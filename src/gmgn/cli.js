/**
 * GMGN subprocess helper — single chokepoint untuk semua call ke gmgn-cli.
 *
 * auth:
 *   - GMGN_API_KEYS (plural, comma-separated) dibaca dari project's .env
 *   - 3 keys dialokasikan by purpose utk hindari rate-limit:
 *       key[0] = screening  (gmgn-cli market trending, heavy 1×/60m)
 *       key[1] = manage     (gmgn-cli token info utk screening enrichment)
 *       key[2] = pnl        (gmgn-cli token info polling tiap 10s per posisi)
 *   - GMGN_PRIVATE_KEY (kalau ada) diteruskan juga untuk live swap
 *
 * hermes-style mapping:
 *   fetchTrending  → gmgn-cli market trending  (screening source)
 *   fetchTokenInfo → gmgn-cli token info       (enrichment + monitoring)
 *   fetchTokenPrice → light wrapper            (PnL polling primary)
 *
 * Output GMGN adalah snake_case JSON. Caller mapping ke camelCase di caller
 * masing-masing (gmgn-discovery.js, screener.js, manager.js).
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '../logger.js';

const execFileP = promisify(execFile);
const log = createLogger('gmgn-cli');

const TIMEOUT_MS = 15000;
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 500;
const MAX_BUFFER = 10 * 1024 * 1024; // 10MB — trending batch bisa besar

// Purpose → index di GMGN_API_KEYS (comma-separated).
// Dipakai agar 3 key yg ada di .env TIDAK share rate-limit budget:
//   screening = key[0]   market trending 1×/60m (heavy batch)
//   manage    = key[1]   token info enrichment (per candidate pas screening)
//   pnl       = key[2]   token info polling tiap tick per posisi
const PURPOSE_INDEX = { screening: 0, manage: 1, pnl: 2 };

/**
 * Ambil key by purpose dari GMGN_API_KEYS env var.
 * Kalau purpose tidak dikenal atau key di index itu kosong → fallback ke key[0].
 * Return string kosong kalau GMGN_API_KEYS kosong (caller decide what to do).
 */
export function getGmgnApiKey({ purpose } = {}) {
  const keys = (process.env.GMGN_API_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) return '';
  const idx = PURPOSE_INDEX[purpose] ?? 0;
  // Fallback ke key[0] kalau key untuk purpose ini tidak ada (mis. user cuma isi 1 key)
  return keys[idx] || keys[0] || '';
}

/** Subprocess env: inherit parent + inject GMGN_API_KEY by purpose + GMGN_PRIVATE_KEY. */
function buildEnv(purpose) {
  const env = { ...process.env };
  const key = getGmgnApiKey({ purpose });
  if (key) env.GMGN_API_KEY = key;
  if (process.env.GMGN_PRIVATE_KEY) env.GMGN_PRIVATE_KEY = process.env.GMGN_PRIVATE_KEY;
  return env;
}

/**
 * Eksekusi gmgn-cli dg retry+backoff. Throw pada error terminal.
 * @param {string[]} args  argumen setelah 'gmgn-cli'
 * @param {{purpose?: 'screening'|'manage'|'pnl', timeoutMs?: number}} [opts]
 */
async function exec(args, opts = {}) {
  const purpose = opts.purpose;
  const env = buildEnv(purpose);
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { stdout } = await execFileP('gmgn-cli', args, {
        env,
        timeout: timeoutMs,
        maxBuffer: MAX_BUFFER,
      });
      if (!stdout) throw new Error('gmgn-cli returned empty stdout');
      return JSON.parse(stdout);
    } catch (e) {
      lastErr = e;
      const cmdTag = args.slice(0, 2).join(' ');
      const reason = e.code === 'ENOENT'
        ? 'gmgn-cli not found in PATH'
        : e.code || (e.stderr || e.message || '').split('\n')[0].slice(0, 120);
      log.debug(`gmgn-cli ${cmdTag} purpose=${purpose || 'screening'} attempt ${attempt}/${MAX_RETRIES} failed: ${reason}`);
      if (attempt < MAX_RETRIES) await new Promise((r) => setTimeout(r, RETRY_BASE_MS * attempt));
    }
  }
  throw lastErr;
}

// === Hermes 11 thresholds → CLI flag translator ===
// Caller mengirim config filters (snipra camelCase keys, units: USD/percent/jam).
// Kita konversi ke unit GMGN (desimal 0-1, duration string). TIDAK ada client-side
// fallback di sini: bila GMGN menerima threshold, dia yg hard-filter di server.
// Caller boleh filter lagi dengan evaluate() / softScore() kalau perlu.
//
// Mapping:
//   minVolume24h         (USD)    → --min-volume
//   minLiquidity         (USD)    → --min-liquidity
//   minMarketCap         (USD)    → --min-marketcap
//   minHolders           (count)  → --min-holder-count
//   minSmartDegenCount   (count)  → --min-smart-degen-count
//   maxBundlerRate       (0-1)    → --max-bundler-rate (fraction, no convert)
//   maxTop10HolderRate   (0-100)  → --max-top10-holder-rate (pct → fraction)
//   maxDevHoldRate       (0-100)  → --max-dev-team-hold-rate (pct → fraction)
//   minAgeHours / maxAgeHours (jam) → --min-created / --max-created
//   filters.launchpads   (string[]) → --platform X (repeatable)
function buildTrendingArgs({ interval = '1h', filters = {}, launchpads = [], limit = 100 }) {
  const args = ['market', 'trending', '--chain', 'sol', '--interval', interval, '--limit', String(limit)];
  for (const lp of launchpads) args.push('--platform', lp);
  if (filters.minVolume24h != null) args.push('--min-volume', String(filters.minVolume24h));
  if (filters.minLiquidity != null) args.push('--min-liquidity', String(filters.minLiquidity));
  if (filters.minMarketCap != null) args.push('--min-marketcap', String(filters.minMarketCap));
  if (filters.minHolders != null) args.push('--min-holder-count', String(filters.minHolders));
  if (filters.minSmartDegenCount != null) args.push('--min-smart-degen-count', String(filters.minSmartDegenCount));
  if (filters.maxBundlerRate != null) args.push('--max-bundler-rate', String(filters.maxBundlerRate));
  if (filters.maxTop10HolderRate != null) args.push('--max-top10-holder-rate', String(filters.maxTop10HolderRate / 100));
  if (filters.maxDevHoldRate != null) args.push('--max-dev-team-hold-rate', String(filters.maxDevHoldRate / 100));
  if (filters.minAgeHours != null) args.push('--min-created', `${filters.minAgeHours}h`);
  if (filters.maxAgeHours != null) args.push('--max-created', `${filters.maxAgeHours}h`);
  args.push('--raw');
  return args;
}

// === Public API ===

/**
 * Screening source — gmgn-cli market trending.
 * Pakai key[0] (screening key). 1 call per siklus screening (60m default).
 * @returns {Promise<object[]>} array of raw token objects (snake_case).
 *          Caller (gmgn-discovery.js) melakukan mapping ke candidate shape.
 */
export async function fetchTrending({ interval, filters, launchpads, limit } = {}) {
  const args = buildTrendingArgs({ interval, filters, launchpads, limit });
  const res = await exec(args, { purpose: 'screening' });
  if (res?.code !== 0) {
    throw new Error(`gmgn-cli trending failed: code=${res.code} message=${res?.message || 'unknown'}`);
  }
  return res?.data?.rank ?? [];
}

/**
 * Token enrichment & monitoring — gmgn-cli token info.
 * Pakai key[1] (manage key) by default — enrichment di screening cycle.
 *
 * Response shape: langsung data token (address, symbol, price, liquidity, dst) —
 * TIDAK dibungkus {code, data} seperti trending. Kalau ada `code !== 0` di root,
 * treat sebagai error.
 * @param {string} address
 * @param {{purpose?: 'screening'|'manage'|'pnl'}} [opts]
 */
export async function fetchTokenInfo(address, opts = {}) {
  const args = ['token', 'info', '--chain', 'sol', '--address', address, '--raw'];
  const res = await exec(args, { ...opts, purpose: opts.purpose || 'manage' });
  if (res && typeof res === 'object' && 'code' in res && res.code !== 0) {
    throw new Error(`gmgn-cli token info failed: code=${res.code} message=${res?.message || 'unknown'}`);
  }
  return res;
}

/**
 * Light price-only fetch — mengembalikan {priceUsd, source} dari price.price.
 * Pakai key[2] (pnl key) — polling tiap tick (10s) per posisi, jadi butuh
 * rate-limit budget sendiri agar tidak menggangu screening/manage.
 * Returns null kalau GMGN return data tanpa price valid (token baru di luar coverage).
 * Caller fallback ke Jupiter atau DexScreener bila null.
 * @param {string} address
 * @param {{purpose?: 'pnl'}} [opts]
 */
export async function fetchTokenPrice(address, opts = {}) {
  try {
    const info = await fetchTokenInfo(address, { ...opts, purpose: opts.purpose || 'pnl' });
    const priceUsd = Number(info?.price?.price);
    if (Number.isFinite(priceUsd) && priceUsd > 0) return { priceUsd, source: 'gmgn-cli' };
  } catch (e) {
    log.debug(`fetchTokenPrice(${address.slice(0, 6)}) failed: ${e.message}`);
  }
  return null;
}

/**
 * Health check: apakah ada minimal 1 key di GMGN_API_KEYS?
 * (gmgn-cli config --check membaca ~/.config/gmgn/.env — kita cek project .env saja.)
 */
export async function healthCheck() {
  return Boolean(getGmgnApiKey({ purpose: 'screening' }));
}