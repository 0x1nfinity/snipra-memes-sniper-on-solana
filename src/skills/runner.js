import 'dotenv/config';
import { loadConfig, getConfig, watchConfig, getActiveMode } from '../config.js';
import { initDb } from '../db.js';
import { loadState, syncStateMode, openPositions, statsSummary, currentPnlPct, moonbags } from '../positions/state.js';
import { recentTrades } from '../db.js';
import { Executor } from '../trade/executor.js';
import { PositionManager } from '../positions/manager.js';
import { Darwin } from '../darwin/darwin.js';
import { LLM } from '../llm/llm.js';
import { StdioBackend } from '../llm/stdio-backend.js';
import { Telegram } from '../telegram/bot.js';
import { createScreeningCycle, startScreeningLoop as startScreeningTimer, createBotContext } from '../llm/loops.js';
import { resolveCandidate, buyToken, sellToken, effectiveMax } from '../trade/helpers.js';
import { runEvolve, onTradeClosed, setEvolveDeps } from '../darwin/evolve.js';
import { sendStatusReport, startStatusLoop, stopStatusLoop, setStatusDeps } from '../telegram/reports.js';
import { createLogger } from '../logger.js';

const log = createLogger('skill-runner');

// Detect skill mode flag
const isSkillMode = process.argv.includes('--skill-mode');
if (!isSkillMode) {
  console.error('This entry point is for skill mode only. Use --skill-mode flag.');
  process.exit(1);
}

loadConfig();
initDb();
loadState();

const executor = new Executor();

function applyMode() {
  executor.syncMode();
  syncStateMode();
}

const darwin = new Darwin().load();
const stdioBackend = new StdioBackend({ timeout: 60000 });
const llm = new LLM({ backend: stdioBackend }).load();

let paused = false;
let screenBusyFlag = false;

const botContext = createBotContext({ darwin, statsSummary, openPositions, currentPnlPct });

// Tool definitions (same as index.js)
const LLM_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'get_positions',
      description: 'Get the current list of open positions + PnL + moonbag.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screen_now',
      description: 'Run one screening cycle now and immediately buy candidates that pass.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buy_token',
      description: 'Buy a token. Needs chain and address; amount optional (native SOL).',
      parameters: {
        type: 'object',
        properties: {
          chain: { type: 'string', enum: ['solana'] },
          address: { type: 'string' },
          amount: { type: 'number', description: 'optional native amount; empty = default buyAmount' },
        },
        required: ['chain', 'address'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sell_token',
      description: 'Sell a position/moonbag by token address. pct defaults to 100.',
      parameters: {
        type: 'object',
        properties: {
          address: { type: 'string' },
          pct: { type: 'number', description: 'percent of holdings 1-100' },
        },
        required: ['address'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'close_all_positions',
      description: 'Close ALL open positions now.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

function inferChain(address) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) ? 'solana' : null;
}

async function runLlmTool(name, args) {
  switch (name) {
    case 'get_positions': {
      const pos = openPositions().map((p) => ({
        chain: p.chain, symbol: p.symbol, address: p.address,
        pnlPct: +currentPnlPct(p).toFixed(1), remainingPct: p.remainingPct,
      }));
      return { openCount: pos.length, positions: pos, moonbags: moonbags().length };
    }
    case 'screen_now': {
      await screeningCycle(true);
      return { ok: true, note: 'screening triggered; results sent as a separate notification' };
    }
    case 'buy_token': {
      const chain = args.chain || inferChain(args.address);
      if (!chain) return { error: 'unknown chain' };
      const pos = await buyToken(chain, args.address, args.amount, 'llm-tool', null, executor, onTradeClosed);
      return { ok: true, symbol: pos.symbol, chain, entryPrice: pos.entryPrice, tx: pos.txid };
    }
    case 'sell_token': {
      const res = await sellToken(args.address, args.pct ?? 100, executor, onTradeClosed);
      return { ok: true, receivedNative: res.receivedNative, tx: res.txid };
    }
    case 'close_all_positions': {
      const results = await positionManager.closeAllPositions('llm-tool');
      return { ok: true, closed: results.filter((r) => !r.error).length, results };
    }
    default:
      return { error: `unknown tool: ${name}` };
  }
}

// Position manager
const positionManager = new PositionManager({
  executor,
  notify: (m) => telegram.notify(m),
  onTradeClosed,
});

// Telegram: non-interactive mode (notifications only)
const telegram = new Telegram({
  executor, darwin, llm, positionManager,
  buyToken: (chain, addr, amt, source) => buyToken(chain, addr, amt, source || 'telegram-button', null, executor, onTradeClosed),
  sellToken: (addr, pct) => sellToken(addr, pct, executor, onTradeClosed),
  screenNow: () => screeningCycle(true),
  runEvolve,
  llmChat: (text) => llm.chat(text, botContext(), getConfig().llm.tools ? { defs: LLM_TOOL_DEFS, run: runLlmTool } : null),
  closeAll: (reason) => positionManager.closeAllPositions(reason),
  applyMode,
  restartLoops,
  setPaused: (v) => { paused = v; if (v) stopStatusLoop(); else startStatusLoop(); },
  isPaused: () => paused,
  shutdown,
}, { interactive: false });

// Wire deps
setEvolveDeps({ darwin, llm, telegram, getConfig, recentTrades });
setStatusDeps({
  executor, telegram, openPositions, currentPnlPct, moonbags,
  paused: () => paused,
  screenBusy: () => screenBusyFlag,
});

// Screening cycle
const screeningCycle = createScreeningCycle({
  darwin, llm, executor, telegram,
  buyToken: (chain, addr, amt, source, c) => buyToken(chain, addr, amt, source, c, executor, onTradeClosed),
  onTradeClosed,
  paused: () => paused,
  screenBusy: (v) => { if (v !== undefined) screenBusyFlag = v; return screenBusyFlag; },
});

let _stopScreening = null;
function startScreeningLoop() {
  if (_stopScreening) _stopScreening();
  _stopScreening = startScreeningTimer(screeningCycle, getConfig);
}

function restartLoops() {
  startScreeningLoop();
  positionManager.start();
  startStatusLoop();
}

// Graceful shutdown
let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`shutdown: ${reason}`);
  process.stdout.write(JSON.stringify({ type: 'shutdown', reason }) + '\n');
  if (_stopScreening) _stopScreening();
  stopStatusLoop();
  positionManager.stop();
  await telegram.stopPolling();
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => log.error('unhandledRejection:', e?.message || e));

// Entry
const cfg = getConfig();
log.info(`snipra v2 skill-mode start | mode=${getActiveMode()} | chains: ${Object.entries(cfg.chains).filter(([, c]) => c.enabled).map(([k]) => k).join(', ')}`);

telegram.start();
positionManager.start();
startScreeningLoop();
startStatusLoop();

watchConfig(({ timersChanged }) => {
  applyMode();
  if (timersChanged) restartLoops();
});

screeningCycle();

// Signal readiness to platform agent
process.stdout.write(JSON.stringify({ type: 'ready', version: '2.0.0' }) + '\n');
