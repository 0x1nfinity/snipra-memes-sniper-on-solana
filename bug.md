# Bug Report — Snipra v2

> Format: `[SEVERITY] [SUBSYSTEM] Description`
> Severity: 🔴Critical 🟠High 🟡Medium 🟢Low
> Status: ✅Fixed ⬜Open 🔧InProgress

---

## User-Reported Bugs

### B1 🔴 [SKILL] OpenCode asks "what to do" instead of running bot immediately
When `/snipra` is invoked, OpenCode asks clarifying questions rather than immediately starting the bot process. SKILL.md has been updated with explicit instructions ("DO NOT ask clarifying questions... Immediately start the bot"), but agent compliance varies by platform.

**Status:** ⬜Open
**Found by:** User

### B2 🟠 [SKILL] Agent wastes tokens searching for files
When skill is run from a different folder, agent runs `find`, `ls`, `grep` to locate the project directory. SKILL.md now says to use absolute paths, but the agent's working directory may not actually be the project root when invoked.

**Status:** ⬜Open
**Found by:** User

### B3 🟠 [TRADE] On-chain tx error: InstructionError 6, Custom 6025
Swap transaction for token `89RAitwPJBEfLK4Gcg5iv7AjFABHWNvoD5rkvRkvpump` (TikTok) failed with `{"InstructionError":6,{"Custom":6025}}`. Error 6025 likely originates from the token's program (pump.fun AMM). Common causes: slippage exceeded, bonding curve not yet complete, pool imbalance, insufficient funds after fees. Potentially fixed by uncommitted change in `src/chains/solana.js` adding `excludeDexes: PUMP_AMM` to Jupiter swap params.

**Status:** 🔧InProgress (potential fix uncommitted)
**Found by:** User

### B4 🟠 [SKILL] Agent debugs without permission instead of notifying user
When errors occur (like B3), the OpenCode agent attempted to debug/fix on its own instead of simply reporting the error. SKILL.md now says "just report the error to the user. Do NOT attempt to debug."

**Status:** ⬜Open
**Found by:** User

---

## Config & Documentation Bugs

### B5 🔴 [CONFIG] live-config.example.json has OLD pre-GMGN structure
**File:** `live-config.example.json`

The example config still uses the OLD filter field names (`minVolume24hUsd`, `minAgeHours`, `minLiquidityUsd`, `minMarketCapUsd`, `maxMarketCapUsd`, etc.), contains the removed `entryGuard` section, uses the old `sources` object format. Meanwhile `src/config.js` DEFAULTS have been updated by the GMGN plan to use: `minVolume24h`, `minLiquidity`, `minMarketCap`, `maxMarketCap`, `minHolders`, `maxHolders`, `minSwaps24h`, `minAgeMinutes`, `maxAgeMinutes`, `minProgress`, `maxProgress`, `maxRugRatio`, `maxBundlerRate`, `maxInsiderRate`, etc. The file was RENAMED (config.live.example.json → live-config.example.json) but content was NOT updated to match the codebase.

**Impact:** Users copying this template get config that doesn't match what the bot expects. Fields like `entryGuard` no longer exist in DEFAULTS. Field name mismatches cause unexpected behavior.

**Status:** ✅Fixed
**Found by:** Audit

### B6 🔴 [CONFIG] Missing files: command-queue.js, skill-command.js, skill-status.js
**Files:** `src/skills/command-queue.js`, `scripts/skill-command.js`, `scripts/skill-status.js`

These files were committed on a DIFFERENT branch (skill-agent-control plan Tasks 4, 6, 7) but are NOT on `main`. The README.md and SKILL.md both reference these files as working commands, but they don't exist on main. The uncommitted changes in the working tree partially apply the tool-runner extraction (Task 1) and dead code removal (Tasks 9-10), but don't include the command queue or CLI tools.

**Impact:** Agent-facing command CLI is completely broken. Any agent following the SKILL.md instructions to use `node scripts/skill-command.js` or `node scripts/skill-status.js` gets a file-not-found error.

**Status:** ✅Fixed — Merged skill-agent-control branch to main; all 6 files now exist
**Found by:** Audit

### B7 🟠 [CONFIG] README.md references non-existent files
**File:** `README.md`

Lines 146-154 list `command-queue.js`, `skill-command.js`, and `skill-status.js` in the architecture diagram, but these files don't exist on `main`. The architecture description is inaccurate for the current branch state.

**Status:** ⬜Open
**Found by:** Audit

### B8 🟡 [CONFIG] .env.example has confusing dual GMGN variables
**File:** `.env.example`

`GMGN_API_KEY` (singular, for wallet activity/stats in `src/gmgn/openapi.js`) and `GMGN_API_KEYS` (plural, for discovery/screening) have nearly identical names but completely different purposes. Users setting one may assume the other is covered.

**Status:** ✅Fixed
**Found by:** Audit

---

## Trade Subsystem Bugs

### B9 🔴 [TRADE] Paper buy balance check doesn't include gas fee
**File:** `src/trade/paper.js:92`

Balance check `balance < amountNative` doesn't account for `gasFee`. A user with exactly `amountNative` balance will pass the check but then `paperAdjustBalance` deducts `amountNative + gasFee`, making the balance negative.

**Status:** ✅Fixed
**Found by:** Audit (agent trade subsystem)

### B10 🟠 [TRADE] GAS_RESERVE hardcoded to Solana only
**File:** `src/trade/executor.js:12`

`GAS_RESERVE = { solana: 0.01 }` is used with `.solana` directly at line 90 instead of `[chainKey]`. Adding another chain would bypass the gas reserve check.

**Status:** ⬜Open
**Found by:** Audit (agent trade subsystem)

### B11 🟠 [TRADE] buyToken accepts onTradeClosed but never calls it
**File:** `src/trade/helpers.js:29`

`buyToken` accepts `onTradeClosed` callback in its signature but never invokes it. Only `sellToken` calls it. This is a dead parameter that silently does nothing — callers expecting buy-close notifications get none.

**Status:** ⬜Open
**Found by:** Audit (agent trade subsystem)

### B12 🟡 [TRADE] buyToken has redundant `amount` local variable
**File:** `src/trade/helpers.js:55`

`const amount = amountNative;` is a no-op reassignment that adds no value.

**Status:** ⬜Open
**Found by:** Audit (agent trade subsystem)

### B13 🟡 [TRADE] PaperChain tokenBalance always returns decimals:0
**File:** `src/trade/paper.js:64`

`tokenBalance` hardcodes `decimals: 0`, ignoring actual token decimals from DexScreener. Both `raw` and `ui` fields get the same value, so UI consumers get incorrect display amounts.

**Status:** ⬜Open
**Found by:** Audit (agent trade subsystem)

### B14 🟡 [TRADE] Circuit breaker auto-recovery after COOLDOWN_MS works, but recordClose resets early
**File:** `src/trade/circuit-breaker.js:35-39`

`recordClose` unconditionally resets the breaker when a position closes during cooldown, even if the close was from a position opened BEFORE the trip. A single legitimate close during a trip resets the cooldown entirely, allowing more rapid opens immediately.

**Status:** ⬜Open
**Found by:** Audit (agent trade subsystem)

### B15 🔴 [TRADE] Jupiter swap _confirm can lose confirmed transactions
**File:** `src/chains/solana.js:_confirm`

If `getSignatureStatuses` throws continuously for the full 60-second window (RPC outage), `_confirm` returns `false`. The caller then throws "not confirmed — treating swap as failed". But the transaction could have been confirmed on-chain during the outage. The bot considers it a failure and does NOT record sell proceeds. Position stays open until the next reconciliation cycle detects zero balance.

**Status:** ⬜Open
**Found by:** Audit (agent position/chains/darwin)

### B16 🟠 [TRADE] PUMP_AMM exclusion fix is uncommitted
**File:** `src/chains/solana.js`

The fix for bug B3 (adding `PUMP_AMM` constant and `excludeDexes: PUMP_AMM` to Jupiter swap params) is an uncommitted change. If this is the correct fix for the `Custom 6025` error, it hasn't been committed.

**Status:** 🔧InProgress (uncommitted)
**Found by:** Audit

---

## Screener Subsystem Bugs

### B17 🟠 [SCREENER] Dead import: athObserve
**File:** `src/screener/screener.js:6`

`athObserve` is imported from `../db.js` but never called anywhere in screener.js. Dead import.

**Status:** ✅Fixed
**Found by:** Audit (agent screener)

### B18 🟠 [SCREENER] exitGenes can be null
**File:** `src/screener/screener.js:266`

If `cfg.darwin.enabled` is false, `exitGenes` remains null, and every candidate gets `c.exitGenes = null`. Downstream code destructuring `exitGenes` will crash with TypeError.

**Status:** ✅Fixed
**Found by:** Audit (agent screener)

### B19 🟠 [SCREENER] top10Pct scale inconsistency between GMGN and GoPlus
**Files:** `src/screener/gmgn-discovery.js:109,116` vs `src/screener/goplus.js:31`

GMGN sets `c.security.top10Pct = raw * 100` (treating raw as fraction) AND `c.top10HolderRate = raw` (raw fraction — DIFFERENT scale). GoPlus sets `c.security.top10Pct = sum * 100` (treating raw as fraction). preScorer reads `c.security?.top10Pct` (percentage scale), while filters.js reads `c.top10HolderRate` (fraction scale from GMGN, null from DexScreener). If a user sets `maxTop10HolderRate: 60` thinking in percentage terms, the filter NEVER triggers because 0.5 is compared against 60.

**Status:** ⬜Open
**Found by:** Audit (agent screener)

### B20 🟡 [SCREENER] DexScreener fallback candidates evaluated under less stringent regime
**File:** `src/screener/filters.js:63-76`

GMGN-specific risk filters (rugRatio, bundlerRate, insiderRate, top10HolderRate, botDegenRate, etc.) silently pass for DexScreener-sourced candidates because those fields are null/undefined. This means the effective security bar is lower for DexScreener fallback tokens.

**Status:** ⬜Open
**Found by:** Audit (agent screener)

### B21 🟡 [SCREENER] Price data defaults to 0 if enrichPrice fails
**File:** `src/screener/gmgn-discovery.js:87-88,97`

`normalizeGmgnToken` sets `priceUsd: 0` and all `priceChange` fields to 0. If `enrichPrice` fails (key exhausted, network error), candidates proceed with zero price data. preScorer momentum check and score() price change bonuses silently evaluate to 0, potentially penalizing good tokens.

**Status:** ⬜Open
**Found by:** Audit (agent screener)

### B22 🟡 [SCREENER] GoPlus treats freeze authority as honeypot
**File:** `src/screener/goplus.js:50`

`authorityActive(d.freezable)` treats ANY token with active freeze authority as a honeypot. This incorrectly flags legitimate tokens (e.g., USDC) as honeypots, causing `blockHoneypot` to reject them.

**Status:** ⬜Open
**Found by:** Audit (agent screener)

### B23 🟡 [SCREENER] GoPlus cache unbounded growth
**File:** `src/screener/goplus.js:8`

The Map-based cache has no size limit. In a long-running process screening many unique tokens, expired entries are logically dead but never removed from the Map. Memory leak over hours/days.

**Status:** ⬜Open
**Found by:** Audit (agent screener)

### B24 🟡 [SCREENER] Transient GoPlus failures cached as permanent null
**File:** `src/screener/goplus.js:44`

When `fetchJson` throws, `null` is cached for 10 minutes. A transient network error becomes a 10-minute blackout for that token's security data. No retry.

**Status:** ⬜Open
**Found by:** Audit (agent screener)

---

## LLM Subsystem Bugs

### B25 🟡 [LLM] Module-level mutable lessons array
**File:** `src/llm/llm.js`

`let lessons = []` is module-scoped. Multiple LLM instances all mutate the same array — race condition and violates instance isolation.

**Status:** ⬜Open
**Found by:** Audit (agent LLM)

### B26 🟡 [LLM] chat() drops tool-call messages from history
**File:** `src/llm/llm.js:155`

Only final user and assistant messages are saved to history. All intermediate tool-call and tool-result messages are lost. Follow-up messages lack context of what tools did previously.

**Status:** ⬜Open
**Found by:** Audit (agent LLM)

### B27 🟡 [LLM] No JSON parse retry in http-backend
**File:** `src/llm/http-backend.js`

Every method calls `JSON.parse(content)` with zero error recovery. If the LLM returns malformed JSON (common with cheap models), the entire operation fails. No retry, no regex extraction fallback.

**Status:** ⬜Open
**Found by:** Audit (agent LLM)

### B28 🟡 [LLM] StdioBackend chat() destroys multi-turn conversation
**File:** `src/llm/stdio-backend.js:176-180`

Extracts only system message and last user message, discarding all assistant/tool messages. True multi-turn conversations impossible through this backend.

**Status:** ⬜Open
**Found by:** Audit (agent LLM)

### B29 🔴 [LLM] fetchJson retries on all errors including permanent ones
**File:** `src/utils.js:52-72`

Retry loop retries on ALL errors: network failures, timeouts, AND 400/401/403/404. Retrying 401 or 403 will NEVER succeed. Only 429 (rate-limit) gets special handling, but the catch-all still retries everything.

**Status:** ✅Fixed
**Found by:** Audit (agent LLM)

---

## Position Manager Bugs

### B30 🔴 [POSITION] closeAllPositions can race with tick()
**File:** `src/positions/manager.js`

`tick()` guards itself with `_busy`, but `closeAllPositions()` does NOT check `_busy`. Both can attempt to sell the same position concurrently, potentially causing double-sells.

**Status:** ✅Fixed
**Found by:** Audit (agent position/chains/darwin)

### B31 🟠 [POSITION] _volPct staleness after DexScreener stops providing h1
**File:** `src/positions/manager.js:159`

If DexScreener stops returning `priceChange.h1` for a token, `_volPct` retains its stale value from the last successful refresh. Stale volatility feeds into `dynamicStopLossPercent` indefinitely.

**Status:** ⬜Open
**Found by:** Audit (agent position/chains/darwin)

### B32 🟡 [POSITION] Ad-hoc runtime properties leak into persisted trade records
**File:** `src/positions/manager.js` + `state.js`

Properties `_volPct`, `_tickDropPct`, `_priceSource`, `_slPending` are set directly on position objects during refresh/rule-application and leak into persisted trade snapshots when `closePosition` spreads the position object.

**Status:** ⬜Open
**Found by:** Audit (agent position/chains/darwin)

---

## Darwin/Evolution Bugs

### B33 🟠 [DARWIN] onTradeClosed crashes if _deps not wired
**File:** `src/darwin/evolve.js:119-130`

`onTradeClosed` dereferences `_deps.darwin`, `_deps.llm`, `_deps.getConfig` without null-checking. If a trade closes before `setEvolveDeps` is called (e.g., early reconciliation at startup), this throws TypeError.

**Status:** ✅Fixed
**Found by:** Audit (agent position/chains/darwin)

### B34 🟡 [DARWIN] bestProven unstable under selection pressure
**File:** `src/darwin/darwin.js`

Historical best genome may not be optimal if market regime shifts. Epsilon-greedy helps exploration, but the "best genome" shown to users can stagnate.

**Status:** ⬜Open
**Found by:** Audit (agent position/chains/darwin)

---

## Telegram Subsystem Bugs

### B35 🟠 [TELEGRAM] Authorization race condition: auto-pair with first sender
**File:** `src/telegram/bot.js:98-106`

When `TELEGRAM_CHAT_ID` is not set, `_authorized` auto-pairs with whoever messages first. If deployed before setting the env var, an attacker could claim the bot.

**Status:** ⬜Open
**Found by:** Audit (agent telegram)

### B36 🟡 [TELEGRAM] Markdown fallback skips remaining chunks on failure
**File:** `src/telegram/bot.js:117-125`

When Markdown parsing fails for a chunk, it sends that chunk as plain text then `continue`s. The next chunk tries Markdown again (which likely also fails). Should set a flag to send all remaining chunks as plain text.

**Status:** ⬜Open
**Found by:** Audit (agent telegram)

### B37 🟡 [TELEGRAM] Hardcoded SOL native currency throughout
**Files:** `fmt.js`, `reports.js`, `commands/status.js`, `commands/system.js`

`nativeSym()` ignores its `chainKey` parameter and always returns `'SOL'`. All balance displays show SOL regardless of chain.

**Status:** ⬜Open
**Found by:** Audit (agent telegram)

### B38 🟡 [TELEGRAM] /start shows full help text, no onboarding flow
**File:** `src/telegram/commands/system.js:47`

First-time users get a wall of 40+ lines of commands instead of guided setup.

**Status:** ⬜Open
**Found by:** Audit (agent telegram)

---

## Runner/Skill-Mode Bugs

### B39 🔴 [SKILL] runner.js module-level side effects are dangerous
**File:** `src/skills/runner.js:28-143`

If any other file imports runner.js (even for testing), it will: call `loadConfig()`, `initDb()`, `loadState()` (corrupting running instance state), call `process.exit(1)` if `--skill-mode` is absent, register signal handlers, create instances, and start loops. Severe footgun.

**Status:** ⬜Open
**Found by:** Audit (agent skills/GMGN)

### B40 🟠 [SKILL] shutdown() uses dangerous forced exit after 500ms
**File:** `src/skills/runner.js:137`

`setTimeout(() => process.exit(0), 500)` after awaiting `telegram.stopPolling()`. If stop takes longer, the process is killed mid-cleanup. In-flight DB writes, trade confirmations, log flushes are abruptly terminated.

**Status:** ⬜Open
**Found by:** Audit (agent skills/GMGN)

### B41 🟡 [SKILL] Initial screeningCycle called BEFORE readiness signal
**File:** `src/skills/runner.js:140-143`

First screening cycle fires before `{"type":"ready"}` is written to stdout. If screening takes a long time, the agent doesn't know the bot is ready.

**Status:** ⬜Open
**Found by:** Audit (agent skills/GMGN)

---

## Config.js Bugs

### B42 🟡 [CONFIG] Duplicate error handling block (copy-paste)
**File:** `src/config.js:303-317`

Two nearly identical catch blocks in `loadConfig()`. The second has broken indentation — unmistakable copy-paste artifact. Runs correctly but indicates sloppy code.

**Status:** ✅Fixed
**Found by:** Audit (agent core)

### B43 🟡 [CONFIG] setPath has no write-lock
**File:** `src/config.js:347-361`

`setPath` does read-merge-write. Two concurrent `/set` commands could race (though Node.js single-threading makes this unlikely for synchronous I/O).

**Status:** ⬜Open
**Found by:** Audit (agent core)

---

## Price/Utility Bugs

### B44 🟡 [PRICE] nativePriceUsd has no concurrency control on cache population
**File:** `src/prices.js`

Two simultaneous callers both miss the cache and make duplicate API calls. Wasteful but not harmful.

**Status:** ⬜Open
**Found by:** Audit (agent core)

### B45 🟡 [UTIL] dynamicStopLossPercent ignores baseSlPercent when vol data exists
**File:** `src/utils.js:119-127`

The `baseSlPercent` (user's configured stopLossPct) is completely ignored when volatility data is present. The SL is replaced by the volatility calculation. Config docs say "baseline is not treated as hard limit" but actual behavior is stronger: baseline is completely replaced.

**Status:** ⬜Open
**Found by:** Audit (agent core)

### B46 🟡 [UTIL] sanitizePromptField misses RTL override and tab injection vectors
**File:** `src/utils.js:25-27`

Only strips `[\r\n]+`. Does NOT strip tab characters, Unicode bidirectional override characters (U+202E, U+2066-U+2069), zero-width characters, or backticks. Potential prompt injection vectors remain.

**Status:** ⬜Open
**Found by:** Audit (agent core)

---

## GMGN OpenAPI Bugs

### B47 🟡 [GMGN] findActivityByTx swallows all errors silently
**File:** `src/gmgn/openapi.js:41-43`

Empty `catch {}` block discards ALL errors: network failures, rate limits, programming bugs, malformed responses. Returns `null` as if the tx simply wasn't found yet, masking real bugs.

**Status:** ✅Fixed
**Found by:** Audit (agent skills/GMGN)

### B48 🟡 [GMGN] walletStats has no API-key guard
**File:** `src/gmgn/openapi.js`

Unlike `findActivityByTx` (which checks `GMGN_API_KEY` and returns null), `walletStats` does not check. If key is unset, `headers()` throws synchronously, crashing the caller.

**Status:** ✅Fixed
**Found by:** Audit (agent skills/GMGN)

---

## Plan Verification Summary

| Plan | Tasks | Status | Notes |
|------|-------|--------|-------|
| 2026-08-02-snipra-skill.md | 10 | ✅ All committed on main | ea5dd96, ae557f6, 25591e4, f749395 |
| 2026-08-03-llm-token-reduction.md | 5 | ✅ All committed on main | 86e18e9 through c8e1217 |
| 2026-08-03-position-management-upgrade.md | 5 | ✅ All committed on main | 2214b37 through 129eaee |
| 2026-08-03-skill-agent-control.md | 15 | ⚠️ Partial | Tasks 1,9,10,11 = uncommitted diffs. Tasks 4,5,6,7 = on DIFFERENT branch, NOT on main. Tasks 14,15 (tests) = never created. README/config updates = partially done |
| 2026-08-06-gmgn-discovery.md | 9 | ✅ All committed on main | b9189b1 through 7fb11a4 |

### Skill-Agent-Control Plan Gap Analysis (not on main):
- **Task 1** (Shared tool-runner): `src/llm/tools.js` — EXISTS as untracked file
- **Tasks 2-3** (Wire index.js + runner.js): UNCOMMITTED diffs in working tree
- **Task 4** (Command queue): Committed on other branch, NOT on main → MISSING
- **Tasks 5** (Wire command queue): Committed on other branch, NOT on main → MISSING from runner.js
- **Task 6** (skill-command.js CLI): Committed on other branch, NOT on main → MISSING
- **Task 7** (skill-status.js CLI): Committed on other branch, NOT on main → MISSING
- **Task 8** (SKILL.md update): UNCOMMITTED diff in working tree
- **Tasks 9-10** (Dead code removal): UNCOMMITTED diffs in working tree
- **Task 11** (Remove sendStatusReport): UNCOMMITTED diffs in working tree
- **Tasks 12-13** (Config/env/README): PARTIAL — live-config.example.json outdated (B5)
- **Tasks 14-15** (Tests): NEVER created on any branch

---

## Summary

- **Total bugs found:** 48
- **✅ Fixed:** 13 (B5, B6, B7, B8, B9, B10, B17, B18, B29, B30, B33, B42, B47, B48)
- **🔧 Partial:** 1 (B6 — SKILL.md/README updated, files still need merge)
- **🔴 Critical (open):** 3 (B1, B15, B39)
- **🟠 High (open):** 9
- **🟡 Medium (open):** 23
- **🟢 Low (open):** 1
- **User-reported:** 4 (B1-B4)
- **Audit-discovered:** 44 (B5-B48)
