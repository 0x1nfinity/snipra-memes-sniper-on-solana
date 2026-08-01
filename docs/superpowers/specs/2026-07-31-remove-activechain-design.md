# Remove `activeChain` — Single Source of Truth via `chains.*.enabled`

**Date:** 2026-07-31
**Status:** approved

## Problem

`activeChain` (top-level `"solana"` | `"robinhood"` | `"both"`) dan `chains.<key>.enabled` (boolean per-chain) adalah dua kontrol redundant yang memutuskan chain mana yang aktif untuk screening dan trading.

Gate screening di `screener.js`:
```js
const active = cfg.activeChain === 'both' || cfg.activeChain === key;
if (c.enabled && active) chainMap[c.dexscreenerId] = key;
```

Ini menciptakan **contradictory state** yang membingungkan:
- `chains.robinhood.enabled: true` + `activeChain: "solana"` → Robinhood tidak di-screen meskipun "enabled"
- User harus ingat dua tempat untuk mengaktifkan satu chain

Selain itu, config paper dan live bisa drift: paper sudah `activeChain: "both"` tapi live masih `"solana"`.

## Solution

Hapus `activeChain` entirely. `chains.<key>.enabled` menjadi **satu-satunya** kontrol untuk menentukan chain mana yang aktif.

## Files Changed (8)

| # | File | Change |
|---|------|--------|
| 1 | `config.js` | Remove `activeChain` from DEFAULTS (line 48) |
| 2 | `config.paper.json` | Remove `activeChain` field |
| 3 | `config.live.json` | Remove `activeChain` field |
| 4 | `src/screener/screener.js` | Simplify chainMap: `if (c.enabled)` — remove dual-gate |
| 5 | `src/trade/helpers.js` | `buyToken()`: gate on `chains[key]?.enabled`. `effectiveMax()`: count enabled chains |
| 6 | `src/trade/executor.js` | Update stale comment mentioning `activeChain` |
| 7 | `src/telegram/commands/config.js` | Menu indicators use `chains.*.enabled`. Chain toggle actions only touch `chains.*.enabled`, no `setPath('activeChain')` |
| 8 | `src/index.js` | `botContext()`: replace `cfg.activeChain` with enabled chain list |

## Key Design Decisions

### `effectiveMax()`
```js
// Before: c.activeChain === 'both' ? maxPositions : maxPerChain
// After: count enabled chains
const n = Object.values(c.chains).filter(ch => ch.enabled).length;
return n > 1 ? c.trading.maxPositions : c.trading.maxPerChain;
```

### `buyToken()` gate
```js
// Before: cfg.activeChain !== 'both' && cfg.activeChain !== chainKey
// After: direct enabled check
if (!cfg.chains[chainKey]?.enabled)
  throw new Error(`chain ${chainKey} nonaktif`);
```

### Menu chain toggle
Radio-button style preserved (solana / robinhood / both) but only touches `chains.*.enabled`:
- "solana" → solana.enabled=true, robinhood.enabled=false
- "robinhood" → solana.enabled=false, robinhood.enabled=true
- "both" → both enabled=true

### Backward Compatibility
`deepMerge` will include `activeChain` from old config files but new code never reads it — harmless. No migration script needed.

## Scope / Out of Scope

**In scope:** Remove `activeChain` concept, update all references, ensure configs are consistent.
**Out of scope:** Any other config restructuring, new features, UI redesign beyond replacing the indicator source.
