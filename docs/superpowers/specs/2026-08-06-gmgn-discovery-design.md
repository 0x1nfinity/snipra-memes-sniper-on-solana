# GMGN-Powered Token Discovery & Filter Redesign

**Date:** 2026-08-06
**Status:** Draft

## Overview

Replace the current DexScreener-only token discovery with a dual-source system: GMGN OpenAPI as primary source with sequential multi-key fallback, DexScreener as ultimate fallback. Redesign all filters to align with GMGN's data model, use server-side filtering for efficiency, and support single-section mode (New / Almost Bonded / Migrated) matching GMGN's web interface.

## 1. Data Source Architecture

### Primary: GMGN OpenAPI

**Endpoint:** `POST https://openapi.gmgn.ai/v1/trenches`

**Auth:** `X-APIKEY` header + `timestamp` + `client_id` query params (same auth as existing `wallet_activity`).

**Request body:**
```json
{
  "version": "v2",
  "<section>": {
    "filters": ["offchain", "onchain"],
    "launchpad_platform_v2": true,
    "launchpad_platform": ["Pump.fun"],
    "limit": 80,
    "quote_address_type": [4, 5, 3, 1, 13, 0],
    "min_volume_24h": 50000,
    "max_rug_ratio": 0.3,
    "min_holder_count": 200,
    "...": "..."
  }
}
```

Where `<section>` is one of: `new_creation`, `near_completion`, `completed`.

**Response:** `{ code: 0, data: { <section>: [token, ...] } }`

### Sequential Multi-Key Fallback

```
API Key 1 → fail? → API Key 2 → fail? → API Key 3 → fail? → DexScreener
```

Each key tried sequentially. On 401/429/network error, move to next key. Only when all keys exhausted, fallback to DexScreener.

### Fallback: DexScreener (Existing)

Current discovery flow preserved as-is: `token-profiles` + `boosts-latest` + `boosts-top` → `tokenPairs` → normalize → GoPlus enrichment.

## 2. Configuration Structure

### New `live-config.json` Screener Section

```json
{
  "screener": {
    "source": "gmgn",
    "gmgnApiKeys": [
      "gmgn_key_1",
      "gmgn_key_2",
      "gmgn_key_3"
    ],
    "section": "new_creation",
    "maxCandidatesPerCycle": 30,
    "filters": {
      "launchpads": ["Pump.fun"],
      "minVolume24h": 50000,
      "maxVolume24h": null,
      "minLiquidity": 20000,
      "maxLiquidity": null,
      "minMarketCap": 30000,
      "maxMarketCap": 20000000,
      "minHolders": 200,
      "maxHolders": null,
      "minSwaps24h": 300,
      "maxSwaps24h": null,
      "minAgeMinutes": 60,
      "maxAgeMinutes": 5760,
      "minProgress": 0,
      "maxProgress": 1,
      "maxRugRatio": 0.3,
      "maxBundlerRate": 0.3,
      "maxInsiderRate": 0.3,
      "minTotalFee": null,
      "maxTotalFee": null,
      "maxBotDegenRate": null,
      "maxTop10HolderRate": 0.55,
      "maxDevHoldRate": null,
      "minSmartDegenCount": null,
      "maxFreshWalletRate": null,
      "blockHoneypot": true,
      "blockWashTrading": true
    }
  }
}
```

- `null` values = filter not applied (no server-side param sent)
- `launchpads` = empty array or null = all launchpads
- `section` = one of `new_creation`, `near_completion`, `completed`

### Removed Config Fields

- `entryGuard` (entire section) — too strict for memecoin
- `minBuySellRatio` — replaced by `minSwaps24h` + GMGN buy/sell data
- `maxPriceDropH1Pct` — price data not in trenches, removed
- `minVolLiqRatio` — computed client-side if needed
- `requireSocials` — GMGN provides social signals natively
- `strictSecurity` — replaced by `blockHoneypot` + `blockWashTrading` + `maxRugRatio`
- `sources` (tokenProfiles, boostsLatest, boostsTop) — only used in DexScreener fallback, kept as internal constant

### Available GMGN Solana Launchpads

`Pump.fun`, `pump_mayhem`, `pump_mayhem_agent`, `pump_agent`, `letsbonk`, `bonkers`, `bags`, `memoo`, `liquid`, `bankr`, `zora`, `surge`, `anoncoin`, `moonshot_app`, `wendotdev`, `heaven`, `sugar`, `token_mill`, `believe`, `trendsfun`, `trends_fun`, `jup_studio`, `Moonshot`, `boop`, `ray_launchpad`, `meteora_virtual_curve`, `xstocks`

## 3. GMGN → Internal Candidate Normalization

| Internal Field | GMGN Trenches Field | Notes |
|---|---|---|
| `chain` | hardcoded `"solana"` | |
| `address` | `address` | |
| `symbol` | `symbol` | |
| `name` | `name` | |
| `priceUsd` | enriched via `GET /v1/token/info` | fallback DexScreener `tokenPairs` |
| `priceChange` | enriched via `GET /v1/token/info` | fallback DexScreener |
| `liquidityUsd` | `liquidity` | |
| `marketCap` | `usd_market_cap` | |
| `volume24h` | `volume_24h` | |
| `ageMinutes` | `(Date.now() - created_timestamp * 1000) / 60000` | |
| `buys24h` | `buys_24h` | |
| `sells24h` | `sells_24h` | |
| `traders24h` | `swaps_24h` | |
| `buySellRatio` | computed: `buys_24h / sells_24h` | |
| `holders` | `holder_count` | |
| `bondingProgress` | `progress` | 0-1, 1 = completed |
| `totalFee` | `total_fee` | |
| `botDegenCount` | `bot_degen_count` | |
| `botDegenRate` | `bot_degen_rate` | |
| `devHoldRate` | `dev_team_hold_rate` | |
| `top10HolderRate` | `top_10_holder_rate` | |
| `smartDegenCount` | `smart_degen_count` | |
| `sniperCount` | `sniper_count` | |
| `renownedCount` | `renowned_count` | |
| `bundlerRate` | `bundler_mhr` | |
| `freshWalletRate` | `fresh_wallet_rate` | |
| `insiderRate` | `suspected_insider_hold_rate` | |
| `ratTraderRate` | `rat_trader_amount_rate` | |
| `entrapmentRatio` | `entrapment_ratio` | |
| `rugRatio` | `rug_ratio` | |
| `section` | `"new_creation"` / `"near_completion"` / `"completed"` | |
| `security.honeypot` | `is_honeypot === "yes"` | |
| `security.washTrading` | `is_wash_trading` | |
| `security.openSource` | `open_source === "yes"` | |
| `security.ownerRenounced` | `owner_renounced === "yes"` | |
| `security.top10Pct` | `top_10_holder_rate * 100` | convert 0-1 to 0-100 |
| `launchpad` | `launchpad_platform` | |
| `dexId` | computed from `exchange` | `pump_amm` = raydium, `pump` = pump.fun curve |
| `socials` | count of non-empty: `twitter`, `telegram`, `website` | |
| `url` | `https://gmgn.ai/sol/token/{address}` | GMGN URL instead of DexScreener |
| `logo` | `logo` | |

### Price Enrichment Flow

After GMGN trenches returns filtered candidates (before scoring/ranking):
1. For each candidate, call `GET /v1/token/info?chain=sol&address=<addr>`
2. Extract `priceUsd` and `priceChange` (h1/h6/h24) from response
3. If GMGN token/info fails or returns no price, fallback to DexScreener `tokenPairs` → `bestPair` → `normalizePair`
4. `priceChange` is NOT used for filtering — only for trailing stop, SL dynamic, and Telegram display

## 4. Filter Engine

### Layer 1: Server-Side (GMGN)

All numeric/boolean filters sent as POST body parameters to `/v1/trenches`. GMGN filters server-side, returns only matching tokens. No client-side work needed.

Server-side filter mapping:
```
config filter        → trenches body param
─────────────────────────────────────────
minVolume24h         → min_volume_24h
maxVolume24h         → max_volume_24h
minLiquidity         → min_liquidity
maxLiquidity         → max_liquidity
minMarketCap         → min_marketcap
maxMarketCap         → max_marketcap
minHolders           → min_holder_count
maxHolders           → max_holder_count
minSwaps24h          → min_swaps_24h
maxSwaps24h          → max_swaps_24h
minAgeMinutes        → min_created (duration string)
maxAgeMinutes        → max_created (duration string)
minProgress          → min_progress
maxProgress          → max_progress
maxRugRatio          → max_rug_ratio
maxBundlerRate       → max_bundler_rate
maxInsiderRate       → max_insider_ratio
minTotalFee          → min_total_fee
maxTotalFee          → max_total_fee
maxBotDegenRate      → max_bot_degen_rate
maxTop10HolderRate   → max_top_holder_rate
maxDevHoldRate       → max_creator_balance_rate
minSmartDegenCount   → min_smart_degen_count
maxFreshWalletRate   → max_fresh_wallet_rate
```

### Layer 2: Client-Side (DexScreener Fallback)

Subset of filters applied client-side using DexScreener + GoPlus data:

| Filter | DexScreener/GoPlus Source |
|---|---|
| min/max volume24h | `volume.h24` |
| min/max liquidity | `liquidity.usd` |
| min/max marketCap | `marketCap` / `fdv` |
| min/max age | `pairCreatedAt` |
| min/max holders | GoPlus `holder_count` |
| min/max swaps24h | `txns.h24.buys + sells` |
| max top10 holder rate | GoPlus `top10Pct` |
| block honeypot | GoPlus `honeypot` |

Fields NOT available in DexScreener fallback (skipped): `progress`, `totalFee`, `botDegenRate`, `devHoldRate`, `rugRatio`, `bundlerRate`, `insiderRate`, `smartDegenCount`, `freshWalletRate`, `blockWashTrading`, `launchpads`.

### Removed Filters

- `entryGuard` (entire feature) — too strict for memecoin
- `minBuySellRatio` — available via computed field but removed as hard filter (used in scoring only)
- `maxPriceDropH1Pct` — price change data not in GMGN trenches
- `minVolLiqRatio` — available via computed field but removed as hard filter (used in scoring only)
- `requireSocials` — replaced by GMGN social signals
- `strictSecurity` — replaced by explicit security filters

## 5. Screening Flow

```
runScreening():
  1. Read config: section, filters, launchpads, gmgnApiKeys
  2. If source=gmgn:
     a. Try sequential API keys:
        POST /v1/trenches with section + filters + launchpads
        → success → normalize candidates → goto step 3
        → 401/429/network error → try next key
     b. All keys failed → goto step 4 (DexScreener fallback)
  3. GMGN candidates:
     a. Normalize to internal format
     b. Enrich price: GMGN token/info → fallback DexScreener tokenPairs
     c. Apply Darwin genome merge (tighten filters)
     d. Score + rank + slice to maxCandidatesPerCycle
     e. Pre-scorer (if LLM enabled)
     f. LLM gate (if LLM enabled)
     g. Return candidates
  4. DexScreener fallback (existing flow):
     a. discover() from DexScreener sources
     b. Cheap pre-filter
     c. GoPlus enrichment
     d. Full client-side filter (subset of GMGN fields)
     e. Score + rank + slice
     f. Pre-scorer (if LLM enabled)
     g. LLM gate (if LLM enabled)
     h. Return candidates
```

## 6. Scoring (Ranking)

Updated scoring function using GMGN fields:

```js
function score(c) {
  let s = 0;
  s += Math.min((c.volume24h || 0) / (c.liquidityUsd || 1), 10);  // vol/liq ratio
  s += Math.min((c.buySellRatio || 0), 3);                          // buy pressure
  s += Math.min((c.holders || 0) / 1000, 3);                        // holder count
  s += Math.min((c.smartDegenCount || 0), 5);                       // smart money
  s += Math.min((c.renownedCount || 0), 3);                         // KOL
  s -= Math.min((c.rugRatio || 0) * 10, 10);                        // rug risk (penalty)
  s -= Math.min((c.bundlerRate || 0) * 5, 5);                       // bundler (penalty)
  s -= Math.min((c.insiderRate || 0) * 5, 5);                       // insider (penalty)
  s += Math.min((c.botDegenCount || 0) / 10, 3);                    // bot degen activity
  s += (c.totalFee || 0) > 0 ? 2 : 0;                               // fee activity signal
  s += (c.socials || 0) > 0 ? 1 : 0;                                // social presence
  s += (c.bondingProgress || 0) > 0.8 ? 2 : 0;                      // near bonding
  return s;
}
```

## 7. Darwin Genome Adaptation

Fields explorable by Darwin (genome only tightens from baseline):

```js
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
```

`resolveExitGenome()` — unchanged (SL, trailing still from trading config).

## 8. Telegram Commands

### New Commands

| Command | Description |
|---|---|
| `/section [new_creation\|near_completion\|completed]` | Switch active section |
| `/launchpads` | List available launchpads |
| `/set screener.section <value>` | Change section |
| `/set screener.filters.launchpads [json]` | Set launchpad filter |
| `/set screener.gmgnApiKeys [json]` | Set API keys |

### Updated Commands

- `/menu` — add section selector + launchpad selector buttons
- `/config` — show new filter fields
- `/set screener.filters.<field> <value>` — all new filter fields supported

### Token Card Update

GMGN URL instead of DexScreener. New fields displayed: bonding progress, smart money count, bot degen rate, rug ratio, launchpad.

## 9. File Changes

### New Files
| File | Purpose |
|---|---|
| `src/screener/gmgn-discovery.js` | `discoverFromGmgn()` — POST /v1/trenches with sequential multi-key fallback, normalize response |

### Modified Files
| File | Changes |
|---|---|
| `src/config.js` | New DEFAULTS: `gmgnApiKeys`, `section`, redesigned filters. Remove entryGuard. |
| `src/screener/screener.js` | `runScreening()` dual-source flow. Remove entryGuard. Add GMGN price enrichment. |
| `src/screener/filters.js` | Redesign `evaluate()` and `score()` for GMGN fields + DexScreener subset. |
| `src/telegram/bot.js` | Section selector + launchpad selector in menu |
| `src/telegram/commands/config.js` | Support new config paths |
| `src/darwin/darwin.js` | Update MIN_FIELDS/MAX_FIELDS |
| `src/llm/loops.js` | Adapt candidate context |
| `src/llm/tools.js` | Adapt tool context |
| `src/telegram/fmt.js` | Token card with GMGN fields |
| `live-config.json` | New structure |

### Unchanged Files
| File | Reason |
|---|---|
| `src/screener/dexscreener.js` | Still used as fallback |
| `src/screener/goplus.js` | Still used in DexScreener fallback |
| `src/trade/executor.js` | Trade logic untouched |
| `src/trade/helpers.js` | Trade logic untouched |
| `src/trade/paper.js` | Trade logic untouched |
| `src/positions/` | Untouched |
| `src/chains/solana.js` | Untouched |
| `src/llm/llm.js` | Untouched |
| `src/db.js` | Minimal changes if any |
| `src/index.js` | Wire new dependencies |

### Removed
- `entryGuard` logic from `src/screener/screener.js`
- `src/screener/preScorer.js` — optional; can keep with field updates or remove

## 10. Skills Mode

Skills mode (non-interactive, stdin/stdout JSON protocol) uses same screening flow. No Telegram UI changes needed — section and filters read from config file directly. Only data source and filter engine change.

## 11. Error Handling

- **GMGN 401 (all keys):** Log warning, fallback to DexScreener
- **GMGN 429 (rate limit):** Wait for `x-ratelimit-reset`, retry once, then fallback to next key or DexScreener
- **GMGN network error:** Try next key immediately, no retry
- **GMGN empty response:** Treat as no candidates (not an error), skip DexScreener fallback
- **DexScreener error:** Return empty candidates (existing behavior)
- **Price enrichment failure:** Candidate kept without price; price fetched at execution time

## 12. Migration

- Old `live-config.json` backed up automatically
- Old filter fields mapped to new equivalents where possible
- `config.json` migration logic updated for new structure
- Users need to add `gmgnApiKeys` array manually (at least one key required)
