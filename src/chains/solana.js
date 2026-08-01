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

const log = createLogger('solana');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUP_LITE = 'https://lite-api.jup.ag/swap/v1';
const JUP_PRO = 'https://api.jup.ag/swap/v1';
const GMGN_BASE = 'https://gmgn.ai';

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
      log.warn('SOLANA_PRIVATE_KEY kosong — hanya bisa dry-run');
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
      platformFeeBps: String(JUP_PLATFORM_FEE_BPS),
    });
    const quote = await fetchJson(`${base}/quote?${q}`, { headers: this._jupHeaders() });
    if (!quote?.outAmount) throw new Error(`Jupiter quote gagal: ${JSON.stringify(quote).slice(0, 200)}`);

    if (this.dryRun) {
      log.info(`[DRY] jupiter swap ${inputMint.slice(0, 4)}→${outputMint.slice(0, 4)} out=${quote.outAmount}`);
      return { txid: `dry-${Date.now()}`, outAmountRaw: BigInt(quote.outAmount), quote };
    }
    if (!this.wallet) throw new Error('wallet Solana belum diset');

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
    if (!swapRes?.swapTransaction) throw new Error(`Jupiter swap build gagal: ${JSON.stringify(swapRes).slice(0, 200)}`);

    const tx = VersionedTransaction.deserialize(Buffer.from(swapRes.swapTransaction, 'base64'));
    tx.sign([this.wallet]);
    const txid = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });
    await this._confirm(txid);
    return { txid, outAmountRaw: BigInt(quote.outAmount), quote };
  }

  async _gmgnSwap(inputMint, outputMint, rawAmount, slippageBps) {
    if (!process.env.GMGN_API_KEY) throw new Error('GMGN_API_KEY kosong');
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
    if (!rawTx) throw new Error(`GMGN route gagal: ${JSON.stringify(route).slice(0, 200)}`);

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
    if (!txid) throw new Error(`GMGN send gagal: ${JSON.stringify(sent).slice(0, 200)}`);
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
        log.warn('GMGN gagal, fallback ke Jupiter:', e.message);
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

    // Capture SOL balance BEFORE swap (best-effort; fallback ke quote jika gagal)
    let solBefore = 0n;
    if (this.wallet) {
      try {
        solBefore = await this.connection.getBalance(this.wallet.publicKey);
      } catch (e) {
        log.warn(`gagal baca saldo SOL sebelum swap: ${e.message}`);
      }
    }

    const res = await this._swap(tokenAddress, SOL_MINT, raw, slippageBps);

    // Compute actual SOL received (balance delta).
    // ⚠️ Swap SUDAH sukses di titik ini — jangan pernah throw.
    // Jika query saldo setelah swap gagal (RPC down/timeout), fallback ke quote.
    let receivedNative;
    if (this.dryRun && !this.wallet) {
      receivedNative = Number(res.outAmountRaw) / LAMPORTS_PER_SOL;
    } else {
      try {
        const solAfter = await this.connection.getBalance(this.wallet.publicKey);
        // Add a small estimate for tx fee since we can't easily get exact fee
        const TX_FEE_ESTIMATE = 5000n; // 0.000005 SOL typical Jupiter tx fee
        receivedNative = Number(solAfter - solBefore + TX_FEE_ESTIMATE) / LAMPORTS_PER_SOL;
      } catch (e) {
        // Fallback: pakai quote outAmount (tanpa koreksi fee — estimasi terbaik)
        receivedNative = Number(res.outAmountRaw) / LAMPORTS_PER_SOL;
        log.warn(`gagal baca saldo SOL setelah swap, fallback ke quote: ${receivedNative.toFixed(4)} SOL (${e.message})`);
      }
    }

    log.info(`SELL ${pct}% ${tokenAddress.slice(0, 6)} → ${receivedNative.toFixed(4)} SOL, tx ${res.txid}`);
    return { txid: res.txid, soldRaw: raw, receivedNative };
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
          if (s.err) throw new Error(`tx ${txid} gagal on-chain: ${JSON.stringify(s.err)}`);
          return true;
        }
      } catch (e) {
        if (/gagal on-chain/.test(e.message)) throw e; // kegagalan on-chain nyata — lempar
        log.debug(`getSignatureStatuses ${txid} gagal, retry: ${e.message}`);
      }
      await sleep(2000);
    }
    log.warn(`tx ${txid} belum confirmed setelah ${maxWaitMs / 1000}s`);
    return false;
  }
}
