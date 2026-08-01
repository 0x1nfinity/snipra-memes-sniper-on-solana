# Snipra v2 Audit Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all critical/high bugs found in audit, implement complete live/paper mode separation (config + state + notifications), and refactor large modules for maintainability.

**Architecture:** Fixes are applied bottom-up: shared utilities first, then chain modules, then state/positions, then orchestrator. Mode separation touches config, state, executor, and telegram modules. Structural refactors extract helpers from oversized files without changing behavior.

**Tech Stack:** Node.js 18+, ES modules, better-sqlite3, ethers.js v6, @solana/web3.js, node-telegram-bot-api

## Global Constraints

- Node.js >= 18 (ES modules, `import`/`export` syntax only)
- All file paths use `import { ... } from '../relative/path.js'` with `.js` extension
- Config hot-reload via `fs.watchFile` must continue working after refactors
- Telegram notifications must carry mode badge (`📝 PAPER` / `🔴 LIVE`) on every message
- State files already per-mode: `positions.paper.json`, `positions.live.json` — this separation must be preserved
- PM2 process manager runs the bot; `SIGINT`/`SIGTERM` shutdown must remain graceful
- No TypeScript — plain JavaScript only

---

## File Structure Map (Post-Implementation)

```
src/
├── index.js              # orchestrator: wiring + loop coordination (~200 lines after split)
├── config.js             # config loader: dual-file (paper/live), deep merge, hot-reload
├── db.js                 # SQLite: trades, paper wallet, ATH watch (unchanged structure)
├── logger.js             # ring-buffer logger (unchanged)
├── prices.js             # native price via DexScreener (unchanged)
├── utils.js              # shared: sleep, fetchJson, formatters, mapLimit, clamp
├── chains/
│   ├── evm.js            # EVM swap: Uniswap V3/V2 (fix receivedNative)
│   └── solana.js         # Solana swap: Jupiter/GMGN (fix receivedNative)
├── darwin/
│   ├── darwin.js         # genetic algorithm (unchanged)
│   └── evolve.js         # EXTRACTED: runEvolve + geneDiffLines from index.js
├── llm/
│   └── llm.js            # LLM: assess, lessons, suggestGenes, chat (unchanged)
├── positions/
│   ├── state.js          # in-memory state + per-mode persist (add debounce)
│   └── manager.js        # monitor loop (add moonbag price guard)
├── screener/
│   ├── screener.js       # screening pipeline (unchanged)
│   ├── dexscreener.js    # DexScreener API (fix trending discovery)
│   ├── filters.js        # filter evaluation + scoring (unchanged)
│   └── goplus.js         # GoPlus security API (unchanged)
├── telegram/
│   ├── bot.js            # Telegram bot: commands via registry (~350 lines after split)
│   ├── commands/         # NEW: one file per command group
│   │   ├── index.js      # command registry + routing
│   │   ├── status.js     # /status, /positions, /stats
│   │   ├── trading.js    # /buy, /sell, /closeall, /screen, /pause, /resume
│   │   ├── config.js     # /config, /get, /set, /mode, /menu
│   │   ├── darwin.js     # /darwin, /evolve, /lessons
│   │   └── system.js     # /help, /logs, /stop, /papertrades, /paperreset
│   ├── fmt.js            # formatting helpers (unchanged)
│   └── reports.js        # EXTRACTED: sendStatusReport from index.js
└── trade/
    ├── executor.js       # unified trade interface (unchanged)
    ├── paper.js          # paper trading simulation (add gas simulation)
    └── helpers.js        # EXTRACTED: buyToken, sellToken, resolveCandidate, effectiveMax
```

---

### Phase 1: Critical + High Bug Fixes

### Task 1.1: Fix trending discovery — `search()` misuse in dexscreener.js

**Files:**
- Modify: `src/screener/dexscreener.js:116-131`
- Reference: `src/screener/dexscreener.js:37-45` (search function)

**Interfaces:**
- Consumes: `search(query)` from same file — currently calls DexScreener `/latest/dex/search?q=...`
- Produces: `discover(chainMap, sources)` — same signature, corrected behavior for `sources.trending`

**Context:** `discover()` line 119 calls `search(dsChain)` where `dsChain` is a DexScreener chain ID like `"solana"` or `"robinhood"`. The `search()` function hits DexScreener's name-search endpoint, so it searches for tokens NAMED "solana" or "robinhood", not tokens trending ON those chains. This makes the `trending` source completely non-functional.

**Fix:** The DexScreener free API doesn't have a dedicated "trending per chain" endpoint. The `token-profiles/latest/v1` and `token-boosts/latest/v1` already provide fresh tokens filtered by chain in the `discover` function. The `trending` source should be removed as a separate code path and instead the existing `tokenProfiles`, `boostsLatest`, and `boostsTop` sources already cover discovery adequately. The `search()` function is still useful for Telegram's manual token lookup (`_searchByName` in bot.js:252) so it must remain.

- [ ] **Step 1: Remove the broken `trending` source block from `discover()`**

In `src/screener/dexscreener.js`, remove lines 116-131 (the entire `// Sumber tambahan: search per chain` block):

```js
// REMOVE this entire block (lines 115-132):
  // Sumber tambahan: search per chain utk pair volume tinggi terbaru
  if (sources.trending) {
    for (const dsChain of wanted) {
      try {
        const pairs = await search(dsChain);
        for (const p of pairs) {
          if (p.chainId === dsChain && wanted.has(p.chainId) && p?.baseToken?.address) {
            found.set(`${p.chainId}:${p.baseToken.address}`, {
              chainId: p.chainId,
              address: p.baseToken.address,
            });
          }
        }
      } catch (e) {
        log.warn(`search ${dsChain} gagal:`, e.message);
      }
    }
  }
```

- [ ] **Step 2: Update config DEFAULTS to remove `trending` from sources**

In `src/config.js`, line 59, change:
```js
sources: { tokenProfiles: true, boostsLatest: true, boostsTop: true, trending: true },
```
To:
```js
sources: { tokenProfiles: true, boostsLatest: true, boostsTop: true },
```

- [ ] **Step 3: Update config.json to remove `trending`**

In `config.json`, line 43, remove `"trending": true` from the `sources` object.

- [ ] **Step 4: Verify syntax**

```bash
node --check src/screener/dexscreener.js && node --check src/config.js
```

- [ ] **Step 5: Commit**

```bash
git add src/screener/dexscreener.js src/config.js config.json
git commit -m "fix: remove broken trending discovery source

The trending source called search(dsChain) which searches DexScreener
by token NAME (e.g. tokens named 'solana'), not tokens trending on that
chain. tokenProfiles + boostsLatest + boostsTop already provide adequate
discovery coverage.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 1.2: Fix `receivedNative` using quote estimate instead of actual in EVM sell

**Files:**
- Modify: `src/chains/evm.js:170-215` (sell method)

**Interfaces:**
- Consumes: `this.provider.getBalance()`, `this.tokenBalance()`, `this._route()`
- Produces: `sell()` returns `{ txid, soldRaw, receivedNative }` — `receivedNative` now actual

**Context:** After a successful swap tx, the sell method returns `route.out` (the pre-swap quote) as `receivedNative`. The actual ETH received can differ due to slippage during execution. Must check actual ETH balance delta.

- [ ] **Step 1: Fix sell() to use actual balance delta for receivedNative**

In `src/chains/evm.js`, modify the sell method. Replace lines 170-215:

The key change: capture ETH balance before the swap, then after receipt, compute the actual delta.

```js
async sell(tokenAddress, pct, slippageBps, pairInfo = {}) {
  const weth = this.cfg.weth;
  let raw;
  if (this.dryRun && !this.wallet) {
    raw = ethers.parseUnits('1000', 18);
  } else {
    const bal = await this.tokenBalance(tokenAddress);
    raw = (bal.raw * BigInt(Math.floor(pct * 100))) / 10000n;
  }
  if (raw <= 0n) throw new Error(`balance ${tokenAddress.slice(0, 8)} = 0`);

  const route = await this._route(tokenAddress, weth, raw, pairInfo.labels);
  const minOut = this._minOut(route.out, slippageBps);

  if (this.dryRun) {
    log.info(`[DRY] [${this.key}] sell ${pct}% ${tokenAddress.slice(0, 8)} via ${route.kind} out=${route.out}`);
    return { txid: `dry-${Date.now()}`, soldRaw: raw, receivedNative: Number(ethers.formatEther(route.out)) };
  }
  if (!this.wallet) throw new Error('wallet EVM belum diset');

  // Capture balance BEFORE swap to compute actual received
  const ethBefore = await this.provider.getBalance(this.wallet.address);

  let tx;
  if (route.kind === 'v3') {
    await this._ensureApproval(tokenAddress, this.cfg.v3SwapRouter02, raw);
    const swapData = this.v3Router.interface.encodeFunctionData('exactInputSingle', [{
      tokenIn: tokenAddress, tokenOut: weth, fee: route.fee,
      recipient: ADDRESS_THIS, amountIn: raw,
      amountOutMinimum: minOut, sqrtPriceLimitX96: 0n,
    }]);
    const unwrapData = this.v3Router.interface.encodeFunctionData('unwrapWETH9', [minOut, this.wallet.address]);
    tx = await this.v3Router.multicall([swapData, unwrapData], { gasLimit: this.cfg.gasLimitSwap });
  } else {
    await this._ensureApproval(tokenAddress, this.cfg.v2Router, raw);
    const deadline = Math.floor(Date.now() / 1000) + 300;
    tx = await this.v2Router.swapExactTokensForETHSupportingFeeOnTransferTokens(
      raw, minOut, [tokenAddress, weth], this.wallet.address, deadline,
      { gasLimit: this.cfg.gasLimitSwap }
    );
  }
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error(`sell tx revert: ${tx.hash}`);

  // Compute actual ETH received (balance delta), accounting for gas spent
  const ethAfter = await this.provider.getBalance(this.wallet.address);
  const gasUsed = receipt.gasUsed * receipt.gasPrice;  // ethers v6: gasUsed and gasPrice are bigints
  const receivedNative = Number(ethers.formatEther(ethAfter - ethBefore + gasUsed));

  log.info(`SELL [${this.key}] ${pct}% ${tokenAddress.slice(0, 8)} via ${route.kind} tx ${tx.hash} → ${receivedNative.toFixed(6)} ETH`);
  return { txid: tx.hash, soldRaw: raw, receivedNative };
}
```

- [ ] **Step 2: Verify syntax**

```bash
node --check src/chains/evm.js
```

- [ ] **Step 3: Commit**

```bash
git add src/chains/evm.js
git commit -m "fix: use actual ETH balance delta for receivedNative in EVM sell

Previously returned quote estimate (route.out) which differs from actual
received due to slippage. Now computes balance before/after swap, adding
back gas cost to get gross ETH received.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 1.3: Fix `receivedNative` using quote estimate instead of actual in Solana sell

**Files:**
- Modify: `src/chains/solana.js:170-183` (sell method)

**Interfaces:**
- Consumes: `this.connection.getBalance()`, `this.tokenBalance()`, `this._swap()`
- Produces: `sell()` returns `{ txid, soldRaw, receivedNative }` — `receivedNative` now actual

- [ ] **Step 1: Fix sell() to compute actual SOL received**

In `src/chains/solana.js`, modify the sell method (lines 170-183):

```js
async sell(tokenAddress, pct, slippageBps) {
  let raw;
  if (this.dryRun && !this.wallet) {
    raw = 1_000_000n;
  } else {
    const bal = await this.tokenBalance(tokenAddress);
    raw = (bal.raw * BigInt(Math.floor(pct * 100))) / 10000n;
  }
  if (raw <= 0n) throw new Error(`balance ${tokenAddress.slice(0, 6)} = 0`);

  // Capture SOL balance BEFORE swap
  const solBefore = this.wallet
    ? await this.connection.getBalance(this.wallet.publicKey)
    : 0n;

  const res = await this._swap(tokenAddress, SOL_MINT, raw, slippageBps);

  // Compute actual SOL received (balance delta)
  let receivedNative;
  if (this.dryRun && !this.wallet) {
    receivedNative = Number(res.outAmountRaw) / LAMPORTS_PER_SOL;
  } else {
    const solAfter = await this.connection.getBalance(this.wallet.publicKey);
    // Add a small estimate for tx fee since we can't easily get exact fee
    const TX_FEE_ESTIMATE = 5000n; // 0.000005 SOL typical Jupiter tx fee
    receivedNative = Number(solAfter - solBefore + TX_FEE_ESTIMATE) / LAMPORTS_PER_SOL;
  }

  log.info(`SELL ${pct}% ${tokenAddress.slice(0, 6)} → ${receivedNative.toFixed(4)} SOL, tx ${res.txid}`);
  return { txid: res.txid, soldRaw: raw, receivedNative };
}
```

- [ ] **Step 2: Verify syntax**

```bash
node --check src/chains/solana.js
```

- [ ] **Step 3: Commit**

```bash
git add src/chains/solana.js
git commit -m "fix: use actual SOL balance delta for receivedNative in Solana sell

Previously returned Jupiter quote outAmount which differs from actual
received due to slippage. Now computes SOL balance before/after swap.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 1.4: Fix stale `resetStats` comment about "global (tidak per-mode)"

**Files:**
- Modify: `src/positions/state.js:224-234`

**Interfaces:**
- Produces: `resetStats()` — behavior unchanged, only comment updated

- [ ] **Step 1: Update the comment**

In `src/positions/state.js`, replace lines 224-234 (the `resetStats` JSDoc):

```js
/**
 * Nolkan akumulator statistik + riwayat close in-memory (dipakai /paperreset).
 * State sudah per-mode (positions.paper.json vs positions.live.json) jadi
 * reset hanya mempengaruhi mode yang sedang aktif. Riwayat DB dihapus
 * terpisah per-mode via deleteTrades('paper').
 */
export function resetStats() {
  state.stats = { totalTrades: 0, wins: 0, losses: 0, totalPnlPct: 0 };
  state.closed = [];
  persist();
}
```

- [ ] **Step 2: Commit**

```bash
git add src/positions/state.js
git commit -m "fix: update resetStats comment to reflect per-mode state separation

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 1.5: Add `priceMinLiquidityUsd` guard to moonbag price refresh

**Files:**
- Modify: `src/positions/manager.js:96-98`

**Interfaces:**
- Consumes: `cfg.trading.priceMinLiquidityUsd` from config
- Produces: moonbag prices skip low-liquidity pairs (same guard as active positions)

- [ ] **Step 1: Add liquidity guard to moonbag price update**

In `src/positions/manager.js`, replace lines 96-98:

```js
for (const m of moon) {
  const { price, liqUsd } = priceOf(m);
  if (!(price > 0)) continue;
  // Same sanity guard as active positions: skip low-liquidity pairs
  if (liqUsd > 0 && liqUsd < minLiq) {
    log.warn(`moonbag ${m.symbol}: harga $${price} diabaikan (likuiditas $${liqUsd.toFixed(0)} < $${minLiq})`);
    continue;
  }
  updateMoonbagPrice(m, price);
}
```

- [ ] **Step 2: Verify syntax**

```bash
node --check src/positions/manager.js
```

- [ ] **Step 3: Commit**

```bash
git add src/positions/manager.js
git commit -m "fix: add priceMinLiquidityUsd guard to moonbag price refresh

Moonbags previously skipped the low-liquidity sanity check that active
positions get. A rug-pulled token's moonbag could read garbage prices
from near-zero liquidity pairs.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 1.6: Add debounce to state `persist()` to reduce disk writes

**Files:**
- Modify: `src/positions/state.js:59-66`

**Interfaces:**
- Produces: `persist()` — same signature, now debounced with 500ms trailing edge

- [ ] **Step 1: Implement debounced persist**

In `src/positions/state.js`, replace lines 59-66 and add the debounce:

```js
let _persistTimer = null;
const PERSIST_DEBOUNCE_MS = 500;

function persist() {
  // Debounce: batch multiple rapid writes into one.
  // Price updates for N positions in one tick → 1 disk write instead of N.
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    _writeState();
  }, PERSIST_DEBOUNCE_MS);
}

/** Force immediate write (used during shutdown or critical state changes) */
function persistNow() {
  if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null; }
  _writeState();
}

function _writeState() {
  const file = fileForMode(loadedMode ?? getConfig().mode);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}
```

- [ ] **Step 2: Use `persistNow()` in `closePosition` and `addPosition` to ensure immediate persistence for critical changes**

In `addPosition()` (line 109), keep `persist()` since positions are written on creation which is infrequent.

In `closePosition()` (line 158), change `persist()` to `persistNow()` since trade close is critical:

```js
// In closePosition, line ~158:
persistNow();  // was: persist()
```

- [ ] **Step 3: Verify syntax**

```bash
node --check src/positions/state.js
```

- [ ] **Step 4: Commit**

```bash
git add src/positions/state.js
git commit -m "perf: debounce state persist to reduce disk writes

Price updates fire persist() on every tick for every position. With
10 positions at 10s interval, that's ~1 write/second. Now batched
with 500ms debounce. Critical state changes (closePosition) use
persistNow() for immediate durability.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 1.7: Extract duplicate `effectiveMax` logic into shared helper

**Files:**
- Modify: `src/index.js:63-64`, `src/index.js:494`
- Create: `src/trade/helpers.js`

**Interfaces:**
- Produces: `export function effectiveMax(cfg)` returning `number`
- Modify: `index.js` imports and uses `effectiveMax`

- [ ] **Step 1: Create `src/trade/helpers.js`**

```js
import { getConfig } from '../config.js';

/**
 * Batas jumlah posisi terbuka efektif berdasarkan activeChain.
 * - 'both':  maxPositions (total semua chain)
 * - single:  maxPerChain (hanya 1 chain yg aktif)
 */
export function effectiveMax(cfg) {
  const c = cfg || getConfig();
  return c.activeChain === 'both' ? c.trading.maxPositions : c.trading.maxPerChain;
}
```

- [ ] **Step 2: Update `index.js` to use the helper**

Add import at top:
```js
import { effectiveMax } from './trade/helpers.js';
```

Replace line 63:
```js
const effectiveMax = cfg.activeChain === 'both' ? cfg.trading.maxPositions : cfg.trading.maxPerChain;
```
With:
```js
const effMax = effectiveMax(cfg);
```

Replace line 64:
```js
if (openPositions().length >= effectiveMax)
  throw new Error(`max posisi (${effectiveMax}) tercapai`);
```
With:
```js
if (openPositions().length >= effMax)
  throw new Error(`max posisi (${effMax}) tercapai`);
```

Replace line 494 (in `sendStatusReport`):
```js
const effectiveMax = cfg.activeChain === 'both' ? cfg.trading.maxPositions : cfg.trading.maxPerChain;
```
With:
```js
const effMax = effectiveMax(cfg);
```

Replace line 497:
```js
`Total posisi ${openPositions().length}/${effectiveMax} · Moonbag ...`
```
With:
```js
`Total posisi ${openPositions().length}/${effMax} · Moonbag ...`
```

- [ ] **Step 3: Verify syntax**

```bash
node --check src/trade/helpers.js && node --check src/index.js
```

- [ ] **Step 4: Commit**

```bash
git add src/trade/helpers.js src/index.js
git commit -m "refactor: extract effectiveMax helper to trade/helpers.js

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Phase 2: Complete Mode Separation

### Task 2.1: Implement dual config file system (config.paper.json + config.live.json)

**Files:**
- Modify: `src/config.js` (full rewrite of load/save/reload/watch logic)
- Create: `config.paper.json` (migrate from current config.json with paper settings)
- Create: `config.live.json` (migrate from current config.json with live settings)
- Modify: `src/index.js` (mode initialization from marker file)

**Interfaces:**
- Consumes: `SNIPRA_MODE` env var or `data/.mode` marker file
- Produces: `getConfig()` — always returns config for the active mode
- Produces: `saveConfig()` — writes to the active mode's config file
- Produces: `reloadConfig()` — watches the active file
- Produces: `switchMode(newMode)` — NEW: atomically saves current + loads other
- Removes: `mode` field from config DEFAULTS (mode is now external)

**Context:** Mode is no longer stored inside config.json. It's determined by `data/.mode` marker file (or `SNIPRA_MODE` env var as fallback). Two config files exist: `config.paper.json` and `config.live.json`. Switching mode saves current config, then loads the other file.

- [ ] **Step 1: Define the mode resolution logic and helper paths**

```js
// config.js — new mode-related constants
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from './logger.js';

const log = createLogger('config');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, '..', 'data');
const ROOT_DIR = path.join(__dirname, '..');

// Marker file: last line contains the active mode ("paper" or "live")
const MODE_FILE = path.join(DATA_DIR, '.mode');

function readModeMarker() {
  // Priority: SNIPRA_MODE env var > .mode file > default "paper"
  if (process.env.SNIPRA_MODE === 'paper' || process.env.SNIPRA_MODE === 'live') {
    return process.env.SNIPRA_MODE;
  }
  try {
    const content = fs.readFileSync(MODE_FILE, 'utf8').trim();
    if (content === 'paper' || content === 'live') return content;
  } catch { /* file doesn't exist yet */ }
  return 'paper'; // safe default
}

function writeModeMarker(mode) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MODE_FILE, `${mode}\n`);
}

/** Path ke config file untuk mode tertentu */
function configFileFor(mode) {
  return path.join(ROOT_DIR, `config.${mode}.json`);
}
```

- [ ] **Step 2: Rewrite loadConfig() for dual files**

```js
let activeMode = null;
let config = null;
let configWatcher = null;

export function loadConfig() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  activeMode = readModeMarker();
  writeModeMarker(activeMode); // ensure file exists

  const file = configFileFor(activeMode);
  if (fs.existsSync(file)) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      config = deepMerge(structuredClone(DEFAULTS), saved);
      log.info(`config loaded from config.${activeMode}.json`);
    } catch (e) {
      log.error(`config.${activeMode}.json rusak, pakai defaults:`, e.message);
      config = structuredClone(DEFAULTS);
    }
  } else {
    // First run: create config file from defaults
    config = structuredClone(DEFAULTS);
    saveConfig();
    log.info(`config.${activeMode}.json belum ada — dibuat dengan nilai default`);
  }

  // Migrate old config.json to new split files (one-time)
  migrateOldConfig();

  // DRY_RUN override: jika diset, paksa paper
  if (process.env.DRY_RUN === '1') {
    if (activeMode !== 'paper') {
      log.warn(`⚠️ DRY_RUN=1 di .env MEMAKSA mode 'paper' walau mode='${activeMode}'. Set DRY_RUN=0 untuk live.`);
      activeMode = 'paper';
    }
  }

  return config;
}

/** One-time migration: if config.json exists but config.paper.json doesn't */
function migrateOldConfig() {
  const oldFile = path.join(ROOT_DIR, 'config.json');
  const paperFile = configFileFor('paper');
  const liveFile = configFileFor('live');

  if (fs.existsSync(oldFile) && !fs.existsSync(paperFile) && !fs.existsSync(liveFile)) {
    try {
      const old = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
      // Create both paper and live configs from old unified config
      const paperCfg = deepMerge(structuredClone(DEFAULTS), { ...old, mode: undefined });
      const liveCfg = deepMerge(structuredClone(DEFAULTS), { ...old, mode: undefined });
      fs.writeFileSync(paperFile, JSON.stringify(paperCfg, null, 2));
      fs.writeFileSync(liveFile, JSON.stringify(liveCfg, null, 2));
      // Rename old file so we don't migrate again
      fs.renameSync(oldFile, `${oldFile}.migrated-${Date.now()}.bak`);
      log.info('migrated config.json → config.paper.json + config.live.json (old file backed up)');
    } catch (e) {
      log.warn('config migration failed:', e.message);
    }
  }
}
```

- [ ] **Step 3: Update saveConfig() to write to active file**

```js
export function saveConfig() {
  if (!activeMode) return;
  const file = configFileFor(activeMode);
  // Strip mode if somehow present
  const toSave = { ...config };
  delete toSave.mode;
  fs.writeFileSync(file, JSON.stringify(toSave, null, 2));
}
```

- [ ] **Step 4: Update reloadConfig() for active file**

```js
export function reloadConfig() {
  if (!activeMode) return { changed: false, timersChanged: false };
  const file = configFileFor(activeMode);
  if (!fs.existsSync(file)) return { changed: false, timersChanged: false };
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    log.debug('reload config dilewati (JSON belum valid):', e.message);
    return { changed: false, timersChanged: false };
  }
  const next = deepMerge(structuredClone(DEFAULTS), saved);
  delete next.mode;
  if (process.env.DRY_RUN === '1' && activeMode !== 'paper') {
    // DRY_RUN override — don't change config, just note
  }
  const prev = config;
  const changed = JSON.stringify(next) !== JSON.stringify(prev);
  const pick = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
  const timersChanged = changed && TIMER_PATHS.some((p) => pick(next, p) !== pick(prev, p));
  config = next;
  return { changed, timersChanged };
}
```

- [ ] **Step 5: Add switchMode() for Telegram /mode command**

```js
/**
 * Ganti mode (paper ↔ live). Simpan config aktif ke file, lalu load config
 * dari file mode baru. Return mode baru.
 */
export function switchMode(newMode) {
  if (newMode !== 'paper' && newMode !== 'live') {
    throw new Error(`mode tidak valid: ${newMode} (harus paper atau live)`);
  }
  if (newMode === activeMode) return activeMode;

  // Save current config first
  saveConfig();

  // Switch
  const oldMode = activeMode;
  activeMode = newMode;
  writeModeMarker(activeMode);

  // Load other config file
  const file = configFileFor(activeMode);
  if (fs.existsSync(file)) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      config = deepMerge(structuredClone(DEFAULTS), saved);
      log.info(`switched mode ${oldMode} → ${activeMode}, config loaded from config.${activeMode}.json`);
    } catch (e) {
      log.error(`config.${activeMode}.json rusak saat switch:`, e.message);
      config = structuredClone(DEFAULTS);
    }
  } else {
    // New mode has no config yet — seed from defaults
    config = structuredClone(DEFAULTS);
    saveConfig();
    log.info(`config.${activeMode}.json dibuat dari defaults (mode baru)`);
  }

  // Update watcher to track new active file
  if (configWatcher) {
    fs.unwatchFile(configFileFor(oldMode));
    fs.watchFile(configFileFor(activeMode), { interval: 2000 }, () => {
      const res = reloadConfig();
      if (res.changed) {
        log.info(`config.${activeMode}.json berubah di disk — dimuat ulang tanpa restart`);
        configChangeCallback?.(res);
      }
    });
  }

  return activeMode;
}

export function getActiveMode() {
  return activeMode;
}
```

- [ ] **Step 6: Update watchConfig() for dynamic file watching**

```js
let configChangeCallback = null;

export function watchConfig(onChange) {
  configChangeCallback = onChange;
  const file = configFileFor(activeMode);
  try {
    fs.watchFile(file, { interval: 2000 }, () => {
      const res = reloadConfig();
      if (res.changed) {
        log.info(`config.${activeMode}.json berubah di disk — dimuat ulang tanpa restart`);
        onChange?.(res);
      }
    });
    log.info(`hot-reload config.${activeMode}.json aktif (pantau tiap 2s)`);
  } catch (e) {
    log.error('gagal memasang watcher config:', e.message);
  }
}
```

- [ ] **Step 7: Remove `mode` from DEFAULTS**

In `src/config.js`, line 20, remove:
```js
mode: 'paper',
```

- [ ] **Step 8: Verify syntax**

```bash
node --check src/config.js
```

- [ ] **Step 9: Commit**

```bash
git add src/config.js
git commit -m "feat: dual config file system (config.paper.json + config.live.json)

Mode is now external to config — stored in data/.mode marker file.
Switching mode via switchMode() saves current config then loads the
other file. One-time migration from old config.json on first run.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2.2: Update `index.js` to use new config mode system

**Files:**
- Modify: `src/index.js`

**Interfaces:**
- Consumes: `getConfig()` now returns config without `mode` field; mode from `getActiveMode()`
- Consumes: `switchMode()` for Telegram /mode handler

**Context:** All references to `cfg.mode` must use the external `getActiveMode()` or `activeMode` concept. The config object no longer carries `mode`.

- [ ] **Step 1: Update imports and mode usage in index.js**

Add import:
```js
import { loadConfig, getConfig, watchConfig, getActiveMode, switchMode } from './config.js';
```

Replace all `cfg.mode` references with `getActiveMode()`. Key locations:

- Line 179: `trades: recentTrades(cfg.mode, 20)` → `trades: recentTrades(getActiveMode(), 20)`
- Line 234: `recentTrades(cfg.mode, 5)` → `recentTrades(getActiveMode(), 5)`
- Line 238: `mode=${cfg.mode}` → `mode=${getActiveMode()}`
- Line 464: `tradeStatsByChain(cfg.mode)` → `tradeStatsByChain(getActiveMode())`
- Line 496: ``${cfg.mode}`` → `${getActiveMode()}`
- Line 541: `mode=${cfg.mode}` → `mode=${getActiveMode()}`

Update the startup log (line 541):
```js
const mode = getActiveMode();
log.info(`snipra v2 start | mode=${mode} | chains: ...`);
```

Update `applyMode()` (line 30-33):
```js
function applyMode() {
  executor.syncMode();
  syncStateMode();
}
```

Update `notify()` calls to use `getActiveMode()` instead of `cfg.mode` — this is already done via `telegram.notify()` which reads config internally. Verify `notify()` in `telegram/bot.js:424` uses `getConfig().mode` → change to `getActiveMode()`.

- [ ] **Step 2: Update /mode command in Telegram to use switchMode()**

In `src/telegram/bot.js`, the `/mode` handler (currently around line 474-484) will be refactored in Task 2.3. For now, verify the handler calls `switchMode()`.

- [ ] **Step 3: Verify syntax**

```bash
node --check src/index.js
```

- [ ] **Step 4: Commit**

```bash
git add src/index.js
git commit -m "refactor: use external getActiveMode() instead of cfg.mode

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2.3: Update Telegram bot to use new mode system + verify no data leakage

**Files:**
- Modify: `src/telegram/bot.js`
- Modify: `src/telegram/fmt.js` (if needed)

**Interfaces:**
- Consumes: `getActiveMode()` from config
- Produces: All notifications carry correct mode badge, no cross-mode data

- [ ] **Step 1: Update /mode handler to use switchMode()**

In `src/telegram/bot.js`, replace the `/mode` case (lines 474-484):

```js
case '/mode': {
  const m = args[0];
  if (m !== 'paper' && m !== 'live') return this._send('Usage: /mode paper|live');
  const newMode = switchMode(m);
  d.applyMode();
  d.restartLoops();
  return this._send(
    newMode === 'paper'
      ? '📝 Mode PAPER — trade simulasi, saldo virtual.\n_Config + state di file terpisah dari live._'
      : '🔴 *MODE LIVE* — transaksi on-chain sungguhan!\n_Config + state di file terpisah dari paper._'
  );
}
```

- [ ] **Step 2: Update /status to use getActiveMode()**

Replace `cfg.mode` references in /status handler with `getActiveMode()`.

- [ ] **Step 3: Update notify() badge**

Replace `getConfig().mode` with `getActiveMode()` on line 424:
```js
notify(text) {
  const badge = getActiveMode() === 'live' ? '🔴 LIVE' : '📝 PAPER';
  this._send(`${badge}\n${text}`).catch((e) => log.warn(`notify gagal: ${e.message}`));
}
```

- [ ] **Step 4: Update all menu/display logic referencing cfg.mode**

Search for `cfg.mode` in bot.js and replace with `getActiveMode()`.

- [ ] **Step 5: Audit notification paths for data leakage**

Verify these notification paths:
- `screeningCycle` → `telegram.notify()` — uses badge ✅
- `PositionManager._notifyClosed` → `this.notify()` — uses badge ✅
- `PositionManager.notify` (SL pending, trailing active) — uses badge ✅
- `sendStatusReport` → `telegram.notify()` — uses badge ✅
- `runEvolve` → `telegram.notify()` — uses badge ✅

Each path must only read from the active mode's state file and DB (filtered by mode).

- [ ] **Step 6: Verify syntax**

```bash
node --check src/telegram/bot.js
```

- [ ] **Step 7: Commit**

```bash
git add src/telegram/bot.js
git commit -m "refactor: update Telegram bot for new mode system + verify no data leakage

All /mode switching now uses switchMode() which saves config, loads the
other file, and updates the watcher. Notification badge uses
getActiveMode(). All data paths verified to only read from active mode.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2.4: Migrate existing config.json to split files + update .gitignore

**Files:**
- Create: `config.paper.json`
- Create: `config.live.json`
- Modify: `.gitignore`
- Modify: `src/config.js` (already done in 2.1 — this task validates)

- [ ] **Step 1: Generate config.paper.json and config.live.json from current config.json**

```bash
# Manual: run the bot once with the migration code in place, or create manually
```

Since migration code is in Task 2.1, running the bot once will auto-migrate. Alternatively, create manually:

**config.paper.json** — paper trading config (conservative test settings):
```json
{
  "activeChain": "solana",
  "paper": { "startBalance": { "solana": 10, "robinhood": 1 } },
  "chains": {
    "solana": { "enabled": true, "type": "solana", "dexscreenerId": "solana", "gmgnSlug": "sol", "buyAmount": 0.04, "executor": "jupiter", "priorityFee": "auto" },
    "robinhood": { "enabled": false, "type": "evm", "dexscreenerId": "robinhood", "gmgnSlug": "robinhood", "chainIdNum": 4663, "rpcEnv": "ROBINHOOD_RPC_URL", "buyAmount": 0.04, "weth": "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", "v3SwapRouter02": "0xcaf681a66d020601342297493863e78c959e5cb2", "v3QuoterV2": "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7", "v2Router": "0x89e5db8b5aa49aa85ac63f691524311aeb649eba", "gasLimitSwap": 400000 }
  },
  "screener": { "intervalSec": 1800, "maxCandidatesPerCycle": 10, "sources": { "tokenProfiles": true, "boostsLatest": true, "boostsTop": true }, "filters": { "minVolume24hUsd": 10000, "minAgeMinutes": 120, "maxAgeHours": 168, "minLiquidityUsd": 15000, "minMarketCapUsd": 10000, "maxMarketCapUsd": 5000000, "minHolders": 100, "minTraders24h": 150, "minBuySellRatio": 0.9, "maxPriceDropH1Pct": 25, "minVolLiqRatio": 0.5, "requireSocials": false, "blockHoneypot": true, "maxTop10Pct": 70, "strictSecurity": false }, "entryGuard": { "enabled": true, "athPullbackPct": 30, "maxGainH1Pct": 150, "maxGainH24Pct": 400, "runThresholdPct": 200 } },
  "trading": { "slippageBps": 50, "maxPositions": 4, "maxPerChain": 2, "minSwapUsd": 1, "cooldownMinutes": 240, "stopLossPct": -20, "slFlashDropPct": 40, "priceMinLiquidityUsd": 300 },
  "tpLadder": [{ "gainPct": 100, "sellPct": 55 }],
  "trailing": { "enabled": true, "activateGainPct": 5, "trailPct": 3, "moonbagPct": 10 },
  "monitor": { "intervalSec": 10 },
  "darwin": { "enabled": true, "populationSize": 8, "evolveEveryNTrades": 50, "mutationRate": 0.35, "exploreRate": 0.25, "minTradesForFitness": 3 },
  "llm": { "enabled": true, "provider": "deepseek", "model": "deepseek-v4-flash", "gateBuy": true, "minConfidence": 0.35, "maxLessons": 12, "tools": true },
  "telegram": { "notifyScreening": true, "notifyPriceMoves": false, "statusIntervalMin": 30 }
}
```

**config.live.json** — same structure, potentially more conservative settings for live trading.

- [ ] **Step 2: Update .gitignore**

Add to `.gitignore`:
```
# Config lama (dimigrasi ke config.paper.json + config.live.json)
config.json
# Backup migrasi
config.json.migrated-*.bak
# Mode marker (ditentukan runtime)
data/.mode
```

- [ ] **Step 3: Verify both config files parse correctly**

```bash
node -e "JSON.parse(require('fs').readFileSync('config.paper.json','utf8')); console.log('paper OK')"
node -e "JSON.parse(require('fs').readFileSync('config.live.json','utf8')); console.log('live OK')"
```

- [ ] **Step 4: Commit**

```bash
git add config.paper.json config.live.json .gitignore
git commit -m "feat: split config into config.paper.json + config.live.json

Old config.json will be auto-migrated on first run. Mode marker
(data/.mode) determines which config is active. Both files committed
as templates; users edit per-mode settings independently.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Phase 3: Structural Refactors

### Task 3.1: Extract trade helpers from `index.js` → `src/trade/helpers.js`

**Files:**
- Modify: `src/trade/helpers.js` (expand, already has `effectiveMax`)
- Modify: `src/index.js`

**Interfaces:**
- Produces:
  - `resolveCandidate(chainKey, address)` → candidate object
  - `buyToken(chainKey, address, amountNative, source, candidate)` → position
  - `sellToken(address, pct)` → result
  - `effectiveMax(cfg)` → number (already done in 1.7)

**Context:** `index.js` lines 43-116 contain buy/sell helper logic that's independent of the orchestrator. Extract to `trade/helpers.js` so `index.js` is focused on wiring.

- [ ] **Step 1: Move buy/sell helpers to trade/helpers.js**

The three functions `resolveCandidate`, `buyToken`, `sellToken` (lines 43-116 in index.js) are moved.

`src/trade/helpers.js` additions:

```js
import { getConfig } from '../config.js';
import { findOpen, inCooldown, openPositions, addPosition, closePosition,
         recordPartialSell, findMoonbag, removeMoonbag, currentPnlPct } from '../positions/state.js';
import { tokenPairs, bestPair, normalizePair } from '../screener/dexscreener.js';
import { shortAddr } from '../utils.js';
import { createLogger } from '../logger.js';

const log = createLogger('trade');

export function effectiveMax(cfg) {
  const c = cfg || getConfig();
  return c.activeChain === 'both' ? c.trading.maxPositions : c.trading.maxPerChain;
}

export async function resolveCandidate(chainKey, address) {
  const cfg = getConfig();
  const dsId = cfg.chains[chainKey]?.dexscreenerId;
  if (!dsId) throw new Error(`chain ${chainKey} tidak dikenal/aktif`);
  const pairs = await tokenPairs(dsId, address);
  const pair = bestPair(pairs);
  if (!pair) throw new Error(`token ${address} tidak ditemukan di DexScreener`);
  return normalizePair(pair, chainKey);
}

export async function buyToken(chainKey, address, amountNative, source, candidate, executor, onTradeClosed) {
  const cfg = getConfig();
  if (cfg.activeChain !== 'both' && cfg.activeChain !== chainKey)
    throw new Error(`chain ${chainKey} nonaktif (activeChain=${cfg.activeChain})`);
  const c = candidate || (await resolveCandidate(chainKey, address));

  if (findOpen(chainKey, c.address)) throw new Error(`sudah ada posisi ${c.symbol}`);
  if (inCooldown(chainKey, c.address, cfg.trading.cooldownMinutes))
    throw new Error(`${c.symbol} masih cooldown`);
  const effMax = effectiveMax(cfg);
  if (openPositions().length >= effMax)
    throw new Error(`max posisi (${effMax}) tercapai`);
  const chainCount = openPositions().filter((p) => p.chain === chainKey).length;
  if (chainCount >= cfg.trading.maxPerChain)
    throw new Error(`maxPerChain ${chainKey} (${cfg.trading.maxPerChain}) tercapai`);

  const amount = amountNative;
  const res = await executor.buy(chainKey, c.address, amount, { labels: c.labels });
  const pos = addPosition({
    chain: chainKey,
    address: c.address,
    symbol: c.symbol,
    pairAddress: c.pairAddress,
    labels: c.labels,
    entryPrice: c.priceUsd,
    amountNative: res.spentNative,
    tokensRaw: res.tokensRaw,
    txid: res.txid,
    genomeId: c.genomeId || null,
    llmVerdict: c.llmVerdict || null,
  });
  log.info(`posisi dibuka [${source}]: ${c.symbol} @ ${c.priceUsd}`);
  return { ...pos, txid: res.txid };
}

export async function sellToken(address, pct, executor, onTradeClosed) {
  const pos = openPositions().find(
    (p) => p.address.toLowerCase() === address.toLowerCase()
  );
  if (pos) {
    const res = await executor.sell(pos.chain, pos.address, pct, { labels: pos.labels, fallbackPriceUsd: pos.currentPrice });
    if (pct >= 100) {
      const trade = closePosition(pos, { reason: 'manual sell', receivedNative: res.receivedNative, txid: res.txid });
      onTradeClosed(trade);
    } else {
      recordPartialSell(pos, { pctOfRemaining: pct, receivedNative: res.receivedNative, txid: res.txid });
    }
    return res;
  }
  const mb = findMoonbag(address);
  if (!mb) throw new Error(`tidak ada posisi/moonbag utk ${shortAddr(address)}`);
  const res = await executor.sell(mb.chain, mb.address, pct, { labels: mb.labels, fallbackPriceUsd: mb.currentPrice });
  if (pct >= 100) removeMoonbag(mb.id);
  else mb.moonPct = mb.moonPct * (1 - pct / 100);
  log.info(`moonbag sell ${pct}% ${mb.symbol} → ${res.receivedNative?.toFixed(6)} native`);
  return res;
}
```

- [ ] **Step 2: Update index.js to import from trade/helpers.js**

Replace lines 43-116 with imports:
```js
import { effectiveMax, resolveCandidate, buyToken, sellToken } from './trade/helpers.js';
```

Since `buyToken` and `sellToken` now take `executor` and `onTradeClosed` params, update call sites:

Line 390 (screening auto-buy):
```js
const pos = await buyToken(c.chain, c.address, undefined, 'screener', c, executor, onTradeClosed);
```

Line 331 (LLM tool buy):
```js
const pos = await buyToken(chain, args.address, args.amount, 'llm-tool', null, executor, onTradeClosed);
```

Line 334 (LLM tool sell):
```js
const res = await sellToken(args.address, args.pct ?? 100, executor, onTradeClosed);
```

Line 535 (Telegram /buy):
```js
const pos = await buyToken(chain, address, amount ? Number(amount) : undefined, 'manual', null, executor, onTradeClosed);
```

Line 544 (Telegram /sell):
```js
const res = await sellToken(args[0], pct, executor, onTradeClosed);
```

- [ ] **Step 3: Update Telegram constructor to not need buyToken/sellToken**

In `index.js`, update the Telegram constructor (line 354):
```js
const telegram = new Telegram({
  executor,
  darwin,
  llm,
  buyToken: (chain, addr, amt) => buyToken(chain, addr, amt, 'telegram-button', null, executor, onTradeClosed),
  sellToken: (addr, pct) => sellToken(addr, pct, executor, onTradeClosed),
  screenNow: () => screeningCycle(true),
  runEvolve,
  // ...
});
```

- [ ] **Step 4: Verify syntax**

```bash
node --check src/trade/helpers.js && node --check src/index.js
```

- [ ] **Step 5: Commit**

```bash
git add src/trade/helpers.js src/index.js
git commit -m "refactor: extract buyToken/sellToken/resolveCandidate to trade/helpers.js

index.js reduced from 571 to ~440 lines. Trade helpers are now in
a focused module with clear dependencies.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3.2: Extract `runEvolve` and `sendStatusReport` from `index.js`

**Files:**
- Create: `src/darwin/evolve.js`
- Create: `src/telegram/reports.js`
- Modify: `src/index.js`

**Interfaces:**
- `src/darwin/evolve.js`:
  - `export async function runEvolve(trigger, { darwin, llm, telegram, getConfig, recentTrades, GENE_SPACE })`
- `src/telegram/reports.js`:
  - `export async function sendStatusReport({ executor, telegram, getConfig, getActiveMode, openPositions, currentPnlPct, moonbags, tradeStatsByChain, chainHeader, tokenLink, fmtPct, fmtHold, fmtNative, nativeSym, effectiveMax })`

- [ ] **Step 1: Create `src/darwin/evolve.js`**

Move `runEvolve`, `fmtGene`, `geneDiffLines`, `onTradeClosed` (lines 118-220 from index.js) to this file.

```js
import { GENE_SPACE } from './darwin.js';
import { fmtPct } from '../utils.js';
import { createLogger } from '../logger.js';

const log = createLogger('evolve');

function fmtGene(v) {
  const n = Number(v);
  if (!isFinite(n)) return String(v);
  if (Math.abs(n) >= 1e6) return `${+(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
  return String(+n.toFixed(2));
}

function geneDiffLines(currentFilters, proposed) {
  const lines = [];
  for (const [name, val] of Object.entries(proposed || {})) {
    if (!(name in GENE_SPACE)) continue;
    const cur = currentFilters[name];
    const nv = Number(val);
    if (!isFinite(nv)) continue;
    if (cur != null && Math.abs(nv - cur) <= Math.abs(cur) * 0.01) continue;
    lines.push(`  • \`${name}\`: ${cur != null ? fmtGene(cur) : '—'} → *${fmtGene(nv)}*`);
  }
  return lines;
}

// ... full runEvolve function (lines 161-220 from index.js)
```

- [ ] **Step 2: Create `src/telegram/reports.js`**

Move `sendStatusReport`, `nativeSymbol`, `startStatusLoop`, `statusTimer` (lines 448-518 from index.js).

- [ ] **Step 3: Update index.js imports**

```js
import { runEvolve, onTradeClosed } from './darwin/evolve.js';
import { sendStatusReport, startStatusLoop } from './telegram/reports.js';
```

- [ ] **Step 4: Verify syntax**

```bash
node --check src/darwin/evolve.js && node --check src/telegram/reports.js && node --check src/index.js
```

- [ ] **Step 5: Commit**

```bash
git add src/darwin/evolve.js src/telegram/reports.js src/index.js
git commit -m "refactor: extract runEvolve → darwin/evolve.js, sendStatusReport → telegram/reports.js

index.js now ~250 lines, focused on wiring + loop coordination.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3.3: Refactor Telegram bot command handlers into registry pattern

**Files:**
- Create: `src/telegram/commands/index.js`
- Create: `src/telegram/commands/status.js`
- Create: `src/telegram/commands/trading.js`
- Create: `src/telegram/commands/config.js`
- Create: `src/telegram/commands/darwin.js`
- Create: `src/telegram/commands/system.js`
- Modify: `src/telegram/bot.js`

**Interfaces:**
- Each command module exports an object: `{ [commandName]: handlerFunction }`
- `commands/index.js` exports `buildRegistry(deps)` → `Map<string, handler>`
- `handler: async (args, msg) => void` — sends response via `deps.send()`

- [ ] **Step 1: Create `src/telegram/commands/index.js` — registry builder**

```js
import * as statusCmds from './status.js';
import * as tradingCmds from './trading.js';
import * as configCmds from './config.js';
import * as darwinCmds from './darwin.js';
import * as systemCmds from './system.js';

/**
 * Build command registry: Map<commandName, handlerFunction>
 * Each handler: async (args: string[], msg: TelegramMessage, deps: object) => void
 */
export function buildRegistry(deps) {
  const all = { ...statusCmds, ...tradingCmds, ...configCmds, ...darwinCmds, ...systemCmds };
  const registry = new Map();
  for (const [name, fn] of Object.entries(all)) {
    // Bind deps so handlers don't need to access closure
    registry.set(name, (args, msg) => fn(args, msg, deps));
  }
  return registry;
}
```

- [ ] **Step 2: Create `src/telegram/commands/status.js`**

Extract `/status`, `/positions`, `/stats` handlers from bot.js.

- [ ] **Step 3: Create `src/telegram/commands/trading.js`**

Extract `/buy`, `/sell`, `/closeall`, `/screen`, `/pause`, `/resume` handlers.

- [ ] **Step 4: Create `src/telegram/commands/config.js`**

Extract `/config`, `/get`, `/set`, `/mode`, `/menu` handlers + callback handler.

- [ ] **Step 5: Create `src/telegram/commands/darwin.js`**

Extract `/darwin`, `/evolve`, `/lessons` handlers.

- [ ] **Step 6: Create `src/telegram/commands/system.js`**

Extract `/help`, `/start`, `/logs`, `/stop`, `/papertrades`, `/paperreset` handlers.

- [ ] **Step 7: Update `bot.js` to use command registry**

Replace the large switch-case in `_onMessage` (lines 433-680) with:

```js
async _onMessage(msg) {
  if (!msg.text || !this._authorized(msg)) return;
  const [cmd, ...args] = msg.text.trim().split(/\s+/);
  const name = cmd.split('@')[0];

  // Command registry lookup
  const handler = this._commands.get(name);
  if (handler) {
    return handler(args, msg).catch((e) => {
      log.error(`command ${name} error:`, e.message);
      this._send(`⚠️ Error: ${e.message}`);
    });
  }

  // Not a command — try address lookup, name search, or LLM chat
  // ... (keep existing fallback logic from lines 656-679)
}
```

Initialize registry in constructor:
```js
this._commands = buildRegistry(this.deps);
```

- [ ] **Step 8: Verify all syntax**

```bash
for f in src/telegram/commands/*.js; do node --check "$f" || break; done
node --check src/telegram/bot.js
```

- [ ] **Step 9: Commit**

```bash
git add src/telegram/commands/ src/telegram/bot.js
git commit -m "refactor: extract Telegram command handlers into registry pattern

bot.js reduced from 683 to ~350 lines. Each command group lives in
its own file under telegram/commands/. New commands can be added
by creating a handler and exporting it — no switch-case editing.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Phase 4: Reliability Improvements

### Task 4.1: Add trade circuit breaker

**Files:**
- Create: `src/trade/circuit-breaker.js`
- Modify: `src/index.js` (wire into buy/sell paths)

**Interfaces:**
- `export class CircuitBreaker` — tracks rapid open/close events
- `breaker.check(chainKey)` → throws if tripped
- `breaker.recordOpen(chainKey)`, `breaker.recordClose(chainKey)`
- Config: max 3 positions opened within 60 seconds trips breaker for 300 seconds

- [ ] **Step 1: Create `src/trade/circuit-breaker.js`**

```js
import { createLogger } from '../logger.js';
const log = createLogger('breaker');

const MAX_OPENS_PER_WINDOW = 3;
const WINDOW_MS = 60_000;       // 1 minute
const COOLDOWN_MS = 300_000;    // 5 minute trip

export class CircuitBreaker {
  constructor() {
    this._opens = [];        // timestamps of position opens
    this._trippedUntil = null;
  }

  check(chainKey) {
    if (this._trippedUntil && Date.now() < this._trippedUntil) {
      const remaining = Math.ceil((this._trippedUntil - Date.now()) / 1000);
      throw new Error(`Circuit breaker aktif — terlalu banyak posisi dibuka. Coba lagi dalam ${remaining}s.`);
    }
  }

  recordOpen(chainKey) {
    const now = Date.now();
    this._opens.push(now);
    // Prune old entries outside window
    this._opens = this._opens.filter((t) => now - t < WINDOW_MS);
    if (this._opens.length > MAX_OPENS_PER_WINDOW) {
      this._trippedUntil = now + COOLDOWN_MS;
      log.warn(`Circuit breaker TRIPPED! ${this._opens.length} opens in ${WINDOW_MS / 1000}s. Cooldown ${COOLDOWN_MS / 1000}s.`);
    }
  }

  recordClose(chainKey) {
    // Reset trip on successful close
    if (this._trippedUntil && Date.now() >= this._trippedUntil) {
      this._trippedUntil = null;
      this._opens = [];
      log.info('Circuit breaker reset — cooldown selesai.');
    }
  }

  status() {
    const recent = this._opens.filter((t) => Date.now() - t < WINDOW_MS).length;
    return {
      recentOpens: recent,
      maxPerWindow: MAX_OPENS_PER_WINDOW,
      tripped: Boolean(this._trippedUntil && Date.now() < this._trippedUntil),
      remainingSeconds: this._trippedUntil ? Math.max(0, Math.ceil((this._trippedUntil - Date.now()) / 1000)) : 0,
    };
  }
}
```

- [ ] **Step 2: Wire breaker into index.js**

```js
import { CircuitBreaker } from './trade/circuit-breaker.js';
const breaker = new CircuitBreaker();

// In buyToken call chain, before buy:
breaker.check(chainKey);
// ... buy ...
breaker.recordOpen(chainKey);

// In onTradeClosed:
breaker.recordClose(trade.chain);
```

- [ ] **Step 3: Verify syntax + commit**

```bash
node --check src/trade/circuit-breaker.js && node --check src/index.js
git add src/trade/circuit-breaker.js src/index.js
git commit -m "feat: add trade circuit breaker

Trips when >3 positions opened within 60 seconds. 5-minute cooldown.
Prevents runaway trading loops from draining balance.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4.2: Add gas fee simulation to paper mode

**Files:**
- Modify: `src/trade/paper.js`

**Interfaces:**
- Consumes: `chainCfg.type` to determine gas token
- Produces: buy/sell deduct simulated gas fee from paper balance

- [ ] **Step 1: Add gas fee deduction to PaperChain buy/sell**

```js
// In PaperChain class, add gas fee constants:
const GAS_FEE_NATIVE = {
  solana: 0.000005,  // ~5000 lamports per swap
  evm: 0.0001,       // ~$0.30 at $3000/ETH
};

// In buy():
const gasFee = GAS_FEE_NATIVE[this.cfg.type] || 0;
paperAdjustBalance(this.key, -(amountNative + gasFee));
log.info(`BUY [paper:${this.key}] ${tokenAddress.slice(0, 8)} ${amountNative} + ${gasFee} gas → ${tokens.toFixed(2)} token`);

// In sell():
const gasFee = GAS_FEE_NATIVE[this.cfg.type] || 0;
// Gas is already deducted from gotNative before crediting
paperAdjustBalance(this.key, receivedNative - gasFee);
```

- [ ] **Step 2: Verify syntax + commit**

```bash
node --check src/trade/paper.js
git add src/trade/paper.js
git commit -m "feat: add gas fee simulation to paper mode

Paper trading now deducts estimated gas fees (SOL: ~0.000005, ETH: ~0.0001)
per swap, making paper PnL more realistic vs live trading.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Implementation Order

1. **Phase 1** (Tasks 1.1–1.7): Critical/high bug fixes — apply sequentially, each independently testable
2. **Phase 2** (Tasks 2.1–2.4): Mode separation — must be applied as a block; config migration is one-time
3. **Phase 3** (Tasks 3.1–3.3): Structural refactors — apply after Phase 2 is stable
4. **Phase 4** (Tasks 4.1–4.2): Reliability — apply last, additive features

Each task ends with a commit. Run `node --check` on every modified file before committing.

---

## Verification After All Phases

- [ ] `node --check src/index.js` passes
- [ ] `node src/index.js --screen-once` runs, scans tokens, prints results, exits
- [ ] Both `config.paper.json` and `config.live.json` exist and are valid JSON
- [ ] `data/.mode` file exists with current mode
- [ ] `data/positions.paper.json` and `data/positions.live.json` are separate
- [ ] All Telegram notifications include mode badge
- [ ] Switching mode via `/mode` preserves config and state per mode
- [ ] `grep -r "cfg.mode" src/` returns zero results (mode is external)
