import { getConfig, getActiveMode } from '../config.js';
import { openPositions, currentPnlPct, closePosition, getLastBriefingDate, setLastBriefingDate } from '../positions/state.js';
import { nativeSym, fmtHold, fmtNative } from './fmt.js';
import { tokenLink, fmtPct, sleep, boundaryAlignedSetInterval } from '../utils.js';
import { tradeStatsByChain, tradeStatsSince } from '../db.js';
import { effectiveMax } from '../trade/helpers.js';
import { createLogger } from '../logger.js';
import { fetchTokenInfo as cliFetchTokenInfo } from '../gmgn/cli.js';

const log = createLogger('reports');

let statusTimer = null;

export function wibDateHour(nowMs = Date.now()) {
  const d = new Date(nowMs + 7 * 3600 * 1000);
  return { dateStr: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}

export function consumeBriefingTrigger(nowMs = Date.now()) {
  const { dateStr, hour } = wibDateHour(nowMs);
  // Dibaca dari state persisted (positions.<mode>.json), bukan variable in-memory —
  // supaya restart bot tidak mereset "sudah terkirim hari ini" dan memicu briefing dobel.
  const isBriefing = hour >= 7 && getLastBriefingDate() !== dateStr;
  if (isBriefing) setLastBriefingDate(dateStr);
  return isBriefing;
}

// Module-level deps for instance-level references (executor, telegram, callbacks, mutable state).
// Set from index.js during initialization via setStatusDeps().
let _sendDeps = {};

export function setStatusDeps(deps) {
  _sendDeps = deps;
}

async function buildChainBlocks(deps, cfg) {
  const { executor, openPositions, currentPnlPct } = deps;
  const bal = await executor.balances();
  const realizedByChain = Object.fromEntries(
    tradeStatsByChain(getActiveMode()).map((r) => [r.chain, r])
  );
  const blocks = [];
  for (const [chainKey, b] of Object.entries(bal)) {
    const sym = nativeSym(chainKey);
    const chainPos = openPositions().filter((x) => x.chain === chainKey);
    let unrealized = 0;
    for (const p of chainPos) {
      const invested = p.amountNative * (p.remainingPct / 100);
      unrealized += invested * (currentPnlPct(p) / 100);
    }
    const r = realizedByChain[chainKey];
    const realized = r?.pnl_native ?? 0;
    const posLines = chainPos.length
      ? chainPos.map((p) => {
          const pnl = currentPnlPct(p);
          return `  ${pnl >= 0 ? '🟢' : '🔴'} ${tokenLink(p.symbol, cfg.chains[chainKey]?.gmgnSlug, p.address)} ${fmtPct(pnl)} · ${fmtHold(p.openedAt)}`;
        }).join('\n')
      : '  (no open positions)';
    blocks.push(
      `Balance: ${b.error ? `⚠️ ${b.error}` : `${b.native.toFixed(4)} ${sym}`}\n` +
      `Unrealized: ${fmtNative(unrealized, chainKey)}\n` +
      `Realized: ${fmtNative(realized, chainKey)}${r ? ` (${r.total} closed)` : ''}\n\n` +
      `Positions (${chainPos.length}):\n${posLines}`
    );
  }
  return blocks;
}

async function prepareReport(deps) {
  if (deps.paused()) return null;
  const cfg = getConfig();
  // Wait for an in-progress screening to finish first, so its Telegram
  // notification arrives before this periodic/briefing report (preserves message order).
  for (let i = 0; i < 240 && deps.screenBusy(); i++) await sleep(500);
  const blocks = await buildChainBlocks(deps, cfg);
  const effMax = effectiveMax(cfg);
  const header = `Positions ${deps.openPositions().length}/${effMax} · Moonbag ${deps.moonbags().length} · Auto-buy ${deps.paused() ? 'off' : 'on'}`;
  return { cfg, blocks, header };
}

export async function sendStatusReport(deps) {
  const d = deps || _sendDeps;
  const prepared = await prepareReport(d);
  if (!prepared) return;
  const { blocks, header } = prepared;
  d.telegram.notify(
    `📊 Periodic report\n\n` +
    `${header}\n\n` +
    blocks.join('\n\n')
  );
}

export async function sendDailyBriefing(deps) {
  const d = deps || _sendDeps;
  const prepared = await prepareReport(d);
  if (!prepared) return;
  const { blocks, header } = prepared;
  const mode = getActiveMode();
  const since = Date.now() - 24 * 3600 * 1000;

  const stats = tradeStatsSince(mode, since);
  const total = stats?.total ?? 0;
  const wins = stats?.wins ?? 0;
  const pnl24h = stats?.total_pnl_native ?? 0;
  const tradeSummary = total > 0
    ? `Closed: ${total} · Win rate: ${Math.round((wins / total) * 100)}% (${wins}W/${total - wins}L)\n24h PnL: ${fmtNative(pnl24h)}`
    : 'No trades closed in the last 24h.';

  const LESSONS_LIMIT = 15;
  let lessonsText = 'No new lessons in the last 24h.';
  if (d.llm) {
    const recent = d.llm.getLessons(200).filter((l) => l.at >= since);
    if (recent.length) {
      const shown = recent.slice(0, LESSONS_LIMIT);
      lessonsText = shown.map((l) => `• [${l.outcome}] ${l.text}`).join('\n');
      if (recent.length > LESSONS_LIMIT) {
        lessonsText += `\n…+${recent.length - LESSONS_LIMIT} more`;
      }
    }
  }

  d.telegram.notify(
    `🌅 Daily briefing\n\n` +
    `${header}\n\n` +
    blocks.join('\n\n') +
    `\n\n📈 Last 24h\n${tradeSummary}` +
    `\n\n🧠 Lessons (24h)\n${lessonsText}`
  );
}

/** jadwalkan laporan tepat di kelipatan wall-clock (mis. :00, :30) */
export function startStatusLoop() {
  if (statusTimer) statusTimer.stop();
  statusTimer = null;
  const min = getConfig().telegram.managecyclemin;
  if (!min || min <= 0) return;
  const periodMs = min * 60000;
  const doCycle = async () => {
    // Manage evaluation duluan — force-close LLM berjalan sebelum report.
    // Kalau close berhasil, report subsequent sudah reflect posisi baru.
    try {
      await runManageEvaluation(_sendDeps);
    } catch (e) {
      log.warn('manage evaluation failed:', e.message);
    }
    const fn = consumeBriefingTrigger() ? sendDailyBriefing : sendStatusReport;
    fn().catch((e) => log.warn('report failed:', e.message));
  };
  statusTimer = boundaryAlignedSetInterval(periodMs, doCycle);
  log.info(`status report loop start (every ${min}min, boundary wall-clock, starting in ${Math.round(statusTimer.delay / 1000)}s)`);
}

export function stopStatusLoop() {
  if (statusTimer) statusTimer.stop();
  statusTimer = null;
}

/**
 * Manage evaluation cycle — setiap managecyclemin (30m default):
 *   1. Ambil posisi terbuka
 *   2. Fetch current metrics via gmgn-cli token info (parallel per posisi)
 *   3. Inject entryMetrics + currentMetrics + cfgTpLadderLen ke tiap posisi
 *   4. Panggil LLM.evaluatePositions → array of {action, confidence, reason}
 *   5. Force-close posisi dengan action=close + confidence >= minConfidence
 *      (override SL/TP — LLM bilang keluar, keluar)
 *
 * Tidak throw — best-effort. Kalau LLM error/down → skip, posisi tetap di
 * PnL tracker (10s hard stop) untuk proteksi.
 */
export async function runManageEvaluation(deps) {
  const d = deps || _sendDeps;
  const cfg = getConfig();
  if (!cfg.llm.enabled) return { evaluated: 0, closed: 0 };
  if (!d.llm || !d.llm.available()) return { evaluated: 0, closed: 0 };
  if (d.paused()) return { evaluated: 0, closed: 0 };

  const positions = openPositions();
  if (positions.length === 0) return { evaluated: 0, closed: 0 };

  // Fetch current metrics per posisi (parallel via Promise.all — limit 5)
  const addrToMetrics = new Map();
  await Promise.all(positions.map(async (p) => {
    try {
      const info = await cliFetchTokenInfo(p.address, { purpose: 'manage' });
      const priceUsd = Number(info?.price?.price);
      addrToMetrics.set(p.address, {
        priceUsd: Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : null,
        marketCap: Number(info?.market_cap) || null,
        holders: info?.holder_count != null ? Number(info.holder_count) : null,
        top10Pct: info?.top_10_holder_rate != null ? Number(info.top_10_holder_rate) * 100 : null,
        smartDegenCount: info?.smart_wallets != null ? Number(info.smart_wallets)
          : (info?.wallet_tags_stat?.smart_wallets != null ? Number(info.wallet_tags_stat.smart_wallets) : null),
      });
    } catch (e) {
      log.debug(`runManageEvaluation: fetch ${p.address.slice(0, 6)} failed: ${e.message}`);
    }
  }));

  const tpLadderLen = cfg.tpLadder?.length ?? 3;
  const positionsForLlm = positions.map((p) => ({
    ...p,
    currentMetrics: addrToMetrics.get(p.address) || {},
    cfgTpLadderLen: tpLadderLen,
  }));

  const verdicts = await d.llm.evaluatePositions(positionsForLlm);
  if (!verdicts || verdicts.length === 0) return { evaluated: positions.length, closed: 0 };

  const minConf = cfg.llm.minConfidence;
  let closedCount = 0;
  const closeLines = [];

  for (let i = 0; i < verdicts.length; i++) {
    const v = verdicts[i];
    const pos = positions[i];
    if (!pos || !openPositions().some((x) => x.id === pos.id)) continue; // sudah di-close di tempat lain
    if (v.action !== 'close') continue;
    if (v.confidence < minConf) continue;

    const pnlPct = currentPnlPct(pos);
    try {
      const res = await d.executor.sell(pos.chain, pos.address, 100, {
        labels: pos.labels,
        fallbackPriceUsd: pos.currentPrice,
      });
      const trade = closePosition(pos, {
        reason: `manage-LLM (conf ${v.confidence.toFixed(2)})`,
        receivedNative: res.receivedNative,
        txid: res.txid,
      });
      if (trade && d.onTradeClosed) {
        try { d.onTradeClosed(trade); } catch (e) { log.warn('onTradeClosed failed:', e.message); }
      }
      closedCount++;
      const slug = cfg.chains[pos.chain]?.gmgnSlug;
      closeLines.push(
        `  🤖 LLM closed ${tokenLink(pos.symbol, slug, pos.address)} — ${fmtPct(pnlPct)}\n` +
        `     reason: ${v.reason || '(none)'} · conf ${v.confidence.toFixed(2)}`
      );
      log.info(`manage-LLM closed ${pos.symbol} @ ${fmtPct(pnlPct)} (conf ${v.confidence.toFixed(2)}): ${v.reason}`);
    } catch (e) {
      log.warn(`manage-LLM close ${pos.symbol} failed: ${e.message}`);
    }
  }

  if (closeLines.length > 0) {
    d.telegram.notify(
      `🤖 Manage Cycle — LLM force-close\n\n` +
      `${closedCount} posisi di-close oleh LLM (override SL/TP):\n\n` +
      closeLines.join('\n')
    );
  }

  return { evaluated: positions.length, closed: closedCount };
}
