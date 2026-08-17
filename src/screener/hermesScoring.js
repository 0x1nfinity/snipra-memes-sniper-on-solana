/**
 * Hermes-style soft scoring (8-component composite ~100pts).
 *
 * Berdasarkan user-config.yaml:140-148 di hermes memes-sniper skill.
 * TIDAK PERNAH gate — hanya additive ranking. Field null/0 menghasilkan 0
 * untuk komponen tersebut (skip-on-null pattern).
 *
 * Komponen:
 *   smart_wallet_count  40 pts — min(N, 200) / 200 * 40
 *   holder_density      20 pts — min(holders/mcap*1000, 20) / 20 * 20
 *   volume_turnover     15 pts — min(vol/liq, 3) / 3 * 15
 *   top10_distribution  10 pts — (1 - top10%/45%) clamped 0-1, * 10
 *   bundle_organic      10 pts — (1 - bundle%/35%) clamped 0-1, * 10
 *   dev_holder_safe      5 pts — (1 - dev%/5%) clamped 0-1, * 5
 *   twitter_bonus        3 pts — if twitter present
 *   website_bonus        2 pts — if website present
 *
 * Return { score: number, breakdown: {component: pts, ...} }.
 */
export function hermesScore(c) {
  const b = {};

  // 1. Smart wallet count — 40 pts
  const sw = Number(c.smartDegenCount) || 0;
  b.smart_wallet_count = (Math.min(sw, 200) / 200) * 40;

  // 2. Holder density — 20 pts
  // Rumus hermes: min(holders/mcap*1000, 20) / 20 * 20
  // Efektif: low-cap + decent holder count = high density score.
  const holders = Number(c.holders) || 0;
  const mcap = Number(c.marketCap) || 1; // avoid div by 0
  const densityRaw = (holders / Math.max(mcap, 1)) * 1000;
  b.holder_density = (Math.min(densityRaw, 20) / 20) * 20;

  // 3. Volume turnover (vol/liq ratio) — 15 pts
  const vol24h = Number(c.volume24h) || 0;
  const liq = Number(c.liquidityUsd) || 1;
  const turnover = vol24h / Math.max(liq, 1);
  b.volume_turnover = (Math.min(turnover, 3) / 3) * 15;

  // 4. Top10 distribution — 10 pts (semakin rendah top10, semakin tinggi score)
  const top10Pct = Number(c.top10HolderRate);
  if (Number.isFinite(top10Pct)) {
    const norm = Math.max(0, Math.min(1, 1 - top10Pct / 45));
    b.top10_distribution = norm * 10;
  } else {
    b.top10_distribution = 0;
  }

  // 5. Bundle organic (bundle%) — 10 pts (semakin rendah bundle, semakin tinggi score)
  const bundlePct = Number(c.bundlerRate);
  if (Number.isFinite(bundlePct)) {
    // bundlerRate adalah fraction 0-1 di data kita (lihat gmgn-discovery.normalizeTrendingToken)
    const norm = Math.max(0, Math.min(1, 1 - bundlePct / 0.35));
    b.bundle_organic = norm * 10;
  } else {
    b.bundle_organic = 0;
  }

  // 6. Dev holder safe — 5 pts
  const devPct = Number(c.devHoldRate);
  if (Number.isFinite(devPct)) {
    // devHoldRate adalah percent 0-100 (lihat gmgn-discovery.normalizeTrendingToken)
    const norm = Math.max(0, Math.min(1, 1 - devPct / 5));
    b.dev_holder_safe = norm * 5;
  } else {
    b.dev_holder_safe = 0;
  }

  // 7-8. Social bonuses — 5 pts total
  b.twitter_bonus = c.socials > 0 && hasField(c, 'twitter') ? 3 : 0;
  b.website_bonus = c.socials > 0 && hasField(c, 'website') ? 2 : 0;

  const total = Object.values(b).reduce((sum, pts) => sum + pts, 0);
  return { score: Math.round(total * 100) / 100, breakdown: b };
}

/**
 * Best-effort detection: apakah field social tertentu terisi.
 * Cek di candidate langsung (untuk tokens dari GMGN trending yg punya
 * twitter_username / website fields di raw response). Kalau candidate
 * hanya punya `socials` count (mis. dari token info), kita asumsikan
 * minimal ada 1 social kalau count > 0.
 */
function hasField(c, kind) {
  if (kind === 'twitter') {
    return Boolean(c.twitter || c.twitterUsername || c.socials > 0);
  }
  if (kind === 'website') {
    return Boolean(c.website || c.socials > 0);
  }
  return false;
}