import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from './logger.js';

const log = createLogger('config');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, '..', 'data');
const ROOT_DIR = path.join(__dirname, '..');

// Marker file: last line contains the active mode ("paper" or "live")
const MODE_FILE = path.join(DATA_DIR, '.mode');

function readModeMarker() {
  // Priority: SNIPRA_MODE env var > .mode file > default "paper"
  if (process.env.SNIPRA_MODE === 'paper' || process.env.SNIPRA_MODE === 'live') {
    return process.env.SNIPRA_MODE;
  }
  try {
    const content = fs.readFileSync(MODE_FILE, 'utf8').trim();
    if (content === 'paper' || content === 'live') return content;
  } catch { /* file doesn't exist yet */ }
  return 'paper'; // safe default
}

function writeModeMarker(mode) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MODE_FILE, `${mode}\n`);
}

/** Path ke config file untuk mode tertentu */
function configFileFor(mode) {
  return path.join(ROOT_DIR, `config.${mode}.json`);
}

/**
 * DEFAULTS = fallback bila field tidak ada di config.<mode>.json.
 * Mode is now external — stored in data/.mode marker file (not in config).
 * Semua nilai bisa diubah dua arah:
 *   - edit langsung config.<mode>.json di root (dibaca saat start)
 *   - runtime lewat Telegram: /set screener.filters.minLiquidityUsd 30000
 *     (dipersist balik ke config.<mode>.json yang sama)
 */
// Properti chain yang tidak lagi user-editable (bot ini dibuild khusus utk Solana).
// Dipasang balik ke config.chains.solana saat build agar kode konsumen (executor,
// screener, telegram, dst.) yang masih mengakses cfg.chains[...] tetap jalan.
const CHAIN_FIXED = {
  solana: {
    enabled: true,
    type: 'solana',
    dexscreenerId: 'solana',
    gmgnSlug: 'sol', // slug URL gmgn.ai/<slug>/token/<address>
    executor: 'jupiter', // 'jupiter' | 'gmgn'
    priorityFee: 'auto',
  },
};

export const DEFAULTS = {
  // 'paper' = trade simulasi penuh (harga real, saldo virtual, PnL dicatat ke SQLite)
  // 'live'  = transaksi on-chain sungguhan
  // Mode TIDAK disimpan di sini — dibaca dari data/.mode marker file.
  paper: {
    // saldo virtual awal per chain, dalam NATIVE (SOL).
    // Alternatif: startBalanceUsd (angka) utk konversi otomatis dari USD.
    startBalance: { solana: 10 },
  },
  screener: {
    maxCandidatesPerCycle: 3,
    sources: { tokenProfiles: true, boostsLatest: true, boostsTop: true },
    filters: {
      // ===== WAJIB =====
      minVolume24hUsd: 50000, // volume per hari
      minAgeHours: 0.5, // umur pair minimal, dalam jam (anti-scam menit pertama)
      maxAgeHours: 168, // umur pair maksimal (fokus memecoin baru)
      minLiquidityUsd: 20000,
      minMarketCapUsd: 100000,
      maxMarketCapUsd: 20000000,
      minHolders: 200,
      minTraders24h: 300, // jumlah transaksi (buys+sells) 24 jam
      // ===== TAMBAHAN =====
      minBuySellRatio: 0.9, // buys/sells 24h — deteksi tekanan jual
      maxPriceDropH1Pct: 25, // skip kalau sudah dump >25% dalam 1 jam
      minVolLiqRatio: 0.5, // volume24h / liquidity — deteksi liquidity zombie
      requireSocials: false,
      blockHoneypot: true, // GoPlus: is_honeypot / freezable / non-transferable
      maxTop10Pct: 85, // tolak jika 10 holder teratas menguasai > sekian % supply
      strictSecurity: false, // true = token tanpa data GoPlus langsung ditolak
    },
    // Sniper early entry guard (anti beli di pucuk) — pakai data harga riil:
    // - token yang SEDANG pump (h1 > maxGainH1Pct atau h24 > maxGainH24Pct) ditolak.
    // - token yang PERNAH run besar (>= runThresholdPct dari harga ~24h lalu ke puncak)
    //   hanya boleh entry setelah turun >= athPullbackPct dari puncak.
    // ATH diperkirakan dari harga sekarang + implied high (priceChange DexScreener),
    // jadi tidak bergantung pada observasi kita yang jarang.
    entryGuard: {
      enabled: true,
      athPullbackPct: 30,
      maxGainH1Pct: 150,
      maxGainH24Pct: 400,
      runThresholdPct: 200, // ambang "run besar" yang mengaktifkan syarat pullback
    },
    // Pre-scorer: gate rule-based GRATIS sebelum LLM (lihat src/screener/preScorer.js).
    // false = semua kandidat lolos hard filter langsung diteruskan ke LLM gate.
    preScoreEnabled: true,
  },
  trading: {
    buyAmount: 0.3, // ukuran posisi PERSIS dalam SOL (satu-satunya kontrol ukuran)
    slippageBps: 300,
    maxPositions: 20,
    minSwapUsd: 5, // tolak swap bernilai di bawah ini (buy & sizing)
    cooldownMinutes: 240, // jangan re-buy token yang sama dalam window ini
    // Token boleh di-close & di-rebuy sampai N kali dalam window cooldownMinutes
    // sebelum cooldown betul-betul memblokir; hitungan reset begitu window lewat
    // tanpa trade baru. 1 = perilaku lama (langsung cooldown setelah 1x close).
    maxTradesBeforeCooldown: 5,
    stopLossPct: -35,
    // ===== proteksi anti-glitch / flash-dump untuk STOP LOSS =====
    // Jika PnL menembus SL SEKALIGUS dengan penurunan mendadak >= slFlashDropPct
    // dalam satu tick monitor, close DITUNDA satu tick untuk konfirmasi.
    // Bila tick berikut harga pulih di atas SL → dianggap glitch/flash, dibatalkan.
    // Dump bertahap (turun pelan menembus SL) tetap di-close langsung seperti biasa.
    slFlashDropPct: 40,
    // Stop-loss dinamis berbasis proxy volatilitas (|priceChange.h1| dari DexScreener).
    // effective SL = clamp(-|h1| * multiplier, floorPct, ceilingPct); base stopLossPct
    // dipakai sebagai fallback saat data volatilitas belum ada / dynamicSl.enabled=false.
    dynamicSl: {
      enabled: true,
      multiplier: 1.5,
      floorPct: -55,
      ceilingPct: -10,
      minVolPct: 3,
      maxVolPct: 40,
    },
    maxHoldMinutes: 0, // 0 = nonaktif; total waktu hold maksimum sebelum force-close
    sidewaysTimeoutMinutes: 0, // 0 = nonaktif; force-close kalau PnL mandek terlalu lama
    sidewaysPnlBandPct: 2, // |PnL| di bawah ini dianggap "mandek" utk sideways timeout
    // Abaikan pembacaan harga dari pair dengan likuiditas < nilai ini (USD).
    // Pair likuiditas ~0 sering memberi harga sampah (sumber utama glitch).
    priceMinLiquidityUsd: 300,
    // Abaikan update harga jika lonjakan melebihi sekian % dalam satu tick (anti-glitch).
    // 0 = nonaktif, default 500% (6x). Untuk token meme baru bisa diset lebih tinggi.
    priceAnomalySpikePct: 500,
    // Biaya gas utk simulasi paper mode (estimasi per swap). Hanya relevan saat
    // mode paper — nilainya hidup di config.paper.json, bukan config.live.json.
    paperGas: { solana: 0.000005 },
  },
  tpLadder: [
    // gainPct = target profit %, sellPct = % dari sisa posisi yang dijual
    { gainPct: 40, sellPct: 30 },
    { gainPct: 100, sellPct: 40 },
    { gainPct: 250, sellPct: 50 },
  ],
  trailing: {
    enabled: true,
    // FASE PRE-TP (belum ada tier tpLadder yang kena):
    activateGainPct: 10, // trailing aktif setelah peak profit sekian %
    trailPct: 5, // turun sekian % dari peak → jual 100% (close)
    // FASE POST-TP (sudah kena tier tpLadder): trailing langsung aktif;
    // saat turun trailPct dari peak, jual sisa KECUALI moonbagPct (dari posisi awal)
    // yang dipindah ke moonbag (hold jangka panjang, keluar dari slot posisi).
    moonbagPct: 10, // 0 = tanpa moonbag, jual semua
  },
  monitor: {
    intervalSec: 20,
    // Peringatkan di log jika harga posisi tidak tersedia selama > N detik.
    // Token yang delisted/rug tidak akan punya harga DexScreener; posisi
    // dengan harga stale > threshold ini mungkin perlu pengecekan manual.
    stalePriceWarnSec: 600,
    // Cek saldo on-chain tiap posisi paling sering sekali per N detik (safety net,
    // menutup otomatis posisi yg sudah 0 saldo tapi masih tercatat terbuka). 0 = nonaktif.
    onchainReconcileSec: 60,
  },
  darwin: {
    enabled: true,
    populationSize: 8,
    evolveEveryNTrades: 20,
    mutationRate: 0.35,
    exploreRate: 0.25, // peluang memakai genome non-terbaik saat screening
    minTradesForFitness: 3,
  },
  llm: {
    enabled: false, // aktifkan via /set llm.enabled true (butuh API key)
    provider: 'openrouter', // 'openrouter' | 'deepseek'
    model: 'deepseek/deepseek-chat-v3-0324', // model OpenRouter; provider deepseek pakai 'deepseek-chat'
    // LLM = GATE buy/skip, BUKAN sizer: ukuran posisi selalu = trading.buyAmount.
    gateBuy: true, // LLM ikut menilai sebelum buy (false = langsung buy semua yang lolos filter)
    minConfidence: 0.35, // action=buy tapi confidence di bawah ini → tetap ditolak
    failOpen: true, // true = LLM error → token lolos; false = LLM error → token ditolak
    maxLessons: 12, // jumlah lesson terakhir yang diinject ke prompt
    // Decision cache: skip verdict LLM di-cache per token supaya tidak tanya
    // ulang tiap siklus screening kalau kondisi pasar belum banyak berubah.
    decisionCacheEnabled: true,
    decisionCacheSkipTtlMin: 30,
    batchSize: 5, // jumlah kandidat digabung dalam satu panggilan LLM
    cheapModel: '', // model lebih murah utk batch gate; kosong = pakai `model` yang sama
    tools: true, // izinkan LLM memanggil tool (screen/buy/sell/positions) di chat
  },
  telegram: {
    notifyScreening: true,
    notifyPriceMoves: false,
    screeningcyclemin: 60, // interval loop screening (cari kandidat baru), dalam menit
    managecyclemin: 30, // interval laporan evaluasi posisi (saldo + PnL) + notif; 0 = nonaktif
  },
};

function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) return override ?? base;
  if (typeof base !== 'object' || base === null) return override ?? base;
  const out = { ...base };
  for (const k of Object.keys(override || {})) {
    out[k] = k in base ? deepMerge(base[k], override[k]) : override[k];
  }
  return out;
}

let activeMode = null;
let config = null;
let configWatcher = null;
let watchedFiles = [];

// config.live.json = sumber tunggal untuk semua pengaturan umum (screener, llm,
// trailing, dll). config.paper.json HANYA boleh override field-field berikut;
// selebihnya selalu ikut config.live.json walau sedang mode paper.
function isPaperOverridePath(pathStr) {
  return (
    pathStr === 'paper' ||
    pathStr.startsWith('paper.') ||
    pathStr === 'trading.maxPositions' ||
    pathStr === 'trading.buyAmount' ||
    pathStr === 'trading.paperGas' ||
    pathStr.startsWith('trading.paperGas.')
  );
}

/** Build config aktif: DEFAULTS + config.live.json, lalu (kalau mode paper) di-overlay config.paper.json. */
function buildConfig(mode) {
  const liveFile = configFileFor('live');
  let liveSaved = {};
  if (fs.existsSync(liveFile)) {
    liveSaved = JSON.parse(fs.readFileSync(liveFile, 'utf8')); // biar error kalau rusak — live adalah sumber utama
  }
  let merged = deepMerge(structuredClone(DEFAULTS), liveSaved);

  if (mode === 'paper') {
    const paperFile = configFileFor('paper');
    if (fs.existsSync(paperFile)) {
      try {
        const paperSaved = JSON.parse(fs.readFileSync(paperFile, 'utf8'));
        merged = deepMerge(merged, paperSaved);
      } catch (e) {
        log.warn(`config.paper.json corrupted, paper override ignored:`, e.message);
      }
    }
  }

  // chains.solana bukan lagi field yang user-edit di file JSON — properti tetapnya
  // di-hardcode (CHAIN_FIXED), hanya buyAmount yang ikut trading.buyAmount (bisa
  // beda live/paper). Dipasang di sini biar konsumen lama (cfg.chains[...]) jalan.
  merged.chains = {
    solana: { ...CHAIN_FIXED.solana, buyAmount: merged.trading.buyAmount },
  };

  return merged;
}

function ensureConfigFiles() {
  const liveFile = configFileFor('live');
  if (!fs.existsSync(liveFile)) {
    const toSave = structuredClone(DEFAULTS);
    delete toSave.paper; // paper.startBalance cuma relevan di config.paper.json
    delete toSave.trading.paperGas; // paperGas cuma relevan di config.paper.json
    fs.writeFileSync(liveFile, JSON.stringify(toSave, null, 2));
    log.info('config.live.json missing — created with default values');
  }
  const paperFile = configFileFor('paper');
  if (!fs.existsSync(paperFile)) {
    const seed = { paper: structuredClone(DEFAULTS.paper) };
    fs.writeFileSync(paperFile, JSON.stringify(seed, null, 2));
    log.info('config.paper.json missing — created (paper override only: startBalance)');
  }
}

export function loadConfig() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  activeMode = readModeMarker();
  writeModeMarker(activeMode); // ensure file exists

  // Migrate old config.json to new split files BEFORE loading,
  // so migrated values are picked up right away.
  migrateOldConfig();
  ensureConfigFiles();

  try {
    config = buildConfig(activeMode);
    log.info(`config loaded: config.live.json${activeMode === 'paper' ? ' + config.paper.json (override)' : ''} (mode=${activeMode})`);
  } catch (e) {
    log.error(`config.live.json corrupted, using defaults:`, e.message);
    config = structuredClone(DEFAULTS);
  }

  // DRY_RUN override: jika diset, paksa paper
  if (process.env.DRY_RUN === '1' && activeMode !== 'paper') {
    log.warn(`⚠️ DRY_RUN=1 in .env FORCES mode 'paper' even though mode='${activeMode}'. Set DRY_RUN=0 for live.`);
    activeMode = 'paper';
    try {
      config = buildConfig(activeMode);
    } catch (e) {
      log.error(`config.live.json corrupted, using defaults:`, e.message);
      config = structuredClone(DEFAULTS);
    }
  }

  return config;
}

/** One-time migration: if config.json exists but config.paper.json doesn't */
function migrateOldConfig() {
  const oldFile = path.join(ROOT_DIR, 'config.json');
  const paperFile = configFileFor('paper');
  const liveFile = configFileFor('live');

  if (fs.existsSync(oldFile) && !fs.existsSync(paperFile) && !fs.existsSync(liveFile)) {
    try {
      const old = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
      // Create both paper and live configs from old unified config
      const paperCfg = deepMerge(structuredClone(DEFAULTS), { ...old, mode: undefined });
      const liveCfg = deepMerge(structuredClone(DEFAULTS), { ...old, mode: undefined });
      fs.writeFileSync(paperFile, JSON.stringify(paperCfg, null, 2));
      fs.writeFileSync(liveFile, JSON.stringify(liveCfg, null, 2));
      // Rename old file so we don't migrate again
      fs.renameSync(oldFile, `${oldFile}.migrated-${Date.now()}.bak`);
      log.info('migrated config.json → config.paper.json + config.live.json (old file backed up)');
    } catch (e) {
      log.warn('config migration failed:', e.message);
    }
  }
}

/** Tulis satu path field ke file JSON tertentu, merge dengan isi file apa adanya (bukan versi ter-resolve DEFAULTS). */
function writePathToFile(file, pathStr, value) {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* file belum ada / rusak → mulai dari kosong */ }
  const keys = pathStr.split('.');
  const last = keys.pop();
  let target = saved;
  for (const k of keys) {
    if (typeof target[k] !== 'object' || target[k] === null) target[k] = {};
    target = target[k];
  }
  target[last] = value;
  fs.writeFileSync(file, JSON.stringify(saved, null, 2));
}

/** File tujuan penyimpanan untuk sebuah path /set, tergantung mode aktif. */
function targetFileForPath(pathStr) {
  if (activeMode === 'paper' && isPaperOverridePath(pathStr)) return configFileFor('paper');
  return configFileFor('live');
}

// Path timer yang butuh restart loop (bukan sekadar nilai) kalau diubah dari disk.
const TIMER_PATHS = ['telegram.screeningcyclemin', 'monitor.intervalSec', 'telegram.managecyclemin'];

/**
 * Baca ulang config.live.json (+ config.paper.json bila mode paper) dari disk (hot-reload).
 * Dipakai agar edit manual file langsung berlaku tanpa restart proses.
 * Aman terhadap self-write (nilai sama → changed:false) & JSON setengah tertulis.
 * @returns {{changed: boolean, timersChanged: boolean}}
 */
export function reloadConfig() {
  if (!activeMode) return { changed: false, timersChanged: false };
  let next;
  try {
    next = buildConfig(activeMode);
  } catch (e) {
    log.debug('config reload skipped (JSON not valid yet):', e.message);
    return { changed: false, timersChanged: false };
  }
  const prev = config;
  const changed = JSON.stringify(next) !== JSON.stringify(prev);
  const pick = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
  const timersChanged = changed && TIMER_PATHS.some((p) => pick(next, p) !== pick(prev, p));
  config = next;
  return { changed, timersChanged };
}

/**
 * Ganti mode (paper ↔ live). Config sudah tersimpan per-field secara langsung
 * lewat setPath(), jadi di sini cukup build ulang config utk mode baru.
 */
export function switchMode(newMode) {
  if (newMode !== 'paper' && newMode !== 'live') {
    throw new Error(`invalid mode: ${newMode} (must be paper or live)`);
  }
  if (newMode === activeMode) return activeMode;

  const oldMode = activeMode;
  activeMode = newMode;
  writeModeMarker(activeMode);

  try {
    config = buildConfig(activeMode);
    log.info(`switched mode ${oldMode} → ${activeMode}, config live.json${activeMode === 'paper' ? ' + paper.json (override)' : ''}`);
  } catch (e) {
    log.error(`config.live.json corrupted during switch:`, e.message);
    config = structuredClone(DEFAULTS);
  }

  refreshWatchers();

  return activeMode;
}

export function getActiveMode() {
  return activeMode;
}

let configChangeCallback = null;

function watchFileChange(file) {
  fs.watchFile(file, { interval: 2000 }, () => {
    const res = reloadConfig();
    if (res.changed) {
      log.info(`${path.basename(file)} changed on disk — reloaded without restart`);
      configChangeCallback?.(res);
    }
  });
}

/** config.live.json selalu dipantau; config.paper.json ikut dipantau hanya saat mode paper. */
function refreshWatchers() {
  if (!configWatcher) return;
  for (const f of watchedFiles) fs.unwatchFile(f);
  watchedFiles = [configFileFor('live')];
  if (activeMode === 'paper') watchedFiles.push(configFileFor('paper'));
  for (const f of watchedFiles) watchFileChange(f);
}

/**
 * Pantau config.live.json (+ config.paper.json saat mode paper) di disk; panggil
 * reloadConfig() tiap kali berubah. Pakai watchFile (polling) agar tahan terhadap
 * simpan-atomic editor (nano/vscode).
 * onChange({changed, timersChanged}) dipanggil hanya saat ada perubahan nyata.
 */
export function watchConfig(onChange) {
  configChangeCallback = onChange;
  configWatcher = true;
  try {
    refreshWatchers();
    log.info(`config hot-reload active (watching every 2s, mode=${activeMode})`);
  } catch (e) {
    log.error('failed to set up config watcher:', e.message);
  }
}

export function getConfig() {
  return config;
}

/** get nilai via path "a.b.c" */
export function getPath(pathStr) {
  return pathStr.split('.').reduce((o, k) => (o == null ? undefined : o[k]), config);
}

/** set nilai via path "a.b.c" dengan koersi tipe; return nilai baru */
export function setPath(pathStr, rawValue) {
  let value = rawValue;
  if (typeof rawValue === 'string') {
    const s = rawValue.trim();
    if (s === 'true') value = true;
    else if (s === 'false') value = false;
    else if (s !== '' && !isNaN(Number(s))) value = Number(s);
    else if ((s.startsWith('[') || s.startsWith('{')) ) {
      try { value = JSON.parse(s); } catch { value = s; }
    }
  }
  writePathToFile(targetFileForPath(pathStr), pathStr, value);
  // Rebuild dari file (bukan cuma tempel ke in-memory) — perlu supaya field turunan
  // seperti chains.solana.buyAmount (disintesis dari trading.buyAmount) ikut sinkron.
  config = buildConfig(activeMode);
  // Notifikasi subsistem yang bergantung pada config (executor rebuild, timer restart).
  // Tanpa ini, perubahan via /set atau menu callback tidak akan diterapkan karena
  // reloadConfig() deteksi "no change" (memori sudah sama dengan file di disk).
  if (configChangeCallback) {
    const timersChanged = TIMER_PATHS.includes(pathStr);
    configChangeCallback({ changed: true, timersChanged });
  }
  return value;
}
