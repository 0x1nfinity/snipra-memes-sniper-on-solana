import { getConfig } from '../config.js';
import { tokensBatch } from '../screener/dexscreener.js';
import {
  openPositions, updatePrice, currentPnlPct, recordPartialSell, closePosition,
  moonbags, moveToMoonbag, updateMoonbagPrice,
} from './state.js';
import { fmtPct, fmtUsd, tokenLink, dynamicStopLossPercent } from '../utils.js';
import { createLogger } from '../logger.js';

const log = createLogger('positions');

/**
 * Loop pemantau posisi: update harga → TP ladder → trailing profit → stop loss.
 * deps: { executor, notify(msg), onTradeClosed(trade) }
 */
export class PositionManager {
  constructor({ executor, notify, onTradeClosed }) {
    this.executor = executor;
    this.notify = notify || (() => {});
    this.onTradeClosed = onTradeClosed || (() => {});
    this._timer = null;
    this._busy = false;
    this._lastReconcileAt = 0;
  }

  start() {
    const { intervalSec } = getConfig().monitor;
    this.stop();
    this._timer = setInterval(() => this.tick().catch((e) => log.error('tick error:', e.message)), intervalSec * 1000);
    log.info(`position monitor start (interval ${intervalSec}s)`);
    // Safety net: deteksi posisi yg on-chain balance-nya sudah 0 (swap manual di luar bot,
    // atau sell() yang gagal konfirmasi walau swap sudah sukses on-chain). Jalan sekali saat
    // startup, LALU berkala tiap tick (lihat _maybeReconcile, dibatasi monitor.onchainReconcileSec
    // agar tidak membebani RPC).
    this._reconcileAll().catch((e) => log.warn('startup safety check failed:', e.message));
    this._lastReconcileAt = Date.now();
  }

  async _reconcileAll() {
    const positions = openPositions();
    if (positions.length === 0) return;
    for (const pos of positions) {
      await this._reconcilePosition(pos);
    }
  }

  /** Reconcile on-demand terhadap saldo on-chain, dipanggil dari /status & /positions agar data yang ditampilkan selalu fresh. */
  async reconcileNow() {
    await this._reconcileAll();
  }

  /** Jalankan _reconcileAll paling sering tiap monitor.onchainReconcileSec, dipanggil dari tick(). */
  async _maybeReconcile() {
    const sec = getConfig().monitor.onchainReconcileSec ?? 60;
    if (sec <= 0) return;
    if (Date.now() - this._lastReconcileAt < sec * 1000) return;
    this._lastReconcileAt = Date.now();
    await this._reconcileAll();
  }

  /** Cek saldo on-chain satu posisi; auto-close bila 0 tapi masih tercatat terbuka. */
  async _reconcilePosition(pos) {
    try {
      const chain = this.executor.chain(pos.chain);
      const bal = await chain.tokenBalance(pos.address);
      const rawNum = typeof bal.raw === 'bigint' ? Number(bal.raw) : Number(bal.raw);
      if (rawNum <= 0 && pos.remainingPct > 0) {
        log.warn(`${pos.symbol}: on-chain balance 0 but position still open — auto-closing (reconcile)`);
        const trade = closePosition(pos, { reason: 'auto-close: on-chain balance 0 (reconcile)', receivedNative: 0, txid: pos.lastSellTx || '' });
        const saldo = await this._saldo(pos.chain);
        this.notify(
          `⚠️ Auto-close\n\n${this._link(pos)} — balance on-chain = 0, likely sold outside the bot\nBalance: ${saldo}`
        );
        this.onTradeClosed(trade);
      }
    } catch (e) {
      log.debug(`reconcile ${pos.symbol} skipped: ${e.message}`);
    }
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async tick() {
    if (this._busy) return;
    this._busy = true;
    try {
      await this._maybeReconcile();
      await this._refreshPrices();
      await this._applyRules();
    } finally {
      this._busy = false;
    }
  }

  async _refreshPrices() {
    const cfg = getConfig();
    const positions = openPositions();
    const moons = moonbags();
    if (positions.length === 0 && moons.length === 0) return;

    // Batch per chain via DexScreener /tokens/v1 (posisi aktif + moonbag sekaligus)
    const byChain = new Map();
    for (const p of positions) {
      if (!byChain.has(p.chain)) byChain.set(p.chain, { pos: [], moon: [] });
      byChain.get(p.chain).pos.push(p);
    }
    for (const m of moons) {
      if (!byChain.has(m.chain)) byChain.set(m.chain, { pos: [], moon: [] });
      byChain.get(m.chain).moon.push(m);
    }
    for (const [chainKey, { pos: list, moon }] of byChain.entries()) {
      const dsId = cfg.chains[chainKey]?.dexscreenerId;
      if (!dsId) continue;
      try {
        const addrs = [...new Set([...list, ...moon].map((p) => p.address))];
        // Retry sekali jika DexScreener gagal (rate limit / transient error)
        let pairs;
        try {
          pairs = await tokensBatch(dsId, addrs);
        } catch (e) {
          log.warn(`refresh price ${chainKey} attempt 1 failed: ${e.message}, retrying…`);
          await new Promise((r) => setTimeout(r, 2000));
          pairs = await tokensBatch(dsId, addrs);
        }
        const priceOf = (p) => {
          const mine = pairs
            .filter((x) => x?.baseToken?.address?.toLowerCase() === p.address.toLowerCase())
            .sort((a, b) => (b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0));
          const pair = mine.find((x) => x.pairAddress === p.pairAddress) || mine[0];
          return {
            price: Number(pair?.priceUsd),
            liqUsd: Number(pair?.liquidity?.usd) || 0,
            h1: Number(pair?.priceChange?.h1),
          };
        };
        const minLiq = cfg.trading.priceMinLiquidityUsd ?? 0;
        const now = Date.now();
        const staleMs = (cfg.monitor.stalePriceWarnSec ?? 600) * 1000;
        for (const p of list) {
          const { price, liqUsd, h1 } = priceOf(p);
          if (Number.isFinite(h1)) p._volPct = Math.abs(h1);
          if (!(price > 0)) {
            p._tickDropPct = 0;
            // Peringatkan jika harga stale >stalePriceWarnSec (token mungkin delisted/rug)
            if (now - p.lastPriceAt > staleMs && p.lastPriceAt > 0) {
              log.warn(`${p.symbol}: price unavailable for ${Math.round((now - p.lastPriceAt) / 1000)}s — token may be delisted`);
            }
            continue;
          }
          // Sanity: pembacaan dari pair likuiditas ~0 tidak dipercaya (glitch harga)
          if (liqUsd > 0 && liqUsd < minLiq) {
            log.warn(`${p.symbol}: price $${price} ignored (liquidity $${liqUsd.toFixed(0)} < $${minLiq})`);
            p._tickDropPct = 0;
            continue;
          }
          const prev = p.currentPrice;
          if (updatePrice(p, price) && prev > 0) {
            // Penurunan dalam SATU tick (positif = turun) — dipakai deteksi flash/glitch di SL
            p._tickDropPct = Math.max(0, ((prev - price) / prev) * 100);
          } else {
            p._tickDropPct = 0;
          }
        }
        for (const m of moon) {
          const { price, liqUsd } = priceOf(m);
          if (!(price > 0)) continue;
          // Same sanity guard as active positions: skip low-liquidity pairs
          if (liqUsd > 0 && liqUsd < minLiq) {
            log.warn(`moonbag ${m.symbol}: price $${price} ignored (liquidity $${liqUsd.toFixed(0)} < $${minLiq})`);
            continue;
          }
          updateMoonbagPrice(m, price);
        }
      } catch (e) {
        log.warn(`refresh price ${chainKey} failed (after retry):`, e.message);
      }
    }
  }

  async _applyRules() {
    const cfg = getConfig();
    for (const pos of [...openPositions()]) {
      const pnl = currentPnlPct(pos);
      try {
        // ===== 1. STOP LOSS (dinamis + konfirmasi anti-glitch/flash-dump) =====
        const dsl = cfg.trading.dynamicSl;
        const effectiveSlPct = dsl?.enabled
          ? dynamicStopLossPercent({
              baseSlPercent: cfg.trading.stopLossPct,
              volPercent: pos._volPct,
              multiplier: dsl.multiplier,
              floorPercent: dsl.floorPct,
              ceilingPercent: dsl.ceilingPct,
              minVolPercent: dsl.minVolPct,
              maxVolPercent: dsl.maxVolPct,
            })
          : cfg.trading.stopLossPct;
        if (pnl <= effectiveSlPct) {
          const flashDrop = cfg.trading.slFlashDropPct ?? 0;
          const sudden = flashDrop > 0 && (pos._tickDropPct ?? 0) >= flashDrop;
          // Penurunan mendadak menembus SL dalam satu tick → tunda, konfirmasi tick berikut.
          // Dump bertahap (tickDrop kecil) atau tick konfirmasi kedua → langsung close.
          if (sudden && !pos._slPending) {
            pos._slPending = { pnl, at: Date.now() };
            this.notify(
              `⚠️ Stop Loss — Pending\n\n${this._link(pos)} — PnL ${fmtPct(pnl)}, dropped ${(pos._tickDropPct).toFixed(0)}% in 1 tick\nRechecking next tick.`
            );
            continue;
          }
          pos._slPending = null;
          await this._closeAll(pos, effectiveSlPct !== cfg.trading.stopLossPct ? `SL (dynamic ${effectiveSlPct.toFixed(1)}%)` : 'SL');
          continue;
        }
        // Harga pulih di atas SL padahal tadi sempat pending → glitch/flash terkonfirmasi
        if (pos._slPending) {
          this.notify(
            `✅ Stop Loss — Cancelled\n\n${this._link(pos)} — PnL recovered to ${fmtPct(pnl)} (likely glitch/flash dump)`
          );
          pos._slPending = null;
        }

        // ===== 2. TP LADDER =====
        // Tier dieksekusi berurutan; sellPct dihitung dari sisa posisi saat itu.
        let laddered = false;
        for (let i = 0; i < cfg.tpLadder.length; i++) {
          const tier = cfg.tpLadder[i];
          if (pos.tpHit.includes(i) || pnl < tier.gainPct) continue;
          const isLastTier = i === cfg.tpLadder.length - 1 && tier.sellPct >= 100;
          const res = await this.executor.sell(pos.chain, pos.address, this._absolutePct(pos, tier.sellPct), { labels: pos.labels, fallbackPriceUsd: pos.currentPrice });
          recordPartialSell(pos, {
            pctOfRemaining: tier.sellPct,
            receivedNative: res.receivedNative,
            tierIndex: i,
            txid: res.txid,
          });
          this.notify(
            `🎯 Take Profit — Tier ${i + 1}\n\n${this._link(pos)} — PnL ${fmtPct(pnl)}, sold ${tier.sellPct}%\nRemaining position: ${pos.remainingPct.toFixed(1)}%`
          );
          laddered = true;
          if (isLastTier || pos.remainingPct < 1) {
            const trade = closePosition(pos, { reason: 'TP ladder complete', receivedNative: 0, txid: res.txid });
            await this._notifyClosed(pos, trade.finalPnlPct, 'TP ladder complete');
            this.onTradeClosed(trade);
            break;
          }
        }
        if (!openPositions().find((p) => p.id === pos.id)) continue;

        // ===== 3. TRAILING PROFIT (dua fase) =====
        // PRE-TP : aktif setelah peak >= activateGainPct; drop trailPct → jual 100%
        // POST-TP: (sudah kena tier TP) trailing langsung aktif; drop trailPct →
        //          jual sisa kecuali moonbagPct yang dipindah ke hold jangka panjang
        const tr = cfg.trailing;
        if (tr.enabled) {
          const postTp = pos.tpHit.length > 0;
          const peakGain = ((pos.peakPrice - pos.entryPrice) / pos.entryPrice) * 100;
          if (!pos.trailingActive && (postTp || peakGain >= tr.activateGainPct)) {
            pos.trailingActive = true;
            this.notify(
              `📈 Trailing — Active\n\n${this._link(pos)} — peak ${fmtPct(peakGain)}, trail ${tr.trailPct}%${postTp ? ' (post-TP)' : ''}`
            );
          }
          if (pos.trailingActive) {
            const dropFromPeak = ((pos.peakPrice - pos.currentPrice) / pos.peakPrice) * 100;
            if (dropFromPeak >= tr.trailPct) {
              const reason = `Trailing stop: dropped ${dropFromPeak.toFixed(1)}% from peak`;
              if (postTp && tr.moonbagPct > 0 && pos.remainingPct > tr.moonbagPct) {
                await this._exitToMoonbag(pos, reason, tr.moonbagPct);
              } else {
                await this._closeAll(pos, reason);
              }
              continue;
            }
          }
        }

        if (laddered) continue;
      } catch (e) {
        log.error(`rule error ${pos.symbol}:`, e.message);
      }
    }
  }

  /** tutup semua posisi terbuka (dipakai /closeall) → ringkasan hasil */
  async closeAllPositions(reason = 'manual closeall') {
    const results = [];
    for (const pos of [...openPositions()]) {
      try {
        const { symbol, chain } = pos;
        const trade = await this._closeAll(pos, reason);
        results.push({ symbol, chain, pnl: trade.finalPnlPct });
      } catch (e) {
        results.push({ symbol: pos.symbol, chain: pos.chain, error: e.message });
      }
    }
    return results;
  }

  /** sellPct tier dihitung dari SISA posisi → konversi ke % balance on-chain saat ini (sama saja, karena balance = sisa). */
  _absolutePct(pos, pctOfRemaining) {
    return Math.min(pctOfRemaining, 100);
  }

  /**
   * Exit post-TP: jual sisa posisi kecuali moonbagPct (dihitung dari posisi awal),
   * lalu pindahkan moonbag keluar dari slot posisi (hold jangka panjang).
   * Contoh: sisa 45%, moonbag 10% → jual 35/45 = 77.8% dari balance.
   */
  async _exitToMoonbag(pos, reason, moonbagPct) {
    const sellPctOfRemaining = ((pos.remainingPct - moonbagPct) / pos.remainingPct) * 100;
    const res = await this.executor.sell(pos.chain, pos.address, sellPctOfRemaining, { labels: pos.labels, fallbackPriceUsd: pos.currentPrice });
    recordPartialSell(pos, { pctOfRemaining: sellPctOfRemaining, receivedNative: res.receivedNative, txid: res.txid });
    const pnl = currentPnlPct(pos);
    const trade = moveToMoonbag(pos, { reason: `${reason} → moonbag ${moonbagPct}%`, receivedNative: 0, txid: res.txid });
    const saldo = await this._saldo(pos.chain);
    this.notify(
      `🌙 Moonbag\n\n${this._link(pos)} — PnL ${fmtPct(pnl)}\n${moonbagPct}% of original position held, sold ${sellPctOfRemaining.toFixed(1)}% of remainder\nBalance: ${saldo}`
    );
    this.onTradeClosed(trade);
    return trade;
  }

  async _closeAll(pos, reason) {
    const res = await this.executor.sell(pos.chain, pos.address, 100, { labels: pos.labels, fallbackPriceUsd: pos.currentPrice });
    const trade = closePosition(pos, { reason, receivedNative: res.receivedNative, txid: res.txid });
    await this._notifyClosed(pos, trade.finalPnlPct, reason);
    this.onTradeClosed(trade);
    return trade;
  }

  _link(pos) {
    const slug = getConfig().chains[pos.chain]?.gmgnSlug;
    return tokenLink(pos.symbol, slug, pos.address);
  }

  /** saldo native chain saat ini, dipakai di notif setelah close/buy — gagal → '—' (jangan block notif) */
  async _saldo(chainKey) {
    try {
      const bal = await this.executor.chain(chainKey).nativeBalance();
      return `${bal.toFixed(4)} SOL`;
    } catch {
      return '—';
    }
  }

  async _notifyClosed(pos, pnl, reason) {
    const emoji = pnl >= 0 ? '✅' : '🔻';
    const saldo = await this._saldo(pos.chain);
    this.notify(
      `${emoji} Closed\n\n${this._link(pos)} — PnL ${fmtPct(pnl)}\n${fmtUsd(pos.entryPrice)} → ${fmtUsd(pos.currentPrice)} · ${reason}\nBalance: ${saldo}`
    );
  }
}
