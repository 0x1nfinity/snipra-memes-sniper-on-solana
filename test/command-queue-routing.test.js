import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeCommand } from '../src/skills/command-queue.js';

const toolNames = new Set(['get_positions', 'screen_now', 'buy_token', 'sell_token', 'close_all_positions']);

test('routeCommand: dispatches known tool names to runLlmTool with object args', async () => {
  let seen = null;
  const runLlmTool = async (name, args) => { seen = { name, args }; return { ok: true }; };
  const runCommand = async () => { throw new Error('should not be called'); };
  const result = await routeCommand('buy_token', { chain: 'solana', address: 'abc' }, { runLlmTool, runCommand, toolNames });
  assert.deepEqual(seen, { name: 'buy_token', args: { chain: 'solana', address: 'abc' } });
  assert.deepEqual(result, { ok: true });
});

test('routeCommand: dispatches unknown-to-tools names to runCommand with array args', async () => {
  let seen = null;
  const runLlmTool = async () => { throw new Error('should not be called'); };
  const runCommand = async (name, args) => { seen = { name, args }; return { text: 'ok' }; };
  const result = await routeCommand('darwin', ['x', 'y'], { runLlmTool, runCommand, toolNames });
  assert.deepEqual(seen, { name: 'darwin', args: ['x', 'y'] });
  assert.deepEqual(result, { text: 'ok' });
});

test('routeCommand: non-array args for a command name are normalized to []', async () => {
  let seen = null;
  const runLlmTool = async () => { throw new Error('should not be called'); };
  const runCommand = async (name, args) => { seen = args; return { text: 'ok' }; };
  await routeCommand('lessons', undefined, { runLlmTool, runCommand, toolNames });
  assert.deepEqual(seen, []);
});

test('routeCommand: missing/non-object args for a tool name normalize to {}', async () => {
  let seen = null;
  const runLlmTool = async (name, args) => { seen = args; return {}; };
  const runCommand = async () => { throw new Error('should not be called'); };
  await routeCommand('screen_now', undefined, { runLlmTool, runCommand, toolNames });
  assert.deepEqual(seen, {});
});
