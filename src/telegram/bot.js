import { AsyncLocalStorage } from 'node:async_hooks';
import TelegramBot from 'node-telegram-bot-api';
import { getConfig, getActiveMode } from '../config.js';
import { tokenPairs, bestPair, normalizePair, search } from '../screener/dexscreener.js';
import { tokenSecurity } from '../screener/goplus.js';
import { fmtUsd, tokenLink } from '../utils.js';
import { nativePriceUsd } from '../prices.js';
import { marketLine, communityLine, gmgnLine } from './fmt.js';
import { createLogger } from '../logger.js';
import { buildRegistry } from './commands/index.js';
import { handleMenuCallback } from './commands/config.js';

const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const log = createLogger('telegram');

// Scopes runCommand()'s send() capture to that specific call's async chain —
// a background notify() (status loop, position-close alert) firing on the
// same Telegram instance while a handler is mid-await runs in a DIFFERENT
// async context and correctly sees no store, so it can't leak into an
// unrelated runCommand()'s captured text.
const captureContext = new AsyncLocalStorage();

// Registered to Telegram automatically on start (setMyCommands) —
// no manual BotFather setup needed.
const COMMANDS = [
  { command: 'status', description: 'Bot status, mode, positions & balance' },
  { command: 'stats', description: 'Win rate, avg PnL, last trades' },
  { command: 'screen', description: 'Screen now + immediately buy candidates that pass' },
  { command: 'buy', description: 'Buy manual: /buy <address> [amount]' },
  { command: 'sell', description: 'Sell a position: /sell <address> [pct]' },
  { command: 'closeall', description: 'Close ALL open positions now' },
  { command: 'menu', description: 'Quick settings button panel' },
  { command: 'papertrades', description: 'Papertest history from the database' },
  { command: 'paperreset', description: 'Reset virtual paper balance' },
  { command: 'pause', description: 'Pause auto-buy (monitoring keeps running)' },
  { command: 'resume', description: 'Resume auto-buy' },
  { command: 'mode', description: 'Switch mode: /mode paper|live' },
  { command: 'config', description: 'Show the full configuration' },
  { command: 'get', description: 'View a single config value: /get <path>' },
  { command: 'set', description: 'Change config: /set <path> <value>' },
  { command: 'darwin', description: 'Screening genome evolution status' },
  { command: 'evolve', description: 'Darwin + LLM analysis → proposed filters (not auto-applied)' },
  { command: 'lessons', description: 'Lessons from LLM analysis' },
  { command: 'logs', description: 'Recent bot logs' },
  { command: 'briefings', description: 'Manual daily briefing (positions, PnL, lessons)' },
  { command: 'help', description: 'Full command list' },
  { command: 'stop', description: 'Shut down the bot' },
];

// Commands reachable via Telegram#runCommand() (skill-mode command queue).
// Deliberately NOT everything buildRegistry() wires — menu/start/help are
// Telegram-UI-only, buy/sell/closeall/screen are already covered by
// LLM_TOOL_DEFS in src/llm/tools.js. Keep in sync with skills/snipra/SKILL.md.
const SKILL_MODE_COMMANDS = new Set([
  'pause', 'resume', 'mode',
  'darwin', 'evolve', 'lessons',
  'config', 'get', 'set',
  'status', 'stats', 'papertrades', 'paperreset', 'briefings', 'logs',
  'stop',
]);

export class Telegram {
  /**
   * deps diisi dari index.js: { executor, screenOnce, buyToken, sellToken,
   *   darwin, llm, setPaused, isPaused, shutdown }
   */
  constructor(deps, { interactive = true } = {}) {
    this.deps = deps;
    this.interactive = interactive;
    this.chatId = process.env.TELEGRAM_CHAT_ID || null;
    this.bot = null;
    this._buyLocks = new Set(); // in-progress buy addresses — cegah double-tap/duplicate webhook
    // Registry is built unconditionally — `interactive` only controls whether
    // Telegram polls for incoming messages/callbacks (see start()). In skill
    // mode (interactive:false) the registry is still reachable via
    // runCommand(), called from the file-based command queue instead of from
    // typed Telegram messages.
    this._commands = buildRegistry({
      ...deps,
      send: (...a) => this._send(...a),
      chainSlug: (k) => this._chainSlug(k),
    });
  }

  start() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      log.warn('TELEGRAM_BOT_TOKEN empty — telegram disabled');
      return;
    }
    this.bot = new TelegramBot(token, { polling: true });
    this.bot.on('polling_error', (e) => log.warn('polling_error:', e.message));
    if (this.interactive) {
      this.bot.on('message', (msg) => this._onMessage(msg).catch((e) => {
        log.error('handler error:', e.message);
        this._send(`⚠️ Error: ${e.message}`);
      }));
      this.bot.on('callback_query', (q) => this._onCallback(q).catch((e) => {
        log.error('callback error:', e.message);
        this._send(`⚠️ Error: ${e.message}`);
      }));
      this.bot
        .setMyCommands(COMMANDS)
        .then(() => log.info(`${COMMANDS.length} commands registered to telegram menu`))
        .catch((e) => log.warn('setMyCommands failed:', e.message));
    } else {
      // Skill mode: no command processing, just polling for delivery
      this.bot.on('message', () => {}); // acknowledge messages silently
    }
    log.info(`telegram bot polling started (interactive=${this.interactive})`);
    const cfg = getConfig();
    const chains = Object.entries(cfg.chains).filter(([, c]) => c.enabled).map(([k]) => k).join(', ');
    this.notify(`snipra online\n\nChain: ${chains}\n${this.interactive ? 'Type /help for the command list.' : 'Skill mode — chat with me through your platform agent.'}`);
  }

  async stopPolling() {
    if (this.bot) await this.bot.stopPolling().catch(() => {});
  }

  _authorized(msg) {
    // Require TELEGRAM_CHAT_ID to be explicitly set in .env.
    // Auto-pairing with the first sender is a security risk: an attacker
    // who messages before the owner claims the bot permanently.
    if (!this.chatId) return false;
    return String(msg.chat.id) === String(this.chatId);
  }

  async _send(text, extra = {}) {
    const sink = captureContext.getStore();
    if (sink) sink.push(text);
    if (!this.bot || !this.chatId) return;
    // link gmgn tanpa preview + Telegram limit 4096 char — pecah per chunk
    const opts = { parse_mode: 'Markdown', disable_web_page_preview: true, ...extra };
    let markdownFailed = false;
    for (let i = 0; i < text.length; i += 3800) {
      const chunk = text.slice(i, i + 3800);
      if (markdownFailed) {
        // First chunk parse failure — all remaining chunks go as plain text
        try {
          await this.bot.sendMessage(this.chatId, chunk, { disable_web_page_preview: true });
        } catch {
          log.warn(`telegram send failed (plain-text fallback also failed)`);
        }
        continue;
      }
      try {
        await this.bot.sendMessage(this.chatId, chunk, opts);
      } catch (e) {
        if (/parse/i.test(e.message)) {
          // Markdown parse failed — set flag, send this chunk + all remaining as plain text
          markdownFailed = true;
          try {
            await this.bot.sendMessage(this.chatId, chunk, { disable_web_page_preview: true });
          } catch (e2) {
            log.warn(`telegram send failed (plain-text fallback also failed): ${e2.message}`);
          }
          continue;
        }
        // error jaringan/transient (ETIMEDOUT, EAI_AGAIN, dll) — 1x retry setelah jeda singkat
        // sebelum menyerah, supaya notif penting (mis. CLOSE posisi) tidak hilang diam-diam.
        await new Promise((r) => setTimeout(r, 1500));
        try {
          await this.bot.sendMessage(this.chatId, chunk, opts);
        } catch (e2) {
          log.warn(`telegram send failed (after retry): ${e2.message}`);
        }
      }
    }
  }

  /**
   * Run a registered Telegram command handler outside of Telegram itself —
   * used by the skill-mode command queue (src/skills/command-queue.js) so an
   * agent gets the exact same command behavior a Telegram user would, without
   * Telegram ever needing to receive typed commands (interactive:false).
   * Gated by SKILL_MODE_COMMANDS — commands wired in the registry but not in
   * that allowlist behave identically to a truly-unknown name.
   * Mirrors the return convention of createToolRunner() in llm/tools.js:
   * plain result object, `{error}` for "ran but rejected" (never throws for
   * a bad/disallowed command name — only lets real handler exceptions propagate).
   */
  async runCommand(name, args) {
    if (!SKILL_MODE_COMMANDS.has(name)) return { error: `unknown command: ${name}` };
    const fn = this._commands.get('/' + name);
    if (!fn) return { error: `unknown command: ${name}` };
    const captured = [];
    await captureContext.run(captured, () => fn(args, null));
    return { text: captured.join('\n\n') };
  }

  _chainSlug(chainKey) {
    return getConfig().chains[chainKey]?.gmgnSlug;
  }

  /** kartu info token utk lookup CA / hasil pencarian nama */
  _tokenCard(c) {
    const gmgn = gmgnLine(c);
    return (
      `${tokenLink(c.symbol, this._chainSlug(c.chain), c.address)} — ${c.name || ''}\n\n` +
      `💵 ${fmtUsd(c.priceUsd)} · ${marketLine(c)}\n` +
      `${communityLine(c, { withDelta: true })}\n` +
      `🔁 tx24 ${c.traders24h} · b/s ${c.buySellRatio?.toFixed(2)}` +
      (c.security?.top10Pct != null ? ` · top10 ${c.security.top10Pct.toFixed(0)}%` : '') + `\n` +
      (gmgn ? `${gmgn}\n` : '') +
      (c.launchpad ? `🚀 ${c.launchpad}\n` : '') +
      (c.security
        ? `🛡 ${c.security.honeypot ? '🚨 honeypot' : ''}${c.security.freezable ? ' ⚠️ freezable' : ''}${!c.security.honeypot && !c.security.freezable ? '✅ safe' : ''}${c.security.washTrading ? ' · 🚨 wash trading' : ''}\n`
        : '') +
      `\`${c.address}\``
    );
  }

  _buyKeyboard(chain, address) {
    return {
      reply_markup: {
        inline_keyboard: [[
          { text: `✅ Buy (${chain})`, callback_data: `buy:${chain}:${address}` },
          { text: '❌ Skip', callback_data: 'skip' },
        ]],
      },
    };
  }

  /** lookup contract address di semua chain aktif → kartu + tombol buy */
  async _lookupAddress(address) {
    const cfg = getConfig();
    const found = [];
    for (const [key, chainCfg] of Object.entries(cfg.chains)) {
      if (!chainCfg.enabled) continue;
      try {
        const pairs = await tokenPairs(chainCfg.dexscreenerId, address);
        const best = bestPair(pairs);
        if (best) {
          const c = normalizePair(best, key);
          const sec = await tokenSecurity(chainCfg, address).catch(() => null);
          if (sec) { c.security = sec; c.holders = sec.holders; }
          found.push(c);
        }
      } catch { /* chain ini tidak punya token tsb */ }
    }
    if (found.length === 0) return this._send(`Token \`${address}\` not found on any active chain.`);
    for (const c of found) {
      await this._send(this._tokenCard(c), this._buyKeyboard(c.chain, c.address));
    }
  }

  /** cari token by nama → 3 hasil terbaik dgn data + tombol buy */
  async _searchByName(query) {
    const cfg = getConfig();
    const chainMap = {};
    for (const [key, c] of Object.entries(cfg.chains)) {
      if (c.enabled) chainMap[c.dexscreenerId] = key;
    }
    const pairs = await search(query);
    // dedupe per token, pilih pair terlikuid, hanya chain aktif
    const byToken = new Map();
    for (const p of pairs) {
      const chainKey = chainMap[p.chainId];
      if (!chainKey || !p?.baseToken?.address) continue;
      const k = `${p.chainId}:${p.baseToken.address}`;
      if (!byToken.has(k) || (p.liquidity?.usd || 0) > (byToken.get(k).liquidity?.usd || 0)) {
        byToken.set(k, p);
      }
    }
    const top = [...byToken.values()]
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))
      .slice(0, 3);
    if (top.length === 0) return this._send(`No token "${query}" found on any active chain.`);

    await this._send(`🔎 *Search results for "${query}"* (top ${top.length}):`);
    for (const p of top) {
      const c = normalizePair(p, chainMap[p.chainId]);
      const sec = await tokenSecurity(cfg.chains[c.chain], c.address).catch(() => null);
      if (sec) { c.security = sec; c.holders = sec.holders; }
      await this._send(this._tokenCard(c), this._buyKeyboard(c.chain, c.address));
    }
  }

  async _onCallback(q) {
    if (String(q.message?.chat?.id) !== String(this.chatId)) return;
    const data = q.data || '';
    if (data.startsWith('m:')) return handleMenuCallback(q, data, this.bot, this.deps);
    if (data === 'skip') {
      await this.bot.answerCallbackQuery(q.id, { text: 'Skip' });
      await this.bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
        chat_id: q.message.chat.id, message_id: q.message.message_id,
      }).catch(() => {});
      return;
    }
    if (data.startsWith('buy:')) {
      const [, chain, address] = data.split(':');
      const lockKey = `${chain}:${address}`.toLowerCase();
      if (this._buyLocks.has(lockKey)) {
        await this.bot.answerCallbackQuery(q.id, { text: 'Already buying…' });
        return;
      }
      this._buyLocks.add(lockKey);
      await this.bot.answerCallbackQuery(q.id, { text: 'Buying…' });
      try {
        const pos = await this.deps.buyToken(chain, address, undefined, 'telegram-button');
        await this.bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
          chat_id: q.message.chat.id, message_id: q.message.message_id,
        }).catch(() => {});
        const solUsd = await nativePriceUsd(chain);
        await this._send(
          `✅ BUY ${tokenLink(pos.symbol, this._chainSlug(chain), address)} @ ${fmtUsd((pos.entryPrice || 0) * solUsd)}\ntx: \`${pos.txid}\``
        );
      } catch (e) {
        await this._send(`⚠️ Buy failed: ${e.message}`);
      } finally {
        this._buyLocks.delete(lockKey);
      }
    }
  }

  /**
   * dipakai modul lain untuk push notifikasi (screening, buy, close, SL, status).
   * Badge mode digabung ke baris pertama (bukan baris terpisah) agar notif paper &
   * live tidak pernah tertukar, tanpa menambah baris ekstra yang mepet.
   */
  notify(text) {
    const badge = getActiveMode() === 'live' ? '🟢 LIVE' : '📝 PAPER';
    const nl = text.indexOf('\n');
    const merged = nl === -1 ? `${badge} · ${text}` : `${badge} · ${text.slice(0, nl)}${text.slice(nl)}`;
    this._send(merged).catch((e) => log.warn(`notify failed: ${e.message}`));
  }

  async _onMessage(msg) {
    if (!msg.text || !this._authorized(msg)) return;
    const [cmd, ...args] = msg.text.trim().split(/\s+/);
    const name = cmd.split('@')[0];

    // Command registry lookup
    const handler = this._commands.get(name);
    if (handler) {
      return handler(args, msg).catch((e) => {
        log.error(`command ${name} error:`, e.message);
        this._send(`⚠️ Error: ${e.message}`);
      });
    }

    // Not a registered command — fallthrough to address lookup / name search / LLM chat
    if (cmd.startsWith('/')) return this._send(`Unknown command: ${cmd}\n/help for the list.`);
    const text = msg.text.trim();
    // contract address → fetch data + tombol buy
    if (SOL_ADDR_RE.test(text)) {
      await this._send('🔍 Mencari data token…');
      return this._lookupAddress(text);
    }
    // 1-2 kata pendek tanpa tanda tanya → cari token by nama
    const words = text.split(/\s+/);
    if (words.length <= 2 && text.length <= 40 && !text.includes('?')) {
      return this._searchByName(text);
    }
    // kalimat/pertanyaan → chatbot LLM dengan konteks realtime bot
    const cfg = getConfig();
    if (cfg.llm.enabled && this.deps.llmChat) {
      await this.bot.sendChatAction(this.chatId, 'typing').catch(() => {});
      const reply = await this.deps.llmChat(text);
      return this._send(reply);
    }
    return this._send(
      'LLM chat is disabled. Enable it with `/set llm.enabled true` (requires OPENROUTER_API_KEY / DEEPSEEK_API_KEY).\n' +
      'Or send 1-2 words to search for a token, /help for commands.'
    );
  }
}
