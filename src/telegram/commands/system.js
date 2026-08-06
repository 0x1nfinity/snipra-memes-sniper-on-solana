import { recentTrades, tradeStats } from '../../db.js';
import { fmtPct } from '../../utils.js';
import { nativeSym } from '../fmt.js';
import { recentLogs } from '../../logger.js';

const START = `🚀 *snipra v2 — Solana meme sniper*

Selamat datang! Bot sudah *langsung berjalan* — screening otomatis tiap interval.

*3 langkah awal:*
1. Cek status: /status
2. Lihat konfigurasi: /config
3. Ganti mode: /mode paper (simulasi) atau /mode live (on-chain real)

*Cek setelan penting:*
/set — ubah parameter (buy amount, filter, TP/SL)
/screen — pindai token sekarang + langsung beli yang lolos filter
/buy — beli token manual

Butuh daftar lengkap? /help`;

const HELP = `*snipra v2 — multi-chain meme sniper*

*Controls*
/menu — quick settings button panel
/status — bot status, open positions & balance
/pause — stop auto-buy (monitoring keeps running)
/resume — resume auto-buy
/mode paper|live — papertest vs real on-chain
/stop — shut down the bot

*Configuration*
/config — view full config
/get <path> — view a single value
/set <path> <value> — change config
  example: \`/set screener.filters.minLiquidityUsd 30000\`
  example: \`/set tpLadder [{"gainPct":50,"sellPct":30}]\`

*Trading*
/screen — screen now + immediately buy candidates that pass
/buy <chain> <address> [amount] — manual buy
/sell <address> [pct] — sell a position (default 100%)
/closeall — close all open positions
/stats — trading stats
/papertrades — paper trade history from the database
/paperreset — reset virtual balance to starting value

*Darwin & LLM*
/darwin — genome evolution status
/evolve — force evolution now
/lessons — lessons from the LLM
/logs — recent logs

*Without a command:*
• send a *contract address* → token data + Buy button
• send a *token name* (1-2 words) → top 3 results + Buy button
• send a *sentence/question* → answered by the LLM with the bot's realtime data`;

export async function start(args, msg, deps) {
  return deps.send(START);
}

export async function help(args, msg, deps) {
  return deps.send(HELP);
}

export async function logs(args, msg, deps) {
  return deps.send('```\n' + recentLogs(20).join('\n').slice(-3700) + '\n```');
}

export async function stop(args, msg, deps) {
  await deps.send('🛑 Bot shut down.');
  return deps.shutdown('telegram /stop');
}

export async function papertrades(args, msg, deps) {
  const rows = recentTrades('paper', 10);
  const s = tradeStats('paper');
  if (!s || s.total === 0) return deps.send('No paper trades closed yet.');
  const lines = rows.map((t) => {
    const held = t.hold_minutes >= 60 ? `${(t.hold_minutes / 60).toFixed(1)}h` : `${Math.round(t.hold_minutes)}m`;
    return `${t.pnl_pct >= 0 ? '✅' : '🔻'} ${t.symbol} *${fmtPct(t.pnl_pct)}* · ${t.pnl_native >= 0 ? '+' : ''}${t.pnl_native?.toFixed(4)} ${nativeSym()} · ⏱ ${held}\n   📝 ${t.close_reason}`;
  });
  return deps.send(
    `📒 *Paper trades* · ${s.total} total\n` +
    `Win rate *${((s.wins / s.total) * 100).toFixed(1)}%* · Avg PnL *${fmtPct(s.avg_pnl_pct)}*\n\n` +
    lines.join('\n\n')
  );
}

export async function paperreset(args, msg, deps) {
  const { balances, tradesDeleted, closedCount, lessonsDerived } = await deps.executor.paperReset({
    llm: deps.llm,
    positionManager: deps.positionManager,
    notify: (m) => deps.send(m),
  });
  const lines = Object.values(balances).map((v) => `${v} ${nativeSym()}`);
  const extra = [];
  if (closedCount > 0) extra.push(`${closedCount} positions closed`);
  if (lessonsDerived > 0) extra.push(`${lessonsDerived} lessons saved`);
  return deps.send(
    `♻️ *Paper reset*\n${lines.join('\n')}\n` +
    `📊 Realized PnL → *0* · ${tradesDeleted} paper trades deleted` +
    (extra.length ? `\n_(${extra.join(', ')})_` : '')
  );
}
