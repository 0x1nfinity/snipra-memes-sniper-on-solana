# snipra v2 — Solana Meme Sniper

Memecoin trading bot for **Solana**.

## Mode: paper vs live

- **`paper` (default)** — paper trading: runs the exact same pipeline as live (screening → open position → TP ladder/trailing/SL → close) using real-time prices + simulated slippage, but with a **virtual balance** (`paper.startBalance`), never touching on-chain funds. Every closed trade is logged to **SQLite** (`data/snipra.db`, table `trades`) with full PnL. Darwin & the LLM still learn from the results.
- **`live`** — real on-chain transactions (Jupiter/GMGN on Solana).

Switch modes via Telegram `/mode paper|live` (persisted to `data/.mode`, not the config file). Review paper trade history with `/papertrades`, reset the virtual balance with `/paperreset`.

## Features

| # | Feature | Implementation |
|---|---------|-----------------|
| 1 | Solana meme screening | DexScreener (discovery + pair data) + GoPlus (holders, honeypot, tax) |
| 2 | SOL↔meme swaps | **Jupiter** lite-api (optional **GMGN** trading API) |
| 3 | TP ladder | Staged tiers, `sellPct` computed from the remaining position |
| 4 | Trailing profit | Activates after `activateGainPct`, sells everything on a `trailPct` drop from peak |
| 5 | Telegram | All config editable via `/set`; `/status` shows open positions & real-time PnL (on-demand on-chain reconcile) in one message |
| 6 | Darwin system | Filter-genome population → fitness from trade PnL → automatic selection + crossover + mutation |
| 7 | LLM | OpenRouter / DeepSeek — gates buys + post-mortem lessons re-injected into the prompt |

## Screening filters (required + additional)

Required: `minVolume24hUsd`, `minAgeHours`/`maxAgeHours`, `minLiquidityUsd`, `minMarketCapUsd`/`maxMarketCapUsd`, `minHolders`, `minTraders24h`.
Additional: buy/sell ratio, 1h anti-dump, volume/liquidity ratio, socials, honeypot/freezable (GoPlus), max buy/sell tax.

Numeric filter parameters are **auto-evolved** by the Darwin system; security filters are never loosened by evolution.

## Configuration

All settings live in two **local, git-ignored** JSON files at the project root — they hold your personal strategy tuning and are never committed:

- **`config.live.json`** — single source of truth for everything (screener, trading, llm, trailing, darwin, telegram, etc).
- **`config.paper.json`** — overrides only a few paper-mode-specific fields on top of `config.live.json` (`paper.startBalance`, `trading.maxPositions`, `trading.buyAmount`, `trading.paperGas`). Every other setting always follows `config.live.json`, even in paper mode.

Templates with inline documentation for every field ship in the repo:

```bash
cp config.live.example.json config.live.json
cp config.paper.example.json config.paper.json
```

Strip the `//` comment lines from your copies (the templates use them for documentation, but plain JSON doesn't support comments). If you skip this step entirely, the bot auto-creates both files with sane defaults on first run.

Edit values directly in the file, or change them at runtime via Telegram `/set` (persists straight back to the same file). Any field missing from the file falls back to the built-in default in `src/config.js`.

## Setup

```bash
npm install
cp .env.example .env                        # fill in your keys
cp config.live.example.json config.live.json    # optional — bot creates defaults if skipped
cp config.paper.example.json config.paper.json  # optional
npm run dev                                  # DRY RUN (default, safe)
```

Minimum required in `.env`:
- `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` — create a bot via @BotFather
- `SOLANA_PRIVATE_KEY` — only needed for live mode
- `OPENROUTER_API_KEY` or `DEEPSEEK_API_KEY` — only if `llm.enabled=true`

Try screening without running the full bot:

```bash
npm run screen
```

## Go live

```bash
# 1. Run paper trading first until win rate & PnL look convincing (/papertrades)
# 2. Switch mode via Telegram:
#    /mode live
npm start
```

⚠️ **Start with a small size** (`trading.buyAmount`). Memecoins are highly risky — this bot is not a profit guarantee.

## Telegram commands

`/status` `/config` `/get` `/set` `/menu` `/screen` `/buy` `/sell` `/closeall` `/stats` `/papertrades` `/paperreset` `/pause` `/resume` `/mode` `/darwin` `/evolve` `/lessons` `/logs` `/help` `/stop`

`/status` shows mode, balance, and **open positions + moonbag** (on-demand on-chain reconcile before rendering) in a single message.

Runtime config examples:

```
/set screener.filters.minLiquidityUsd 30000
/set trailing.trailPct 15
/set tpLadder [{"gainPct":50,"sellPct":30},{"gainPct":150,"sellPct":50}]
/set llm.enabled true
```

## Active chain

- **Solana** — dexscreenerId `solana`, executor Jupiter (or GMGN).

## Architecture

```
src/
  index.js              # wiring, screening loop, auto-buy, graceful shutdown
  config.js             # config + persistence + /set path resolution
  screener/
    dexscreener.js      # discovery + pair data + batched prices
    goplus.js           # holders + honeypot + tax (Solana)
    filters.js          # filter evaluation + scoring
    screener.js         # orchestration (darwin genome + LLM gate)
  chains/
    solana.js           # Jupiter (default) / GMGN executor
  trade/executor.js     # cross-mode buy/sell interface (paper/live)
  trade/paper.js        # paper engine: virtual balance, real price fills + slippage
  db.js                 # SQLite: trade history, paper wallet & holdings
  positions/
    state.js            # position, cooldown & stats persistence
    manager.js           # monitor loop: TP ladder → trailing → stop loss → on-chain reconcile
  darwin/darwin.js      # filter-genome evolution
  llm/llm.js             # OpenRouter/DeepSeek: gate + lessons
  telegram/bot.js        # command handler
config.live.example.json   # documented template → copy to config.live.json (git-ignored)
config.paper.example.json  # documented template → copy to config.paper.json (git-ignored)
data/                       # snipra.db (SQLite), positions.*.json, darwin.json, lessons.json — all git-ignored
```

## API sources (official docs)

- DexScreener: `https://docs.dexscreener.com/api/reference`
- Jupiter Swap: `https://developers.jup.ag` (free lite-api: `lite-api.jup.ag/swap/v1`)
- GMGN Cooperation API: `https://docs.gmgn.ai` (requires approval, `x-route-key` header)
- GoPlus Security: `https://api.gopluslabs.io`
