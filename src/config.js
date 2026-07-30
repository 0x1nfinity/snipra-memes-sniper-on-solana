import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from './logger.js';

const log = createLogger('config');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, '..', 'data');
// Config utama di ROOT project agar mudah diedit manual (nano/vscode).
const CONFIG_FILE = path.join(__dirname, '..', 'config.json');

/**
 * DEFAULTS = fallback bila field tidak ada di config.json.
 * Semua nilai bisa diubah dua arah:
 *   - edit langsung config.json di root (dibaca saat start)
 *   - runtime lewat Telegram: /set screener.filters.minLiquidityUsd 30000
 *     (dipersist balik ke config.json yang sama)
 */
export const DEFAULTS = {
  // 'paper' = trade simulasi penuh (harga real, saldo virtual, PnL dicatat ke SQLite)
  // 'live'  = transaksi on-chain sungguhan
  mode: 'paper',
  // 'solana' | 'robinhood' | 'both' — chain mana yang boleh open posisi baru.
  // Jika bukan 'both', batas posisi memakai trading.maxPerChain (bukan maxPositions).
  activeChain: 'both',
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

let config = structuredClone(DEFAULTS);

export function loadConfig() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      config = deepMerge(structuredClone(DEFAULTS), saved);
      log.info('config loaded from config.json (root)');
    } catch (e) {
      log.error('config.json rusak, pakai defaults:', e.message);
    }
  } else {
    saveConfig(); // generate config.json default di root saat pertama kali jalan
    log.info('config.json belum ada — dibuat dengan nilai default');
  }
  if (process.env.DRY_RUN === '1' && config.mode !== 'paper') {
    // Jangan diam-diam: config.json minta live tapi .env DRY_RUN=1 memaksa paper.
    log.warn(`⚠️ DRY_RUN=1 di .env MEMAKSA mode 'paper' walau config.json mode='${config.mode}'. Set DRY_RUN=0 untuk live.`);
  }
  if (process.env.DRY_RUN === '1') config.mode = 'paper'; // kompat lama: DRY_RUN memaksa paper
  return config;
}

export function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// Path timer yang butuh restart loop (bukan sekadar nilai) kalau diubah dari disk.
const TIMER_PATHS = ['screener.intervalSec', 'monitor.intervalSec', 'telegram.statusIntervalMin'];

/**
 * Baca ulang config.json dari disk ke objek in-memory (hot-reload).
 * Dipakai agar edit manual file langsung berlaku tanpa restart proses.
 * Aman terhadap self-write (nilai sama → changed:false) & JSON setengah tertulis.
 * @returns {{changed: boolean, timersChanged: boolean}}
 */
export function reloadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return { changed: false, timersChanged: false };
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    // editor mungkin sedang menulis (JSON belum lengkap) — lewati, poll berikut coba lagi
    log.debug('reload config.json dilewati (JSON belum valid):', e.message);
    return { changed: false, timersChanged: false };
  }
  const next = deepMerge(structuredClone(DEFAULTS), saved);
  if (process.env.DRY_RUN === '1') next.mode = 'paper';
  const prev = config;
  const changed = JSON.stringify(next) !== JSON.stringify(prev);
  const pick = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
  const timersChanged = changed && TIMER_PATHS.some((p) => pick(next, p) !== pick(prev, p));
  config = next;
  return { changed, timersChanged };
}

/**
 * Pantau config.json di disk; panggil reloadConfig() tiap kali berubah.
 * Pakai watchFile (polling) agar tahan terhadap simpan-atomic editor (nano/vscode).
 * onChange({changed, timersChanged}) dipanggil hanya saat ada perubahan nyata.
 */
export function watchConfig(onChange) {
  try {
    fs.watchFile(CONFIG_FILE, { interval: 2000 }, () => {
      const res = reloadConfig();
      if (res.changed) {
        log.info('config.json berubah di disk — dimuat ulang tanpa restart');
        onChange?.(res);
      }
    });
    log.info('hot-reload config.json aktif (pantau tiap 2s)');
  } catch (e) {
    log.error('gagal memasang watcher config.json:', e.message);
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
  return value;
}
