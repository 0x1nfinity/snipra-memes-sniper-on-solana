import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolRunner, inferChain, LLM_TOOL_DEFS } from '../src/llm/tools.js';

test('LLM_TOOL_DEFS exposes exactly the 5 known tool names', () => {
  const names = LLM_TOOL_DEFS.map((d) => d.function.name);
  assert.deepEqual(names, ['get_positions', 'screen_now', 'buy_token', 'sell_token', 'close_all_positions']);
});

test('inferChain recognizes a base58 Solana-shaped address', () => {
  assert.equal(inferChain('DyKoCHKYn69hd2nW1rjRfScYdGz1YK4YahoN3ak8pump'), 'solana');
});

test('inferChain returns null for a non-address string', () => {
  assert.equal(inferChain('not-an-address'), null);
});

test('get_positions summarizes open positions and moonbag count', async () => {
  const runLlmTool = createToolRunner({
    openPositions: () => [{ chain: 'solana', symbol: 'FOO', address: 'abc', remainingPct: 100 }],
    currentPnlPct: () => 12.5,
    moonbags: () => [{}, {}],
  });
  const result = await runLlmTool('get_positions', {});
  assert.deepEqual(result, {
    openCount: 1,
    positions: [{ chain: 'solana', symbol: 'FOO', address: 'abc', pnlPct: 12.5, remainingPct: 100 }],
    moonbags: 2,
  });
});

test('screen_now triggers the screening cycle thunk and returns immediately', async () => {
  let calledWith = null;
  const runLlmTool = createToolRunner({ screeningCycle: (force) => { calledWith = force; } });
  const result = await runLlmTool('screen_now', {});
  assert.equal(calledWith, true);
  assert.deepEqual(result, { ok: true, note: 'screening triggered; results sent as a separate notification' });
});

test('buy_token rejects when no chain is given and the address is not Solana-shaped', async () => {
  const runLlmTool = createToolRunner({});
  const result = await runLlmTool('buy_token', { address: 'not-a-solana-address' });
  assert.deepEqual(result, { error: 'unknown chain' });
});

test('buy_token calls the injected buyToken with the resolved chain and fixed args', async () => {
  let capturedArgs = null;
  const runLlmTool = createToolRunner({
    buyToken: async (...args) => { capturedArgs = args; return { symbol: 'FOO', entryPrice: 0.001, txid: 'tx1' }; },
    executor: 'EXEC', onTradeClosed: 'ON_CLOSE',
  });
  const result = await runLlmTool('buy_token', { chain: 'solana', address: 'abc', amount: 0.5 });
  assert.deepEqual(capturedArgs, ['solana', 'abc', 0.5, 'llm-tool', null, 'EXEC', 'ON_CLOSE']);
  assert.deepEqual(result, { ok: true, symbol: 'FOO', chain: 'solana', entryPrice: 0.001, tx: 'tx1' });
});

test('sell_token defaults pct to 100 and returns the receipt', async () => {
  let capturedArgs = null;
  const runLlmTool = createToolRunner({
    sellToken: async (...args) => { capturedArgs = args; return { receivedNative: 0.31, txid: 'tx2' }; },
    executor: 'EXEC', onTradeClosed: 'ON_CLOSE',
  });
  const result = await runLlmTool('sell_token', { address: 'abc' });
  assert.deepEqual(capturedArgs, ['abc', 100, 'EXEC', 'ON_CLOSE']);
  assert.deepEqual(result, { ok: true, receivedNative: 0.31, tx: 'tx2' });
});

test('close_all_positions reports the count of successful closes via the injected thunk', async () => {
  const runLlmTool = createToolRunner({
    closeAllPositions: async (reason) => {
      assert.equal(reason, 'llm-tool');
      return [{ ok: true }, { error: 'failed' }];
    },
  });
  const result = await runLlmTool('close_all_positions', {});
  assert.deepEqual(result, { ok: true, closed: 1, results: [{ ok: true }, { error: 'failed' }] });
});

test('unknown tool name returns an error object instead of throwing', async () => {
  const runLlmTool = createToolRunner({});
  const result = await runLlmTool('not_a_real_tool', {});
  assert.deepEqual(result, { error: 'unknown tool: not_a_real_tool' });
});
