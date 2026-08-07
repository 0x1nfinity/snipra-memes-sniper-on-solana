import { GENE_SPACE, readGeneBaseline } from './darwin.js';
import { fmtPct } from '../utils.js';
import { getActiveMode } from '../config.js';
import { createLogger } from '../logger.js';
import { breaker } from '../trade/circuit-breaker.js';

const log = createLogger('evolve');

// Module-level deps, wired from index.js after Darwin/LLM/Telegram creation.
// Enables onTradeClosed (a callback) and runEvolve (called by Telegram) to
// work without the caller needing to pass instance references each time.
let _deps = {};

export function setEvolveDeps(deps) {
  _deps = deps;
}

// Format angka gen ringkas: 50000→50K, 20000000→20M, 0.9→0.9
function fmtGene(v) {
  const n = Number(v);
  if (!isFinite(n)) return String(v);
  if (Math.abs(n) >= 1e6) return `${+(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
  return String(+n.toFixed(2));
}

// Susun daftar "gen: sekarang → usulan" hanya untuk gen yang benar-benar beda.
function geneDiffLines(cfg, proposed) {
  const lines = [];
  for (const [name, val] of Object.entries(proposed || {})) {
    if (!(name in GENE_SPACE)) continue;
    // Baseline dibaca lewat GENE_CONFIG_PATH: 10 gen screening dari screener.filters,
    // 3 gen exit dari trading.stopLossPct / trailing.*.
    const cur = readGeneBaseline(cfg, name);
    const nv = Number(val);
    if (!isFinite(nv)) continue;
    // anggap sama bila selisih < 1% (hindari noise pembulatan)
    if (cur != null && Math.abs(nv - cur) <= Math.abs(cur) * 0.01) continue;
    lines.push(`  • \`${name}\`: ${cur != null ? fmtGene(cur) : '—'} → *${fmtGene(nv)}*`);
  }
  return lines;
}

/**
 * ANALISA EVOLUSI (advisory) — TIDAK mengubah apa pun otomatis.
 * Menggabungkan data fitness Darwin (genome terbaik yang teruji) + analisa LLM,
 * lalu mengirim NOTIFIKASI berisi usulan perubahan filter. User menerapkan sendiri
 * (lewat /menu, /set, atau edit config.<mode>.json — hot-reload aktif).
 */
export async function runEvolve(trigger = 'manual', deps) {
  const { darwin, llm, telegram, getConfig, recentTrades } = deps || _deps;
  const cfg = getConfig();
  const filters = cfg.screener.filters;
  const st = darwin.status();

  // ── sisi Darwin: genome terbaik yang sudah teruji ──
  const best = darwin.bestProven();
  const darwinLines = best ? geneDiffLines(cfg, best.genes) : [];

  // ── sisi LLM: rekomendasi berbasis trade + performa genome + lessons ──
  let llmLines = [];
  let rationale = null;
  if (cfg.llm.enabled && llm.available()) {
    try {
      const suggestion = await llm.suggestGenes({
        geneSpace: GENE_SPACE,
        currentFilters: {
          ...filters,
          stopLossPct: cfg.trading.stopLossPct,
          trailingActivateGainPct: cfg.trailing.activateGainPct,
          trailingTrailPct: cfg.trailing.trailPct,
        },
        genomes: st.genomes.map((g) => ({ id: g.id, fitness: +g.fitness.toFixed(2), trades: g.trades, avgPnl: +g.avgPnl.toFixed(1), genes: g.genes })),
        trades: recentTrades(getActiveMode(), 20).map((t) => ({
          symbol: t.symbol, chain: t.chain, pnlPct: +(t.pnl_pct ?? 0).toFixed(1),
          reason: t.close_reason, holdMin: Math.round(t.hold_minutes ?? 0),
        })),
        lessonsText: llm.getLessons(10).map((l) => `[${l.outcome}] ${l.text}`).join('\n'),
      });
      if (suggestion?.genes) {
        llmLines = geneDiffLines(cfg, suggestion.genes);
        rationale = suggestion.rationale;
        log.info(`LLM suggested filter: ${JSON.stringify(suggestion.genes)} — ${rationale}`);
      }
    } catch (e) {
      log.warn('LLM suggestGenes failed:', e.message);
    }
  }

  // ── susun notifikasi usulan ──
  const parts = [`🧬 Usulan Evolusi (${trigger}) — tidak diterapkan otomatis`];
  if (best) {
    parts.push(
      `\n*Darwin* — genome teruji terbaik \`${best.id}\`` +
      ` (fitness ${darwin.fitness(best).toFixed(2)}, ${best.trades} trades, avg ${fmtPct(best.totalPnlPct / best.trades)})` +
      (darwinLines.length ? `\n${darwinLines.join('\n')}` : `\n  _(setara config saat ini)_`)
    );
  } else {
    parts.push(`\n*Darwin* — belum ada genome cukup teruji (butuh ≥ ${cfg.darwin.minTradesForFitness} trades/genome)`);
  }
  if (llmLines.length || rationale) {
    parts.push(
      `\n*LLM*` +
      (llmLines.length ? `\n${llmLines.join('\n')}` : `\n  _(tanpa usulan angka)_`) +
      (rationale ? `\n  _${rationale}_` : '')
    );
  } else if (cfg.llm.enabled) {
    parts.push(`\n*LLM* — tidak ada usulan`);
  }
  parts.push(`\n_Terapkan manual bila setuju: /menu · /set · atau edit config.<mode>.json (hot-reload)._`);

  telegram.notify(parts.join('\n'));
  darwin.resetEvolveCounter(); // reset kuota agar tidak memicu tiap trade berikutnya
  return { darwinLines, llmLines, rationale };
}

// ===== feedback loop: trade close → darwin fitness + LLM lesson =====

export function onTradeClosed(trade) {
  breaker.recordClose(trade.chain, trade.openedAt);
  if (!_deps || !_deps.darwin) return; // guard: deps not yet wired (early startup reconciliation)
  const { darwin, llm, getConfig } = _deps;
  const cfg = getConfig();
  if (cfg.darwin.enabled) {
    darwin.recordTrade(trade); // tetap catat untuk fitness tracking
    // Auto-evolve disabled — genome hanya berubah via /evolve manual
  }
  if (cfg.llm.enabled && llm && llm.available()) {
    llm.recordTradeLesson(trade).catch(() => {});
  }
}
