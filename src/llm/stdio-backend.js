import { createInterface } from 'readline';
import { fmtUsd } from '../utils.js';

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

  _failOpen(result) {
    return result;
  }

  async assessToken(c, lessonBlock) {
    const system = `You are an aggressive but disciplined memecoin sniper. The token below ALREADY PASSED all strict hard filters (liquidity, volume, age, market cap, holder count, holder concentration, honeypot check). Your default decision is BUY. Only choose "skip" if there is a SERIOUS red flag (e.g. clear dump in progress, extreme holder concentration, obvious rug pattern). Do NOT reject just because liquidity/market cap is "moderate" — the filters already guarantee a floor. Express your view through confidence only; position size is fixed by config.`;
    const user = `TOKEN:
- ${c.symbol} (${c.name}) on ${c.chain}, dex ${c.dexId}
- Pair age: ${c.ageMinutes?.toFixed(0)} min
- Market cap ${fmtUsd(c.marketCap)} | Liquidity ${fmtUsd(c.liquidityUsd)} | Vol24h ${fmtUsd(c.volume24h)} (vol/liq ${(c.volume24h / (c.liquidityUsd || 1)).toFixed(2)})
- Holders ${c.holders ?? 'unknown'} | top10 ${c.top10Pct != null ? c.top10Pct.toFixed(0) + '%' : 'unknown'} | tx24h ${c.traders24h} (buy/sell ${c.buySellRatio?.toFixed(2)})
- Price change: 1h ${c.priceChange?.h1}% | 6h ${c.priceChange?.h6}% | 24h ${c.priceChange?.h24}%
- Socials ${c.socials} | Security: honeypot=${c.security?.honeypot ?? 'unknown'}, mintable=${c.security?.mintable ?? 'unknown'}

LESSONS FROM PAST TRADES (consider them):
${lessonBlock}

Reply ONLY JSON: {"action":"buy"|"skip","confidence":<0-1>,"risk":"low"|"medium"|"high","reason":"<1 short sentence, Indonesian>"}`;

    const resp = await this._request('assess_token', system, user, {
      action: 'buy|skip',
      confidence: 'number 0-1',
      risk: 'low|medium|high',
      reason: 'string',
    });

    if (!resp.ok || !resp.result) {
      return { action: 'buy', confidence: 0.5, risk: 'medium', reason: 'LLM unavailable (failOpen)' };
    }

    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
    return {
      action: resp.result.action === 'skip' ? 'skip' : 'buy',
      confidence: clamp(Number(resp.result.confidence) || 0, 0, 1),
      risk: ['low', 'medium', 'high'].includes(resp.result.risk) ? resp.result.risk : 'medium',
      reason: String(resp.result.reason || '').slice(0, 300),
    };
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
    const system = `Kamu ahli optimasi strategi screening memecoin. Bot memfilter token dengan sekumpulan threshold. Analisis data dan REKOMENDASIKAN perubahan nilai filter. Rekomendasi ini akan DITINJAU MANUAL oleh user (tidak diterapkan otomatis).`;
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

Reply ONLY JSON: {"genes": {<nama filter>: <angka>, ...}, "rationale": "<2-3 kalimat bahasa Indonesia>"}
Sertakan HANYA filter yang ingin diubah dari baseline.`;

    const resp = await this._request('suggest_genes', system, user, {
      genes: 'object mapping filter names to numbers',
      rationale: 'string (Indonesian)',
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
    // Extract system and user from messages for the protocol
    const systemMsg = messages.find((m) => m.role === 'system');
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');

    const system = systemMsg?.content || '';
    const user = lastUser?.content || '';

    const resp = await this._request('chat', system, user, {
      reply: 'string (Indonesian, santai tapi tajam, ringkas)',
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
