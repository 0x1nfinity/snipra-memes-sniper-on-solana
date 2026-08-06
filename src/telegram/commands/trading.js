import { openPositions } from '../../positions/state.js';
import { tokenLink, fmtPct, fmtUsd, shortAddr } from '../../utils.js';

export async function buy(args, msg, deps) {
  if (args.length < 1) return deps.send('Usage: /buy <address> [amount]');
  const chain = 'solana';
  const [address, amount] = args;
  const pos = await deps.buyToken(chain, address, amount ? Number(amount) : undefined, 'manual');
  const saldo = await deps.executor.chain(chain).nativeBalance().catch(() => null);
  return deps.send(
    `✅ BUY ${tokenLink(pos.symbol, deps.chainSlug(chain), pos.address)} @ ${fmtUsd(pos.entryPrice)}` +
    (saldo != null ? `\nBalance: ${saldo.toFixed(4)} SOL` : '')
  );
}

export async function sell(args, msg, deps) {
  if (!args[0]) return deps.send('Usage: /sell <address> [pct]');
  const pct = args[1] ? Number(args[1]) : 100;
  const res = await deps.sellToken(args[0], pct);
  const saldo = res.chain ? await deps.executor.chain(res.chain).nativeBalance().catch(() => null) : null;
  return deps.send(
    `✅ SELL ${pct}% ${shortAddr(args[0])}` +
    (saldo != null ? `\nBalance: ${saldo.toFixed(4)} SOL` : '')
  );
}

export async function closeall(args, msg, deps) {
  const list = openPositions();
  if (list.length === 0) return deps.send('No open positions.');
  await deps.send(`⏳ Closing ${list.length} positions…`);
  const results = await deps.closeAll('manual /closeall');
  const lines = results.map((r) =>
    r.error ? `⚠️ ${r.symbol} — ${r.error}` : `${r.pnl >= 0 ? '✅' : '🔻'} ${r.symbol} ${fmtPct(r.pnl)}`
  );
  const ok = results.filter((r) => !r.error);
  const avg = ok.length ? ok.reduce((s, r) => s + r.pnl, 0) / ok.length : 0;
  return deps.send(
    `🏁 *CLOSEALL* · ${ok.length}/${results.length} closed · avg ${fmtPct(avg)}\n\n` +
    lines.join('\n')
  );
}

export async function screen(args, msg, deps) {
  await deps.send('🔍 Screening + auto-buy running…');
  await deps.screenNow();
}

export async function pause(args, msg, deps) {
  deps.setPaused(true);
  return deps.send('⏸ Auto-buy paused. Position monitoring keeps running.');
}

export async function resume(args, msg, deps) {
  deps.setPaused(false);
  return deps.send('▶️ Auto-buy resumed.');
}
