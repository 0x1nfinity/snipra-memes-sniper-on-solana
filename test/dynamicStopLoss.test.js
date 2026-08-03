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
  const wide = dynamicStopLossPercent({ baseSlPercent: -35, volPercent: 30, ...DEFAULTS }); // 30*1.5=-45
  const narrow = dynamicStopLossPercent({ baseSlPercent: -35, volPercent: 5, ...DEFAULTS });  // 5*1.5=-7.5 -> clamped to ceiling -10
  assert.equal(wide, -45);
  assert.equal(narrow, -10);
});

test('volPercent is clamped to [minVolPercent, maxVolPercent] before applying the multiplier', () => {
  const extreme = dynamicStopLossPercent({ baseSlPercent: -35, volPercent: 999, ...DEFAULTS }); // clamped to 40*1.5=-60 -> floor -55
  assert.equal(extreme, -55);
});

test('invalid baseSlPercent falls back to -25', () => {
  assert.equal(dynamicStopLossPercent({ baseSlPercent: NaN, volPercent: 10, ...DEFAULTS }), -25);
});
