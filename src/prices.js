import { tokensBatch } from './screener/dexscreener.js';
import { getConfig } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('prices');
const WSOL = 'So11111111111111111111111111111111111111112';

const cache = new Map(); // chainKey → { t, price }
const _inflight = new Map(); // chainKey → Promise<number> — deduplication for concurrent callers
const TTL = 60 * 1000;

/**
 * Harga native chain (SOL) dalam USD via DexScreener, cache 60 detik.
 * Dipakai untuk sizing swap berbasis USD dan konversi saldo paper.
 */
export async function nativePriceUsd(chainKey) {
  const hit = cache.get(chainKey);
  if (hit && Date.now() - hit.t < TTL) return hit.price;

  // Return in-flight promise if one is already fetching
  const inflight = _inflight.get(chainKey);
  if (inflight) return inflight;

  const promise = (async () => {
    const chainCfg = getConfig().chains[chainKey];
    if (!chainCfg) throw new Error(`chain ${chainKey} unknown`);
    const addr = WSOL;

    const pairs = await tokensBatch(chainCfg.dexscreenerId, [addr]);
    let best = null;
    for (const p of pairs) {
      const liq = p?.liquidity?.usd || 0;
      let price = null;
      if (p?.baseToken?.address?.toLowerCase() === addr.toLowerCase()) {
        price = Number(p.priceUsd);
      } else if (p?.quoteToken?.address?.toLowerCase() === addr.toLowerCase()) {
        // token dihargai dalam native: USD per native = priceUsd / priceNative
        const pn = Number(p.priceNative);
        if (pn > 0) price = Number(p.priceUsd) / pn;
      }
      if (price > 0 && (!best || liq > best.liq)) best = { price, liq };
    }
    if (!best) throw new Error(`native price for ${chainKey} not available on DexScreener`);
    cache.set(chainKey, { t: Date.now(), price: best.price });
    log.debug(`${chainKey} native = $${best.price.toFixed(2)}`);
    return best.price;
  })();

  _inflight.set(chainKey, promise);
  try {
    return await promise;
  } finally {
    _inflight.delete(chainKey);
  }
}
