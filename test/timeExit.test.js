import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldTimeExit } from '../src/positions/manager.js';

test('returns null when both timers are disabled (0)', () => {
  assert.equal(shouldTimeExit({ ageMinutes: 999, pnlPct: 0, maxHoldMinutes: 0, sidewaysTimeoutMinutes: 0, sidewaysPnlBandPct: 2 }), null);
});

test('MAX_HOLD fires once age reaches the threshold, regardless of pnl', () => {
  assert.equal(shouldTimeExit({ ageMinutes: 60, pnlPct: 500, maxHoldMinutes: 60, sidewaysTimeoutMinutes: 0, sidewaysPnlBandPct: 2 }), 'MAX_HOLD');
  assert.equal(shouldTimeExit({ ageMinutes: 59, pnlPct: 500, maxHoldMinutes: 60, sidewaysTimeoutMinutes: 0, sidewaysPnlBandPct: 2 }), null);
});

test('SIDEWAYS_TIMEOUT fires only when age threshold reached AND pnl is within the band', () => {
  assert.equal(shouldTimeExit({ ageMinutes: 120, pnlPct: 0.5, maxHoldMinutes: 0, sidewaysTimeoutMinutes: 120, sidewaysPnlBandPct: 2 }), 'SIDEWAYS_TIMEOUT');
  assert.equal(shouldTimeExit({ ageMinutes: 120, pnlPct: -0.5, maxHoldMinutes: 0, sidewaysTimeoutMinutes: 120, sidewaysPnlBandPct: 2 }), 'SIDEWAYS_TIMEOUT');
  assert.equal(shouldTimeExit({ ageMinutes: 120, pnlPct: 50, maxHoldMinutes: 0, sidewaysTimeoutMinutes: 120, sidewaysPnlBandPct: 2 }), null); // moving, not sideways
  assert.equal(shouldTimeExit({ ageMinutes: 100, pnlPct: 0, maxHoldMinutes: 0, sidewaysTimeoutMinutes: 120, sidewaysPnlBandPct: 2 }), null); // too early
});

test('MAX_HOLD takes priority over SIDEWAYS_TIMEOUT when both would fire', () => {
  assert.equal(shouldTimeExit({ ageMinutes: 200, pnlPct: 0, maxHoldMinutes: 150, sidewaysTimeoutMinutes: 100, sidewaysPnlBandPct: 2 }), 'MAX_HOLD');
});
