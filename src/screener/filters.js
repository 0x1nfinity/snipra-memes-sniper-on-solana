/**
 * Evaluasi satu kandidat terhadap satu set filter.
 * Return { pass: boolean, reasons: string[] } — reasons berisi alasan gagal.
 */
export function evaluate(c, f) {
  const reasons = [];
  const fail = (r) => reasons.push(r);

  // ===== WAJIB =====
  if ((c.volume24h ?? 0) < f.minVolume24hUsd) fail(`vol24h ${Math.round(c.volume24h)} < ${f.minVolume24hUsd}`);

  if (c.ageMinutes == null) {
    fail('age unknown');
  } else {
    if (c.ageMinutes < f.minAgeHours * 60) fail(`age ${c.ageMinutes.toFixed(0)}m < ${(f.minAgeHours * 60).toFixed(0)}m`);
    if (c.ageMinutes > f.maxAgeHours * 60) fail(`age ${(c.ageMinutes / 60).toFixed(0)}h > ${f.maxAgeHours}h`);
  }

  if ((c.liquidityUsd ?? 0) < f.minLiquidityUsd) fail(`liq ${Math.round(c.liquidityUsd)} < ${f.minLiquidityUsd}`);

  if ((c.marketCap ?? 0) < f.minMarketCapUsd) fail(`mc ${Math.round(c.marketCap)} < ${f.minMarketCapUsd}`);
  if ((c.marketCap ?? 0) > f.maxMarketCapUsd) fail(`mc ${Math.round(c.marketCap)} > ${f.maxMarketCapUsd}`);

  if (c.holders == null) {
    if (f.strictSecurity) fail('holders unknown (strict)');
  } else if (c.holders < f.minHolders) {
    fail(`holders ${c.holders} < ${f.minHolders}`);
  }

  if ((c.traders24h ?? 0) < f.minTraders24h) fail(`traders24h ${c.traders24h} < ${f.minTraders24h}`);

  // ===== TAMBAHAN =====
  if (f.minBuySellRatio > 0 && (c.buySellRatio ?? 0) < f.minBuySellRatio)
    fail(`buy/sell ${c.buySellRatio?.toFixed(2)} < ${f.minBuySellRatio}`);

  if (f.maxPriceDropH1Pct > 0 && (c.priceChange?.h1 ?? 0) < -f.maxPriceDropH1Pct)
    fail(`dump h1 ${c.priceChange.h1}%`);

  if (f.minVolLiqRatio > 0 && c.liquidityUsd > 0 && c.volume24h / c.liquidityUsd < f.minVolLiqRatio)
    fail(`vol/liq ${(c.volume24h / c.liquidityUsd).toFixed(2)} < ${f.minVolLiqRatio}`);

  if (f.requireSocials && (c.socials ?? 0) === 0) fail('no socials');

  // ===== SECURITY (GoPlus) =====
  const sec = c.security;
  if (sec == null) {
    if (f.strictSecurity) fail('security data unknown (strict)');
  } else {
    if (f.blockHoneypot && sec.honeypot) fail('honeypot/freezable');
    // konsentrasi 10 holder teratas — deteksi supply terlalu terpusat (rug risk)
    if (f.maxTop10Pct > 0 && sec.top10Pct != null && sec.top10Pct > f.maxTop10Pct)
      fail(`top10 ${sec.top10Pct.toFixed(0)}% > ${f.maxTop10Pct}%`);
    else if (f.maxTop10Pct > 0 && sec.top10Pct == null && f.strictSecurity)
      fail('top10 unknown (strict)');
  }

  return { pass: reasons.length === 0, reasons };
}

/**
 * Skor kandidat untuk ranking (semakin tinggi semakin menarik).
 * Dipakai untuk memilih kandidat terbaik saat lolos lebih banyak dari slot.
 */
export function score(c) {
  let s = 0;
  s += Math.min((c.volume24h || 0) / (c.liquidityUsd || 1), 10); // aktivitas relatif
  s += Math.min((c.buySellRatio || 0), 3);
  s += (c.priceChange?.h1 || 0) > 0 ? 1 : 0;
  s += (c.priceChange?.h6 || 0) > 0 ? 1 : 0;
  s += (c.socials || 0) > 0 ? 1 : 0;
  s += Math.min((c.holders || 0) / 1000, 3);
  s += Math.min((c.boosts || 0) / 5, 2);
  return s;
}
