import { getConfig } from '../config.js';
import { discover } from './dexscreener.js';
import { tokenSecurity } from './goplus.js';
import { evaluate, score } from './filters.js';
import { preScore, PRE_SCORE_THRESHOLD } from './preScorer.js';
import { checkDecisionCache, storeDecisionCache, pruneExpiredDecisionCache } from '../db.js';
import { openPositions } from '../positions/state.js';
import { mapLimit, fetchJson } from '../utils.js';
import { createLogger } from '../logger.js';
import { discoverFromGmgn } from './gmgn-discovery.js';
import { normalizePair, bestPair, tokenPairs } from './dexscreener.js';

const log = createLogger('screener');

const MIN_FIELDS = [
  'minVolume24h', 'minLiquidity', 'minMarketCap', 'minHolders',
  'minSwaps24h', 'minAgeMinutes', 'minProgress', 'minTotalFee',
  'minSmartDegenCount',
];
const MAX_FIELDS = [
  'maxVolume24h', 'maxLiquidity', 'maxMarketCap', 'maxHolders',
  'maxSwaps24h', 'maxAgeMinutes', 'maxProgress', 'maxRugRatio',
  'maxBundlerRate', 'maxInsiderRate', 'maxTotalFee',
  'maxBotDegenRate', 'maxTop10HolderRate', 'maxDevHoldRate',
  'maxFreshWalletRate',
];

function mergeGenome(baseFilters, genes) {
  const merged = { ...baseFilters };
  for (const f of MIN_FIELDS) {
    if (genes[f] != null) merged[f] = Math.max(baseFilters[f] ?? -Infinity, genes[f]);
  }
  for (const f of MAX_FIELDS) {
    if (genes[f] != null) merged[f] = Math.min(baseFilters[f] ?? Infinity, genes[f]);
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

/**
 * Enrich harga dari GMGN token/info (utk priceUsd/priceChange), lalu WAJIB
 * DexScreener tokenPairs utk priceNative — GMGN tidak pernah menyediakan
 * priceNative. entryPrice & monitoring (manager.js:priceOf) pakai priceNative
 * sbg source of truth; kalau tidak diisi di sini, buyToken() (trade/helpers.js)
 * fallback ke priceUsd sbg entryPrice → unit mismatch (USD vs SOL) yg bikin
 * PnL/peak jadi ngaco meski entryPrice > 0 (tidak Infinity, tapi salah total).
 * Mutasi candidate langsung.
 */
async function enrichPrice(candidate) {
  let gmgnPriceUsd = null;
  let gmgnPriceChange = null;

  // GMGN token/info — priceUsd/priceChange saja, bukan priceNative.
  try {
    const ts = Math.floor(Date.now() / 1000);
    const q = new URLSearchParams({ chain: 'sol', address: candidate.address, timestamp: ts, client_id: 'snipra' });
    const info = await fetchJson(`https://openapi.gmgn.ai/v1/token/info?${q}`, {
      headers: { 'X-APIKEY': getConfig().screener.gmgnApiKeys?.[0] || '', 'Content-Type': 'application/json' },
    }, { timeoutMs: 10000, retries: 0 });
    if (info?.data?.price != null) {
      gmgnPriceUsd = Number(info.data.price) || 0;
      gmgnPriceChange = {
        m5: info.data.price_change_5m ?? 0,
        h1: info.data.price_change_1h ?? 0,
        h6: info.data.price_change_6h ?? 0,
        h24: info.data.price_change_24h ?? 0,
      };
    }
  } catch (e) {
    log.debug(`GMGN token/info failed for ${candidate.symbol}: ${e.message}`);
  }

  // DexScreener — wajib utk priceNative. Kalau pair belum terindeks,
  // priceNative tetap null dan candidate akan di-skip sebelum buy.
  try {
    const pairs = await tokenPairs('solana', candidate.address);
    const best = bestPair(pairs);
    if (best) {
      const norm = normalizePair(best, 'solana');
      if (norm) {
        candidate.priceNative = norm.priceNative;
        candidate.priceUsd = gmgnPriceUsd ?? norm.priceUsd;
        candidate.priceChange = gmgnPriceChange ?? norm.priceChange;
        return;
      }
    }
  } catch (e) {
    log.debug(`DexScreener price fallback failed for ${candidate.symbol}: ${e.message}`);
  }

  // DexScreener tidak punya pair — simpan priceUsd GMGN (display only),
  // priceNative tetap null.
  if (gmgnPriceUsd != null) {
    candidate.priceUsd = gmgnPriceUsd;
    candidate.priceChange = gmgnPriceChange;
  }
}

/**
 * Satu siklus screening.
 * @param {object} deps { darwin, llm, availSlots }
 * @returns {Promise<{candidates: object[], genomeId: string|null, scanned: number}>}
 */
export async function runScreening({ darwin, llm, availSlots } = {}) {
  const cfg = getConfig();

  // Base filters = config user (sebelum genome tightening).
  // Genome hanya tighten client-side — server-side filter harus tetap
  // pakai base config agar tidak terlalu ketat & kill semua hasil GMGN.
  const baseFilters = { ...cfg.screener.filters };
  let filters = baseFilters;
  let genomeId = null;
  let exitGenes = null;
  if (cfg.darwin.enabled && darwin) {
    const g = darwin.pickGenome();
    filters = mergeGenome(baseFilters, g.genes);
    genomeId = g.id;
    exitGenes = resolveExitGenome(cfg, g.genes);
  }

  const apiKeys = cfg.screener.gmgnApiKeys || [];
  const section = cfg.screener.section || 'new_creation';
  const launchpads = cfg.screener.filters.launchpads;
  const limit = cfg.screener.maxCandidatesPerCycle * 3;

  let candidates = [];
  // Jumlah kandidat MENTAH yang benar-benar dievaluasi (sebelum filter apapun) —
  // beda dari candidates.length di akhir yg sudah lolos semua filter/ranking/LLM.
  let scannedCount = 0;

  // === Primary: GMGN ===
  // Server-side pakai baseFilters (bukan genome-tightened) — genome
  // tightening terlalu agresif bisa bikin GMGN return kosong.
  if (cfg.screener.source === 'gmgn' && apiKeys.length > 0) {
    const result = await discoverFromGmgn({
      section,
      filters: baseFilters,
      launchpads,
      apiKeys,
      limit,
    });

    if (result.candidates.length > 0) {
      candidates = result.candidates;
      scannedCount = candidates.length;
      log.info(`GMGN ${section}: ${candidates.length} candidates received (server-side filtered)`);

      // Enrich harga: GMGN token/info → DexScreener fallback
      const maxEnrich = availSlots != null
        ? Math.max(availSlots, cfg.screener.maxCandidatesPerCycle)
        : cfg.screener.maxCandidatesPerCycle * 3;
      const toEnrich = candidates.slice(0, maxEnrich);
      await mapLimit(toEnrich, 3, enrichPrice);

      // GMGN server-side hanya filter risk/quality (buildServerFilters).
      // Market-data filter (mcap, liquidity, volume, holders, age, dst) HARUS
      // dicek client-side di sini — tanpa ini semua kandidat GMGN lolos tanpa
      // filter market data sama sekali.
      const beforeFilter = candidates.length;
      candidates = candidates.filter((c) => {
        const res = evaluate(c, filters);
        if (!res.pass) log.debug(`${c.symbol} rejected: ${res.reasons.join(', ')}`);
        return res.pass;
      });
      log.info(`GMGN client-side filter: ${candidates.length}/${beforeFilter} passed`);
    } else {
      log.warn(`GMGN returned no candidates (error: ${result.error || 'none'}), falling back to DexScreener`);
    }
  }

  // === Fallback: DexScreener ===
  if (candidates.length === 0 || cfg.screener.source === 'dexscreener') {
    const chainMap = { solana: 'solana' };

    let raw = [];
    try {
      raw = await discover(chainMap, { tokenProfiles: true, boostsLatest: true, boostsTop: true });
    } catch (e) {
      log.error('DexScreener discovery failed:', e.message);
      return { candidates: [], genomeId, scanned: 0 };
    }

    const cheap = raw.filter((c) => {
      return (
        (filters.minVolume24h == null || (c.volume24h ?? 0) >= filters.minVolume24h) &&
        (filters.minLiquidity == null || (c.liquidityUsd ?? 0) >= filters.minLiquidity) &&
        (filters.minMarketCap == null || (c.marketCap ?? 0) >= filters.minMarketCap) &&
        (filters.maxMarketCap == null || (c.marketCap ?? 0) <= filters.maxMarketCap) &&
        (filters.minAgeMinutes == null || (c.ageMinutes != null && c.ageMinutes >= filters.minAgeMinutes)) &&
        (filters.maxAgeMinutes == null || (c.ageMinutes != null && c.ageMinutes <= filters.maxAgeMinutes))
      );
    });
    scannedCount = raw.length;
    log.info(`DexScreener scanned ${raw.length}, passed pre-filter ${cheap.length}`);

    const maxEnrich = availSlots != null
      ? Math.max(availSlots, cfg.screener.maxCandidatesPerCycle)
      : cfg.screener.maxCandidatesPerCycle * 3;
    const toEnrich = cheap.slice(0, maxEnrich);
    await mapLimit(toEnrich, 2, async (c) => {
      const sec = await tokenSecurity(cfg.chains[c.chain], c.address);
      if (sec) {
        c.security = sec;
        // Jangan timpa data GMGN dengan null — GoPlus kadang tidak punya holder_count
        if (sec.holders != null) c.holders = sec.holders;
        if (sec.top10Pct != null) c.top10Pct = sec.top10Pct;
        if (sec.top10HolderRate != null) c.top10HolderRate = sec.top10HolderRate;
      }
    });

    // Kandidat di luar toEnrich tidak pernah dapat c.holders/c.security dari GoPlus
    // (masih null) — evaluate() men-SKIP (bukan gagalkan) cek holder/honeypot/wash-
    // trading kalau data null, jadi mereka akan lolos filter tanpa pernah benar-benar
    // dicek. Exclude eksplisit dari candidates alih-alih lolos diam-diam.
    const enrichedAddrs = new Set(toEnrich.map((c) => c.address));
    for (const c of cheap) {
      if (!enrichedAddrs.has(c.address)) {
        log.debug(`${c.symbol} rejected: not enriched this cycle (budget)`);
        continue;
      }
      const res = evaluate(c, filters);
      if (res.pass) candidates.push(c);
      else log.debug(`${c.symbol} rejected: ${res.reasons.join(', ')}`);
    }
    log.info(`DexScreener fallback: ${candidates.length} candidates passed filter`);
  }

  // === Common post-filter pipeline ===

  // Filter token yang sudah di-hold — jangan buang LLM analysis / buy attempt
  const heldAddrs = new Set(openPositions().map((p) => p.address.toLowerCase()));
  const before = candidates.length;
  candidates = candidates.filter((c) => !heldAddrs.has(c.address.toLowerCase()));
  if (candidates.length < before) log.info(`${before - candidates.length} already-held tokens filtered out`);

  // Decision cache
  if (cfg.llm.enabled && cfg.llm.decisionCacheEnabled) {
    pruneExpiredDecisionCache();
    candidates = candidates.filter((c) => {
      const cached = checkDecisionCache(c.chain, c.address, { mcap: c.marketCap, holders: c.holders });
      if (cached) {
        log.debug(`${c.symbol} skipped (decision cache: ${cached.reason || cached.verdict})`);
        return false;
      }
      return true;
    });
  }

  // Pre-scorer
  if (cfg.llm.enabled && cfg.screener.preScoreEnabled) {
    candidates = candidates.filter((c) => {
      const r = preScore(c);
      c.preScore = r.score;
      if (!r.passed) log.debug(`${c.symbol} rejected by pre-scorer: score ${r.score} < ${PRE_SCORE_THRESHOLD} (${r.reasons.join(', ')})`);
      return r.passed;
    });
  }

  // Ranking
  candidates.sort((a, b) => score(b) - score(a));
  candidates = candidates.slice(0, cfg.screener.maxCandidatesPerCycle);

  // LLM gate
  if (cfg.llm.enabled && cfg.llm.gateBuy && llm && candidates.length > 0) {
    const gated = [];
    const batchSize = Math.max(1, cfg.llm.batchSize || 1);
    for (let i = 0; i < candidates.length; i += batchSize) {
      const batch = candidates.slice(i, i + batchSize);
      let verdicts;
      try {
        verdicts = await llm.assessBatch(batch);
      } catch (e) {
        if (cfg.llm.failOpen !== false) {
          log.warn(`LLM batch failed (${batch.length} candidates), passing without gate:`, e.message);
          gated.push(...batch);
        } else {
          log.warn(`LLM batch failed (${batch.length} candidates), rejected (failOpen=false):`, e.message);
        }
        continue;
      }
      batch.forEach((candidate, idx) => {
        const v = verdicts[idx];
        candidate.llmVerdict = v;
        if (v.action === 'buy' && v.confidence >= cfg.llm.minConfidence) {
          gated.push(candidate);
        } else {
          log.info(`LLM rejected ${candidate.symbol} (${v.action}, conf ${v.confidence}): ${v.reason}`);
          if (cfg.llm.decisionCacheEnabled) {
            try {
              storeDecisionCache(candidate.chain, candidate.address, 'skip', {
                confidence: v.confidence,
                reason: v.reason,
                mcap: candidate.marketCap,
                holders: candidate.holders,
                ttlMs: cfg.llm.decisionCacheSkipTtlMin * 60000,
              });
            } catch (cacheErr) {
              log.warn(`failed to store decision cache for ${candidate.symbol}:`, cacheErr.message);
            }
          }
        }
      });
    }
    candidates = gated;
  }

  for (const c of candidates) c.exitGenes = exitGenes || {};
  log.info(`final candidates: ${candidates.map((c) => c.symbol).join(', ') || '(none)'}`);
  return { candidates, genomeId, scanned: scannedCount };
}
