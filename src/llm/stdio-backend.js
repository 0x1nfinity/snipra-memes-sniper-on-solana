import { createInterface } from 'readline';
import { sanitizePromptField } from '../utils.js';

export class StdioBackend {
  constructor({ timeout = 60000 } = {}) {
    this._timeout = timeout;
    this._pending = new Map();
    this._reqId = 0;
    this._rl = null;
    this._started = false;
  }

  available() {
    return true;
  }

  _start() {
    if (this._started) return;
    this._started = true;
    this._rl = createInterface({ input: process.stdin });
    this._rl.on('line', (line) => {
      try {
        const resp = JSON.parse(line.trim());
        if (resp.id && this._pending.has(resp.id)) {
          const { resolve, timer } = this._pending.get(resp.id);
          clearTimeout(timer);
          this._pending.delete(resp.id);
          resolve(resp);
        }
      } catch { /* ignore non-JSON lines */ }
    });
  }

  _nextId() {
    return `req-${++this._reqId}-${Date.now()}`;
  }

  async _request(type, system, user, responseFormat) {
    this._start();
    const id = this._nextId();
    const req = JSON.stringify({ id, type, system, user, response_format: responseFormat });
    process.stdout.write(req + '\n');

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        resolve({ id, ok: false, error: 'timeout' });
      }, this._timeout);
      this._pending.set(id, { resolve, timer });
    });
  }

  async assessBatch(candidates, lessonBlock) {
    const system = `You are an aggressive but disciplined memecoin sniper. Every token in the list ALREADY PASSED strict hard filters. Default decision per token is BUY. Only "skip" a token if there is a SERIOUS red flag for THAT specific token. Assess EACH token independently.`;
    const list = candidates.map((c, i) =>
      `[${i}] ${sanitizePromptField(c.symbol)} (${sanitizePromptField(c.name)}) on ${c.chain}, dex ${c.dexId}\n` +
      `  Pair age: ${c.ageMinutes?.toFixed(0)} min | MC ${c.marketCap} | Liq ${c.liquidityUsd} | Vol24h ${c.volume24h}\n` +
      `  Holders ${c.holders ?? 'unknown'} | top10 ${c.top10Pct != null ? c.top10Pct.toFixed(0) + '%' : 'unknown'} | tx24h ${c.traders24h} (buy/sell ${c.buySellRatio?.toFixed(2)})\n` +
      `  Price change: 1h ${c.priceChange?.h1}% | 6h ${c.priceChange?.h6}% | 24h ${c.priceChange?.h24}%\n` +
      `  Security: honeypot=${c.security?.honeypot ?? 'unknown'}, mintable=${c.security?.mintable ?? 'unknown'}`
    ).join('\n\n');
    const user = `TOKENS:\n${list}\n\nLESSONS FROM PAST TRADES:\n${lessonBlock}\n\nReply ONLY JSON: {"verdicts":[{"index":<int>,"action":"buy"|"skip","confidence":<0-1>,"risk":"low"|"medium"|"high","reason":"<1 short sentence, English>"}, ...]} — exactly one entry per token index (0 to ${candidates.length - 1}).`;

    const resp = await this._request('assess_batch', system, user, {
      verdicts: 'array of {index: int, action: "buy"|"skip", confidence: number 0-1, risk: "low"|"medium"|"high", reason: string}',
    });

    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
    if (!resp.ok || !Array.isArray(resp.result?.verdicts)) {
      // Seluruh batch gagal (agent/protokol unavailable) — failOpen hardcoded.
      return candidates.map(() => ({ action: 'buy', confidence: 0.5, risk: 'medium', reason: 'LLM unavailable (failOpen)' }));
    }
    // Verdict per-index yang tidak dijawab LLM dianggap GAGAL (confidence 0), BUKAN buy
    // otomatis — supaya respons batch parsial (mis. model murah yg truncate) tidak diam-diam
    // membeli token yang belum benar-benar dinilai.
    const out = candidates.map(() => ({ action: 'buy', confidence: 0, risk: 'medium', reason: 'no verdict returned' }));
    for (const v of resp.result.verdicts) {
      const i = Number(v.index);
      if (!Number.isInteger(i) || i < 0 || i >= out.length) continue;
      out[i] = {
        action: v.action === 'skip' ? 'skip' : 'buy',
        confidence: clamp(Number(v.confidence) || 0, 0, 1),
        risk: ['low', 'medium', 'high'].includes(v.risk) ? v.risk : 'medium',
        reason: String(v.reason || '').slice(0, 300),
      };
    }
    return out;
  }

  async recordLesson(trade) {
    const v = trade.llmVerdict;
    const system = 'You are a memecoin trading analyst. Extract one short, actionable lesson from this closed trade.';
    const user = `TRADE:
- ${trade.symbol} on ${trade.chain}, held ${trade.holdMinutes?.toFixed(0)} min
- Final PnL: ${trade.finalPnlPct?.toFixed(1)}%
- Close reason: ${trade.closeReason}
- Entry verdict: ${v ? `action=${v.action ?? '?'} confidence=${v.confidence ?? '?'} risk=${v.risk ?? '?'} — ${v.reason ?? ''}` : 'none'}
- TP tiers hit: ${trade.tpHit?.length || 0}

Write ONE short lesson (max 25 words, ENGLISH). Reply ONLY JSON: {"lesson":"<english lesson>"}`;

    const resp = await this._request('record_lesson', system, user, {
      lesson: 'string (max 150 chars, English)',
    });

    if (!resp.ok || !resp.result?.lesson) return null;
    return String(resp.result.lesson).slice(0, 300);
  }

  async suggestGenes({ geneSpace, currentFilters, genomes, trades, lessonsText }) {
    const system = `You are a memecoin screening strategy expert. The bot filters tokens with a set of thresholds. Analyze the data below and RECOMMEND filter value changes that would improve profit. These are MANUAL REVIEW suggestions (not auto-applied), so be concrete with data-backed rationale.`;
    const user = `BATAS WAJAR TIAP FILTER (jangan usulkan di luar range ini):
${JSON.stringify(geneSpace, null, 1)}

KONFIG FILTER SAAT INI (baseline user):
${JSON.stringify(currentFilters, null, 1)}

PERFORMA GENOME EKSPERIMEN:
${JSON.stringify(genomes, null, 1)}

TRADE TERAKHIR:
${JSON.stringify(trades, null, 1)}

LESSONS:
${lessonsText || '(belum ada)'}

Reply ONLY JSON: {"genes": {<filter name>: <number>, ...}, "rationale": "<2-3 sentences, English>"}
Only include filters you want to change from baseline.`;

    const resp = await this._request('suggest_genes', system, user, {
      genes: 'object mapping filter names to numbers',
      rationale: 'string (English)',
    });

    if (!resp.ok || !resp.result?.genes || typeof resp.result.genes !== 'object') return null;
    return {
      genes: resp.result.genes,
      rationale: String(resp.result.rationale || '').slice(0, 500),
    };
  }

  async deriveLessons(trades, existingLessons) {
    const tradeLines = trades.map((t, i) =>
      `${i + 1}. ${t.symbol} ${t.chain} — PnL ${t.pnl_pct?.toFixed(1)}% · ` +
      `hold ${Math.round(t.hold_minutes ?? 0)}m · alasan: ${t.close_reason}` +
      (t.llm_score ? ` · LLM conf ${t.llm_score.toFixed(2)}` : '')
    ).join('\n');
    const lessonLines = (existingLessons || []).slice(-20).map((l, i) =>
      `${i + 1}. [${l.outcome}] ${l.text}`
    ).join('\n');

    const system = 'You are reviewing a COMPLETED paper trading session before resetting it. Analyze ALL closed trades and extract 3-5 HIGH-LEVEL strategic lessons (max 30 words each, ENGLISH). Focus on patterns across multiple trades.';
    const user = `CLOSED TRADES (will be deleted after this):
${tradeLines || '(none)'}

EXISTING LESSONS (carried forward, don't repeat them):
${lessonLines || '(none)'}

Reply ONLY JSON: {"lessons":[{"text":"...","outcome":"WIN|LOSS|PATTERN"}, ...]}`;

    const resp = await this._request('derive_lessons', system, user, {
      lessons: 'array of {text: string, outcome: "WIN"|"LOSS"|"PATTERN"}',
    });

    if (!resp.ok || !Array.isArray(resp.result?.lessons)) return [];
    return resp.result.lessons
      .filter((l) => l.text)
      .map((l) => ({
        text: String(l.text).slice(0, 300),
        outcome: l.outcome === 'LOSS' ? 'LOSS' : l.outcome === 'PATTERN' ? 'PATTERN' : 'WIN',
      }));
  }

  async chat(messages, { tools = null } = {}) {
    // Serialize full message history so the platform agent has multi-turn context.
    // Protocol expects system + user, so we pack history into the user field.
    const systemMsg = messages.find((m) => m.role === 'system');
    const system = systemMsg?.content || '';

    // Build a readable transcript of non-system messages for the agent
    const transcript = messages
      .filter((m) => m.role !== 'system')
      .map((m) => {
        if (m.role === 'user') return `[USER]: ${m.content}`;
        if (m.role === 'assistant') {
          if (m.tool_calls?.length) return `[ASSISTANT tool_calls]: ${JSON.stringify(m.tool_calls)}`;
          return `[ASSISTANT]: ${m.content || ''}`;
        }
        if (m.role === 'tool') return `[TOOL RESULT id=${m.tool_call_id}]: ${m.content}`;
        return `[${m.role}]: ${m.content || ''}`;
      })
      .join('\n');

    const user = transcript || messages.filter((m) => m.role === 'user').pop()?.content || '';

    const resp = await this._request('chat', system, user, {
      reply: 'string (English, casual but sharp, concise)',
    });

    if (!resp.ok || !resp.result) {
      return { role: 'assistant', content: 'LLM backend unavailable' };
    }

    // If the agent returned tool_calls, pass them through
    if (resp.tool_calls?.length) {
      return { role: 'assistant', content: null, tool_calls: resp.tool_calls };
    }

    return { role: 'assistant', content: String(resp.result.reply || '') };
  }
}
