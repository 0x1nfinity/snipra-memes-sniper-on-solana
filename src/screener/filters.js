/**
 * Filter kandidat.
 *
 * evaluate() = hard gate. Sekarang HANYA berisi security flags
 * (blockHoneypot / blockWashTrading) — semua threshold numeric (volume,
 * liquidity, mcap, holders, age, fee, dll) sudah dipindah ke softScore()
 * sebagai SOFT scoring (additive ranking only), sesuai refactor Hermes-style:
 *
 *   - Hermes 11 thresholds (hard)  → gmgn-cli market trending server-side flag
 *   - Non-Hermes snipra thresholds → softScore() di sini, TIDAK gate
 *   - Hermes 8 scoring weights      → hermesScore() di src/screener/hermesScoring.js
 *
 * Caller (screener.js) menjalankan evaluate() dulu (reject kalau honeypot/
 * washTrading). Setelah itu, softScore + hermesScore dipakai untuk ranking.
 * LLM gate tetap jadi gate terakhir untuk buy/skip.
 */
export function evaluate(c, f) {
  const reasons = [];
  const fail = (r) => reasons.push(r);

  // ===== Security flags (hard gate — bukan threshold) =====
  if (f.blockHoneypot && c.security?.honeypot)
    fail('honeypot (non-transferable)');
  if (f.blockWashTrading && c.security?.washTrading)
    fail('wash trading');

  return { pass: reasons.length === 0, reasons };
}

/**
 * Skor kandidat untuk ranking (semakin tinggi semakin menarik).
 * Skor lama — dipakai sebagai baseline ranking (volume/liq/holders/rug/...).
 */
export function score(c) {
  let s = 0;
  s += Math.min((c.volume24h || 0) / Math.max(c.liquidityUsd || 1, 1), 10);
  s += Math.min((c.buySellRatio || 0), 3);
  s += Math.min((c.holders || 0) / 1000, 3);
  s += Math.min((c.smartDegenCount || 0), 5);
  s += Math.min((c.renownedCount || 0), 3);
  s -= Math.min((c.rugRatio || 0) * 10, 10);
  s -= Math.min((c.bundlerRate || 0) * 5, 5);
  s -= Math.min((c.insiderRate || 0) * 5, 5);
  s += Math.min((c.botDegenCount || 0) / 10, 3);
  s += (c.totalFee || 0) > 0 ? 2 : 0;
  s += (c.socials || 0) > 0 ? 1 : 0;
  s += (c.bondingProgress || 0) > 80 ? 2 : 0;
  s += (c.priceChange?.h1 || 0) > 0 ? 1 : 0;
  s += (c.priceChange?.h24 || 0) > 0 ? 1 : 0;
  return s;
}

/**
 * Soft scoring — non-Hermes snipra thresholds sebagai additive ranking.
 *
 * TIDAK PERNAH reject. Hanya menambahkan/mengurangi poin dari ranking score
 * berdasarkan seberapa banyak threshold yg terpenuhi. Threshold yg TIDAK
 * terpenuhi mengurangi poin (penalty), TIDAK menyebabkan gate.
 *
 * Bobot dirancang sehingga:
 *   - Threshold vital (liquidity, holders) bobot lebih besar
 *   - Threshold ekstrim (maxProgress, maxTotalFee) bobot kecil
 *   - Bonus social/age jika melampaui minimum
 *
 * Input: candidate + config filters (sama dg yg sebelumnya dipakai evaluate()).
 * Return: { score: number, breakdown: {field: pts, ...} }
 */
export function softScore(c, f) {
  const breakdown = {};
  const add = (key, pts, reason) => {
    breakdown[key] = (breakdown[key] || 0) + pts;
    if (reason) breakdown[`${key}__why`] = reason;
  };

  // === Volume 24h ===
  if (f.minVolume24h != null) {
    const v = c.volume24h ?? 0;
    if (v >= f.minVolume24h) {
      const headroom = Math.min((v / f.minVolume24h - 1), 3); // up to 3x bonus
      add('volume', 5 + headroom * 2, `vol24h $${Math.round(v)} ≥ $${f.minVolume24h}`);
    } else {
      add('volume', -8, `vol24h $${Math.round(v)} < $${f.minVolume24h}`);
    }
  }
  if (f.maxVolume24h != null && (c.volume24h ?? 0) > f.maxVolume24h) {
    add('volume_cap', -3, `vol24h $${Math.round(c.volume24h)} > $${f.maxVolume24h}`);
  }

  // === Liquidity ===
  if (f.minLiquidity != null) {
    const v = c.liquidityUsd ?? 0;
    if (v >= f.minLiquidity) {
      const headroom = Math.min((v / f.minLiquidity - 1), 2);
      add('liquidity', 5 + headroom * 2, `liq $${Math.round(v)} ≥ $${f.minLiquidity}`);
    } else {
      add('liquidity', -10, `liq $${Math.round(v)} < $${f.minLiquidity}`);
    }
  }
  if (f.maxLiquidity != null && (c.liquidityUsd ?? 0) > f.maxLiquidity) {
    add('liquidity_cap', -3, `liq > $${f.maxLiquidity}`);
  }

  // === Market cap ===
  if (f.minMarketCap != null) {
    const v = c.marketCap ?? 0;
    if (v >= f.minMarketCap) {
      add('mcap', 4, `mc $${Math.round(v)} ≥ $${f.minMarketCap}`);
    } else {
      add('mcap', -8, `mc $${Math.round(v)} < $${f.minMarketCap}`);
    }
  }
  if (f.maxMarketCap != null && (c.marketCap ?? 0) > f.maxMarketCap) {
    add('mcap_cap', -4, `mc > $${f.maxMarketCap}`);
  }

  // === Holders ===
  if (f.minHolders != null) {
    const v = c.holders ?? 0;
    if (v >= f.minHolders) {
      add('holders', 4, `holders ${v} ≥ ${f.minHolders}`);
    } else {
      add('holders', -6, `holders ${v} < ${f.minHolders}`);
    }
  }
  if (f.maxHolders != null && (c.holders ?? 0) > f.maxHolders) {
    add('holders_cap', -2, `holders > ${f.maxHolders}`);
  }

  // === Age (menit) ===
  if (f.minAgeMinutes != null && c.ageMinutes != null) {
    if (c.ageMinutes >= f.minAgeMinutes) add('age_min', 2, `age ≥ ${f.minAgeMinutes}m`);
    else add('age_min', -4, `age < ${f.minAgeMinutes}m`);
  }
  if (f.maxAgeMinutes != null && c.ageMinutes != null && c.ageMinutes > f.maxAgeMinutes) {
    add('age_max', -2, `age > ${f.maxAgeMinutes / 60}h`);
  }

  // === Swaps 24h ===
  if (f.minSwaps24h != null) {
    const v = c.traders24h ?? 0;
    if (v >= f.minSwaps24h) add('swaps', 3, `swaps24h ${v} ≥ ${f.minSwaps24h}`);
    else add('swaps', -5, `swaps24h ${v} < ${f.minSwaps24h}`);
  }

  // === Bonding progress (Pump.fun / launchpad) ===
  if (f.minProgress != null && c.bondingProgress != null) {
    if (c.bondingProgress >= f.minProgress) add('progress_min', 2);
    else add('progress_min', -4, `progress < ${f.minProgress}%`);
  }
  if (f.maxProgress != null && c.bondingProgress != null && c.bondingProgress > f.maxProgress) {
    add('progress_max', -2);
  }

  // === Risk fields (non-Hermes) ===
  // maxRugRatio, maxInsiderRate, maxBotDegenRate, maxFreshWalletRate:
  // Hermes tdk cover → soft penalty. blockHoneypot/blockWashTrading sudah hard gate.
  if (f.maxRugRatio != null && c.rugRatio != null && c.rugRatio > f.maxRugRatio) {
    add('rug', -10, `rugRatio ${c.rugRatio.toFixed(2)} > ${f.maxRugRatio}`);
  }
  if (f.maxInsiderRate != null && c.insiderRate != null && c.insiderRate > f.maxInsiderRate) {
    add('insider', -8, `insiderRate ${c.insiderRate.toFixed(2)} > ${f.maxInsiderRate}`);
  }
  if (f.maxBotDegenRate != null && c.botDegenRate != null && c.botDegenRate > f.maxBotDegenRate) {
    add('bot_degen', -6, `botDegen ${c.botDegenRate.toFixed(2)} > ${f.maxBotDegenRate}`);
  }
  if (f.maxFreshWalletRate != null && c.freshWalletRate != null && c.freshWalletRate > f.maxFreshWalletRate) {
    add('fresh_wallet', -4, `freshWallet > ${f.maxFreshWalletRate}`);
  }

  // === Fees ===
  if (f.minTotalFee != null && c.totalFee != null && c.totalFee < f.minTotalFee) {
    add('fee_min', -3, `totalFee ${c.totalFee.toFixed(4)} < ${f.minTotalFee}`);
  }
  if (f.maxTotalFee != null && c.totalFee != null && c.totalFee > f.maxTotalFee) {
    add('fee_max', -3, `totalFee > ${f.maxTotalFee}`);
  }

  const total = Object.entries(breakdown)
    .filter(([k]) => !k.includes('__why'))
    .reduce((sum, [, pts]) => sum + pts, 0);
  return { score: total, breakdown };
}