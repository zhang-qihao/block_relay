'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Bomb = require('../bomb');
const Match = require('../match');
const Rules = require('../public/rules');
const { createGame, explodeGarbage, collides, act } = require('../game');

function fixture(count = 3) {
  const room = { settings: { ...Rules.defaults, hotPotato: true }, players: new Map(), status: 'lobby' };
  for (let i = 0; i < count; i++) room.players.set(String(i), { id: String(i), name: `玩家${i}`, order: i, ws: {}, ready: true });
  Match.beginMatch(room, 42, 1000, 0);
  Match.advanceMatch(room, 1000);
  Bomb.advance(room, 1000, () => 0);
  return room;
}
test('hot potato is opt-in across base modes without replacing their victory rules', () => {
  assert.equal(Rules.presets.bomb, undefined);
  assert.equal(Rules.modes.bomb, undefined);
  for (const mode of Object.keys(Rules.modes)) {
    const room = fixture();
    room.settings.mode = mode;
    room.settings.hotPotato = false;
    room.bomb = null;
    assert.equal(Bomb.advance(room, 1100), null);
    assert.equal(room.bomb, null);
    room.settings.hotPotato = true;
    Bomb.advance(room, 1200, () => 0);
    assert.equal(room.bomb.holderId, '0');
    assert.equal(room.settings.mode, mode);
  }
  const room = fixture();
  room.settings.mode = 'practice';
  room.players.get('1').game.alive = false;
  room.players.get('2').game.alive = false;
  room.dirty = false;
  Bomb.advance(room, 1300);
  assert.equal(room.bomb, null);
  assert.equal(room.dirty, true);
  assert.equal(Match.evaluateMatch(room, 1300), false);
});

test('flash intervals accelerate monotonically and random fuse changes acceleration speed', () => {
  function intervals(rngValue) {
    const room = fixture();
    room.bomb = null;
    Bomb.advance(room, 1000, () => rngValue);
    const periods = [];
    while (room.bomb.nextBlinkAt < room.bomb.explodesAt) {
      const now = room.bomb.nextBlinkAt;
      Bomb.advance(room, now, () => .99);
      periods.push(room.bomb.nextBlinkAt - now);
      Bomb.advance(room, room.bomb.litUntil, () => 0);
    }
    assert.ok(periods.length > 5);
    assert.ok(periods.every((period, i) => period >= 400 && period <= 1400 && (!i || period < periods[i - 1])));
    return periods;
  }
  assert.notDeepEqual(intervals(0), intervals(.9));
});

test('new bombs can choose different survivors but never the explosion victim', () => {
  for (const value of [0, .99]) {
    const room = fixture();
    Bomb.advance(room, room.bomb.explodesAt, () => value);
    assert.equal(room.bomb.holderId, value === 0 ? '1' : '2');
    assert.equal(room.bomb.cleared, 0);
  }
});

test('bomb snapshots hide random fuse and flash schedule while sharing current holder', () => {
  const room = fixture();
  assert.deepEqual(Bomb.snapshot(room), { holderId: '0', cleared: 0, lit: false });
  const firstFuse = room.bomb.explodesAt;
  room.bomb = null;
  Bomb.advance(room, 1000, () => .5);
  assert.notEqual(room.bomb.explodesAt, firstFuse);
  const pulseAt = room.bomb.nextBlinkAt;
  Bomb.advance(room, pulseAt, () => .2);
  assert.equal(Bomb.snapshot(room).lit, true);
  const interval1 = room.bomb.nextBlinkAt - pulseAt;
  Bomb.advance(room, room.bomb.litUntil, () => .8);
  assert.equal(Bomb.snapshot(room).lit, false);
  const nextPulse = room.bomb.nextBlinkAt;
  Bomb.advance(room, nextPulse, () => .8);
  assert.ok(room.bomb.nextBlinkAt - nextPulse < interval1);
  assert.deepEqual(Object.keys(Bomb.snapshot(room)).sort(), ['cleared', 'holderId', 'lit']);
});
test('one clear unlock voluntary passing without resetting the fuse', () => {
  const room = fixture();
  const a = room.players.get('0'), b = room.players.get('1');
  const fuse = room.bomb.explodesAt;
  Bomb.credit(room, b, 4);
  assert.equal(Bomb.pass(room, a, 1100), null);
  Bomb.credit(room, a, 1);
  assert.equal(room.bomb.holderId, a.id);
  assert.equal(Bomb.pass(room, b, 1100), null);
  assert.equal(Bomb.pass(room, a, 1100), b);
  assert.equal(room.bomb.cleared, 0);
  assert.equal(room.bomb.explodesAt, fuse);
  Bomb.credit(room, b, 4);
  assert.equal(room.bomb.cleared, 1);
  assert.equal(Bomb.pass(room, b, fuse), null);
});
test('explosion inserts exactly one row immediately and randomly respawns on another survivor', () => {
  const room = fixture();
  const victim = room.players.get('0');
  victim.game.active.y = 8;
  victim.game.energy = 12;
  victim.game.cleanseQueued = true;
  const oldFuse = room.bomb.explodesAt;
  const effect = Bomb.advance(room, oldFuse, () => .5);
  assert.deepEqual(effect, { kind: 'bomb', at: oldFuse, targetId: '0', targetName: '玩家0', lines: 1 });
  assert.equal(victim.game.received, 1);
  assert.equal(victim.game.pending, 0);
  assert.equal(victim.game.active.y, 7);
  assert.equal(victim.game.board.filter(row => row.includes('G')).length, 1);
  assert.equal(room.bomb.holderId, '2');
  assert.equal(room.bomb.cleared, 0);
  assert.ok(room.bomb.explodesAt > oldFuse);
  assert.equal(Bomb.advance(room, oldFuse, () => .5), null);
  assert.equal(collides(victim.game), false);
  assert.doesNotThrow(() => act(victim.game, 'drop', oldFuse));
});
test('death and departure move the bomb, and the last survivor ends the mode', () => {
  const room = fixture();
  room.players.get('0').game.board[0][0] = 'J';
  Bomb.advance(room, room.bomb.explodesAt, () => 0);
  assert.equal(room.players.get('0').game.alive, false);
  assert.equal(room.bomb.holderId, '1');
  room.players.delete('1');
  Bomb.advance(room, 50000);
  assert.equal(room.bomb, null);
  assert.equal(Match.evaluateMatch(room, 50000), true);
  assert.equal(Bomb.snapshot(room), null);
  Match.beginMatch(room, 10, 60000, 5000);
  assert.equal(room.bomb, null);
  assert.equal(Bomb.advance(room, 60000), null);
});
test('departed holder passes existing fuse to next living player', () => {
  const room = fixture(4);
  const fuse = room.bomb.explodesAt;
  room.players.delete('0');
  room.players.get('1').game.alive = false;
  Bomb.advance(room, 1100);
  assert.equal(room.bomb.holderId, '2');
  assert.equal(room.bomb.explodesAt, fuse);
});
test('explosion does not touch already eliminated players or reset lock timers', () => {
  const game = createGame(42);
  game.lockTime = 300; game.lockResets = 8;
  explodeGarbage(game);
  assert.equal(game.lockTime, 300);
  assert.equal(game.lockResets, 8);
  assert.equal(collides(game), false);
  game.alive = false;
  explodeGarbage(game);
  assert.equal(game.received, 3);
});
