import {
  Connection,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  PublicKey,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { fetchJson, sleep } from '../utils.js';
import { createLogger } from '../logger.js';
import { findActivityByTx } from '../gmgn/openapi.js';

const log = createLogger('solana');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUP_LITE = 'https://lite-api.jup.ag/swap/v1';
const JUP_PRO = 'https://api.jup.ag/swap/v1';
const GMGN_BASE = 'https://gmgn.ai';
const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

// Platform fee (Jupiter Swap API) — token account WSOL, mint boleh sisi input
// ATAU output utk ExactIn, jadi satu account ini menampung fee dari kedua arah
// (buy & sell) tanpa perlu account terpisah per token meme.
const JUP_FEE_ACCOUNT = '9UPiLzNaZJtCWmA1ZFvbFvvuqTSR81g1UcuvE5AKTgnp';
const JUP_PLATFORM_FEE_BPS = 50; // 0.5%

export class SolanaChain {
  constructor(chainCfg, { dryRun }) {
    this.cfg = chainCfg;
    this.dryRun = dryRun;
    this.connection = new Connection(
      process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
      'confirmed'
    );
    this.wallet = null;
    if (process.env.SOLANA_PRIVATE_KEY) {
      this.wallet = Keypair.fromSecretKey(bs58.decode(process.env.SOLANA_PRIVATE_KEY));
      log.info(`wallet: ${this.wallet.publicKey.toBase58()}`);
    } else {
      log.warn('SOLANA_PRIVATE_KEY empty — dry-run only');
    }
  }

  get address() {
    return this.wallet?.publicKey?.toBase58() || null;
  }

  async nativeBalance() {
    if (!this.wallet) return 0;
    const lamports = await this.connection.getBalance(this.wallet.publicKey);
    return lamports / LAMPORTS_PER_SOL;
  }

  /** balance token SPL → { raw: bigint, decimals, ui } */
  async tokenBalance(mint) {
    if (!this.wallet) return { raw: 0n, decimals: 0, ui: 0 };
    const accounts = await this.connection.getParsedTokenAccountsByOwner(this.wallet.publicKey, {
      mint: new PublicKey(mint),
    });
    let raw = 0n;
    let decimals = 0;
    for (const { account } of accounts.value) {
      const info = account.data.parsed.info.tokenAmount;
      raw += BigInt(info.amount);
      decimals = info.decimals;
    }
    return { raw, decimals, ui: Number(raw) / 10 ** decimals };
  }

  /**
   * Harga jual token (dalam SOL per token) dari quote Jupiter LANGSUNG terhadap
   * saldo wallet saat ini — dipakai sebagai fallback saat harga DexScreener
   * tidak tersedia / dari pair likuiditas terlalu tipis (lihat PositionManager
   * ._refreshPrices). Hanya berlaku live (perlu wallet + saldo on-chain nyata);
   * TIDAK ada di PaperChain — caller di manager.js feature-detect via typeof.
   * null kalau saldo 0 atau quote gagal (best-effort, tidak boleh throw ke tick loop).
   */
  async quoteSellPriceUsd(tokenAddress) {
    if (!this.wallet) return null;
    try {
      const bal = await this.tokenBalance(tokenAddress);
      if (!(bal.raw > 0n) || !(bal.ui > 0)) return null;
      const base = this._jupBase();
      const q = new URLSearchParams({
        inputMint: tokenAddress,
        outputMint: SOL_MINT,
        amount: bal.raw.toString(),
        slippageBps: '50',
      });
      const quote = await fetchJson(`${base}/quote?${q}`, { headers: this._jupHeaders() });
      if (!quote?.outAmount) return null;
      const solOut = Number(quote.outAmount) / LAMPORTS_PER_SOL;
      return solOut / bal.ui;
    } catch (e) {
      log.debug(`quoteSellPriceUsd ${tokenAddress.slice(0, 6)} failed: ${e.message}`);
      return null;
    }
  }

  _jupHeaders() {
    return process.env.JUPITER_API_KEY
      ? { 'x-api-key': process.env.JUPITER_API_KEY, 'Content-Type': 'application/json' }
      : { 'Content-Type': 'application/json' };
  }

  _jupBase() {
    return process.env.JUPITER_API_KEY ? JUP_PRO : JUP_LITE;
  }

  async _jupiterSwap(inputMint, outputMint, rawAmount, slippageBps) {
    const base = this._jupBase();
    const q = new URLSearchParams({
      inputMint,
      outputMint,
      amount: rawAmount.toString(),
      slippageBps: String(slippageBps),
      restrictIntermediateTokens: 'true',
      excludeDexes: PUMP_AMM,
      platformFeeBps: String(JUP_PLATFORM_FEE_BPS),
      instructionVersion: 'V2', // wajib utk kutip fee di token Token-2022 (custom 6014 kalau tak ada)
    });
    const quote = await fetchJson(`${base}/quote?${q}`, { headers: this._jupHeaders() });
    if (!quote?.outAmount) throw new Error(`Jupiter quote failed: ${JSON.stringify(quote).slice(0, 200)}`);

    if (this.dryRun) {
      log.info(`[DRY] jupiter swap ${inputMint.slice(0, 4)}→${outputMint.slice(0, 4)} out=${quote.outAmount}`);
      return { txid: `dry-${Date.now()}`, outAmountRaw: BigInt(quote.outAmount), quote };
    }
    if (!this.wallet) throw new Error('Solana wallet not set');

    const swapRes = await fetchJson(`${base}/swap`, {
      method: 'POST',
      headers: this._jupHeaders(),
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: this.wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
        feeAccount: JUP_FEE_ACCOUNT,
      }),
    });
    if (!swapRes?.swapTransaction) throw new Error(`Jupiter swap build failed: ${JSON.stringify(swapRes).slice(0, 200)}`);

    const tx = VersionedTransaction.deserialize(Buffer.from(swapRes.swapTransaction, 'base64'));
    tx.sign([this.wallet]);
    const txid = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });
    const confirmed = await this._confirm(txid);
    if (!confirmed) throw new Error(`tx ${txid} not confirmed within timeout — treating swap as failed`);
    return { txid, outAmountRaw: BigInt(quote.outAmount), quote };
  }

  async _gmgnSwap(inputMint, outputMint, rawAmount, slippageBps) {
    if (!process.env.GMGN_API_KEY) throw new Error('GMGN_API_KEY is empty');
    const q = new URLSearchParams({
      token_in_address: inputMint,
      token_out_address: outputMint,
      in_amount: rawAmount.toString(),
      from_address: this.wallet.publicKey.toBase58(),
      slippage: String(slippageBps / 100),
    });
    const route = await fetchJson(`${GMGN_BASE}/defi/router/v1/sol/tx/get_swap_route?${q}`, {
      headers: { 'x-route-key': process.env.GMGN_API_KEY },
    });
    const rawTx = route?.data?.raw_tx?.swapTransaction;
    if (!rawTx) throw new Error(`GMGN route failed: ${JSON.stringify(route).slice(0, 200)}`);

    if (this.dryRun) {
      log.info(`[DRY] gmgn swap ${inputMint.slice(0, 4)}→${outputMint.slice(0, 4)}`);
      return { txid: `dry-${Date.now()}`, outAmountRaw: 0n, quote: route.data.quote };
    }

    const tx = VersionedTransaction.deserialize(Buffer.from(rawTx, 'base64'));
    tx.sign([this.wallet]);
    const signed = Buffer.from(tx.serialize()).toString('base64');
    const sent = await fetchJson(`${GMGN_BASE}/txproxy/v1/send_transaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-route-key': process.env.GMGN_API_KEY },
      body: JSON.stringify({ chain: 'sol', signedTx: signed }),
    });
    const txid = sent?.data?.hash;
    if (!txid) throw new Error(`GMGN send failed: ${JSON.stringify(sent).slice(0, 200)}`);
    const confirmed = await this._confirm(txid);
    if (!confirmed) throw new Error(`tx ${txid} not confirmed within timeout — treating swap as failed`);
    return {
      txid,
      outAmountRaw: BigInt(route?.data?.quote?.outAmount || 0),
      quote: route.data.quote,
    };
  }

  async _swap(inputMint, outputMint, rawAmount, slippageBps) {
    if (this.cfg.executor === 'gmgn' && process.env.GMGN_API_KEY) {
      try {
        return await this._gmgnSwap(inputMint, outputMint, rawAmount, slippageBps);
      } catch (e) {
        log.warn('GMGN failed, falling back to Jupiter:', e.message);
      }
    }
    return this._jupiterSwap(inputMint, outputMint, rawAmount, slippageBps);
  }

  /** Buy: SOL → token. amountNative dalam SOL. */
  async buy(tokenAddress, amountNative, slippageBps) {
    const lamports = BigInt(Math.floor(amountNative * LAMPORTS_PER_SOL));
    const res = await this._swap(SOL_MINT, tokenAddress, lamports, slippageBps);
    log.info(`BUY ${tokenAddress.slice(0, 6)} ${amountNative} SOL → tx ${res.txid}`);
    return { txid: res.txid, spentNative: amountNative, tokensRaw: res.outAmountRaw };
  }

  /** Sell: token → SOL. pct = persen dari balance (0-100). */
  async sell(tokenAddress, pct, slippageBps) {
    let raw;
    if (this.dryRun && !this.wallet) {
      raw = 1_000_000n; // placeholder utk simulasi tanpa wallet
    } else {
      const bal = await this.tokenBalance(tokenAddress);
      raw = (bal.raw * BigInt(Math.floor(pct * 100))) / 10000n;
    }
    if (raw <= 0n) throw new Error(`balance ${tokenAddress.slice(0, 6)} = 0`);

    const res = await this._swap(tokenAddress, SOL_MINT, raw, slippageBps);
    const quoteFallback = Number(res.outAmountRaw) / LAMPORTS_PER_SOL;

    // ⚠️ Swap SUDAH sukses di titik ini — jangan pernah throw dari sini ke bawah.
    // receivedNative diselesaikan lewat 3 tingkat fallback (GMGN → tx-meta on-chain → quote).
    const receivedNative = (this.dryRun && !this.wallet)
      ? quoteFallback
      : await this._resolveReceivedNative(res.txid, tokenAddress, quoteFallback);

    log.info(`SELL ${pct}% ${tokenAddress.slice(0, 6)} → ${receivedNative.toFixed(4)} SOL, tx ${res.txid}`);
    return { txid: res.txid, soldRaw: raw, receivedNative };
  }

  /**
   * Resolve SOL received from a sell: GMGN wallet_activity (primary — matches
   * exactly what the user sees in GMGN's own UI, matched by tx_hash) → on-chain
   * tx-meta delta (fallback 1) → the swap's own quote estimate (fallback 2, last resort).
   */
  async _resolveReceivedNative(txid, tokenAddress, quoteFallbackNative) {
    try {
      const match = await findActivityByTx(this.address, tokenAddress, txid);
      if (match) {
        log.info(`SELL PnL source: gmgn (tx ${txid.slice(0, 8)})`);
        return Number(match.quote_amount);
      }
    } catch (e) {
      log.warn(`gmgn findActivityByTx failed: ${e.message}`);
    }
    try {
      const delta = await this._txMetaDelta(txid);
      if (delta != null) {
        log.info(`SELL PnL source: onchain-tx-meta (tx ${txid.slice(0, 8)})`);
        return delta;
      }
    } catch (e) {
      log.warn(`tx-meta delta failed: ${e.message}`);
    }
    log.warn(`SELL PnL source: quote-fallback (tx ${txid.slice(0, 8)}) — GMGN and tx-meta both unavailable`);
    return quoteFallbackNative;
  }

  /**
   * Exact SOL delta caused by ONE specific transaction, read from its own
   * meta.preBalances/postBalances — immune to any other concurrent wallet
   * activity, unlike a separate before/after wallet-balance snapshot.
   */
  async _txMetaDelta(txid) {
    for (let i = 0; i < 3; i++) {
      try {
        const tx = await this.connection.getTransaction(txid, { maxSupportedTransactionVersion: 0 });
        if (tx?.meta) {
          const keys = tx.transaction.message.staticAccountKeys;
          const idx = keys.findIndex((k) => k.toBase58() === this.wallet.publicKey.toBase58());
          if (idx >= 0) {
            return (tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) / LAMPORTS_PER_SOL;
          }
        }
      } catch (e) {
        log.warn(`_txMetaDelta attempt ${i + 1} failed: ${e.message}`);
      }
      if (i < 2) await sleep(1000);
    }
    return null;
  }

  async _confirm(txid, maxWaitMs = 60000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      // Baca status RPC dibungkus try-catch: rate-limit/network blip di tengah polling
      // TIDAK BOLEH menggagalkan confirm — tx bisa saja sudah sukses on-chain.
      // Cukup log & lanjut poll ke iterasi berikutnya sampai maxWaitMs habis.
      try {
        const st = await this.connection.getSignatureStatuses([txid]);
        const s = st?.value?.[0];
        if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') {
          if (s.err) {
            const err = new Error(`tx ${txid} failed on-chain: ${JSON.stringify(s.err)}`);
            err.onChainFailure = true; // kegagalan on-chain nyata (bukan RPC noise) — flag, bukan string-match
            throw err;
          }
          return true;
        }
      } catch (e) {
        if (e.onChainFailure) throw e; // kegagalan on-chain nyata — lempar
        log.debug(`getSignatureStatuses ${txid} failed, retrying: ${e.message}`);
      }
      await sleep(2000);
    }
    log.warn(`tx ${txid} not confirmed after ${maxWaitMs / 1000}s`);
    return false;
  }
}
