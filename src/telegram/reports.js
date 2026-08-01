import { getConfig, getActiveMode } from '../config.js';
import { chainHeader, nativeSym, fmtHold, fmtNative } from './fmt.js';
import { tokenLink, fmtPct, sleep } from '../utils.js';
import { tradeStatsByChain } from '../db.js';
import { effectiveMax } from '../trade/helpers.js';
import { createLogger } from '../logger.js';

const log = createLogger('reports');

let statusTimer = null;

// Module-level deps for instance-level references (executor, telegram, callbacks, mutable state).
// Set from index.js during initialization via setStatusDeps().
let _sendDeps = {};

export function setStatusDeps(deps) {
  _sendDeps = deps;
}

export async function sendStatusReport(deps) {
  const {
    executor, telegram, openPositions, currentPnlPct,
    moonbags, paused, screenBusy,
  } = deps || _sendDeps;
  // Jangan kirim laporan berkala saat auto-buy sedang paused.
  if (paused()) return;
  const cfg = getConfig();
  // #8 prioritas: kalau screening sedang jalan, tunggu sampai selesai agar
  // notif screening terkirim lebih dulu, baru laporan posisi.
  for (let i = 0; i < 240 && screenBusy(); i++) await sleep(500);

  const bal = await executor.balances();
  const realizedByChain = Object.fromEntries(
    tradeStatsByChain(getActiveMode()).map((r) => [r.chain, r])
  );
  const blocks = [];
  for (const [chainKey, b] of Object.entries(bal)) {
    const sym = nativeSym(chainKey);
    const chainPos = openPositions().filter((x) => x.chain === chainKey);
    // unrealized = Σ modal tersisa × pnl% posisi terbuka chain ini
    let unrealized = 0;
    for (const p of chainPos) {
      const invested = p.amountNative * (p.remainingPct / 100);
      unrealized += invested * (currentPnlPct(p) / 100);
    }
    const r = realizedByChain[chainKey];
    const realized = r?.pnl_native ?? 0;
    // daftar posisi terbuka chain ini
    const posLines = chainPos.length
      ? chainPos.map((p) => {
          const pnl = currentPnlPct(p);
          return `  ${pnl >= 0 ? '🟢' : '🔴'} ${tokenLink(p.symbol, cfg.chains[chainKey]?.gmgnSlug, p.address)} ${fmtPct(pnl)} · ${fmtHold(p.openedAt)}`;
        }).join('\n')
      : '  (no open positions)';
    blocks.push(
      `${chainHeader(chainKey)}\n` +
      `Balance: ${b.error ? `⚠️ ${b.error}` : `${b.native.toFixed(4)} ${sym}`}\n` +
      `Unrealized: ${fmtNative(unrealized, chainKey)}\n` +
      `Realized: ${fmtNative(realized, chainKey)}${r ? ` (${r.total} closed)` : ''}\n\n` +
      `Positions (${chainPos.length}):\n${posLines}`
    );
  }
  const effMax = effectiveMax(cfg);
  telegram.notify(
    `📊 Periodic report\n\n` +
    `Positions ${openPositions().length}/${effMax} · Moonbag ${moonbags().length} · Auto-buy ${paused() ? 'off' : 'on'}\n\n` +
    blocks.join('\n\n')
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
  const doReport = () => sendStatusReport().catch((e) => log.warn('status report gagal:', e.message));
  statusTimer = setTimeout(() => {
    doReport();
    statusTimer = setInterval(doReport, periodMs);
  }, delay);
  log.info(`status report loop start (tiap ${min} menit, boundary wall-clock, mulai dalam ${Math.round(delay / 1000)}s)`);
}

export function stopStatusLoop() {
  if (statusTimer) { clearTimeout(statusTimer); clearInterval(statusTimer); }
  statusTimer = null;
}
