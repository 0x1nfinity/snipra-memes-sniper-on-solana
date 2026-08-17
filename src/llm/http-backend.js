import { getConfig } from '../config.js';
import { fetchJson, sanitizePromptField } from '../utils.js';
import { createLogger } from '../logger.js';

const log = createLogger('http-backend');

/**
 * Parse JSON dengan fallback regex extraction dari markdown code blocks.
 * Model murah kadang membungkus JSON dalam ```json ... ``` atau ``` ... ```.
 */
function tryParseJson(content) {
  try {
    return JSON.parse(content);
  } catch {
    // Try extracting from ```json ... ``` block
    const fenced = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenced) {
      try { return JSON.parse(fenced[1]); } catch { /* continue */ }
    }
    // Try extracting the first { ... } or [ ... ] object
    const bare = content.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (bare) {
      try { return JSON.parse(bare[1]); } catch { /* continue */ }
    }
    throw new Error(`Failed to parse JSON from LLM response: ${content.slice(0, 200)}`);
  }
}

const PROVIDERS = {
  openrouter: {
    url: 'https://openrouter.ai/api/v1/chat/completions',
    keyEnv: 'OPENROUTER_API_KEY',
  },
  deepseek: {
    url: 'https://api.deepseek.com/chat/completions',
    keyEnv: 'DEEPSEEK_API_KEY',
    fallbackModel: 'deepseek-chat',
  },
};

/**
 * Parse the LLM's {"verdicts":[{index, action, confidence, risk, reason}, ...]}
 * response into a fixed-length array aligned to the input candidate order.
 * Index yang TIDAK dijawab LLM di-default ke confidence 0 (= ditolak gate), bukan
 * buy 0.5 — respons batch parsial (mis. model murah yang truncate) tidak boleh
 * diam-diam membeli token yang belum benar-benar dinilai.
 */
export function parseBatchVerdicts(parsed, count) {
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const out = Array.from({ length: count }, () => ({
    action: 'buy',
    confidence: 0,
    risk: 'medium',
    reason: 'no verdict returned',
  }));
  const verdicts = Array.isArray(parsed?.verdicts) ? parsed.verdicts : [];
  for (const v of verdicts) {
    const i = Number(v.index);
    if (!Number.isInteger(i) || i < 0 || i >= count) continue;
    out[i] = {
      action: v.action === 'skip' ? 'skip' : 'buy',
      confidence: clamp(Number(v.confidence) || 0, 0, 1),
      risk: ['low', 'medium', 'high'].includes(v.risk) ? v.risk : 'medium',
      reason: String(v.reason || '').slice(0, 300),
    };
  }
  return out;
}

export class HttpBackend {
  async _completion(messages, { json = false, tools = null, model = null, maxTokens = 700 } = {}) {
    const cfg = getConfig().llm;
    const p = PROVIDERS[cfg.provider];
    if (!p) throw new Error(`unknown LLM provider: ${cfg.provider}`);
    const key = process.env[p.keyEnv];
    if (!key) throw new Error(`${p.keyEnv} is empty`);
    const resolvedModel =
      cfg.provider === 'deepseek' && (model || cfg.model)?.includes('/')
        ? p.fallbackModel
        : model || cfg.model || p.fallbackModel;
    const body = { model: resolvedModel, messages, temperature: 0.2, max_tokens: maxTokens };
    if (json) body.response_format = { type: 'json_object' };
    if (tools?.length) body.tools = tools;
    const res = await fetchJson(p.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        ...(cfg.provider === 'openrouter' ? { 'X-Title': 'snipra' } : {}),
      },
      body: JSON.stringify(body),
    }, { timeoutMs: 45000, retries: 1 });
    const msg = res?.choices?.[0]?.message;
    if (!msg) throw new Error(`empty LLM response: ${JSON.stringify(res).slice(0, 200)}`);
    return msg;
  }

  async _chat(messages, { json = true, model = null, maxTokens = 700 } = {}) {
    const msg = await this._completion(messages, { json, model, maxTokens });
    if (!msg.content) throw new Error('respons LLM tanpa content');
    return msg.content;
  }

  async assessBatch(candidates, lessonBlock, fmtUsd, { model } = {}) {
    const list = candidates.map((c, i) =>
      `[${i}] ${sanitizePromptField(c.symbol)} (${sanitizePromptField(c.name)}) on ${c.chain}, dex ${c.dexId}\n` +
      `  Pair age: ${c.ageMinutes?.toFixed(0)} min | MC ${fmtUsd(c.marketCap)} | Liq ${fmtUsd(c.liquidityUsd)} | Vol24h ${fmtUsd(c.volume24h)}\n` +
      `  Holders ${c.holders ?? 'unknown'} | top10 ${c.top10Pct != null ? c.top10Pct.toFixed(0) + '%' : 'unknown'} | tx24h ${c.traders24h} (buy/sell ${c.buySellRatio?.toFixed(2)})\n` +
      `  Price change: 1h ${c.priceChange?.h1}% | 6h ${c.priceChange?.h6}% | 24h ${c.priceChange?.h24}%\n` +
      `  Security: honeypot=${c.security?.honeypot ?? 'unknown'}, mintable=${c.security?.mintable ?? 'unknown'}`
    ).join('\n\n');

    const prompt = `You are an aggressive, profit-seeking memecoin sniper. Your ONLY goal is to maximize profit. Every token below ALREADY PASSED strict hard filters (liquidity, volume, age, market cap, holder count, holder concentration, honeypot check). Default to BUY — only skip if there is CLEAR evidence of scam, honeypot, or zero liquidity. Be bold: the filters are your safety net, don't add your own. Assess EACH token INDEPENDENTLY — do not compare them or ration your "buy" verdicts.

TOKENS:
${list}

LESSONS FROM PAST TRADES (internalize them):
${lessonBlock}

Reply ONLY JSON: {"verdicts":[{"index":<int>,"action":"buy"|"skip","confidence":<0-1>,"risk":"low"|"medium"|"high","reason":"<1 short sentence, English>"}, ...]} — exactly one entry per token index (0 to ${candidates.length - 1}).`;

    // Budget output ikut jumlah kandidat — 700 (default single-candidate) bisa
    // memotong respons batch besar, dan JSON terpotong = seluruh batch gagal parse.
    // Math.max(700, …): formula 300+120n turun DI BAWAH 700 utk batch kecil (1-3
    // kandidat) — floor 700 mencegah budget batch kecil malah lebih sempit dari
    // default single-candidate.
    const maxTokens = Math.max(700, Math.min(4000, 300 + 120 * candidates.length));
    const content = await this._chat([{ role: 'user', content: prompt }], { model, maxTokens });
    const parsed = tryParseJson(content);
    return parseBatchVerdicts(parsed, candidates.length);
  }

  async recordLesson(trade) {
    const v = trade.llmVerdict;
    const prompt = `A memecoin trade just closed. Write ONE short, actionable lesson (max 25 words, ENGLISH) to improve future screening/entry decisions. Focus on a transferable pattern, not this specific token.

TRADE:
- ${sanitizePromptField(trade.symbol)} on ${trade.chain}, held ${trade.holdMinutes?.toFixed(0)} min
- Final PnL: ${trade.finalPnlPct?.toFixed(1)}%
- Close reason: ${trade.closeReason}
- Entry verdict: ${v ? `action=${v.action ?? '?'} confidence=${v.confidence ?? '?'} risk=${v.risk ?? '?'} — ${v.reason ?? ''}` : 'none'}
- TP tiers hit: ${trade.tpHit?.length || 0}

Reply ONLY JSON: {"lesson":"<english lesson>"}`;
    const content = await this._chat([{ role: 'user', content: prompt }]);
    const parsed = tryParseJson(content);
    if (parsed.lesson) return String(parsed.lesson).slice(0, 300);
    return null;
  }

  async suggestGenes({ geneSpace, currentFilters, genomes, trades, lessonsText }) {
    const prompt = `Kamu ahli optimasi strategi screening memecoin. Bot memfilter token dengan sekumpulan threshold. Analisis data di bawah dan REKOMENDASIKAN perubahan nilai filter yang menurutmu memperbaiki profit. Rekomendasi ini akan DITINJAU MANUAL oleh user (tidak diterapkan otomatis), jadi berikan usulan konkret + alasan.

BATAS WAJAR TIAP FILTER (jangan usulkan di luar range ini):
${JSON.stringify(geneSpace, null, 1)}

KONFIG FILTER SAAT INI (baseline user):
${JSON.stringify(currentFilters, null, 1)}

PERFORMA GENOME EKSPERIMEN (fitness = avg PnL% berbobot jumlah trade; genes = set threshold yang dicoba):
${JSON.stringify(genomes, null, 1)}

TRADE TERAKHIR (symbol, chain, pnl%, alasan close, menit hold):
${JSON.stringify(trades, null, 1)}

LESSONS:
${lessonsText || '(belum ada)'}

Boleh mengusulkan filter lebih KETAT maupun lebih LONGGAR dari baseline, asalkan di dalam batas wajar dan didukung data.
Balas HANYA JSON: {"genes": {<nama filter>: <angka>, ...}, "rationale": "<2-3 kalimat bahasa Indonesia, jelaskan alasannya berbasis data di atas>"}
Sertakan HANYA filter yang ingin kamu ubah dari baseline (boleh subset, boleh kosong bila tidak ada usulan).`;

    const content = await this._chat([{ role: 'user', content: prompt }]);
    const parsed = tryParseJson(content);
    if (!parsed?.genes || typeof parsed.genes !== 'object') return null;
    return {
      genes: parsed.genes,
      rationale: String(parsed.rationale || '').slice(0, 500),
    };
  }

  async evaluatePositions(positions, fmtUsd) {
    if (!positions || positions.length === 0) return [];

    const lines = positions.map((p, i) => {
      const e = p.entryMetrics || {};
      const m = p.currentMetrics || {};
      const peakPnlPct = p.entryPrice > 0 ? ((p.peakPrice - p.entryPrice) / p.entryPrice) * 100 : 0;
      const currentPnlPct = p.entryPrice > 0 ? ((p.currentPrice - p.entryPrice) / p.entryPrice) * 100 : 0;
      const ageMin = Math.round((Date.now() - p.openedAt) / 60000);
      const tpCount = p.tpHit?.length ?? 0;
      const tpTotal = (p.cfgTpLadderLen ?? 3); // di-inject oleh caller
      return (
        `[${i}] ${sanitizePromptField(p.symbol)} (${p.chain}) — held ${ageMin}m\n` +
        `  ENTRY:  price ${fmtUsd(e.priceUsd ?? p.entryPrice)} | MC ${fmtUsd(e.marketCap)} | holders ${e.holders ?? '?'} | top10 ${e.top10Pct != null ? e.top10Pct.toFixed(0) + '%' : '?'} | smart_wallets ${e.smartDegenCount ?? '?'}\n` +
        `  NOW:    price ${fmtUsd(m.priceUsd ?? p.currentPrice)} | MC ${fmtUsd(m.marketCap)} | holders ${m.holders ?? '?'} | top10 ${m.top10Pct != null ? m.top10Pct.toFixed(0) + '%' : '?'} | smart_wallets ${m.smartDegenCount ?? '?'}\n` +
        `  DELTA:  PnL ${currentPnlPct.toFixed(1)}% (peak ${peakPnlPct.toFixed(1)}%) | TP tiers hit ${tpCount}/${tpTotal} | trailing ${p.trailingActive ? 'active' : 'inactive'} | remaining ${p.remainingPct?.toFixed(0) ?? 100}%`
      );
    }).join('\n\n');

    const prompt = `You are managing open positions for an aggressive Solana memecoin sniper. Your job: decide whether each open position is still WORTH HOLDING based on how the metrics changed since entry.

For each position below, compare ENTRY metrics (when we bought) vs NOW metrics (current). Decide:
- HOLD: position still healthy — holders not collapsing, top10 not concentrating, MC not dumping, smart money still present. Hold.
- CLOSE: momentum lost — holders dumped, top10 concentrated (rug risk), MC collapsed significantly, smart money exited, or peak PnL was good and we're now fading. EXIT NOW even if SL/TP not triggered.

Default to HOLD unless there is CLEAR evidence the position should be exited. We already have hard SL/TP/trailing as a backstop — only override them when you see something they don't.

Be data-driven. Compare numbers, don't speculate.

POSITIONS (${positions.length}):
${lines}

Reply ONLY JSON: {"verdicts":[{"index":<int>,"action":"hold"|"close","confidence":<0-1>,"reason":"<1 short sentence, English>"}, ...]} — exactly one entry per index (0 to ${positions.length - 1}).`;

    const maxTokens = Math.max(800, Math.min(4000, 250 + 150 * positions.length));
    const content = await this._chat([{ role: 'user', content: prompt }], { maxTokens });
    const parsed = tryParseJson(content);

    const out = Array.from({ length: positions.length }, () => ({
      action: 'hold', confidence: 0, reason: 'no verdict returned',
    }));
    const verdicts = Array.isArray(parsed?.verdicts) ? parsed.verdicts : [];
    for (const v of verdicts) {
      const i = Number(v.index);
      if (!Number.isInteger(i) || i < 0 || i >= positions.length) continue;
      out[i] = {
        action: v.action === 'close' ? 'close' : 'hold',
        confidence: Math.max(0, Math.min(1, Number(v.confidence) || 0)),
        reason: String(v.reason || '').slice(0, 300),
      };
    }
    return out;
  }

  async deriveLessons(trades, existingLessons) {
    const tradeLines = trades.map((t, i) =>
      `${i + 1}. ${sanitizePromptField(t.symbol)} ${t.chain} — PnL ${t.pnl_pct?.toFixed(1)}% · ` +
      `hold ${Math.round(t.hold_minutes ?? 0)}m · alasan: ${t.close_reason}` +
      (t.llm_score ? ` · LLM conf ${t.llm_score.toFixed(2)}` : '')
    ).join('\n');
    const lessonLines = (existingLessons || []).slice(-20).map((l, i) =>
      `${i + 1}. [${l.outcome}] ${l.text}`
    ).join('\n');
    const prompt = `You are reviewing a COMPLETED paper trading session before resetting it. Analyze ALL closed trades below and extract 3-5 HIGH-LEVEL strategic lessons (max 30 words each, ENGLISH). Focus on patterns across multiple trades — not single-trade observations. These lessons will be the ONLY thing carried forward to the next session.

CLOSED TRADES (will be deleted after this):
${tradeLines || '(none)'}

EXISTING LESSONS (carried forward, don't repeat them):
${lessonLines || '(none)'}

Reply ONLY JSON: {"lessons":[{"text":"...","outcome":"WIN|LOSS|PATTERN"}, ...]}`;
    // Default 700 sering habis oleh reasoning tokens model sebelum sempat keluarkan
    // content (respons kosong) — apalagi dgn banyak trade di prompt. Naikkan seperti
    // assessBatch, floor 1500 krn output lessons sendiri pendek tapi reasoning-nya besar.
    const maxTokens = Math.max(1500, Math.min(4000, 500 + 15 * trades.length));
    const content = await this._chat([{ role: 'user', content: prompt }], { maxTokens });
    const parsed = tryParseJson(content);
    const lessons = [];
    if (Array.isArray(parsed.lessons)) {
      for (const l of parsed.lessons) {
        if (!l.text) continue;
        lessons.push({
          text: String(l.text).slice(0, 300),
          outcome: l.outcome === 'LOSS' ? 'LOSS' : l.outcome === 'PATTERN' ? 'PATTERN' : 'WIN',
        });
      }
    }
    return lessons;
  }

  async chat(messages, { tools = null } = {}) {
    const msg = await this._completion(messages, { tools });
    return msg;
  }

  available() {
    const cfg = getConfig().llm;
    const p = PROVIDERS[cfg.provider];
    return Boolean(p && process.env[p.keyEnv]);
  }
}
