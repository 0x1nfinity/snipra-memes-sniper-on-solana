import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBatchVerdicts } from '../src/llm/http-backend.js';

test('maps verdicts by index, fills missing indices with confidence 0 (rejected)', () => {
  const parsed = { verdicts: [{ index: 1, action: 'skip', confidence: 0.9, risk: 'high', reason: 'r' }] };
  const out = parseBatchVerdicts(parsed, 3);
  assert.equal(out.length, 3);
  assert.equal(out[0].reason, 'no verdict returned');
  // Index yang tidak dijawab LLM HARUS gagal gate (minConfidence default 0.35),
  // bukan lolos sebagai buy 0.5 seperti sebelumnya.
  assert.equal(out[0].confidence, 0);
  assert.equal(out[2].confidence, 0);
  assert.equal(out[1].action, 'skip');
  assert.equal(out[1].confidence, 0.9);
});

test('clamps confidence to 0-1 and coerces unknown action/risk to safe defaults', () => {
  const parsed = { verdicts: [{ index: 0, action: 'nonsense', confidence: 5, risk: 'extreme', reason: 'x' }] };
  const out = parseBatchVerdicts(parsed, 1);
  assert.equal(out[0].action, 'buy'); // anything other than exactly 'skip' -> 'buy', matches assessToken() behavior
  assert.equal(out[0].confidence, 1);
  assert.equal(out[0].risk, 'medium');
});

test('ignores out-of-range or non-integer indices instead of throwing', () => {
  const parsed = { verdicts: [{ index: 99, action: 'skip' }, { index: -1, action: 'skip' }, { index: 'x', action: 'skip' }] };
  const out = parseBatchVerdicts(parsed, 2);
  assert.equal(out.length, 2);
  assert.equal(out[0].action, 'buy');
  assert.equal(out[1].action, 'buy');
});

test('handles a missing or malformed verdicts array', () => {
  assert.equal(parseBatchVerdicts({}, 2).length, 2);
  assert.equal(parseBatchVerdicts({ verdicts: 'not an array' }, 2).length, 2);
});
