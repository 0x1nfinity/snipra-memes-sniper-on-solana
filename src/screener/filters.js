/**
 * Evaluasi kandidat terhadap filter.
 * Field filter null = tidak dicek (dilewati).
 * Return { pass: boolean, reasons: string[] }.
 */
export function evaluate(c, f) {
  const reasons = [];
  const fail = (r) => reasons.push(r);

  // Volume 24h
  if (f.minVolume24h != null && (c.volume24h ?? 0) < f.minVolume24h)
    fail(`vol24h ${Math.round(c.volume24h)} < ${f.minVolume24h}`);
  if (f.maxVolume24h != null && (c.volume24h ?? 0) > f.maxVolume24h)
    fail(`vol24h ${Math.round(c.volume24h)} > ${f.maxVolume24h}`);

  // Liquidity
  if (f.minLiquidity != null && (c.liquidityUsd ?? 0) < f.minLiquidity)
    fail(`liq ${Math.round(c.liquidityUsd)} < ${f.minLiquidity}`);
  if (f.maxLiquidity != null && (c.liquidityUsd ?? 0) > f.maxLiquidity)
    fail(`liq ${Math.round(c.liquidityUsd)} > ${f.maxLiquidity}`);

  // Market cap
  if (f.minMarketCap != null && (c.marketCap ?? 0) < f.minMarketCap)
    fail(`mc ${Math.round(c.marketCap)} < ${f.minMarketCap}`);
  if (f.maxMarketCap != null && (c.marketCap ?? 0) > f.maxMarketCap)
    fail(`mc ${Math.round(c.marketCap)} > ${f.maxMarketCap}`);

  // Age
  if (c.ageMinutes == null) {
    if (f.minAgeMinutes != null || f.maxAgeMinutes != null)
      fail('age unknown');
  } else {
    if (f.minAgeMinutes != null && c.ageMinutes < f.minAgeMinutes)
      fail(`age ${c.ageMinutes.toFixed(0)}m < ${f.minAgeMinutes}m`);
    if (f.maxAgeMinutes != null && c.ageMinutes > f.maxAgeMinutes)
      fail(`age ${(c.ageMinutes / 60).toFixed(1)}h > ${f.maxAgeMinutes / 60}h`);
  }

  // Holders — only check when data is available
  if (c.holders != null) {
    if (f.minHolders != null && c.holders < f.minHolders)
      fail(`holders ${c.holders} < ${f.minHolders}`);
    if (f.maxHolders != null && c.holders > f.maxHolders)
      fail(`holders ${c.holders} > ${f.maxHolders}`);
  }

  // Swaps 24h
  if (f.minSwaps24h != null && (c.traders24h ?? 0) < f.minSwaps24h)
    fail(`swaps24h ${c.traders24h} < ${f.minSwaps24h}`);
  if (f.maxSwaps24h != null && (c.traders24h ?? 0) > f.maxSwaps24h)
    fail(`swaps24h ${c.traders24h} > ${f.maxSwaps24h}`);

  // Bonding progress — only check when data is available (GMGN-only field)
  if (c.bondingProgress != null) {
    if (f.minProgress != null && c.bondingProgress < f.minProgress)
      fail(`progress ${c.bondingProgress.toFixed(0)}% < ${f.minProgress}%`);
    if (f.maxProgress != null && c.bondingProgress > f.maxProgress)
      fail(`progress ${c.bondingProgress.toFixed(0)}% > ${f.maxProgress}%`);
  }

  // GMGN-specific risk filters — these fields only exist when data comes from
  // GMGN (DexScreener tokens have null for all of them). Skip the check when
  // data is unavailable rather than using conservative fallbacks that silently
  // reject every DexScreener candidate.
  if (f.maxRugRatio != null && c.rugRatio != null && c.rugRatio > f.maxRugRatio)
    fail(`rugRatio ${c.rugRatio.toFixed(2)} > ${f.maxRugRatio}`);
  if (f.maxBundlerRate != null && c.bundlerRate != null && c.bundlerRate > f.maxBundlerRate)
    fail(`bundlerRate ${c.bundlerRate.toFixed(2)} > ${f.maxBundlerRate}`);
  if (f.maxInsiderRate != null && c.insiderRate != null && c.insiderRate > f.maxInsiderRate)
    fail(`insiderRate ${c.insiderRate.toFixed(2)} > ${f.maxInsiderRate}`);
  if (f.maxTop10HolderRate != null && c.top10HolderRate != null && c.top10HolderRate > f.maxTop10HolderRate)
    fail(`top10 ${c.top10HolderRate.toFixed(0)}% > ${f.maxTop10HolderRate}%`);
  if (f.maxDevHoldRate != null && c.devHoldRate != null && c.devHoldRate > f.maxDevHoldRate)
    fail(`devHold ${c.devHoldRate.toFixed(1)}% > ${f.maxDevHoldRate}%`);
  if (f.maxBotDegenRate != null && c.botDegenRate != null && c.botDegenRate > f.maxBotDegenRate)
    fail(`botDegenRate ${c.botDegenRate.toFixed(2)} > ${f.maxBotDegenRate}`);
  if (f.maxFreshWalletRate != null && c.freshWalletRate != null && c.freshWalletRate > f.maxFreshWalletRate)
    fail(`freshWallet ${c.freshWalletRate.toFixed(2)} > ${f.maxFreshWalletRate}`);

  // Smart degen count
  if (f.minSmartDegenCount != null && c.smartDegenCount != null && c.smartDegenCount < f.minSmartDegenCount)
    fail(`smartDegen ${c.smartDegenCount} < ${f.minSmartDegenCount}`);

  // Total fee
  if (f.minTotalFee != null && c.totalFee != null && c.totalFee < f.minTotalFee)
    fail(`totalFee ${c.totalFee.toFixed(4)} < ${f.minTotalFee}`);
  if (f.maxTotalFee != null && c.totalFee != null && c.totalFee > f.maxTotalFee)
    fail(`totalFee ${c.totalFee.toFixed(4)} > ${f.maxTotalFee}`);

  // Security
  if (f.blockHoneypot && c.security?.honeypot)
    fail('honeypot (non-transferable)');
  if (f.blockWashTrading && c.security?.washTrading)
    fail('wash trading');

  return { pass: reasons.length === 0, reasons };
}

/**
 * Skor kandidat untuk ranking (semakin tinggi semakin menarik).
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
