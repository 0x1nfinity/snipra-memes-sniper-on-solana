import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dynamicStopLossPercent } from '../src/utils.js';

const DEFAULTS = { multiplier: 1.5, floorPercent: -55, ceilingPercent: -10, minVolPercent: 3, maxVolPercent: 40 };

test('falls back to base (clamped) when volPercent is missing/zero', () => {
  assert.equal(dynamicStopLossPercent({ baseSlPercent: -35, volPercent: null, ...DEFAULTS }), -35);
  assert.equal(dynamicStopLossPercent({ baseSlPercent: -35, volPercent: 0, ...DEFAULTS }), -35);
});

test('base outside [floor, ceiling] gets clamped even without volPercent', () => {
  assert.equal(dynamicStopLossPercent({ baseSlPercent: -80, volPercent: null, ...DEFAULTS }), -55); // below floor
  assert.equal(dynamicStopLossPercent({ baseSlPercent: -5, volPercent: null, ...DEFAULTS }), -10);  // above ceiling
});

test('widens the stop when volatility is high, narrows when low', () => {
  // baseSlPercent = -35, volPercent = 30: bounded=30, dynamic=-45, blend=(-35+-45)/2=-40
  // baseSlPercent = -35, volPercent = 5:  bounded=5,  dynamic=-7.5, blend=(-35+-7.5)/2=-21.25
  // Both now reflect 50/50 blend between user baseline and volatility signal
  const wide = dynamicStopLossPercent({ baseSlPercent: -35, volPercent: 30, ...DEFAULTS });
  const narrow = dynamicStopLossPercent({ baseSlPercent: -35, volPercent: 5, ...DEFAULTS });
  assert.equal(wide, -40);
  assert.equal(narrow, -21.25);
});

test('volPercent is clamped to [minVolPercent, maxVolPercent] before applying the multiplier', () => {
  // volPercent=999 → bounded=40 (clamped), dynamic=-60, blend=(-35+-60)/2=-47.5
  const extreme = dynamicStopLossPercent({ baseSlPercent: -35, volPercent: 999, ...DEFAULTS });
  assert.equal(extreme, -47.5);
});

// dynamicSl.enabled defaults to false (opt-in), dan _applyRules() memakai pola
// baseSlPct = pos.slPct ?? cfg.trading.stopLossPct. Jadi pada jalur DEFAULT, SL efektif
// harus mengikuti baseline apa pun yang diberikan — termasuk slPct hasil genome Darwin
// yang lebih ketat dari cfg.trading.stopLossPct — bukan balik ke nilai config datar.
test('honors a genome-tightened baseSlPercent when dynamicSl is a no-op (no vol data)', () => {
  // genome mempersempit SL dari config -35 menjadi -20 (lihat resolveExitGenome)
  assert.equal(dynamicStopLossPercent({ baseSlPercent: -20, volPercent: null, ...DEFAULTS }), -20);
  assert.equal(dynamicStopLossPercent({ baseSlPercent: -20, volPercent: 0, ...DEFAULTS }), -20);
  assert.equal(dynamicStopLossPercent({ baseSlPercent: -20, volPercent: undefined, ...DEFAULTS }), -20);
});

test('invalid baseSlPercent falls back to -25', () => {
  assert.equal(dynamicStopLossPercent({ baseSlPercent: NaN, volPercent: 10, ...DEFAULTS }), -25);
});
