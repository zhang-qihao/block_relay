'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLeaderboard } = require('../leaderboard');

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'block-relay-leaderboard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'data', 'leaderboard.json');
}

test('leaderboard merges NFC nickname highs, preserves ties and validates scores', async () => {
  const board = createLeaderboard();
  assert.equal(board.record('é', 100, 'survival', 200), true);
  assert.equal(board.record('é', 90, 'survival', 100), false);
  assert.equal(board.record('é', 100, 'survival', 100), false);
  board.record('Alice', 200, 'survival', 300);
  board.record('alice', 200, 'survival', 250);
  board.record('Bob', 200, 'survival', 250);
  assert.deepEqual(board.snapshot().entries.map(row => row.name), ['alice', 'Bob', 'Alice', 'é']);
  assert.equal(board.record('é', 90, 'timed', 500), true);
  assert.equal(board.record('é', 300, 'timed', 600), true);
  assert.equal(board.snapshot().entries.find(row => row.mode === 'timed').score, 300);
  assert.equal(board.snapshot().entries.find(row => row.name === 'é' && row.mode === 'survival').score, 100);
  for (const score of [0, -1, Infinity, NaN, '100', .5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(board.record('invalid', score, 'survival'), false);
  assert.equal(board.record('invalid', 100, 'unknown'), false);
  assert.equal(board.record('', 100, 'survival'), false);
  assert.equal(board.snapshot().storage, 'memory');
  await board.flush();
});

test('leaderboard atomically saves concurrent highs and restores after restart', async t => {
  const file = temporary(t);
  const board = createLeaderboard({ file });
  for (let i = 0; i < 60; i++) board.record(`玩家${i}`, 100 + i, 'survival', i);
  const first = board.flush();
  board.record('冠军', 10000, 'sprint', 100);
  await Promise.all([first, board.flush()]);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(json.entries.length, 61);
  assert.equal(json.entries[0].name, '冠军');
  assert.equal(json.version, 2);
  assert.equal(board.snapshot().entries.filter(row => row.mode === 'survival').length, 50);
  assert.equal(board.snapshot().entries.find(row => row.mode === 'sprint').rank, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['leaderboard.json']);
  const restored = createLeaderboard({ file });
  assert.deepEqual(restored.snapshot().entries, board.snapshot().entries);
  assert.equal(restored.snapshot().storage, 'saved');
});

test('each mode keeps its own top three and top fifty without global truncation', () => {
  const board = createLeaderboard();
  const { modes } = require('../public/rules');
  for (const [index, mode] of Object.keys(modes).entries()) {
    for (let i = 0; i < 60; i++) board.record(`玩家${i}`, 10000 * index + i + 1, mode, i);
  }
  const entries = board.snapshot().entries;
  assert.equal(entries.length, Object.keys(modes).length * 50);
  for (const mode of Object.keys(modes)) {
    const list = entries.filter(entry => entry.mode === mode);
    assert.deepEqual(list.slice(0, 3).map(entry => [entry.rank, entry.name]), [[1, '玩家59'], [2, '玩家58'], [3, '玩家57']]);
    assert.equal(list.at(-1).rank, 50);
  }
});

test('legacy records retain their original modes and new mode highs survive restart', async t => {
  const file = temporary(t);
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ version: 1, entries: [
    { name: '老玩家', score: 500, mode: 'practice', at: 1 },
    { name: 'é', score: 100, mode: 'survival', at: 2 },
    { name: 'é', score: 90, mode: 'survival', at: 3 },
  ] }));
  const board = createLeaderboard({ file });
  assert.equal(board.snapshot().entries.length, 2);
  assert.equal(board.record('老玩家', 50, 'dig', 4), true);
  assert.equal(board.record('老玩家', 400, 'practice', 5), false);
  await board.flush();
  const restored = createLeaderboard({ file });
  assert.deepEqual(restored.snapshot().entries, board.snapshot().entries);
  assert.deepEqual(restored.snapshot().entries.filter(entry => entry.name === '老玩家').map(entry => [entry.mode, entry.score, entry.rank]), [['practice', 500, 1], ['dig', 50, 1]]);
});

test('retired battle records remain readable and preserved without a selectable mode', async t => {
  const file = temporary(t);
  fs.mkdirSync(path.dirname(file));
  const legacy = { name: '老玩家', mode: 'battle', score: 1200, at: 1 };
  fs.writeFileSync(file, JSON.stringify({ version: 2, entries: [legacy] }));
  const board = createLeaderboard({ file });
  assert.equal(board.snapshot().available, true);
  assert.equal(board.snapshot().storage, 'saved');
  assert.deepEqual(board.snapshot().entries, []);
  board.record('新玩家', 100, 'survival', 2);
  await board.flush();
  assert.ok(JSON.parse(fs.readFileSync(file)).entries.some(entry => entry.mode === 'battle' && entry.score === 1200));
});

test('server shutdown flushes pending leaderboard records before returning', async t => {
  const { createApp } = require('../server');
  const file = temporary(t);
  const board = createLeaderboard({ file });
  const app = createApp({ leaderboard: board });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  board.record('停服前纪录', 3210, 'survival');
  await app.close();
  assert.equal(createLeaderboard({ file }).snapshot().entries[0].score, 3210);
});

test('server shutdown rejects when pending leaderboard records cannot be saved', async t => {
  const { createApp } = require('../server');
  const file = temporary(t);
  const board = createLeaderboard({ file, onError() {} });
  const app = createApp({ leaderboard: board });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  board.record('未保存纪录', 3210, 'survival');
  fs.writeFileSync(path.dirname(file), 'blocked');
  try {
    await assert.rejects(app.close(), /排行榜保存失败/);
    assert.equal(app.server.listening, false);
    assert.equal(board.snapshot().storage, 'error');
    assert.equal(board.snapshot().entries[0].score, 3210);
  } finally {
    fs.unlinkSync(path.dirname(file));
    await board.flush();
  }
  assert.equal(createLeaderboard({ file }).snapshot().entries[0].score, 3210);
});

test('corrupt leaderboard remains untouched and disables writes with an explicit error', async t => {
  const file = temporary(t);
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, '{bad data');
  const errors = [];
  const board = createLeaderboard({ file, onError: message => errors.push(message) });
  assert.equal(board.snapshot().available, false);
  assert.equal(board.snapshot().storage, 'error');
  assert.equal(board.record('test', 100, 'survival'), false);
  await board.flush();
  assert.equal(fs.readFileSync(file, 'utf8'), '{bad data');
  assert.equal(errors.length, 1);
});

test('failed leaderboard save keeps memory record and permits explicit retry', async t => {
  const file = temporary(t);
  fs.writeFileSync(path.dirname(file), 'not a directory');
  const errors = [];
  const board = createLeaderboard({ file, onError: message => errors.push(message) });
  // ENOTDIR at load is deliberately read-only, so simulate failure after load.
  assert.equal(board.snapshot().available, false);
  fs.unlinkSync(path.dirname(file));
  const writable = createLeaderboard({ file, onError: message => errors.push(message) });
  writable.record('玩家', 500, 'survival');
  fs.writeFileSync(path.dirname(file), 'blocked');
  assert.equal(await writable.flush(), false);
  assert.equal(writable.snapshot().entries[0].score, 500);
  assert.equal(writable.snapshot().storage, 'error');
  fs.unlinkSync(path.dirname(file));
  assert.equal(await writable.flush(), true);
  assert.equal(writable.snapshot().storage, 'saved');
  assert.equal(JSON.parse(fs.readFileSync(file)).entries[0].score, 500);
});
