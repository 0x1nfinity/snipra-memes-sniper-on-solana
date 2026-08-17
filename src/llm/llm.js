import fs from 'fs';
import path from 'path';
import { DATA_DIR, getConfig } from '../config.js';
import { fmtUsd } from '../utils.js';
import { createLogger } from '../logger.js';

const log = createLogger('llm');
const LESSONS_FILE = path.join(DATA_DIR, 'lessons.json');

export class LLM {
  constructor({ backend } = {}) {
    this._history = [];
    this._lessons = [];   // instance-level — no shared module state
    this._backend = backend || null;
  }

  load() {
    if (fs.existsSync(LESSONS_FILE)) {
      try {
        const all = JSON.parse(fs.readFileSync(LESSONS_FILE, 'utf8'));
        const en = all.filter((l) => l.lang === 'en');
        if (en.length !== all.length) {
          this._lessons = en;
          this._persistLessons();
          log.info(`purged ${all.length - en.length} old non-English lessons`);
        } else {
          this._lessons = en;
        }
      } catch { /* mulai kosong */ }
    }
    return this;
  }

  _persistLessons() {
    fs.writeFileSync(LESSONS_FILE, JSON.stringify(this._lessons, null, 2));
  }

  available() {
    if (!this._backend) return false;
    if (typeof this._backend.available === 'function') return this._backend.available();
    return true;
  }

  _lessonBlock() {
    const { maxLessons } = getConfig().llm;
    const recent = this._lessons.slice(-maxLessons);
    if (recent.length === 0) return '(none yet)';
    return recent.map((l, i) => `${i + 1}. [${l.outcome}] ${l.text}`).join('\n');
  }

  getLessons(n = 10) {
    return this._lessons.slice(-n);
  }

  async assessBatch(candidates) {
    if (!this._backend) throw new Error('no LLM backend configured');
    const { cheapModel } = getConfig().llm;
    return this._backend.assessBatch(candidates, this._lessonBlock(), fmtUsd, { model: cheapModel || null });
  }

  async recordTradeLesson(trade) {
    if (!this._backend) return null;
    try {
      const lesson = await this._backend.recordLesson(trade);
      if (lesson) {
        this._lessons.push({
          text: String(lesson).slice(0, 300),
          outcome: trade.finalPnlPct >= 0 ? 'WIN' : 'LOSS',
          symbol: trade.symbol,
          chain: trade.chain,
          pnl: trade.finalPnlPct,
          lang: 'en',
          at: Date.now(),
        });
        if (this._lessons.length > 200) this._lessons = this._lessons.slice(-200);
        this._persistLessons();
        log.info(`new lesson: ${lesson}`);
        return lesson;
      }
    } catch (e) {
      log.warn('recordTradeLesson failed:', e.message);
    }
    return null;
  }

  async deriveResetLessons(trades, existingLessons) {
    if (!trades || trades.length === 0) return [];
    if (!this.available()) return [];
    try {
      const newLessonsData = await this._backend.deriveLessons(trades, existingLessons || []);
      const saved = [];
      for (const l of newLessonsData) {
        this._lessons.push({
          text: String(l.text).slice(0, 300),
          outcome: l.outcome === 'LOSS' ? 'LOSS' : l.outcome === 'PATTERN' ? 'PATTERN' : 'WIN',
          symbol: '*',
          chain: 'paper',
          pnl: 0,
          lang: 'en',
          at: Date.now(),
        });
        saved.push(l.text);
      }
      if (this._lessons.length > 200) this._lessons = this._lessons.slice(-200);
      this._persistLessons();
      log.info(`deriveResetLessons: ${saved.length} strategic lessons saved`);
      return saved;
    } catch (e) {
      log.warn('deriveResetLessons failed:', e.message);
      return [];
    }
  }

  async chat(userText, context, tools = null) {
    if (!this._backend) return 'LLM backend not available';
    const canTool = Boolean(tools?.defs?.length);
    const system = {
      role: 'system',
      content:
        `You are "snipra", an aggressive Solana memecoin sniper bot. ` +
        `Your goal: maximize user profit. ` +
        `Respond in Indonesian (casual, sharp, concise). ` +
        `Use ONLY data from context/tool results — never fabricate.\n` +
        (canTool
          ? `You HAVE tools: screen_now, buy_token, sell_token, close_all_positions, get_positions. ` +
            `When user wants action (e.g. "buy <address>", "sell X", "close all"), CALL the tool — ` +
            `don't tell the user to type commands. For buy/sell, chain is always solana. ` +
            `Report results concisely after tool execution.\n`
          : `You have no execution access; if user asks for action, direct them to /buy /sell /closeall.\n`) +
        `\nREALTIME CONTEXT:\n${context}`,
    };
    const messages = [system, ...this._history, { role: 'user', content: userText }];

    let finalText = '';
    for (let hop = 0; hop < 4; hop++) {
      const msg = await this._backend.chat(messages, { tools: canTool ? tools.defs : null });
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
        continue;
      }
      finalText = msg.content || '';
      break;
    }
    // Save full turn including all intermediate tool messages to history
    // so follow-up messages retain context of what tools did.
    for (const m of messages) {
      if (m.role !== 'system') this._history.push(m);
    }
    if (this._history.length > 24) this._history = this._history.slice(-24);
    return finalText || '(tidak ada jawaban)';
  }

  async suggestGenes({ geneSpace, currentFilters, genomes, trades, lessonsText }) {
    if (!this._backend) return null;
    return this._backend.suggestGenes({ geneSpace, currentFilters, genomes, trades, lessonsText });
  }

  /**
   * Evaluasi posisi terbuka: bandingkan entryMetrics vs currentMetrics, minta
   * LLM putuskan hold/close per posisi. Caller yg enforce verdict (force-close).
   *
   * Input: positions[] dengan field {entryMetrics, currentMetrics, symbol, chain,
   *   entryPrice, currentPrice, peakPrice, openedAt, tpHit, trailingActive,
   *   remainingPct, cfgTpLadderLen}.
   * Output: [{action: 'hold'|'close', confidence: 0-1, reason: string}]
   *
   * Return null kalau backend tidak available atau positions kosong.
   * Caller catch & log — bukan throw (manage cycle harus lanjut jalan).
   */
  async evaluatePositions(positions) {
    if (!this._backend) return null;
    if (!positions || positions.length === 0) return [];
    try {
      return await this._backend.evaluatePositions(positions, fmtUsd);
    } catch (e) {
      log.warn('evaluatePositions failed:', e.message);
      return null;
    }
  }
}
