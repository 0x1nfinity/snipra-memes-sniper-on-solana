---
name: snipra
description: Solana memecoin sniper bot — screens tokens via DexScreener, executes trades via Jupiter, manages positions with TP ladder/trailing stop/SL, evolves filters via Darwin genetic algorithm. Runs as a long-lived process; agent handles all LLM decisions via stdin/stdout JSON protocol.
---

# Snipra — Solana Memecoin Sniper

## Startup

Run the bot in skill mode:

```bash
node src/skills/runner.js --skill-mode
```

For paper trading (dry run):

```bash
DRY_RUN=1 node src/skills/runner.js --skill-mode
```

This starts a long-running process. It will print `{"type":"ready","version":"2.0.0"}` to stdout when ready.

## Your Role as the Agent

You are the **brain** of this bot. The runner process handles all execution (DexScreener API calls, Jupiter swaps, position tracking, database). But every time an LLM decision is needed, the runner sends a JSON request to stdout and waits for your response on stdin.

**You MUST:**
1. Read each line from stdout of the runner process
2. If the line is a JSON request with a `"type"` field, use your intelligence to evaluate and decide
3. Write your decision as a JSON response to stdin of the runner process
4. Continue reading stdout in a loop until you see `{"type":"shutdown","reason":"..."}`

## Protocol

### Request Format (stdout, one JSON object per line)

```json
{
  "id": "string",
  "type": "assess_token | record_lesson | suggest_genes | derive_lessons | chat",
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

#### 1. assess_token
Evaluate whether to buy a token that passed all hard filters. The token has already passed strict checks on liquidity, volume, age, market cap, holders, and honeypot. **Default bias: BUY** — only reject if there's a serious red flag (clear dump in progress, extreme holder concentration, obvious rug pattern). Express caution through confidence score, not rejection.

Respond with:
```json
{"action":"buy"|"skip","confidence":<0-1>,"risk":"low"|"medium"|"high","reason":"<1 sentence, Indonesian>"}
```

#### 2. record_lesson
Generate one short English lesson (max 150 chars) from a closed trade's outcome. Focus on transferable patterns, not this specific token.

Respond with:
```json
{"lesson":"<english lesson text>"}
```

#### 3. suggest_genes
Analyze genome performance data, trade history, and lessons. Recommend filter threshold changes that would improve profit. Only include filters that should change from baseline values. These are advisory (not auto-applied).

Respond with:
```json
{"genes":{"<filter_name>":<number>,...},"rationale":"<2-3 sentences, Indonesian>"}
```

#### 4. derive_lessons
Analyze ALL closed trades in batch before a paper trading reset. Extract 3-5 high-level strategic lessons (English, max 200 chars each). Focus on patterns across multiple trades, not single-trade observations.

Respond with:
```json
{"lessons":[{"text":"...","outcome":"WIN|LOSS|PATTERN"},...]}
```

#### 5. chat
Respond to user's natural language message. The system prompt contains the bot persona (snipra, Indonesian-speaking memecoin sniper) and realtime state (open positions, PnL, stats). If the request includes `tools`, you may respond with `tool_calls` to execute actions:
- `screen_now` — run one screening cycle
- `buy_token` — buy a token (chain: solana, address, optional amount)
- `sell_token` — sell a position (address, optional pct 1-100)
- `close_all_positions` — close all open positions
- `get_positions` — get current open positions

Max 4 tool-calling hops per chat. After tools execute, the runner sends a follow-up chat request with results.

Respond with:
```json
{"reply":"<response text, Indonesian>"}
```
Or with tool calls:
```json
{"tool_calls":[{"id":"call_1","function":{"name":"buy_token","arguments":"{\"chain\":\"solana\",\"address\":\"...\"}"}}]}
```

## Shutdown

When the runner exits, it prints `{"type":"shutdown","reason":"..."}`. Stop reading stdout.

## User Interaction

The user can chat with you directly. You forward their messages as `chat` requests to the runner. The runner responds with the bot's reply, which you relay to the user.

For status checks, the user can ask you "what's my position?" or "how's the bot doing?" — forward as a chat request and the runner will respond with current state.
