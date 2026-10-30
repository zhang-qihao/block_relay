'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Rules = require('../public/rules');
const Match = require('../match');
const { createGame, act, tickGame, enqueueGarbage, snapshotGame } = require('../game');

function roomFor(mode, count = 2, settings = {}) {
  const room = { settings: Rules.normalize({ ...Rules.defaults, mode, ...settings }), players: new Map() };
  for (let i = 0; i < count; i++) room.players.set(String(i), { id: String(i), name: `玩家${i}`, order: i, team: i % 2 ? 'blue' : 'red', ready: true, ws: {} });
  Match.beginMatch(room, 42, 1000, 0);
  Match.advanceMatch(room, 1000);
  return room;
}

test('alternating rotation cannot stall a grounded piece past the reset budget', () => {
  const game = createGame(1);
  game.active = { type: 'I', matrix: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]], x: 3, y: 18 };
  let locked = false;
  for (let i = 0; i < 1200; i++) {
    act(game, i % 2 ? 'rotateBack' : 'rotate', i * 50);
    if (tickGame(game, 50, i * 50).locked) { locked = true; break; }
  }
  assert.equal(locked, true, 'previously stalled for 60 seconds indefinitely');
});

test('same-batch eliminations have tied places, no phantom survivor', () => {
  const room = roomFor('survival', 3);
  room.players.get('0').game.alive = false;
  Match.recordEliminations(room);
  assert.equal(room.players.get('0').rank, 3);
  room.players.get('1').game.alive = false;
  room.players.get('2').game.alive = false;
  Match.recordEliminations(room);
  assert.equal(Match.evaluateMatch(room, 1001), true);
  assert.deepEqual(room.outcome.winnerIds, []);
  assert.deepEqual(room.outcome.results.map(player => player.rank), [1, 1, 3]);
});

test('same-batch sprint completion shares victory', () => {
  const room = roomFor('sprint', 3);
  room.players.get('0').game.lines = 40;
  room.players.get('1').game.lines = 40;
  Match.evaluateMatch(room, 1001);
  assert.deepEqual(room.outcome.winnerIds, ['0', '1']);
});

for (const rows of [4, 8, 12]) {
  test(`dig ${rows}: identical grouped holes, independent seven-bag and forbidden cleanse`, () => {
    const room = roomFor('dig', 2, { digRows: rows, cleanse: true });
    const [a, b] = [...room.players.values()].map(player => player.game);
    assert.deepEqual(a.board, b.board);
    assert.equal(snapshotGame(a).garbageRows, rows);
    assert.equal(a.settings.cleanse, false);
    assert.deepEqual(a.queue, createGame(42).queue);
    assert.equal(a.active.type, createGame(42).active.type);
    const holes = a.board.slice(-rows).map(row => row.indexOf(null));
    for (let i = 0; i < rows; i += 4) assert.equal(new Set(holes.slice(i, i + 4)).size, 1);
    if (rows > 4) assert.notEqual(holes[0], holes[4]);
    assert.deepEqual(Match.routeAttack(room, room.players.get('0'), 4), []);
    a.energy = 12;
    assert.equal(act(a, 'cleanse').changed, false);
  });
}

test('dig challenge continues with one survivor, supports solo completion and all-failed', () => {
  const room = roomFor('dig');
  room.players.get('1').game.alive = false;
  Match.recordEliminations(room);
  assert.equal(Match.evaluateMatch(room, 1001), false);
  room.players.get('0').game.board = Array.from({ length: 20 }, () => Array(10).fill(null));
  assert.equal(Match.evaluateMatch(room, 1002), true);
  assert.deepEqual(room.outcome.winnerIds, ['0']);
  const solo = roomFor('dig', 1);
  assert.equal(Match.startError(solo), null);
  solo.players.get('0').game.alive = false;
  Match.recordEliminations(solo);
  assert.equal(Match.evaluateMatch(solo, 1001), true);
  assert.deepEqual(solo.outcome.winnerIds, []);
});

test('coop rescues only queued garbage, highest pressure first, no friendly fire', () => {
  const room = roomFor('coop', 3);
  const [a, b, c] = [...room.players.values()];
  enqueueGarbage(b.game, 2, 1000);
  enqueueGarbage(c.game, 5, 1000);
  const result = Match.rescue(room, a, 4);
  assert.equal(result.reduce((sum, target) => sum + target.lines, 0), 4);
  assert.equal(a.game.helped, 4);
  assert.equal(b.game.pending + c.game.pending, 3);
  assert.ok(Math.abs(b.game.pending - c.game.pending) <= 1);
  assert.deepEqual(Match.routeAttack(room, a, 4), []);
  Match.rescue(room, a, 100);
  const helped = a.game.helped;
  assert.deepEqual(Match.rescue(room, a, 100), []);
  assert.equal(a.game.helped, helped);
});

test('coop forces self defense before rescue and preserves source metadata on leftovers', () => {
  const game = createGame(42, { mode: 'coop', counter: false });
  assert.equal(game.settings.counter, true);
  game.board[19] = Array.from({ length: 10 }, (_, x) => x === 4 ? null : 'G');
  game.active = { type: 'I', matrix: [[1], [1], [1], [1]], x: 4, y: 0 };
  enqueueGarbage(game, 2, 1000, { sourceName: '守城第 1 波' });
  const result = act(game, 'drop', 1000);
  assert.equal(result.attack, 0);
  assert.equal(game.pending, 1);
  assert.equal(game.garbage[0].sourceName, '守城第 1 波');
});

for (const waves of [3, 5, 8]) {
  test(`coop ${waves} waves: 20s schedule, scaling and final grace period`, () => {
    const room = roomFor('coop', 1, { waves });
    const game = room.players.get('0').game;
    assert.equal(Match.startError(room), null);
    Match.advanceMatch(room, 20999);
    assert.equal(game.pending, 0);
    let total = 0;
    for (let wave = 1; wave <= waves; wave++) {
      Match.advanceMatch(room, 1000 + wave * 20000);
      total += Math.min(4, Math.ceil(wave / 2));
      assert.equal(game.pending, total);
      assert.equal(room.wave, wave);
      assert.equal(Match.evaluateMatch(room, 1000 + wave * 20000), false);
    }
    assert.equal(room.nextWaveAt, null);
    assert.equal(Match.evaluateMatch(room, room.coopEndsAt - 1), false);
    assert.equal(Match.evaluateMatch(room, room.coopEndsAt), true);
    assert.equal(room.outcome.winningTeam, 'coop');
    assert.equal(room.outcome.results[0].rank, 1);
  });
}

test('coop all dead fails even at completion boundary; rematch clears progress', () => {
  const room = roomFor('coop');
  room.coopEndsAt = 5000;
  for (const player of room.players.values()) player.game.alive = false;
  Match.recordEliminations(room);
  Match.evaluateMatch(room, 5000);
  assert.equal(room.outcome.winningTeam, null);
  assert.deepEqual(room.outcome.winnerIds, []);
  Match.beginMatch(room, 43, 6000, 1000);
  assert.equal(room.wave, 0);
  assert.equal(room.coopEndsAt, null);
  assert.equal(room.nextWaveAt, 27000);
  assert.equal(room.outcome, null);
});

test('coop surviving teammate wins for eliminated members and ignores bounty routing', () => {
  const room = roomFor('coop', 3, { attack: 'bounty' });
  room.players.get('0').game.alive = false;
  room.players.get('1').game.alive = false;
  Match.recordEliminations(room);
  Match.advanceMatch(room, 21000);
  assert.equal(room.bountyId, null);
  assert.equal(Match.evaluateMatch(room, 21001), false);
  room.coopEndsAt = 22000;
  Match.evaluateMatch(room, 22000);
  assert.equal(room.outcome.winningTeam, 'coop');
  assert.equal(room.outcome.winnerIds.length, 3);
  assert.ok(room.outcome.results.every(player => player.rank === 1));
});

test('packet-hole setting groups garbage without affecting fair piece sequence', () => {
  const game = createGame(42, { buffer: false });
  const plain = createGame(42);
  enqueueGarbage(game, 4, 1000);
  act(game, 'drop', 1000);
  act(plain, 'drop', 1000);
  assert.equal(new Set(game.board.slice(-4).map(row => row.indexOf(null))).size, 1);
  assert.equal(game.active.type, plain.active.type);
  assert.deepEqual(game.queue, plain.queue);
});

test('all nine presets validate and changing mode enforces non-negotiable rules', () => {
  assert.equal(Object.keys(Rules.presets).length, 9);
  for (const preset of Object.values(Rules.presets)) assert.deepEqual(Rules.validate(Rules.defaults, preset.settings), preset.settings);
  const dig = Rules.validate(Rules.defaults, { mode: 'dig', cleanse: true });
  assert.equal(dig.cleanse, false);
  const coop = Rules.validate(Rules.defaults, { mode: 'coop', counter: false });
  assert.equal(coop.counter, true);
  for (const patch of [{ digRows: 6 }, { waves: 0 }]) assert.equal(Rules.validate(Rules.defaults, patch), null);
});
