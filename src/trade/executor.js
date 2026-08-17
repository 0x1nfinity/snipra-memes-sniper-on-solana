import { getConfig, getActiveMode } from '../config.js';
import { SolanaChain } from '../chains/solana.js';
import { PaperChain } from './paper.js';
import { nativePriceUsd } from '../prices.js';
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
   * Reset paper state — UI "kita ulangi dari awal":
   *  1. Tutup semua posisi paper terbuka (force-close via /sell 100%)
   *  2. Reset saldo tiap paper wallet → startBalance
   *  3. Hapus SQLite trades (kedua mode) — fresh audit start
   *  4. Hapus SQLite decision_cache — LLM verdict cache drop
   *  5. Hapus decision-log.jsonl — fresh decision history
   *  6. Hapus lessons.json — fresh LLM lesson learning
   *  7. Hapus darwin.json — fresh genome evolution
   *  8. Hapus positions.live.json — live state juga bersih (konsisten dengan paper)
   *  9. Reset positions.paper.json (kosong) — handled by closeAllPositions di step 1
   * Darwin genome direstart ke generation 0; lessons drop ke 0; cache invalidates.
   *
   * Catatan: file backup (.bak) di data/ TIDAK disentuh — itu snapshot historis.
   */
  async paperReset({ llm, positionManager, notify } = {}) {
    const removed = [];

    // 1. Tutup semua posisi paper terbuka
    let closedCount = 0;
    const { openPositions } = await import('../positions/state.js');
    const openList = [...openPositions()];
    if (positionManager && openList.length > 0) {
      notify?.(`♻️ Paper reset — closing ${openList.length} open positions…`);
      const results = await positionManager.closeAllPositions('paper reset');
      closedCount = results.filter((r) => !r.error).length;
      log.info(`paper reset: ${closedCount}/${openList.length} positions closed`);
    }

    // 2. Reset saldo paper wallet ke startBalance
    const balances = {};
    for (const [key, c] of this.chains.entries()) {
      if (c instanceof PaperChain) balances[key] = await c.resetWallet();
    }

    // 3. Hapus SQLite trades (kedua mode)
    try {
      const dbMod = await import('../db.js');
      dbMod.deleteTrades('paper');
      dbMod.deleteTrades('live');
      removed.push('trades (paper+live)');
    } catch (e) { log.warn('deleteTrades failed:', e.message); }

    // 4. Hapus decision cache (SQLite)
    try {
      const dbMod = await import('../db.js');
      dbMod.pruneExpiredDecisionCache();
      // prune hanya hapus yg expired; kita juga perlu hapus yg masih aktif
      // — langsung DELETE all
      const Database = (await import('better-sqlite3')).default;
      const fs = await import('fs');
      const path = await import('path');
      const { DATA_DIR } = await import('../config.js');
      const dbFile = path.join(DATA_DIR, 'snipra.db');
      if (fs.existsSync(dbFile)) {
        const tmpDb = new Database(dbFile);
        tmpDb.prepare('DELETE FROM decision_cache').run();
        tmpDb.close();
        removed.push('decision_cache');
      }
    } catch (e) { log.warn('clear decision_cache failed:', e.message); }

    // 5. Hapus decision log
    try {
      const dlMod = await import('../decision-log.js');
      dlMod.clearDecisionLog();
      removed.push('decision-log');
    } catch (e) { log.warn('clearDecisionLog failed:', e.message); }

    // 6. Hapus lessons.json
    if (llm && typeof llm.clearLessons === 'function') {
      try { llm.clearLessons(); removed.push('lessons'); }
      catch (e) { log.warn('clearLessons failed:', e.message); }
    }

    // 7. Hapus Darwin genome state
    try {
      const fs = await import('fs');
      const path = await import('path');
      const { DATA_DIR } = await import('../config.js');
      const darwinFile = path.join(DATA_DIR, 'darwin.json');
      if (fs.existsSync(darwinFile)) {
        fs.unlinkSync(darwinFile);
        removed.push('darwin');
      }
    } catch (e) { log.warn('delete darwin.json failed:', e.message); }

    // 8. Hapus positions.live.json (live state kosong — fresh start)
    try {
      const fs = await import('fs');
      const path = await import('path');
      const { DATA_DIR } = await import('../config.js');
      const liveFile = path.join(DATA_DIR, 'positions.live.json');
      if (fs.existsSync(liveFile)) {
        fs.unlinkSync(liveFile);
        removed.push('positions.live');
      }
    } catch (e) { log.warn('delete positions.live.json failed:', e.message); }

    log.info(`paper reset full: ${closedCount} positions closed, balance reset, removed: ${removed.join(', ') || '(none)'}`);
    return { balances, closedCount, removed };
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
