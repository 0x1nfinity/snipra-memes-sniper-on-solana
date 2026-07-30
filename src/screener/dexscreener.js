import { fetchJson, mapLimit } from '../utils.js';
import { createLogger } from '../logger.js';

const log = createLogger('dexscreener');
const BASE = 'https://api.dexscreener.com';

// Rate limit resmi: 60/min utk endpoint discovery, 300/min utk endpoint pairs/tokens.

export async function latestTokenProfiles() {
  return fetchJson(`${BASE}/token-profiles/latest/v1`);
}

export async function latestBoosts() {
  return fetchJson(`${BASE}/token-boosts/latest/v1`);
}

export async function topBoosts() {
  return fetchJson(`${BASE}/token-boosts/top/v1`);
}

/** Semua pair utk satu token → array pair */
export async function tokenPairs(chainId, tokenAddress) {
  return fetchJson(`${BASE}/token-pairs/v1/${chainId}/${tokenAddress}`);
}

/** Batch harga/pair terbaik utk banyak token (max 30 alamat per call) */
export async function tokensBatch(chainId, addresses) {
  const out = [];
  for (let i = 0; i < addresses.length; i += 30) {
    const chunk = addresses.slice(i, i + 30);
    const res = await fetchJson(`${BASE}/tokens/v1/${chainId}/${chunk.join(',')}`);
    if (Array.isArray(res)) out.push(...res);
  }
  return out;
}

export async function search(query) {
  const res = await fetchJson(`${BASE}/latest/dex/search?q=${encodeURIComponent(query)}`);
  return res?.pairs || [];
}

/** Pilih pair paling likuid dari daftar pair sebuah token */
export function bestPair(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  return [...pairs].sort((a, b) => (b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0))[0];
}

/** Normalisasi pair DexScreener → candidate object standar internal */
export function normalizePair(pair, chainKey) {
  if (!pair?.baseToken?.address) return null;
  const buys = pair?.txns?.h24?.buys ?? 0;
  const sells = pair?.txns?.h24?.sells ?? 0;
  const ageMs = pair.pairCreatedAt ? Date.now() - pair.pairCreatedAt : null;
  return {
    chain: chainKey,
    chainId: pair.chainId,
    address: pair.baseToken.address,
    symbol: pair.baseToken.symbol,
    name: pair.baseToken.name,
    pairAddress: pair.pairAddress,
    dexId: pair.dexId,
    labels: pair.labels || [],
    priceUsd: Number(pair.priceUsd) || 0,
    priceNative: Number(pair.priceNative) || 0,
    volume24h: pair?.volume?.h24 ?? 0,
    liquidityUsd: pair?.liquidity?.usd ?? 0,
    marketCap: pair.marketCap ?? pair.fdv ?? 0,
    ageMinutes: ageMs != null ? ageMs / 60000 : null,
    buys24h: buys,
    sells24h: sells,
    traders24h: buys + sells,
    buySellRatio: sells > 0 ? buys / sells : buys > 0 ? 99 : 0,
    priceChange: {
      m5: pair?.priceChange?.m5 ?? 0,
      h1: pair?.priceChange?.h1 ?? 0,
      h6: pair?.priceChange?.h6 ?? 0,
      h24: pair?.priceChange?.h24 ?? 0,
    },
    socials: (pair?.info?.socials || []).length + (pair?.info?.websites || []).length,
    boosts: pair?.boosts?.active ?? 0,
    url: pair.url,
    // diisi GoPlus nanti:
    holders: null,
    security: null,
  };
}

/**
 * Discovery: kumpulkan alamat token kandidat dari sumber2 DexScreener
 * untuk chain yang diaktifkan, lalu resolve ke pair terlikuid.
 * chainMap: { dexscreenerChainId: chainKey }
 */
export async function discover(chainMap, sources) {
  const wanted = new Set(Object.keys(chainMap));
  const found = new Map(); // `${chain}:${addr}` → {chainId, address}

  const collectors = [];
  if (sources.tokenProfiles) collectors.push(latestTokenProfiles());
  if (sources.boostsLatest) collectors.push(latestBoosts());
  if (sources.boostsTop) collectors.push(topBoosts());

  const results = await Promise.allSettled(collectors);
  for (const r of results) {
    if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue;
    for (const item of r.value) {
      if (wanted.has(item.chainId) && item.tokenAddress) {
        found.set(`${item.chainId}:${item.tokenAddress}`, {
          chainId: item.chainId,
          address: item.tokenAddress,
        });
      }
    }
  }
  const tokens = [...found.values()];
  log.info(`discovery: ${tokens.length} token unik ditemukan`);

  // Resolve tiap token → pair terlikuid → normalize
  const candidates = await mapLimit(tokens, 4, async (t) => {
    const pairs = await tokenPairs(t.chainId, t.address);
    const best = bestPair(pairs);
    return best ? normalizePair(best, chainMap[t.chainId]) : null;
  });

  return candidates.filter((c) => c && !c.__error);
}
