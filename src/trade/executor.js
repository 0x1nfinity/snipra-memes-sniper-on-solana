import { getConfig, getActiveMode } from '../config.js';
import { SolanaChain } from '../chains/solana.js';
import { EvmChain } from '../chains/evm.js';
import { PaperChain } from './paper.js';
import { nativePriceUsd } from '../prices.js';
import { deleteTrades } from '../db.js';
import { resetStats } from '../positions/state.js';
import { createLogger } from '../logger.js';

const log = createLogger('executor');

// Cadangan native yang tidak boleh dipakai buy di mode live (biaya gas/fee)
const GAS_RESERVE = { solana: 0.01, evm: 0.0005 };

/**
 * Interface trading terpadu lintas chain + lintas mode.
 * mode 'paper' → semua chain memakai PaperChain (saldo virtual, harga real).
 * mode 'live'  → SolanaChain (Jupiter/GMGN) & EvmChain (Uniswap) sungguhan.
 */
export class Executor {
  constructor() {
    this.mode = null;
    this.chains = new Map();
    this._build();
  }

  _build() {
    const cfg = getConfig();
    this.mode = getActiveMode();
    this.chains.clear();
    for (const [key, c] of Object.entries(cfg.chains)) {
      if (!c.enabled) continue;
      try {
        if (getActiveMode() === 'paper') {
          this.chains.set(key, new PaperChain(key, c));
        } else {
          this.chains.set(
            key,
            c.type === 'solana'
              ? new SolanaChain(c, { dryRun: false })
              : new EvmChain(key, c, { dryRun: false })
          );
        }
      } catch (e) {
        log.error(`init chain ${key} (${getActiveMode()}) gagal:`, e.message);
      }
    }
    log.info(`executor mode=${getActiveMode()}, chains: ${[...this.chains.keys()].join(', ')}`);
  }

  /** panggil setelah mode berubah (telegram /mode) */
  syncMode() {
    if (getActiveMode() !== this.mode) this._build();
  }

  chain(key) {
    const c = this.chains.get(key);
    if (!c) throw new Error(`chain ${key} tidak aktif`);
    return c;
  }

  /**
   * Buy dengan guard lengkap (berlaku utk auto-buy DAN /buy manual):
   * 1. sizing: amount eksplisit > buyAmount (native per chain) > buyAmountUsd (konversi)
   * 2. pengaman nilai minimal trading.minSwapUsd (anti swap debu)
   * 3. CEK BALANCE: saldo (dikurangi cadangan gas di live) harus mencukupi
   */
  async buy(chainKey, tokenAddress, amountNative, pairInfo = {}) {
    const cfg = getConfig();
    const chainCfg = cfg.chains[chainKey];
    const chain = this.chain(chainKey);
    const px = await nativePriceUsd(chainKey);

    let amount = amountNative;
    if (amount == null) {
      amount = chainCfg.buyAmount > 0
        ? chainCfg.buyAmount // ukuran posisi dalam native (SOL/ETH)
        : chainCfg.buyAmountUsd > 0
          ? chainCfg.buyAmountUsd / px
          : 0;
    }
    if (!amount || amount <= 0) throw new Error(`buyAmount ${chainKey} belum diset`);
    // Ukuran = buyAmount PERSIS dari config (tanpa floor native / skala score).
    // Hanya trading.minSwapUsd yang jadi pengaman terhadap swap bernilai debu.
    amount = Number(amount.toPrecision(6));

    const usdValue = amount * px;
    const minSwap = cfg.trading.minSwapUsd ?? 0;
    if (usdValue < minSwap - 0.01) {
      throw new Error(`nilai swap $${usdValue.toFixed(2)} < minimum $${minSwap}`);
    }

    const balance = await chain.nativeBalance();
    const reserve = getActiveMode() === 'live' ? (chainCfg.type === 'solana' ? GAS_RESERVE.solana : GAS_RESERVE.evm) : 0;
    if (balance - reserve < amount) {
      throw new Error(
        `saldo ${chainKey} tidak cukup: ${balance.toFixed(6)} native` +
        `${reserve ? ` (cadangan gas ${reserve})` : ''} < butuh ${amount.toFixed(6)}`
      );
    }

    log.info(`buy ${chainKey} ${tokenAddress.slice(0, 8)}: ${amount} native (~$${usdValue.toFixed(2)}), saldo ${balance.toFixed(4)}`);
    return chain.buy(tokenAddress, amount, cfg.trading.slippageBps, pairInfo);
  }

  async sell(chainKey, tokenAddress, pct, pairInfo = {}) {
    const cfg = getConfig();
    return this.chain(chainKey).sell(tokenAddress, pct, cfg.trading.slippageBps, pairInfo);
  }

  /**
   * Reset penuh lingkungan paper:
   *  - saldo tiap paper wallet → startBalance
   *  - realized PnL → 0 (akumulator stats in-memory + hapus trade paper dari DB)
   * Posisi terbuka TIDAK ditutup (unrealized tetap berjalan).
   */
  async paperReset() {
    const balances = {};
    for (const [key, c] of this.chains.entries()) {
      if (c instanceof PaperChain) balances[key] = await c.resetWallet();
    }
    resetStats();                              // nolkan stats + riwayat close in-memory
    const tradesDeleted = deleteTrades('paper'); // hapus realized PnL paper dari DB
    log.info(`paper reset: saldo + realized PnL dinolkan, ${tradesDeleted} trade paper dihapus`);
    return { balances, tradesDeleted };
  }

  async balances() {
    const out = {};
    for (const [key, c] of this.chains.entries()) {
      try {
        out[key] = { address: c.address, native: await c.nativeBalance() };
      } catch (e) {
        out[key] = { address: c.address, error: e.message };
      }
    }
    return out;
  }
}
