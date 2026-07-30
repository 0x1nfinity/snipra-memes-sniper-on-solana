import { openPositions } from '../../positions/state.js';
import { tokenLink, fmtPct, fmtUsd, shortAddr } from '../../utils.js';
import { chainBlocks } from '../fmt.js';

export async function buy(args, msg, deps) {
  if (args.length < 2) return deps.send('Usage: /buy <chain> <address> [amount]');
  const [chain, address, amount] = args;
  const pos = await deps.buyToken(chain, address, amount ? Number(amount) : undefined, 'manual');
  return deps.send(
    `✅ BUY ${tokenLink(pos.symbol, deps.chainSlug(chain), pos.address)} @ ${fmtUsd(pos.entryPrice)}\ntx: \`${pos.txid}\``
  );
}

export async function sell(args, msg, deps) {
  if (!args[0]) return deps.send('Usage: /sell <address> [pct]');
  const pct = args[1] ? Number(args[1]) : 100;
  const res = await deps.sellToken(args[0], pct);
  return deps.send(`✅ SELL ${pct}% ${shortAddr(args[0])}\ntx: \`${res.txid}\``);
}

export async function closeall(args, msg, deps) {
  const list = openPositions();
  if (list.length === 0) return deps.send('Tidak ada posisi terbuka.');
  await deps.send(`⏳ Menutup ${list.length} posisi…`);
  const results = await deps.closeAll('manual /closeall');
  const byChain = {};
  for (const r of results) {
    (byChain[r.chain] ??= []).push(
      r.error ? `⚠️ ${r.symbol} — ${r.error}` : `${r.pnl >= 0 ? '✅' : '🔻'} ${r.symbol} ${fmtPct(r.pnl)}`
    );
  }
  const ok = results.filter((r) => !r.error);
  const avg = ok.length ? ok.reduce((s, r) => s + r.pnl, 0) / ok.length : 0;
  return deps.send(
    `🏁 *CLOSEALL* · ${ok.length}/${results.length} ditutup · avg ${fmtPct(avg)}\n\n` +
    chainBlocks(byChain, { gapBetweenItems: false })
  );
}

export async function screen(args, msg, deps) {
  await deps.send('🔍 Screening + auto-buy berjalan…');
  await deps.screenNow();
}

export async function pause(args, msg, deps) {
  deps.setPaused(true);
  return deps.send('⏸ Auto-buy dijeda. Monitor posisi tetap jalan.');
}

export async function resume(args, msg, deps) {
  deps.setPaused(false);
  return deps.send('▶️ Auto-buy dilanjutkan.');
}
