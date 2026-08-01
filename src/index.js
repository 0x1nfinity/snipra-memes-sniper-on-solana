import 'dotenv/config';
import { loadConfig, getConfig, watchConfig, getActiveMode } from './config.js';
import { initDb } from './db.js';
import { loadState, syncStateMode, openPositions, statsSummary, currentPnlPct, moonbags } from './positions/state.js';
import { recentTrades } from './db.js';
import { Executor } from './trade/executor.js';
import { PositionManager } from './positions/manager.js';
import { Darwin } from './darwin/darwin.js';
import { LLM } from './llm/llm.js';
import { Telegram } from './telegram/bot.js';
import { runScreening } from './screener/screener.js';
import { fmtUsd, fmtPct, tokenLink } from './utils.js';
import { marketLine, communityLine } from './telegram/fmt.js';
import { createLogger } from './logger.js';
import { resolveCandidate, buyToken, sellToken, effectiveMax } from './trade/helpers.js';
import { runEvolve, onTradeClosed, setEvolveDeps } from './darwin/evolve.js';
import { sendStatusReport, startStatusLoop, stopStatusLoop, setStatusDeps } from './telegram/reports.js';

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
const llm = new LLM().load();

let paused = false;
let screenTimer = null;
let screenBusy = false;


/** konteks realtime utk LLM chatbot */
function botContext() {
  const cfg = getConfig();
  const s = statsSummary();
  const byChain = {};
  for (const p of openPositions()) {
    (byChain[p.chain] ??= []).push(`${p.symbol} ${currentPnlPct(p).toFixed(1)}% (sisa ${p.remainingPct.toFixed(0)}%)`);
  }
  const posBlock = Object.keys(byChain).sort()
    .map((k) => `${k.toUpperCase()}: ${byChain[k].join(', ')}`)
    .join('\n') || '(tidak ada posisi terbuka)';
  const st = darwin.status();
  const lastTrades = recentTrades(getActiveMode(), 5)
    .map((t) => `${t.symbol} ${(t.pnl_pct ?? 0).toFixed(1)}% (${t.close_reason})`)
    .join('; ') || '(belum ada)';
  const enabledChains = Object.entries(cfg.chains).filter(([,c]) => c.enabled).map(([k]) => k).join(', ') || '(none)';
  return (
    `mode=${getActiveMode()}, chains=${enabledChains}, screening tiap ${cfg.screener.intervalSec}s, monitor tiap ${cfg.monitor.intervalSec}s\n` +
    `Posisi terbuka (${openPositions().length}):\n${posBlock}\n` +
    `Statistik: ${s.totalTrades} trades, win rate ${s.winRatePct.toFixed(1)}%, avg PnL ${s.avgPnlPct.toFixed(1)}%\n` +
    `Trade terakhir: ${lastTrades}\n` +
    `Darwin: generasi ${st.generation}, genome terbaik ${st.genomes[0]?.id} (fitness ${st.genomes[0]?.fitness.toFixed(2)})\n` +
    `Filter utama: ${JSON.stringify(cfg.screener.filters)}\n` +
    `TP ladder: ${JSON.stringify(cfg.tpLadder)} | trailing: aktif ${cfg.trailing.activateGainPct}%, trail ${cfg.trailing.trailPct}% | SL ${cfg.trading.stopLossPct}%`
  );
}

// ===== LLM tool-calling (#4): definisi + eksekutor =====

const LLM_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'get_positions',
      description: 'Ambil daftar posisi terbuka + PnL + moonbag saat ini.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screen_now',
      description: 'Jalankan satu siklus screening sekarang dan langsung beli kandidat yang lolos.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buy_token',
      description: 'Beli token. Butuh chain dan address; amount opsional (native SOL).',
      parameters: {
        type: 'object',
        properties: {
          chain: { type: 'string', enum: ['solana'] },
          address: { type: 'string' },
          amount: { type: 'number', description: 'jumlah native opsional; kosong = default buyAmount' },
        },
        required: ['chain', 'address'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sell_token',
      description: 'Jual posisi/moonbag berdasarkan address token. pct default 100.',
      parameters: {
        type: 'object',
        properties: {
          address: { type: 'string' },
          pct: { type: 'number', description: 'persen holdings 1-100' },
        },
        required: ['address'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'close_all_positions',
      description: 'Tutup SEMUA posisi terbuka sekarang.',
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
      return { ok: true, note: 'screening dijalankan; hasil dikirim sebagai notifikasi terpisah' };
    }
    case 'buy_token': {
      const chain = args.chain || inferChain(args.address);
      if (!chain) return { error: 'chain tidak diketahui' };
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
      return { error: `tool tidak dikenal: ${name}` };
  }
}

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
  paused: () => paused,
  screenBusy: () => screenBusy,
});

// ===== screening loop + auto-buy =====

/** force=true (dari /screen manual) tetap jalan walau auto-buy sedang paused */
async function screeningCycle(force = false) {
  if (paused && !force) return;
  if (screenBusy) {
    log.info('screening di-skip: cycle sebelumnya masih berjalan');
    return;
  }
  screenBusy = true;
  try {
    const cfg = getConfig();
    const effMax = effectiveMax(cfg);

    // BUG-B1: cek slot kosong SEBELUM screening — hemat rate limit & token LLM
    const availSlots = effMax - openPositions().length;
    if (!force && availSlots <= 0) {
      log.info(`screening di-skip: posisi penuh (${openPositions().length}/${effMax})`);
      if (cfg.telegram.notifyScreening) {
        telegram.notify(
          `⏭️ Screening — Dilewati\n\nPosisi penuh ${openPositions().length}/${effMax} — tidak ada slot kosong.`
        );
      }
      return;
    }

    const { candidates, genomeId, scanned } = await runScreening({
      darwin,
      llm,
      availSlots: availSlots > 0 ? availSlots : undefined,
    });
    const bought = [];
    const rejected = []; // BUG-A4: lacak alasan token tidak dibeli
    const MAX_RETRIES = 2;
    const RETRY_DELAY_MS = 2000;
    for (const c of candidates) {
      c.genomeId = genomeId;
      let lastError = null;
      let boughtToken = false;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const pos = await buyToken(c.chain, c.address, undefined, 'screener', c, executor, onTradeClosed);
          bought.push({ c, pos });
          boughtToken = true;
          if (attempt > 0) log.info(`retry #${attempt} berhasil utk ${c.symbol}`);
          break;
        } catch (e) {
          lastError = e.message;
          // Hanya retry utk error transient (RPC, network, slippage), bukan error permanen
          const isTransient = /timeout|ECONN|EAI_|ENOTFOUND|ETIMEDOUT|nonce|underpriced|replacement|rate.?limit|429|503/i.test(e.message);
          if (!isTransient || attempt >= MAX_RETRIES) break;
          log.debug(`retry #${attempt + 1} utk ${c.symbol} dalam ${RETRY_DELAY_MS}ms: ${e.message}`);
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
      }
      if (!boughtToken) {
        rejected.push({ c, reason: lastError || 'gagal' });
        log.debug(`skip buy ${c.symbol}: ${lastError}`);
      }
    }
    // Notifikasi hasil screening — ringkas, tetap detail, spasi antar baris jelas
    if (cfg.telegram.notifyScreening) {
      if (candidates.length === 0) {
        telegram.notify(`🔍 Screening — ${scanned} discan, tidak ada yang lolos filter`);
      } else {
        const lines = [];
        lines.push(`🔍 Screening — ${scanned} discan, ${candidates.length} lolos, ${bought.length} dibeli, ${rejected.length} ditolak`);
        lines.push('');
        for (const { c } of bought) {
          const slug = cfg.chains[c.chain]?.gmgnSlug;
          lines.push(`✅ Beli ${tokenLink(c.symbol, slug, c.address)} — ${fmtUsd(c.priceUsd)}`);
          lines.push(`   ${marketLine(c)}, ${communityLine(c)}`);
          lines.push('');
        }
        for (const { c, reason } of rejected) {
          const slug = cfg.chains[c.chain]?.gmgnSlug;
          lines.push(`❌ Tolak ${tokenLink(c.symbol, slug, c.address)} — ${fmtUsd(c.priceUsd)}`);
          lines.push(`   Alasan: ${reason}`);
          lines.push('');
        }
        telegram.notify(lines.join('\n').trimEnd());
      }
    }
  } catch (e) {
    log.error('screening cycle gagal:', e.message);
  } finally {
    screenBusy = false;
  }
}

/** jadwalkan screening tepat di kelipatan wall-clock (mis. :00/:30 utk 30 menit) */
function startScreeningLoop() {
  const { intervalSec } = getConfig().screener;
  if (screenTimer) { clearTimeout(screenTimer); clearInterval(screenTimer); }
  screenTimer = null;
  if (!intervalSec || intervalSec <= 0) return;
  const periodMs = intervalSec * 1000;
  const delay = periodMs - (Date.now() % periodMs); // ke boundary berikutnya
  screenTimer = setTimeout(() => {
    screeningCycle();
    screenTimer = setInterval(screeningCycle, periodMs);
  }, delay);
  log.info(`screening loop start (tiap ${intervalSec}s, boundary wall-clock, mulai dalam ${Math.round(delay / 1000)}s)`);
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
  if (screenTimer) { clearTimeout(screenTimer); clearInterval(screenTimer); }
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
  console.log(`\nScan ${scanned} token, ${candidates.length} lolos filter:\n`);
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
