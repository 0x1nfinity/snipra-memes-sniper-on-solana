import { getConfig, getActiveMode } from '../config.js';
import { openPositions, currentPnlPct } from '../positions/state.js';
import { recentTrades } from '../db.js';
import { fmtUsd, tokenLink } from '../utils.js';
import { marketLine, communityLine } from '../telegram/fmt.js';
import { createLogger } from '../logger.js';
import { runScreening } from '../screener/screener.js';
import { effectiveMax } from '../trade/helpers.js';

const log = createLogger('loops');

export function createBotContext(deps) {
  const { darwin } = deps;
  return () => {
    const cfg = getConfig();
    const s = deps.statsSummary();
    const byChain = {};
    for (const p of openPositions()) {
      (byChain[p.chain] ??= []).push(`${p.symbol} ${currentPnlPct(p).toFixed(1)}% (remaining ${p.remainingPct.toFixed(0)}%)`);
    }
    const posBlock = Object.keys(byChain).sort()
      .map((k) => `${k.toUpperCase()}: ${byChain[k].join(', ')}`)
      .join('\n') || '(no open positions)';
    const st = darwin.status();
    const lastTrades = recentTrades(getActiveMode(), 5)
      .map((t) => `${t.symbol} ${(t.pnl_pct ?? 0).toFixed(1)}% (${t.close_reason})`)
      .join('; ') || '(none yet)';
    const enabledChains = Object.entries(cfg.chains).filter(([,c]) => c.enabled).map(([k]) => k).join(', ') || '(none)';
    return (
      `mode=${getActiveMode()}, chains=${enabledChains}, screening every ${cfg.telegram.screeningcyclemin}m, monitor every ${cfg.monitor.intervalSec}s\n` +
      `Open positions (${openPositions().length}):\n${posBlock}\n` +
      `Stats: ${s.totalTrades} trades, win rate ${s.winRatePct.toFixed(1)}%, avg PnL ${s.avgPnlPct.toFixed(1)}%\n` +
      `Last trades: ${lastTrades}\n` +
      `Darwin: generation ${st.generation}, best genome ${st.genomes[0]?.id} (fitness ${st.genomes[0]?.fitness.toFixed(2)})\n` +
      `Main filters: ${JSON.stringify(cfg.screener.filters)}\n` +
      `TP ladder: ${JSON.stringify(cfg.tpLadder)} | trailing: activate ${cfg.trailing.activateGainPct}%, trail ${cfg.trailing.trailPct}% | SL ${cfg.trading.stopLossPct}%`
    );
  };
}

export function createScreeningCycle(deps) {
  const { darwin, llm, executor, telegram, buyToken, onTradeClosed, paused, screenBusy } = deps;

  return async function screeningCycle(force = false) {
    if (paused() && !force) return;
    if (screenBusy()) {
      log.info('screening skipped: previous cycle still running');
      return;
    }
    screenBusy(true);
    try {
      const cfg = getConfig();
      const effMax = effectiveMax(cfg);
      const availSlots = effMax - openPositions().length;
      if (!force && availSlots <= 0) {
        log.info(`screening skipped: positions full (${openPositions().length}/${effMax})`);
        if (cfg.telegram.notifyScreening) {
          telegram.notify(
            `⏭️ Screening — Skipped\n\nPositions full ${openPositions().length}/${effMax} — no open slots.`
          );
        }
        return;
      }

      const { candidates, genomeId, scanned } = await runScreening({
        darwin,
        llm,
        availSlots: availSlots > 0 ? availSlots : undefined,
      });
      const bought = [];
      const rejected = [];
      const MAX_RETRIES = 2;
      const RETRY_DELAY_MS = 2000;
      for (const c of candidates) {
        c.genomeId = genomeId;
        let lastError = null;
        let boughtToken = false;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          try {
            const pos = await buyToken(c.chain, c.address, undefined, 'screener', c);
            bought.push({ c, pos });
            boughtToken = true;
            if (attempt > 0) log.info(`retry #${attempt} succeeded for ${c.symbol}`);
            break;
          } catch (e) {
            lastError = e.message;
            const isTransient = /timeout|ECONN|EAI_|ENOTFOUND|ETIMEDOUT|nonce|underpriced|replacement|rate.?limit|429|503/i.test(e.message);
            if (!isTransient || attempt >= MAX_RETRIES) break;
            log.debug(`retry #${attempt + 1} for ${c.symbol} in ${RETRY_DELAY_MS}ms: ${e.message}`);
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          }
        }
        if (!boughtToken) {
          rejected.push({ c, reason: lastError || 'failed' });
          log.debug(`skip buy ${c.symbol}: ${lastError}`);
        }
      }
      if (cfg.telegram.notifyScreening) {
        if (candidates.length === 0) {
          telegram.notify(`🔍 Screening — ${scanned} scanned, none passed the filter`);
        } else {
          const lines = [];
          lines.push(`🔍 Screening — ${scanned} scanned, ${candidates.length} passed, ${bought.length} bought, ${rejected.length} rejected`);
          lines.push('');
          for (const { c } of bought) {
            const slug = cfg.chains[c.chain]?.gmgnSlug;
            lines.push(`✅ Bought ${tokenLink(c.symbol, slug, c.address)} — ${fmtUsd(c.priceUsd)}`);
            lines.push(`   ${marketLine(c)}, ${communityLine(c)}`);
            lines.push('');
          }
          if (bought.length > 0) {
            const chainsBought = [...new Set(bought.map((b) => b.c.chain))];
            const saldoLines = await Promise.all(chainsBought.map(async (ck) => {
              try {
                const bal = await executor.chain(ck).nativeBalance();
                return `${bal.toFixed(4)} SOL`;
              } catch { return null; }
            }));
            const shown = saldoLines.filter(Boolean);
            if (shown.length) {
              lines.push(`Balance remaining: ${shown.join(' · ')}`);
              lines.push('');
            }
          }
          for (const { c, reason } of rejected) {
            const slug = cfg.chains[c.chain]?.gmgnSlug;
            lines.push(`❌ Rejected ${tokenLink(c.symbol, slug, c.address)} — ${fmtUsd(c.priceUsd)}`);
            lines.push(`   Reason: ${reason}`);
            lines.push('');
          }
          telegram.notify(lines.join('\n').trimEnd());
        }
      }
    } catch (e) {
      log.error('screening cycle failed:', e.message);
    } finally {
      screenBusy(false);
    }
  };
}

export function startScreeningLoop(screeningCycleFn, getConfigFn) {
  const intervalSec = getConfigFn().telegram.screeningcyclemin * 60;
  let timer = null;
  if (!intervalSec || intervalSec <= 0) return () => {};
  const periodMs = intervalSec * 1000;
  const delay = periodMs - (Date.now() % periodMs);
  timer = setTimeout(() => {
    screeningCycleFn();
    timer = setInterval(screeningCycleFn, periodMs);
  }, delay);
  log.info(`screening loop start (every ${intervalSec}s, boundary wall-clock, starting in ${Math.round(delay / 1000)}s)`);
  return () => {
    if (timer) { clearTimeout(timer); clearInterval(timer); }
  };
}
