import { createLogger } from '../logger.js';
const log = createLogger('breaker');

const MAX_OPENS_PER_WINDOW = 3;
const WINDOW_MS = 60_000;       // 1 minute
const COOLDOWN_MS = 300_000;    // 5 minute trip

export class CircuitBreaker {
  constructor() {
    this._opens = {};           // per-chain: chainKey → timestamps[]
    this._trippedUntil = {};    // per-chain: chainKey → timestamp until
    this._tripTimestamps = {};  // per-chain: chainKey → trip start timestamp
  }

  check(chainKey) {
    const until = this._trippedUntil[chainKey];
    if (until && Date.now() < until) {
      const remaining = Math.ceil((until - Date.now()) / 1000);
      throw new Error(`Circuit breaker ${chainKey} active — too many positions opened. Try again in ${remaining}s.`);
    }
  }

  recordOpen(chainKey) {
    const now = Date.now();
    const opens = this._opens[chainKey] || [];
    opens.push(now);
    const pruned = opens.filter((t) => now - t < WINDOW_MS);
    this._opens[chainKey] = pruned;
    if (pruned.length > MAX_OPENS_PER_WINDOW) {
      this._trippedUntil[chainKey] = now + COOLDOWN_MS;
      this._tripTimestamps[chainKey] = now;
      log.warn(`Circuit breaker ${chainKey} TRIPPED! ${pruned.length} opens in ${WINDOW_MS / 1000}s. Cooldown ${COOLDOWN_MS / 1000}s.`);
    }
  }

  recordClose(chainKey, openTime) {
    const tripTs = this._tripTimestamps[chainKey];
    // Only reset breaker if the closed position was opened AFTER the trip —
    // meaning the trip caused the user to close (risk management working).
    // Pre-existing positions closing during cooldown should NOT reset the breaker.
    if (this._trippedUntil[chainKey] && (openTime == null || openTime > tripTs)) {
      this._trippedUntil[chainKey] = null;
      this._tripTimestamps[chainKey] = null;
      this._opens[chainKey] = [];
      log.info(`Circuit breaker ${chainKey} reset by position close${openTime != null ? ' (post-trip)' : ''}.`);
    }
  }

  status(chainKey) {
    const opens = this._opens[chainKey] || [];
    const recent = opens.filter((t) => Date.now() - t < WINDOW_MS).length;
    const until = this._trippedUntil[chainKey];
    return {
      recentOpens: recent,
      maxPerWindow: MAX_OPENS_PER_WINDOW,
      tripped: Boolean(until && Date.now() < until),
      remainingSeconds: until ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : 0,
    };
  }
}

/** Singleton instance — shared across modules via import */
export const breaker = new CircuitBreaker();
