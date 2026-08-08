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

test('runCommand: does not capture unrelated notify() text that fires while a handler is mid-await', async () => {
  // paperreset genuinely awaits deps.executor.paperReset(...) before it sends
  // its own result — exactly the "handler mid-await" window the finding
  // describes. We gate that await on a promise we control from the test, so
  // we can fire an unrelated _send() (standing in for a concurrent notify()
  // from e.g. the status loop or a position-close callback on the SAME
  // Telegram instance) DURING the window, then let the handler finish.
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const tg = makeTelegram({
    executor: {
      paperReset: async () => {
        await gate; // simulates real work in progress mid-command
        return { balances: { sol: 1 }, closedCount: 0 };
      },
    },
  });

  const runP = tg.runCommand('paperreset', []);

  // Fire the unrelated background send while runCommand's handler is
  // suspended on `gate` — this is the concurrency window that leaked
  // under the old shared `this._captureSink` field.
  await tg._send('🔔 unrelated background notification');

  releaseGate();
  const res = await runP;

  assert.match(res.text, /Paper reset/i, 'command\'s own output should still be captured');
  assert.doesNotMatch(
    res.text,
    /unrelated background notification/,
    'concurrent unrelated _send() must not leak into this runCommand() result'
  );
});
