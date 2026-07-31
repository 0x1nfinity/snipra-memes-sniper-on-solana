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
export const DEFAULTS = {
  // 'paper' = trade simulasi penuh (harga real, saldo virtual, PnL dicatat ke SQLite)
  // 'live'  = transaksi on-chain sungguhan
  // Mode TIDAK disimpan di sini — dibaca dari data/.mode marker file.
  paper: {
    // saldo virtual awal per chain, dalam NATIVE (SOL/ETH).
    // Alternatif: startBalanceUsd (angka) utk konversi otomatis dari USD.
    startBalance: { solana: 10, robinhood: 1 },
  },
  chains: {
    solana: {
      enabled: true,
      type: 'solana',
      dexscreenerId: 'solana',
      gmgnSlug: 'sol', // slug URL gmgn.ai/<slug>/token/<address>
      buyAmount: 0.3, // ukuran posisi PERSIS dalam SOL (satu-satunya kontrol ukuran)
      executor: 'jupiter', // 'jupiter' | 'gmgn'
      priorityFee: 'auto',
    },
    robinhood: {
      enabled: true,
      type: 'evm',
      dexscreenerId: 'robinhood',
      gmgnSlug: 'robinhood',
      chainIdNum: 4663, // Robinhood Chain mainnet (Arbitrum Orbit, gas = ETH)
      rpcEnv: 'ROBINHOOD_RPC_URL',
      buyAmount: 0.01, // ukuran posisi PERSIS dalam ETH (satu-satunya kontrol ukuran)
      weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
      v3SwapRouter02: '0xcaf681a66d020601342297493863e78c959e5cb2',
      v3QuoterV2: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',
      v2Router: '0x89e5db8b5aa49aa85ac63f691524311aeb649eba',
      gasLimitSwap: 400000,
    },
  },
  screener: {
    intervalSec: 3600, // screening per jam — hemat API & credit LLM
    maxCandidatesPerCycle: 3,
    sources: { tokenProfiles: true, boostsLatest: true, boostsTop: true },
    filters: {
      // ===== WAJIB =====
      minVolume24hUsd: 50000, // volume per hari
      minAgeMinutes: 30, // umur pair minimal (anti-scam menit pertama)
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
  },
  trading: {
    slippageBps: 300,
    maxPositions: 20,
    maxPerChain: 10,
    minSwapUsd: 5, // tolak swap bernilai di bawah ini (buy & sizing)
    cooldownMinutes: 240, // jangan re-buy token yang sama dalam window ini
    stopLossPct: -35,
    // ===== proteksi anti-glitch / flash-dump untuk STOP LOSS =====
    // Jika PnL menembus SL SEKALIGUS dengan penurunan mendadak >= slFlashDropPct
    // dalam satu tick monitor, close DITUNDA satu tick untuk konfirmasi.
    // Bila tick berikut harga pulih di atas SL → dianggap glitch/flash, dibatalkan.
    // Dump bertahap (turun pelan menembus SL) tetap di-close langsung seperti biasa.
    slFlashDropPct: 40,
    // Abaikan pembacaan harga dari pair dengan likuiditas < nilai ini (USD).
    // Pair likuiditas ~0 sering memberi harga sampah (sumber utama glitch).
    priceMinLiquidityUsd: 300,
    // Abaikan update harga jika lonjakan melebihi sekian % dalam satu tick (anti-glitch).
    // 0 = nonaktif, default 500% (6x). Untuk token meme baru bisa diset lebih tinggi.
    priceAnomalySpikePct: 500,
    // Biaya gas untuk paper mode (estimasi per swap)
    paperGas: { solana: 0.000005, evm: 0.0001 },
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
    // LLM = GATE buy/skip, BUKAN sizer: ukuran posisi selalu = chains.<key>.buyAmount.
    gateBuy: true, // LLM ikut menilai sebelum buy (false = langsung buy semua yang lolos filter)
    minConfidence: 0.35, // action=buy tapi confidence di bawah ini → tetap ditolak
    failOpen: true, // true = LLM error → token lolos; false = LLM error → token ditolak
    maxLessons: 12, // jumlah lesson terakhir yang diinject ke prompt
    tools: true, // izinkan LLM memanggil tool (screen/buy/sell/positions) di chat
  },
  telegram: {
    notifyScreening: true,
    notifyPriceMoves: false,
    statusIntervalMin: 30, // laporan berkala (saldo + PnL); 0 = nonaktif
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

export function loadConfig() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  activeMode = readModeMarker();
  writeModeMarker(activeMode); // ensure file exists

  // Migrate old config.json to new split files BEFORE loading,
  // so migrated values are picked up right away.
  migrateOldConfig();

  const file = configFileFor(activeMode);
  if (fs.existsSync(file)) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      config = deepMerge(structuredClone(DEFAULTS), saved);
      log.info(`config loaded from config.${activeMode}.json`);
    } catch (e) {
      log.error(`config.${activeMode}.json rusak, pakai defaults:`, e.message);
      config = structuredClone(DEFAULTS);
    }
  } else {
    // First run: create config file from defaults
    config = structuredClone(DEFAULTS);
    saveConfig();
    log.info(`config.${activeMode}.json belum ada — dibuat dengan nilai default`);
  }

  // DRY_RUN override: jika diset, paksa paper
  if (process.env.DRY_RUN === '1') {
    if (activeMode !== 'paper') {
      log.warn(`⚠️ DRY_RUN=1 di .env MEMAKSA mode 'paper' walau mode='${activeMode}'. Set DRY_RUN=0 untuk live.`);
      activeMode = 'paper';
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

export function saveConfig() {
  if (!activeMode) return;
  const file = configFileFor(activeMode);
  // Strip mode if somehow present
  const toSave = { ...config };
  delete toSave.mode;
  fs.writeFileSync(file, JSON.stringify(toSave, null, 2));
}

// Path timer yang butuh restart loop (bukan sekadar nilai) kalau diubah dari disk.
const TIMER_PATHS = ['screener.intervalSec', 'monitor.intervalSec', 'telegram.statusIntervalMin'];

/**
 * Baca ulang config.<mode>.json dari disk ke objek in-memory (hot-reload).
 * Dipakai agar edit manual file langsung berlaku tanpa restart proses.
 * Aman terhadap self-write (nilai sama → changed:false) & JSON setengah tertulis.
 * @returns {{changed: boolean, timersChanged: boolean}}
 */
export function reloadConfig() {
  if (!activeMode) return { changed: false, timersChanged: false };
  const file = configFileFor(activeMode);
  if (!fs.existsSync(file)) return { changed: false, timersChanged: false };
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    log.debug('reload config dilewati (JSON belum valid):', e.message);
    return { changed: false, timersChanged: false };
  }
  const next = deepMerge(structuredClone(DEFAULTS), saved);
  delete next.mode;
  // DRY_RUN=1 forced paper mode in loadConfig() — reload doesn't change mode
  const prev = config;
  const changed = JSON.stringify(next) !== JSON.stringify(prev);
  const pick = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
  const timersChanged = changed && TIMER_PATHS.some((p) => pick(next, p) !== pick(prev, p));
  config = next;
  return { changed, timersChanged };
}

/**
 * Ganti mode (paper ↔ live). Simpan config aktif ke file, lalu load config
 * dari file mode baru. Return mode baru.
 */
export function switchMode(newMode) {
  if (newMode !== 'paper' && newMode !== 'live') {
    throw new Error(`mode tidak valid: ${newMode} (harus paper atau live)`);
  }
  if (newMode === activeMode) return activeMode;

  // Save current config first
  saveConfig();

  // Switch
  const oldMode = activeMode;
  activeMode = newMode;
  writeModeMarker(activeMode);

  // Load other config file
  const file = configFileFor(activeMode);
  if (fs.existsSync(file)) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      config = deepMerge(structuredClone(DEFAULTS), saved);
      log.info(`switched mode ${oldMode} → ${activeMode}, config loaded from config.${activeMode}.json`);
    } catch (e) {
      log.error(`config.${activeMode}.json rusak saat switch:`, e.message);
      config = structuredClone(DEFAULTS);
    }
  } else {
    // New mode has no config yet — seed from defaults
    config = structuredClone(DEFAULTS);
    saveConfig();
    log.info(`config.${activeMode}.json dibuat dari defaults (mode baru)`);
  }

  // Update watcher to track new active file
  if (configWatcher) {
    fs.unwatchFile(configFileFor(oldMode));
    fs.watchFile(configFileFor(activeMode), { interval: 2000 }, () => {
      const res = reloadConfig();
      if (res.changed) {
        log.info(`config.${activeMode}.json berubah di disk — dimuat ulang tanpa restart`);
        configChangeCallback?.(res);
      }
    });
  }

  return activeMode;
}

export function getActiveMode() {
  return activeMode;
}

let configChangeCallback = null;

/**
 * Pantau config.<mode>.json di disk; panggil reloadConfig() tiap kali berubah.
 * Pakai watchFile (polling) agar tahan terhadap simpan-atomic editor (nano/vscode).
 * onChange({changed, timersChanged}) dipanggil hanya saat ada perubahan nyata.
 */
export function watchConfig(onChange) {
  configChangeCallback = onChange;
  configWatcher = true;
  const file = configFileFor(activeMode);
  try {
    fs.watchFile(file, { interval: 2000 }, () => {
      const res = reloadConfig();
      if (res.changed) {
        log.info(`config.${activeMode}.json berubah di disk — dimuat ulang tanpa restart`);
        onChange?.(res);
      }
    });
    log.info(`hot-reload config.${activeMode}.json aktif (pantau tiap 2s)`);
  } catch (e) {
    log.error('gagal memasang watcher config:', e.message);
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
  const keys = pathStr.split('.');
  const last = keys.pop();
  let target = config;
  for (const k of keys) {
    if (typeof target[k] !== 'object' || target[k] === null) target[k] = {};
    target = target[k];
  }
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
  target[last] = value;
  saveConfig();
  // Notifikasi subsistem yang bergantung pada config (executor rebuild, timer restart).
  // Tanpa ini, perubahan via /set atau menu callback tidak akan diterapkan karena
  // reloadConfig() deteksi "no change" (memori sudah sama dengan file di disk).
  if (configChangeCallback) {
    const timersChanged = TIMER_PATHS.includes(pathStr);
    configChangeCallback({ changed: true, timersChanged });
  }
  return value;
}
