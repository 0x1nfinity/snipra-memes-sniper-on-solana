import { getConfig, getPath, setPath, getActiveMode, switchMode } from '../../config.js';

// format ringkas angka USD utk label tombol: 30000 → 30K, 2000000 → 2M
const fmtK = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(v % 1e6 ? 1 : 0)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}K` : `${v}`);

// Field numerik yang bisa diatur lewat tombol /menu (id pendek → path config + step + batas).
// Hanya setting operasional yang aman; LLM/Darwin/teknis TIDAK diekspos.
// group: 'main' (trading/eksekusi) atau 'filter' (hard filter screening).
const MENU_NUM = {
  // ── main / trading ──
  si: { group: 'main', path: 'screener.intervalSec', step: 300, min: 300, max: 21600, label: '🔍 Scan', fmt: (v) => `${Math.round(v / 60)}m` },
  bs: { group: 'main', path: 'chains.solana.buyAmount', step: 0.05, min: 0.05, max: 50, label: '💰 Buy SOL', fmt: (v) => `${+v.toFixed(3)}` },
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

function menuText(view, deps) {
  const cfg = getConfig();
  const enabledChains = Object.entries(cfg.chains)
    .filter(([, c]) => c.enabled)
    .map(([k]) => k)
    .join(', ');
  const head = view === 'filter' ? '🎛 *Menu · Filter Screening*' : '🎛 *Menu Pengaturan*';
  return (
    `${head}\n` +
    `Mode: ${getActiveMode() === 'paper' ? '📝 paper' : '🔴 LIVE'} · Chain: ${enabledChains || '(none)'} · Auto-buy: ${deps.isPaused() ? '⏸ off' : '▶️ on'}\n` +
    (view === 'filter'
      ? `Atur hard filter. LLM/Darwin via /set.`
      : `Tombol di bawah. Filter screening → 🔧, teknis via /set.`)
  );
}

function menuKeyboard(view = 'main', deps) {
  const mark = (on) => (on ? '🟢 ' : '');
  const rows = [];

  if (view === 'main') {
    rows.push([
      { text: `${mark(getActiveMode() === 'paper')}📝 paper`, callback_data: 'm:mode:paper' },
      { text: `${mark(getActiveMode() === 'live')}🔴 live`, callback_data: 'm:mode:live' },
    ]);
    rows.push([
      { text: `${mark(!deps.isPaused())}▶️ auto-buy on`, callback_data: 'm:auto:on' },
      { text: `${mark(deps.isPaused())}⏸ off`, callback_data: 'm:auto:off' },
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

// ===== Command handlers =====

export async function config(args, msg, deps) {
  return deps.send('```json\n' + JSON.stringify(getConfig(), null, 2) + '\n```');
}

export async function get(args, msg, deps) {
  if (!args[0]) return deps.send('Usage: /get <path>');
  return deps.send(`\`${args[0]}\` = \`${JSON.stringify(getPath(args[0]))}\``);
}

export async function set(args, msg, deps) {
  if (args.length < 2) return deps.send('Usage: /set <path> <value>');
  const path = args[0];
  // Mode switching uses dedicated switchMode() — not setPath
  if (path === 'mode') {
    const m = args.slice(1).join(' ').toLowerCase();
    if (m !== 'paper' && m !== 'live') return deps.send('Mode harus `paper` atau `live`.');
    switchMode(m);
    deps.applyMode();
    return deps.send(`✅ Mode → \`${m}\``);
  }
  const value = setPath(path, args.slice(1).join(' '));
  // interval screening/monitor/laporan langsung diterapkan tanpa restart bot
  if (['screener.intervalSec', 'monitor.intervalSec', 'telegram.statusIntervalMin'].includes(path)) {
    deps.restartLoops();
    return deps.send(`✅ \`${path}\` = \`${JSON.stringify(value)}\` — timer di-restart, langsung aktif.`);
  }
  return deps.send(`✅ \`${path}\` = \`${JSON.stringify(value)}\``);
}

export async function mode(args, msg, deps) {
  const m = args[0];
  if (m !== 'paper' && m !== 'live') return deps.send('Usage: /mode paper|live');
  switchMode(m);
  deps.applyMode();
  return deps.send(
    m === 'paper'
      ? '📝 Mode PAPER — trade simulasi, saldo virtual, PnL tetap dicatat ke database.'
      : '🔴 *MODE LIVE* — transaksi on-chain sungguhan dengan saldo asli!'
  );
}

export async function menu(args, msg, deps) {
  return deps.send(menuText('main', deps), menuKeyboard('main', deps));
}

// ===== Callback handler for menu inline buttons =====

export async function handleMenuCallback(q, data, bot, deps) {
  const [, action, arg] = data.split(':');
  const editMenu = async (view, toast) => {
    await bot.answerCallbackQuery(q.id, toast ? { text: toast } : {}).catch(() => {});
    await bot.editMessageText(menuText(view, deps), {
      chat_id: q.message.chat.id, message_id: q.message.message_id,
      parse_mode: 'Markdown', disable_web_page_preview: true,
      ...menuKeyboard(view, deps),
    }).catch(() => {});
  };
  switch (action) {
    case 'noop':
      return bot.answerCallbackQuery(q.id).catch(() => {});
    case 'view':
      return editMenu(arg);
    case 'refresh':
      return editMenu('main', 'Diperbarui');
    case 'close':
      await bot.answerCallbackQuery(q.id, { text: 'Ditutup' }).catch(() => {});
      return bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
        chat_id: q.message.chat.id, message_id: q.message.message_id,
      }).catch(() => {});
    case 'mode':
      switchMode(arg);
      deps.applyMode();
      return editMenu('main', `Mode → ${arg}`);
    case 'auto':
      deps.setPaused(arg === 'off');
      return editMenu('main', arg === 'off' ? 'Auto-buy dijeda' : 'Auto-buy aktif');
    case 'inc':
    case 'dec': {
      const m = MENU_NUM[arg];
      if (!m) return bot.answerCallbackQuery(q.id).catch(() => {});
      const cur = Number(getPath(m.path));
      let next = cur + (action === 'inc' ? m.step : -m.step);
      next = Math.max(m.min, Math.min(m.max, Number(next.toFixed(6))));
      setPath(m.path, next);
      if (m.path === 'screener.intervalSec') deps.restartLoops();
      return editMenu(m.group, `${m.label} → ${m.fmt(next)}`);
    }
    default:
      return bot.answerCallbackQuery(q.id).catch(() => {});
  }
}
