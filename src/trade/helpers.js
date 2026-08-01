import { getConfig } from '../config.js';
import { findOpen, inCooldown, openPositions, addPosition, closePosition,
         recordPartialSell, findMoonbag, removeMoonbag } from '../positions/state.js';
import { tokenPairs, bestPair, normalizePair } from '../screener/dexscreener.js';
import { shortAddr } from '../utils.js';
import { createLogger } from '../logger.js';
import { breaker } from './circuit-breaker.js';

const log = createLogger('trade');

export function effectiveMax(cfg) {
  const c = cfg || getConfig();
  return c.trading.maxPositions;
}

export async function resolveCandidate(chainKey, address) {
  const cfg = getConfig();
  const dsId = cfg.chains[chainKey]?.dexscreenerId;
  if (!dsId) throw new Error(`chain ${chainKey} tidak dikenal/aktif`);
  const pairs = await tokenPairs(dsId, address);
  const pair = bestPair(pairs);
  if (!pair) throw new Error(`token ${address} tidak ditemukan di DexScreener`);
  return normalizePair(pair, chainKey);
}

export async function buyToken(chainKey, address, amountNative, source, candidate, executor, onTradeClosed) {
  const cfg = getConfig();
  if (!cfg.chains[chainKey]?.enabled)
    throw new Error(`chain ${chainKey} nonaktif`);
  const c = candidate || (await resolveCandidate(chainKey, address));

  if (findOpen(chainKey, c.address)) throw new Error(`sudah ada posisi ${c.symbol}`);
  if (inCooldown(chainKey, c.address, cfg.trading.cooldownMinutes))
    throw new Error(`${c.symbol} masih cooldown`);
  const effMax = effectiveMax(cfg);
  if (openPositions().length >= effMax)
    throw new Error(`max posisi (${effMax}) tercapai`);

  breaker.check(chainKey);

  const amount = amountNative;
  const res = await executor.buy(chainKey, c.address, amount, { labels: c.labels });
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
  });
  breaker.recordOpen(chainKey);
  log.info(`posisi dibuka [${source}]: ${c.symbol} @ ${c.priceUsd}`);
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
    return res;
  }
  const mb = findMoonbag(address);
  if (!mb) throw new Error(`tidak ada posisi/moonbag utk ${shortAddr(address)}`);
  const res = await executor.sell(mb.chain, mb.address, pct, { labels: mb.labels, fallbackPriceUsd: mb.currentPrice });
  if (pct >= 100) removeMoonbag(mb.id);
  else mb.moonPct = mb.moonPct * (1 - pct / 100);
  log.info(`moonbag sell ${pct}% ${mb.symbol} → ${res.receivedNative?.toFixed(6)} native`);
  return res;
}
