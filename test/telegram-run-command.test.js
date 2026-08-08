import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Telegram } from '../src/telegram/bot.js';

function makeTelegram(overrides = {}) {
  return new Telegram({
    setPaused: () => {},
    isPaused: () => false,
    ...overrides,
  }, { interactive: false });
}

test('runCommand: runs a registered command and captures its send() text', async () => {
  let pausedTo = null;
  const tg = makeTelegram({ setPaused: (v) => { pausedTo = v; } });
  const res = await tg.runCommand('pause', []);
  assert.equal(pausedTo, true);
  assert.match(res.text, /Auto-buy paused/i);
});

test('runCommand: resume captures its own text independently of pause', async () => {
  let pausedTo = null;
  const tg = makeTelegram({ setPaused: (v) => { pausedTo = v; } });
  const res = await tg.runCommand('resume', []);
  assert.equal(pausedTo, false);
  assert.match(res.text, /Auto-buy resumed/i);
});

test('runCommand: unknown command name returns an error object, does not throw', async () => {
  const tg = makeTelegram();
  const res = await tg.runCommand('not_a_real_command', []);
  assert.equal(res.error, 'unknown command: not_a_real_command');
});

test('runCommand: rejects commands that exist in the registry but are outside the skill-mode allowlist', async () => {
  // menu/start/help/buy/sell/closeall/screen ARE registered (buildRegistry
  // wires every command module), but must stay unreachable via runCommand —
  // they're either Telegram-UI-only or already covered by LLM_TOOL_DEFS.
  const tg = makeTelegram();
  assert.ok(tg._commands.get('/menu'), 'sanity check: menu really is in the registry');
  const res = await tg.runCommand('menu', []);
  assert.equal(res.error, 'unknown command: menu');
});

test('runCommand: registry exists even when interactive is false (no polling started)', async () => {
  const tg = makeTelegram();
  assert.ok(tg._commands.get('/pause'), 'registry should be built regardless of interactive flag');
  assert.equal(tg.bot, null, 'bot/polling should not be started just by constructing Telegram');
});
