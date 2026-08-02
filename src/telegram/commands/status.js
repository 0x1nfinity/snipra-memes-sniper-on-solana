import { getConfig, getActiveMode } from '../../config.js';
import { openPositions, moonbags, statsSummary, currentPnlPct, getState } from '../../positions/state.js';
import { fmtUsd, fmtPct, tokenLink } from '../../utils.js';
import { effectiveMax } from '../../trade/helpers.js';
import { nativeSym, fmtHold } from '../fmt.js';

export async function status(args, msg, deps) {
  await deps.positionManager.reconcileNow();
  const cfg = getConfig();
  const bal = await deps.executor.balances();
  const effMax = effectiveMax(cfg);
  const lines = Object.values(bal).map(
    (b) => (b.error ? `⚠️ ${b.error}` : `*${b.native?.toFixed(4)} ${nativeSym()}*`)
  );

  const onEnabled = (x) => cfg.chains[x.chain]?.enabled;
  const list = openPositions().filter(onEnabled);
  const moons = moonbags().filter(onEnabled);

  let msgText =
    `⚙️ *Status* · ${getActiveMode() === 'paper' ? '📝 paper' : '🟢 LIVE'}\n\n` +
    `Auto-buy ${deps.isPaused() ? '⏸ paused' : '▶️ active'}\n` +
    `Positions ${openPositions().length}/${effMax}\n` +
    `Moonbag ${moonbags().length}\n` +
    `🧠 LLM ${cfg.llm.enabled ? cfg.llm.provider : 'off'}\n` +
    `🧬 Darwin ${cfg.darwin.enabled ? 'on' : 'off'}\n\n` +
    `*Balance${getActiveMode() === 'paper' ? ' (virtual)' : ''}*: ${lines.join(' · ')}`;

  if (list.length > 0) {
    const items = list.map((p) => {
      const pnl = currentPnlPct(p);
      const peak = ((p.peakPrice - p.entryPrice) / p.entryPrice) * 100;
      return (
        `${pnl >= 0 ? '🟢' : '🔴'} ${tokenLink(p.symbol, deps.chainSlug(p.chain), p.address)} *${fmtPct(pnl)}* · ⏱ ${fmtHold(p.openedAt)}\n` +
        `   ${fmtUsd(p.entryPrice)} → ${fmtUsd(p.currentPrice)} · peak ${fmtPct(peak)}\n` +
        `   remaining ${p.remainingPct.toFixed(0)}% · TP ${p.tpHit.length} · trailing ${p.trailingActive ? 'on' : 'off'}`
      );
    });
    msgText += `\n\n📋 *Positions (${list.length})*\n\n${items.join('\n\n')}`;
  }

  if (moons.length > 0) {
    const moonLines = moons.map((m) => {
      const pnl = m.entryPrice > 0 ? ((m.currentPrice - m.entryPrice) / m.entryPrice) * 100 : 0;
      return (
        `🌙 ${tokenLink(m.symbol, deps.chainSlug(m.chain), m.address)} *${fmtPct(pnl)}*\n` +
        `   hold ${m.moonPct.toFixed(0)}% of original position · ${fmtUsd(m.entryPrice)} → ${fmtUsd(m.currentPrice)}`
      );
    });
    msgText += `\n\n━━ 🌙 *MOONBAG (${moons.length})* ━━\n\n${moonLines.join('\n\n')}`;
  }

  return deps.send(msgText);
}

export async function stats(args, msg, deps) {
  const s = statsSummary();
  const closed = getState().closed.slice(-5).reverse();
  const recent = closed
    .map((t) =>
      `${t.finalPnlPct >= 0 ? '✅' : '🔻'} ${t.symbol} *${fmtPct(t.finalPnlPct)}* · ${Math.round(t.holdMinutes)}m\n   📝 ${t.closeReason}`
    )
    .join('\n\n');
  return deps.send(
    `📊 *Stats*\n\n` +
    `Total ${s.totalTrades} · ✅ ${s.wins} · 🔻 ${s.losses}\n` +
    `Win rate *${s.winRatePct.toFixed(1)}%* · Avg PnL *${fmtPct(s.avgPnlPct)}*\n\n` +
    `*Last 5 trades*\n\n${recent || '(none yet)'}`
  );
}
