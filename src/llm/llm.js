import fs from 'fs';
import path from 'path';
import { DATA_DIR, getConfig } from '../config.js';
import { fetchJson, fmtUsd } from '../utils.js';
import { createLogger } from '../logger.js';

const log = createLogger('llm');
const LESSONS_FILE = path.join(DATA_DIR, 'lessons.json');

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

let lessons = [];

export class LLM {
  constructor() {
    this._history = []; // riwayat chat singkat (rolling)
  }
  load() {
    if (fs.existsSync(LESSONS_FILE)) {
      try {
        const all = JSON.parse(fs.readFileSync(LESSONS_FILE, 'utf8'));
        // buang lesson lama non-English (lang != 'en') — lessons wajib English
        lessons = all.filter((l) => l.lang === 'en');
        if (lessons.length !== all.length) {
          this._persistLessons();
          log.info(`purged ${all.length - lessons.length} old non-English lessons`);
        }
      } catch { /* mulai kosong */ }
    }
    return this;
  }

  _persistLessons() {
    fs.writeFileSync(LESSONS_FILE, JSON.stringify(lessons, null, 2));
  }

  available() {
    const cfg = getConfig().llm;
    const p = PROVIDERS[cfg.provider];
    return Boolean(p && process.env[p.keyEnv]);
  }

  /** panggil chat completion, return message object penuh (content + tool_calls) */
  async _completion(messages, { json = false, tools = null } = {}) {
    const cfg = getConfig().llm;
    const p = PROVIDERS[cfg.provider];
    if (!p) throw new Error(`unknown LLM provider: ${cfg.provider}`);
    const key = process.env[p.keyEnv];
    if (!key) throw new Error(`${p.keyEnv} is empty`);

    // provider deepseek: model openrouter-style ("vendor/model") tidak valid → fallback
    const model =
      cfg.provider === 'deepseek' && cfg.model?.includes('/')
        ? p.fallbackModel
        : cfg.model || p.fallbackModel;
    const body = { model, messages, temperature: 0.2, max_tokens: 700 };
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

  /** helper: kembalikan content string saja (untuk prompt JSON satu-shot) */
  async _chat(messages, { json = true } = {}) {
    const msg = await this._completion(messages, { json });
    if (!msg.content) throw new Error('respons LLM tanpa content');
    return msg.content;
  }

  _lessonBlock() {
    const { maxLessons } = getConfig().llm;
    const recent = lessons.slice(-maxLessons);
    if (recent.length === 0) return '(none yet)';
    return recent.map((l, i) => `${i + 1}. [${l.outcome}] ${l.text}`).join('\n');
  }

  /**
   * Gate buy/skip: token SUDAH lolos semua hard filter ketat. Default = BUY.
   * LLM HANYA memutuskan buy/skip + confidence; ukuran posisi TIDAK lagi ditentukan
   * LLM — selalu = config trading.buyAmount (lihat index.js).
   * Return { action: 'buy'|'skip', confidence: 0-1, risk, reason }.
   */
  async assessToken(c) {
    const prompt = `You are an aggressive but disciplined memecoin sniper. The token below ALREADY PASSED all strict hard filters (liquidity, volume, age, market cap, holder count, holder concentration, honeypot check). Your default decision is BUY. Only choose "skip" if there is a SERIOUS red flag (e.g. clear dump in progress, extreme holder concentration, obvious rug pattern). Do NOT reject just because liquidity/market cap is "moderate" — the filters already guarantee a floor. Express your view through confidence only; position size is fixed by config.

TOKEN:
- ${c.symbol} (${c.name}) on ${c.chain}, dex ${c.dexId}
- Pair age: ${c.ageMinutes?.toFixed(0)} min
- Market cap ${fmtUsd(c.marketCap)} | Liquidity ${fmtUsd(c.liquidityUsd)} | Vol24h ${fmtUsd(c.volume24h)} (vol/liq ${(c.volume24h / (c.liquidityUsd || 1)).toFixed(2)})
- Holders ${c.holders ?? 'unknown'} | top10 ${c.top10Pct != null ? c.top10Pct.toFixed(0) + '%' : 'unknown'} | tx24h ${c.traders24h} (buy/sell ${c.buySellRatio?.toFixed(2)})
- Price change: 1h ${c.priceChange?.h1}% | 6h ${c.priceChange?.h6}% | 24h ${c.priceChange?.h24}%
- Socials ${c.socials} | Security: honeypot=${c.security?.honeypot ?? 'unknown'}, mintable=${c.security?.mintable ?? 'unknown'}

LESSONS FROM PAST TRADES (consider them):
${this._lessonBlock()}

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

  /**
   * Post-mortem trade yang sudah close → simpan lesson (bahasa Inggris, terstruktur)
   * untuk diinject ke keputusan berikutnya (feedback loop pembelajaran).
   */
  async recordTradeLesson(trade) {
    try {
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
      if (parsed.lesson) {
        lessons.push({
          text: String(parsed.lesson).slice(0, 300),
          outcome: trade.finalPnlPct >= 0 ? 'WIN' : 'LOSS',
          symbol: trade.symbol,
          chain: trade.chain,
          pnl: trade.finalPnlPct,
          lang: 'en',
          at: Date.now(),
        });
        if (lessons.length > 200) lessons = lessons.slice(-200);
        this._persistLessons();
        log.info(`new lesson: ${parsed.lesson}`);
        return parsed.lesson;
      }
    } catch (e) {
      log.warn('recordTradeLesson failed:', e.message);
    }
    return null;
  }

  getLessons(n = 10) {
    return lessons.slice(-n);
  }

  /**
   * Analisis batch semua trade paper yang akan dihapus saat /paperreset.
   * Ekstrak pola strategis (bukan per-trade) untuk dipelajari sebelum data hilang.
   * Return array lesson baru yang disimpan, atau [] bila LLM tidak tersedia.
   */
  async deriveResetLessons(trades, existingLessons) {
    if (!trades || trades.length === 0) return [];
    if (!this.available()) return [];
    try {
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
      const newLessons = [];
      if (Array.isArray(parsed.lessons)) {
        for (const l of parsed.lessons) {
          if (!l.text) continue;
          lessons.push({
            text: String(l.text).slice(0, 300),
            outcome: l.outcome === 'LOSS' ? 'LOSS' : l.outcome === 'PATTERN' ? 'PATTERN' : 'WIN',
            symbol: '*',
            chain: 'paper',
            pnl: 0,
            lang: 'en',
            at: Date.now(),
          });
          newLessons.push(l.text);
        }
        if (lessons.length > 200) lessons = lessons.slice(-200);
        this._persistLessons();
        log.info(`deriveResetLessons: ${newLessons.length} strategic lessons saved`);
      }
      return newLessons;
    } catch (e) {
      log.warn('deriveResetLessons failed:', e.message);
      return [];
    }
  }

  /**
   * Mode chatbot dengan tool-calling. `tools` = { defs: [openai tool schema],
   * run: async (name, args) => resultObj }. Bila null, chat murni tanpa aksi.
   * Return teks jawaban akhir.
   */
  async chat(userText, context, tools = null) {
    const canTool = Boolean(tools?.defs?.length);
    const system = {
      role: 'system',
      content:
        `Kamu adalah "snipra", bot sniper memecoin di Solana milik user. ` +
        `Jawab dalam bahasa Indonesia, santai tapi tajam, ringkas. ` +
        `Gunakan HANYA data pada konteks / hasil tool — jangan mengarang angka.\n` +
        (canTool
          ? `Kamu PUNYA tool untuk beraksi: screen_now, buy_token, sell_token, close_all_positions, get_positions. ` +
            `Jika user minta aksi (mis. "buy <address>", "jual X", "tutup semua"), PANGGIL tool yang sesuai — ` +
            `jangan menyuruh user mengetik command. Untuk buy/sell butuh address (chain selalu solana). ` +
            `Setelah tool jalan, laporkan hasilnya singkat.\n`
          : `Kamu tidak punya akses eksekusi; jika user minta aksi arahkan ke command /buy /sell /closeall.\n`) +
        `\nKONTEKS REALTIME:\n${context}`,
    };
    const messages = [system, ...this._history, { role: 'user', content: userText }];

    let finalText = '';
    for (let hop = 0; hop < 4; hop++) {
      const msg = await this._completion(messages, { tools: canTool ? tools.defs : null });
      messages.push(msg);
      if (msg.tool_calls?.length) {
        for (const call of msg.tool_calls) {
          let result;
          try {
            const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
            result = await tools.run(call.function.name, args);
          } catch (e) {
            result = { error: e.message };
          }
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(result).slice(0, 1500),
          });
        }
        continue; // panggil model lagi dengan hasil tool
      }
      finalText = msg.content || '';
      break;
    }
    // simpan ringkas ke history (tanpa tool plumbing agar hemat token)
    this._history.push({ role: 'user', content: userText }, { role: 'assistant', content: finalText });
    if (this._history.length > 12) this._history = this._history.slice(-12);
    return finalText || '(tidak ada jawaban)';
  }

  /**
   * Penasihat evolve: analisis performa genome + trade history + lessons,
   * usulkan satu set gen baru (di dalam batas hard limit user) untuk diinject
   * ke populasi generasi berikutnya.
   * Return { genes, rationale } atau null.
   */
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
}
