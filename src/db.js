import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('db');

let db = null;

export function initDb() {
  if (db) return db;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(path.join(DATA_DIR, 'snipra.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id   TEXT NOT NULL,
      mode          TEXT NOT NULL,             -- 'paper' | 'live'
      chain         TEXT NOT NULL,
      address       TEXT NOT NULL,
      symbol        TEXT,
      entry_price   REAL,
      exit_price    REAL,
      pnl_pct       REAL,
      amount_native REAL,                      -- modal masuk (SOL/ETH)
      realized_native REAL,                    -- total hasil keluar (SOL/ETH)
      pnl_native    REAL,                      -- realized - amount
      opened_at     INTEGER,
      closed_at     INTEGER,
      hold_minutes  REAL,
      close_reason  TEXT,
      tp_hits       INTEGER,
      genome_id     TEXT,
      llm_score     REAL
    );
    CREATE INDEX IF NOT EXISTS idx_trades_mode ON trades(mode, closed_at);

    CREATE TABLE IF NOT EXISTS paper_wallet (
      chain   TEXT PRIMARY KEY,
      balance REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS paper_holdings (
      chain  TEXT NOT NULL,
      token  TEXT NOT NULL,
      amount REAL NOT NULL,
      PRIMARY KEY (chain, token)
    );

    -- pelacak ATH utk entry guard sniper (harga tertinggi yang pernah kita amati)
    CREATE TABLE IF NOT EXISTS ath_watch (
      chain      TEXT NOT NULL,
      token      TEXT NOT NULL,
      ath        REAL NOT NULL,
      pumped     INTEGER NOT NULL DEFAULT 0,  -- 1 = pernah terdeteksi pump ekstrem
      first_seen INTEGER,
      updated_at INTEGER,
      PRIMARY KEY (chain, token)
    );

    -- cache verdict "skip" dari LLM per token, hindari tanya ulang LLM utk token
    -- yang baru saja dinilai & kondisi pasarnya belum banyak berubah
    CREATE TABLE IF NOT EXISTS decision_cache (
      chain             TEXT NOT NULL,
      address           TEXT NOT NULL,
      verdict           TEXT NOT NULL,        -- 'skip' (hanya skip yang di-cache, buy langsung dieksekusi)
      confidence        REAL NOT NULL,
      reason            TEXT,
      created_at        INTEGER NOT NULL,
      expires_at        INTEGER NOT NULL,
      mcap_snapshot     REAL,
      holders_snapshot  INTEGER,
      PRIMARY KEY (chain, address)
    );
    CREATE INDEX IF NOT EXISTS idx_decision_cache_expires ON decision_cache(expires_at);
  `);
  log.info('sqlite ready: data/snipra.db');
  return db;
}

// ===== trades =====

export function recordTradeDb(trade, mode) {
  initDb()
    .prepare(
      `INSERT INTO trades (position_id, mode, chain, address, symbol, entry_price, exit_price,
        pnl_pct, amount_native, realized_native, pnl_native, opened_at, closed_at, hold_minutes,
        close_reason, tp_hits, genome_id, llm_score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      trade.id, mode, trade.chain, trade.address, trade.symbol,
      trade.entryPrice, trade.currentPrice, trade.finalPnlPct,
      trade.amountNative, trade.realizedNative,
      (trade.realizedNative ?? 0) - (trade.amountNative ?? 0),
      trade.openedAt, trade.closedAt, trade.holdMinutes,
      trade.closeReason, trade.tpHit?.length ?? 0, trade.genomeId,
      trade.llmVerdict?.confidence ?? null
    );
}

export function recentTrades(mode, limit = 10) {
  return initDb()
    .prepare(`SELECT * FROM trades WHERE mode = ? ORDER BY closed_at DESC LIMIT ?`)
    .all(mode, limit);
}

/** Hapus seluruh riwayat trade untuk satu mode (dipakai /paperreset → realized PnL 0). */
export function deleteTrades(mode) {
  return initDb().prepare(`DELETE FROM trades WHERE mode = ?`).run(mode).changes;
}

export function tradeStatsByChain(mode) {
  return initDb()
    .prepare(
      `SELECT chain, COUNT(*) AS total, SUM(pnl_native) AS pnl_native
       FROM trades WHERE mode = ? GROUP BY chain`
    )
    .all(mode);
}

export function tradeStats(mode) {
  return initDb()
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN pnl_pct >= 0 THEN 1 ELSE 0 END) AS wins,
              AVG(pnl_pct) AS avg_pnl_pct,
              SUM(pnl_native) AS total_pnl_native
       FROM trades WHERE mode = ?`
    )
    .get(mode);
}

export function tradeStatsSince(mode, sinceTs) {
  return initDb()
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN pnl_pct >= 0 THEN 1 ELSE 0 END) AS wins,
              SUM(pnl_native) AS total_pnl_native
       FROM trades WHERE mode = ? AND closed_at >= ?`
    )
    .get(mode, sinceTs);
}

// ===== paper wallet =====

export function paperWalletInit(chain, startBalance) {
  initDb()
    .prepare(`INSERT OR IGNORE INTO paper_wallet (chain, balance) VALUES (?, ?)`)
    .run(chain, startBalance);
}

export function paperWalletExists(chain) {
  return Boolean(
    initDb().prepare(`SELECT 1 FROM paper_wallet WHERE chain = ?`).get(chain)
  );
}

export function paperBalance(chain) {
  const row = initDb().prepare(`SELECT balance FROM paper_wallet WHERE chain = ?`).get(chain);
  return row ? row.balance : 0;
}

export function paperAdjustBalance(chain, delta) {
  initDb()
    .prepare(`UPDATE paper_wallet SET balance = balance + ? WHERE chain = ?`)
    .run(delta, chain);
  return paperBalance(chain);
}

export function paperResetWallet(chain, balance) {
  initDb()
    .prepare(`INSERT INTO paper_wallet (chain, balance) VALUES (?, ?)
              ON CONFLICT(chain) DO UPDATE SET balance = excluded.balance`)
    .run(chain, balance);
}

// ===== ATH watch (entry guard) =====

/**
 * Update ATH terlacak dengan harga high (max dari harga sekarang + implied high
 * yang diturunkan dari priceChange). Tidak ada flag sticky — keputusan guard
 * dihitung ulang dari data harga riil tiap siklus.
 * Return { ath, firstSeen }.
 */
export function athObserve(chain, token, highEstimate) {
  const d = initDb();
  const now = Date.now();
  const row = d.prepare(`SELECT ath, first_seen FROM ath_watch WHERE chain=? AND token=?`).get(chain, token);
  if (!row) {
    d.prepare(
      `INSERT INTO ath_watch (chain, token, ath, pumped, first_seen, updated_at) VALUES (?, ?, ?, 0, ?, ?)`
    ).run(chain, token, highEstimate, now, now);
    return { ath: highEstimate, firstSeen: now };
  }
  const ath = Math.max(row.ath, highEstimate);
  d.prepare(`UPDATE ath_watch SET ath=?, updated_at=? WHERE chain=? AND token=?`)
    .run(ath, now, chain, token);
  return { ath, firstSeen: row.first_seen };
}

// ===== decision cache (LLM token-saving) =====

/**
 * Cek apakah cache entry masih berlaku: belum expired, DAN kondisi pasar
 * (mcap/holders) belum bergeser jauh sejak verdict di-cache.
 * Pure function (tanpa DB) supaya gampang di-unit-test.
 */
export function decisionCacheValid(row, { mcap, holders, now = Date.now() } = {}) {
  if (!row) return false;
  if (row.expires_at <= now) return false;
  if (mcap != null && row.mcap_snapshot != null && row.mcap_snapshot > 0) {
    if (Math.abs(mcap - row.mcap_snapshot) / row.mcap_snapshot > 0.20) return false;
  }
  if (holders != null && row.holders_snapshot != null && row.holders_snapshot > 0) {
    if (Math.abs(holders - row.holders_snapshot) / row.holders_snapshot > 0.30) return false;
  }
  return true;
}

export function checkDecisionCache(chain, address, { mcap, holders } = {}) {
  const row = initDb()
    .prepare(`SELECT * FROM decision_cache WHERE chain = ? AND address = ?`)
    .get(chain, address.toLowerCase());
  if (!decisionCacheValid(row, { mcap, holders })) return null;
  return { verdict: row.verdict, confidence: row.confidence, reason: row.reason };
}

export function storeDecisionCache(chain, address, verdict, { confidence, reason, mcap, holders, ttlMs }) {
  const now = Date.now();
  initDb()
    .prepare(
      `INSERT INTO decision_cache (chain, address, verdict, confidence, reason, created_at, expires_at, mcap_snapshot, holders_snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chain, address) DO UPDATE SET
         verdict = excluded.verdict, confidence = excluded.confidence, reason = excluded.reason,
         created_at = excluded.created_at, expires_at = excluded.expires_at,
         mcap_snapshot = excluded.mcap_snapshot, holders_snapshot = excluded.holders_snapshot`
    )
    .run(chain, address.toLowerCase(), verdict, confidence ?? 0, reason ?? null, now, now + ttlMs, mcap ?? null, holders ?? null);
}

/** Housekeeping: hapus entry cache yang sudah expired. Dipanggil tiap screening cycle. */
export function pruneExpiredDecisionCache() {
  return initDb().prepare(`DELETE FROM decision_cache WHERE expires_at < ?`).run(Date.now()).changes;
}

// ===== paper holdings =====

export function paperHolding(chain, token) {
  const row = initDb()
    .prepare(`SELECT amount FROM paper_holdings WHERE chain = ? AND token = ?`)
    .get(chain, token);
  return row ? row.amount : 0;
}

export function paperSetHolding(chain, token, amount) {
  if (amount <= 0) {
    initDb().prepare(`DELETE FROM paper_holdings WHERE chain = ? AND token = ?`).run(chain, token);
  } else {
    initDb()
      .prepare(`INSERT INTO paper_holdings (chain, token, amount) VALUES (?, ?, ?)
                ON CONFLICT(chain, token) DO UPDATE SET amount = excluded.amount`)
      .run(chain, token, amount);
  }
}
