import { getConfig } from '../config.js';
import { findOpen, inCooldown, openPositions, addPosition, closePosition,
         recordPartialSell, findMoonbag, removeMoonbag, recordMoonbagPartialSell } from '../positions/state.js';
import { tokenPairs, bestPair, normalizePair } from '../screener/dexscreener.js';
import { evaluate } from '../screener/filters.js';
import { shortAddr } from '../utils.js';
import { createLogger } from '../logger.js';
import { breaker } from './circuit-breaker.js';

const log = createLogger('trade');

const TRANSIENT_BUY_ERROR_RE = /timeout|ECONN|EAI_|ENOTFOUND|ETIMEDOUT|nonce|underpriced|replacement|rate.?limit|429|503/i;

export function effectiveMax(cfg) {
  const c = cfg || getConfig();
  return c.trading.maxPositions;
}

/**
 * Snapshot kondisi market candidate saat entry (liquidity, marketcap, age, dst) —
 * dipakai buat kumpulin data historis utk analisis filter screening nanti (mis.
 * strategy "myself"). Field-nya sama dgn yang dievaluasi filters.js supaya nanti
 * bisa dibandingkan langsung ke config filter yang lagi dipakai.
 */
function buildEntrySnapshot(c) {
  return {
    liquidityUsd: c.liquidityUsd ?? null,
    marketCap: c.marketCap ?? null,
    ageMinutes: c.ageMinutes ?? null,
    volume24h: c.volume24h ?? null,
    holders: c.holders ?? null,
    swaps24h: c.traders24h ?? null,
    buySellRatio: c.buySellRatio ?? null,
    bondingProgress: c.bondingProgress ?? null,
    rugRatio: c.rugRatio ?? null,
    bundlerRate: c.bundlerRate ?? null,
    insiderRate: c.insiderRate ?? null,
    top10HolderRate: c.top10HolderRate ?? null,
    devHoldRate: c.devHoldRate ?? null,
    botDegenRate: c.botDegenRate ?? null,
    freshWalletRate: c.freshWalletRate ?? null,
    smartDegenCount: c.smartDegenCount ?? null,
    totalFee: c.totalFee ?? null,
    socials: c.socials ?? null,
    priceChangeH1: c.priceChange?.h1 ?? null,
    priceChangeH24: c.priceChange?.h24 ?? null,
    launchpad: c.launchpad ?? null,
    section: c.section ?? null,
  };
}

export async function resolveCandidate(chainKey, address) {
  const cfg = getConfig();
  const dsId = cfg.chains[chainKey]?.dexscreenerId;
  if (!dsId) throw new Error(`chain ${chainKey} unknown/inactive`);
  const pairs = await tokenPairs(dsId, address);
  const pair = bestPair(pairs);
  if (!pair) throw new Error(`token ${address} not found on DexScreener`);
  return normalizePair(pair, chainKey);
}

export async function buyToken(chainKey, address, amountNative, source, candidate, executor) {
  const cfg = getConfig();
  if (!cfg.chains[chainKey]?.enabled)
    throw new Error(`chain ${chainKey} disabled`);
  const c = candidate || (await resolveCandidate(chainKey, address));

  if (findOpen(chainKey, c.address)) throw new Error(`position already open for ${c.symbol}`);
  if (inCooldown(chainKey, c.address, cfg.trading.cooldownMinutes, cfg.trading.maxTradesBeforeCooldown))
    throw new Error(`${c.symbol} still in cooldown`);
  const effMax = effectiveMax(cfg);
  if (openPositions().length >= effMax)
    throw new Error(`max positions (${effMax}) reached`);

  // buyFreshnessCheck: re-fetch DexScreener sebelum buy untuk validasi ulang.
  // Bisa dinonaktifkan via config — berguna untuk new_creation dimana data DS
  // sering belum terindeks (liq 0, mcap beda jauh dari GMGN).
  if (cfg.trading.buyFreshnessCheck) {
    const fresh = await resolveCandidate(chainKey, c.address);
    const res = evaluate(fresh, cfg.screener.filters);
    if (!res.pass) throw new Error('freshness recheck failed');
    Object.assign(c, fresh);
  }

  breaker.check(chainKey);

  // Math.max(0, …): buyMaxRetries negatif (salah konfigurasi) jangan sampai membuat
  // loop tidak jalan sama sekali dan res tetap undefined.
  const maxRetries = Math.max(0, cfg.trading.buyMaxRetries ?? 0);
  const retryDelayMs = cfg.trading.buyRetryDelayMs ?? 2000;
  let res;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      res = await executor.buy(chainKey, c.address, amountNative, { labels: c.labels });
      if (attempt > 0) log.info(`buy retry #${attempt} succeeded for ${c.symbol}`);
      break;
    } catch (e) {
      // tx sudah tersiar (atau broadcast-nya sendiri tidak pasti) — jangan retry, risiko beli ganda
      if (/not confirmed|broadcast uncertain/i.test(e.message)) throw e;
      const isTransient = TRANSIENT_BUY_ERROR_RE.test(e.message);
      if (!isTransient || attempt >= maxRetries) throw e;
      log.debug(`buy retry #${attempt + 1} for ${c.symbol} in ${retryDelayMs}ms: ${e.message}`);
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  // entryPrice HARUS priceNative (SOL) — monitoring (manager.js:priceOf) &
  // display (status.js) berasumsi pos.entryPrice selalu native, bukan USD.
  // Kalau candidate tidak bawa priceNative (screener seharusnya sudah gate
  // ini di loops.js sebelum sampai sini), re-resolve dari DexScreener alih-
  // alih fallback ke priceUsd — supaya tidak pernah campur unit lagi.
  let entryPrice = c.priceNative > 0 ? c.priceNative : null;
  if (!(entryPrice > 0)) {
    try {
      const fresh = await resolveCandidate(chainKey, c.address);
      entryPrice = fresh.priceNative > 0 ? fresh.priceNative : 0;
    } catch (e) {
      log.warn(`entryPrice re-resolve failed for ${c.symbol}: ${e.message}`);
    }
  }
  const pos = addPosition({
    chain: chainKey,
    address: c.address,
    symbol: c.symbol,
    pairAddress: c.pairAddress,
    labels: c.labels,
    entryPrice,
    amountNative: res.spentNative,
    tokensRaw: res.tokensRaw,
    txid: res.txid,
    genomeId: c.genomeId || null,
    llmVerdict: c.llmVerdict || null,
    slPct: c.exitGenes?.slPct ?? null,
    trailingActivateGainPct: c.exitGenes?.trailingActivateGainPct ?? null,
    trailingTrailPct: c.exitGenes?.trailingTrailPct ?? null,
    entrySnapshot: buildEntrySnapshot(c),
  });
  if (res._pendingConfirm) {
    pos._confirmPending = true;
    log.warn(`position opened with pending confirm [${source}]: ${c.symbol} @ ${c.priceUsd} — will reconcile on next tick`);
  }
  breaker.recordOpen(chainKey);
  log.info(`position opened [${source}]: ${c.symbol} @ ${c.priceUsd}`);
  return { ...pos, txid: res.txid };
}

function moonbagFinalPnlPct(mb, exitPrice) {
  if (!(mb.entryPrice > 0)) return 0;
  return ((exitPrice - mb.entryPrice) / mb.entryPrice) * 100;
}

export async function sellToken(address, pct, executor, onTradeClosed) {
  // Validasi terpusat — pct negatif/NaN/0 merusak state paper secara permanen
  // (holdings naik, saldo salah arah, remainingPct > 100%, atau NaN menyebar).
  // Reachable dari /sell manual & LLM tool sell_token, jadi divalidasi di satu
  // titik temu ini, bukan di masing-masing caller.
  pct = Number(pct);
  if (!(pct > 0 && pct <= 100)) {
    throw new Error(`invalid pct: must be a number 0 < pct <= 100, got ${pct}`);
  }
  const pos = openPositions().find(
    (p) => p.address.toLowerCase() === address.toLowerCase()
  );
  if (pos) {
    const res = await executor.sell(pos.chain, pos.address, pct, { labels: pos.labels, fallbackPriceUsd: pos.currentPrice });
    if (pct >= 100) {
      const trade = closePosition(pos, { reason: 'manual sell', receivedNative: res.receivedNative, txid: res.txid });
      if (trade) onTradeClosed(trade); // null = sudah di-close di jalur lain (race) — idempotency guard
    } else {
      recordPartialSell(pos, { pctOfRemaining: pct, receivedNative: res.receivedNative, txid: res.txid });
    }
    return { ...res, chain: pos.chain };
  }
  const mb = findMoonbag(address);
  if (!mb) throw new Error(`no position/moonbag for ${shortAddr(address)}`);
  const res = await executor.sell(mb.chain, mb.address, pct, { labels: mb.labels, fallbackPriceUsd: mb.currentPrice });
  if (pct >= 100) {
    // Moonbag exit sepenuhnya — laporkan PnL tambahan ini ke Darwin fitness/LLM
    // lesson (sebelumnya tidak pernah dilaporkan sama sekali, understating nilai
    // riil genome yang menghasilkan trade ini). Mark-based (currentPrice terakhir),
    // konsisten dgn pola currentPnlPct() yang dipakai di notifikasi lain.
    if (mb.genomeId && onTradeClosed) {
      onTradeClosed({
        genomeId: mb.genomeId,
        finalPnlPct: moonbagFinalPnlPct(mb, mb.currentPrice),
        chain: mb.chain,
        symbol: mb.symbol,
        openedAt: mb.openedAt,
        closeReason: 'moonbag exit',
        holdMinutes: (Date.now() - mb.openedAt) / 60000,
        tpHit: [],
      });
    }
    removeMoonbag(mb.id);
  } else {
    recordMoonbagPartialSell(mb, pct);
  }
  log.info(`moonbag sell ${pct}% ${mb.symbol} → ${res.receivedNative?.toFixed(6)} native`);
  return { ...res, chain: mb.chain };
}
