import { getConfig } from '../config.js';

/**
 * Batas jumlah posisi terbuka efektif berdasarkan activeChain.
 * - 'both':  maxPositions (total semua chain)
 * - single:  maxPerChain (hanya 1 chain yg aktif)
 */
export function effectiveMax(cfg) {
  const c = cfg || getConfig();
  return c.activeChain === 'both' ? c.trading.maxPositions : c.trading.maxPerChain;
}
