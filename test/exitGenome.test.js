import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveExitGenome } from '../src/screener/screener.js';

function cfg(overrides = {}) {
  return {
    trading: { stopLossPct: -35, ...overrides.trading },
    trailing: { activateGainPct: 10, trailPct: 5, ...overrides.trailing },
  };
}

test('no genes -> falls back to config baseline unchanged', () => {
  assert.deepEqual(resolveExitGenome(cfg(), {}), { slPct: -35, trailingActivateGainPct: 10, trailingTrailPct: 5 });
});

test('stopLossPct gene only allowed to TIGHTEN (less negative), never loosen', () => {
  assert.equal(resolveExitGenome(cfg(), { stopLossPct: -25 }).slPct, -25); // tighter, allowed
  assert.equal(resolveExitGenome(cfg(), { stopLossPct: -45 }).slPct, -35); // looser, clamped to baseline
});

test('trailingActivateGainPct/trailingTrailPct genes only allowed to TIGHTEN (smaller), never loosen', () => {
  const tighter = resolveExitGenome(cfg(), { trailingActivateGainPct: 6, trailingTrailPct: 3 });
  assert.equal(tighter.trailingActivateGainPct, 6);
  assert.equal(tighter.trailingTrailPct, 3);
  const looser = resolveExitGenome(cfg(), { trailingActivateGainPct: 20, trailingTrailPct: 12 });
  assert.equal(looser.trailingActivateGainPct, 10); // clamped to baseline
  assert.equal(looser.trailingTrailPct, 5);           // clamped to baseline
});

test('null/undefined individual genes leave that field at baseline', () => {
  const r = resolveExitGenome(cfg(), { stopLossPct: -20, trailingActivateGainPct: null });
  assert.equal(r.slPct, -20);
  assert.equal(r.trailingActivateGainPct, 10);
});

test('NaN gene value falls back to baseline instead of propagating', () => {
  const r = resolveExitGenome(cfg(), { stopLossPct: NaN, trailingActivateGainPct: NaN, trailingTrailPct: NaN });
  assert.equal(r.slPct, -35);
  assert.equal(r.trailingActivateGainPct, 10);
  assert.equal(r.trailingTrailPct, 5);
  assert.ok(!Number.isNaN(r.slPct) && !Number.isNaN(r.trailingActivateGainPct) && !Number.isNaN(r.trailingTrailPct));
});
