'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Rules = require('../public/rules');
const { createGame, act, enqueueGarbage, cancelGarbage, collides } = require('../game');
const Match = require('../match');

function fixture(settings = {}, count = 4) {
  const room = { settings: { ...Rules.defaults, ...settings }, players: new Map(), status: 'lobby' };
  for (let i = 0; i < count; i++) room.players.set(String(i), {
    id: String(i), name: `玩家${i}`, order: i, team: i % 2 ? 'blue' : 'red', ws: {}, ready: true,
  });
  Match.beginMatch(room, 42, 1000, 0);
  Match.advanceMatch(room, 1000);
  return room;
}
function setupClear(game, count, garbage = false) {
  game.board = Array.from({ length: 20 }, () => Array(10).fill(null));
  for (let y = 20 - count; y < 20; y++) game.board[y] = Array.from({ length: 10 }, (_, x) => x === 4 ? null : garbage ? 'G' : 'J');
  game.active = { type: 'I', matrix: [[1], [1], [1], [1]], x: 4, y: 0 };
}

for (const mode of Object.keys(Rules.attacks)) {
  test(`${mode}: attack routing excludes self, dead players and teammates`, () => {
    const room = fixture({ attack: mode, mode: 'teams' }, 6);
    const self = room.players.get('0');
    room.players.get('1').game.alive = false;
    room.bountyId = '2'; // Teammate bounty must not cause friendly fire.
    self.targetId = '2';
    const result = Match.routeAttack(room, self, 4, () => 0);
    assert.ok(result.length);
    for (const item of result) {
      assert.ok(['3', '5'].includes(item.player.id));
      assert.ok(item.lines > 0);
    }
    assert.equal(result.reduce((sum, item) => sum + item.lines, 0), mode === 'all' ? 8 : 4);
  });
}

test('metrics distinguish total cleared lines from physical stack height', () => {
  const room = fixture();
  const [self, a, b, c] = [...room.players.values()];
  a.game.lines = 1; b.game.lines = 20; c.game.lines = 10;
  a.game.board[2][0] = 'J'; b.game.board[18][0] = 'J'; c.game.board[10][0] = 'J';
  for (const [mode, expected] of [['lowest', a], ['leader', b], ['emptiest', b], ['highest', a]]) {
    room.settings.attack = mode;
    assert.equal(Match.routeAttack(room, self, 3)[0].player, expected);
  }
});

test('ties and random attacks use the injected random source', () => {
  const room = fixture({ attack: 'lowest' });
  const self = room.players.get('0');
  assert.equal(Match.routeAttack(room, self, 1, () => 0)[0].player.id, '1');
  assert.equal(Match.routeAttack(room, self, 1, () => 0.99)[0].player.id, '3');
  room.settings.attack = 'random';
  assert.equal(Match.routeAttack(room, self, 1, () => 0.5)[0].player.id, '2');
});

test('round-robin continues correctly after a target leaves', () => {
  const room = fixture({ attack: 'round' });
  const self = room.players.get('0');
  assert.equal(Match.routeAttack(room, self, 2)[0].player.id, '1');
  room.players.delete('1');
  assert.equal(Match.routeAttack(room, self, 2)[0].player.id, '2');
  assert.equal(Match.routeAttack(room, self, 2)[0].player.id, '3');
  assert.equal(Match.routeAttack(room, self, 2)[0].player.id, '2');
});

test('split allocates one row at a time and keeps cursor between attacks', () => {
  const room = fixture({ attack: 'split' });
  const self = room.players.get('0');
  assert.deepEqual(Match.routeAttack(room, self, 4).map(item => [item.player.id, item.lines]), [['1', 2], ['2', 1], ['3', 1]]);
  assert.equal(Match.routeAttack(room, self, 1)[0].player.id, '2');
});

test('bounty rotates at twenty seconds and immediately after elimination', () => {
  const room = fixture({ attack: 'bounty' });
  assert.equal(room.bountyId, '0');
  assert.equal(Match.routeAttack(room, room.players.get('1'), 1)[0].player.id, '0');
  assert.notEqual(Match.routeAttack(room, room.players.get('0'), 1)[0].player.id, '0');
  Match.advanceMatch(room, 20999);
  assert.equal(room.bountyId, '0');
  Match.advanceMatch(room, 21000);
  assert.equal(room.bountyId, '1');
  room.players.get('1').game.alive = false;
  Match.advanceMatch(room, 21001);
  assert.equal(room.bountyId, '2');
});

test('no routing to eliminated players and no attacks in practice', () => {
  const room = fixture({ mode: 'practice' });
  assert.deepEqual(Match.routeAttack(room, room.players.get('0'), 4), []);
  room.settings.mode = 'survival';
  for (const player of room.players.values()) if (player.id !== '0') player.game.alive = false;
  assert.deepEqual(Match.routeAttack(room, room.players.get('0'), 4), []);
});

test('counter cancels pending garbage before ready garbage is applied', () => {
  const game = createGame(42, { buffer: false });
  setupClear(game, 2);
  enqueueGarbage(game, 3, 1000);
  const result = act(game, 'drop', 1000);
  assert.equal(result.attack, 0);
  assert.equal(result.cancelled, 2);
  assert.equal(game.received, 1);
  assert.equal(game.pending, 0);
  assert.equal(game.board[19].filter(cell => cell === 'G').length, 9);
});

test('buffer protects new packets for two seconds and cancellation works FIFO', () => {
  const game = createGame(42);
  enqueueGarbage(game, 3, 1000);
  enqueueGarbage(game, 4, 1500);
  assert.equal(cancelGarbage(game, 4), 4);
  assert.equal(game.garbage.length, 1);
  assert.equal(game.garbage[0].readyAt, 3500);
  act(game, 'drop', 3499);
  assert.equal(game.received, 0);
  assert.equal(game.pending, 3);
  act(game, 'drop', 3500);
  assert.equal(game.received, 3);
  assert.equal(game.pending, 0);
});

test('counter affects unready packets and only the remainder becomes attack', () => {
  const game = createGame(42);
  setupClear(game, 4);
  enqueueGarbage(game, 2, 1000);
  const result = act(game, 'drop', 1001);
  assert.equal(result.attack, 2);
  assert.equal(game.cancelled, 2);
  assert.equal(game.received, 0);
});

test('digging gray rows clears them normally and grants defense-only bonus', () => {
  const game = createGame(42, { digBonus: true, counter: false });
  setupClear(game, 2, true);
  enqueueGarbage(game, 3, 1000);
  const result = act(game, 'drop', 1000);
  assert.equal(game.dug, 2);
  assert.equal(game.lines, 2);
  assert.equal(result.attack, 2);
  assert.equal(result.cancelled, 2);
  assert.equal(game.pending, 1);
});

test('combos add at most three attack rows and reset on a miss', () => {
  const game = createGame(42, { combo: true });
  for (let i = 0; i < 6; i++) {
    setupClear(game, 1);
    assert.equal(act(game, 'drop').attack, 1 + Math.min(i, 3));
  }
  act(game, 'drop');
  assert.equal(game.combo, 0);
  setupClear(game, 1);
  assert.equal(act(game, 'drop').attack, 1);
});

test('cleanse is queued, removes bottommost garbage rows and does not farm score', () => {
  const game = createGame(42);
  game.energy = 12;
  for (const y of [10, 15, 19]) game.board[y][0] = 'G';
  const before = JSON.stringify(game.board);
  assert.equal(act(game, 'cleanse').changed, true);
  assert.equal(JSON.stringify(game.board), before);
  assert.equal(game.energy, 12);
  const result = act(game, 'drop');
  assert.equal(result.purified, 2);
  assert.equal(result.cleared, 0);
  assert.equal(result.attack, 0);
  assert.equal(game.purified, 2);
  assert.equal(game.lines, 0);
  assert.equal(game.energy, 6);
  assert.equal(game.cleanseQueued, false);
  assert.equal(game.board.filter(row => row.includes('G')).length, 1);
  assert.equal(game.board.length, 20);
  assert.equal(collides(game), false);
});

test('cleanse fallback cancels queued attacks and empty targets spend no energy', () => {
  const game = createGame(42);
  game.energy = 6;
  act(game, 'cleanse');
  act(game, 'drop');
  assert.equal(game.energy, 6);
  assert.equal(game.cleanseQueued, false);
  enqueueGarbage(game, 3, Date.now() + 10000);
  act(game, 'cleanse');
  act(game, 'drop');
  assert.equal(game.energy, 0);
  assert.equal(game.pending, 1);
  assert.equal(game.cancelled, 2);
});

test('energy caps at twelve and cleanse cannot be used when disabled or dead', () => {
  const game = createGame(42);
  for (let i = 0; i < 4; i++) { setupClear(game, 4); act(game, 'drop'); }
  assert.equal(game.energy, 12);
  game.alive = false;
  assert.equal(act(game, 'cleanse').changed, false);
  const disabled = createGame(42, { cleanse: false });
  setupClear(disabled, 4); act(disabled, 'drop');
  assert.equal(disabled.energy, 0);
  assert.equal(act(disabled, 'cleanse').changed, false);
});

test('cleanse executes before ready garbage and cannot revive a topped-out piece', () => {
  const game = createGame(42, { buffer: false });
  game.energy = 6;
  game.board[19][0] = 'G';
  game.board[0][0] = 'J';
  act(game, 'cleanse');
  enqueueGarbage(game, 1, 1000);
  act(game, 'drop', 1000);
  assert.equal(game.alive, true);
  assert.equal(game.received, 1);
  game.active = { type: 'O', matrix: [[1, 1], [1, 1]], x: 4, y: -1 };
  game.board[1][4] = 'G';
  game.energy = 6;
  act(game, 'cleanse');
  act(game, 'drop', 1000);
  assert.equal(game.alive, false);
});

test('all settings strictly validated', () => {
  for (const mode of Object.keys(Rules.modes)) assert.equal(Rules.validate(Rules.defaults, { mode }).mode, mode);
  for (const attack of Object.keys(Rules.attacks)) assert.equal(Rules.validate(Rules.defaults, { attack }).attack, attack);
  for (const patch of [null, [], {}, { mode: 'invalid' }, { duration: -1 }, { goal: 1 }, { counter: 'yes' }, { cheat: true }, { mode: { toString: null } }, { attack: ['all'] }]) {
    assert.equal(Rules.validate(Rules.defaults, patch), null);
  }
});

test('start conditions and balanced team sizes', () => {
  const room = fixture({ mode: 'teams' });
  assert.equal(Match.startError(room), null);
  room.players.get('1').team = 'red';
  assert.match(Match.startError(room), /人数/);
  const single = fixture({ mode: 'practice' }, 1);
  assert.equal(Match.startError(single), null);
  single.settings.mode = 'survival';
  assert.match(Match.startError(single), /2/);
});

for (const mode of ['survival', 'sprint', 'battle', 'timed']) {
  test(`${mode}: last survivor wins and all-eliminated state finishes`, () => {
    const room = fixture({ mode });
    for (const player of room.players.values()) if (player.id !== '0') player.game.alive = false;
    Match.recordEliminations(room);
    assert.equal(Match.evaluateMatch(room, 1001), true);
    assert.deepEqual(room.outcome.winnerIds, ['0']);
    assert.equal(room.players.get('0').rank, 1);
    const empty = fixture({ mode });
    for (const player of empty.players.values()) player.game.alive = false;
    Match.recordEliminations(empty);
    assert.equal(Match.evaluateMatch(empty, 1001), true);
    assert.deepEqual(empty.outcome.winnerIds, []);
  });
}

test('timed mode deadline prioritizes survival, then lines and score, ties share rank', () => {
  const room = fixture({ mode: 'timed', duration: 60 });
  room.players.get('3').game.lines = 99;
  room.players.get('3').game.alive = false;
  room.players.get('0').game.lines = 10;
  room.players.get('1').game.lines = 10;
  Match.recordEliminations(room);
  assert.equal(Match.evaluateMatch(room, 60999), false);
  assert.equal(Match.evaluateMatch(room, 61000), true);
  assert.deepEqual(room.outcome.winnerIds, ['0', '1']);
  assert.deepEqual(room.outcome.results.map(player => player.rank), [1, 1, 3, 4]);
});

test('sprint resolves on goal and rejects eliminated goal achievers', () => {
  const room = fixture({ mode: 'sprint', goal: 20 });
  room.players.get('2').game.lines = 20;
  room.players.get('2').game.alive = false;
  assert.equal(Match.evaluateMatch(room, 1001), false);
  room.players.get('1').game.lines = 20;
  assert.equal(Match.evaluateMatch(room, 1002), true);
  assert.deepEqual(room.outcome.winnerIds, ['1']);
});

test('teams win as a team including already eliminated teammates', () => {
  const room = fixture({ mode: 'teams' }, 6);
  for (const player of room.players.values()) player.game.alive = player.id === '0' || player.id === '2';
  Match.recordEliminations(room);
  assert.equal(Match.evaluateMatch(room, 1001), true);
  assert.equal(room.outcome.winningTeam, 'red');
  assert.deepEqual(room.outcome.winnerIds, ['0', '2', '4']);
  assert.ok(room.outcome.results.filter(player => player.team === 'red').every(player => player.rank === 1));
});

test('battle queues environment garbage at thirty-second intervals only', () => {
  const room = fixture({ mode: 'battle' });
  Match.advanceMatch(room, 30999);
  assert.equal(room.players.get('0').game.pending, 0);
  Match.advanceMatch(room, 31000);
  assert.equal(room.players.get('0').game.pending, 1);
  Match.advanceMatch(room, 31000);
  assert.equal(room.players.get('0').game.pending, 1);
  Match.advanceMatch(room, 91000);
  assert.equal(room.players.get('0').game.pending, 3);
});

test('practice continues with one survivor and can be ended manually', () => {
  const room = fixture({ mode: 'practice' }, 2);
  room.players.get('1').game.alive = false;
  assert.equal(Match.evaluateMatch(room, 1000), false);
  setupClear(room.players.get('0').game, 4);
  assert.equal(act(room.players.get('0').game, 'drop').attack, 0);
  Match.complete(room, '房主结束练习', [], null, true);
  assert.equal(room.status, 'finished');
  const alone = fixture({ mode: 'practice' }, 1);
  alone.players.get('0').game.alive = false;
  assert.equal(Match.evaluateMatch(alone, 1000), true);
});

test('new round resets garbage, energy, outcome, target cursors and timers', () => {
  const room = fixture({ mode: 'battle' });
  room.players.get('0').game.energy = 12;
  enqueueGarbage(room.players.get('0').game, 10);
  room.outcome = { reason: 'old' };
  room.settings.mode = 'practice';
  Match.beginMatch(room, 7, 2000, 100);
  const game = room.players.get('0').game;
  assert.equal(game.energy, 0);
  assert.equal(game.pending, 0);
  assert.equal(room.nextEnvironmentAt, null);
  assert.equal(room.bountyId, null);
  assert.equal(room.outcome, null);
  assert.equal(room.startsAt, 2100);
});
