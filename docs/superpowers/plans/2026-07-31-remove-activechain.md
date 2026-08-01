# Remove `activeChain` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the redundant `activeChain` concept and use only `chains.<key>.enabled` as the single source of truth for which chains are active.

**Architecture:** 8 files touched. `activeChain` field removed from config defaults and both config files. Gate logic in screener, helpers, and menu commands simplified from dual-condition (`activeChain` + `enabled`) to single-condition (`enabled` only). Menu UI unchanged (radio-button style preserved) but indicators and actions now read/write `chains.*.enabled` instead of `activeChain`.

**Tech Stack:** Node.js, no new dependencies

## Global Constraints

- No breaking changes to Telegram bot UX (menu still uses radio-button style)
- Config backward compatibility: old config files with `activeChain` field are harmless (field ignored)
- State files (`positions.*.json`) unchanged — already mode-separated
- Must pass `node --check` (syntax valid) on all changed files

---

### Task 1: Remove `activeChain` from DEFAULTS in config.js

**Files:**
- Modify: `src/config.js:44-48`

**Interfaces:**
- Produces: DEFAULTS object without `activeChain` key

- [ ] **Step 1: Remove `activeChain` line from DEFAULTS**

In `src/config.js`, remove line 48:
```js
activeChain: 'both',
```

The DEFAULTS block starting around line 44 should go from:
```js
export const DEFAULTS = {
  // 'paper' = trade simulasi penuh ...
  // 'live'  = transaksi on-chain sungguhan
  // Mode TIDAK disimpan di sini — dibaca dari data/.mode marker file.
  activeChain: 'both',
  paper: {
```
to:
```js
export const DEFAULTS = {
  // 'paper' = trade simulasi penuh ...
  // 'live'  = transaksi on-chain sungguhan
  // Mode TIDAK disimpan di sini — dibaca dari data/.mode marker file.
  paper: {
```

- [ ] **Step 2: Verify syntax**

Run: `node --check src/config.js`
Expected: no output (exit 0)

- [ ] **Step 3: Commit**

```bash
git add src/config.js
git commit -m "refactor: remove activeChain from DEFAULTS in config.js

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Remove `activeChain` from config files

**Files:**
- Modify: `config.paper.json`
- Modify: `config.live.json`

- [ ] **Step 1: Remove from config.paper.json**

In `config.paper.json`, remove line 2:
```json
"activeChain": "both",
```
The file starts at:
```json
{
  "activeChain": "both",
  "paper": {
```
becomes:
```json
{
  "paper": {
```

- [ ] **Step 2: Remove from config.live.json**

In `config.live.json`, remove line 2:
```json
"activeChain": "solana",
```
The file starts at:
```json
{
  "activeChain": "solana",
  "paper": {
```
becomes:
```json
{
  "paper": {
```

- [ ] **Step 3: Verify both files are valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('config.paper.json','utf8')); console.log('paper OK')"`
Run: `node -e "JSON.parse(require('fs').readFileSync('config.live.json','utf8')); console.log('live OK')"`
Expected: "paper OK" then "live OK"

- [ ] **Step 4: Commit**

```bash
git add config.paper.json config.live.json
git commit -m "refactor: remove activeChain field from config.paper.json and config.live.json

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Simplify screener chainMap to use only `c.enabled`

**Files:**
- Modify: `src/screener/screener.js:84-89`

**Interfaces:**
- Consumes: `cfg.chains` (each entry has `.enabled` boolean, `.dexscreenerId` string)
- Produces: `chainMap` (same shape as before: `{ dexscreenerId: chainKey }`)

- [ ] **Step 1: Replace dual-gate with single `c.enabled` check**

In `src/screener/screener.js`, replace lines 84-89:
```js
  // chainMap: dexscreenerId → chainKey (hanya chain enabled + sesuai activeChain)
  const chainMap = {};
  for (const [key, c] of Object.entries(cfg.chains)) {
    const active = cfg.activeChain === 'both' || cfg.activeChain === key;
    if (c.enabled && active) chainMap[c.dexscreenerId] = key;
  }
```
with:
```js
  // chainMap: dexscreenerId → chainKey (hanya chain yang enabled)
  const chainMap = {};
  for (const [key, c] of Object.entries(cfg.chains)) {
    if (c.enabled) chainMap[c.dexscreenerId] = key;
  }
```

- [ ] **Step 2: Verify syntax**

Run: `node --check src/screener/screener.js`
Expected: no output (exit 0)

- [ ] **Step 3: Commit**

```bash
git add src/screener/screener.js
git commit -m "refactor: simplify screener chainMap to use only chains.*.enabled

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Update trade helpers — buyToken gate + effectiveMax

**Files:**
- Modify: `src/trade/helpers.js:11-13` (effectiveMax)
- Modify: `src/trade/helpers.js:28-29` (buyToken gate)

**Interfaces:**
- Consumes: `cfg.chains` (each entry has `.enabled` boolean)
- Produces: `effectiveMax(cfg)` returns number; `buyToken()` throws or continues

- [ ] **Step 1: Rewrite `effectiveMax()` to count enabled chains**

In `src/trade/helpers.js`, replace lines 11-13:
```js
export function effectiveMax(cfg) {
  const c = cfg || getConfig();
  return c.activeChain === 'both' ? c.trading.maxPositions : c.trading.maxPerChain;
}
```
with:
```js
export function effectiveMax(cfg) {
  const c = cfg || getConfig();
  const enabledCount = Object.values(c.chains).filter(ch => ch.enabled).length;
  return enabledCount > 1 ? c.trading.maxPositions : c.trading.maxPerChain;
}
```

- [ ] **Step 2: Rewrite `buyToken()` chain gate**

In `src/trade/helpers.js`, replace lines 28-29:
```js
  if (cfg.activeChain !== 'both' && cfg.activeChain !== chainKey)
    throw new Error(`chain ${chainKey} nonaktif (activeChain=${cfg.activeChain})`);
```
with:
```js
  if (!cfg.chains[chainKey]?.enabled)
    throw new Error(`chain ${chainKey} nonaktif`);
```

- [ ] **Step 3: Verify syntax**

Run: `node --check src/trade/helpers.js`
Expected: no output (exit 0)

- [ ] **Step 4: Commit**

```bash
git add src/trade/helpers.js
git commit -m "refactor: replace activeChain checks with chains.*.enabled in helpers

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Update executor stale comment

**Files:**
- Modify: `src/trade/executor.js:53-56`

- [ ] **Step 1: Update the stale comment in `syncMode()`**

In `src/trade/executor.js`, replace lines 53-56:
```js
    // Selalu rebuild — constructor murah (hanya buat PaperChain/Map).
    // Guard mode-only akan melewatkan rebuild ketika chains.*.enabled berubah via
    // /set atau menu callback (activeChain 'both' tapi chain masih disabled).
    this._build();
```
with:
```js
    // Selalu rebuild — constructor murah (hanya buat PaperChain/Map).
    // Perubahan chains.*.enabled via /set atau menu callback langsung
    // diterapkan tanpa perlu restart.
    this._build();
```

- [ ] **Step 2: Verify syntax**

Run: `node --check src/trade/executor.js`
Expected: no output (exit 0)

- [ ] **Step 3: Commit**

```bash
git add src/trade/executor.js
git commit -m "chore: update stale activeChain comment in executor syncMode

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Update menu chain indicators + toggle actions

**Files:**
- Modify: `src/telegram/commands/config.js:56-58` (menuKeyboard indicators)
- Modify: `src/telegram/commands/config.js:161-176` (handleMenuCallback chain case)

- [ ] **Step 1: Replace menu indicators to read `chains.*.enabled`**

In `src/telegram/commands/config.js`, replace lines 56-58:
```js
      { text: `${mark(cfg.activeChain === 'solana')}🟪 solana`, callback_data: 'm:chain:solana' },
      { text: `${mark(cfg.activeChain === 'robinhood')}🟩 robinhood`, callback_data: 'm:chain:robinhood' },
      { text: `${mark(cfg.activeChain === 'both')}both`, callback_data: 'm:chain:both' },
```
with:
```js
      { text: `${mark(cfg.chains.solana?.enabled && cfg.chains.robinhood?.enabled)}both`, callback_data: 'm:chain:both' },
      { text: `${mark(cfg.chains.solana?.enabled && !cfg.chains.robinhood?.enabled)}🟪 solana`, callback_data: 'm:chain:solana' },
      { text: `${mark(!cfg.chains.solana?.enabled && cfg.chains.robinhood?.enabled)}🟩 robinhood`, callback_data: 'm:chain:robinhood' },
```

- [ ] **Step 2: Simplify chain toggle to only touch `chains.*.enabled`**

In `src/telegram/commands/config.js`, replace lines 161-176:
```js
    case 'chain':
      // Toggle per-chain enabled flags sesuai pilihan, bukan hanya activeChain.
      // activeChain hanya memfilter di antara chain yg sudah enabled;
      // tanpa ini, klik 'both' tidak mengaktifkan chain yg disabled.
      if (arg === 'both') {
        setPath('chains.solana.enabled', true);
        setPath('chains.robinhood.enabled', true);
      } else if (arg === 'solana') {
        setPath('chains.solana.enabled', true);
        setPath('chains.robinhood.enabled', false);
      } else if (arg === 'robinhood') {
        setPath('chains.solana.enabled', false);
        setPath('chains.robinhood.enabled', true);
      }
      setPath('activeChain', arg);
      return editMenu('main', `Chain → ${arg}`);
```
with:
```js
    case 'chain':
      // Toggle per-chain enabled flags. chains.*.enabled adalah
      // satu-satunya kontrol untuk menentukan chain mana yang aktif.
      if (arg === 'both') {
        setPath('chains.solana.enabled', true);
        setPath('chains.robinhood.enabled', true);
      } else if (arg === 'solana') {
        setPath('chains.solana.enabled', true);
        setPath('chains.robinhood.enabled', false);
      } else if (arg === 'robinhood') {
        setPath('chains.solana.enabled', false);
        setPath('chains.robinhood.enabled', true);
      }
      return editMenu('main', `Chain → ${arg}`);
```

- [ ] **Step 3: Verify syntax**

Run: `node --check src/telegram/commands/config.js`
Expected: no output (exit 0)

- [ ] **Step 4: Commit**

```bash
git add src/telegram/commands/config.js
git commit -m "refactor: menu chain toggle uses chains.*.enabled instead of activeChain

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Update botContext in index.js

**Files:**
- Modify: `src/index.js:59`

- [ ] **Step 1: Replace `cfg.activeChain` with enabled chain list**

In `src/index.js`, replace line 59:
```js
    `mode=${getActiveMode()}, activeChain=${cfg.activeChain}, screening tiap ${cfg.screener.intervalSec}s, monitor tiap ${cfg.monitor.intervalSec}s\n` +
```
with:
```js
    `mode=${getActiveMode()}, chains: ${Object.entries(cfg.chains).filter(([,c]) => c.enabled).map(([k]) => k).join(', ') || '(none)'}, screening tiap ${cfg.screener.intervalSec}s, monitor tiap ${cfg.monitor.intervalSec}s\n` +
```

- [ ] **Step 2: Verify syntax**

Run: `node --check src/index.js`
Expected: no output (exit 0)

- [ ] **Step 3: Commit**

```bash
git add src/index.js
git commit -m "refactor: replace activeChain with enabled chain list in botContext

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Final verification

- [ ] **Step 1: Verify all changed files pass syntax check**

Run: `for f in src/config.js src/screener/screener.js src/trade/helpers.js src/trade/executor.js src/telegram/commands/config.js src/index.js; do echo "=== $f ===" && node --check "$f" || exit 1; done`
Expected: each file reports no errors

- [ ] **Step 2: Verify no remaining `activeChain` references in src/**

Run: `grep -rn "activeChain" src/ --include="*.js" | grep -v node_modules`
Expected: no output (all references removed)

- [ ] **Step 3: Verify config files parse correctly with new code**

Run: `node -e "
const fs = require('fs');
const paper = JSON.parse(fs.readFileSync('config.paper.json','utf8'));
const live = JSON.parse(fs.readFileSync('config.live.json','utf8'));
console.log('paper chains:', Object.keys(paper.chains).filter(k => paper.chains[k].enabled).join(', '));
console.log('live chains:', Object.keys(live.chains).filter(k => live.chains[k].enabled).join(', '));
console.log('paper has activeChain:', 'activeChain' in paper);
console.log('live has activeChain:', 'activeChain' in live);
"`
Expected: paper chains includes both, live chains includes both, neither has activeChain

- [ ] **Step 4: Commit verification**

```bash
git add -A
git commit -m "verify: no remaining activeChain references, all files valid

Co-Authored-By: Claude <noreply@anthropic.com>"
```
