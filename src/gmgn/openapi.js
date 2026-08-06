import crypto from 'crypto';
import { fetchJson } from '../utils.js';
import { createLogger } from '../logger.js';

const log = createLogger('gmgn-openapi');

const BASE = 'https://openapi.gmgn.ai';

function authQuery() {
  return { timestamp: Math.floor(Date.now() / 1000), client_id: crypto.randomUUID() };
}

function headers() {
  if (!process.env.GMGN_API_KEY) throw new Error('GMGN_API_KEY is empty');
  return { 'X-APIKEY': process.env.GMGN_API_KEY, 'Content-Type': 'application/json' };
}

/** GET /v1/user/wallet_activity — per-transaction activity/trade history for a wallet. */
export async function walletActivity(walletAddress, { chain = 'sol', token, limit, cursor, type } = {}) {
  const q = new URLSearchParams({
    chain,
    wallet_address: walletAddress,
    ...authQuery(),
    ...(token ? { token } : {}),
    ...(limit ? { limit: String(limit) } : {}),
    ...(cursor ? { cursor } : {}),
    ...(type ? { type } : {}),
  });
  return fetchJson(`${BASE}/v1/user/wallet_activity?${q}`, { headers: headers() });
}

/**
 * Poll wallet_activity for the entry whose tx_hash exactly matches ours.
 * Returns null immediately (no retries) if GMGN_API_KEY is unset — no point
 * burning the retry budget on a guaranteed failure.
 */
export async function findActivityByTx(walletAddress, tokenAddress, txid, { attempts = 5, delayMs = 1500 } = {}) {
  if (!process.env.GMGN_API_KEY) return null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await walletActivity(walletAddress, { token: tokenAddress, limit: 20 });
      const match = res?.data?.activities?.find((a) => a.tx_hash === txid);
      if (match) return match;
    } catch (e) {
      // network/rate-limit blips — log and retry
      // Log only status/code — never the raw message (API key is in headers, but
      // fetchJson errors could theoretically echo request config in some runtimes).
      const reason = e.statusCode ? `HTTP ${e.statusCode}` : (e.code || 'network');
      log.warn(`findActivityByTx attempt ${i + 1}/${attempts} failed: ${reason}`);
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

/** GET /v1/user/wallet_stats — aggregate realized PnL/winrate/cost for a wallet over a period. */
export async function walletStats(walletAddress, { chain = 'sol', period = '7d' } = {}) {
  if (!process.env.GMGN_API_KEY) throw new Error('GMGN_API_KEY not set — walletStats unavailable');
  const q = new URLSearchParams({ chain, wallet_address: walletAddress, period, ...authQuery() });
  return fetchJson(`${BASE}/v1/user/wallet_stats?${q}`, { headers: headers() });
}
