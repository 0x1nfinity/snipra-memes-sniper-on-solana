import { getConfig, getActiveMode } from '../config.js';
import { nativeSym, fmtHold, fmtNative } from './fmt.js';
import { tokenLink, fmtPct, sleep } from '../utils.js';
import { tradeStatsByChain, tradeStatsSince } from '../db.js';
import { effectiveMax } from '../trade/helpers.js';
import { createLogger } from '../logger.js';

const log = createLogger('reports');

let statusTimer = null;

export function wibDateHour(nowMs = Date.now()) {
  const d = new Date(nowMs + 7 * 3600 * 1000);
  return { dateStr: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}

let lastBriefingDate = null;

export function checkBriefingTrigger(nowMs = Date.now()) {
  const { dateStr, hour } = wibDateHour(nowMs);
  const isBriefing = hour >= 8 && lastBriefingDate !== dateStr;
  if (isBriefing) lastBriefingDate = dateStr;
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
  for (let i = 0; i < 240 && deps.screenBusy(); i++) await sleep(500);
  const blocks = await buildChainBlocks(deps, cfg);
  return { cfg, blocks };
}

export async function sendStatusReport(deps) {
  const d = deps || _sendDeps;
  const prepared = await prepareReport(d);
  if (!prepared) return;
  const { cfg, blocks } = prepared;
  const effMax = effectiveMax(cfg);
  d.telegram.notify(
    `📊 Periodic report\n\n` +
    `Positions ${d.openPositions().length}/${effMax} · Moonbag ${d.moonbags().length} · Auto-buy ${d.paused() ? 'off' : 'on'}\n\n` +
    blocks.join('\n\n')
  );
}

export async function sendDailyBriefing(deps) {
  const d = deps || _sendDeps;
  const prepared = await prepareReport(d);
  if (!prepared) return;
  const { cfg, blocks } = prepared;
  const effMax = effectiveMax(cfg);
  const mode = getActiveMode();
  const since = Date.now() - 24 * 3600 * 1000;

  const stats = tradeStatsSince(mode, since);
  const total = stats?.total ?? 0;
  const wins = stats?.wins ?? 0;
  const pnl24h = stats?.total_pnl_native ?? 0;
  const tradeSummary = total > 0
    ? `Closed: ${total} · Win rate: ${Math.round((wins / total) * 100)}% (${wins}W/${total - wins}L)\n24h PnL: ${fmtNative(pnl24h)}`
    : 'No trades closed in the last 24h.';

  let lessonsText = 'No new lessons in the last 24h.';
  if (d.llm) {
    const recent = d.llm.getLessons(200).filter((l) => l.at >= since);
    if (recent.length) {
      lessonsText = recent.map((l) => `• [${l.outcome}] ${l.text}`).join('\n');
    }
  }

  d.telegram.notify(
    `🌅 Daily briefing\n\n` +
    `Positions ${d.openPositions().length}/${effMax} · Moonbag ${d.moonbags().length} · Auto-buy ${d.paused() ? 'off' : 'on'}\n\n` +
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
    const fn = checkBriefingTrigger() ? sendDailyBriefing : sendStatusReport;
    fn().catch((e) => log.warn('status report failed:', e.message));
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
