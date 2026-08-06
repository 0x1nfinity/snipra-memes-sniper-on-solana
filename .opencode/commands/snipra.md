---
description: Start the Snipra Solana memecoin sniper bot in skill mode
---

IMPORTANT: Do NOT ask questions or explore the codebase. Do NOT search for files. Immediately start the bot from the current project directory.

1. Run: node src/skills/runner.js --skill-mode
   (or DRY_RUN=1 node src/skills/runner.js --skill-mode for paper trading)

2. Read stdout line by line. When you see {"type":"ready","version":"2.0.0"}, the bot is live.

3. Process each JSON request from stdout per the protocol:
   - assess_batch: evaluate tokens and respond with buy/skip verdicts
   - record_lesson: generate lesson from closed trade
   - suggest_genes: recommend filter changes
   - derive_lessons: batch lessons from all closed trades
   - chat: respond to user messages or execute tool_calls

4. Keep reading stdout until you see {"type":"shutdown","reason":"..."}.

CRITICAL RULES:
- NEVER search for files (find, ls, grep, glob) — you're already in the project directory
- When on-chain errors occur (failed tx), just report to user. Do NOT debug or fix code.
- Start the bot immediately, no questions asked.
