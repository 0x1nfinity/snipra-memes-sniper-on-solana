import { createLogger } from '../logger.js';
const log = createLogger('breaker');

const MAX_OPENS_PER_WINDOW = 3;
const WINDOW_MS = 60_000;       // 1 minute
const COOLDOWN_MS = 300_000;    // 5 minute trip

export class CircuitBreaker {
  constructor() {
    this._opens = [];        // timestamps of position opens
    this._trippedUntil = null;
  }

  check(chainKey) {
    if (this._trippedUntil && Date.now() < this._trippedUntil) {
      const remaining = Math.ceil((this._trippedUntil - Date.now()) / 1000);
      throw new Error(`Circuit breaker aktif — terlalu banyak posisi dibuka. Coba lagi dalam ${remaining}s.`);
    }
  }

  recordOpen(chainKey) {
    const now = Date.now();
    this._opens.push(now);
    // Prune old entries outside window
    this._opens = this._opens.filter((t) => now - t < WINDOW_MS);
    if (this._opens.length > MAX_OPENS_PER_WINDOW) {
      this._trippedUntil = now + COOLDOWN_MS;
      log.warn(`Circuit breaker TRIPPED! ${this._opens.length} opens in ${WINDOW_MS / 1000}s. Cooldown ${COOLDOWN_MS / 1000}s.`);
    }
  }

  recordClose(chainKey) {
    // Reset trip on successful close
    if (this._trippedUntil && Date.now() >= this._trippedUntil) {
      this._trippedUntil = null;
      this._opens = [];
      log.info('Circuit breaker reset — cooldown selesai.');
    }
  }

  status() {
    const recent = this._opens.filter((t) => Date.now() - t < WINDOW_MS).length;
    return {
      recentOpens: recent,
      maxPerWindow: MAX_OPENS_PER_WINDOW,
      tripped: Boolean(this._trippedUntil && Date.now() < this._trippedUntil),
      remainingSeconds: this._trippedUntil ? Math.max(0, Math.ceil((this._trippedUntil - Date.now()) / 1000)) : 0,
    };
  }
}

/** Singleton instance — shared across modules via import */
export const breaker = new CircuitBreaker();
