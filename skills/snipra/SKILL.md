---
name: snipra
description: Solana memecoin sniper bot — screens tokens via DexScreener, executes trades via Jupiter, manages positions with TP ladder/trailing stop/SL, evolves filters via Darwin genetic algorithm. Runs as a long-lived process; agent handles all LLM decisions via stdin/stdout JSON protocol.
---

# Snipra — Solana Memecoin Sniper

## ⚠️ CRITICAL: Start Immediately

When you receive this instruction, **DO NOT** ask clarifying questions, search for files, or explore the codebase. **Immediately start the bot** from the project root directory.

## ⚠️ Error Handling

When on-chain transaction errors occur (failed swaps, error codes like 6025, etc.), **just report the error to the user**. Do NOT attempt to debug, search code, or fix anything.

## ⚠️ No File Searching

You are already in the project directory. Do NOT run find, ls, grep, glob, or any file search commands. Just start the bot.

---

## How to Use with Any AI Agent

This bot is **agent-agnostic** — it communicates via stdin/stdout JSON protocol. Any AI coding agent (OpenCode, Claude Code, OpenClaw, Hermes, Cursor, etc.) can run it.

### Step 1: Start the bot

```bash
node src/skills/runner.js --skill-mode
```

For paper trading (dry run):

```bash
DRY_RUN=1 node src/skills/runner.js --skill-mode
```

The bot prints `{"type":"ready","version":"2.0.0"}` when ready.

### Step 2: Read stdin/stdout

The runner sends JSON requests to stdout, one per line. You (the agent) respond on stdin. Keep reading until you see `{"type":"shutdown","reason":"..."}`.

---

## Protocol

### Request Format (stdout, one JSON object per line)

```json
{
  "id": "string",
  "type": "assess_token | assess_batch | record_lesson | suggest_genes | derive_lessons | chat",
  "system": "system prompt describing your role and task",
  "user": "the data or question to evaluate",
  "response_format": { ... description of expected output ... }
}
```

### Response Format (write to stdin, one JSON object per line)

Success:
```json
{"id":"<same id as request>","ok":true,"result":{...}}
```

Error:
```json
{"id":"<same id as request>","ok":false,"error":"reason"}
```

### Request Types

#### 1. assess_batch
Evaluate MULTIPLE tokens in one request. Every token already passed strict hard filters. **Default bias: BUY** — only reject if there's a serious red flag for THAT specific token. Assess each token independently.

The `user` field contains a numbered token list:

```
TOKENS:
[0] SYMBOL (Name) on solana, dex raydium
  Pair age: 12 min | MC ... | Liq ... | Vol24h ...
  Holders ... | top10 ...% | tx24h ... (buy/sell ...)
  Price change: 1h ...% | 6h ...% | 24h ...%
  Security: honeypot=..., mintable=...

[1] ...
```

Return exactly one entry per token index. Missing index = REJECTED.

```json
{"verdicts":[{"index":<int>,"action":"buy"|"skip","confidence":<0-1>,"risk":"low"|"medium"|"high","reason":"<1 short sentence, English>"},...]}
```

#### 2. record_lesson
Generate one short English lesson (max 150 chars) from a closed trade.

```json
{"lesson":"<english lesson text>"}
```

#### 3. suggest_genes
Recommend filter threshold changes. Advisory only (not auto-applied).

```json
{"genes":{"<filter_name>":<number>,...},"rationale":"<2-3 sentences, English>"}
```

#### 4. derive_lessons
Extract 3-5 strategic lessons from ALL closed trades (max 200 chars each, English).

```json
{"lessons":[{"text":"...","outcome":"WIN|LOSS|PATTERN"},...]}
```

#### 5. chat
Respond to user messages. If `tools` are included, you may call:
- `screen_now` — run one screening cycle
- `buy_token` — `{"chain":"solana","address":"...","amount":<optional>}`
- `sell_token` — `{"address":"...","pct":<optional 1-100>}`
- `close_all_positions` — close all positions
- `get_positions` — current open positions

```json
{"reply":"<response text, English>"}
```
Or with tool calls:
```json
{"id":"<request id>","ok":true,"tool_calls":[{"id":"call_1","function":{"name":"buy_token","arguments":"{\"chain\":\"solana\",\"address\":\"...\"}"}}]}
```

---

## Shutdown

When the runner exits, it prints `{"type":"shutdown","reason":"..."}`. Stop reading stdout.

---

## User Interaction (External Commands)

The user talks to you directly — not through this stdout/stdin protocol. You are their single interface to the bot; they never need Telegram (notifications only in skill mode) or any other channel.

### Checking status

Run:
```bash
node scripts/skill-status.js
```
Prints a snapshot: mode, open positions + PnL, recent trades, Darwin genome status, active filters/TP/SL/trailing config. Read-only, safe to run anytime.

### Taking action

Run:
```bash
node scripts/skill-command.js <tool_name> '<json_args>'
```

Available tools:

| Tool | Args | Description |
|------|------|--------------|
| `get_positions` | `{}` | Open positions + PnL + moonbag count |
| `screen_now` | `{}` | Run one screening cycle now, buy whatever passes |
| `buy_token` | `{"chain":"solana","address":"...","amount":<optional native SOL>}` | Buy a token |
| `sell_token` | `{"address":"...","pct":<optional 1-100, default 100>}` | Sell a position/moonbag |
| `close_all_positions` | `{}` | Close every open position now |

The command blocks up to 30s and prints the result as JSON. Two different things can mean "the action didn't do what you wanted" — check both:
- Top-level `"ok":false` — the command queue itself failed (an unexpected exception, or "no response from snipra after 30s — is it running?" if the runner process isn't up).
- Top-level `"ok":true` but `"result":{"error":"..."}` — the tool ran fine but rejected the request for a normal reason (e.g. `buy_token` with an unrecognized chain returns `{"error":"unknown chain"}` inside `result`, not a top-level failure). This is the same "return an error object instead of throwing" convention `LLM_TOOL_DEFS`'s tools have always used, not something specific to this CLI.

Relay the outcome to the user in your own words; do not paste raw JSON at them.

Example: user says "buy token ABC on solana" → run
`node scripts/skill-command.js buy_token '{"chain":"solana","address":"ABC..."}'`
→ report back what happened.

---

## Agent-Specific Setup

### OpenCode
Place this file at `.opencode/skills/snipra/SKILL.md` or create a command at `.opencode/commands/snipra.md`:
```md
---
description: Start the Snipra bot
---
node src/skills/runner.js --skill-mode
```

### Claude Code / OpenClaw / Hermes
Tell the agent: "Read skills/snipra/SKILL.md and follow it exactly."

### Any Agent
The bot is just a Node.js process. Any agent that can spawn a subprocess and read/write stdin/stdout can run it. Point the agent to this file.
