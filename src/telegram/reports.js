import { getConfig, getActiveMode } from '../config.js';
import { nativeSym, fmtHold, fmtNative } from './fmt.js';
import { tokenLink, fmtPct, sleep } from '../utils.js';
import { tradeStatsByChain, tradeStatsSince } from '../db.js';
import { effectiveMax } from '../trade/helpers.js';
import { getLastBriefingDate, setLastBriefingDate } from '../positions/state.js';
import { createLogger } from '../logger.js';

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
  const min = getConfig().telegram.managecyclemin;
  if (statusTimer) { clearTimeout(statusTimer); clearInterval(statusTimer); }
  statusTimer = null;
  if (!min || min <= 0) return;
  const periodMs = min * 60000;
  const delay = periodMs - (Date.now() % periodMs); // ke boundary berikutnya
  const doReport = () => {
    const fn = consumeBriefingTrigger() ? sendDailyBriefing : sendStatusReport;
    fn().catch((e) => log.warn('report failed:', e.message));
  };
  statusTimer = setTimeout(() => {
    doReport();
    statusTimer = setInterval(doReport, periodMs);
  }, delay);
  log.info(`status report loop start (every ${min}min, boundary wall-clock, starting in ${Math.round(delay / 1000)}s)`);
}

export function stopStatusLoop() {
  if (statusTimer) { clearTimeout(statusTimer); clearInterval(statusTimer); }
  statusTimer = null;
}
