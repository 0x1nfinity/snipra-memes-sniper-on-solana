import { getConfig } from '../config.js';
import { nativePriceUsd } from '../prices.js';
import { fetchTokenInfo as cliFetchTokenInfo } from '../gmgn/cli.js';
import {
  openPositions, updatePrice, currentPnlPct, recordPartialSell, closePosition,
  moonbags, moveToMoonbag, updateMoonbagPrice,
} from './state.js';
import { fmtPct, fmtUsd, tokenLink, dynamicStopLossPercent, mapLimit } from '../utils.js';
import { createLogger } from '../logger.js';
import { appendDecision } from '../decision-log.js';
import { getActiveMode } from '../config.js';

const log = createLogger('positions');

/**
 * Normalize close reason string → canonical short tag untuk audit log.
 * Input bisa verbose string dari manager.js (mis. "Trailing stop: dropped 5.0% from peak",
 * "SL (dynamic -45.0%)", "Max hold time reached"). Output selalu salah satu dari:
 *   'SL' | 'TP1' | 'TP2' | 'TP3' | 'trailing' | 'moonbag' | 'manual'
 *   | 'MAX_HOLD' | 'SIDEWAYS_TIMEOUT' | 'manage-LLM' | 'paper reset' | 'auto-close: on-chain balance 0'
 */
function normalizeCloseReason(reason) {
  if (!reason) return 'manual';
  const r = String(reason).toLowerCase();
  if (r.startsWith('sl') || r.includes('stopdown')) return 'SL';
  if (r.startsWith('max hold')) return 'MAX_HOLD';
  if (r.startsWith('sideways')) return 'SIDEWAYS_TIMEOUT';
  if (r.startsWith('manage-llm')) return 'manage-LLM';
  if (r.startsWith('trailing')) return 'trailing';
  if (r.startsWith('tp ladder')) return 'TP1'; // fallback for "TP ladder complete"
  if (r.startsWith('paper reset')) return 'paper reset';
  if (r.includes('reconcile') || r.includes('on-chain balance 0')) return 'auto-close: on-chain balance 0';
  return 'manual';
}

/**
 * Exit karena waktu, independen dari PnL: MAX_HOLD (batas hold total) dan
 * SIDEWAYS_TIMEOUT (PnL mandek terlalu lama, bebaskan slot). MAX_HOLD menang
 * kalau keduanya sama-sama terpicu. 0 = timer nonaktif.
 * Pure function (tanpa akses posisi/DB) supaya gampang di-unit-test.
 */
export function shouldTimeExit({ ageMinutes, pnlPct, maxHoldMinutes, sidewaysTimeoutMinutes, sidewaysPnlBandPct }) {
  if (maxHoldMinutes > 0 && ageMinutes >= maxHoldMinutes) return 'MAX_HOLD';
  if (sidewaysTimeoutMinutes > 0 && ageMinutes >= sidewaysTimeoutMinutes && Math.abs(pnlPct) < sidewaysPnlBandPct) {
    return 'SIDEWAYS_TIMEOUT';
  }
  return null;
}

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
        if (!trade) return; // sudah di-close di jalur lain (race) — idempotency guard
        // Audit trail: auto-close (on-chain balance 0)
        appendDecision({
          type: 'sell',
          mode: getActiveMode(),
          chain: pos.chain,
          address: pos.address,
          symbol: pos.symbol,
          reason: 'auto-close: on-chain balance 0',
          pnlPct: trade.finalPnlPct,
          pnlNative: (trade.realizedNative ?? 0) - (trade.amountNative ?? 0),
          receivedNative: 0,
        });
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

    // === Primary: gmgn-cli token info per address (parallel, 5 concurrent) ===
    // Hermes-style PnL: setiap posisi aktif di-poll harga via subprocess.
    // Key yg dipakai: GMGN_API_KEYS[2] (purpose='pnl') — beda dari screening/manage
    // agar 3 key di .env tidak share rate-limit budget.
    const allAddrs = [...new Set([
      ...positions.map((p) => p.address),
      ...moons.map((m) => m.address),
    ])];
    const priceMap = new Map(); // address → { priceNative, liqUsd, h1, source }
    await mapLimit(allAddrs, 5, async (addr) => {
      try {
        const info = await cliFetchTokenInfo(addr, { purpose: 'pnl' });
        const priceUsd = Number(info?.price?.price);
        const liqUsd = Number(info?.liquidity) || 0;
        const h1 = Number(info?.price?.price_change_1h);
        if (Number.isFinite(priceUsd) && priceUsd > 0) {
          // Convert USD → SOL via nativePriceUsd (cached, 60s TTL).
          let priceNative = priceUsd;
          try {
            const solUsd = await nativePriceUsd('solana');
            if (solUsd > 0) priceNative = priceUsd / solUsd;
          } catch { /* keep USD value as last resort */ }
          priceMap.set(addr, {
            priceNative,
            liqUsd,
            h1: Number.isFinite(h1) ? h1 : undefined,
            source: 'gmgn-cli',
          });
        }
      } catch (e) {
        log.debug(`gmgn-cli token info ${addr.slice(0, 6)}… failed: ${e.message}`);
      }
    });

    const minLiq = cfg.trading.priceMinLiquidityUsd ?? 0;
    const now = Date.now();
    const staleMs = (cfg.monitor.stalePriceWarnSec ?? 600) * 1000;
    for (const p of positions) {
      const data = priceMap.get(p.address);
      const usable = data && data.priceNative > 0 && !(data.liqUsd > 0 && data.liqUsd < minLiq);
      if (!usable) {
        // === Fallback 1: Jupiter quote (live only — paper tidak punya wallet) ===
        try {
          const chain = this.executor.chain(p.chain);
          if (typeof chain.quoteSellPriceUsd === 'function') {
            const nativePx = await chain.quoteSellPriceUsd(p.address).catch(() => null);
            if (nativePx > 0) {
              const prev = p.currentPrice;
              const sameSource = p._priceSource === 'quote';
              if (updatePrice(p, nativePx) && prev > 0 && sameSource) {
                p._tickDropPct = Math.max(0, ((prev - nativePx) / prev) * 100);
              } else {
                p._tickDropPct = 0;
              }
              p._priceSource = 'quote';
              if (data && Number.isFinite(data.h1)) {
                p._volPct = Math.abs(data.h1);
                p._volPctAt = Date.now();
              }
              continue;
            }
          }
        } catch (e) {
          log.debug(`${p.symbol}: Jupiter quote fallback failed: ${e.message}`);
        }
        p._tickDropPct = 0;
        if (now - p.lastPriceAt > staleMs && p.lastPriceAt > 0) {
          log.warn(`${p.symbol}: price unavailable for ${Math.round((now - p.lastPriceAt) / 1000)}s — token may be delisted`);
        }
        continue;
      }
      const prev = p.currentPrice;
      const sameSource = p._priceSource === data.source;
      if (updatePrice(p, data.priceNative) && prev > 0 && sameSource) {
        p._tickDropPct = Math.max(0, ((prev - data.priceNative) / prev) * 100);
      } else {
        p._tickDropPct = 0;
      }
      p._priceSource = data.source;
      if (Number.isFinite(data.h1)) {
        p._volPct = Math.abs(data.h1);
        p._volPctAt = Date.now();
      } else if (p._volPctAt && Date.now() - p._volPctAt > 30 * 60 * 1000) {
        // h1 data stale > 30 min — reset, fall back to base SL without widening
        p._volPct = undefined;
        p._volPctAt = undefined;
      }
    }
    for (const m of moons) {
      const data = priceMap.get(m.address);
      if (!data || !(data.priceNative > 0)) continue;
      if (data.liqUsd > 0 && data.liqUsd < minLiq) {
        log.warn(`moonbag ${m.symbol}: price $${data.priceNative} ignored (liquidity $${data.liqUsd.toFixed(0)} < $${minLiq})`);
        continue;
      }
      updateMoonbagPrice(m, data.priceNative);
    }
  }

  async _applyRules() {
    const cfg = getConfig();
    for (const pos of [...openPositions()]) {
      const pnl = currentPnlPct(pos);
      try {
        // ===== 0. TIME-BASED EXIT (independen dari PnL/SL/TP) =====
        const timeReason = shouldTimeExit({
          ageMinutes: (Date.now() - pos.openedAt) / 60000,
          pnlPct: pnl,
          maxHoldMinutes: cfg.trading.maxHoldMinutes ?? 0,
          sidewaysTimeoutMinutes: cfg.trading.sidewaysTimeoutMinutes ?? 0,
          sidewaysPnlBandPct: cfg.trading.sidewaysPnlBandPct ?? 2,
        });
        if (timeReason) {
          await this._closeAll(pos, timeReason === 'MAX_HOLD' ? 'Max hold time reached' : `Sideways timeout (PnL ${fmtPct(pnl)})`);
          continue;
        }

        // ===== 1. STOP LOSS (dinamis + konfirmasi anti-glitch/flash-dump) =====
        const dsl = cfg.trading.dynamicSl;
        const baseSlPct = pos.slPct ?? cfg.trading.stopLossPct;
        const effectiveSlPct = dsl?.enabled
          ? dynamicStopLossPercent({
              baseSlPercent: baseSlPct,
              volPercent: pos._volPct,
              multiplier: dsl.multiplier,
              floorPercent: dsl.floorPct,
              ceilingPercent: dsl.ceilingPct,
              minVolPercent: dsl.minVolPct,
              maxVolPercent: dsl.maxVolPct,
            })
          : baseSlPct;
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
          await this._closeAll(pos, effectiveSlPct !== baseSlPct ? `SL (dynamic ${effectiveSlPct.toFixed(1)}%)` : 'SL');
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
          // Audit trail: partial sell (TP ladder hit)
          appendDecision({
            type: 'sell',
            mode: getActiveMode(),
            chain: pos.chain,
            address: pos.address,
            symbol: pos.symbol,
            reason: `TP${i + 1}`,
            pnlPct: pnl,
            pnlNative: (res.receivedNative || 0) - (pos.amountNative * (tier.sellPct / 100) * (1 - pos.realizedNative / Math.max(pos.amountNative, 1e-9))),
            receivedNative: res.receivedNative,
            tierIndex: i,
          });
          this.notify(
            `🎯 Take Profit — Tier ${i + 1}\n\n${this._link(pos)} — PnL ${fmtPct(pnl)}, sold ${tier.sellPct}%\nRemaining position: ${pos.remainingPct.toFixed(1)}%`
          );
          laddered = true;
          if (isLastTier || pos.remainingPct < 1) {
            const trade = closePosition(pos, { reason: 'TP ladder complete', receivedNative: 0, txid: res.txid });
            if (trade) {
              await this._notifyClosed(pos, trade.finalPnlPct, 'TP ladder complete');
              this.onTradeClosed(trade);
            }
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
          const activateGainPct = pos.trailingActivateGainPct ?? tr.activateGainPct;
          const trailPct = pos.trailingTrailPct ?? tr.trailPct;
          const peakGain = pos.entryPrice > 0 ? ((pos.peakPrice - pos.entryPrice) / pos.entryPrice) * 100 : 0;
          if (!pos.trailingActive && (postTp || peakGain >= activateGainPct)) {
            pos.trailingActive = true;
            this.notify(
              `📈 Trailing — Active\n\n${this._link(pos)} — peak ${fmtPct(peakGain)}, trail ${trailPct}%${postTp ? ' (post-TP)' : ''}`
            );
          }
          if (pos.trailingActive) {
            const dropFromPeak = ((pos.peakPrice - pos.currentPrice) / pos.peakPrice) * 100;
            if (dropFromPeak >= trailPct) {
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
    // Prevent racing with tick() which also iterates and sells positions
    while (this._busy) await new Promise((r) => setTimeout(r, 200));
    this._busy = true;
    try {
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
    } finally {
      this._busy = false;
    }
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
    // Audit trail: partial sell to moonbag
    appendDecision({
      type: 'sell',
      mode: getActiveMode(),
      chain: pos.chain,
      address: pos.address,
      symbol: pos.symbol,
      reason: 'moonbag',
      pnlPct: pnl,
      pnlNative: (res.receivedNative || 0) - (pos.amountNative * (sellPctOfRemaining / 100)),
      receivedNative: res.receivedNative,
    });
    const trade = moveToMoonbag(pos, { reason: `${reason} → moonbag ${moonbagPct}%`, receivedNative: 0, txid: res.txid });
    if (!trade) return null; // sudah di-close di jalur lain (race) — idempotency guard
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
    if (!trade) return null; // sudah di-close di jalur lain (race) — idempotency guard
    // Audit trail: full close (SL / TP / trailing / time-exit / manual)
    appendDecision({
      type: 'sell',
      mode: getActiveMode(),
      chain: pos.chain,
      address: pos.address,
      symbol: pos.symbol,
      reason: normalizeCloseReason(reason),
      pnlPct: trade.finalPnlPct,
      pnlNative: (trade.realizedNative ?? 0) - (trade.amountNative ?? 0),
      receivedNative: res.receivedNative,
      txid: res.txid,
    });
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
    const px = await nativePriceUsd(pos.chain);
    const entryUsd = (pos.entryPrice || 0) * px;
    const exitUsd = (pos.currentPrice || 0) * px;
    this.notify(
      `${emoji} Closed\n\n${this._link(pos)} — PnL ${fmtPct(pnl)}\n${fmtUsd(entryUsd)} → ${fmtUsd(exitUsd)} · ${reason}\nBalance: ${saldo}`
    );
  }
}
