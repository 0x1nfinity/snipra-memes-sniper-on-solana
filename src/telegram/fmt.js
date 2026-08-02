import { fmtUsd, fmtPct } from '../utils.js';

// ===== helper kosmetik bersama untuk semua pesan Telegram =====

/** simbol native chain: SOL */
export function nativeSym() {
  return 'SOL';
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

/** baris data pasar token: MC · Liq · Vol24 (plain label, tanpa emoji dekoratif) */
export function marketLine(c) {
  return `MC ${fmtUsd(c.marketCap)} · Liq ${fmtUsd(c.liquidityUsd)} · Vol24 ${fmtUsd(c.volume24h)}`;
}

/** baris komunitas token: holders · age (+opsional Δ harga) */
export function communityLine(c, { withDelta = false } = {}) {
  const age = c.ageMinutes != null ? `${(c.ageMinutes / 60).toFixed(1)}h` : '?';
  let line = `Holders ${c.holders ?? '?'} · Age ${age}`;
  if (withDelta) line += ` · 1h ${fmtPct(c.priceChange?.h1)} · 24h ${fmtPct(c.priceChange?.h24)}`;
  return line;
}

/** baris verdict LLM: LLM conf 0.7 risk med — alasan (LLM = gate buy/skip, bukan sizer) */
export function llmLine(c) {
  const v = c.llmVerdict;
  if (!v) return null;
  if (v.confidence != null) {
    return `LLM conf ${v.confidence.toFixed(2)} ${v.risk} — ${v.reason}`;
  }
  return `LLM ${v.reason || ''}`;
}
