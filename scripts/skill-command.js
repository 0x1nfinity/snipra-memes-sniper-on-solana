import fs from 'fs';
import path from 'path';
import { commandQueueDir } from '../src/skills/command-queue.js';

const [, , toolName, argsJson] = process.argv;

if (!toolName) {
  console.error('usage: node scripts/skill-command.js <tool_name> [json_args]');
  console.error('tools: get_positions | screen_now | buy_token | sell_token | close_all_positions');
  process.exit(1);
}

let args = {};
if (argsJson) {
  try {
    args = JSON.parse(argsJson);
  } catch (e) {
    console.error(`invalid JSON args: ${e.message}`);
    process.exit(1);
  }
}

const id = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const dir = commandQueueDir();
const cmdPath = path.join(dir, `${id}.cmd.json`);
const resultPath = path.join(dir, `${id}.result.json`);

fs.writeFileSync(cmdPath, JSON.stringify({ id, name: toolName, args, createdAt: Date.now() }));

const TIMEOUT_MS = 30000;
const POLL_MS = 500;
const deadline = Date.now() + TIMEOUT_MS;

async function poll() {
  while (Date.now() < deadline) {
    if (fs.existsSync(resultPath)) {
      const raw = fs.readFileSync(resultPath, 'utf8');
      fs.unlinkSync(resultPath);
      const out = JSON.parse(raw);
      console.log(JSON.stringify(out, null, 2));
      process.exit(out.ok ? 0 : 1);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  console.error(`no response from snipra after ${TIMEOUT_MS / 1000}s — is it running? (npm run skill / npm run skill-dev)`);
  process.exit(1);
}

poll();
