import 'dotenv/config';
import { loadConfig, getConfig, watchConfig, getActiveMode } from './config.js';
import { initDb } from './db.js';
import { loadState, syncStateMode, openPositions, statsSummary, currentPnlPct, moonbags } from './positions/state.js';
import { recentTrades } from './db.js';
import { Executor } from './trade/executor.js';
import { PositionManager } from './positions/manager.js';
import { Darwin } from './darwin/darwin.js';
import { HttpBackend } from './llm/http-backend.js';
import { LLM } from './llm/llm.js';
import { Telegram } from './telegram/bot.js';
import { runScreening } from './screener/screener.js';
import { fmtUsd, fmtPct } from './utils.js';
import { createLogger } from './logger.js';
import { buyToken, sellToken } from './trade/helpers.js';
import { runEvolve, onTradeClosed, setEvolveDeps } from './darwin/evolve.js';
import { sendStatusReport, startStatusLoop, stopStatusLoop, setStatusDeps } from './telegram/reports.js';
import { createScreeningCycle, startScreeningLoop as startScreeningTimer, createBotContext } from './llm/loops.js';
import { LLM_TOOL_DEFS, createToolRunner } from './llm/tools.js';

const log = createLogger('main');

loadConfig();
initDb();
loadState();

const executor = new Executor();

// Terapkan perubahan mode (paper↔live) ke SELURUH subsistem yang mode-aware:
//  - executor: rebuild chain (paper vs on-chain)
//  - state:    reload posisi/stats dari file mode yang benar (positions.<mode>.json)
// Dipanggil dari hot-reload config.<mode>.json maupun perintah Telegram /mode & /set mode.
function applyMode() {
  executor.syncMode();
  syncStateMode();
}
const darwin = new Darwin().load();
const llm = new LLM({ backend: new HttpBackend() }).load();

let paused = false;
let screenBusyFlag = false;
let _stopScreening = null;

const botContext = createBotContext({ darwin, statsSummary });

// ===== LLM tool-calling (#4): definisi + eksekutor (shared, lihat src/llm/tools.js) =====

const runLlmTool = createToolRunner({
  openPositions, currentPnlPct, moonbags, buyToken, sellToken, executor, onTradeClosed,
  screeningCycle: (force) => screeningCycle(force),
  closeAllPositions: (reason) => positionManager.closeAllPositions(reason),
});

// ===== komponen utama =====

const positionManager = new PositionManager({
  executor,
  notify: (m) => telegram.notify(m),
  onTradeClosed,
});

const telegram = new Telegram({
  executor,
  darwin,
  llm,
  positionManager,
  buyToken: (chain, addr, amt, source) => buyToken(chain, addr, amt, source || 'telegram-button', null, executor, onTradeClosed),
  sellToken: (addr, pct) => sellToken(addr, pct, executor, onTradeClosed),
  screenNow: () => screeningCycle(true), // screening + langsung buy yang lolos
  runEvolve,
  llmChat: (text) => llm.chat(
    text,
    botContext(),
    getConfig().llm.tools ? { defs: LLM_TOOL_DEFS, run: runLlmTool } : null
  ),
  closeAll: (reason) => positionManager.closeAllPositions(reason),
  // terapkan pergantian mode (executor + reload state per-mode) dari /mode & /set mode
  applyMode,
  // restart timer setelah interval diubah via /set (tanpa perlu restart bot)
  restartLoops,
  setPaused: (v) => {
    paused = v;
    if (v) stopStatusLoop();
    else startStatusLoop();
  },
  isPaused: () => paused,
  shutdown,
});

// Wire module-level deps for extracted modules
setEvolveDeps({ darwin, llm, telegram, getConfig, recentTrades });
setStatusDeps({
  executor,
  telegram,
  openPositions,
  currentPnlPct,
  moonbags,
  llm,
  paused: () => paused,
  screenBusy: () => screenBusyFlag,
});

// ===== screening loop + auto-buy =====

const screeningCycle = createScreeningCycle({
  darwin, llm, executor, telegram,
  buyToken: (chain, addr, amt, source, c) => buyToken(chain, addr, amt, source, c, executor, onTradeClosed),
  onTradeClosed,
  paused: () => paused,
  screenBusy: (v) => { if (v !== undefined) screenBusyFlag = v; return screenBusyFlag; },
});

function startScreeningLoop() {
  if (_stopScreening) _stopScreening();
  _stopScreening = startScreeningTimer(screeningCycle, getConfig);
}

// Restart ketiga timer (screening/monitor/status) — dipakai saat interval diubah
// via /set atau via edit manual config.<mode>.json (hot-reload).
function restartLoops() {
  startScreeningLoop();
  positionManager.start();
  startStatusLoop();
}

// ===== graceful shutdown (SIGTERM/SIGINT + /stop telegram) =====

let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`shutdown: ${reason}`);
  if (_stopScreening) _stopScreening();
  stopStatusLoop();
  positionManager.stop();
  await telegram.stopPolling();
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => log.error('unhandledRejection:', e?.message || e));

// ===== entrypoint =====

const cfg = getConfig();
log.info(`snipra v2 start | mode=${getActiveMode()} | chains: ${Object.entries(cfg.chains).filter(([, c]) => c.enabled).map(([k]) => k).join(', ')}`);

if (process.argv.includes('--screen-once')) {
  const { candidates, scanned } = await runScreening({ darwin, llm });
  console.log(`\nScanned ${scanned} tokens, ${candidates.length} passed filter:\n`);
  for (const c of candidates) {
    console.log(
      `  ${c.symbol.padEnd(12)} ${c.chain.padEnd(8)} mc=${fmtUsd(c.marketCap)} liq=${fmtUsd(c.liquidityUsd)} ` +
      `vol24=${fmtUsd(c.volume24h)} holders=${c.holders ?? '?'} h1=${fmtPct(c.priceChange.h1)}`
    );
  }
  process.exit(0);
}

telegram.start();
positionManager.start();
startScreeningLoop();
startStatusLoop();

// Hot-reload: edit config.<mode>.json manual langsung dipakai siklus berikutnya tanpa pm2 restart.
// Nilai (filter, buyAmount, SL/TP, trailing) sudah dibaca live via getConfig() tiap siklus;
// hanya perubahan interval timer yang perlu restart loop.
watchConfig(({ timersChanged }) => {
  // mode paper↔live via /mode / /set mode → rebuild chain + reload state.
  // applyMode() no-op bila mode tidak berubah, jadi aman dipanggil tiap reload.
  applyMode();
  if (timersChanged) restartLoops();
});

screeningCycle(); // langsung jalan sekali saat boot
