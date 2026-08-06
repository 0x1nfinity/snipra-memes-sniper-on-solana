import { getConfig, getActiveMode } from '../config.js';
import { SolanaChain } from '../chains/solana.js';
import { PaperChain } from './paper.js';
import { nativePriceUsd } from '../prices.js';
import { deleteTrades, recentTrades } from '../db.js';
import { resetStats } from '../positions/state.js';
import { createLogger } from '../logger.js';

const log = createLogger('executor');

// Cadangan native yang tidak boleh dipakai buy di mode live (biaya gas/fee)
const GAS_RESERVE = { solana: 0.01 };

/**
 * Interface trading terpadu lintas mode.
 * mode 'paper' → semua chain memakai PaperChain (saldo virtual, harga real).
 * mode 'live'  → SolanaChain (Jupiter/GMGN) sungguhan.
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
        this.chains.set(
          key,
          getActiveMode() === 'paper' ? new PaperChain(key, c) : new SolanaChain(c, { dryRun: false })
        );
      } catch (e) {
        log.error(`init chain ${key} (${getActiveMode()}) failed:`, e.message);
      }
    }
    log.info(`executor mode=${getActiveMode()}, chains: ${[...this.chains.keys()].join(', ')}`);
  }

  /** panggil setelah mode berubah (telegram /mode) atau config chain berubah (/set, menu) */
  syncMode() {
    // Selalu rebuild — constructor murah (hanya buat PaperChain/Map).
    // Perubahan chains.*.enabled via /set atau menu callback langsung
    // diterapkan tanpa perlu restart.
    this._build();
  }

  chain(key) {
    const c = this.chains.get(key);
    if (!c) throw new Error(`chain ${key} not active`);
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
    if (!amount || amount <= 0) throw new Error(`buyAmount for ${chainKey} not set`);
    // Ukuran = buyAmount PERSIS dari config (tanpa floor native / skala score).
    // Hanya trading.minSwapUsd yang jadi pengaman terhadap swap bernilai debu.
    amount = Number(amount.toPrecision(6));

    const usdValue = amount * px;
    const minSwap = cfg.trading.minSwapUsd ?? 0;
    if (usdValue < minSwap - 0.01) {
      throw new Error(`swap value $${usdValue.toFixed(2)} < minimum $${minSwap}`);
    }

    const balance = await chain.nativeBalance();
    const reserve = getActiveMode() === 'live' ? (GAS_RESERVE[chainKey] ?? 0.01) : 0;
    if (balance - reserve < amount) {
      throw new Error(
        `insufficient ${chainKey} balance: ${balance.toFixed(6)} native` +
        `${reserve ? ` (gas reserve ${reserve})` : ''} < needs ${amount.toFixed(6)}`
      );
    }

    log.info(`buy ${chainKey} ${tokenAddress.slice(0, 8)}: ${amount} native (~$${usdValue.toFixed(2)}), balance ${balance.toFixed(4)}`);
    return chain.buy(tokenAddress, amount, cfg.trading.slippageBps, pairInfo);
  }

  async sell(chainKey, tokenAddress, pct, pairInfo = {}) {
    const cfg = getConfig();
    return this.chain(chainKey).sell(tokenAddress, pct, cfg.trading.slippageBps, pairInfo);
  }

  /**
   * Reset penuh lingkungan paper:
   *  1. Tutup semua posisi paper terbuka
   *  2. Derive lessons dari riwayat trade paper (via LLM) sebelum data dihapus
   *  3. Reset saldo tiap paper wallet → startBalance
   *  4. Nolkan realized PnL (akumulator stats in-memory + hapus trade paper dari DB)
   *  5. Reset unrealized PnL (posisi sudah ditutup di langkah 1)
   * @param {object} opts.llm — instance LLM (opsional; lessons dilewati bila tidak ada)
   * @param {object} opts.positionManager — untuk closeAllPositions
   * @param {function} opts.notify — fungsi kirim notif ke Telegram
   */
  async paperReset({ llm, positionManager, notify } = {}) {
    // 1. Tutup semua posisi terbuka (termasuk moonbag tidak ada mekanisme close massal)
    let closedCount = 0;
    const { openPositions } = await import('../positions/state.js');
    const openList = [...openPositions()];
    if (positionManager && openList.length > 0) {
      notify?.(`♻️ Paper reset — closing ${openList.length} open positions…`);
      const results = await positionManager.closeAllPositions('paper reset');
      closedCount = results.filter((r) => !r.error).length;
      log.info(`paper reset: ${closedCount}/${openList.length} positions closed`);
    }

    // 2. Derive lessons strategis dari riwayat sebelum data dihapus
    let lessonsDerived = 0;
    if (llm?.available()) {
      try {
        const trades = recentTrades('paper', 50);
        if (trades.length > 0) {
          const existingLessons = llm.getLessons(20);
          const derived = await llm.deriveResetLessons(trades, existingLessons);
          lessonsDerived = derived.length;
        }
      } catch (e) {
        log.warn('paperReset: LLM derive lessons failed, lanjut tanpa lessons:', e.message);
      }
    }

    // 3. Reset saldo paper wallet
    const balances = {};
    for (const [key, c] of this.chains.entries()) {
      if (c instanceof PaperChain) balances[key] = await c.resetWallet();
    }

    // 4. Nolkan stats + riwayat close in-memory
    resetStats();

    // 5. Hapus realized PnL paper dari DB
    const tradesDeleted = deleteTrades('paper');

    log.info(`paper reset: balance + realized PnL zeroed, ${tradesDeleted} paper trades deleted` +
      (lessonsDerived ? `, ${lessonsDerived} lessons saved` : ''));
    return { balances, tradesDeleted, closedCount, lessonsDerived };
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
