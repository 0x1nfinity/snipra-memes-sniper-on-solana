# GMGN-Powered Token Discovery & Filter Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace DexScreener-only discovery with GMGN OpenAPI as primary source (sequential multi-key fallback → DexScreener ultimate fallback), redesign all filters to GMGN data model, support single-section mode (New / Almost Bonded / Migrated), server-side filtering.

**Architecture:** New `gmgn-discovery.js` module wraps POST `/v1/trenches` with sequential API key fallback. `screener.js` gains dual-source flow: GMGN primary → normalize → price enrich (GMGN token/info → DexScreener) → score → rank; DexScreener fallback when all keys fail. `filters.js` redesigned for GMGN fields with DexScreener subset fallback. Config gets `section`, `gmgnApiKeys`, `launchpads`, redesigned filter fields. Entry guard removed entirely.

**Tech Stack:** Node.js ESM, existing dependencies only (no new npm packages). GMGN OpenAPI (existing X-APIKEY auth). DexScreener + GoPlus (existing, fallback path).

## Global Constraints

- Node.js ESM modules (`import`/`export`, `"type":"module"` in package.json)
- No new npm dependencies
- Follow existing code patterns (logger, config deepMerge, mapLimit, etc.)
- All config paths support `/set` via Telegram + hot-reload via fs.watchFile
- Skills mode (non-interactive) works without code changes beyond data source
- Sequential API key fallback: Key1 → Key2 → Key3 → DexScreener (not parallel)
- `null` filter values = not applied (omit from GMGN request body)
- Entry guard fully removed (all code, config, DB table optional)
- Single active section at a time

---

### Task 1: Redesign config.js DEFAULTS

**Files:**
- Modify: `src/config.js:58-105`

**Interfaces:**
- Consumes: nothing new
- Produces: Updated `DEFAULTS.screener` object with `source`, `gmgnApiKeys`, `section`, redesigned `filters` (no more entryGuard, minBuySellRatio, maxPriceDropH1Pct, minVolLiqRatio, requireSocials, strictSecurity)

- [ ] **Step 1: Replace `DEFAULTS.screener` object**

Replace lines 67-105 (the `screener:` block) in `src/config.js` with:

```js
  screener: {
    maxCandidatesPerCycle: 3,
    source: 'gmgn',                     // 'gmgn' | 'dexscreener'
    gmgnApiKeys: [],                    // [key1, key2, key3] — sequential fallback
    section: 'new_creation',            // 'new_creation' | 'near_completion' | 'completed'
    filters: {
      launchpads: ['Pump.fun'],         // [] or null = all launchpads
      minVolume24h: 50000,
      maxVolume24h: null,
      minLiquidity: 20000,
      maxLiquidity: null,
      minMarketCap: 100000,
      maxMarketCap: 20000000,
      minHolders: 200,
      maxHolders: null,
      minSwaps24h: 300,
      maxSwaps24h: null,
      minAgeMinutes: 30,
      maxAgeMinutes: 10080,             // 7 days
      minProgress: 0,
      maxProgress: 1,
      maxRugRatio: 0.3,
      maxBundlerRate: 0.3,
      maxInsiderRate: 0.3,
      minTotalFee: null,
      maxTotalFee: null,
      maxBotDegenRate: null,
      maxTop10HolderRate: 0.85,
      maxDevHoldRate: null,
      minSmartDegenCount: null,
      maxFreshWalletRate: null,
      blockHoneypot: true,
      blockWashTrading: true,
    },
    preScoreEnabled: true,
  },
```

- [ ] **Step 2: Remove entryGuard section from DEFAULTS**

Delete lines 89-101 (the `entryGuard:` block and the comment above it).

- [ ] **Step 3: Remove old filter fields that are also in trading/trailing**

In `DEFAULTS.trading`, verify `stopLossPct` is at line 116 (keep it). It stays.

- [ ] **Step 4: Remove entryGuard import and usage from screener**

Skip this — done in Task 4.

- [ ] **Step 5: Run to verify config loads without error**

```bash
cd /home/ijal/Documents/tools/new-tools/crypto/solana-project/snipra
node -e "import('./src/config.js').then(m => { m.loadConfig(); const c = m.getConfig(); console.log('section:', c.screener.section); console.log('source:', c.screener.source); console.log('filters keys:', Object.keys(c.screener.filters).join(', ')); console.log('entryGuard:', c.screener.entryGuard); })"
```
Expected: `section: new_creation`, `source: gmgn`, `filters keys:` lists all new fields, `entryGuard: undefined`

- [ ] **Step 6: Commit**

```bash
git add src/config.js
git commit -m "feat: redesign config DEFAULTS for GMGN discovery — new filter fields, remove entryGuard"
```

---

### Task 2: Create src/screener/gmgn-discovery.js

**Files:**
- Create: `src/screener/gmgn-discovery.js`

**Interfaces:**
- Produces:
  - `async function discoverFromGmgn({ section, filters, launchpads, apiKeys, limit })` → `{ candidates: object[], source: 'gmgn', error: null }` on success, `{ candidates: [], source: 'gmgn', error: string }` on total failure
  - `async function enrichPriceGmgn(candidate)` → mutates candidate with `priceUsd`, `priceChange` from GMGN `GET /v1/token/info`
  - `function normalizeGmgnToken(raw, section)` → internal candidate object

- [ ] **Step 1: Create the file**

```bash
touch src/screener/gmgn-discovery.js
```

- [ ] **Step 2: Write the module**

```js
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

function buildServerFilters(filters) {
  const map = {
    minVolume24h: 'min_volume_24h',
    maxVolume24h: 'max_volume_24h',
    minLiquidity: 'min_liquidity',
    maxLiquidity: 'max_liquidity',
    minMarketCap: 'min_marketcap',
    maxMarketCap: 'max_marketcap',
    minHolders: 'min_holder_count',
    maxHolders: 'max_holder_count',
    minSwaps24h: 'min_swaps_24h',
    maxSwaps24h: 'max_swaps_24h',
    maxRugRatio: 'max_rug_ratio',
    maxBundlerRate: 'max_bundler_rate',
    maxInsiderRate: 'max_insider_ratio',
    minTotalFee: 'min_total_fee',
    maxTotalFee: 'max_total_fee',
    maxBotDegenRate: 'max_bot_degen_rate',
    maxTop10HolderRate: 'max_top_holder_rate',
    maxDevHoldRate: 'max_creator_balance_rate',
    minSmartDegenCount: 'min_smart_degen_count',
    maxFreshWalletRate: 'max_fresh_wallet_rate',
  };
  const server = {};
  for (const [configKey, apiKey] of Object.entries(map)) {
    const val = filters[configKey];
    if (val != null) server[apiKey] = val;
  }
  if (filters.minAgeMinutes != null) {
    server.min_created = `${Math.round(filters.minAgeMinutes)}m`;
  }
  if (filters.maxAgeMinutes != null) {
    server.max_created = `${Math.round(filters.maxAgeMinutes)}m`;
  }
  if (filters.minProgress != null) server.min_progress = filters.minProgress;
  if (filters.maxProgress != null) server.max_progress = filters.maxProgress;
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
    priceUsd: 0,
    priceNative: 0,
    volume24h: raw.volume_24h ?? 0,
    liquidityUsd: raw.liquidity ?? 0,
    marketCap: raw.usd_market_cap ?? raw.market_cap ?? 0,
    ageMinutes: raw.created_timestamp ? (nowMs / 1000 - raw.created_timestamp) / 60 : null,
    buys24h: raw.buys_24h ?? 0,
    sells24h: raw.sells_24h ?? 0,
    traders24h: raw.swaps_24h ?? 0,
    buySellRatio: (raw.sells_24h ?? 0) > 0 ? (raw.buys_24h ?? 0) / raw.sells_24h : (raw.buys_24h ?? 0) > 0 ? 99 : 0,
    priceChange: { m5: 0, h1: 0, h6: 0, h24: 0 },
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
    bondingProgress: raw.progress ?? 0,
    totalFee: raw.total_fee ?? 0,
    botDegenCount: raw.bot_degen_count ?? 0,
    botDegenRate: raw.bot_degen_rate ?? 0,
    devHoldRate: raw.dev_team_hold_rate ?? 0,
    top10HolderRate: raw.top_10_holder_rate ?? 0,
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
    throw new Error(`GMGN API error: code=${res.code} message=${res.message || res.error || 'unknown'}`);
  }
  const tokens = res.data?.[section];
  if (!Array.isArray(tokens)) {
    throw new Error(`GMGN returned no ${section} array in response`);
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
```

Note: `enrichPriceGmgn` is handled in Task 4 (inline in screener.js) since it needs fallback to DexScreener.

- [ ] **Step 3: Verify import works**

```bash
cd /home/ijal/Documents/tools/new-tools/crypto/solana-project/snipra
node -e "import('./src/screener/gmgn-discovery.js').then(m => console.log('exports:', Object.keys(m).join(', ')))"
```
Expected: `exports: discoverFromGmgn`

- [ ] **Step 4: Commit**

```bash
git add src/screener/gmgn-discovery.js
git commit -m "feat: add GMGN discovery module — POST /v1/trenches with sequential multi-key fallback"
```

---

### Task 3: Redesign src/screener/filters.js

**Files:**
- Modify: `src/screener/filters.js`

**Interfaces:**
- Consumes: `normalizeGmgnToken` output (Task 2), `normalizePair` output (existing dexscreener.js)
- Produces: `evaluate(candidate, filters)` → `{ pass, reasons }`, `score(candidate)` → number

- [ ] **Step 1: Replace entire file content**

Replace all content of `src/screener/filters.js` with:

```js
/**
 * Evaluasi kandidat terhadap filter.
 * Field filter null = tidak dicek (dilewati).
 * Return { pass: boolean, reasons: string[] }.
 */
export function evaluate(c, f) {
  const reasons = [];
  const fail = (r) => reasons.push(r);

  // Volume 24h
  if (f.minVolume24h != null && (c.volume24h ?? 0) < f.minVolume24h)
    fail(`vol24h ${Math.round(c.volume24h)} < ${f.minVolume24h}`);
  if (f.maxVolume24h != null && (c.volume24h ?? 0) > f.maxVolume24h)
    fail(`vol24h ${Math.round(c.volume24h)} > ${f.maxVolume24h}`);

  // Liquidity
  if (f.minLiquidity != null && (c.liquidityUsd ?? 0) < f.minLiquidity)
    fail(`liq ${Math.round(c.liquidityUsd)} < ${f.minLiquidity}`);
  if (f.maxLiquidity != null && (c.liquidityUsd ?? 0) > f.maxLiquidity)
    fail(`liq ${Math.round(c.liquidityUsd)} > ${f.maxLiquidity}`);

  // Market cap
  if (f.minMarketCap != null && (c.marketCap ?? 0) < f.minMarketCap)
    fail(`mc ${Math.round(c.marketCap)} < ${f.minMarketCap}`);
  if (f.maxMarketCap != null && (c.marketCap ?? 0) > f.maxMarketCap)
    fail(`mc ${Math.round(c.marketCap)} > ${f.maxMarketCap}`);

  // Age
  if (c.ageMinutes == null) {
    if (f.minAgeMinutes != null || f.maxAgeMinutes != null)
      fail('age unknown');
  } else {
    if (f.minAgeMinutes != null && c.ageMinutes < f.minAgeMinutes)
      fail(`age ${c.ageMinutes.toFixed(0)}m < ${f.minAgeMinutes}m`);
    if (f.maxAgeMinutes != null && c.ageMinutes > f.maxAgeMinutes)
      fail(`age ${(c.ageMinutes / 60).toFixed(1)}h > ${f.maxAgeMinutes / 60}h`);
  }

  // Holders
  if (c.holders == null) {
    if (f.minHolders != null || f.maxHolders != null)
      fail('holders unknown');
  } else {
    if (f.minHolders != null && c.holders < f.minHolders)
      fail(`holders ${c.holders} < ${f.minHolders}`);
    if (f.maxHolders != null && c.holders > f.maxHolders)
      fail(`holders ${c.holders} > ${f.maxHolders}`);
  }

  // Swaps 24h
  if (f.minSwaps24h != null && (c.traders24h ?? 0) < f.minSwaps24h)
    fail(`swaps24h ${c.traders24h} < ${f.minSwaps24h}`);
  if (f.maxSwaps24h != null && (c.traders24h ?? 0) > f.maxSwaps24h)
    fail(`swaps24h ${c.traders24h} > ${f.maxSwaps24h}`);

  // Bonding progress
  if (f.minProgress != null && (c.bondingProgress ?? 0) < f.minProgress)
    fail(`progress ${(c.bondingProgress ?? 0).toFixed(3)} < ${f.minProgress}`);
  if (f.maxProgress != null && (c.bondingProgress ?? 0) > f.maxProgress)
    fail(`progress ${(c.bondingProgress ?? 0).toFixed(3)} > ${f.maxProgress}`);

  // GMGN-specific risk filters (only apply when data is present)
  if (f.maxRugRatio != null && c.rugRatio != null && c.rugRatio > f.maxRugRatio)
    fail(`rugRatio ${c.rugRatio.toFixed(2)} > ${f.maxRugRatio}`);
  if (f.maxBundlerRate != null && c.bundlerRate != null && c.bundlerRate > f.maxBundlerRate)
    fail(`bundlerRate ${c.bundlerRate.toFixed(2)} > ${f.maxBundlerRate}`);
  if (f.maxInsiderRate != null && c.insiderRate != null && c.insiderRate > f.maxInsiderRate)
    fail(`insiderRate ${c.insiderRate.toFixed(2)} > ${f.maxInsiderRate}`);
  if (f.maxTop10HolderRate != null && c.top10HolderRate != null && c.top10HolderRate > f.maxTop10HolderRate)
    fail(`top10 ${(c.top10HolderRate * 100).toFixed(0)}% > ${f.maxTop10HolderRate * 100}%`);
  if (f.maxDevHoldRate != null && c.devHoldRate != null && c.devHoldRate > f.maxDevHoldRate)
    fail(`devHold ${(c.devHoldRate * 100).toFixed(1)}% > ${f.maxDevHoldRate * 100}%`);
  if (f.maxBotDegenRate != null && c.botDegenRate != null && c.botDegenRate > f.maxBotDegenRate)
    fail(`botDegenRate ${c.botDegenRate.toFixed(2)} > ${f.maxBotDegenRate}`);
  if (f.maxFreshWalletRate != null && c.freshWalletRate != null && c.freshWalletRate > f.maxFreshWalletRate)
    fail(`freshWallet ${c.freshWalletRate.toFixed(2)} > ${f.maxFreshWalletRate}`);

  // Smart degen count
  if (f.minSmartDegenCount != null && c.smartDegenCount != null && c.smartDegenCount < f.minSmartDegenCount)
    fail(`smartDegen ${c.smartDegenCount} < ${f.minSmartDegenCount}`);

  // Total fee
  if (f.minTotalFee != null && c.totalFee != null && c.totalFee < f.minTotalFee)
    fail(`totalFee ${c.totalFee.toFixed(4)} < ${f.minTotalFee}`);
  if (f.maxTotalFee != null && c.totalFee != null && c.totalFee > f.maxTotalFee)
    fail(`totalFee ${c.totalFee.toFixed(4)} > ${f.maxTotalFee}`);

  // Security
  if (f.blockHoneypot && c.security?.honeypot)
    fail('honeypot/freezable');
  if (f.blockWashTrading && c.security?.washTrading)
    fail('wash trading');

  return { pass: reasons.length === 0, reasons };
}

/**
 * Skor kandidat untuk ranking (semakin tinggi semakin menarik).
 */
export function score(c) {
  let s = 0;
  s += Math.min((c.volume24h || 0) / Math.max(c.liquidityUsd || 1, 1), 10);
  s += Math.min((c.buySellRatio || 0), 3);
  s += Math.min((c.holders || 0) / 1000, 3);
  s += Math.min((c.smartDegenCount || 0), 5);
  s += Math.min((c.renownedCount || 0), 3);
  s -= Math.min((c.rugRatio || 0) * 10, 10);
  s -= Math.min((c.bundlerRate || 0) * 5, 5);
  s -= Math.min((c.insiderRate || 0) * 5, 5);
  s += Math.min((c.botDegenCount || 0) / 10, 3);
  s += (c.totalFee || 0) > 0 ? 2 : 0;
  s += (c.socials || 0) > 0 ? 1 : 0;
  s += (c.bondingProgress || 0) > 0.8 ? 2 : 0;
  s += (c.priceChange?.h1 || 0) > 0 ? 1 : 0;
  s += (c.priceChange?.h24 || 0) > 0 ? 1 : 0;
  return s;
}
```

- [ ] **Step 2: Verify import works**

```bash
cd /home/ijal/Documents/tools/new-tools/crypto/solana-project/snipra
node -e "import('./src/screener/filters.js').then(m => console.log('exports:', Object.keys(m).join(', ')))"
```
Expected: `exports: evaluate, score`

- [ ] **Step 3: Commit**

```bash
git add src/screener/filters.js
git commit -m "feat: redesign filters for GMGN data model — server-side field mapping, GMGN risk metrics"
```

---

### Task 4: Rewrite src/screener/screener.js

**Files:**
- Modify: `src/screener/screener.js`

**Interfaces:**
- Consumes: `discoverFromGmgn` (Task 2), `evaluate`/`score` (Task 3), `discover` from dexscreener.js (existing), `tokenSecurity` from goplus.js (existing), `athObserve`/`checkDecisionCache`/`storeDecisionCache`/`pruneExpiredDecisionCache` from db.js (existing)
- Produces: `runScreening({ darwin, llm, availSlots })` → `{ candidates, genomeId, scanned }`, `resolveExitGenome(cfg, genes)` (unchanged)

- [ ] **Step 1: Replace imports and mergeGenome**

Replace lines 1-29 (imports, MIN_FIELDS, MAX_FIELDS, mergeGenome) with:

```js
import { getConfig } from '../config.js';
import { discover } from './dexscreener.js';
import { tokenSecurity } from './goplus.js';
import { evaluate, score } from './filters.js';
import { preScore, PRE_SCORE_THRESHOLD } from './preScorer.js';
import { athObserve, checkDecisionCache, storeDecisionCache, pruneExpiredDecisionCache } from '../db.js';
import { mapLimit, fetchJson } from '../utils.js';
import { createLogger } from '../logger.js';
import { discoverFromGmgn } from './gmgn-discovery.js';
import { normalizePair, bestPair, tokenPairs } from './dexscreener.js';

const log = createLogger('screener');

const MIN_FIELDS = [
  'minVolume24h', 'minLiquidity', 'minMarketCap', 'minHolders',
  'minSwaps24h', 'minAgeMinutes', 'minProgress', 'minTotalFee',
  'minSmartDegenCount',
];
const MAX_FIELDS = [
  'maxVolume24h', 'maxLiquidity', 'maxMarketCap', 'maxHolders',
  'maxSwaps24h', 'maxAgeMinutes', 'maxProgress', 'maxRugRatio',
  'maxBundlerRate', 'maxInsiderRate', 'maxTotalFee',
  'maxBotDegenRate', 'maxTop10HolderRate', 'maxDevHoldRate',
  'maxFreshWalletRate',
];

function mergeGenome(baseFilters, genes) {
  const merged = { ...baseFilters };
  for (const f of MIN_FIELDS) {
    if (genes[f] != null) merged[f] = Math.max(baseFilters[f] ?? -Infinity, genes[f]);
  }
  for (const f of MAX_FIELDS) {
    if (genes[f] != null) merged[f] = Math.min(baseFilters[f] ?? Infinity, genes[f]);
  }
  return merged;
}
```

- [ ] **Step 2: Keep resolveExitGenome unchanged**

Lines 37-47 stay as-is.

- [ ] **Step 3: Remove entryGuardCheck and priceAgo functions**

Delete lines 49-93 (priceAgo, entryGuardCheck, and their comments).

- [ ] **Step 4: Add price enrichment function**

Add after resolveExitGenome:

```js
/**
 * Enrich harga dari GMGN token/info, fallback ke DexScreener tokenPairs.
 * Mutasi candidate langsung.
 */
async function enrichPrice(candidate) {
  // GMGN token/info
  try {
    const ts = Math.floor(Date.now() / 1000);
    const q = new URLSearchParams({ chain: 'sol', address: candidate.address, timestamp: ts, client_id: 'snipra' });
    const info = await fetchJson(`https://openapi.gmgn.ai/v1/token/info?${q}`, {
      headers: { 'X-APIKEY': getConfig().screener.gmgnApiKeys?.[0] || '', 'Content-Type': 'application/json' },
    }, { timeoutMs: 10000, retries: 0 });
    if (info?.data?.price != null) {
      candidate.priceUsd = Number(info.data.price) || 0;
      candidate.priceChange = {
        m5: info.data.price_change_5m ?? 0,
        h1: info.data.price_change_1h ?? 0,
        h6: info.data.price_change_6h ?? 0,
        h24: info.data.price_change_24h ?? 0,
      };
      return;
    }
  } catch (e) {
    log.debug(`GMGN token/info failed for ${candidate.symbol}: ${e.message}`);
  }

  // Fallback DexScreener
  try {
    const pairs = await tokenPairs('solana', candidate.address);
    const best = bestPair(pairs);
    if (best) {
      const norm = normalizePair(best, 'solana');
      if (norm) {
        candidate.priceUsd = norm.priceUsd;
        candidate.priceChange = norm.priceChange;
      }
    }
  } catch (e) {
    log.debug(`DexScreener price fallback failed for ${candidate.symbol}: ${e.message}`);
  }
}
```

- [ ] **Step 5: Rewrite runScreening function**

Replace lines 101-266 (runScreening) with:

```js
export async function runScreening({ darwin, llm, availSlots } = {}) {
  const cfg = getConfig();

  let filters = { ...cfg.screener.filters };
  let genomeId = null;
  let exitGenes = null;
  if (cfg.darwin.enabled && darwin) {
    const g = darwin.pickGenome();
    filters = mergeGenome(cfg.screener.filters, g.genes);
    genomeId = g.id;
    exitGenes = resolveExitGenome(cfg, g.genes);
  }

  const apiKeys = cfg.screener.gmgnApiKeys || [];
  const section = cfg.screener.section || 'new_creation';
  const launchpads = cfg.screener.filters.launchpads;
  const limit = cfg.screener.maxCandidatesPerCycle * 3;

  let candidates = [];

  // === Primary: GMGN ===
  if (cfg.screener.source === 'gmgn' && apiKeys.length > 0) {
    const result = await discoverFromGmgn({
      section,
      filters,
      launchpads,
      apiKeys,
      limit,
    });

    if (result.candidates.length > 0) {
      candidates = result.candidates;
      log.info(`GMGN ${section}: ${candidates.length} candidates received (server-side filtered)`);

      // Enrich harga: GMGN token/info → DexScreener fallback
      const maxEnrich = availSlots != null
        ? Math.max(availSlots, cfg.screener.maxCandidatesPerCycle)
        : cfg.screener.maxCandidatesPerCycle * 3;
      const toEnrich = candidates.slice(0, maxEnrich);
      await mapLimit(toEnrich, 3, enrichPrice);
    } else {
      log.warn(`GMGN returned no candidates (error: ${result.error || 'none'}), falling back to DexScreener`);
    }
  }

  // === Fallback: DexScreener ===
  if (candidates.length === 0 || cfg.screener.source === 'dexscreener') {
    const chainMap = { solana: 'solana' };

    let raw = [];
    try {
      raw = await discover(chainMap, { tokenProfiles: true, boostsLatest: true, boostsTop: true });
    } catch (e) {
      log.error('DexScreener discovery failed:', e.message);
      return { candidates: [], genomeId, scanned: 0 };
    }

    const cheap = raw.filter((c) => {
      return (
        (filters.minVolume24h == null || (c.volume24h ?? 0) >= filters.minVolume24h) &&
        (filters.minLiquidity == null || (c.liquidityUsd ?? 0) >= filters.minLiquidity) &&
        (filters.minMarketCap == null || (c.marketCap ?? 0) >= filters.minMarketCap) &&
        (filters.maxMarketCap == null || (c.marketCap ?? 0) <= filters.maxMarketCap) &&
        (filters.minAgeMinutes == null || (c.ageMinutes != null && c.ageMinutes >= filters.minAgeMinutes)) &&
        (filters.maxAgeMinutes == null || (c.ageMinutes != null && c.ageMinutes <= filters.maxAgeMinutes))
      );
    });
    log.info(`DexScreener scanned ${raw.length}, passed pre-filter ${cheap.length}`);

    const maxEnrich = availSlots != null
      ? Math.max(availSlots, cfg.screener.maxCandidatesPerCycle)
      : cfg.screener.maxCandidatesPerCycle * 3;
    const toEnrich = cheap.slice(0, maxEnrich);
    await mapLimit(toEnrich, 2, async (c) => {
      const sec = await tokenSecurity(cfg.chains[c.chain], c.address);
      if (sec) {
        c.security = sec;
        c.holders = sec.holders;
        c.top10Pct = sec.top10Pct;
      }
    });

    for (const c of cheap) {
      const res = evaluate(c, filters);
      if (res.pass) candidates.push(c);
      else log.debug(`${c.symbol} rejected: ${res.reasons.join(', ')}`);
    }
    log.info(`DexScreener fallback: ${candidates.length} candidates passed filter`);
  }

  // === Common post-filter pipeline ===

  // Decision cache
  if (cfg.llm.enabled && cfg.llm.decisionCacheEnabled) {
    pruneExpiredDecisionCache();
    candidates = candidates.filter((c) => {
      const cached = checkDecisionCache(c.chain, c.address, { mcap: c.marketCap, holders: c.holders });
      if (cached) {
        log.debug(`${c.symbol} skipped (decision cache: ${cached.reason || cached.verdict})`);
        return false;
      }
      return true;
    });
  }

  // Pre-scorer
  if (cfg.llm.enabled && cfg.screener.preScoreEnabled) {
    candidates = candidates.filter((c) => {
      const r = preScore(c);
      c.preScore = r.score;
      if (!r.passed) log.debug(`${c.symbol} rejected by pre-scorer: score ${r.score} < ${PRE_SCORE_THRESHOLD} (${r.reasons.join(', ')})`);
      return r.passed;
    });
  }

  // Ranking
  candidates.sort((a, b) => score(b) - score(a));
  candidates = candidates.slice(0, cfg.screener.maxCandidatesPerCycle);

  // LLM gate
  if (cfg.llm.enabled && cfg.llm.gateBuy && llm && candidates.length > 0) {
    const gated = [];
    const batchSize = Math.max(1, cfg.llm.batchSize || 1);
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      let verdicts;
      try {
        verdicts = await llm.assessBatch(batch);
      } catch (e) {
        if (cfg.llm.failOpen !== false) {
          log.warn(`LLM batch failed (${batch.length} candidates), passing without gate:`, e.message);
          gated.push(...batch);
        } else {
          log.warn(`LLM batch failed (${batch.length} candidates), rejected (failOpen=false):`, e.message);
        }
        continue;
      }
      batch.forEach((candidate, idx) => {
        const v = verdicts[idx];
        candidate.llmVerdict = v;
        if (v.action === 'buy' && v.confidence >= cfg.llm.minConfidence) {
          gated.push(candidate);
        } else {
          log.info(`LLM rejected ${candidate.symbol} (${v.action}, conf ${v.confidence}): ${v.reason}`);
          if (cfg.llm.decisionCacheEnabled) {
            try {
              storeDecisionCache(candidate.chain, candidate.address, 'skip', {
                confidence: v.confidence,
                reason: v.reason,
                mcap: candidate.marketCap,
                holders: candidate.holders,
                ttlMs: cfg.llm.decisionCacheSkipTtlMin * 60000,
              });
            } catch (cacheErr) {
              log.warn(`failed to store decision cache for ${candidate.symbol}:`, cacheErr.message);
            }
          }
        }
      });
    }
    candidates = gated;
  }

  for (const c of candidates) c.exitGenes = exitGenes;
  log.info(`final candidates: ${candidates.map((c) => c.symbol).join(', ') || '(none)'}`);
  return { candidates, genomeId, scanned: candidates.length };
}
```

- [ ] **Step 6: Remove entryGuard entry from DEFAULTS if still there**

Double-check `src/config.js` — the `entryGuard` section in DEFAULTS should already be removed from Task 1. If not, remove now.

- [ ] **Step 7: Verify module imports work**

```bash
cd /home/ijal/Documents/tools/new-tools/crypto/solana-project/snipra
node -e "import('./src/screener/screener.js').then(m => console.log('exports:', Object.keys(m).join(', ')))"
```
Expected: `exports: resolveExitGenome, runScreening`

- [ ] **Step 8: Commit**

```bash
git add src/screener/screener.js
git commit -m "feat: dual-source screening — GMGN primary with multi-key fallback, DexScreener fallback, remove entry guard"
```

---

### Task 5: Update Darwin GENE_SPACE and GENE_CONFIG_PATH

**Files:**
- Modify: `src/darwin/darwin.js:14-46`

**Interfaces:**
- Consumes: New config filter paths (Task 1)
- Produces: Updated `GENE_SPACE` and `GENE_CONFIG_PATH` for GMGN fields

- [ ] **Step 1: Replace GENE_SPACE and GENE_CONFIG_PATH**

Replace lines 14-46 in `src/darwin/darwin.js` with:

```js
export const GENE_SPACE = {
  minVolume24h: { min: 5000, max: 500000, sigma: 0.25 },
  minLiquidity: { min: 5000, max: 200000, sigma: 0.25 },
  minMarketCap: { min: 10000, max: 1000000, sigma: 0.3 },
  maxMarketCap: { min: 500000, max: 50000000, sigma: 0.3 },
  minHolders: { min: 50, max: 2000, sigma: 0.3 },
  minSwaps24h: { min: 50, max: 2000, sigma: 0.3 },
  minAgeMinutes: { min: 1, max: 720, sigma: 0.3 },
  maxAgeMinutes: { min: 720, max: 20160, sigma: 0.25 },
  minProgress: { min: 0, max: 0.9, sigma: 0.2 },
  maxProgress: { min: 0.1, max: 1, sigma: 0.2 },
  maxRugRatio: { min: 0.1, max: 0.9, sigma: 0.2 },
  maxBundlerRate: { min: 0.05, max: 0.8, sigma: 0.2 },
  maxInsiderRate: { min: 0.05, max: 0.8, sigma: 0.2 },
  maxTop10HolderRate: { min: 0.1, max: 0.95, sigma: 0.15 },
  maxBotDegenRate: { min: 0.05, max: 0.5, sigma: 0.2 },
  maxFreshWalletRate: { min: 0.1, max: 0.9, sigma: 0.2 },
  maxDevHoldRate: { min: 0.01, max: 0.5, sigma: 0.2 },
  maxTotalFee: { min: 0.1, max: 100, sigma: 0.3 },
  minSmartDegenCount: { min: 0, max: 10, sigma: 0.3 },
  minVolume24hUsd: null,
  minAgeHours: null,
  maxAgeHours: null,
  minLiquidityUsd: null,
  minMarketCapUsd: null,
  maxMarketCapUsd: null,
  minTraders24h: null,
  minBuySellRatio: null,
  minVolLiqRatio: null,
  stopLossPct: { min: -60, max: -15, sigma: 0.2 },
  trailingActivateGainPct: { min: 5, max: 40, sigma: 0.25 },
  trailingTrailPct: { min: 3, max: 15, sigma: 0.25 },
};

export const GENE_CONFIG_PATH = {
  minVolume24h: 'screener.filters.minVolume24h',
  minLiquidity: 'screener.filters.minLiquidity',
  minMarketCap: 'screener.filters.minMarketCap',
  maxMarketCap: 'screener.filters.maxMarketCap',
  minHolders: 'screener.filters.minHolders',
  minSwaps24h: 'screener.filters.minSwaps24h',
  minAgeMinutes: 'screener.filters.minAgeMinutes',
  maxAgeMinutes: 'screener.filters.maxAgeMinutes',
  minProgress: 'screener.filters.minProgress',
  maxProgress: 'screener.filters.maxProgress',
  maxRugRatio: 'screener.filters.maxRugRatio',
  maxBundlerRate: 'screener.filters.maxBundlerRate',
  maxInsiderRate: 'screener.filters.maxInsiderRate',
  maxTop10HolderRate: 'screener.filters.maxTop10HolderRate',
  maxBotDegenRate: 'screener.filters.maxBotDegenRate',
  maxFreshWalletRate: 'screener.filters.maxFreshWalletRate',
  maxDevHoldRate: 'screener.filters.maxDevHoldRate',
  maxTotalFee: 'screener.filters.maxTotalFee',
  minSmartDegenCount: 'screener.filters.minSmartDegenCount',
  stopLossPct: 'trading.stopLossPct',
  trailingActivateGainPct: 'trailing.activateGainPct',
  trailingTrailPct: 'trailing.trailPct',
};
```

Old fields (`minVolume24hUsd`, `minAgeHours`, `maxAgeHours`, `minLiquidityUsd`, `minMarketCapUsd`, `maxMarketCapUsd`, `minTraders24h`, `minBuySellRatio`, `minVolLiqRatio`) get `null` values in GENE_SPACE — they're no longer explorable. Their entries in GENE_CONFIG_PATH are removed since they no longer map to active config paths.

- [ ] **Step 2: Verify import works**

```bash
cd /home/ijal/Documents/tools/new-tools/crypto/solana-project/snipra
node -e "import('./src/darwin/darwin.js').then(m => console.log('GENE_SPACE keys:', Object.keys(m.GENE_SPACE).join(', ')))"
```
Expected: Lists all new GMGN field names in GENE_SPACE

- [ ] **Step 3: Regenerate darwin.json**

Since gene structure changed, delete old darwin.json so it reseeds:

```bash
rm -f /home/ijal/Documents/tools/new-tools/crypto/solana-project/snipra/data/darwin.json
```

- [ ] **Step 4: Commit**

```bash
git add src/darwin/darwin.js
git commit -m "feat: update Darwin GENE_SPACE for GMGN filter fields"
```

---

### Task 6: Update Telegram UI — fmt.js + bot.js + config commands

**Files:**
- Modify: `src/telegram/fmt.js:24-34`
- Modify: `src/telegram/bot.js:142-155`
- Modify: `src/telegram/commands/config.js:9-28`

**Interfaces:**
- Consumes: Updated candidate object (from Task 2/4)
- Produces: Updated token card display, section/launchpad selector in menu

- [ ] **Step 1: Update fmt.js — communityLine and add gmgnTokenLine**

Replace `communityLine` in `src/telegram/fmt.js` and add a new function:

```js
/** baris komunitas token: holders · age */
export function communityLine(c, { withDelta = false } = {}) {
  const age = c.ageMinutes != null ? `${(c.ageMinutes / 60).toFixed(1)}h` : '?';
  let line = `Holders ${c.holders ?? '?'} · Age ${age}`;
  if (withDelta) line += ` · 1h ${fmtPct(c.priceChange?.h1)} · 24h ${fmtPct(c.priceChange?.h24)}`;
  return line;
}

/** baris metrik GMGN: progress, smart money, KOL, rug risk */
export function gmgnLine(c) {
  const parts = [];
  if (c.bondingProgress != null) parts.push(`Progress ${(c.bondingProgress * 100).toFixed(0)}%`);
  if (c.smartDegenCount > 0) parts.push(`Smart ${c.smartDegenCount}`);
  if (c.renownedCount > 0) parts.push(`KOL ${c.renownedCount}`);
  if (c.botDegenCount > 0) parts.push(`Bots ${c.botDegenCount}`);
  if (c.rugRatio != null && c.rugRatio > 0.3) parts.push(`Rug ${(c.rugRatio * 100).toFixed(0)}%`);
  return parts.join(' · ') || null;
}
```

- [ ] **Step 2: Update bot.js — _tokenCard**

Replace `_tokenCard` in `src/telegram/bot.js` (lines 142-156):

```js
  _tokenCard(c) {
    const gmgn = gmgnLine(c);
    return (
      `${tokenLink(c.symbol, this._chainSlug(c.chain), c.address)} — ${c.name || ''}\n\n` +
      `💵 ${fmtUsd(c.priceUsd)} · ${marketLine(c)}\n` +
      `${communityLine(c, { withDelta: true })}\n` +
      `🔁 tx24 ${c.traders24h} · b/s ${c.buySellRatio?.toFixed(2)}` +
      (c.security?.top10Pct != null ? ` · top10 ${c.security.top10Pct.toFixed(0)}%` : '') + `\n` +
      (gmgn ? `${gmgn}\n` : '') +
      (c.launchpad ? `🚀 ${c.launchpad}\n` : '') +
      (c.security
        ? `🛡 ${c.security.honeypot ? '🚨 honeypot/freezable' : '✅ safe'}${c.security.washTrading ? ' · 🚨 wash trading' : ''}\n`
        : '') +
      `\`${c.address}\``
    );
  }
```

Add import at top of bot.js:

```js
import { marketLine, communityLine, gmgnLine } from './fmt.js';
```

- [ ] **Step 3: Update config.js commands — MENU_NUM**

Replace `MENU_NUM` in `src/telegram/commands/config.js` (lines 9-28):

```js
const MENU_NUM = {
  // main / trading
  si: { group: 'main', path: 'telegram.screeningcyclemin', step: 5, min: 5, max: 360, label: 'Scan', fmt: (v) => `${v}m` },
  bs: { group: 'main', path: 'trading.buyAmount', step: 0.05, min: 0.05, max: 50, label: 'Buy SOL', fmt: (v) => `${+v.toFixed(3)}` },
  sl: { group: 'main', path: 'trading.stopLossPct', step: 5, min: -90, max: -5, label: 'SL', fmt: (v) => `${v}%` },
  cd: { group: 'main', path: 'trading.cooldownMinutes', step: 30, min: 0, max: 1440, label: 'Cooldown', fmt: (v) => `${v}m` },
  cn: { group: 'main', path: 'trading.maxTradesBeforeCooldown', step: 1, min: 1, max: 20, label: 'Cooldown after', fmt: (v) => `${v}x` },
  ta: { group: 'main', path: 'trailing.activateGainPct', step: 5, min: 5, max: 500, label: 'Trail+', fmt: (v) => `${v}%` },
  tp: { group: 'main', path: 'trailing.trailPct', step: 1, min: 1, max: 50, label: 'Trail-', fmt: (v) => `${v}%` },
  // filter
  fvol: { group: 'filter', path: 'screener.filters.minVolume24h', step: 10000, min: 0, max: 5000000, label: 'Vol', fmt: (v) => `$${fmtK(v)}` },
  fliq: { group: 'filter', path: 'screener.filters.minLiquidity', step: 5000, min: 0, max: 2000000, label: 'Liq', fmt: (v) => `$${fmtK(v)}` },
  fmcn: { group: 'filter', path: 'screener.filters.minMarketCap', step: 10000, min: 0, max: 5000000, label: 'MC-', fmt: (v) => `$${fmtK(v)}` },
  fmcx: { group: 'filter', path: 'screener.filters.maxMarketCap', step: 1000000, min: 1000000, max: 100000000, label: 'MC+', fmt: (v) => `$${fmtK(v)}` },
  fagn: { group: 'filter', path: 'screener.filters.minAgeMinutes', step: 15, min: 0, max: 1440, label: 'Age-', fmt: (v) => `${v}m` },
  fagx: { group: 'filter', path: 'screener.filters.maxAgeMinutes', step: 720, min: 720, max: 43200, label: 'Age+', fmt: (v) => `${(v / 60).toFixed(0)}h` },
  fhld: { group: 'filter', path: 'screener.filters.minHolders', step: 50, min: 0, max: 10000, label: 'Hold', fmt: (v) => `${v}` },
  ftx:  { group: 'filter', path: 'screener.filters.minSwaps24h', step: 50, min: 0, max: 10000, label: 'Tx', fmt: (v) => `${v}` },
  frug: { group: 'filter', path: 'screener.filters.maxRugRatio', step: 0.1, min: 0, max: 1, label: 'Rug', fmt: (v) => `${(v * 100).toFixed(0)}%` },
  ft10: { group: 'filter', path: 'screener.filters.maxTop10HolderRate', step: 0.05, min: 0, max: 1, label: 'Top10', fmt: (v) => `${(v * 100).toFixed(0)}%` },
};
```

- [ ] **Step 4: Add /section command to menu and registry**

In `src/telegram/commands/config.js`, add a new export:

```js
export async function sectionCmd(args, msg, deps) {
  const valid = ['new_creation', 'near_completion', 'completed'];
  const val = args[0];
  if (!val || !valid.includes(val)) return deps.send(`Usage: /section ${valid.join('|')}`);
  const value = setPath('screener.section', val);
  return deps.send(`Section → ${value}`);
}
```

Register it in `src/telegram/commands/index.js` — the existing `buildRegistry` auto-discovers exports, so `sectionCmd` will automatically become `/sectioncmd`. We need to name it for a clean command. The convention in the codebase is `export async function foo(...)` → `/foo`. So name it:

```js
export async function sectionCmd(args, msg, deps) { ... }
```

This registers as `/sectioncmd`. Not ideal. Let's add a manual mapping. But actually, looking at the codebase pattern, commands are named by their export name with `/` prefix. Let's just use the `/set` approach for now.

Instead, add a `sectionCmd` function and register it manually in the COMMANDS array in `bot.js` for Telegram menu display. But since `buildRegistry` auto-discovers, let's just name the export function well and add it to COMMANDS.

Actually, the simpler approach: just add `/set screener.section new_creation` since it already works via `setPath`. No new command needed. Just update the menu buttons.

- [ ] **Step 5: Add section selector to menu keyboard**

In `menuKeyboard` function (config.js), add section selector buttons to the `filter` view between the header and filter rows:

```js
  if (view === 'filter') {
    const currentSection = getPath('screener.section');
    rows.push([
      { text: `${currentSection === 'new_creation' ? '🟢 ' : ''}New`, callback_data: 'm:section:new_creation' },
      { text: `${currentSection === 'near_completion' ? '🟢 ' : ''}Almost`, callback_data: 'm:section:near_completion' },
      { text: `${currentSection === 'completed' ? '🟢 ' : ''}Migrated`, callback_data: 'm:section:completed' },
    ]);
  }
```

Add handler for `m:section:` in `handleMenuCallback`:

```js
    case 'section':
      setPath('screener.section', arg);
      return editMenu('filter', `Section → ${arg}`);
```

- [ ] **Step 6: Verify import works**

```bash
cd /home/ijal/Documents/tools/new-tools/crypto/solana-project/snipra
node -e "import('./src/telegram/fmt.js').then(m => console.log('exports:', Object.keys(m).join(', ')))"
```
Expected: includes `gmgnLine`

- [ ] **Step 7: Commit**

```bash
git add src/telegram/fmt.js src/telegram/bot.js src/telegram/commands/config.js
git commit -m "feat: update Telegram UI — GMGN fields in token card, section selector, updated menu filters"
```

---

### Task 7: Update LLM Loops Context

**Files:**
- Modify: `src/llm/loops.js:29-38`

**Interfaces:**
- Consumes: Updated config filter fields
- Produces: Updated `createBotContext` with new filter names in LLM context string

- [ ] **Step 1: Update context string in createBotContext**

Replace line 35 in `src/llm/loops.js`:

```js
      `Main filters: ${JSON.stringify(cfg.screener.filters)}\n` +
```

With:

```js
      `Section: ${cfg.screener.section || 'new_creation'} · Source: ${cfg.screener.source || 'gmgn'}\n` +
      `Filters: ${JSON.stringify(cfg.screener.filters)}\n` +
```

- [ ] **Step 2: Commit**

```bash
git add src/llm/loops.js
git commit -m "feat: update LLM context with GMGN section and source info"
```

---

### Task 8: Update live-config.json Structure + Integration Test

**Files:**
- Modify: `live-config.json`

- [ ] **Step 1: Back up existing config**

```bash
cp /home/ijal/Documents/tools/new-tools/crypto/solana-project/snipra/live-config.json /home/ijal/Documents/tools/new-tools/crypto/solana-project/snipra/live-config.json.bak
```

- [ ] **Step 2: Write new live-config.json**

Replace `live-config.json` with the new structure matching DEFAULTS:

```json
{
  "screener": {
    "maxCandidatesPerCycle": 30,
    "source": "gmgn",
    "gmgnApiKeys": ["gmgn_dc7051b90aec7f99c4186e3ad0e338d9"],
    "section": "new_creation",
    "filters": {
      "launchpads": ["Pump.fun"],
      "minVolume24h": 50000,
      "minLiquidity": 20000,
      "minMarketCap": 30000,
      "maxMarketCap": 20000000,
      "minHolders": 200,
      "minSwaps24h": 300,
      "minAgeMinutes": 30,
      "maxAgeMinutes": 10080,
      "minProgress": 0,
      "maxProgress": 1,
      "maxRugRatio": 0.3,
      "maxBundlerRate": 0.3,
      "maxInsiderRate": 0.3,
      "maxTop10HolderRate": 0.55,
      "blockHoneypot": true,
      "blockWashTrading": true
    },
    "preScoreEnabled": true
  },
  "trading": {
    "buyAmount": 0.03,
    "slippageBps": 300,
    "maxPositions": 20,
    "minSwapUsd": 1,
    "cooldownMinutes": 240,
    "maxTradesBeforeCooldown": 5,
    "stopLossPct": -40,
    "slFlashDropPct": 40,
    "priceMinLiquidityUsd": 300,
    "priceAnomalySpikePct": 500
  },
  "tpLadder": [
    { "gainPct": 40, "sellPct": 30 },
    { "gainPct": 100, "sellPct": 40 },
    { "gainPct": 250, "sellPct": 50 }
  ],
  "trailing": {
    "enabled": true,
    "activateGainPct": 10,
    "trailPct": 5,
    "moonbagPct": 10
  },
  "monitor": {
    "intervalSec": 20,
    "stalePriceWarnSec": 600,
    "onchainReconcileSec": 60
  },
  "darwin": {
    "enabled": true,
    "populationSize": 8,
    "evolveEveryNTrades": 20,
    "mutationRate": 0.35,
    "exploreRate": 0.25,
    "minTradesForFitness": 3
  },
  "llm": {
    "enabled": false,
    "provider": "openrouter",
    "model": "deepseek/deepseek-chat-v3-0324",
    "gateBuy": true,
    "minConfidence": 0.35,
    "failOpen": true,
    "maxLessons": 12,
    "decisionCacheEnabled": true,
    "decisionCacheSkipTtlMin": 30,
    "batchSize": 5,
    "cheapModel": "",
    "tools": true
  },
  "telegram": {
    "notifyScreening": true,
    "notifyPriceMoves": false,
    "screeningcyclemin": 60,
    "managecyclemin": 30
  }
}
```

- [ ] **Step 3: Integration test — run screen-once**

```bash
cd /home/ijal/Documents/tools/new-tools/crypto/solana-project/snipra
node src/index.js --screen-once 2>&1
```

Expected:
- Log shows `GMGN key 1/1: fetching new_creation...`
- Log shows `GMGN key 1: X new_creation candidates returned`
- Price enrichment logs
- Final candidates printed with GMGN-specific fields
- No entry guard messages
- No crashes

If all GMGN keys fail, should see fallback to DexScreener.

- [ ] **Step 4: Test with different section**

```bash
cd /home/ijal/Documents/tools/new-tools/crypto/solana-project/snipra
node -e "
import('./src/config.js').then(m => {
  m.loadConfig();
  m.setPath('screener.section', 'near_completion');
  console.log('section:', m.getPath('screener.section'));
})
"
```

Then run `node src/index.js --screen-once` and verify it fetches near_completion tokens.

- [ ] **Step 5: Test with completed section**

```bash
node -e "import('./src/config.js').then(m => { m.loadConfig(); m.setPath('screener.section', 'completed'); })"
node src/index.js --screen-once 2>&1 | head -30
```

- [ ] **Step 6: Commit**

```bash
git add live-config.json
git rm -f live-config.json.bak 2>/dev/null || true
git commit -m "feat: update live-config.json for GMGN discovery — new filter structure, section selector"
```

---

### Task 9: Final Verification — Full E2E

- [ ] **Step 1: Run all three sections end-to-end**

```bash
cd /home/ijal/Documents/tools/new-tools/crypto/solana-project/snipra

# Test new_creation
node -e "import('./src/config.js').then(m => { m.loadConfig(); m.setPath('screener.section', 'new_creation'); })" && node src/index.js --screen-once 2>&1 | tail -20

# Test near_completion
node -e "import('./src/config.js').then(m => { m.loadConfig(); m.setPath('screener.section', 'near_completion'); })" && node src/index.js --screen-once 2>&1 | tail -20

# Test completed
node -e "import('./src/config.js').then(m => { m.loadConfig(); m.setPath('screener.section', 'completed'); })" && node src/index.js --screen-once 2>&1 | tail -20
```

- [ ] **Step 2: Verify no regressions — check module loads**

```bash
cd /home/ijal/Documents/tools/new-tools/crypto/solana-project/snipra
node -e "
Promise.all([
  import('./src/config.js'),
  import('./src/screener/screener.js'),
  import('./src/screener/filters.js'),
  import('./src/screener/gmgn-discovery.js'),
  import('./src/screener/dexscreener.js'),
  import('./src/screener/goplus.js'),
  import('./src/darwin/darwin.js'),
  import('./src/telegram/fmt.js'),
  import('./src/llm/loops.js'),
  import('./src/llm/tools.js'),
]).then(() => console.log('All modules load OK'))
"
```
Expected: `All modules load OK`

- [ ] **Step 3: Test DexScreener fallback manually**

Set source to dexscreener and verify it still works:

```bash
node -e "import('./src/config.js').then(m => { m.loadConfig(); m.setPath('screener.source', 'dexscreener'); })"
node src/index.js --screen-once 2>&1 | head -20
```
Expected: Falls through to DexScreener, old discovery works.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: finalize GMGN discovery integration — all sections verified, fallback tested"
```
