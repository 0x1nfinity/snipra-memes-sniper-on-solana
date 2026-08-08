export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const nowMs = () => Date.now();

export function fmtUsd(n) {
  if (n == null || isNaN(n)) return '?';
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n <= 0) return `$${n.toPrecision(4)}`;
  // Sub-$1 memecoin prices (e.g. 0.00000012345) — toPrecision(4) switches to
  // scientific notation below 1e-6, unreadable in Telegram. Format as full
  // decimal with ~4 significant digits instead.
  const exp = Math.floor(Math.log10(n));
  const decimals = 3 - exp;
  return `$${n.toFixed(decimals)}`;
}

export function fmtPct(n) {
  if (n == null || isNaN(n)) return '?';
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

/**
 * Bersihkan metadata token (symbol/name) sebelum masuk prompt LLM.
 * Metadata on-chain sepenuhnya dikontrol attacker — newline + teks yang meniru
 * instruksi bisa dipakai untuk prompt injection (khususnya di batch, di mana satu
 * token jahat bisa memanipulasi verdict token LAIN dalam batch yang sama).
 *
 * Strip yg dilakukan:
 * - newline/CR → spasi
 * - tab → spasi
 * - backtick → petik tunggal
 * - Unicode Bidi override (U+202A–U+202E) — mencegah right-to-left injection
 * - Unicode Bidi isolate (U+2066–U+2069) — mencegah directional isolation injection
 * - Zero-width space (U+200B), zero-width non-joiner (U+200C), zero-width joiner (U+200D)
 * - BOM (U+FEFF)
 */
export function sanitizePromptField(s, maxLen = 32) {
  return String(s ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\t/g, ' ')
    .replace(/`/g, "'")
    .replace(/[​-‍]/g, '')   // zero-width space, ZWNJ, ZWJ
    .replace(/[‪-‮]/g, '')   // Bidi override (LRE,RLE,PDF,LRO,RLO)
    .replace(/[⁦-⁩]/g, '')   // Bidi isolate (LRI,RLI,FSI,PDI)
    .replace(/﻿/g, '')            // BOM
    .slice(0, maxLen);
}

export function shortAddr(a) {
  if (!a) return '?';
  return a.length > 12 ? `${a.slice(0, 5)}…${a.slice(-4)}` : a;
}

/** URL token di gmgn.ai — slug per chain dari config (chains.X.gmgnSlug) */
export function gmgnUrl(gmgnSlug, address) {
  return `https://gmgn.ai/${gmgnSlug || 'sol'}/token/${address}`;
}

/** markdown link nama token → gmgn */
export function tokenLink(symbol, gmgnSlug, address) {
  return `[${(symbol || '?').replace(/[[\]]/g, '')}](${gmgnUrl(gmgnSlug, address)})`;
}

export function pnlPct(entry, current) {
  if (!entry || !current || entry <= 0) return 0;
  return ((current - entry) / entry) * 100;
}

/** fetch JSON dengan timeout + retry ringan */
export async function fetchJson(url, opts = {}, { timeoutMs = 15000, retries = 2, retryDelayMs = 1000 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(t);
      if (res.status === 429) {
        lastErr = new Error(`429 rate limited: ${url}`);
        await sleep(retryDelayMs * (i + 2));
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error(`HTTP ${res.status} ${url} :: ${body.slice(0, 300)}`);
        // Don't retry permanent client errors (400-428, 430-499)
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw err;
        }
        throw err;
      }
      return await res.json();
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      // Don't retry permanent errors even if they come from the catch block
      if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500 && e.statusCode !== 429) {
        throw e;
      }
      if (i < retries) await sleep(retryDelayMs * (i + 1));
    }
  }
  throw lastErr;
}

/** jalankan array of async fn dengan batas concurrency */
export async function mapLimit(items, limit, fn) {
  const out = [];
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        out[i] = { __error: e };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

export function randBetween(min, max) {
  return min + Math.random() * (max - min);
}

export function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Stop-loss dinamis: melebar saat volatilitas tinggi, menyempit saat rendah.
 * volPercent = proxy volatilitas (di sini: |priceChange.h1| dari DexScreener,
 * karena tidak ada sumber candle/ATR asli — lihat src/positions/manager.js).
 * Diadaptasi dari legacy/src/utils.js:199-208 (nama parameter atrPercent→volPercent
 * karena bukan ATR asli).
 *
 * baseSlPercent (user configured stopLossPct) TIDAK diabaikan — hasil akhir adalah
 * rata-rata berbobot antara base (50%) dan dynamic (50%), jadi preferensi user
 * tetap punya pengaruh bahkan saat data volatilitas tersedia.
 */
export function dynamicStopLossPercent({
  baseSlPercent, volPercent, multiplier = 1.5,
  floorPercent = -55, ceilingPercent = -10,
  minVolPercent = 3, maxVolPercent = 40,
}) {
  const base = Number(baseSlPercent);
  if (!Number.isFinite(base)) return -25;
  if (!Number.isFinite(Number(volPercent)) || Number(volPercent) <= 0) {
    return Math.max(floorPercent, Math.min(ceilingPercent, base));
  }
  const boundedVol = Math.max(minVolPercent, Math.min(maxVolPercent, Number(volPercent)));
  const dynamic = -boundedVol * multiplier;
  // Blend base (user preference) with dynamic (volatility signal)
  const blended = (base + dynamic) / 2;
  return Math.max(floorPercent, Math.min(ceilingPercent, blended));
}
