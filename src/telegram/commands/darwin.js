import { getConfig } from '../../config.js';
import { fmtPct } from '../../utils.js';
import { recentTrades } from '../../db.js';

export async function darwin(args, msg, deps) {
  const st = deps.darwin.status();
  const medals = ['🥇', '🥈', '🥉', '4.', '5.'];
  const lines = st.genomes.slice(0, 5).map(
    (g, i) =>
      `${medals[i]} \`${g.id}\` · fit *${g.fitness.toFixed(2)}* · ${g.trades} trades · avg ${fmtPct(g.avgPnl)}`
  );
  return deps.send(
    `🧬 *Darwin* · Generasi ${st.generation}\n` +
    `Trades menuju evolve: ${st.tradesSinceEvolve}/${getConfig().darwin.evolveEveryNTrades}\n\n` +
    `*Top genomes*\n${lines.join('\n')}\n\n` +
    `*Gen terbaik:*\n\`\`\`json\n${JSON.stringify(st.genomes[0]?.genes, null, 1)}\n\`\`\``
  );
}

export async function evolve(args, msg, deps) {
  await deps.send('🧬 Menganalisa Darwin' + (getConfig().llm.enabled ? ' + LLM' : '') + ' → menyusun usulan filter…');
  await deps.runEvolve('manual'); // notifikasi usulan dikirim oleh runEvolve (tidak auto-apply)
}

export async function lessons(args, msg, deps) {
  if (args[0] === 'refresh') {
    if (!deps.llm.available()) return deps.send('❌ LLM tidak aktif/tidak terkonfigurasi — cek `/set llm.enabled true` & API key.');
    await deps.send('🧠 Menganalisa riwayat trade (paper + live) → menyusun lessons…');
    const trades = [...recentTrades('paper', 100), ...recentTrades('live', 100)];
    if (trades.length === 0) return deps.send('Belum ada riwayat trade untuk dianalisa.');
    const existing = deps.llm.getLessons(20);
    const saved = await deps.llm.deriveResetLessons(trades, existing);
    if (saved.length === 0) return deps.send('LLM tidak menghasilkan lesson baru (cek log kalau ini tidak biasa).');
    return deps.send(
      `✅ *${saved.length} lesson baru* dari ${trades.length} trade (paper+live)\n\n` +
      saved.map((t) => `• ${t}`).join('\n')
    );
  }
  const ls = deps.llm.getLessons(10);
  if (ls.length === 0) return deps.send('Belum ada lesson dari LLM. Coba `/lessons refresh` untuk analisa riwayat trade.');
  return deps.send(
    '*Lessons terakhir*\n' +
    ls.map((l) => `• [${l.outcome}] ${l.text}`).join('\n')
  );
}
