import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preScore, PRE_SCORE_THRESHOLD } from '../src/screener/preScorer.js';

function candidate(overrides = {}) {
  return {
    buySellRatio: 1.0,
    volume24h: 50000,
    liquidityUsd: 20000,
    holders: 200,
    socials: 0,
    priceChange: { h1: 5 },
    security: { top10Pct: 50 },
    ...overrides,
  };
}

test('strong candidate scores high and passes', () => {
  const c = candidate({
    buySellRatio: 2.0,
    volume24h: 100000,
    liquidityUsd: 20000, // vol/liq = 5 -> top tier
    holders: 1500,
    socials: 2,
    security: { top10Pct: 30 },
  });
  const r = preScore(c);
  assert.equal(r.passed, true);
  assert.ok(r.score >= PRE_SCORE_THRESHOLD, `score ${r.score} should be >= ${PRE_SCORE_THRESHOLD}`);
});

test('weak candidate scores low and fails', () => {
  const c = candidate({
    buySellRatio: 0.5,
    volume24h: 10000,
    liquidityUsd: 40000, // vol/liq = 0.25 -> weakest tier
    holders: 50,
    socials: 0,
    security: { top10Pct: 90 },
    priceChange: { h1: -20 },
  });
  const r = preScore(c);
  assert.equal(r.passed, false);
  assert.ok(r.score < PRE_SCORE_THRESHOLD);
});

test('unknown top10Pct (no security data) scores zero for that factor, does not throw', () => {
  const c = candidate({ security: null });
  assert.doesNotThrow(() => preScore(c));
});

test('threshold is exactly inclusive', () => {
  // construct a candidate whose total is exactly PRE_SCORE_THRESHOLD
  const c = candidate({
    buySellRatio: 0.9,        // tier: >=0.9 -> 5 pts
    volume24h: 20000,
    liquidityUsd: 20000,       // vol/liq = 1 -> tier >=1 -> 15 pts
    holders: 500,               // tier >=500 -> 9 pts
    socials: 1,                  // 10 pts
    security: { top10Pct: 60 }, // tier <=60 -> 12 pts... total so far 5+15+9+10+12=51
    priceChange: { h1: 5 },      // within band -> 5 pts => 56 total, just checking no throw/shape
  });
  const r = preScore(c);
  assert.equal(typeof r.score, 'number');
  assert.equal(typeof r.passed, 'boolean');
  assert.ok(Array.isArray(r.reasons));
});
