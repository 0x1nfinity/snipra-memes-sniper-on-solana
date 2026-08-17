import { getConfig } from '../config.js';
import { discover } from './dexscreener.js';
import { tokenSecurity } from './goplus.js';
import { evaluate, score, softScore } from './filters.js';
import { preScore } from './preScorer.js';
import { hermesScore } from './hermesScoring.js';
import { checkDecisionCache, storeDecisionCache, pruneExpiredDecisionCache } from '../db.js';
import { openPositions } from '../positions/state.js';
import { mapLimit, sleep } from '../utils.js';
import { createLogger } from '../logger.js';
import { discoverFromGmgn } from './gmgn-discovery.js';
import { normalizePair, bestPair, tokenPairs } from './dexscreener.js';
import { fetchTokenInfo as cliFetchTokenInfo } from '../gmgn/cli.js';

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
 *
 * Sumber GMGN: gmgn-cli subprocess via src/gmgn/cli.js (lihat juga _refreshPrices
 * di manager.js yg juga pakai CLI sbg primary PnL source).
 */
async function enrichPrice(candidate) {
  let gmgnPriceUsd = null;
  let gmgnPriceChange = null;

  // GMGN token/info via subprocess — priceUsd/priceChange saja, bukan priceNative.
  try {
    const info = await cliFetchTokenInfo(candidate.address, { purpose: 'manage' });
    const p = info?.price || {};
    const pxUsd = Number(p.price);
    if (Number.isFinite(pxUsd) && pxUsd > 0) {
      gmgnPriceUsd = pxUsd;
      gmgnPriceChange = {
        m5: p.price_change_5m != null ? Number(p.price_change_5m) : 0,
        h1: p.price_change_1h != null ? Number(p.price_change_1h) : 0,
        h6: p.price_change_6h != null ? Number(p.price_change_6h) : 0,
        h24: p.price_change_24h != null ? Number(p.price_change_24h) : 0,
      };
    }
  } catch (e) {
    log.debug(`gmgn-cli token info failed for ${candidate.symbol}: ${e.message}`);
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
 * Retry DexScreener utk candidate yang sudah lolos semua filter tapi priceNative
 * masih kosong (pair belum terindeks saat enrichPrice() pertama). TIDAK derive dari
 * priceUsd — cuma re-fetch data asli dari market, kasih waktu DexScreener nge-index
 * pool yang baru banget dibuat. Dipanggil sesaat sebelum buy, jadi cuma kena candidate
 * yang benar-benar mau dieksekusi (bukan semua 80 kandidat mentah).
 * @returns {Promise<boolean>} true kalau priceNative berhasil didapat.
 */
export async function retryPriceNative(candidate, { attempts = 3, delayMs = 3000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    await sleep(delayMs);
    try {
      const pairs = await tokenPairs('solana', candidate.address);
      const best = bestPair(pairs);
      if (best) {
        const norm = normalizePair(best, 'solana');
        if (norm?.priceNative > 0) {
          candidate.priceNative = norm.priceNative;
          candidate.priceUsd = norm.priceUsd ?? candidate.priceUsd;
          candidate.priceChange = norm.priceChange ?? candidate.priceChange;
          log.info(`${candidate.symbol}: priceNative recovered on retry ${i + 1}/${attempts}`);
          return true;
        }
      }
    } catch (e) {
      log.debug(`retryPriceNative ${candidate.symbol} attempt ${i + 1} failed: ${e.message}`);
    }
  }
  return false;
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

  const launchpads = cfg.screener.filters.launchpads;
  const interval = cfg.screener.marketInterval || '1h';
  const limit = cfg.screener.maxCandidatesPerCycle * 3;

  let candidates = [];
  // Jumlah kandidat MENTAH yang benar-benar dievaluasi (sebelum filter apapun) —
  // beda dari candidates.length di akhir yg sudah lolos semua filter/ranking/LLM.
  let scannedCount = 0;

  // === Primary: GMGN ===
  // Server-side pakai baseFilters (bukan genome-tightened) — genome
  // tightening terlalu agresif bisa bikin GMGN return kosong.
  // Auth: gmgn-cli baca GMGN_API_KEYS dari project's .env (key[0]=screening).
  // Tidak perlu pass apiKeys lagi — cli.js handle rotasi internal.
  if (cfg.screener.source === 'gmgn') {
    const result = await discoverFromGmgn({
      filters: baseFilters,
      launchpads,
      interval,
      limit,
    });

    if (result.candidates.length > 0) {
      candidates = result.candidates;
      scannedCount = candidates.length;
      log.info(`gmgn-cli trending: ${candidates.length} candidates received (server-side filtered)`);

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

  // Pre-scorer (soft — additive ranking only, tidak gate)
  // softScore = non-Hermes snipra thresholds sebagai ranking signal
  // hermesScore = Hermes 8-component composite (~100 pts)
  // preScore = legacy 6-component signal
  // score = legacy baseline ranking
  // Composite = score + softScore.score + hermesScore.score + preScore.score
  for (const c of candidates) {
    c.preScore = preScore(c).score;
    c.softScore = softScore(c, filters).score;
    c.hermesScore = hermesScore(c).score;
    c.compositeScore = score(c) + c.softScore + c.hermesScore + c.preScore;
  }

  // Ranking
  candidates.sort((a, b) => (b.compositeScore || 0) - (a.compositeScore || 0));
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
