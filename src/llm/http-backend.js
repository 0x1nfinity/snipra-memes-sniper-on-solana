import { getConfig } from '../config.js';
import { fetchJson } from '../utils.js';

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
 * Missing/invalid entries default to a safe "buy" (matches assessToken()'s
 * single-candidate default — the hard filters already did the heavy lifting).
 */
export function parseBatchVerdicts(parsed, count) {
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const out = Array.from({ length: count }, () => ({
    action: 'buy',
    confidence: 0.5,
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
  async _completion(messages, { json = false, tools = null, model = null } = {}) {
    const cfg = getConfig().llm;
    const p = PROVIDERS[cfg.provider];
    if (!p) throw new Error(`unknown LLM provider: ${cfg.provider}`);
    const key = process.env[p.keyEnv];
    if (!key) throw new Error(`${p.keyEnv} is empty`);
    const resolvedModel =
      cfg.provider === 'deepseek' && (model || cfg.model)?.includes('/')
        ? p.fallbackModel
        : model || cfg.model || p.fallbackModel;
    const body = { model: resolvedModel, messages, temperature: 0.2, max_tokens: 700 };
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

  async _chat(messages, { json = true, model = null } = {}) {
    const msg = await this._completion(messages, { json, model });
    if (!msg.content) throw new Error('respons LLM tanpa content');
    return msg.content;
  }

  async assessToken(c, lessonBlock, fmtUsd) {
    const prompt = `You are an aggressive but disciplined memecoin sniper. The token below ALREADY PASSED all strict hard filters (liquidity, volume, age, market cap, holder count, holder concentration, honeypot check). Your default decision is BUY. Only choose "skip" if there is a SERIOUS red flag (e.g. clear dump in progress, extreme holder concentration, obvious rug pattern). Do NOT reject just because liquidity/market cap is "moderate" — the filters already guarantee a floor. Express your view through confidence only; position size is fixed by config.

TOKEN:
- ${c.symbol} (${c.name}) on ${c.chain}, dex ${c.dexId}
- Pair age: ${c.ageMinutes?.toFixed(0)} min
- Market cap ${fmtUsd(c.marketCap)} | Liquidity ${fmtUsd(c.liquidityUsd)} | Vol24h ${fmtUsd(c.volume24h)} (vol/liq ${(c.volume24h / (c.liquidityUsd || 1)).toFixed(2)})
- Holders ${c.holders ?? 'unknown'} | top10 ${c.top10Pct != null ? c.top10Pct.toFixed(0) + '%' : 'unknown'} | tx24h ${c.traders24h} (buy/sell ${c.buySellRatio?.toFixed(2)})
- Price change: 1h ${c.priceChange?.h1}% | 6h ${c.priceChange?.h6}% | 24h ${c.priceChange?.h24}%
- Socials ${c.socials} | Security: honeypot=${c.security?.honeypot ?? 'unknown'}, mintable=${c.security?.mintable ?? 'unknown'}

LESSONS FROM PAST TRADES (consider them):
${lessonBlock}

Reply ONLY JSON: {"action":"buy"|"skip","confidence":<0-1>,"risk":"low"|"medium"|"high","reason":"<1 short sentence, Indonesian>"}`;

    const content = await this._chat([{ role: 'user', content: prompt }]);
    const p = JSON.parse(content);
    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
    return {
      action: p.action === 'skip' ? 'skip' : 'buy',
      confidence: clamp(Number(p.confidence) || 0, 0, 1),
      risk: ['low', 'medium', 'high'].includes(p.risk) ? p.risk : 'medium',
      reason: String(p.reason || '').slice(0, 300),
    };
  }

  async assessBatch(candidates, lessonBlock, fmtUsd, { model } = {}) {
    const list = candidates.map((c, i) =>
      `[${i}] ${c.symbol} (${c.name}) on ${c.chain}, dex ${c.dexId}\n` +
      `  Pair age: ${c.ageMinutes?.toFixed(0)} min | MC ${fmtUsd(c.marketCap)} | Liq ${fmtUsd(c.liquidityUsd)} | Vol24h ${fmtUsd(c.volume24h)}\n` +
      `  Holders ${c.holders ?? 'unknown'} | top10 ${c.top10Pct != null ? c.top10Pct.toFixed(0) + '%' : 'unknown'} | tx24h ${c.traders24h} (buy/sell ${c.buySellRatio?.toFixed(2)})\n` +
      `  Price change: 1h ${c.priceChange?.h1}% | 6h ${c.priceChange?.h6}% | 24h ${c.priceChange?.h24}%\n` +
      `  Security: honeypot=${c.security?.honeypot ?? 'unknown'}, mintable=${c.security?.mintable ?? 'unknown'}`
    ).join('\n\n');

    const prompt = `You are an aggressive but disciplined memecoin sniper. Every token below ALREADY PASSED strict hard filters (liquidity, volume, age, market cap, holder count, holder concentration, honeypot check). Your default decision per token is BUY. Only "skip" a token if there is a SERIOUS red flag for THAT token. Assess EACH token INDEPENDENTLY — do not compare them against each other or ration your "buy" verdicts.

TOKENS:
${list}

LESSONS FROM PAST TRADES (consider them):
${lessonBlock}

Reply ONLY JSON: {"verdicts":[{"index":<int>,"action":"buy"|"skip","confidence":<0-1>,"risk":"low"|"medium"|"high","reason":"<1 short sentence, Indonesian>"}, ...]} — exactly one entry per token index (0 to ${candidates.length - 1}).`;

    const content = await this._chat([{ role: 'user', content: prompt }], { model });
    const parsed = JSON.parse(content);
    return parseBatchVerdicts(parsed, candidates.length);
  }

  async recordLesson(trade) {
    const v = trade.llmVerdict;
    const prompt = `A memecoin trade just closed. Write ONE short, actionable lesson (max 25 words, ENGLISH) to improve future screening/entry decisions. Focus on a transferable pattern, not this specific token.

TRADE:
- ${trade.symbol} on ${trade.chain}, held ${trade.holdMinutes?.toFixed(0)} min
- Final PnL: ${trade.finalPnlPct?.toFixed(1)}%
- Close reason: ${trade.closeReason}
- Entry verdict: ${v ? `action=${v.action ?? '?'} confidence=${v.confidence ?? '?'} risk=${v.risk ?? '?'} — ${v.reason ?? ''}` : 'none'}
- TP tiers hit: ${trade.tpHit?.length || 0}

Reply ONLY JSON: {"lesson":"<english lesson>"}`;
    const content = await this._chat([{ role: 'user', content: prompt }]);
    const parsed = JSON.parse(content);
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
    const parsed = JSON.parse(content);
    if (!parsed?.genes || typeof parsed.genes !== 'object') return null;
    return {
      genes: parsed.genes,
      rationale: String(parsed.rationale || '').slice(0, 500),
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
    const prompt = `You are reviewing a COMPLETED paper trading session before resetting it. Analyze ALL closed trades below and extract 3-5 HIGH-LEVEL strategic lessons (max 30 words each, ENGLISH). Focus on patterns across multiple trades — not single-trade observations. These lessons will be the ONLY thing carried forward to the next session.

CLOSED TRADES (will be deleted after this):
${tradeLines || '(none)'}

EXISTING LESSONS (carried forward, don't repeat them):
${lessonLines || '(none)'}

Reply ONLY JSON: {"lessons":[{"text":"...","outcome":"WIN|LOSS|PATTERN"}, ...]}`;
    const content = await this._chat([{ role: 'user', content: prompt }]);
    const parsed = JSON.parse(content);
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
