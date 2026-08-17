/**
 * Decision log — append-only JSON-lines audit trail.
 *
 * Schema per entry (JSON object per line in data/decision-log.jsonl):
 *   {
 *     ts:       number,             // unix ms
 *     type:     'screening' | 'manage_eval' | 'buy' | 'sell',
 *     mode:     'paper' | 'live',
 *     chain:    string,
 *     address:  string,             // token contract
 *     symbol:   string,
 *     ... type-specific fields (see below)
 *   }
 *
 * Type-specific fields:
 *   screening:  scores {composite, preScore, softScore, hermesScore},
 *               metrics {holders, top10Pct, marketCap, smartDegenCount, liquidityUsd, volume24h, ageHours},
 *               decision: 'buy' | 'skip',
 *               llmAction, llmConfidence, llmRisk, llmReason,
 *               reason?: string  // extra: 'cooldown', 'max positions', 'freshness recheck failed'
 *   manage_eval: pnlPct, peakPnlPct, entryMetrics, currentMetrics,
 *                delta {holdersPct, top10PctDelta, smartDegenDelta},
 *                llmAction: 'hold' | 'close', llmConfidence, llmReason,
 *                action: 'hold' | 'close_force'
 *   buy:        entryPriceUsd, amountNative, genomeId?,
 *               llmVerdict {action, confidence, risk, reason},
 *               entryMetrics
 *   sell:       reason ('SL' | 'TP1' | 'TP2' | 'TP3' | 'trailing' | 'manage-LLM'
 *                          | 'moonbag' | 'manual' | 'MAX_HOLD' | 'SIDEWAYS_TIMEOUT'
 *                          | 'paper reset' | 'auto-close: on-chain balance 0'),
 *               pnlPct, pnlNative, receivedNative,
 *               tierIndex?: number (for TP),
 *               llmVerdict?: {action, confidence, reason} (for manage-LLM)
 *
 * Digunakan untuk:
 * - LLM prompt context (bandingkan dengan lessons — performance history)
 * - Post-mortem analysis (kenapa pass / kenapa skip / kenapa close)
 * - Audit trail debugging
 *
 * Append-only — JANGAN mutate file di tempat. Untuk reset, hapus file via
 * clearDecisionLog() atau /paperreset command.
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('decision-log');
const DECISION_LOG_FILE = path.join(DATA_DIR, 'decision-log.jsonl');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Append satu decision entry ke decision log. Auto-create file jika belum ada.
 * Failure di-swallow (logged warn) — decision log TIDAK boleh ganggu alur
 * screening/manage/sell. Best-effort audit.
 */
export function appendDecision(entry) {
  if (!entry || typeof entry !== 'object') return;
  try {
    ensureDir();
    const rec = { ts: Date.now(), ...entry };
    fs.appendFileSync(DECISION_LOG_FILE, JSON.stringify(rec) + '\n');
  } catch (e) {
    log.warn(`appendDecision failed for type=${entry?.type}: ${e.message}`);
  }
}

/** Append banyak entry sekaligus — dipakai saat batch log screening. */
export function appendDecisionBatch(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  try {
    ensureDir();
    const lines = entries
      .filter((e) => e && typeof e === 'object')
      .map((e) => JSON.stringify({ ts: Date.now(), ...e }))
      .join('\n') + '\n';
    fs.appendFileSync(DECISION_LOG_FILE, lines);
  } catch (e) {
    log.warn(`appendDecisionBatch failed (${entries.length} entries): ${e.message}`);
  }
}

/**
 * Baca N entry terakhir dari decision log. Return array (kosong kalau file
 * tidak ada). Default sort: ascending by ts (oldest first).
 *
 * @param {number} n  jumlah entry terakhir (default 50)
 */
export function readRecentDecisions(n = 50) {
  try {
    if (!fs.existsSync(DECISION_LOG_FILE)) return [];
    const content = fs.readFileSync(DECISION_LOG_FILE, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    return lines.slice(-n).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch (e) {
    log.warn(`readRecentDecisions failed: ${e.message}`);
    return [];
  }
}

/** Filter decision log by type — untuk LLM prompt context (e.g. recent buy/sell). */
export function readDecisionsByType(type, n = 30) {
  const all = readRecentDecisions(500); // window besar, lalu filter
  return all.filter((d) => d.type === type).slice(-n);
}

/**
 * Ringkasan compact untuk LLM prompt — format sebagai baris per entry.
 * Cocok untuk di-inject ke system prompt atau lesson block.
 */
export function summarizeDecisions(decisions, { maxChars = 2000 } = {}) {
  if (!decisions || decisions.length === 0) return '';
  const lines = [];
  for (const d of decisions) {
    const sym = d.symbol || d.address?.slice(0, 6) || '?';
    let line;
    switch (d.type) {
      case 'screening':
        line = `[${d.decision === 'buy' ? 'BUY' : 'SKIP'}] ${sym} conf=${(d.llmConfidence ?? 0).toFixed(2)} — ${d.llmReason?.slice(0, 80) || ''}`;
        break;
      case 'manage_eval':
        line = `[EVAL ${d.action === 'close_force' ? 'FORCE_CLOSE' : 'HOLD'}] ${sym} ${(d.pnlPct ?? 0).toFixed(1)}% — ${d.llmReason?.slice(0, 80) || ''}`;
        break;
      case 'buy':
        line = `[OPEN] ${sym} @ $${(d.entryPriceUsd ?? 0).toFixed(6)} ${(d.amountNative ?? 0).toFixed(3)} SOL`;
        break;
      case 'sell':
        line = `[CLOSE ${d.reason}] ${sym} ${(d.pnlPct ?? 0).toFixed(1)}% pnl ${(d.pnlNative ?? 0).toFixed(4)} SOL`;
        break;
      default:
        line = `[${d.type}] ${sym}`;
    }
    lines.push(line);
  }
  let out = lines.join('\n');
  if (out.length > maxChars) out = '…' + out.slice(-maxChars);
  return out;
}

/** Hapus seluruh decision log. Dipakai oleh /paperreset. */
export function clearDecisionLog() {
  try {
    if (fs.existsSync(DECISION_LOG_FILE)) fs.unlinkSync(DECISION_LOG_FILE);
    log.info('decision log cleared');
  } catch (e) {
    log.warn(`clearDecisionLog failed: ${e.message}`);
  }
}

export const DECISION_LOG_PATH = DECISION_LOG_FILE;