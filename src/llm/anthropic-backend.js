/**
 * Anthropic-compatible backend (POST /v1/messages, x-api-key auth).
 *
 * Currently used to talk to MiniMax, which exposes its chat-completions
 * surface via the Anthropic Messages protocol. Other Anthropic-compatible
 * providers can be added to PROVIDERS below.
 *
 * Wire-up (src/index.js, src/skills/runner.js):
 *   provider === 'minimax' → AnthropicBackend
 *   else                   → HttpBackend (OpenAI-compatible)
 *
 * LLM.js chat() loop expects messages in OpenAI shape (`role`/`content`/
 * `tool_calls`/`tool_call_id`). This backend translates to/from the
 * Anthropic content-block shape at the wire boundary so the rest of the
 * pipeline (LLM loop, tool runner) doesn't need to know it's not OpenAI.
 */
import { getConfig } from '../config.js';
import { fetchJson, sanitizePromptField } from '../utils.js';
import { createLogger } from '../logger.js';
import { parseBatchVerdicts } from './http-backend.js';

const log = createLogger('anthropic-backend');

// Per-provider Anthropic-compatible config. `url` is overridable via
// live-config.json:llm.anthropicUrl in case the provider host changes.
// NOTE: URL MiniMax yang benar = /anthropic/v1/messages (di bawah subdomain
// api.minimax.io). Sebelumnya saya tulis api.minimaxi.chat (404) — salah.
const PROVIDERS = {
  minimax: {
    url: 'https://api.minimax.io/anthropic/v1/messages',
    keyEnv: 'MINIMAX_API_KEY',
    defaultModel: 'MiniMax-M3',
  },
};

function getProvider() {
  const cfg = getConfig().llm;
  const p = PROVIDERS[cfg.provider];
  if (!p) {
    throw new Error(
      `anthropic backend: unsupported provider "${cfg.provider}" ` +
      `(expected one of: ${Object.keys(PROVIDERS).join(', ')})`
    );
  }
  return p;
}

function providerUrl() {
  const p = getProvider();
  return getConfig().llm.anthropicUrl || p.url;
}

function providerHeaders() {
  const p = getProvider();
  const key = process.env[p.keyEnv];
  if (!key) throw new Error(`${p.keyEnv} is empty`);
  return {
    'Content-Type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
  };
}

function defaultModel() {
  return getConfig().llm.model || getProvider().defaultModel;
}

// JSON parser with fallback for models that wrap JSON in markdown code fences.
function tryParseJson(content) {
  try {
    return JSON.parse(content);
  } catch {
    const fenced = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenced) {
      try { return JSON.parse(fenced[1]); } catch { /* continue */ }
    }
    const bare = content.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (bare) {
      try { return JSON.parse(bare[1]); } catch { /* continue */ }
    }
    throw new Error(`Failed to parse JSON from LLM response: ${content.slice(0, 200)}`);
  }
}

/**
 * Convert an OpenAI-shape messages array → { system, messages } in Anthropic shape.
 * - `system` lifted out of the messages array (Anthropic requires it as a top-level field).
 * - tool result messages → Anthropic `tool_result` content blocks under a user message.
 * - assistant tool_calls → Anthropic `tool_use` content blocks.
 */
function splitAndConvert(messages) {
  let system = null;
  const converted = [];
  for (const m of messages || []) {
    if (m.role === 'system') {
      // Multiple system messages are concatenated — Anthropic's `system` field is a string.
      system = system ? `${system}\n\n${m.content}` : m.content;
      continue;
    }
    if (m.role === 'tool') {
      // OpenAI tool result: { role: 'tool', tool_call_id, content }
      // Anthropic: { role: 'user', content: [{ type: 'tool_result', tool_use_id, content }] }
      let parsed;
      try { parsed = JSON.parse(m.content); } catch { parsed = m.content; }
      const text = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
      converted.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: text }],
      });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls) {
        let input = {};
        try { input = JSON.parse(tc.function.arguments); } catch { /* leave {} on parse error */ }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      converted.push({ role: 'assistant', content: blocks });
      continue;
    }
    converted.push({ role: m.role, content: m.content });
  }
  return { system, messages: converted };
}

// OpenAI tool defs → Anthropic tool defs (input_schema instead of parameters).
function convertTools(tools) {
  if (!tools?.length) return null;
  return tools.map((t) => {
    const fn = t.function || t;
    return {
      name: fn.name,
      description: fn.description || '',
      input_schema: fn.parameters || { type: 'object', properties: {} },
    };
  });
}

// Anthropic response.content → OpenAI-shape message (for llm.js compatibility).
function convertResponse(json) {
  const blocks = json.content || [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const toolUses = blocks.filter((b) => b.type === 'tool_use');
  if (toolUses.length === 0) {
    return { role: 'assistant', content: text || '' };
  }
  return {
    role: 'assistant',
    content: text || null,
    tool_calls: toolUses.map((t) => ({
      id: t.id,
      type: 'function',
      function: { name: t.name, arguments: JSON.stringify(t.input || {}) },
    })),
  };
}

function extractText(json) {
  const blocks = json.content || [];
  return blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

export class AnthropicBackend {
  async _rawCall(body, { maxTokens = 4096 } = {}) {
    const fullBody = { max_tokens: maxTokens, ...body };
    log.debug(`anthropic request: model=${body.model}, max_tokens=${maxTokens}`);
    return fetchJson(providerUrl(), {
      method: 'POST',
      headers: providerHeaders(),
      body: JSON.stringify(fullBody),
    }, { timeoutMs: 60000, retries: 1 });
  }

  // Full chat with optional tool use — returns an OpenAI-shape message.
  async _completion(messages, { tools = null, maxTokens = 4096 } = {}) {
    const { system, messages: convMessages } = splitAndConvert(messages);
    const body = {
      model: defaultModel(),
      messages: convMessages,
    };
    if (system) body.system = system;
    const anthropicTools = convertTools(tools);
    if (anthropicTools) body.tools = anthropicTools;

    const json = await this._rawCall(body, { maxTokens });
    if (!json?.content?.length) {
      throw new Error(`empty Anthropic response: ${JSON.stringify(json).slice(0, 200)}`);
    }
    return convertResponse(json);
  }

  // Single-turn text-only call. Returns the text content of the response.
  async _chatText(messages, { maxTokens = 1024, model = null } = {}) {
    const { system, messages: convMessages } = splitAndConvert(messages);
    const body = {
      model: model || defaultModel(),
      messages: convMessages,
    };
    if (system) body.system = system;

    const json = await this._rawCall(body, { maxTokens });
    const text = extractText(json);
    if (!text) throw new Error('Anthropic response without text content');
    return text;
  }

  async assessBatch(candidates, lessonBlock, fmtUsd, { model } = {}) {
    const list = candidates.map((c, i) =>
      `[${i}] ${sanitizePromptField(c.symbol)} (${sanitizePromptField(c.name)}) on ${c.chain}, dex ${c.dexId}\n` +
      `  Pair age: ${c.ageMinutes?.toFixed(0)} min | MC ${fmtUsd(c.marketCap)} | Liq ${fmtUsd(c.liquidityUsd)} | Vol24h ${fmtUsd(c.volume24h)}\n` +
      `  Holders ${c.holders ?? 'unknown'} | top10 ${c.top10Pct != null ? c.top10Pct.toFixed(0) + '%' : 'unknown'} | tx24h ${c.traders24h} (buy/sell ${c.buySellRatio?.toFixed(2)})\n` +
      `  Price change: 1h ${c.priceChange?.h1}% | 6h ${c.priceChange?.h6}% | 24h ${c.priceChange?.h24}%\n` +
      `  Security: honeypot=${c.security?.honeypot ?? 'unknown'}, mintable=${c.security?.mintable ?? 'unknown'}`
    ).join('\n\n');

    const prompt = `You are an aggressive, profit-seeking memecoin sniper. Your ONLY goal is to maximize profit. Every token below ALREADY PASSED strict hard filters (liquidity, volume, age, market cap, holder count, honeypot check). Default to BUY — only skip if there is CLEAR evidence of scam, honeypot, or zero liquidity. Be bold: the filters are your safety net, don't add your own. Assess EACH token INDEPENDENTLY — do not compare them or ration your "buy" verdicts.

TOKENS:
${list}

LESSONS FROM PAST TRADES (internalize them):
${lessonBlock}

Reply ONLY JSON: {"verdicts":[{"index":<int>,"action":"buy"|"skip","confidence":<0-1>,"risk":"low"|"medium"|"high","reason":"<1 short sentence, English>"}, ...]} — exactly one entry per token index (0 to ${candidates.length - 1}).`;

    // Budget sama dgn HttpBackend — agar batch besar tidak terpotong & JSON gagal parse.
    const maxTokens = Math.max(1024, Math.min(4096, 300 + 120 * candidates.length));
    const text = await this._chatText([{ role: 'user', content: prompt }], { maxTokens, model });
    const parsed = tryParseJson(text);
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
    const text = await this._chatText([{ role: 'user', content: prompt }], { maxTokens: 1024 });
    const parsed = tryParseJson(text);
    if (parsed.lesson) return String(parsed.lesson).slice(0, 300);
    return null;
  }

  async suggestGenes({ geneSpace, currentFilters, genomes, trades, lessonsText }) {
    const prompt = `You are an expert at optimizing memecoin screening strategies. The bot filters tokens with a set of thresholds. Analyze the data below and RECOMMEND filter value changes you think would improve profit. Recommendations are MANUALLY REVIEWED by the user (not auto-applied), so be concrete with data-backed rationale.

REASONABLE BOUNDS PER FILTER (do not propose outside these ranges):
${JSON.stringify(geneSpace, null, 1)}

CURRENT FILTER CONFIG (user baseline):
${JSON.stringify(currentFilters, null, 1)}

EXPERIMENTAL GENOME PERFORMANCE (fitness = avg PnL% weighted by trade count; genes = set of thresholds tried):
${JSON.stringify(genomes, null, 1)}

RECENT TRADES (symbol, chain, pnl%, close reason, hold minutes):
${JSON.stringify(trades, null, 1)}

LESSONS:
${lessonsText || '(none yet)'}

You may propose filters TIGHTER or LOOSER than baseline, as long as within bounds and backed by data.
Reply ONLY JSON: {"genes": {<filter name>: <number>, ...}, "rationale": "<2-3 sentences English, data-backed>"}
Include ONLY filters you want to change from baseline (subset OK, empty OK if no suggestions).`;

    const text = await this._chatText([{ role: 'user', content: prompt }], { maxTokens: 2048 });
    const parsed = tryParseJson(text);
    if (!parsed?.genes || typeof parsed.genes !== 'object') return null;
    return {
      genes: parsed.genes,
      rationale: String(parsed.rationale || '').slice(0, 500),
    };
  }

  async deriveLessons(trades, existingLessons) {
    const tradeLines = trades.map((t, i) =>
      `${i + 1}. ${sanitizePromptField(t.symbol)} ${t.chain} — PnL ${t.pnl_pct?.toFixed(1)}% · ` +
      `hold ${Math.round(t.hold_minutes ?? 0)}m · close reason: ${t.close_reason}` +
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
    const maxTokens = Math.max(2048, Math.min(4096, 500 + 15 * trades.length));
    const text = await this._chatText([{ role: 'user', content: prompt }], { maxTokens });
    const parsed = tryParseJson(text);
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
    return this._completion(messages, { tools, maxTokens: 4096 });
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
      const tpTotal = (p.cfgTpLadderLen ?? 3);
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

    const maxTokens = Math.max(1024, Math.min(4096, 250 + 150 * positions.length));
    const text = await this._chatText([{ role: 'user', content: prompt }], { maxTokens });
    const parsed = tryParseJson(text);

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

  available() {
    const cfg = getConfig().llm;
    const p = PROVIDERS[cfg.provider];
    return Boolean(p && process.env[p.keyEnv]);
  }
}