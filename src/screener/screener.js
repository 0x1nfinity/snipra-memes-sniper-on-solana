import { getConfig } from '../config.js';
import { discover } from './dexscreener.js';
import { tokenSecurity } from './goplus.js';
import { evaluate, score } from './filters.js';
import { preScore, PRE_SCORE_THRESHOLD } from './preScorer.js';
import { athObserve, checkDecisionCache, storeDecisionCache, pruneExpiredDecisionCache } from '../db.js';
import { mapLimit } from '../utils.js';
import { createLogger } from '../logger.js';

const log = createLogger('screener');

// Field yang boleh dieksplorasi Darwin, dengan arah "stricter"-nya.
// Config user = BATAS KERAS: genome hanya boleh memperketat, tidak pernah melonggarkan.
const MIN_FIELDS = [
  'minVolume24hUsd', 'minAgeHours', 'minLiquidityUsd', 'minMarketCapUsd',
  'minHolders', 'minTraders24h', 'minBuySellRatio', 'minVolLiqRatio',
];
const MAX_FIELDS = ['maxAgeHours', 'maxMarketCapUsd'];

function mergeGenome(baseFilters, genes) {
  const merged = { ...baseFilters };
  for (const f of MIN_FIELDS) {
    if (genes[f] != null) merged[f] = Math.max(baseFilters[f], genes[f]);
  }
  for (const f of MAX_FIELDS) {
    if (genes[f] != null) merged[f] = Math.min(baseFilters[f], genes[f]);
  }
  return merged;
}

/**
 * Resolusi parameter exit dari genome Darwin, dengan filosofi yang sama seperti
 * mergeGenome(): config user = batas keras, genome hanya boleh memperketat (SL
 * lebih rapat ke 0, trailing mengunci profit lebih cepat/dekat) — tidak pernah
 * lebih longgar dari baseline config.
 */
export function resolveExitGenome(cfg, genes) {
  const out = {
    slPct: cfg.trading.stopLossPct,
    trailingActivateGainPct: cfg.trailing.activateGainPct,
    trailingTrailPct: cfg.trailing.trailPct,
  };
  if (Number.isFinite(genes.stopLossPct)) out.slPct = Math.max(cfg.trading.stopLossPct, genes.stopLossPct);
  if (Number.isFinite(genes.trailingActivateGainPct)) out.trailingActivateGainPct = Math.min(cfg.trailing.activateGainPct, genes.trailingActivateGainPct);
  if (Number.isFinite(genes.trailingTrailPct)) out.trailingTrailPct = Math.min(cfg.trailing.trailPct, genes.trailingTrailPct);
  return out;
}

/** harga X jam lalu diperkirakan dari priceChange DexScreener (data riil) */
function priceAgo(now, changePct) {
  if (changePct == null) return null;
  const denom = 1 + changePct / 100;
  return denom > 0 ? now / denom : null;
}

/**
 * Entry guard sniper (anti beli di pucuk) — semua dari data harga riil, tanpa flag sticky:
 * 1. SEDANG pump (h1 > maxGainH1Pct atau h24 > maxGainH24Pct) → tolak.
 * 2. PERNAH run besar (puncak >= runThresholdPct di atas harga ~24h lalu) DAN belum
 *    turun athPullbackPct dari puncak → tolak (tunggu pullback).
 * Puncak = max(harga sekarang, implied high dari priceChange, ATH terlacak).
 * Return null jika lolos, string alasan jika ditolak.
 */
function entryGuardCheck(c, guard) {
  if (!guard?.enabled) return null;
  const now = c.priceUsd;
  if (!now || now <= 0) return null;

  // implied high 24h: kalau harga sempat lebih tinggi (priceChange negatif → past > now)
  const highs = [now];
  for (const ch of [c.priceChange?.h1, c.priceChange?.h6, c.priceChange?.h24]) {
    const p = priceAgo(now, ch);
    if (p && p > now) highs.push(p);
  }
  const highEstimate = Math.max(...highs);
  const { ath } = athObserve(c.chain, c.address, highEstimate); // puncak riil terbaik yang kita tahu

  // 1. sedang pump ekstrem sekarang
  if ((c.priceChange?.h1 ?? 0) > guard.maxGainH1Pct || (c.priceChange?.h24 ?? 0) > guard.maxGainH24Pct) {
    return `sedang pump (h1 ${c.priceChange?.h1}%, h24 ${c.priceChange?.h24}%) — tunggu -${guard.athPullbackPct}% dari puncak`;
  }

  // 2. cek apakah pernah run besar (dari harga ~24h lalu ke puncak)
  const low24h = priceAgo(now, c.priceChange?.h24) || now;
  const runPct = low24h > 0 ? ((ath - low24h) / low24h) * 100 : 0;
  if (runPct >= guard.runThresholdPct) {
    const drawdownPct = ath > 0 ? ((ath - now) / ath) * 100 : 0;
    if (drawdownPct < guard.athPullbackPct) {
      return `run +${runPct.toFixed(0)}%, baru -${drawdownPct.toFixed(1)}% dari puncak $${ath.toPrecision(3)} (butuh -${guard.athPullbackPct}%)`;
    }
  }
  return null;
}

/**
 * Satu siklus screening.
 * @param {object} deps { darwin, llm, availSlots }  — darwin memberi filter aktif, llm gate opsional,
 *   availSlots membatasi jumlah kandidat akhir (hemat rate limit)
 * @returns {Promise<{candidates: object[], genomeId: string|null, scanned: number}>}
 */
export async function runScreening({ darwin, llm, availSlots } = {}) {
  const cfg = getConfig();

  // chainMap: dexscreenerId → chainKey (hanya chain yang enabled)
  const chainMap = {};
  for (const [key, c] of Object.entries(cfg.chains)) {
    if (c.enabled) chainMap[c.dexscreenerId] = key;
  }
  if (Object.keys(chainMap).length === 0) return { candidates: [], genomeId: null, scanned: 0 };

  // Filter aktif: config user = batas keras; genome darwin hanya boleh memperketat
  let filters = { ...cfg.screener.filters };
  let genomeId = null;
  let exitGenes = null;
  if (cfg.darwin.enabled && darwin) {
    const g = darwin.pickGenome();
    filters = mergeGenome(cfg.screener.filters, g.genes);
    genomeId = g.id;
    exitGenes = resolveExitGenome(cfg, g.genes);
  }

  let raw = [];
  try {
    raw = await discover(chainMap, cfg.screener.sources);
  } catch (e) {
    log.error('discovery failed:', e.message);
    return { candidates: [], genomeId, scanned: 0 };
  }

  // Pre-filter murah (tanpa GoPlus) untuk hemat rate limit
  const cheap = raw.filter((c) => {
    const f = filters;
    return (
      (c.volume24h ?? 0) >= f.minVolume24hUsd &&
      (c.liquidityUsd ?? 0) >= f.minLiquidityUsd &&
      (c.marketCap ?? 0) >= f.minMarketCapUsd &&
      (c.marketCap ?? 0) <= f.maxMarketCapUsd &&
      c.ageMinutes != null &&
      c.ageMinutes >= f.minAgeHours * 60 &&
      c.ageMinutes <= f.maxAgeHours * 60
    );
  });
  log.info(`scanned ${raw.length}, passed pre-filter ${cheap.length}`);

  // Entry guard sniper: cek pump/ATH SEBELUM enrichment (hemat rate limit).
  // Semua kandidat pre-filter tetap diamati agar ATH-nya terlacak dari waktu ke waktu.
  const guarded = [];
  for (const c of cheap) {
    const reason = entryGuardCheck(c, cfg.screener.entryGuard);
    if (reason) log.info(`${c.symbol} held by entry guard: ${reason}`);
    else guarded.push(c);
  }

  // Cap enrichment GoPlus: kalau availSlots kecil, batasi jumlah enrichment
  // agar tidak boros rate limit GoPlus
  const maxEnrich = availSlots != null
    ? Math.max(availSlots, cfg.screener.maxCandidatesPerCycle)
    : cfg.screener.maxCandidatesPerCycle * 3;
  // Enrichment GoPlus (holders + honeypot) hanya utk yang lolos guard
  // Batasi jumlah: lebih banyak dari maxCandidatesPerCycle agar filter penuh
  // punya cukup data untuk ranking, tapi tidak boros
  const toEnrich = guarded.slice(0, maxEnrich);
  await mapLimit(toEnrich, 2, async (c) => {
    const sec = await tokenSecurity(cfg.chains[c.chain], c.address);
    if (sec) {
      c.security = sec;
      c.holders = sec.holders;
      c.top10Pct = sec.top10Pct;
    }
  });

  // Filter penuh
  let passed = [];
  for (const c of guarded) {
    const res = evaluate(c, filters);
    if (res.pass) passed.push(c);
    else log.debug(`${c.symbol} rejected: ${res.reasons.join(', ')}`);
  }

  // Decision cache: skip token yang baru saja di-skip LLM & kondisi pasarnya belum bergeser
  // (hemat panggilan LLM — dicek SEBELUM pre-scorer karena tanpa biaya sama sekali).
  // Hanya aktif saat LLM enabled (otherwise pure no-op, exact behavior = sebelum task ini).
  if (cfg.llm.enabled && cfg.llm.decisionCacheEnabled) {
    pruneExpiredDecisionCache();
    passed = passed.filter((c) => {
      const cached = checkDecisionCache(c.chain, c.address, { mcap: c.marketCap, holders: c.holders });
      if (cached) {
        log.debug(`${c.symbol} skipped (decision cache: ${cached.reason || cached.verdict})`);
        return false;
      }
      return true;
    });
  }

  // Pre-scorer: gate rule-based gratis, tanpa API call tambahan.
  // Hanya aktif saat LLM enabled (otherwise pure no-op, exact behavior = sebelum task ini).
  if (cfg.llm.enabled && cfg.screener.preScoreEnabled) {
    passed = passed.filter((c) => {
      const r = preScore(c);
      c.preScore = r.score;
      if (!r.passed) log.debug(`${c.symbol} rejected by pre-scorer: score ${r.score} < ${PRE_SCORE_THRESHOLD} (${r.reasons.join(', ')})`);
      return r.passed;
    });
  }

  // Ranking dan potong sesuai slot
  passed.sort((a, b) => score(b) - score(a));
  passed = passed.slice(0, cfg.screener.maxCandidatesPerCycle);

  // LLM gate buy/skip (opsional) — token sudah lolos hard filter, default BUY.
  // Tolak HANYA jika action=skip atau confidence di bawah minConfidence.
  // Ukuran posisi TIDAK dipengaruhi LLM — selalu config.json buyAmount.
  // Kandidat digabung dalam batch (cfg.llm.batchSize) supaya hemat panggilan LLM.
  if (cfg.llm.enabled && cfg.llm.gateBuy && llm && passed.length > 0) {
    const gated = [];
    const batchSize = Math.max(1, cfg.llm.batchSize || 1);
    for (let i = 0; i < passed.length; i += batchSize) {
      const batch = passed.slice(i, i + batchSize);
      // try HANYA membungkus panggilan LLM. Kalau post-processing di bawah ikut
      // dibungkus, error di situ (mis. tulis decision cache gagal) akan salah
      // dianggap "LLM gagal" dan mendorong SELURUH batch ke `gated` untuk kedua
      // kalinya — duplikat + token yang justru di-skip LLM ikut lolos.
      let verdicts;
      try {
        verdicts = await llm.assessBatch(batch);
      } catch (e) {
        // failOpen=true (default): LLM error → seluruh batch lolos (backward compat)
        // failOpen=false: LLM error → seluruh batch ditolak (lebih aman)
        if (cfg.llm.failOpen !== false) {
          log.warn(`LLM batch failed (${batch.length} candidates), passing without gate:`, e.message);
          gated.push(...batch);
        } else {
          log.warn(`LLM batch failed (${batch.length} candidates), rejected (failOpen=false):`, e.message);
        }
        continue;
      }
      batch.forEach((c, idx) => {
        const v = verdicts[idx];
        c.llmVerdict = v;
        if (v.action === 'buy' && v.confidence >= cfg.llm.minConfidence) {
          gated.push(c);
        } else {
          log.info(`${c.symbol} rejected by LLM (${v.action}, conf ${v.confidence}): ${v.reason}`);
          if (cfg.llm.decisionCacheEnabled) {
            try {
              storeDecisionCache(c.chain, c.address, 'skip', {
                confidence: v.confidence,
                reason: v.reason,
                mcap: c.marketCap,
                holders: c.holders,
                ttlMs: cfg.llm.decisionCacheSkipTtlMin * 60000,
              });
            } catch (cacheErr) {
              log.warn(`gagal simpan decision cache utk ${c.symbol}:`, cacheErr.message);
            }
          }
        }
      });
    }
    passed = gated;
  }

  for (const c of passed) c.exitGenes = exitGenes;
  log.info(`final candidates: ${passed.map((c) => c.symbol).join(', ') || '(none)'}`);
  return { candidates: passed, genomeId, scanned: raw.length };
}
