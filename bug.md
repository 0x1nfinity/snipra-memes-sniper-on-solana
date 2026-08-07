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

---

# Bug: Client-Side Filters Not Applied to GMGN Candidates

## Date
2026-08-07

## Severity
**CRITICAL** — Semua kandidat dari GMGN lolos tanpa filter market data (MC, liquidity, volume, holders, age). Hanya risk/quality filter yg dikirim server-side.

## Root Cause
`screener.js:runScreening()` — GMGN path (line 140-149) tidak memanggil `evaluate()`. Hanya DexScreener fallback path (line 194-198) yg menjalankan client-side filter.

GMGN server-side hanya menerima risk/quality params (`buildServerFilters`). Market data filter (`minMarketCap`, `minLiquidity`, `minVolume24h`, `minHolders`, `minSwaps24h`, `minAgeMinutes`, `maxAgeMinutes`) harus dicek client-side via `evaluate()`, tapi tidak dilakukan.

Akibat: token dengan MC $1.6K, liq $541 lolos padahal config `minMarketCap: 20000`, `minLiquidity: 20000`.

## Fix
Tambahkan `candidates.filter(c => evaluate(c, filters).pass)` setelah enrichment di GMGN path.

## Status
**BELUM DITERAPKAN** — edit gagal karena whitespace mismatch.

---

# Bug: Buy Loop Exceeds maxPositions (Revolving Door)

## Date
2026-08-07

## Severity
High — 14 posisi dibuka padahal maxPositions=5.

## Root Cause
Buy loop di `loops.js` cek `openPositions().length < effMax` tiap iterasi. Tapi ada delay 20 detik antar buy. Selama delay, position monitor (interval 20s) bisa menutup posisi via trailing stop/SL. Slot terbuka lagi → loop lanjut beli → "revolving door".

Balance: 14 buy × 1 SOL = 14 SOL, start balance 10 SOL — seharusnya gagal di buy ke-11 karena insufficient balance. Tapi loop tetap lanjut karena slot check cuma lihat current open positions.

## Fix
- Batasi total buy per siklus: `maxBuyThisCycle = Math.min(availSlots, candidates.length)` — diambil dari slot tersedia di AWAL siklus.
- Cek `bought.length >= maxBuyThisCycle` sebagai hard limit.

## Status
**Sudah di-commit** (`a1c0422`... atau belum? Perlu dicek).

---

# Bug: priceUsd vs priceNative DexScreener Inconsistency

## Date  
2026-08-07 (ongoing)

## Severity
High — PnL realized tidak match dengan pergerakan harga di monitoring.

## Symptom
BUTTHOLE: price +26.4% ($0.000006173 → $0.000007805), tapi PnL -11.1%. Monitoring pakai `priceUsd`, eksekusi pakai `priceNative`. DexScreener memberikan dua nilai yg tidak konsisten untuk pair yg sama.

## Root Cause
DexScreener `priceUsd` dan `priceNative` bisa berbeda 2-25x untuk token meme coin baru. Sistem sebelumnya pakai `priceUsd` untuk monitoring (trigger trailing/TP/SL) dan `priceNative` untuk eksekusi trade → trigger nyala di harga phantom.

## Fix
- `priceOf()` sekarang pakai `pair.priceNative` (bukan `priceUsd`)
- `entryPrice` pakai `c.priceNative` (bukan `c.priceUsd`)  
- `pos.currentPrice` sekarang dalam native SOL, bukan USD
- Display USD dikonversi via `nativePriceUsd()` hanya untuk tampilan

## Status
**Sudah di-commit** (`52ecb75`).

---

# Bug: Darwin Genome Kills GMGM Results

## Date
2026-08-07

## Severity
High — genome evolve `maxTop10HolderRate` ke 0.95% → dikirim server-side sebagai `max_top_holder_rate: 0.0095` → GMGN return `data: null` → 0 kandidat.

## Root Cause
Darwin genome tightening dikirim sebagai server-side filter ke GMGN. Nilai genome terlalu restriktif untuk new_creation — `maxTop10HolderRate: 0.95%` artinya "hanya token dengan top holder < 0.95% supply" — hampir tidak ada token memenuhi.

## Fix
- Server-side filter pakai `baseFilters` (config user, tanpa genome)
- Genome tightening hanya diterapkan client-side (`evaluate()`)
- Auto-evolve disabled di `evolve.js:onTradeClosed` + `darwin.js:recordTrade` guard `every <= 0`

## Status
**Sudah di-commit** (`08c66e4`, `16faf3f`).

---

# Bug: buyFreshnessCheck Kills New Tokens

## Date
2026-08-07

## Severity
Medium — 30/30 kandidat gagal freshness recheck.

## Root Cause
`buyFreshnessCheck` re-fetch dari DexScreener sebelum buy. Untuk token `new_creation`, DexScreener belum terindeks — return liq 0, mcap beda jauh dari GMGN. Semua kandidat gagal recheck.

## Fix
Disabled via config: `buyFreshnessCheck: false` di paper-config.json.

## Status
**Sudah di-commit** (`530d23f`).

---

# Bug: GoPlus Overwrites GMGN Holder Data

## Date
2026-08-07

## Severity
Low — holder count hilang dari display.

## Root Cause
`screener.js:180` — `c.holders = sec.holders` menimpa data GMGN dengan null dari GoPlus (GoPlus sering tidak punya `holder_count` untuk token baru).

## Fix
Cek `!= null` sebelum overwrite: `if (sec.holders != null) c.holders = sec.holders`.

## Status
**Sudah di-commit** (`4270afa`).

---

# Bug: Pair Selection Mismatch (priceOf vs bestPair)

## Date
2026-08-07

## Severity
High — monitoring pakai pair berbeda dari eksekusi.

## Root Cause
`priceOf` di monitoring: `mine.find(x => x.pairAddress === p.pairAddress) || mine[0]` — prioritaskan match by pairAddress. `_tryPriceNative` di eksekusi: `bestPair(mine)` — selalu pair paling likuid. Bisa berbeda → harga monitoring ≠ harga eksekusi.

## Fix
`priceOf` sekarang pakai `mine[0]` (pair paling likuid) — konsisten dengan `bestPair()`.

## Status
**Sudah di-commit** (`4270afa`).
