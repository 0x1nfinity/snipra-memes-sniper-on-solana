import { fetchJson } from '../utils.js';
import { createLogger } from '../logger.js';

const log = createLogger('goplus');
const BASE = 'https://api.gopluslabs.io/api/v1';

// Cache dengan LRU eviction + differentiated TTL.
// - Hasil permanen (token found / not found): TTL 10 menit
// - Network error: TTL 1 menit (retry cepat)
const cache = new Map();
const MAX_CACHE = 1000;
const TTL_PERMANENT = 10 * 60 * 1000;
const TTL_TRANSIENT = 60 * 1000;

function cached(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.t < hit.ttl) {
    // Touch: re-insert ke akhir Map (JS Map mempertahankan insertion order)
    // supaya eviction di store() benar-benar LRU (buang yg PALING LAMA
    // TIDAK DIAKSES), bukan FIFO (buang yg paling lama DIMASUKKAN).
    cache.delete(key);
    cache.set(key, hit);
    return hit.v;
  }
  // expired — hapus dan return undefined
  cache.delete(key);
  return undefined;
}

function store(key, v, transient = false) {
  // LRU eviction: hapus entry tertua jika melebihi kapasitas
  if (cache.size >= MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { t: Date.now(), v, ttl: transient ? TTL_TRANSIENT : TTL_PERMANENT });
  return v;
}

/** total persentase supply yang dipegang 10 holder teratas (0-100), atau null */
function top10Pct(holders) {
  if (!Array.isArray(holders) || holders.length === 0) return null;
  const pcts = holders
    .map((h) => Number(h.percent))
    .filter((n) => !isNaN(n))
    .sort((a, b) => b - a)
    .slice(0, 10);
  if (pcts.length === 0) return null;
  return pcts.reduce((s, p) => s + p, 0) * 100; // percent GoPlus berupa fraksi (0.05 = 5%)
}

/**
 * Security + holder data untuk token Solana.
 */
export async function solanaSecurity(address) {
  const key = `sol:${address}`;
  const hit = cached(key);
  if (hit !== undefined) return hit;
  try {
    const res = await fetchJson(`${BASE}/solana/token_security?contract_addresses=${address}`);
    const d = res?.result?.[address];
    if (!d) return store(key, null); // token not found → permanent cache
    const authorityActive = (auth) =>
      Array.isArray(auth) ? auth.length > 0 : auth?.authority?.length > 0;
    return store(key, {
      holders: d.holder_count != null ? Number(d.holder_count) : null,
      top10Pct: top10Pct(d.holders),
      top10HolderRate: top10Pct(d.holders),
      // Freeze authority ≠ honeypot. USDC, USDT, dan token besar lainnya punya
      // freeze authority resmi. Hanya blokir token yang benar-benar non-transferable.
      honeypot: d.non_transferable === '1',
      freezable: authorityActive(d.freezable),
      buyTaxPct: null, // konsep tax tidak berlaku umum di SPL
      sellTaxPct: null,
      mintable: authorityActive(d.mintable),
      openSource: true,
      raw: d,
    });
  } catch (e) {
    log.warn(`solanaSecurity ${address} failed:`, e.message);
    // Network error → short TTL agar retry cepat, bukan blackout 10 menit
    return store(key, null, true);
  }
}

export async function tokenSecurity(chainCfg, address) {
  return solanaSecurity(address);
}
