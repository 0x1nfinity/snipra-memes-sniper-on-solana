# snipra v2 — Solana Meme Sniper

Memecoin trading bot for **Solana**. Screens tokens via GMGN/DexScreener, executes trades via Jupiter/GMGN, manages positions with TP ladder + trailing stop + stop-loss, evolves screening filters via Darwin genetic algorithm, and uses LLM analysis to gate buy decisions.

## Two Operating Modes

snipra v2 runs in one of two modes — pick based on whether you have your own LLM API keys or prefer your AI coding agent to be the brain:

### 1. Standalone Mode (`npm start`)

The bot runs fully self-contained. You bring your own LLM API keys (OpenRouter or DeepSeek), and the bot handles everything: screening, LLM buy-gating, position management, Telegram notifications + commands.

- **LLM**: Your API keys → HTTP calls to OpenRouter/DeepSeek
- **Interface**: Telegram bot (full command menu, inline keyboards, notifications)
- **Start**: `npm run dev` (paper) or `npm start` (live)

### 2. Skills Agentic Mode (`npm run skill-dev` / `npm run skill`)

The bot runs as a long-lived process communicating via stdin/stdout JSON protocol. Your AI coding agent (Claude Code, Codex, OpenCode, Cursor, etc.) becomes the LLM brain — it receives screening requests, evaluates tokens, records lessons, suggests gene mutations, and handles chat, all through the protocol.

- **LLM**: Your platform agent (no API keys needed)
- **Interface**: Talk to your agent directly (Telegram is notification-only)
- **Start**: `npm run skill-dev` (paper) or `npm run skill` (live)
- **Protocol**: `skills/snipra/SKILL.md` — full spec

## Features

### Screening & Discovery
| Feature | Description |
|---------|-------------|
| **GMGN Discovery** | Primary source — fetches new creations, near-completion, and completed tokens from GMGN trenches |
| **DexScreener Fallback** | Automatic fallback when GMGN is unavailable |
| **GoPlus Security** | Honeypot detection, freezable check, holder count, top-10 concentration, mint authority |
| **Multi-key GMGN** | Comma-separated API keys in `.env` — sequential fallback on failure |
| **Pre-scorer Gate** | Free rule-based scoring before the LLM (reduces LLM costs) |
| **20+ Hard Filters** | Volume, liquidity, market cap, holders, swaps, age, bonding progress, rug ratio, bundler rate, insider rate, top-10 concentration, bot/degen rate, fresh wallet rate, dev hold rate, smart degen count, total fees, honeypot block, wash trading block, launchpad whitelist |

### Trading & Execution
| Feature | Description |
|---------|-------------|
| **Jupiter Swap** | Default executor — routes through Jupiter lite-api for best price |
| **GMGN Trading** | Optional executor via GMGN trading API |
| **TP Ladder** | Staged take-profit tiers — e.g. sell 30% at +40%, 40% at +100%, 50% at +250% |
| **Trailing Stop** | Activates after `activateGainPct` — trails peak price, sells on `trailPct` drop |
| **Dynamic Stop-Loss** | Opt-in volatility-based SL — widens in high vol, narrows in low vol (50/50 blend with base SL) |
| **Moonbag** | Post-TP moonbag system — keeps a % of original position for long-term hold |
| **Max Hold Timeout** | Force-close positions older than N minutes regardless of PnL |
| **Sideways Timeout** | Force-close positions stuck in a tight PnL band for too long |
| **Circuit Breaker** | Rate-limits position opens (3 opens in 60s trips 5-min cooldown) |
| **Buy Freshness Check** | Re-verifies hard filters just before execution (guards against stale/rugged candidates) |
| **Buy Retry** | Auto-retries failed swaps with configurable count + delay |
| **Cooldown** | Prevents re-buying the same token within N minutes (configurable burst allowance) |
| **Anti-glitch** | Flash-dump detection — delays SL close by one tick if drop is sudden, confirms next tick |
| **Price Safety** | Ignores prices from near-zero-liquidity pairs; anomaly spike rejection |

### Darwin Genetic Evolution
| Feature | Description |
|---------|-------------|
| **Genome Population** | 8 genomes (configurable) — each a full set of filter + exit thresholds |
| **Fitness Tracking** | EMA-weighted PnL (recency bias α=0.2) with small-sample confidence penalty |
| **Selection** | Elitism + top-half survivors, epsilon-greedy exploration |
| **Crossover + Mutation** | Gaussian mutation within per-gene bounds, crossover from survivor pairs |
| **LLM-guided Evolution** | Optional — LLM analyzes genome performance + trade history, proposes guided offspring (max 2) |
| **Safety Guardrails** | Security filters (honeypot, wash trading) are never evolved; SL/TP-trailing genes only tighten, never loosen |

### LLM Integration (Standalone Mode)
| Feature | Description |
|---------|-------------|
| **Batch Assessment** | Multiple candidates in one LLM call — reduces API costs |
| **Buy Gate** | LLM evaluates tokens that passed hard filters — default bias is BUY |
| **Decision Cache** | Skip verdicts cached per token (TTL 30 min) — avoids re-asking about stale rejects |
| **Cheap Model Option** | Separate cheaper model for batch gate vs main model for chat |
| **Lessons System** | Post-trade lesson extraction → injected into future prompts |
| **Derive Lessons** | Batch lesson extraction from all closed trades (paper reset) |
| **Gene Suggestions** | LLM analyzes genome data → proposes filter changes (manual review, not auto-applied) |
| **Chat with Tools** | Natural language chat → LLM calls tools: screen, buy, sell, close all, get positions |

### Darwin Genetic Evolution
| Feature | Description |
|---------|-------------|
| **Genome Population** | 8 genomes, each a complete set of screening + exit thresholds |
| **EMA Fitness** | Exponential moving average of trade PnL (α=0.2) — favors recent performance |
| **Epsilon-greedy Selection** | Explores random genomes 25% of the time, exploits best otherwise |
| **Crossover + Mutation** | Gaussian mutation (σ per gene), uniform crossover from survivor pairs |
| **LLM-guided Offspring** | Up to 2 genomes per generation proposed by LLM analysis (clamped to safe ranges) |
| **Safety Bounds** | Security filters never evolved; SL/trailing genes only tighten from baseline |

### Position Management
| Feature | Description |
|---------|-------------|
| **Monitor Loop** | Runs every N seconds — checks PnL, TP ladder, trailing stop, SL, timeouts |
| **On-chain Reconcile** | Periodically checks actual on-chain balance vs recorded position — auto-closes if 0 |
| **Stale Price Warning** | Warns when a position's price has been unavailable for too long |

### Telegram Bot (Standalone Mode)
| Feature | Description |
|---------|-------------|
| **20+ Commands** | status, stats, screen, buy, sell, closeall, menu, config, get, set, darwin, evolve, lessons, logs, briefings, pause, resume, mode, papertrades, paperreset, help, stop |
| **Inline Keyboards** | Buy/Skip buttons on token lookup cards |
| **Address Lookup** | Paste a contract address → full token card + Buy button |
| **Name Search** | Type 1-2 words → top 3 DexScreener results + Buy buttons |
| **Config Hot-reload** | Edit JSON files directly — bot detects changes without restart |
| **Runtime /set** | Change any config value via Telegram, persists to file immediately |
| **Markdown Fallback** | Auto-detects Telegram parse errors → falls back to plain text per chunk |
| **Periodic Reports** | Configurable interval status reports (balance, positions, PnL) |
| **Daily Briefing** | 7 AM WIB — 24h trade summary + recent lessons |

### Skill Mode
| Feature | Description |
|---------|-------------|
| **Platform-agnostic** | Works with any agent that can read/write stdin/stdout |
| **Multi-platform Installer** | `npm run setup` auto-detects Claude Code, Codex, OpenCode, Cursor |
| **Command Queue** | File-based inbox/outbox — agent writes commands, bot processes them |
| **Status CLI** | `node scripts/skill-status.js` — read-only snapshot of bot state |
| **Action CLI** | `node scripts/skill-command.js <tool> '<args>'` — execute bot actions |

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — fill in TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
# For live mode: add SOLANA_PRIVATE_KEY, SOLANA_RPC_URL
# For standalone LLM: add OPENROUTER_API_KEY or DEEPSEEK_API_KEY
# For GMGN discovery: add GMGN_API_KEYS (comma-separated)

# 3. (Optional) Copy config templates
cp live-config.example.json live-config.json
cp paper-config.example.json paper-config.json
# The bot auto-creates these with defaults if skipped

# 4. Run (paper mode first — ALWAYS paper test before live!)
npm run dev          # Standalone mode, paper trading
# or
npm run skill-dev    # Skill mode, paper trading
```

### Minimum .env

| Variable | Required For | Description |
|----------|-------------|-------------|
| `TELEGRAM_BOT_TOKEN` | Both modes | Telegram bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Both modes | Your chat ID (from @userinfobot) |
| `SOLANA_PRIVATE_KEY` | Live mode only | Base58 private key for swaps |
| `SOLANA_RPC_URL` | Live mode only | Dedicated RPC endpoint recommended |
| `OPENROUTER_API_KEY` | Standalone LLM | OpenRouter API key |
| `DEEPSEEK_API_KEY` | Standalone LLM | DeepSeek API key (alternative) |
| `GMGN_API_KEYS` | GMGN (both) | Comma-separated API keys for discovery + wallet tracking |

### npm Scripts

| Script | Mode | Description |
|--------|------|-------------|
| `npm run dev` | Standalone | Paper trading, SNIPRA_MODE=paper forced |
| `npm start` | Standalone | Live trading (or paper if SNIPRA_MODE=paper) |
| `npm run screen` | Standalone | Screen once, print candidates, exit |
| `npm run skill-dev` | Skill | Paper trading via stdin/stdout protocol |
| `npm run skill` | Skill | Live trading via stdin/stdout protocol |
| `npm run setup` | Setup | Install SKILL.md to detected platforms |
| `npm test` | Dev | Run 43 tests |

## Strategy Presets

Four hardcoded filter profiles for different trading styles. Set via `strategy` in `live-config.json` or `/set strategy <name>`.

| Preset | Style | Key Traits |
|--------|-------|------------|
| `myself` | Full manual | Use config values as-is, no overrides |
| `sniper` | Ultra-fast | Low MC (7K-200K), max age 60min, loose risk |
| `wait_for_dip` | Patient | Mid MC (25K-500K), max age 24h, moderate risk |
| `smart_money` | Conservative | Higher holders (1K+), tight top-10 cap (50%), strict risk |
| `degen` | Maximum risk | Lowest MC (5K-100K), max age 60min, loose everything |

**Strategy presets ONLY override `screener.filters.*`** — all management settings (TP, SL, trailing, position size, LLM config, max positions, max hold) stay in your config file and are never touched.

## Configuration

All settings live in two **local, git-ignored** JSON files at the project root:

- **`live-config.json`** — single source of truth for everything (strategy, screener, trading, llm, trailing, darwin, telegram, monitor).
- **`paper-config.json`** — overrides only paper-specific fields on top of `live-config.json` (`paper.startBalance`, `trading.maxPositions`, `trading.buyAmount`, `trading.paperGas`). Every other setting always follows `live-config.json`.

Templates with inline documentation ship in the repo:

```bash
cp live-config.example.json live-config.json    # full template
cp paper-config.example.json paper-config.json  # paper override template
```

**Strip the `//` comment lines** from your copies (JSON doesn't support comments; the templates use them for documentation only). The bot auto-creates both files with defaults on first run if you skip this step.

Edit values directly in the file, or change at runtime via Telegram `/set <path> <value>` (persists straight back to the file). Hot-reload: the bot watches both files and picks up changes without restart. Timer changes (screening interval, monitor interval) auto-restart their respective loops.

### Key Config Sections

| Path | Default | Description |
|------|---------|-------------|
| `strategy` | `"myself"` | Strategy preset for filter overrides |
| `screener.source` | `"gmgn"` | Discovery source: `gmgn` or `dexscreener` |
| `screener.section` | `"new_creation"` | GMGN trench section |
| `screener.maxCandidatesPerCycle` | `3` | Max new tokens evaluated per cycle |
| `trading.buyAmount` | `0.3` | Position size in SOL |
| `trading.stopLossPct` | `-35` | Static stop-loss percentage |
| `trading.maxPositions` | `20` | Max concurrent open positions |
| `trading.maxHoldMinutes` | `0` | Force-close after N minutes (0=off) |
| `trading.cooldownMinutes` | `240` | Don't re-buy same token within window |
| `trailing.enabled` | `true` | Trailing stop active |
| `trailing.activateGainPct` | `10` | Trailing activates after this % profit |
| `trailing.trailPct` | `5` | Close when drops this % from peak |
| `darwin.enabled` | `true` | Genome evolution active |
| `llm.enabled` | `false` | LLM buy-gate active (needs API key) |
| `llm.gateBuy` | `true` | LLM evaluates before buy |
| `llm.tools` | `true` | LLM can call bot tools in chat |
| `telegram.screeningcyclemin` | `60` | Screening loop interval (minutes) |
| `telegram.managecyclemin` | `30` | Status report interval (minutes) |

## Telegram Commands

### Trading
| Command | Description |
|---------|-------------|
| `/buy <address> [amount]` | Buy a token (chain=Solana, amount from config if omitted) |
| `/sell <address> [pct]` | Sell a position (default 100%) |
| `/closeall` | Close all open positions |
| `/screen` | Run screening cycle + auto-buy candidates |
| `/pause` | Pause auto-buy (monitoring keeps running) |
| `/resume` | Resume auto-buy |

### Status & Reports
| Command | Description |
|---------|-------------|
| `/status` | Mode, balance, open positions + PnL, moonbags |
| `/stats` | Win rate, avg PnL, recent trades |
| `/briefings` | Manual daily briefing (positions, 24h PnL, lessons) |
| `/logs` | Recent 20 log lines |

### Configuration
| Command | Description |
|---------|-------------|
| `/config` | View full configuration |
| `/get <path>` | View a single config value |
| `/set <path> <value>` | Change config (persists to file) |
| `/menu` | Quick settings button panel |
| `/mode paper\|live` | Switch trading mode |

### Darwin & LLM
| Command | Description |
|---------|-------------|
| `/darwin` | Genome evolution status |
| `/evolve` | Force evolution + LLM analysis |
| `/lessons` | Recent lessons from LLM |

### Paper Trading
| Command | Description |
|---------|-------------|
| `/papertrades` | Paper trade history from SQLite |
| `/paperreset` | Reset virtual balance to starting value |

### System
| Command | Description |
|---------|-------------|
| `/help` | Full command list |
| `/start` | Onboarding message |
| `/stop` | Shut down the bot |

### Without Commands
- **Contract address** → token data card + Buy button
- **1-2 words** → top 3 DexScreener search results + Buy buttons
- **Sentence/question** → answered by LLM with realtime bot context

Runtime config examples:
```
/set screener.filters.minLiquidity 30000
/set trading.stopLossPct -25
/set strategy sniper
/set tpLadder [{"gainPct":50,"sellPct":30},{"gainPct":150,"sellPct":50}]
/set llm.enabled true
```

## Skill Mode Protocol

In skill mode, the bot communicates via stdin/stdout JSON. The platform agent becomes the LLM brain.

### Startup
```bash
npm run skill-dev    # Paper mode
npm run skill        # Live mode
```
The bot prints `{"type":"ready","version":"2.0.0"}` to stdout when ready.

### Request Types
| Type | Purpose | Response |
|------|---------|----------|
| `assess_batch` | Evaluate tokens that passed filters | `{verdicts: [{index, action, confidence, risk, reason}]}` |
| `record_lesson` | Extract lesson from closed trade | `{lesson: "..."}` |
| `suggest_genes` | Recommend filter changes | `{genes: {...}, rationale: "..."}` |
| `derive_lessons` | Batch extract lessons from all trades | `{lessons: [{text, outcome}]}` |
| `chat` | User message + optional tool calls | `{reply: "..."}` or `{tool_calls: [...]}` |

### Available Tools (Skill Mode)
| Tool | Args | Description |
|------|------|-------------|
| `get_positions` | `{}` | Open positions + PnL + moonbag count |
| `screen_now` | `{}` | Run one screening cycle |
| `buy_token` | `{"chain":"solana","address":"...","amount":<optional>}` | Buy a token |
| `sell_token` | `{"address":"...","pct":<optional>}` | Sell a position |
| `close_all_positions` | `{}` | Close all positions |

### User Interaction in Skill Mode
Talk to your agent directly:
- **Status check**: Agent runs `node scripts/skill-status.js` → relays to you
- **Actions**: Agent runs `node scripts/skill-command.js <tool> '<args>'` → relays result
- **Chat**: Agent forwards your message via the `chat` request type

Full protocol details: `skills/snipra/SKILL.md`

## Architecture

```
src/
  index.js                   # Standalone entry: wiring, loops, graceful shutdown
  config.js                  # Config layer: DEFAULTS, deep merge, hot-reload, /set persistence
  strategies.js              # Strategy presets: 4 hardcoded filter profiles + applyStrategy()
  screener/
    gmgn-discovery.js        # GMGN OpenAPI token discovery (multi-key fallback)
    dexscreener.js           # DexScreener: discovery, pair data, batched prices, search
    goplus.js                # GoPlus: security audit (honeypot, freezable, holders, top10)
    filters.js               # Hard filter evaluation + scoring (all GMGN fields)
    preScorer.js             # Rule-based scoring gate before LLM (cost reduction)
    screener.js              # Orchestration: genome selection → discovery → filter → LLM gate
  chains/
    solana.js                # Jupiter (default) / GMGN executor, quote-based price fallback
  trade/
    executor.js              # Cross-mode buy/sell interface (paper ↔ live)
    paper.js                 # Paper engine: virtual balance, real prices, simulated fills
    helpers.js               # buyToken/sellToken: retry + freshness recheck, shared by all callers
    circuit-breaker.js       # Rate-limits position opens (burst protection)
  db.js                      # SQLite: trade history, decision cache, paper wallet
  positions/
    state.js                 # Position, cooldown & stats persistence (per-mode JSON files)
    manager.js               # Monitor loop: time-exit → SL → TP ladder → trailing → reconcile
  darwin/
    darwin.js                # Genome population: seed, mutate, crossover, evolve, fitness (EMA)
    evolve.js                # Evolution orchestration: trade feedback → LLM suggestion → notify
  llm/
    llm.js                   # Public API: assessBatch, lessons, chat, suggestGenes, deriveLessons
    http-backend.js          # OpenRouter/DeepSeek HTTP calls (standalone mode)
    stdio-backend.js         # stdin/stdout JSON protocol backend (skill mode)
    tools.js                 # Shared LLM tool defs + executor (both modes)
    loops.js                 # Shared screening-cycle/bot-context factory (index.js + runner.js)
  telegram/
    bot.js                   # Bot: commands, inline keyboards, token lookup, notifications
    fmt.js                   # Formatting helpers (nativeSym, marketLine, communityLine, etc.)
    reports.js               # Periodic status reports + daily briefing (7 AM WIB)
    commands/                # 20+ exported command handlers (auto-discovered via buildRegistry)
  gmgn/
    openapi.js               # GMGN OpenAPI: wallet_activity, wallet_stats
  skills/
    runner.js                # Skill-mode entry: StdioBackend + command-queue + Telegram (notify-only)
    command-queue.js         # File-based inbox/outbox for agent-initiated actions
scripts/
  install.js                 # Platform detector + SKILL.md installer (npm run setup)
  skill-command.js           # Agent-facing CLI: submit action, wait for result
  skill-status.js            # Agent-facing CLI: read-only status snapshot
skills/snipra/
  SKILL.md                   # Skill template: protocol spec + agent instructions
live-config.example.json     # Documented template → copy to live-config.json
paper-config.example.json    # Documented template → copy to paper-config.json
data/                        # All runtime data — git-ignored
  snipra.db                  # SQLite database
  positions.paper.json       # Paper mode positions + stats
  positions.live.json        # Live mode positions + stats
  darwin.json                # Genome population + evolution history
  lessons.json               # LLM-extracted trading lessons
  .mode                      # Active mode marker (paper or live)
```

## API Sources

| Service | Endpoint | Usage |
|---------|----------|-------|
| DexScreener | `api.dexscreener.com` | Token discovery, pair data, batched prices, search |
| Jupiter | `lite-api.jup.ag/swap/v1` | Swap execution (free tier) |
| GMGN | `gmgn.ai` | Token discovery (trenches API) + trading API |
| GoPlus | `api.gopluslabs.io` | Security audit (honeypot, holders, tax) |
| OpenRouter | `openrouter.ai/api/v1` | LLM provider (standalone mode) |
| DeepSeek | `api.deepseek.com` | LLM provider (standalone mode) |

## Go Live Checklist

1. ✅ Paper trade for at least several days — review `/papertrades` and `/stats`
2. ✅ Verify win rate and avg PnL are acceptable
3. ✅ Start with small `trading.buyAmount` (e.g. 0.05 SOL)
4. ✅ Ensure dedicated RPC endpoint (not public default)
5. ✅ Double-check `SOLANA_PRIVATE_KEY` is correct
6. ✅ Switch mode: `/mode live`
7. ✅ Monitor first few trades closely

⚠️ **Memecoins are highly risky.** This bot is a tool, not a profit guarantee. Never trade more than you can afford to lose.
