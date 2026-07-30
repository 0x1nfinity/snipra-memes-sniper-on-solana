import { getConfig, getActiveMode } from '../../config.js';
import { openPositions, moonbags, statsSummary, currentPnlPct, getState } from '../../positions/state.js';
import { fmtUsd, fmtPct, shortAddr, tokenLink } from '../../utils.js';
import { chainEmoji, nativeSym, chainBlocks, fmtHold } from '../fmt.js';

export async function status(args, msg, deps) {
  const cfg = getConfig();
  const bal = await deps.executor.balances();
  const effectiveMax = cfg.activeChain === 'both' ? cfg.trading.maxPositions : cfg.trading.maxPerChain;
  const lines = Object.entries(bal).map(
    ([k, b]) => `${chainEmoji(k)} ${k}: ${b.error ? `⚠️ ${b.error}` : `*${b.native?.toFixed(4)} ${nativeSym(k)}*`} · ${shortAddr(b.address)}`
  );
  return deps.send(
    `⚙️ *Status* · ${getActiveMode() === 'paper' ? '📝 paper' : '🔴 LIVE'}\n\n` +
    `Auto-buy ${deps.isPaused() ? '⏸ paused' : '▶️ aktif'} · Posisi ${openPositions().length}/${effectiveMax} · Moonbag ${moonbags().length}\n` +
    `🧠 LLM ${cfg.llm.enabled ? cfg.llm.provider : 'off'} · 🧬 Darwin ${cfg.darwin.enabled ? 'on' : 'off'}\n\n` +
    `*Saldo${getActiveMode() === 'paper' ? ' (virtual)' : ''}*\n${lines.join('\n')}`
  );
}

export async function positions(args, msg, deps) {
  const cfg = getConfig();
  const onEnabled = (x) => cfg.chains[x.chain]?.enabled;
  const list = openPositions().filter(onEnabled);
  const moons = moonbags().filter(onEnabled);
  if (list.length === 0 && moons.length === 0) return deps.send('Tidak ada posisi terbuka.');
  const byChain = {};
  for (const p of list) {
    const pnl = currentPnlPct(p);
    const peak = ((p.peakPrice - p.entryPrice) / p.entryPrice) * 100;
    const item =
      `${pnl >= 0 ? '🟢' : '🔴'} ${tokenLink(p.symbol, deps.chainSlug(p.chain), p.address)} *${fmtPct(pnl)}* · ⏱ ${fmtHold(p.openedAt)}\n` +
      `   ${fmtUsd(p.entryPrice)} → ${fmtUsd(p.currentPrice)} · peak ${fmtPct(peak)}\n` +
      `   sisa ${p.remainingPct.toFixed(0)}% · TP ${p.tpHit.length} · trailing ${p.trailingActive ? 'on' : 'off'}\n` +
      `   \`${p.address}\``;
    (byChain[p.chain] ??= []).push(item);
  }
  let msgText = `📋 *Posisi (${list.length})*\n\n${chainBlocks(byChain)}`;
  if (moons.length > 0) {
    const moonLines = moons.map((m) => {
      const pnl = m.entryPrice > 0 ? ((m.currentPrice - m.entryPrice) / m.entryPrice) * 100 : 0;
      return (
        `🌙 ${tokenLink(m.symbol, deps.chainSlug(m.chain), m.address)} (${m.chain}) *${fmtPct(pnl)}*\n` +
        `   hold ${m.moonPct.toFixed(0)}% posisi awal · ${fmtUsd(m.entryPrice)} → ${fmtUsd(m.currentPrice)}\n` +
        `   \`${m.address}\``
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
    `📊 *Statistik*\n\n` +
    `Total ${s.totalTrades} · ✅ ${s.wins} · 🔻 ${s.losses}\n` +
    `Win rate *${s.winRatePct.toFixed(1)}%* · Avg PnL *${fmtPct(s.avgPnlPct)}*\n\n` +
    `*5 trade terakhir*\n\n${recent || '(belum ada)'}`
  );
}
