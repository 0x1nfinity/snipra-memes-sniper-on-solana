import 'dotenv/config';
import { loadConfig, getConfig, watchConfig } from './config.js';
import { initDb } from './db.js';
import { loadState, syncStateMode, openPositions, findOpen, inCooldown, addPosition, statsSummary, currentPnlPct, moonbags } from './positions/state.js';
import { recentTrades, tradeStatsByChain } from './db.js';
import { GENE_SPACE } from './darwin/darwin.js';
import { Executor } from './trade/executor.js';
import { PositionManager } from './positions/manager.js';
import { Darwin } from './darwin/darwin.js';
import { LLM } from './llm/llm.js';
import { Telegram } from './telegram/bot.js';
import { runScreening } from './screener/screener.js';
import { tokenPairs, bestPair, normalizePair } from './screener/dexscreener.js';
import { fmtUsd, fmtPct, shortAddr, tokenLink, sleep } from './utils.js';
import { chainBlocks, marketLine, communityLine, llmLine, fmtNative, chainHeader, fmtHold } from './telegram/fmt.js';
import { createLogger } from './logger.js';
import { effectiveMax } from './trade/helpers.js';

const log = createLogger('main');

loadConfig();
initDb();
loadState();

const executor = new Executor();

// Terapkan perubahan mode (paper↔live) ke SELURUH subsistem yang mode-aware:
//  - executor: rebuild chain (paper vs on-chain)
//  - state:    reload posisi/stats dari file mode yang benar (positions.<mode>.json)
// Dipanggil dari hot-reload config.json maupun perintah Telegram /mode & /set mode.
function applyMode() {
  executor.syncMode();
  syncStateMode();
}
const darwin = new Darwin().load();
const llm = new LLM().load();

let paused = false;
let screenTimer = null;
let screenBusy = false;

// ===== BUY / SELL helpers (dipakai auto-buy & perintah telegram) =====

async function resolveCandidate(chainKey, address) {
  const cfg = getConfig();
  const dsId = cfg.chains[chainKey]?.dexscreenerId;
  if (!dsId) throw new Error(`chain ${chainKey} tidak dikenal/aktif`);
  const pairs = await tokenPairs(dsId, address);
  const pair = bestPair(pairs);
  if (!pair) throw new Error(`token ${address} tidak ditemukan di DexScreener`);
  return normalizePair(pair, chainKey);
}

async function buyToken(chainKey, address, amountNative, source, candidate) {
  const cfg = getConfig();
  if (cfg.activeChain !== 'both' && cfg.activeChain !== chainKey)
    throw new Error(`chain ${chainKey} nonaktif (activeChain=${cfg.activeChain})`);
  const c = candidate || (await resolveCandidate(chainKey, address));

  if (findOpen(chainKey, c.address)) throw new Error(`sudah ada posisi ${c.symbol}`);
  if (inCooldown(chainKey, c.address, cfg.trading.cooldownMinutes))
    throw new Error(`${c.symbol} masih cooldown`);
  // single-chain: batas efektif = maxPerChain; both: total maxPositions + per-chain
  const effMax = effectiveMax(cfg);
  if (openPositions().length >= effMax)
    throw new Error(`max posisi (${effMax}) tercapai`);
  const chainCount = openPositions().filter((p) => p.chain === chainKey).length;
  if (chainCount >= cfg.trading.maxPerChain)
    throw new Error(`maxPerChain ${chainKey} (${cfg.trading.maxPerChain}) tercapai`);

  // sizing: SELALU ikut config.json (chains.<key>.buyAmount) apa adanya —
  // TIDAK lagi diskalakan LLM sizeMult/score. amount eksplisit (mis. /buy <amt>)
  // tetap dihormati; jika kosong, executor.buy memakai buyAmount persis.
  const amount = amountNative;
  // sizing final + cek minSwap + floor + CEK BALANCE semua terjadi di executor.buy
  const res = await executor.buy(chainKey, c.address, amount, { labels: c.labels });
  const pos = addPosition({
    chain: chainKey,
    address: c.address,
    symbol: c.symbol,
    pairAddress: c.pairAddress,
    labels: c.labels,
    entryPrice: c.priceUsd,
    amountNative: res.spentNative,
    tokensRaw: res.tokensRaw,
    txid: res.txid,
    genomeId: c.genomeId || null,
    llmVerdict: c.llmVerdict || null,
  });
  log.info(`posisi dibuka [${source}]: ${c.symbol} @ ${c.priceUsd}`);
  return { ...pos, txid: res.txid };
}

async function sellToken(address, pct) {
  const { recordPartialSell, closePosition, findMoonbag, removeMoonbag } = await import('./positions/state.js');
  const pos = openPositions().find(
    (p) => p.address.toLowerCase() === address.toLowerCase()
  );
  if (pos) {
    const res = await executor.sell(pos.chain, pos.address, pct, { labels: pos.labels, fallbackPriceUsd: pos.currentPrice });
    if (pct >= 100) {
      const trade = closePosition(pos, { reason: 'manual sell', receivedNative: res.receivedNative, txid: res.txid });
      onTradeClosed(trade);
    } else {
      recordPartialSell(pos, { pctOfRemaining: pct, receivedNative: res.receivedNative, txid: res.txid });
    }
    return res;
  }
  // bukan posisi aktif — cek moonbag
  const mb = findMoonbag(address);
  if (!mb) throw new Error(`tidak ada posisi/moonbag utk ${shortAddr(address)}`);
  const res = await executor.sell(mb.chain, mb.address, pct, { labels: mb.labels, fallbackPriceUsd: mb.currentPrice });
  if (pct >= 100) removeMoonbag(mb.id);
  else mb.moonPct = mb.moonPct * (1 - pct / 100);
  log.info(`moonbag sell ${pct}% ${mb.symbol} → ${res.receivedNative?.toFixed(6)} native`);
  return res;
}

// ===== feedback loop: trade close → darwin fitness + LLM lesson =====

function onTradeClosed(trade) {
  const cfg = getConfig();
  if (cfg.darwin.enabled) {
    const due = darwin.recordTrade(trade);
    if (due) runEvolve('auto').catch((e) => log.error('auto-evolve gagal:', e.message));
  }
  if (cfg.llm.enabled && llm.available()) {
    llm.recordTradeLesson(trade).catch(() => {});
  }
}

// Format angka gen ringkas: 50000→50K, 20000000→20M, 0.9→0.9
function fmtGene(v) {
  const n = Number(v);
  if (!isFinite(n)) return String(v);
  if (Math.abs(n) >= 1e6) return `${+(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
  return String(+n.toFixed(2));
}

// Susun daftar "gen: sekarang → usulan" hanya untuk gen yang benar-benar beda.
function geneDiffLines(currentFilters, proposed) {
  const lines = [];
  for (const [name, val] of Object.entries(proposed || {})) {
    if (!(name in GENE_SPACE)) continue;
    const cur = currentFilters[name];
    const nv = Number(val);
    if (!isFinite(nv)) continue;
    // anggap sama bila selisih < 1% (hindari noise pembulatan)
    if (cur != null && Math.abs(nv - cur) <= Math.abs(cur) * 0.01) continue;
    lines.push(`  • \`${name}\`: ${cur != null ? fmtGene(cur) : '—'} → *${fmtGene(nv)}*`);
  }
  return lines;
}

/**
 * ANALISA EVOLUSI (advisory) — TIDAK mengubah apa pun otomatis.
 * Menggabungkan data fitness Darwin (genome terbaik yang teruji) + analisa LLM,
 * lalu mengirim NOTIFIKASI berisi usulan perubahan filter. User menerapkan sendiri
 * (lewat /menu, /set, atau edit config.json — hot-reload aktif).
 */
async function runEvolve(trigger = 'manual') {
  const cfg = getConfig();
  const filters = cfg.screener.filters;
  const st = darwin.status();

  // ── sisi Darwin: genome terbaik yang sudah teruji ──
  const best = darwin.bestProven();
  const darwinLines = best ? geneDiffLines(filters, best.genes) : [];

  // ── sisi LLM: rekomendasi berbasis trade + performa genome + lessons ──
  let llmLines = [];
  let rationale = null;
  if (cfg.llm.enabled && llm.available()) {
    try {
      const suggestion = await llm.suggestGenes({
        geneSpace: GENE_SPACE,
        currentFilters: filters,
        genomes: st.genomes.map((g) => ({ id: g.id, fitness: +g.fitness.toFixed(2), trades: g.trades, avgPnl: +g.avgPnl.toFixed(1), genes: g.genes })),
        trades: recentTrades(cfg.mode, 20).map((t) => ({
          symbol: t.symbol, chain: t.chain, pnlPct: +(t.pnl_pct ?? 0).toFixed(1),
          reason: t.close_reason, holdMin: Math.round(t.hold_minutes ?? 0),
        })),
        lessonsText: llm.getLessons(10).map((l) => `[${l.outcome}] ${l.text}`).join('\n'),
      });
      if (suggestion?.genes) {
        llmLines = geneDiffLines(filters, suggestion.genes);
        rationale = suggestion.rationale;
        log.info(`LLM usul filter: ${JSON.stringify(suggestion.genes)} — ${rationale}`);
      }
    } catch (e) {
      log.warn('LLM suggestGenes gagal:', e.message);
    }
  }

  // ── susun notifikasi usulan ──
  const parts = [`🧬 *Usulan evolusi* (${trigger}) — _tidak diterapkan otomatis_`];
  if (best) {
    parts.push(
      `\n📊 *Darwin* — genome teruji terbaik \`${best.id}\`` +
      ` (fitness ${darwin.fitness(best).toFixed(2)}, ${best.trades} trades, avg ${fmtPct(best.totalPnlPct / best.trades)})` +
      (darwinLines.length ? `\n${darwinLines.join('\n')}` : `\n  _(setara config saat ini)_`)
    );
  } else {
    parts.push(`\n📊 *Darwin* — belum ada genome cukup teruji (butuh ≥ ${cfg.darwin.minTradesForFitness} trades/genome)`);
  }
  if (llmLines.length || rationale) {
    parts.push(
      `\n🧠 *LLM*` +
      (llmLines.length ? `\n${llmLines.join('\n')}` : `\n  _(tanpa usulan angka)_`) +
      (rationale ? `\n  _${rationale}_` : '')
    );
  } else if (cfg.llm.enabled) {
    parts.push(`\n🧠 *LLM* — tidak ada usulan`);
  }
  parts.push(`\n_Terapkan manual bila setuju: /menu · /set · atau edit config.json (hot-reload)._`);

  telegram.notify(parts.join('\n'));
  darwin.resetEvolveCounter(); // reset kuota agar tidak memicu tiap trade berikutnya
  return { darwinLines, llmLines, rationale };
}

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
  const lastTrades = recentTrades(cfg.mode, 5)
    .map((t) => `${t.symbol} ${(t.pnl_pct ?? 0).toFixed(1)}% (${t.close_reason})`)
    .join('; ') || '(belum ada)';
  return (
    `mode=${cfg.mode}, activeChain=${cfg.activeChain}, screening tiap ${cfg.screener.intervalSec}s, monitor tiap ${cfg.monitor.intervalSec}s\n` +
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
      description: 'Beli token. Butuh chain dan address; amount opsional (native SOL/ETH).',
      parameters: {
        type: 'object',
        properties: {
          chain: { type: 'string', enum: ['solana', 'robinhood'] },
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
  if (/^0x[a-fA-F0-9]{40}$/.test(address)) return 'robinhood';
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return 'solana';
  return null;
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
      const pos = await buyToken(chain, args.address, args.amount, 'llm-tool');
      return { ok: true, symbol: pos.symbol, chain, entryPrice: pos.entryPrice, tx: pos.txid };
    }
    case 'sell_token': {
      const res = await sellToken(args.address, args.pct ?? 100);
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
  buyToken,
  sellToken,
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
  setPaused: (v) => { paused = v; },
  isPaused: () => paused,
  shutdown,
});

// ===== screening loop + auto-buy =====

/** force=true (dari /screen manual) tetap jalan walau auto-buy sedang paused */
async function screeningCycle(force = false) {
  if (screenBusy || (paused && !force)) return;
  screenBusy = true;
  try {
    const cfg = getConfig();
    const { candidates, genomeId, scanned } = await runScreening({ darwin, llm });
    const bought = [];
    for (const c of candidates) {
      c.genomeId = genomeId;
      try {
        const pos = await buyToken(c.chain, c.address, undefined, 'screener', c);
        bought.push({ c, pos });
      } catch (e) {
        log.debug(`skip buy ${c.symbol}: ${e.message}`);
      }
    }
    // Notifikasi hasil screening SELALU dikirim (walau tidak ada yang lolos/dibeli),
    // dikelompokkan per chain (bukan selang-seling)
    if (cfg.telegram.notifyScreening) {
      const boughtSet = new Set(bought.map((b) => `${b.c.chain}:${b.c.address}`));
      if (candidates.length === 0) {
        telegram.notify(`🔍 *Screening* · ${scanned} token discan · tidak ada yang lolos filter`);
      } else {
        const byChain = {};
        for (const c of candidates) {
          const slug = cfg.chains[c.chain]?.gmgnSlug;
          const isBought = boughtSet.has(`${c.chain}:${c.address}`);
          const item =
            `${isBought ? '✅' : '⏸'} ${tokenLink(c.symbol, slug, c.address)} — ${fmtUsd(c.priceUsd)}${isBought ? ' *(dibeli)*' : ''}\n` +
            `   ${marketLine(c)}\n` +
            `   ${communityLine(c)}` +
            (llmLine(c) ? `\n   ${llmLine(c)}` : '');
          (byChain[c.chain] ??= []).push(item);
        }
        telegram.notify(
          `🔍 *Screening* · ${candidates.length} lolos · ${bought.length} dibeli\n\n${chainBlocks(byChain)}`
        );
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
// via /set atau via edit manual config.json (hot-reload).
function restartLoops() {
  startScreeningLoop();
  positionManager.start();
  startStatusLoop();
}

// ===== laporan berkala (saldo + PnL) =====

let statusTimer = null;

function nativeSymbol(chainKey) {
  return getConfig().chains[chainKey]?.type === 'solana' ? 'SOL' : 'ETH';
}

async function sendStatusReport() {
  const cfg = getConfig();
  // #8 prioritas: kalau screening sedang jalan, tunggu sampai selesai agar
  // notif screening terkirim lebih dulu, baru laporan posisi.
  for (let i = 0; i < 240 && screenBusy; i++) await sleep(500);

  const bal = await executor.balances();
  const realizedByChain = Object.fromEntries(
    tradeStatsByChain(cfg.mode).map((r) => [r.chain, r])
  );
  const blocks = [];
  for (const [chainKey, b] of Object.entries(bal)) {
    const sym = nativeSymbol(chainKey);
    const chainPos = openPositions().filter((x) => x.chain === chainKey);
    // unrealized = Σ modal tersisa × pnl% posisi terbuka chain ini
    let unrealized = 0;
    for (const p of chainPos) {
      const invested = p.amountNative * (p.remainingPct / 100);
      unrealized += invested * (currentPnlPct(p) / 100);
    }
    const r = realizedByChain[chainKey];
    const realized = r?.pnl_native ?? 0;
    // daftar posisi terbuka chain ini
    const posLines = chainPos.length
      ? chainPos.map((p) => {
          const pnl = currentPnlPct(p);
          return `  ${pnl >= 0 ? '🟢' : '🔴'} ${tokenLink(p.symbol, cfg.chains[chainKey]?.gmgnSlug, p.address)} ${fmtPct(pnl)} · ⏱${fmtHold(p.openedAt)}`;
        }).join('\n')
      : '  (tidak ada posisi terbuka)';
    blocks.push(
      `${chainHeader(chainKey)}\n` +
      `💼 Saldo ${b.error ? '⚠️ ' + b.error : `${b.native.toFixed(4)} ${sym}`}\n` +
      `📈 Unrealized ${fmtNative(unrealized, chainKey)}\n` +
      `✅ Realized ${fmtNative(realized, chainKey)}${r ? ` · ${r.total} closed trades` : ''}\n` +
      `📂 Posisi (${chainPos.length}):\n${posLines}`
    );
  }
  const effMax = effectiveMax(cfg);
  telegram.notify(
    `📊 *Laporan berkala* · ${cfg.mode}\n` +
    `Total posisi ${openPositions().length}/${effMax} · Moonbag ${moonbags().length} · Auto-buy ${paused ? '⏸' : '▶️'}\n\n` +
    blocks.join('\n\n')
  );
}

/** jadwalkan laporan tepat di kelipatan wall-clock (mis. :00, :30) */
function startStatusLoop() {
  const min = getConfig().telegram.statusIntervalMin;
  if (statusTimer) { clearTimeout(statusTimer); clearInterval(statusTimer); }
  statusTimer = null;
  if (!min || min <= 0) return;
  const periodMs = min * 60000;
  const delay = periodMs - (Date.now() % periodMs); // ke boundary berikutnya
  statusTimer = setTimeout(() => {
    sendStatusReport().catch((e) => log.warn('status report gagal:', e.message));
    statusTimer = setInterval(
      () => sendStatusReport().catch((e) => log.warn('status report gagal:', e.message)),
      periodMs
    );
  }, delay);
  log.info(`status report loop start (tiap ${min} menit, boundary wall-clock, mulai dalam ${Math.round(delay / 1000)}s)`);
}

// ===== graceful shutdown (SIGTERM/SIGINT + /stop telegram) =====

let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`shutdown: ${reason}`);
  if (screenTimer) { clearTimeout(screenTimer); clearInterval(screenTimer); }
  if (statusTimer) { clearTimeout(statusTimer); clearInterval(statusTimer); }
  positionManager.stop();
  await telegram.stopPolling();
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => log.error('unhandledRejection:', e?.message || e));

// ===== entrypoint =====

const cfg = getConfig();
log.info(`snipra v2 start | mode=${cfg.mode} | chains: ${Object.entries(cfg.chains).filter(([, c]) => c.enabled).map(([k]) => k).join(', ')}`);

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

// Hot-reload: edit config.json manual langsung dipakai siklus berikutnya tanpa pm2 restart.
// Nilai (filter, buyAmount, SL/TP, trailing) sudah dibaca live via getConfig() tiap siklus;
// hanya perubahan interval timer yang perlu restart loop.
watchConfig(({ timersChanged }) => {
  // mode paper↔live diedit manual di config.json → rebuild chain + reload state mode.
  // applyMode() no-op bila mode tidak berubah, jadi aman dipanggil tiap reload.
  applyMode();
  if (timersChanged) restartLoops();
});

screeningCycle(); // langsung jalan sekali saat boot
