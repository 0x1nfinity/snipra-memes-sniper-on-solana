import { tokensBatch, bestPair } from '../screener/dexscreener.js';
import {
  paperWalletInit, paperWalletExists, paperBalance, paperAdjustBalance,
  paperHolding, paperSetHolding, paperResetWallet,
} from '../db.js';
import { getConfig } from '../config.js';
import { nativePriceUsd } from '../prices.js';
import { createLogger } from '../logger.js';

const log = createLogger('paper');

/** PaperChain: implementasi interface chain (buy/sell/nativeBalance) yang
 * berperilaku seperti live — harga real-time DexScreener, slippage disimulasikan —
 * tapi saldo & holdings virtual di SQLite. Tidak menyentuh on-chain sama sekali.
 */
export class PaperChain {
  constructor(chainKey, chainCfg) {
    this.key = chainKey;
    this.cfg = chainCfg;
  }

  get address() {
    return 'PAPER';
  }

  /** gas fee dari config atau fallback hardcoded */
  _gasFee() {
    const cfg = getConfig();
    return cfg.trading.paperGas?.[this.cfg.type] ?? 0.000005;
  }

  /** saldo awal dalam native, dari paper.startBalanceUsd (kurs terkini) */
  async _startBalanceNative() {
    const paperCfg = getConfig().paper;
    if (paperCfg.startBalanceUsd > 0) {
      const px = await nativePriceUsd(this.key);
      return Number((paperCfg.startBalanceUsd / px).toPrecision(6));
    }
    return paperCfg.startBalance?.[this.key] ?? 1; // kompat config lama
  }

  /** init wallet lazily (butuh kurs → async, tidak bisa di constructor) */
  async _ensureWallet() {
    if (paperWalletExists(this.key)) return;
    const start = await this._startBalanceNative();
    paperWalletInit(this.key, start);
    log.info(`[${this.key}] paper wallet init: ${start} native (~$${getConfig().paper.startBalanceUsd ?? '?'})`);
  }

  async resetWallet() {
    const start = await this._startBalanceNative();
    paperResetWallet(this.key, start);
    log.info(`[${this.key}] paper wallet reset → ${start} native`);
    return start;
  }

  async nativeBalance() {
    await this._ensureWallet();
    return paperBalance(this.key);
  }

  async tokenBalance(token) {
    const ui = paperHolding(this.key, token);
    let decimals = this._decimalsCache?.get(token.toLowerCase());
    if (decimals == null) {
      try {
        const pairs = await tokensBatch(this.cfg.dexscreenerId, [token]);
        const mine = pairs.filter(
          (p) => p?.baseToken?.address?.toLowerCase() === token.toLowerCase()
        );
        const pair = bestPair(mine);
        decimals = pair?.baseToken?.decimals ?? pair?.quoteToken?.decimals ?? 0;
      } catch {
        decimals = 0;
      }
      if (!this._decimalsCache) this._decimalsCache = new Map();
      this._decimalsCache.set(token.toLowerCase(), decimals);
    }
    const raw = BigInt(Math.floor(ui * (10 ** decimals)));
    return { raw, decimals, ui };
  }

  /** harga token dalam native (SOL/ETH) dari pair terlikuid; null jika tak tersedia */
  async _tryPriceNative(token) {
    try {
      const pairs = await tokensBatch(this.cfg.dexscreenerId, [token]);
      const mine = pairs.filter(
        (p) => p?.baseToken?.address?.toLowerCase() === token.toLowerCase()
      );
      const pair = bestPair(mine);
      const priceNative = Number(pair?.priceNative);
      return priceNative > 0 ? priceNative : null;
    } catch {
      return null;
    }
  }

  async _priceNative(token) {
    const p = await this._tryPriceNative(token);
    if (p == null) throw new Error(`price for ${token.slice(0, 8)} not available on DexScreener`);
    return p;
  }

  /** Buy: native → token. Fill di harga sekarang + slippage. */
  async buy(tokenAddress, amountNative, slippageBps) {
    await this._ensureWallet();
    const balance = paperBalance(this.key);
    const gasFee = this._gasFee();
    if (balance < amountNative + gasFee) {
      throw new Error(`saldo paper ${this.key} ${balance.toFixed(4)} < ${(amountNative + gasFee).toFixed(6)} (incl gas)`);
    }
    const price = await this._priceNative(tokenAddress);
    const fillPrice = price * (1 + slippageBps / 10000); // beli lebih mahal (slippage)
    const tokens = amountNative / fillPrice;

    paperAdjustBalance(this.key, -(amountNative + gasFee));
    paperSetHolding(this.key, tokenAddress, paperHolding(this.key, tokenAddress) + tokens);

    const txid = `paper-buy-${Date.now()}`;
    log.info(`BUY [paper:${this.key}] ${tokenAddress.slice(0, 8)} ${amountNative} + ${gasFee} gas → ${tokens.toFixed(2)} token`);
    return { txid, spentNative: amountNative, tokensRaw: tokens };
  }

  /**
   * Sell: token → native. pct = persen holdings (0-100).
   * Jika harga live tidak tersedia (token delisted/rug), fallback ke
   * pairInfo.fallbackPriceUsd (harga terakhir yang diketahui posisi);
   * tanpa fallback pun posisi tetap bisa ditutup dengan nilai 0.
   */
  async sell(tokenAddress, pct, slippageBps, pairInfo = {}) {
    await this._ensureWallet();
    const held = paperHolding(this.key, tokenAddress);
    if (held <= 0) throw new Error(`holdings paper ${tokenAddress.slice(0, 8)} = 0`);
    const tokens = held * (Math.min(pct, 100) / 100);

    let price = await this._tryPriceNative(tokenAddress);
    if (price == null) {
      if (pairInfo.fallbackPriceUsd > 0) {
        const px = await nativePriceUsd(this.key);
        price = pairInfo.fallbackPriceUsd / px;
        log.warn(`[${this.key}] live price ${tokenAddress.slice(0, 8)} unavailable — using last known price ($${pairInfo.fallbackPriceUsd})`);
      } else {
        price = 0;
        log.warn(`[${this.key}] ${tokenAddress.slice(0, 8)} illiquid & no fallback — treated as rug, close @ 0`);
      }
    }
    const fillPrice = price * (1 - slippageBps / 10000); // jual lebih murah (slippage)
    const receivedNative = tokens * fillPrice;

    const gasFee = this._gasFee();
    // Gas is already deducted from gotNative before crediting
    paperSetHolding(this.key, tokenAddress, held - tokens);
    paperAdjustBalance(this.key, receivedNative - gasFee);

    const txid = `paper-sell-${Date.now()}`;
    log.info(`SELL [paper:${this.key}] ${pct}% ${tokenAddress.slice(0, 8)} → ${receivedNative.toFixed(4)} native (gas -${gasFee})`);
    return { txid, soldRaw: tokens, receivedNative };
  }
}
