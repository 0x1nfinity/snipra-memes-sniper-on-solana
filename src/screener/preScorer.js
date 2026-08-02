/**
 * Pre-scorer berbasis rule, TANPA API call tambahan — semua field sudah
 * tersedia dari hasil discover()+GoPlus enrichment. Dipakai sebagai gate
 * gratis sebelum LLM (lihat legacy/src/pipeline/preScorer.js sebagai referensi
 * desain; field & bobot di sini disesuaikan ke data yang kita punya: DexScreener
 * + GoPlus, bukan GMGN smart-degen/organic-score/bundler-rate milik legacy).
 */
export const PRE_SCORE_THRESHOLD = 35;

export function preScore(c) {
  const reasons = [];
  let score = 0;

  // 1. Tekanan beli (buy/sell ratio) — 0-25
  const bsr = c.buySellRatio ?? 0;
  if (bsr >= 1.5) { score += 25; reasons.push(`buy/sell ${bsr.toFixed(2)} (kuat)`); }
  else if (bsr >= 1.1) { score += 15; reasons.push(`buy/sell ${bsr.toFixed(2)} (sedang)`); }
  else if (bsr >= 0.9) { score += 5; reasons.push(`buy/sell ${bsr.toFixed(2)} (lemah)`); }
  else { reasons.push(`buy/sell ${bsr.toFixed(2)} (jual dominan)`); }

  // 2. Aktivitas organik (volume/liquidity ratio) — 0-25
  const volLiq = c.liquidityUsd > 0 ? (c.volume24h ?? 0) / c.liquidityUsd : 0;
  if (volLiq >= 2) { score += 25; reasons.push(`vol/liq ${volLiq.toFixed(2)} (tinggi)`); }
  else if (volLiq >= 1) { score += 15; reasons.push(`vol/liq ${volLiq.toFixed(2)} (sedang)`); }
  else if (volLiq >= 0.5) { score += 5; reasons.push(`vol/liq ${volLiq.toFixed(2)} (rendah)`); }
  else { reasons.push(`vol/liq ${volLiq.toFixed(2)} (zombie)`); }

  // 3. Konsentrasi holder (top10Pct, makin kecil makin aman) — 0-20
  const top10 = c.security?.top10Pct;
  if (top10 == null) { reasons.push('top10 unknown'); }
  else if (top10 <= 40) { score += 20; reasons.push(`top10 ${top10.toFixed(0)}% (aman)`); }
  else if (top10 <= 60) { score += 12; reasons.push(`top10 ${top10.toFixed(0)}% (ok)`); }
  else if (top10 <= 85) { score += 5; reasons.push(`top10 ${top10.toFixed(0)}% (waspada)`); }
  else { reasons.push(`top10 ${top10.toFixed(0)}% (terpusat)`); }

  // 4. Jumlah holder — 0-15
  const holders = c.holders ?? 0;
  if (holders >= 1000) { score += 15; reasons.push(`holders ${holders} (banyak)`); }
  else if (holders >= 500) { score += 9; reasons.push(`holders ${holders} (cukup)`); }
  else if (holders >= 200) { score += 4; reasons.push(`holders ${holders} (minimal)`); }
  else { reasons.push(`holders ${holders} (sedikit)`); }

  // 5. Sinyal sosial — 0-10
  if ((c.socials ?? 0) > 0) { score += 10; reasons.push('punya sosial'); }
  else { reasons.push('tanpa sosial'); }

  // 6. Guard momentum harga 1h (bukan sedang dump berat, bukan blow-off top) — 0-5
  const h1 = c.priceChange?.h1 ?? 0;
  if (h1 > -15 && h1 < 100) { score += 5; reasons.push(`h1 ${h1}% (wajar)`); }
  else { reasons.push(`h1 ${h1}% (ekstrem)`); }

  return { score, passed: score >= PRE_SCORE_THRESHOLD, reasons };
}
