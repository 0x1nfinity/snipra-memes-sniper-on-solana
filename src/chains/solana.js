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
import { findActivityByTx, getGmgnApiKey } from '../gmgn/openapi.js';

const log = createLogger('solana');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUP_LITE = 'https://lite-api.jup.ag/swap/v1';
const JUP_PRO = 'https://api.jup.ag/swap/v1';
const GMGN_BASE = 'https://gmgn.ai';

// Platform fee (Jupiter Swap API)
// Fee account adalah WSOL ATA milik wallet 99p59baK2Md5EPmHmhBK8HMC1dFaPUWYJDaWPanyhCV1.
// Address deterministic dari (wallet, WSOL mint) → harus exist on-chain sebelum swap.
// Jika belum exist: swap akan gagal 6025. Buat dgn createAssociatedTokenAccount
// (funder bebas, owner = wallet di atas, mint = WSOL).
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

  /**
   * Jupiter swap dengan 4-tier fallback — platform fee DIUTAMAKAN:
   *   1. V2 + fee + restricted   (primary — rute paling efisien, seperti old-snipra)
   *   2. V2 + fee + unrestricted (fallback 6025 — rute lebih luas, lebih banyak DEX)
   *   3. noV2 + fee + unrestricted (fallback 6014 — coba tanpa V2, rute luas)
   *   4. noV2 + noFee + unrestricted (LAST RESORT — TANPA platform fee, log keras)
   *
   * excludeDexes TIDAK dipakai — old-snipra tidak pakai dan swap-nya lancar.
   */
  async _jupiterSwap(inputMint, outputMint, rawAmount, slippageBps) {
    const base = this._jupBase();

    // 4-tier: fee di 3 tier pertama, no-fee hanya last resort
    const tiers = [
      { v2: true,  fee: true,  restricted: true,  label: 'V2+fee+restricted' },
      { v2: true,  fee: true,  restricted: false, label: 'V2+fee+unrestricted' },
      { v2: false, fee: true,  restricted: false, label: 'noV2+fee+unrestricted' },
      { v2: false, fee: false, restricted: false, label: 'noV2+noFee' },
    ];

    let lastErr;
    for (const tier of tiers) {
      const q = new URLSearchParams({
        inputMint,
        outputMint,
        amount: rawAmount.toString(),
        slippageBps: String(slippageBps),
      });
      if (tier.restricted) q.set('restrictIntermediateTokens', 'true');
      if (tier.fee) q.set('platformFeeBps', String(JUP_PLATFORM_FEE_BPS));
      if (tier.v2) q.set('instructionVersion', 'V2');

      let quote;
      try {
        quote = await fetchJson(`${base}/quote?${q}`, { headers: this._jupHeaders() });
      } catch (e) {
        lastErr = e;
        log.warn(`tier ${tier.label} quote HTTP error: ${e.message}`);
        continue;
      }
      if (!quote?.outAmount) {
        lastErr = new Error(`Jupiter quote failed: ${JSON.stringify(quote).slice(0, 200)}`);
        log.warn(`tier ${tier.label} quote failed: ${lastErr.message}`);
        continue;
      }

      if (this.dryRun) {
        log.info(`[DRY] jupiter swap ${inputMint.slice(0, 4)}→${outputMint.slice(0, 4)} tier=${tier.label} out=${quote.outAmount}`);
        return { txid: `dry-${Date.now()}`, outAmountRaw: BigInt(quote.outAmount), quote };
      }
      if (!this.wallet) throw new Error('Solana wallet not set');

      const swapBody = {
        quoteResponse: quote,
        userPublicKey: this.wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: 'auto',
      };
      if (tier.fee) swapBody.feeAccount = JUP_FEE_ACCOUNT;

      let swapRes;
      try {
        swapRes = await fetchJson(`${base}/swap`, {
          method: 'POST',
          headers: this._jupHeaders(),
          body: JSON.stringify(swapBody),
        });
      } catch (e) {
        lastErr = e;
        log.warn(`tier ${tier.label} swap build HTTP error: ${e.message}`);
        continue;
      }
      if (!swapRes?.swapTransaction) {
        lastErr = new Error(`Jupiter swap build failed: ${JSON.stringify(swapRes).slice(0, 200)}`);
        log.warn(`tier ${tier.label} swap build failed: ${lastErr.message}`);
        continue;
      }

      const tx = VersionedTransaction.deserialize(Buffer.from(swapRes.swapTransaction, 'base64'));
      tx.sign([this.wallet]);
      let txid;
      try {
        txid = await this.connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: true,
          maxRetries: 3,
        });
      } catch (e) {
        // Transaction too large — try next tier
        if (e.message?.includes('too large') && tier !== tiers[tiers.length - 1]) {
          log.warn(`tier ${tier.label} tx too large, trying next tier`);
          continue;
        }
        throw e;
      }

      try {
        const confirmed = await this._confirm(txid);
        if (confirmed === 'timeout') {
          log.warn(`tx ${txid} broadcast but unconfirmed — proceeding, may confirm later`);
          return { txid, outAmountRaw: BigInt(quote.outAmount), quote, _pendingConfirm: true };
        }
        if (!confirmed) {
          lastErr = new Error(`tx ${txid} not confirmed within timeout`);
          continue;
        }
        if (tier.label !== 'V2+fee+restricted') {
          log.info(`swap succeeded at tier ${tier.label} (tx ${txid.slice(0, 8)})`);
        }
        return { txid, outAmountRaw: BigInt(quote.outAmount), quote };
      } catch (e) {
        if (e.onChainFailure) {
          // 6025 = V2 ditolak rute, 6014 = Token-2022 butuh V2 utk fee
          const errStr = e.message;
          const code = errStr.includes('6025') ? '6025' : errStr.includes('6014') ? '6014' : null;
          if (code && tier !== tiers[tiers.length - 1]) {
            log.warn(`tier ${tier.label} failed on-chain (${code}), trying next tier`);
            lastErr = e;
            continue;
          }
        }
        throw e;
      }
    }

    // Semua tier gagal — lempar error terakhir
    throw lastErr || new Error('All Jupiter swap tiers exhausted');
  }

  async _gmgnSwap(inputMint, outputMint, rawAmount, slippageBps) {
    const gmgnKey = getGmgnApiKey();
    if (!gmgnKey) throw new Error('GMGN_API_KEYS is empty');
    const q = new URLSearchParams({
      token_in_address: inputMint,
      token_out_address: outputMint,
      in_amount: rawAmount.toString(),
      from_address: this.wallet.publicKey.toBase58(),
      slippage: String(slippageBps / 100),
    });
    const route = await fetchJson(`${GMGN_BASE}/defi/router/v1/sol/tx/get_swap_route?${q}`, {
      headers: { 'x-route-key': gmgnKey },
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
      headers: { 'Content-Type': 'application/json', 'x-route-key': gmgnKey },
      body: JSON.stringify({ chain: 'sol', signedTx: signed }),
    });
    const txid = sent?.data?.hash;
    if (!txid) throw new Error(`GMGN send failed: ${JSON.stringify(sent).slice(0, 200)}`);
    const confirmed = await this._confirm(txid);
    if (confirmed === 'timeout') {
      log.warn(`tx ${txid} broadcast but unconfirmed via GMGN — proceeding, may confirm later`);
      return {
        txid,
        outAmountRaw: BigInt(route?.data?.quote?.outAmount || 0),
        quote: route.data.quote,
        _pendingConfirm: true,
      };
    }
    if (!confirmed) throw new Error(`tx ${txid} not confirmed within timeout — treating swap as failed`);
    return {
      txid,
      outAmountRaw: BigInt(route?.data?.quote?.outAmount || 0),
      quote: route.data.quote,
    };
  }

  async _swap(inputMint, outputMint, rawAmount, slippageBps) {
    const gmgnKey = getGmgnApiKey();
    if (this.cfg.executor === 'gmgn' && gmgnKey) {
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

  /**
   * Poll getSignatureStatuses sampai confirmed/finalized.
   * Return values:
   *   true       — confirmed on-chain (success)
   *   "timeout"  — unconfirmed after all attempts, tapi tx SUDAH broadcast (bisa confirm nanti)
   *   throw      — on-chain failure (s.err != null)
   *
   * Caller TIDAK BOLEH memperlakukan "timeout" sebagai definitive failure —
   * tx mungkin sudah confirmed di network tapi RPC kita tidak melihatnya.
   */
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

    // === Last-chance: banyak tx stuck di 55-60s confirm di 70-75s ===
    log.warn(`tx ${txid} not confirmed after ${maxWaitMs / 1000}s — waiting 15s more for last-chance check`);
    await sleep(15000);
    try {
      const st = await this.connection.getSignatureStatuses([txid]);
      const s = st?.value?.[0];
      if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') {
        if (s.err) {
          const err = new Error(`tx ${txid} failed on-chain: ${JSON.stringify(s.err)}`);
          err.onChainFailure = true;
          throw err;
        }
        log.info(`tx ${txid} confirmed on last-chance check`);
        return true;
      }
    } catch (e) {
      if (e.onChainFailure) throw e;
    }

    // === getTransaction fallback: baca langsung dari ledger, lebih reliable ===
    try {
      log.warn(`tx ${txid} — trying getTransaction as fallback`);
      const tx = await this.connection.getTransaction(txid, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (tx) {
        if (tx.meta?.err) {
          const err = new Error(`tx ${txid} failed on-chain: ${JSON.stringify(tx.meta.err)}`);
          err.onChainFailure = true;
          throw err;
        }
        log.info(`tx ${txid} confirmed via getTransaction fallback`);
        return true;
      }
    } catch (e) {
      if (e.onChainFailure) throw e;
      log.debug(`getTransaction fallback for ${txid} also failed: ${e.message}`);
    }

    // === Benar-benar tidak bisa konfirmasi, tapi tx sudah broadcast ===
    log.warn(`tx ${txid} still unconfirmed after all attempts — tx was broadcast, may confirm later`);
    return 'timeout';
  }
}
