import { getConfig } from '../config.js';
import { fmtUsd, fmtPct } from '../utils.js';

// ===== helper kosmetik bersama untuk semua pesan Telegram =====

const CHAIN_EMOJI = { solana: '🟪', robinhood: '🟩' };

export function chainEmoji(chainKey) {
  return CHAIN_EMOJI[chainKey] || '⛓';
}

/** header blok chain: ━━ 🟪 SOLANA ━━ */
export function chainHeader(chainKey) {
  return `━━ ${chainEmoji(chainKey)} *${chainKey.toUpperCase()}* ━━`;
}

/** simbol native chain: SOL / ETH */
export function nativeSym(chainKey) {
  return getConfig().chains[chainKey]?.type === 'solana' ? 'SOL' : 'ETH';
}

/** format angka native bertanda: +0.0123 SOL */
export function fmtNative(n, chainKey) {
  return `${n >= 0 ? '+' : ''}${n.toFixed(4)} ${nativeSym(chainKey)}`;
}

/** durasi sejak timestamp: 87m / 3.2h / 2.1d */
export function fmtHold(fromTs) {
  const min = (Date.now() - fromTs) / 60000;
  if (min < 90) return `${Math.round(min)}m`;
  if (min < 60 * 36) return `${(min / 60).toFixed(1)}h`;
  return `${(min / 1440).toFixed(1)}d`;
}

/** baris data pasar token: 💰 MC · 💧 Liq · 📊 Vol24 */
export function marketLine(c) {
  return `💰 MC ${fmtUsd(c.marketCap)} · 💧 Liq ${fmtUsd(c.liquidityUsd)} · 📊 Vol24 ${fmtUsd(c.volume24h)}`;
}

/** baris komunitas token: 👥 holders · ⏱ age (+opsional Δ harga) */
export function communityLine(c, { withDelta = false } = {}) {
  const age = c.ageMinutes != null ? `${(c.ageMinutes / 60).toFixed(1)}h` : '?';
  let line = `👥 ${c.holders ?? '?'} · ⏱ ${age}`;
  if (withDelta) line += ` · Δ1h ${fmtPct(c.priceChange?.h1)} · Δ24h ${fmtPct(c.priceChange?.h24)}`;
  return line;
}

/** baris verdict LLM: 🧠 conf 0.7 · risk med — alasan (LLM = gate buy/skip, bukan sizer) */
export function llmLine(c) {
  const v = c.llmVerdict;
  if (!v) return null;
  if (v.confidence != null) {
    return `🧠 conf ${v.confidence.toFixed(2)} · ${v.risk} — ${v.reason}`;
  }
  return `🧠 ${v.reason || ''}`;
}

/**
 * Susun blok per chain dengan header + baris kosong antar item.
 * itemsByChain: { chainKey: [teksItem, ...] }
 */
export function chainBlocks(itemsByChain, { gapBetweenItems = true } = {}) {
  const sep = gapBetweenItems ? '\n\n' : '\n';
  return Object.keys(itemsByChain)
    .sort()
    .map((ck) => `${chainHeader(ck)}\n\n${itemsByChain[ck].join(sep)}`)
    .join('\n\n');
}
