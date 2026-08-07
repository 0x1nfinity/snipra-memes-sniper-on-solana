# Bug: Infinity Peak & Missing Price Data

## Date
2026-08-07

## Severity
High — positions opened with null entry price, causing Infinity% peak display, broken PnL tracking, and phantom trailing stop triggers.

## Symptoms

1. **Peak +Infinity%** in trailing stop notifications and `/status`
2. **Entry price shown as `?`** in buy notifications and position display
3. **All 4 bought tokens** had `entryPrice: null`
4. **Position PnL stuck at +0.0%** even as price moves

```
📈 Trailing — Active
COW — peak +Infinity%, trail 5%

🟢 ONBOARD  +0.0%
   ? → $0.000002032 · peak +Infinity%
```

## Root Cause

### 1. GMGN doesn't provide `priceUsd` for new_creation tokens

`gmgn-discovery.js:normalizeGmgnToken` sets:
```javascript
priceUsd: null,
priceNative: null,
```

Brand new tokens on GMGN have no price data — only market cap, liquidity, volume.

### 2. Price enrichment fails silently

`screener.js:enrichPrice()` tries two sources:
1. **GMGN `/v1/token/info`** — also returns no price for brand new tokens
2. **DexScreener fallback** — token not yet indexed (pair doesn't exist yet)

Both fail, `candidate.priceUsd` stays `null`. No error is thrown — enrichment is best-effort.

### 3. No validation before buy

`loops.js` buy loop doesn't check if `c.priceUsd` is valid before calling `buyToken`. Position is created with `entryPrice: null`.

### 4. Division by null/zero causes Infinity

`pnlPct(null, current)` → `(current - null) / null` → `NaN`
`(peakPrice - null) / null` → `Infinity`

Used in:
- `manager.js:324` — `peakGain` for trailing stop activation
- `status.js:32` — peak display in `/status`
- `state.js:176` — `currentPnlPct()`

## Fix (commit `0888b41`)

1. **`loops.js`**: Skip candidates with `!c.priceUsd > 0` before buy — show as "no price data" in rejection summary
2. **`utils.js:pnlPct()`**: Guard `entry <= 0` → return 0
3. **`manager.js:peakGain`**: Guard `pos.entryPrice > 0` before division

## Prevention

- New tokens on `new_creation` section may not have prices. This is expected — GMGN and DexScreener both need time to index.
- The `buyFreshnessCheck` flag controls re-validation before buy. For `new_creation`, set to `false` in config.
- Circuit breaker prevents rapid-fire buys (max 3/min) with 20s delay between buys in the screening loop.
