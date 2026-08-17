/**
 * Screening source: gmgn-cli market trending (subprocess).
 *
 * Hard filter mengikuti threshold Hermes (lihat src/gmgn/cli.js). Market-data
 * filters (vol, liq, mcap, holders, swaps, age) dikirim server-side via flag
 * GMGN — BUKAN body JSON seperti dulu. Server-side risk filter (rug, bundler,
 * top10, dev) juga flag GMGN.
 *
 * Caller (screener.js) tetap menjalankan client-side `evaluate()` untuk
 * fields yg TIDAK bisa difilter server-side (security flags dari GoPlus,
 * genome-tightened filters, dll) dan untuk ranking/score.
 */
import { fetchTrending as cliFetchTrending } from '../gmgn/cli.js';
import { createLogger } from '../logger.js';

const log = createLogger('gmgn-discovery');

/**
 * Map GMGN trending response (snake_case) → snipra candidate shape (camelCase).
 * Field yg tidak tersedia di endpoint (totalFee, openSource, progress, dll)
 * di-default null/0 — evaluate() skip-on-null untuk fields tersebut.
 */
function normalizeTrendingToken(raw) {
  const nowMs = Date.now();
  const priceUsd = Number(raw.price) || 0;
  const marketCap = Number(raw.market_cap) || 0;
  const liquidityUsd = Number(raw.liquidity) || 0;
  const volume24h = Number(raw.volume) || 0;
  const buys = Number(raw.buys) || 0;
  const sells = Number(raw.sells) || 0;
  const swaps = Number(raw.swaps) || 0;
  return {
    chain: 'solana',
    chainId: 'solana',
    address: raw.address,
    symbol: raw.symbol,
    name: raw.name,
    pairAddress: null,
    dexId: raw.exchange === 'pump_amm' ? 'raydium' : 'pump',
    labels: [],
    priceUsd,
    priceNative: null, // di-enrich via cli.fetchTokenInfo di screener.js
    volume24h,
    liquidityUsd,
    marketCap,
    ageMinutes: raw.creation_timestamp ? (nowMs / 1000 - raw.creation_timestamp) / 60 : null,
    buys24h: buys,
    sells24h: sells,
    traders24h: swaps,
    buySellRatio: sells > 0 ? buys / sells : buys > 0 ? 99 : 0,
    priceChange: {
      m5: raw.price_change_percent5m != null ? Number(raw.price_change_percent5m) : null,
      h1: raw.price_change_percent1h != null ? Number(raw.price_change_percent1h) : null,
      h6: null, // trending tdk kasih — diisi dari token info
      h24: null,
    },
    socials: [raw.twitter_username, raw.telegram, raw.website].filter(Boolean).length,
    boosts: 0,
    url: `https://gmgn.ai/sol/token/${raw.address}`,
    logo: raw.logo || null,
    holders: raw.holder_count != null ? Number(raw.holder_count) : null,
    security: {
      honeypot: !!raw.is_honeypot,
      washTrading: !!raw.is_wash_trading,
      openSource: false, // trending tidak kasih — default false (filter skip-on-null)
      ownerRenounced: !!raw.is_renounced,
      mintable: false,
      top10Pct: raw.top_10_holder_rate != null ? Number(raw.top_10_holder_rate) * 100 : null,
    },
    bondingProgress: 0, // trending tidak kasih — default 0
    totalFee: 0,
    botDegenCount: Number(raw.bot_degen_count) || 0,
    botDegenRate: Number(raw.bot_degen_rate) || 0,
    devHoldRate: raw.dev_team_hold_rate != null ? Number(raw.dev_team_hold_rate) * 100 : 0,
    top10HolderRate: raw.top_10_holder_rate != null ? Number(raw.top_10_holder_rate) * 100 : 0,
    smartDegenCount: Number(raw.smart_degen_count) || 0,
    sniperCount: Number(raw.sniper_count) || 0,
    renownedCount: Number(raw.renowned_count) || 0,
    bundlerRate: Number(raw.bundler_rate) || 0,
    freshWalletRate: Number(raw.fresh_wallet_rate) || 0,
    insiderRate: Number(raw.insider_rate) || 0,
    ratTraderRate: Number(raw.rat_trader_amount_rate) || 0,
    entrapmentRatio: Number(raw.entrapment_ratio) || 0,
    rugRatio: Number(raw.rug_ratio) || 0,
    launchpad: raw.launchpad_platform || null,
    section: 'trending',
    source: 'gmgn-cli-trending',
  };
}

/**
 * Wrapper publik: panggil gmgn-cli trending → array of normalized candidates.
 * @param {object} args { filters, launchpads, interval, limit }
 * @returns {Promise<{candidates: object[], source: string, error: string|null}>}
 */
export async function discoverFromGmgn({ filters, launchpads, interval = '1h', limit = 80 } = {}) {
  try {
    const rawTokens = await cliFetchTrending({ interval, filters, launchpads, limit });
    const candidates = rawTokens.map(normalizeTrendingToken);
    log.info(`gmgn-cli trending: ${candidates.length} candidates (interval=${interval}, platform=${(launchpads || []).join('|') || 'all'})`);
    return { candidates, source: 'gmgn-cli-trending', error: null };
  } catch (e) {
    log.warn(`gmgn-cli trending failed: ${e.message}`);
    return { candidates: [], source: 'gmgn-cli-trending', error: e.message };
  }
}