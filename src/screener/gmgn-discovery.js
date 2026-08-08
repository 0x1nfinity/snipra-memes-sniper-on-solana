import crypto from 'crypto';
import { fetchJson } from '../utils.js';
import { createLogger } from '../logger.js';

const log = createLogger('gmgn-discovery');
const BASE = 'https://openapi.gmgn.ai';

function authQuery() {
  return { timestamp: Math.floor(Date.now() / 1000), client_id: crypto.randomUUID() };
}

function headers(apiKey) {
  return { 'X-APIKEY': apiKey, 'Content-Type': 'application/json' };
}

const SOLANA_TRENCHES_BODY_BASE = {
  filters: ['offchain', 'onchain'],
  launchpad_platform_v2: true,
  quote_address_type: [4, 5, 3, 1, 13, 0],
};

/**
 * Build server-side filter params sent to the GMGN API.
 *
 * IMPORTANT: Only RISK/QUALITY filters are sent server-side.
 * Market-data filters (volume, liquidity, mcap, holders, swaps, age, fee)
 * are applied CLIENT-SIDE only via filters.js. Sending them server-side
 * kills all new_creation tokens because fresh tokens haven't built those
 * metrics yet — GMGN returns an empty list instead of tokens with low metrics.
 */
function buildServerFilters(filters) {
  // Only risk/quality filters — these are intrinsic token properties that are
  // safe to filter server-side without killing new tokens.
  const map = {
    maxRugRatio: 'max_rug_ratio',
    maxBundlerRate: 'max_bundler_rate',
    maxInsiderRate: 'max_insider_ratio',
    maxTop10HolderRate: 'max_top_holder_rate',
    maxDevHoldRate: 'max_creator_balance_rate',
    maxBotDegenRate: 'max_bot_degen_rate',
    maxFreshWalletRate: 'max_fresh_wallet_rate',
    minSmartDegenCount: 'min_smart_degen_count',
  };
  const server = {};
  for (const [configKey, apiKey] of Object.entries(map)) {
    const val = filters[configKey];
    if (val != null) server[apiKey] = val;
  }
  // maxTop10HolderRate/maxDevHoldRate are percentages (0-100) in config —
  // GMGN API expects a fraction (0-1), so convert back here. raw.dev_team_hold_rate
  // is *100-scaled the same way as raw.top_10_holder_rate (gmgn-discovery.js:110-115),
  // confirming the API expects a fraction for both.
  if (server.max_top_holder_rate != null) {
    server.max_top_holder_rate = server.max_top_holder_rate / 100;
  }
  if (server.max_creator_balance_rate != null) {
    server.max_creator_balance_rate = server.max_creator_balance_rate / 100;
  }
  // Progress is 0-100 in config — GMGN API expects 0-1 fraction
  if (filters.minProgress != null) server.min_progress = filters.minProgress / 100;
  if (filters.maxProgress != null) server.max_progress = filters.maxProgress / 100;
  return server;
}

function buildTrenchesBody(section, filters, launchpads, limit) {
  const serverFilters = buildServerFilters(filters);
  const sectionBody = {
    ...SOLANA_TRENCHES_BODY_BASE,
    limit: limit ?? 80,
    ...serverFilters,
  };
  if (launchpads && launchpads.length > 0) {
    sectionBody.launchpad_platform = launchpads;
  }
  const body = { version: 'v2' };
  body[section] = sectionBody;
  return body;
}

function normalizeGmgnToken(raw, section) {
  const nowMs = Date.now();
  return {
    chain: 'solana',
    chainId: 'solana',
    address: raw.address,
    symbol: raw.symbol,
    name: raw.name,
    pairAddress: raw.pool_address || null,
    dexId: raw.exchange === 'pump_amm' ? 'raydium' : 'pump',
    labels: [],
    priceUsd: null,
    priceNative: null,
    volume24h: raw.volume_24h ?? 0,
    liquidityUsd: raw.liquidity ?? 0,
    marketCap: raw.usd_market_cap ?? raw.market_cap ?? 0,
    ageMinutes: raw.created_timestamp ? (nowMs / 1000 - raw.created_timestamp) / 60 : null,
    buys24h: raw.buys_24h ?? 0,
    sells24h: raw.sells_24h ?? 0,
    traders24h: raw.swaps_24h ?? 0,
    buySellRatio: (raw.sells_24h ?? 0) > 0 ? (raw.buys_24h ?? 0) / raw.sells_24h : (raw.buys_24h ?? 0) > 0 ? 99 : 0,
    priceChange: { m5: null, h1: null, h6: null, h24: null },
    socials: [raw.twitter, raw.telegram, raw.website].filter(Boolean).length,
    boosts: 0,
    url: `https://gmgn.ai/sol/token/${raw.address}`,
    logo: raw.logo || null,
    holders: raw.holder_count ?? null,
    security: {
      honeypot: raw.is_honeypot === 'yes' || raw.is_honeypot === '1',
      washTrading: !!raw.is_wash_trading,
      openSource: raw.open_source === 'yes',
      ownerRenounced: raw.owner_renounced === 'yes',
      mintable: false,
      top10Pct: raw.top_10_holder_rate != null ? raw.top_10_holder_rate * 100 : null,
    },
    bondingProgress: raw.progress != null ? raw.progress * 100 : 0,
    totalFee: raw.total_fee ?? 0,
    botDegenCount: raw.bot_degen_count ?? 0,
    botDegenRate: raw.bot_degen_rate ?? 0,
    devHoldRate: raw.dev_team_hold_rate != null ? raw.dev_team_hold_rate * 100 : 0,
    top10HolderRate: raw.top_10_holder_rate != null ? raw.top_10_holder_rate * 100 : 0,
    smartDegenCount: raw.smart_degen_count ?? 0,
    sniperCount: raw.sniper_count ?? 0,
    renownedCount: raw.renowned_count ?? 0,
    bundlerRate: raw.bundler_mhr ?? 0,
    freshWalletRate: raw.fresh_wallet_rate ?? 0,
    insiderRate: raw.suspected_insider_hold_rate ?? 0,
    ratTraderRate: raw.rat_trader_amount_rate ?? 0,
    entrapmentRatio: raw.entrapment_ratio ?? 0,
    rugRatio: raw.rug_ratio ?? 0,
    launchpad: raw.launchpad_platform || null,
    section: section,
  };
}

async function fetchTrenches(apiKey, section, filters, launchpads, limit) {
  const body = buildTrenchesBody(section, filters, launchpads, limit);
  const q = new URLSearchParams({ chain: 'sol', ...authQuery() });
  const url = `${BASE}/v1/trenches?${q}`;
  const res = await fetchJson(url, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify(body),
  }, { timeoutMs: 20000, retries: 1 });
  if (res.code !== 0) {
    throw new Error(`GMGN API error [${section}]: code=${res.code} message=${res.message || res.error || 'unknown'}`);
  }
  const tokens = res.data?.[section];
  if (!Array.isArray(tokens)) {
    log.warn(`GMGN ${section}: no tokens array in response (data keys: ${Object.keys(res.data || {}).join(', ') || 'none'}), treating as empty`);
    return [];
  }
  return tokens;
}

export async function discoverFromGmgn({ section, filters, launchpads, apiKeys, limit }) {
  if (!apiKeys || apiKeys.length === 0) {
    return { candidates: [], source: 'gmgn', error: 'no API keys configured' };
  }

  let lastError = null;
  for (let i = 0; i < apiKeys.length; i++) {
    const key = apiKeys[i];
    try {
      log.info(`GMGN key ${i + 1}/${apiKeys.length}: fetching ${section}...`);
      const rawTokens = await fetchTrenches(key, section, filters, launchpads, limit);
      const candidates = rawTokens.map((t) => normalizeGmgnToken(t, section));
      log.info(`GMGN key ${i + 1}: ${candidates.length} ${section} candidates returned`);
      return { candidates, source: 'gmgn', error: null };
    } catch (e) {
      lastError = e;
      log.warn(`GMGN key ${i + 1} failed: ${e.message}`);
    }
  }

  log.warn(`All ${apiKeys.length} GMGN keys failed, last error: ${lastError?.message}`);
  return { candidates: [], source: 'gmgn', error: lastError?.message || 'all keys failed' };
}
