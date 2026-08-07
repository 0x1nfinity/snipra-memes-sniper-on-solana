import { getConfig } from '../config.js';
import { findOpen, inCooldown, openPositions, addPosition, closePosition,
         recordPartialSell, findMoonbag, removeMoonbag } from '../positions/state.js';
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
    if (!res.pass) throw new Error(`freshness recheck failed: ${res.reasons.join(', ')}`);
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
      if (/not confirmed/i.test(e.message)) throw e; // tx sudah tersiar ke jaringan — jangan retry, risiko beli ganda
      const isTransient = TRANSIENT_BUY_ERROR_RE.test(e.message);
      if (!isTransient || attempt >= maxRetries) throw e;
      log.debug(`buy retry #${attempt + 1} for ${c.symbol} in ${retryDelayMs}ms: ${e.message}`);
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  const pos = addPosition({
    chain: chainKey,
    address: c.address,
    symbol: c.symbol,
    pairAddress: c.pairAddress,
    labels: c.labels,
    entryPrice: c.priceUsd,
    amountNative: res.spentNative,
    tokensRaw: res.tokensRaw,
    txid: res.txid,
    genomeId: c.genomeId || null,
    llmVerdict: c.llmVerdict || null,
    slPct: c.exitGenes?.slPct ?? null,
    trailingActivateGainPct: c.exitGenes?.trailingActivateGainPct ?? null,
    trailingTrailPct: c.exitGenes?.trailingTrailPct ?? null,
  });
  if (res._pendingConfirm) {
    pos._confirmPending = true;
    log.warn(`position opened with pending confirm [${source}]: ${c.symbol} @ ${c.priceUsd} — will reconcile on next tick`);
  }
  breaker.recordOpen(chainKey);
  log.info(`position opened [${source}]: ${c.symbol} @ ${c.priceUsd}`);
  return { ...pos, txid: res.txid };
}

export async function sellToken(address, pct, executor, onTradeClosed) {
  const pos = openPositions().find(
    (p) => p.address.toLowerCase() === address.toLowerCase()
  );
  if (pos) {
    const res = await executor.sell(pos.chain, pos.address, pct, { labels: pos.labels, fallbackPriceUsd: pos.currentPrice });
    if (pct >= 100) {
      const trade = closePosition(pos, { reason: 'manual sell', receivedNative: res.receivedNative, txid: res.txid });
      onTradeClosed(trade);
    } else {
      recordPartialSell(pos, { pctOfRemaining: pct, receivedNative: res.receivedNative, txid: res.txid });
    }
    return { ...res, chain: pos.chain };
  }
  const mb = findMoonbag(address);
  if (!mb) throw new Error(`no position/moonbag for ${shortAddr(address)}`);
  const res = await executor.sell(mb.chain, mb.address, pct, { labels: mb.labels, fallbackPriceUsd: mb.currentPrice });
  if (pct >= 100) removeMoonbag(mb.id);
  else mb.moonPct = mb.moonPct * (1 - pct / 100);
  log.info(`moonbag sell ${pct}% ${mb.symbol} → ${res.receivedNative?.toFixed(6)} native`);
  return { ...res, chain: mb.chain };
}
