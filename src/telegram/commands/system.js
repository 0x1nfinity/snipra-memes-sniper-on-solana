import { recentTrades, tradeStats } from '../../db.js';
import { fmtPct } from '../../utils.js';
import { nativeSym, chainBlocks, chainEmoji } from '../fmt.js';
import { recentLogs } from '../../logger.js';

const HELP = `*snipra v2 — multi-chain meme sniper*

*Kontrol*
/menu — panel tombol pengaturan cepat
/status — kondisi bot & saldo
/pause — stop auto-buy (monitor tetap jalan)
/resume — lanjut auto-buy
/mode paper|live — papertest vs on-chain sungguhan
/stop — matikan bot

*Konfigurasi*
/config — lihat semua config
/get <path> — lihat satu nilai
/set <path> <value> — ubah config
  contoh: \`/set screener.filters.minLiquidityUsd 30000\`
  contoh: \`/set tpLadder [{"gainPct":50,"sellPct":30}]\`

*Trading*
/screen — screening sekarang + langsung buy yang lolos
/buy <chain> <address> [amount] — buy manual
/sell <address> [pct] — sell posisi (default 100%)
/closeall — tutup semua posisi terbuka
/positions — posisi terbuka + PnL
/stats — statistik trading
/papertrades — riwayat paper trade dari database
/paperreset — reset saldo virtual ke awal

*Darwin & LLM*
/darwin — status evolusi genome
/evolve — paksa evolusi sekarang
/lessons — lessons dari LLM
/logs — log terakhir

*Tanpa command:*
• kirim *contract address* → data token + tombol Buy
• kirim *nama token* (1-2 kata) → 3 hasil terbaik + tombol Buy
• kirim *kalimat/pertanyaan* → dijawab LLM dengan data realtime bot`;

export async function help(args, msg, deps) {
  return deps.send(HELP);
}

export { help as start };

export async function logs(args, msg, deps) {
  return deps.send('```\n' + recentLogs(20).join('\n').slice(-3700) + '\n```');
}

export async function stop(args, msg, deps) {
  await deps.send('🛑 Bot dimatikan.');
  return deps.shutdown('telegram /stop');
}

export async function papertrades(args, msg, deps) {
  const rows = recentTrades('paper', 10);
  const s = tradeStats('paper');
  if (!s || s.total === 0) return deps.send('Belum ada paper trade yang close.');
  const byChain = {};
  for (const t of rows) {
    const held = t.hold_minutes >= 60 ? `${(t.hold_minutes / 60).toFixed(1)}h` : `${Math.round(t.hold_minutes)}m`;
    (byChain[t.chain] ??= []).push(
      `${t.pnl_pct >= 0 ? '✅' : '🔻'} ${t.symbol} *${fmtPct(t.pnl_pct)}* · ${t.pnl_native >= 0 ? '+' : ''}${t.pnl_native?.toFixed(4)} ${nativeSym(t.chain)} · ⏱ ${held}\n   📝 ${t.close_reason}`
    );
  }
  return deps.send(
    `📒 *Paper trades* · ${s.total} total\n` +
    `Win rate *${((s.wins / s.total) * 100).toFixed(1)}%* · Avg PnL *${fmtPct(s.avg_pnl_pct)}*\n\n` +
    chainBlocks(byChain)
  );
}

export async function paperreset(args, msg, deps) {
  const { balances, tradesDeleted } = await deps.executor.paperReset();
  const lines = Object.entries(balances).map(([k, v]) => `${chainEmoji(k)} ${k}: ${v} ${nativeSym(k)}`);
  return deps.send(
    `♻️ *Paper direset*\n${lines.join('\n')}\n` +
    `📊 Realized PnL → *0* · ${tradesDeleted} trade paper dihapus dari statistik\n` +
    `_(posisi terbuka tidak ditutup)_`
  );
}
