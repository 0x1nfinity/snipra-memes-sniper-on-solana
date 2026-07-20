import TelegramBot from 'node-telegram-bot-api';
import { getConfig, getPath, setPath } from '../config.js';
import { openPositions, statsSummary, currentPnlPct, getState, moonbags } from '../positions/state.js';
import { recentTrades, tradeStats } from '../db.js';
import { tokenPairs, bestPair, normalizePair, search } from '../screener/dexscreener.js';
import { tokenSecurity } from '../screener/goplus.js';
import { fmtUsd, fmtPct, shortAddr, tokenLink } from '../utils.js';
import {
  chainHeader, chainBlocks, marketLine, communityLine, llmLine, fmtHold, nativeSym, chainEmoji,
} from './fmt.js';

const EVM_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// format ringkas angka USD utk label tombol: 30000 → 30K, 2000000 → 2M
const fmtK = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(v % 1e6 ? 1 : 0)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}K` : `${v}`);

// Field numerik yang bisa diatur lewat tombol /menu (id pendek → path config + step + batas).
// Hanya setting operasional yang aman; LLM/Darwin/teknis TIDAK diekspos.
// group: 'main' (trading/eksekusi) atau 'filter' (hard filter screening).
const MENU_NUM = {
  // ── main / trading ──
  si: { group: 'main', path: 'screener.intervalSec', step: 300, min: 300, max: 21600, label: '🔍 Scan', fmt: (v) => `${Math.round(v / 60)}m` },
  bs: { group: 'main', path: 'chains.solana.buyAmount', step: 0.05, min: 0.05, max: 50, label: '💰 Buy SOL', fmt: (v) => `${+v.toFixed(3)}` },
  be: { group: 'main', path: 'chains.robinhood.buyAmount', step: 0.005, min: 0.005, max: 5, label: '💰 Buy ETH', fmt: (v) => `${+v.toFixed(4)}` },
  sl: { group: 'main', path: 'trading.stopLossPct', step: 5, min: -90, max: -5, label: '🛑 SL', fmt: (v) => `${v}%` },
  ta: { group: 'main', path: 'trailing.activateGainPct', step: 5, min: 5, max: 500, label: '📈 Trail↑', fmt: (v) => `${v}%` },
  tp: { group: 'main', path: 'trailing.trailPct', step: 1, min: 1, max: 50, label: '📉 Trail↓', fmt: (v) => `${v}%` },
  // ── filter / hard filter screening ──
  fvol: { group: 'filter', path: 'screener.filters.minVolume24hUsd', step: 10000, min: 0, max: 5e6, label: '📊 Vol', fmt: (v) => `$${fmtK(v)}` },
  fliq: { group: 'filter', path: 'screener.filters.minLiquidityUsd', step: 5000, min: 0, max: 2e6, label: '💧 Liq', fmt: (v) => `$${fmtK(v)}` },
  fmcn: { group: 'filter', path: 'screener.filters.minMarketCapUsd', step: 10000, min: 0, max: 5e6, label: '💰 MC↓', fmt: (v) => `$${fmtK(v)}` },
  fmcx: { group: 'filter', path: 'screener.filters.maxMarketCapUsd', step: 1e6, min: 1e6, max: 1e8, label: '💰 MC↑', fmt: (v) => `$${fmtK(v)}` },
  fagn: { group: 'filter', path: 'screener.filters.minAgeMinutes', step: 15, min: 0, max: 1440, label: '⏱ Age↓', fmt: (v) => `${v}m` },
  fagx: { group: 'filter', path: 'screener.filters.maxAgeHours', step: 12, min: 12, max: 720, label: '⏱ Age↑', fmt: (v) => `${v}h` },
  fhld: { group: 'filter', path: 'screener.filters.minHolders', step: 50, min: 0, max: 10000, label: '👥 Hold', fmt: (v) => `${v}` },
  ftx: { group: 'filter', path: 'screener.filters.minTraders24h', step: 50, min: 0, max: 10000, label: '🔁 Tx', fmt: (v) => `${v}` },
  ft10: { group: 'filter', path: 'screener.filters.maxTop10Pct', step: 5, min: 0, max: 100, label: '🔝 Top10', fmt: (v) => `${v}%` },
};
import { recentLogs } from '../logger.js';
import { createLogger } from '../logger.js';

const log = createLogger('telegram');

// Didaftarkan otomatis ke Telegram saat start (setMyCommands) —
// tidak perlu setting manual lewat BotFather.
const COMMANDS = [
  { command: 'status', description: 'Kondisi bot, mode, posisi & saldo' },
  { command: 'positions', description: 'Posisi terbuka + PnL real-time' },
  { command: 'stats', description: 'Win rate, avg PnL, trade terakhir' },
  { command: 'screen', description: 'Screening sekarang + langsung buy yang lolos' },
  { command: 'buy', description: 'Buy manual: /buy <chain> <address> [amount]' },
  { command: 'sell', description: 'Sell posisi: /sell <address> [pct]' },
  { command: 'closeall', description: 'Tutup SEMUA posisi terbuka sekarang' },
  { command: 'menu', description: 'Panel tombol pengaturan cepat' },
  { command: 'papertrades', description: 'Riwayat papertest dari database' },
  { command: 'paperreset', description: 'Reset saldo virtual paper' },
  { command: 'pause', description: 'Jeda auto-buy (monitor tetap jalan)' },
  { command: 'resume', description: 'Lanjutkan auto-buy' },
  { command: 'mode', description: 'Ganti mode: /mode paper|live' },
  { command: 'config', description: 'Tampilkan seluruh konfigurasi' },
  { command: 'get', description: 'Lihat satu nilai config: /get <path>' },
  { command: 'set', description: 'Ubah config: /set <path> <value>' },
  { command: 'darwin', description: 'Status evolusi genome screening' },
  { command: 'evolve', description: 'Analisa Darwin + LLM → usulan filter (tidak auto-apply)' },
  { command: 'lessons', description: 'Lessons hasil analisis LLM' },
  { command: 'logs', description: 'Log terakhir bot' },
  { command: 'help', description: 'Daftar perintah lengkap' },
  { command: 'stop', description: 'Matikan bot' },
];

const HELP = `*snipra v2 — multi-chain meme sniper*

*Kontrol*
/menu — panel tombol pengaturan cepat
/status — kondisi bot & saldo
/pause — stop auto-buy (monitor tetap jalan)
/resume — lanjut auto-buy
/mode paper|live — papertest vs on-chain sungguhan
/stop — matikan bot

*Konfigurasi*
/config — lihat semua config
/get <path> — lihat satu nilai
/set <path> <value> — ubah config
  contoh: \`/set screener.filters.minLiquidityUsd 30000\`
  contoh: \`/set tpLadder [{"gainPct":50,"sellPct":30}]\`

*Trading*
/screen — screening sekarang + langsung buy yang lolos
/buy <chain> <address> [amount] — buy manual
/sell <address> [pct] — sell posisi (default 100%)
/closeall — tutup semua posisi terbuka
/positions — posisi terbuka + PnL
/stats — statistik trading
/papertrades — riwayat paper trade dari database
/paperreset — reset saldo virtual ke awal

*Darwin & LLM*
/darwin — status evolusi genome
/evolve — paksa evolusi sekarang
/lessons — lessons dari LLM
/logs — log terakhir

*Tanpa command:*
• kirim *contract address* → data token + tombol Buy
• kirim *nama token* (1-2 kata) → 3 hasil terbaik + tombol Buy
• kirim *kalimat/pertanyaan* → dijawab LLM dengan data realtime bot`;

export class Telegram {
  /**
   * deps diisi dari index.js: { executor, screenOnce, buyToken, sellToken,
   *   darwin, llm, setPaused, isPaused, shutdown }
   */
  constructor(deps) {
    this.deps = deps;
    this.chatId = process.env.TELEGRAM_CHAT_ID || null;
    this.bot = null;
  }

  start() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      log.warn('TELEGRAM_BOT_TOKEN kosong — telegram nonaktif');
      return;
    }
    this.bot = new TelegramBot(token, { polling: true });
    this.bot.on('polling_error', (e) => log.warn('polling_error:', e.message));
    this.bot.on('message', (msg) => this._onMessage(msg).catch((e) => {
      log.error('handler error:', e.message);
      this._send(`⚠️ Error: ${e.message}`);
    }));
    this.bot.on('callback_query', (q) => this._onCallback(q).catch((e) => {
      log.error('callback error:', e.message);
      this._send(`⚠️ Error: ${e.message}`);
    }));
    // inject daftar command ke menu Telegram — tanpa BotFather
    this.bot
      .setMyCommands(COMMANDS)
      .then(() => log.info(`${COMMANDS.length} command terdaftar ke menu telegram`))
      .catch((e) => log.warn('setMyCommands gagal:', e.message));
    log.info('telegram bot polling dimulai');
    const cfg = getConfig();
    this.notify(
      `🤖 *snipra v2 online* · ${cfg.mode === 'paper' ? '📝 paper' : '🔴 LIVE'}\n` +
      `Chain: ${Object.entries(cfg.chains).filter(([, c]) => c.enabled).map(([k]) => `${chainEmoji(k)} ${k}`).join(' · ')}\n` +
      `Ketik /help untuk daftar perintah.`
    );
  }

  async stopPolling() {
    if (this.bot) await this.bot.stopPolling().catch(() => {});
  }

  _authorized(msg) {
    if (!this.chatId) {
      // Belum diset: terima chat pertama sebagai owner, kasih tahu ID-nya
      this.chatId = String(msg.chat.id);
      this._send(`Chat ID kamu: \`${msg.chat.id}\`\nSet TELEGRAM_CHAT_ID di .env agar permanen.`);
      return true;
    }
    return String(msg.chat.id) === String(this.chatId);
  }

  async _send(text, extra = {}) {
    if (!this.bot || !this.chatId) return;
    // link gmgn tanpa preview + Telegram limit 4096 char — pecah per chunk
    const opts = { parse_mode: 'Markdown', disable_web_page_preview: true, ...extra };
    for (let i = 0; i < text.length; i += 3800) {
      const chunk = text.slice(i, i + 3800);
      try {
        await this.bot.sendMessage(this.chatId, chunk, opts);
      } catch (e) {
        if (/parse/i.test(e.message)) {
          // fallback tanpa markdown kalau parsing gagal
          try {
            await this.bot.sendMessage(this.chatId, chunk, { disable_web_page_preview: true });
          } catch (e2) {
            log.warn(`kirim telegram gagal (fallback plain-text juga gagal): ${e2.message}`);
          }
          continue;
        }
        // error jaringan/transient (ETIMEDOUT, EAI_AGAIN, dll) — 1x retry setelah jeda singkat
        // sebelum menyerah, supaya notif penting (mis. CLOSE posisi) tidak hilang diam-diam.
        await new Promise((r) => setTimeout(r, 1500));
        try {
          await this.bot.sendMessage(this.chatId, chunk, opts);
        } catch (e2) {
          log.warn(`kirim telegram gagal (setelah retry): ${e2.message}`);
        }
      }
    }
  }

  _chainSlug(chainKey) {
    return getConfig().chains[chainKey]?.gmgnSlug;
  }

  /** kartu info token utk lookup CA / hasil pencarian nama */
  _tokenCard(c) {
    const guardTag = (c.priceChange?.h1 ?? 0) > 150 || (c.priceChange?.h24 ?? 0) > 400 ? '\n⚠️ *sedang pump — entry guard aktif*' : '';
    return (
      `${chainEmoji(c.chain)} ${tokenLink(c.symbol, this._chainSlug(c.chain), c.address)} — ${c.name || ''} (${c.chain})${guardTag}\n\n` +
      `💵 ${fmtUsd(c.priceUsd)} · ${marketLine(c)}\n` +
      `${communityLine(c, { withDelta: true })}\n` +
      `🔁 tx24 ${c.traders24h} · b/s ${c.buySellRatio?.toFixed(2)}` +
      (c.security?.top10Pct != null ? ` · top10 ${c.security.top10Pct.toFixed(0)}%` : '') + `\n` +
      (c.security
        ? `🛡 ${c.security.honeypot ? '🚨 honeypot/freezable' : '✅ aman'}${c.security.mintable ? ' · ⚠️ mintable' : ''}\n`
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
    const isEvm = EVM_ADDR_RE.test(address);
    const found = [];
    for (const [key, chainCfg] of Object.entries(cfg.chains)) {
      if (!chainCfg.enabled) continue;
      if (isEvm !== (chainCfg.type === 'evm')) continue;
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
    if (found.length === 0) return this._send(`Token \`${address}\` tidak ditemukan di chain aktif.`);
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
    if (top.length === 0) return this._send(`Tidak ada token "${query}" di chain aktif.`);

    await this._send(`🔎 *Hasil pencarian "${query}"* (${top.length} terbaik):`);
    for (const p of top) {
      const c = normalizePair(p, chainMap[p.chainId]);
      const sec = await tokenSecurity(cfg.chains[c.chain], c.address).catch(() => null);
      if (sec) { c.security = sec; c.holders = sec.holders; }
      await this._send(this._tokenCard(c), this._buyKeyboard(c.chain, c.address));
    }
  }

  // ===== /menu: panel tombol pengaturan aman (dari config.json) =====

  _menuText(view) {
    const cfg = getConfig();
    const head = view === 'filter' ? '🎛 *Menu · Filter Screening*' : '🎛 *Menu Pengaturan*';
    return (
      `${head}\n` +
      `Mode: ${cfg.mode === 'paper' ? '📝 paper' : '🔴 LIVE'} · Chain: ${cfg.activeChain} · Auto-buy: ${this.deps.isPaused() ? '⏸ off' : '▶️ on'}\n` +
      (view === 'filter'
        ? `Atur hard filter. LLM/Darwin via /set.`
        : `Tombol di bawah. Filter screening → 🔧, teknis via /set.`)
    );
  }

  _menuKeyboard(view = 'main') {
    const cfg = getConfig();
    const mark = (on) => (on ? '🟢 ' : '');
    const rows = [];

    if (view === 'main') {
      rows.push([
        { text: `${mark(cfg.mode === 'paper')}📝 paper`, callback_data: 'm:mode:paper' },
        { text: `${mark(cfg.mode === 'live')}🔴 live`, callback_data: 'm:mode:live' },
      ]);
      rows.push([
        { text: `${mark(cfg.activeChain === 'solana')}🟪 solana`, callback_data: 'm:chain:solana' },
        { text: `${mark(cfg.activeChain === 'robinhood')}🟩 robinhood`, callback_data: 'm:chain:robinhood' },
        { text: `${mark(cfg.activeChain === 'both')}both`, callback_data: 'm:chain:both' },
      ]);
      rows.push([
        { text: `${mark(!this.deps.isPaused())}▶️ auto-buy on`, callback_data: 'm:auto:on' },
        { text: `${mark(this.deps.isPaused())}⏸ off`, callback_data: 'm:auto:off' },
      ]);
    }

    for (const [id, m] of Object.entries(MENU_NUM)) {
      if (m.group !== view) continue;
      rows.push([
        { text: '➖', callback_data: `m:dec:${id}` },
        { text: `${m.label}: ${m.fmt(Number(getPath(m.path)))}`, callback_data: 'm:noop' },
        { text: '➕', callback_data: `m:inc:${id}` },
      ]);
    }

    rows.push(
      view === 'filter'
        ? [{ text: '⬅ Kembali', callback_data: 'm:view:main' }, { text: '✖ Tutup', callback_data: 'm:close' }]
        : [{ text: '🔧 Filter screening', callback_data: 'm:view:filter' }]
    );
    if (view === 'main') {
      rows.push([{ text: '🔄 Refresh', callback_data: 'm:refresh' }, { text: '✖ Tutup', callback_data: 'm:close' }]);
    }
    return { reply_markup: { inline_keyboard: rows } };
  }

  async _sendMenu() {
    return this._send(this._menuText('main'), this._menuKeyboard('main'));
  }

  async _handleMenuCallback(q, data) {
    const [, action, arg] = data.split(':');
    const editMenu = async (view, toast) => {
      await this.bot.answerCallbackQuery(q.id, toast ? { text: toast } : {}).catch(() => {});
      await this.bot.editMessageText(this._menuText(view), {
        chat_id: q.message.chat.id, message_id: q.message.message_id,
        parse_mode: 'Markdown', disable_web_page_preview: true,
        ...this._menuKeyboard(view),
      }).catch(() => {});
    };
    switch (action) {
      case 'noop':
        return this.bot.answerCallbackQuery(q.id).catch(() => {});
      case 'view':
        return editMenu(arg);
      case 'refresh':
        return editMenu('main', 'Diperbarui');
      case 'close':
        await this.bot.answerCallbackQuery(q.id, { text: 'Ditutup' }).catch(() => {});
        return this.bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
          chat_id: q.message.chat.id, message_id: q.message.message_id,
        }).catch(() => {});
      case 'mode':
        setPath('mode', arg);
        this.deps.applyMode();
        return editMenu('main', `Mode → ${arg}`);
      case 'chain':
        setPath('activeChain', arg);
        return editMenu('main', `Chain → ${arg}`);
      case 'auto':
        this.deps.setPaused(arg === 'off');
        return editMenu('main', arg === 'off' ? 'Auto-buy dijeda' : 'Auto-buy aktif');
      case 'inc':
      case 'dec': {
        const m = MENU_NUM[arg];
        if (!m) return this.bot.answerCallbackQuery(q.id).catch(() => {});
        const cur = Number(getPath(m.path));
        let next = cur + (action === 'inc' ? m.step : -m.step);
        next = Math.max(m.min, Math.min(m.max, Number(next.toFixed(6))));
        setPath(m.path, next);
        if (m.path === 'screener.intervalSec') this.deps.restartLoops();
        return editMenu(m.group, `${m.label} → ${m.fmt(next)}`);
      }
      default:
        return this.bot.answerCallbackQuery(q.id).catch(() => {});
    }
  }

  async _onCallback(q) {
    if (String(q.message?.chat?.id) !== String(this.chatId)) return;
    const data = q.data || '';
    if (data.startsWith('m:')) return this._handleMenuCallback(q, data);
    if (data === 'skip') {
      await this.bot.answerCallbackQuery(q.id, { text: 'Skip' });
      await this.bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
        chat_id: q.message.chat.id, message_id: q.message.message_id,
      }).catch(() => {});
      return;
    }
    if (data.startsWith('buy:')) {
      const [, chain, address] = data.split(':');
      await this.bot.answerCallbackQuery(q.id, { text: 'Membeli…' });
      try {
        const pos = await this.deps.buyToken(chain, address, undefined, 'telegram-button');
        await this.bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
          chat_id: q.message.chat.id, message_id: q.message.message_id,
        }).catch(() => {});
        await this._send(
          `✅ BUY ${tokenLink(pos.symbol, this._chainSlug(chain), address)} @ ${fmtUsd(pos.entryPrice)}\ntx: \`${pos.txid}\``
        );
      } catch (e) {
        await this._send(`⚠️ Buy gagal: ${e.message}`);
      }
    }
  }

  /**
   * dipakai modul lain untuk push notifikasi (screening, buy, close, SL, status).
   * SELALU diberi badge mode di baris pertama agar notif paper & live tidak pernah
   * tertukar — sumber utama kebingungan "mode live tapi datanya paper".
   */
  notify(text) {
    const badge = getConfig().mode === 'live' ? '🔴 LIVE' : '📝 PAPER';
    this._send(`${badge}\n${text}`).catch((e) => log.warn(`notify gagal: ${e.message}`));
  }

  async _onMessage(msg) {
    if (!msg.text || !this._authorized(msg)) return;
    const [cmd, ...args] = msg.text.trim().split(/\s+/);
    const d = this.deps;

    switch (cmd.split('@')[0]) {
      case '/start':
      case '/help':
        return this._send(HELP);

      case '/status': {
        const cfg = getConfig();
        const bal = await d.executor.balances();
        const effectiveMax = cfg.activeChain === 'both' ? cfg.trading.maxPositions : cfg.trading.maxPerChain;
        const lines = Object.entries(bal).map(
          ([k, b]) => `${chainEmoji(k)} ${k}: ${b.error ? `⚠️ ${b.error}` : `*${b.native?.toFixed(4)} ${nativeSym(k)}*`} · ${shortAddr(b.address)}`
        );
        return this._send(
          `⚙️ *Status* · ${cfg.mode === 'paper' ? '📝 paper' : '🔴 LIVE'}\n\n` +
          `Auto-buy ${d.isPaused() ? '⏸ paused' : '▶️ aktif'} · Posisi ${openPositions().length}/${effectiveMax} · Moonbag ${moonbags().length}\n` +
          `🧠 LLM ${cfg.llm.enabled ? cfg.llm.provider : 'off'} · 🧬 Darwin ${cfg.darwin.enabled ? 'on' : 'off'}\n\n` +
          `*Saldo${cfg.mode === 'paper' ? ' (virtual)' : ''}*\n${lines.join('\n')}`
        );
      }

      case '/config':
        return this._send('```json\n' + JSON.stringify(getConfig(), null, 2) + '\n```');

      case '/get': {
        if (!args[0]) return this._send('Usage: /get <path>');
        return this._send(`\`${args[0]}\` = \`${JSON.stringify(getPath(args[0]))}\``);
      }

      case '/set': {
        if (args.length < 2) return this._send('Usage: /set <path> <value>');
        const path = args[0];
        const value = setPath(path, args.slice(1).join(' '));
        if (path === 'mode') d.applyMode();
        // interval screening/monitor/laporan langsung diterapkan tanpa restart bot
        if (['screener.intervalSec', 'monitor.intervalSec', 'telegram.statusIntervalMin'].includes(path)) {
          d.restartLoops();
          return this._send(`✅ \`${path}\` = \`${JSON.stringify(value)}\` — timer di-restart, langsung aktif.`);
        }
        return this._send(`✅ \`${path}\` = \`${JSON.stringify(value)}\``);
      }

      case '/mode': {
        const m = args[0];
        if (m !== 'paper' && m !== 'live') return this._send('Usage: /mode paper|live');
        setPath('mode', m);
        d.applyMode();
        return this._send(
          m === 'paper'
            ? '📝 Mode PAPER — trade simulasi, saldo virtual, PnL tetap dicatat ke database.'
            : '🔴 *MODE LIVE* — transaksi on-chain sungguhan dengan saldo asli!'
        );
      }

      case '/papertrades': {
        const rows = recentTrades('paper', 10);
        const s = tradeStats('paper');
        if (!s || s.total === 0) return this._send('Belum ada paper trade yang close.');
        const byChain = {};
        for (const t of rows) {
          const held = t.hold_minutes >= 60 ? `${(t.hold_minutes / 60).toFixed(1)}h` : `${Math.round(t.hold_minutes)}m`;
          (byChain[t.chain] ??= []).push(
            `${t.pnl_pct >= 0 ? '✅' : '🔻'} ${t.symbol} *${fmtPct(t.pnl_pct)}* · ${t.pnl_native >= 0 ? '+' : ''}${t.pnl_native?.toFixed(4)} ${nativeSym(t.chain)} · ⏱ ${held}\n   📝 ${t.close_reason}`
          );
        }
        return this._send(
          `📒 *Paper trades* · ${s.total} total\n` +
          `Win rate *${((s.wins / s.total) * 100).toFixed(1)}%* · Avg PnL *${fmtPct(s.avg_pnl_pct)}*\n\n` +
          chainBlocks(byChain)
        );
      }

      case '/paperreset': {
        const { balances, tradesDeleted } = await d.executor.paperReset();
        const lines = Object.entries(balances).map(([k, v]) => `${chainEmoji(k)} ${k}: ${v} ${nativeSym(k)}`);
        return this._send(
          `♻️ *Paper direset*\n${lines.join('\n')}\n` +
          `📊 Realized PnL → *0* · ${tradesDeleted} trade paper dihapus dari statistik\n` +
          `_(posisi terbuka tidak ditutup)_`
        );
      }

      case '/menu':
        return this._sendMenu();

      case '/pause':
        d.setPaused(true);
        return this._send('⏸ Auto-buy dijeda. Monitor posisi tetap jalan.');

      case '/resume':
        d.setPaused(false);
        return this._send('▶️ Auto-buy dilanjutkan.');

      case '/screen': {
        // siklus penuh: screening + langsung buy yang lolos (hasil dikirim oleh siklus)
        await this._send('🔍 Screening + auto-buy berjalan…');
        await d.screenNow();
        return;
      }

      case '/buy': {
        if (args.length < 2) return this._send('Usage: /buy <chain> <address> [amount]');
        const [chain, address, amount] = args;
        const pos = await d.buyToken(chain, address, amount ? Number(amount) : undefined, 'manual');
        return this._send(
          `✅ BUY ${tokenLink(pos.symbol, this._chainSlug(chain), pos.address)} @ ${fmtUsd(pos.entryPrice)}\ntx: \`${pos.txid}\``
        );
      }

      case '/sell': {
        if (!args[0]) return this._send('Usage: /sell <address> [pct]');
        const pct = args[1] ? Number(args[1]) : 100;
        const res = await d.sellToken(args[0], pct);
        return this._send(`✅ SELL ${pct}% ${shortAddr(args[0])}\ntx: \`${res.txid}\``);
      }

      case '/closeall': {
        const list = openPositions();
        if (list.length === 0) return this._send('Tidak ada posisi terbuka.');
        await this._send(`⏳ Menutup ${list.length} posisi…`);
        const results = await d.closeAll('manual /closeall');
        const byChain = {};
        for (const r of results) {
          (byChain[r.chain] ??= []).push(
            r.error ? `⚠️ ${r.symbol} — ${r.error}` : `${r.pnl >= 0 ? '✅' : '🔻'} ${r.symbol} ${fmtPct(r.pnl)}`
          );
        }
        const ok = results.filter((r) => !r.error);
        const avg = ok.length ? ok.reduce((s, r) => s + r.pnl, 0) / ok.length : 0;
        return this._send(
          `🏁 *CLOSEALL* · ${ok.length}/${results.length} ditutup · avg ${fmtPct(avg)}\n\n` +
          chainBlocks(byChain, { gapBetweenItems: false })
        );
      }

      case '/positions': {
        // hanya tampilkan chain yang enabled di config (mis. robinhood off → sembunyikan)
        const cfg = getConfig();
        const onEnabled = (x) => cfg.chains[x.chain]?.enabled;
        const list = openPositions().filter(onEnabled);
        const moons = moonbags().filter(onEnabled);
        if (list.length === 0 && moons.length === 0) return this._send('Tidak ada posisi terbuka.');
        // kelompokkan per chain, jangan selang-seling
        const byChain = {};
        for (const p of list) {
          const pnl = currentPnlPct(p);
          const peak = ((p.peakPrice - p.entryPrice) / p.entryPrice) * 100;
          const item =
            `${pnl >= 0 ? '🟢' : '🔴'} ${tokenLink(p.symbol, this._chainSlug(p.chain), p.address)} *${fmtPct(pnl)}* · ⏱ ${fmtHold(p.openedAt)}\n` +
            `   ${fmtUsd(p.entryPrice)} → ${fmtUsd(p.currentPrice)} · peak ${fmtPct(peak)}\n` +
            `   sisa ${p.remainingPct.toFixed(0)}% · TP ${p.tpHit.length} · trailing ${p.trailingActive ? 'on' : 'off'}\n` +
            `   \`${p.address}\``;
          (byChain[p.chain] ??= []).push(item);
        }
        let msg = `📋 *Posisi (${list.length})*\n\n${chainBlocks(byChain)}`;
        // moonbag: hold jangka panjang, di luar slot posisi
        if (moons.length > 0) {
          const moonLines = moons.map((m) => {
            const pnl = m.entryPrice > 0 ? ((m.currentPrice - m.entryPrice) / m.entryPrice) * 100 : 0;
            return (
              `🌙 ${tokenLink(m.symbol, this._chainSlug(m.chain), m.address)} (${m.chain}) *${fmtPct(pnl)}*\n` +
              `   hold ${m.moonPct.toFixed(0)}% posisi awal · ${fmtUsd(m.entryPrice)} → ${fmtUsd(m.currentPrice)}\n` +
              `   \`${m.address}\``
            );
          });
          msg += `\n\n━━ 🌙 *MOONBAG (${moons.length})* ━━\n\n${moonLines.join('\n\n')}`;
        }
        return this._send(msg);
      }

      case '/stats': {
        const s = statsSummary();
        const closed = getState().closed.slice(-5).reverse();
        const recent = closed
          .map((t) =>
            `${t.finalPnlPct >= 0 ? '✅' : '🔻'} ${t.symbol} *${fmtPct(t.finalPnlPct)}* · ${Math.round(t.holdMinutes)}m\n   📝 ${t.closeReason}`
          )
          .join('\n\n');
        return this._send(
          `📊 *Statistik*\n\n` +
          `Total ${s.totalTrades} · ✅ ${s.wins} · 🔻 ${s.losses}\n` +
          `Win rate *${s.winRatePct.toFixed(1)}%* · Avg PnL *${fmtPct(s.avgPnlPct)}*\n\n` +
          `*5 trade terakhir*\n\n${recent || '(belum ada)'}`
        );
      }

      case '/darwin': {
        const st = d.darwin.status();
        const medals = ['🥇', '🥈', '🥉', '4.', '5.'];
        const lines = st.genomes.slice(0, 5).map(
          (g, i) =>
            `${medals[i]} \`${g.id}\` · fit *${g.fitness.toFixed(2)}* · ${g.trades} trades · avg ${fmtPct(g.avgPnl)}`
        );
        return this._send(
          `🧬 *Darwin* · Generasi ${st.generation}\n` +
          `Trades menuju evolve: ${st.tradesSinceEvolve}/${getConfig().darwin.evolveEveryNTrades}\n\n` +
          `*Top genomes*\n${lines.join('\n')}\n\n` +
          `*Gen terbaik:*\n\`\`\`json\n${JSON.stringify(st.genomes[0]?.genes, null, 1)}\n\`\`\``
        );
      }

      case '/evolve': {
        await this._send('🧬 Menganalisa Darwin' + (getConfig().llm.enabled ? ' + LLM' : '') + ' → menyusun usulan filter…');
        await d.runEvolve('manual'); // notifikasi usulan dikirim oleh runEvolve (tidak auto-apply)
        return;
      }

      case '/lessons': {
        const ls = d.llm.getLessons(10);
        if (ls.length === 0) return this._send('Belum ada lesson dari LLM.');
        return this._send(
          '*Lessons terakhir*\n' +
          ls.map((l) => `• [${l.outcome}] ${l.text}`).join('\n')
        );
      }

      case '/logs':
        return this._send('```\n' + recentLogs(20).join('\n').slice(-3700) + '\n```');

      case '/stop':
        await this._send('🛑 Bot dimatikan.');
        return d.shutdown('telegram /stop');

      default: {
        if (cmd.startsWith('/')) return this._send(`Perintah tidak dikenal: ${cmd}\n/help untuk daftar.`);
        const text = msg.text.trim();
        // contract address → fetch data + tombol buy
        if (EVM_ADDR_RE.test(text) || SOL_ADDR_RE.test(text)) {
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
          'LLM chat nonaktif. Aktifkan dengan `/set llm.enabled true` (butuh OPENROUTER_API_KEY / DEEPSEEK_API_KEY).\n' +
          'Atau kirim 1-2 kata untuk mencari token, /help untuk perintah.'
        );
      }
    }
  }
}
