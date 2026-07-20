import { fetchJson } from '../utils.js';
import { createLogger } from '../logger.js';

const log = createLogger('goplus');
const BASE = 'https://api.gopluslabs.io/api/v1';

// Cache 10 menit — data security jarang berubah dan GoPlus punya rate limit.
const cache = new Map();
const TTL = 10 * 60 * 1000;

function cached(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  return undefined;
}

function store(key, v) {
  cache.set(key, { t: Date.now(), v });
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
 * Security + holder data untuk token EVM.
 * Return { holders, honeypot, buyTaxPct, sellTaxPct, mintable, raw } atau null jika tak ada data.
 */
export async function evmSecurity(chainIdNum, address) {
  const key = `evm:${chainIdNum}:${address.toLowerCase()}`;
  const hit = cached(key);
  if (hit !== undefined) return hit;
  try {
    const res = await fetchJson(
      `${BASE}/token_security/${chainIdNum}?contract_addresses=${address}`
    );
    const d = res?.result?.[address.toLowerCase()];
    if (!d) return store(key, null);
    return store(key, {
      holders: d.holder_count != null ? Number(d.holder_count) : null,
      top10Pct: top10Pct(d.holders),
      honeypot:
        d.is_honeypot === '1' ||
        d.cannot_sell_all === '1' ||
        d.transfer_pausable === '1',
      buyTaxPct: d.buy_tax != null && d.buy_tax !== '' ? Number(d.buy_tax) * 100 : null,
      sellTaxPct: d.sell_tax != null && d.sell_tax !== '' ? Number(d.sell_tax) * 100 : null,
      mintable: d.is_mintable === '1',
      openSource: d.is_open_source === '1',
      raw: d,
    });
  } catch (e) {
    log.warn(`evmSecurity ${address} gagal:`, e.message);
    return null; // jangan cache error
  }
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
    if (!d) return store(key, null);
    const authorityActive = (auth) =>
      Array.isArray(auth) ? auth.length > 0 : auth?.authority?.length > 0;
    return store(key, {
      holders: d.holder_count != null ? Number(d.holder_count) : null,
      top10Pct: top10Pct(d.holders),
      honeypot: authorityActive(d.freezable) || d.non_transferable === '1',
      buyTaxPct: null, // konsep tax tidak berlaku umum di SPL
      sellTaxPct: null,
      mintable: authorityActive(d.mintable),
      openSource: true,
      raw: d,
    });
  } catch (e) {
    log.warn(`solanaSecurity ${address} gagal:`, e.message);
    return null;
  }
}

export async function tokenSecurity(chainCfg, address) {
  if (chainCfg.type === 'solana') return solanaSecurity(address);
  return evmSecurity(chainCfg.chainIdNum, address);
}
