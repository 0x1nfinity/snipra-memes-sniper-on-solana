import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sweepStaleCommandFiles, startCommandQueueLoop } from '../src/skills/command-queue.js';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('sweepStaleCommandFiles removes only files older than maxAgeMs', () => {
  const dir = tmpDir('snipra-cmdq-sweep-');
  const oldFile = path.join(dir, 'old.cmd.json');
  const freshFile = path.join(dir, 'fresh.cmd.json');
  fs.writeFileSync(oldFile, '{}');
  fs.writeFileSync(freshFile, '{}');
  const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(oldFile, twoHoursAgo, twoHoursAgo);
  sweepStaleCommandFiles(dir, 60 * 60 * 1000);
  assert.equal(fs.existsSync(oldFile), false);
  assert.equal(fs.existsSync(freshFile), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('processes a command file and writes a result file, deleting the command file first', async () => {
  const dir = tmpDir('snipra-cmdq-process-');
  const id = 'cmd-test-1';
  fs.writeFileSync(path.join(dir, `${id}.cmd.json`), JSON.stringify({ id, name: 'ping', args: { x: 1 } }));
  const seenCalls = [];
  const runLlmTool = async (name, args) => { seenCalls.push([name, args]); return { echoed: name }; };
  const timer = startCommandQueueLoop(runLlmTool, { dir, intervalMs: 20 });
  await new Promise((resolve) => setTimeout(resolve, 80));
  clearInterval(timer);
  assert.deepEqual(seenCalls, [['ping', { x: 1 }]]);
  const raw = fs.readFileSync(path.join(dir, `${id}.result.json`), 'utf8');
  const result = JSON.parse(raw);
  assert.equal(result.id, id);
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, { echoed: 'ping' });
  assert.equal(fs.existsSync(path.join(dir, `${id}.cmd.json`)), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a tool that throws produces an ok:false result instead of crashing the loop', async () => {
  const dir = tmpDir('snipra-cmdq-error-');
  const id = 'cmd-test-2';
  fs.writeFileSync(path.join(dir, `${id}.cmd.json`), JSON.stringify({ id, name: 'boom', args: {} }));
  const runLlmTool = async () => { throw new Error('kaboom'); };
  const timer = startCommandQueueLoop(runLlmTool, { dir, intervalMs: 20 });
  await new Promise((resolve) => setTimeout(resolve, 80));
  clearInterval(timer);
  const raw = fs.readFileSync(path.join(dir, `${id}.result.json`), 'utf8');
  const result = JSON.parse(raw);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'kaboom');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a malformed command file is dropped without producing a result file', async () => {
  const dir = tmpDir('snipra-cmdq-malformed-');
  fs.writeFileSync(path.join(dir, 'broken.cmd.json'), '{not valid json');
  const runLlmTool = async () => ({});
  const timer = startCommandQueueLoop(runLlmTool, { dir, intervalMs: 20 });
  await new Promise((resolve) => setTimeout(resolve, 80));
  clearInterval(timer);
  assert.equal(fs.existsSync(path.join(dir, 'broken.cmd.json')), false);
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
