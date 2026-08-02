import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decisionCacheValid } from '../src/db.js';

test('returns false when row is null', () => {
  assert.equal(decisionCacheValid(null, { now: 1000 }), false);
});

test('returns false when expired', () => {
  const row = { expires_at: 500, mcap_snapshot: null, holders_snapshot: null };
  assert.equal(decisionCacheValid(row, { now: 1000 }), false);
});

test('returns true when not expired and no snapshots to compare', () => {
  const row = { expires_at: 2000, mcap_snapshot: null, holders_snapshot: null };
  assert.equal(decisionCacheValid(row, { now: 1000 }), true);
});

test('invalidates when mcap drifted more than 20%', () => {
  const row = { expires_at: 2000, mcap_snapshot: 100000, holders_snapshot: null };
  assert.equal(decisionCacheValid(row, { now: 1000, mcap: 121000 }), false); // +21%
  assert.equal(decisionCacheValid(row, { now: 1000, mcap: 115000 }), true);  // +15%
});

test('invalidates when holders drifted more than 30%', () => {
  const row = { expires_at: 2000, mcap_snapshot: null, holders_snapshot: 200 };
  assert.equal(decisionCacheValid(row, { now: 1000, holders: 261 }), false); // +30.5%
  assert.equal(decisionCacheValid(row, { now: 1000, holders: 250 }), true);  // +25%
});

test('a zero snapshot is ignored (no divide-by-zero false invalidation)', () => {
  const row = { expires_at: 2000, mcap_snapshot: 0, holders_snapshot: 0 };
  assert.equal(decisionCacheValid(row, { now: 1000, mcap: 500, holders: 10 }), true);
});
