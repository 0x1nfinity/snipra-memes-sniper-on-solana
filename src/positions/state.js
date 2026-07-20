import fs from 'fs';
import path from 'path';
import { DATA_DIR, getConfig } from '../config.js';
import { recordTradeDb } from '../db.js';
import { pnlPct } from '../utils.js';
import { createLogger } from '../logger.js';

const log = createLogger('state');

// State DIPISAH per-mode: positions.paper.json vs positions.live.json.
// Tujuan: posisi, moonbag, cooldown, & statistik paper tidak pernah tercampur
// dengan live. File yang dipakai selalu mengikuti mode yang sedang di-load.
function fileForMode(mode) {
  return path.join(DATA_DIR, `positions.${mode}.json`);
}

function freshState() {
  return {
    open: [],
    closed: [],
    moonbags: [], // sisa alokasi hold jangka panjang (di luar slot maxPositions)
    cooldowns: {}, // `${chain}:${address}` → timestamp exit terakhir
    stats: { totalTrades: 0, wins: 0, losses: 0, totalPnlPct: 0 },
  };
}

let state = freshState();
let loadedMode = null; // mode yang sedang dimuat di memori (paper|live)

export function loadState() {
  loadedMode = getConfig().mode;
  state = freshState(); // reset dulu agar tidak membawa sisa mode sebelumnya
  const file = fileForMode(loadedMode);
  if (fs.existsSync(file)) {
    try {
      state = { ...state, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
      log.info(`state[${loadedMode}] loaded: ${state.open.length} open, ${state.closed.length} closed`);
    } catch (e) {
      log.error(`${path.basename(file)} rusak:`, e.message);
    }
  } else {
    log.info(`state[${loadedMode}] baru — ${path.basename(file)} belum ada`);
  }
  return state;
}

/**
 * Dipanggil setiap kali cfg.mode berubah (hot-reload config.json / /mode / /set mode).
 * Muat ulang state in-memory dari file mode yang baru supaya paper & live tak menyatu.
 * @returns {boolean} true bila mode benar-benar berganti (state di-reload).
 */
export function syncStateMode() {
  if (getConfig().mode === loadedMode) return false;
  log.info(`mode berubah ${loadedMode} → ${getConfig().mode}: reload state dari file mode baru`);
  loadState();
  return true;
}

function persist() {
  // Tulis ke file milik loadedMode (bukan getConfig().mode) supaya bila mode
  // baru berganti tapi syncStateMode() belum jalan, data lama tidak bocor ke file baru.
  const file = fileForMode(loadedMode ?? getConfig().mode);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

export function getState() {
  return state;
}

export function openPositions() {
  return state.open;
}

export function findOpen(chain, address) {
  return state.open.find((p) => p.chain === chain && p.address === address);
}

export function inCooldown(chain, address, cooldownMinutes) {
  const t = state.cooldowns[`${chain}:${address}`];
  return t != null && Date.now() - t < cooldownMinutes * 60000;
}

export function addPosition({ chain, address, symbol, pairAddress, labels, entryPrice, amountNative, tokensRaw, txid, genomeId, llmVerdict }) {
  const pos = {
    id: `${chain}-${address.slice(0, 8)}-${Date.now()}`,
    chain,
    address,
    symbol,
    pairAddress,
    labels: labels || [],
    entryPrice,
    currentPrice: entryPrice,
    peakPrice: entryPrice,
    amountNative, // modal dalam native (SOL/ETH)
    remainingPct: 100, // % posisi yang masih dipegang
    tokensRaw: tokensRaw?.toString?.() ?? String(tokensRaw ?? ''),
    realizedNative: 0, // hasil sell parsial terkumpul
    tpHit: [], // index tier tpLadder yang sudah dieksekusi
    trailingActive: false,
    openedAt: Date.now(),
    txid,
    genomeId: genomeId || null,
    llmVerdict: llmVerdict || null,
    lastPriceAt: Date.now(),
  };
  state.open.push(pos);
  persist();
  return pos;
}

export function updatePrice(pos, price) {
  // Guard harga anomali: lonjakan >500% dalam satu tick kemungkinan data rusak
  if (pos.currentPrice > 0 && price > pos.currentPrice * 6) {
    log.warn(`${pos.symbol}: harga anomali ${price} (prev ${pos.currentPrice}), skip tick`);
    return false;
  }
  pos.currentPrice = price;
  pos.lastPriceAt = Date.now();
  if (price > pos.peakPrice) pos.peakPrice = price;
  persist();
  return true;
}

export function currentPnlPct(pos) {
  return pnlPct(pos.entryPrice, pos.currentPrice);
}

export function recordPartialSell(pos, { pctOfRemaining, receivedNative, tierIndex, txid }) {
  pos.remainingPct = pos.remainingPct * (1 - pctOfRemaining / 100);
  pos.realizedNative += receivedNative || 0;
  if (tierIndex != null) pos.tpHit.push(tierIndex);
  pos.lastSellTx = txid;
  persist();
}

export function closePosition(pos, { reason, receivedNative, txid }) {
  pos.realizedNative += receivedNative || 0;
  const pnl = currentPnlPct(pos);
  const trade = {
    ...pos,
    closedAt: Date.now(),
    closeReason: reason,
    closeTx: txid,
    finalPnlPct: pnl,
    holdMinutes: (Date.now() - pos.openedAt) / 60000,
  };
  state.open = state.open.filter((p) => p.id !== pos.id);
  state.closed.push(trade);
  if (state.closed.length > 500) state.closed = state.closed.slice(-500);
  state.cooldowns[`${pos.chain}:${pos.address}`] = Date.now();

  state.stats.totalTrades += 1;
  if (pnl >= 0) state.stats.wins += 1;
  else state.stats.losses += 1;
  state.stats.totalPnlPct += pnl;
  persist();

  // riwayat permanen ke SQLite (paper & live sama-sama tercatat, dibedakan kolom mode)
  try {
    recordTradeDb(trade, getConfig().mode);
  } catch (e) {
    log.error('recordTradeDb gagal:', e.message);
  }
  return trade;
}

// ===== moonbag =====

export function moonbags() {
  return state.moonbags;
}

export function findMoonbag(address) {
  return state.moonbags.find((m) => m.address.toLowerCase() === address.toLowerCase());
}

/**
 * Tutup trade (tercatat ke stats + DB) tapi sisa posisi (moonbagPct) dipindah
 * ke daftar moonbag: tetap dipantau harganya, tanpa rule TP/trailing/SL,
 * dan tidak menghitung slot maxPositions.
 */
export function moveToMoonbag(pos, { reason, receivedNative, txid }) {
  const moonPct = pos.remainingPct;
  const snapshot = {
    id: `moon-${pos.chain}-${pos.address.slice(0, 8)}-${Date.now()}`,
    chain: pos.chain,
    address: pos.address,
    symbol: pos.symbol,
    pairAddress: pos.pairAddress,
    labels: pos.labels,
    entryPrice: pos.entryPrice,
    currentPrice: pos.currentPrice,
    peakPrice: pos.peakPrice,
    moonPct, // % dari posisi awal yang di-hold
    openedAt: pos.openedAt,
    movedAt: Date.now(),
  };
  const trade = closePosition(pos, { reason, receivedNative, txid });
  state.moonbags.push(snapshot);
  persist();
  return trade;
}

export function updateMoonbagPrice(m, price) {
  m.currentPrice = price;
  if (price > (m.peakPrice || 0)) m.peakPrice = price;
  persist();
}

export function removeMoonbag(id) {
  state.moonbags = state.moonbags.filter((m) => m.id !== id);
  persist();
}

export function statsSummary() {
  const s = state.stats;
  const wr = s.totalTrades > 0 ? (s.wins / s.totalTrades) * 100 : 0;
  const avg = s.totalTrades > 0 ? s.totalPnlPct / s.totalTrades : 0;
  return { ...s, winRatePct: wr, avgPnlPct: avg };
}

/**
 * Nolkan akumulator statistik + riwayat close in-memory (dipakai /paperreset).
 * Catatan: state.stats/closed bersifat global (tidak per-mode); reset ini
 * mengembalikan realized PnL yang tampil di /stats ke 0. Riwayat DB dihapus
 * terpisah per-mode via deleteTrades('paper').
 */
export function resetStats() {
  state.stats = { totalTrades: 0, wins: 0, losses: 0, totalPnlPct: 0 };
  state.closed = [];
  persist();
}
