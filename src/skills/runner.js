import 'dotenv/config';
import { fileURLToPath } from 'url';
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
import { buyToken, sellToken } from '../trade/helpers.js';
import { runEvolve, onTradeClosed, setEvolveDeps } from '../darwin/evolve.js';
import { startStatusLoop, stopStatusLoop, setStatusDeps, sendDailyBriefing } from '../telegram/reports.js';
import { LLM_TOOL_DEFS, createToolRunner } from '../llm/tools.js';
import { createLogger } from '../logger.js';
import { sweepStaleCommandFiles, startCommandQueueLoop } from './command-queue.js';

const log = createLogger('skill-runner');

// ===== main() — semua inisialisasi dan side effect dibungkus di sini =====
// Module ini TIDAK BOLEH punya side effect selain `dotenv/config` dan `log` creation.
// Import runner.js dari file lain (test, utility, etc.) tidak akan memulai bot.

async function main() {
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

  // Tool definitions + executor (shared, lihat src/llm/tools.js)

  const runLlmTool = createToolRunner({
    openPositions, currentPnlPct, moonbags, buyToken, sellToken, executor, onTradeClosed,
    screeningCycle: (force) => screeningCycle(force),
    closeAllPositions: (reason) => positionManager.closeAllPositions(reason),
  });

  sweepStaleCommandFiles();
  let _stopCommandQueue = startCommandQueueLoop(runLlmTool);

  // Position manager
  const positionManager = new PositionManager({
    executor,
    notify: (m) => telegram.notify(m),
    onTradeClosed,
  });

  // Telegram: non-interactive mode (notifications only)
  const telegram = new Telegram({
    executor, darwin, llm, positionManager,
    buyToken: (chain, addr, amt, source) => buyToken(chain, addr, amt, source || 'telegram-button', null, executor),
    sellToken: (addr, pct) => sellToken(addr, pct, executor, onTradeClosed),
    screenNow: () => screeningCycle(true),
    runEvolve,
    llmChat: (text) => llm.chat(text, botContext(), getConfig().llm.tools ? { defs: LLM_TOOL_DEFS, run: runLlmTool } : null),
    closeAll: (reason) => positionManager.closeAllPositions(reason),
    sendDailyBriefing: () => sendDailyBriefing(),
    applyMode,
    restartLoops,
    setPaused: (v) => { paused = v; if (v) stopStatusLoop(); else startStatusLoop(); },
    isPaused: () => paused,
    shutdown,
  }, { interactive: false });

  // Wire deps
  setEvolveDeps({ darwin, llm, telegram, getConfig, recentTrades });
  setStatusDeps({
    executor, telegram, openPositions, currentPnlPct, moonbags, llm,
    paused: () => paused,
    screenBusy: () => screenBusyFlag,
  });

  // Screening cycle
  const screeningCycle = createScreeningCycle({
    darwin, llm, executor, telegram,
    buyToken: (chain, addr, amt, source, c) => buyToken(chain, addr, amt, source, c, executor),
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
    clearInterval(_stopCommandQueue);
    stopStatusLoop();
    positionManager.stop();
    try { await telegram.stopPolling(); } catch (e) { log.warn('telegram stopPolling error:', e.message); }
    // Grace period for in-flight DB writes, log flushes, trade confirmations
    const GRACE_MS = 10_000;
    const forceExit = setTimeout(() => {
      log.warn(`shutdown: forced exit after ${GRACE_MS}ms grace period`);
      process.exit(0);
    }, GRACE_MS);
    // Allow event loop to drain, then exit cleanly
    forceExit.unref();
    await new Promise((r) => setTimeout(r, 500));
    clearTimeout(forceExit);
    process.exit(0);
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

  // Signal readiness to platform agent BEFORE first screening cycle
  process.stdout.write(JSON.stringify({ type: 'ready', version: '2.0.0' }) + '\n');

  screeningCycle();
}

// Only execute main() when this file is the direct entry point.
// Importing this module (test, utility, etc.) will NOT start the bot.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
