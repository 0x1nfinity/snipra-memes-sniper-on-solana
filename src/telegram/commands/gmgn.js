import { walletActivity } from '../../gmgn/openapi.js';

/** Diagnostic only: dump the raw GMGN wallet_activity response for the live wallet
 *  so we can see the real field names before wiring this into any live logic. */
export async function gmgnactivity(args, msg, deps) {
  const address = deps.executor.chain('solana').address;
  if (!address) return deps.send('⚠️ Solana wallet not configured.');
  const limit = args[0] ? Number(args[0]) : 5;
  try {
    const raw = await walletActivity(address, { limit });
    const text = JSON.stringify(raw, null, 2);
    return deps.send('```\n' + text.slice(0, 3500) + '\n```');
  } catch (e) {
    return deps.send(`⚠️ GMGN wallet_activity failed: ${e.message}`);
  }
}
