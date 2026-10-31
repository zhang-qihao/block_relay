'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createGame, snapshotGame, act, collides, SHAPES, WIDTH, HEIGHT } = require('../game');
const { levels, plan, reactionReady } = require('../bot');

function gameFor(type = 'T') {
  const game = createGame(123, { mode: 'practice', cleanse: false });
  game.active = { type, matrix: SHAPES[type].map(row => row.slice()), x: Math.floor((WIDTH - SHAPES[type].length) / 2), y: 0 };
  return game;
}
function execute(game, actions) {
  assert.ok(actions.length > 0 && actions.length <= 38);
  assert.equal(actions.at(-1), 'drop');
  assert.equal(actions.filter(action => action === 'drop').length, 1);
  for (const [index, action] of actions.entries()) {
    assert.ok(['left', 'right', 'rotate', 'rotateBack', 'down', 'drop', 'hold'].includes(action));
    const result = act(game, action, 0);
    assert.equal(result.changed, true, `illegal action ${index}: ${actions.join(' ')}`);
    if (index < actions.length - 1) { assert.equal(game.alive, true); assert.equal(collides(game), false); }
  }
  return game;
}
function holes(board) {
  let result = 0;
  for (let x = 0; x < WIDTH; x++) {
    let covered = false;
    for (const row of board) { if (row[x]) covered = true; else if (covered) result++; }
  }
  return result;
}
function well(game, count = 4, x = 0, width = 1, cell = 'G') {
  for (let y = HEIGHT - count; y < HEIGHT; y++) {
    game.board[y] = Array.from({ length: WIDTH }, (_, col) => col >= x && col < x + width ? null : cell);
  }
}
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}

test('easy and normal sometimes select legal suboptimal placements while hard stays precise', () => {
  for (const level of ['easy', 'normal']) {
    const snapshot = snapshotGame(gameFor('T'));
    const best = plan(snapshot, {}, level, .99);
    const alternatives = [0.05, .1, .2].map(choice => plan(snapshot, {}, level, choice));
    assert.ok(alternatives.some(actions => JSON.stringify(actions) !== JSON.stringify(best)), level);
    for (const actions of alternatives) execute(gameFor('T'), actions);
    assert.deepEqual(plan(snapshot, {}, level, .1), plan(snapshot, {}, level, .1));
  }
  const snapshot = snapshotGame(gameFor('T'));
  assert.deepEqual(plan(snapshot, {}, 'hard', .1), plan(snapshot, {}, 'hard', .99));
  assert.ok(levels.easy.pieceDelay > levels.normal.pieceDelay);
  assert.equal(levels.hard.pieceDelay, 0);
});

test('reaction delay requires continuous eligibility and resets after passing or relief', () => {
  const state = {};
  assert.equal(reactionReady(state, 'bomb', true, 1000, 1400), false);
  assert.equal(reactionReady(state, 'bomb', true, 2399, 1400), false);
  assert.equal(reactionReady(state, 'bomb', true, 2400, 1400), true);
  assert.equal(reactionReady(state, 'bomb', false, 2500, 1400), false);
  assert.equal(reactionReady(state, 'bomb', true, 2600, 1400), false);
  assert.equal(reactionReady(state, 'hard', true, 1000, 0), true);
});

test('bot exposes ordered difficulties and defaults to normal', () => {
  assert.deepEqual(Object.values(levels).map(level => level.label), ['简单', '普通', '困难']);
  assert.ok(levels.easy.interval > levels.normal.interval && levels.normal.interval > levels.hard.interval);
  assert.ok(levels.hard.interval >= 50);
  const game = gameFor();
  assert.deepEqual(plan(snapshotGame(game), game.settings), plan(snapshotGame(game), game.settings, 'normal'));
  assert.deepEqual(plan(snapshotGame(game), game.settings, 'invalid'), plan(snapshotGame(game), game.settings, 'normal'));
});

for (const level of Object.keys(levels)) {
  for (const type of Object.keys(SHAPES)) {
    test(`${level} returns a legal drop path for ${type}`, () => {
      const game = gameFor(type);
      game.holdUsed = true;
      const result = execute(game, plan(snapshotGame(game), game.settings, level));
      assert.equal(result.alive, true);
      assert.equal(result.board.flat().filter(Boolean).length, 4);
    });
  }
}

test('planning never mutates frozen snapshots/settings or reads hidden state/RNG', () => {
  const game = gameFor('S');
  const snapshot = snapshotGame(game), before = JSON.stringify(snapshot);
  for (const hidden of ['queue', 'random', 'garbageRandom', 'garbage', 'fuse', 'explodesAt']) {
    Object.defineProperty(snapshot, hidden, { get() { throw new Error(`read hidden ${hidden}`); } });
  }
  freeze(snapshot); freeze(game.settings);
  const random = Math.random;
  Math.random = () => { throw new Error('planning used randomness'); };
  try {
    for (const level of Object.keys(levels)) {
      assert.deepEqual(plan(snapshot, game.settings, level), plan(snapshot, game.settings, level));
    }
  } finally { Math.random = random; }
  assert.equal(JSON.stringify(snapshot), before);
});

test('easy ignores preview/hold and avoids creating holes', () => {
  const game = gameFor('O');
  for (let y = 18; y < 20; y++) { game.board[y][0] = 'J'; game.board[y][1] = 'J'; }
  const snapshot = snapshotGame(game);
  const actions = plan(snapshot, game.settings, 'easy');
  assert.ok(!actions.includes('hold'));
  snapshot.next = ['I', 'Z', 'T']; snapshot.hold = 'I';
  assert.deepEqual(plan(snapshot, game.settings, 'easy'), actions);
  execute(game, actions);
  assert.equal(holes(game.board), 0);
  assert.ok(game.board.slice(0, 18).every(row => row.every(cell => !cell)), 'prefer filling low ground over building a tower');
});

for (const level of Object.keys(levels)) {
  test(`${level} clears four rows and digs visible garbage`, () => {
    const game = gameFor('I');
    game.settings.mode = 'dig'; game.holdUsed = true;
    well(game);
    execute(game, plan(snapshotGame(game), game.settings, level));
    assert.equal(game.lines, 4);
    assert.equal(game.dug, 4);
    assert.equal(game.board.flat().filter(Boolean).length, 0);
  });
  test(`${level} survives a high stack by clearing the open channel`, () => {
    const game = gameFor('O');
    game.holdUsed = true;
    well(game, 16, 4, 2, 'J');
    execute(game, plan(snapshotGame(game), game.settings, level));
    assert.equal(game.alive, true);
    assert.equal(game.lines, 2);
    assert.equal(holes(game.board), 0);
  });
}

for (const held of ['I', null]) {
  test(`normal/hard may hold ${held ? 'a stored piece' : 'using the visible next piece'}`, () => {
    for (const level of ['normal', 'hard']) {
      const game = gameFor('O');
      game.hold = held; game.queue[0] = 'I';
      game.settings.mode = 'dig'; well(game);
      const actions = plan(snapshotGame(game), game.settings, level);
      assert.equal(actions[0], 'hold');
      execute(game, actions);
      assert.equal(game.dug, 4);
    }
  });
}

test('holdUsed prevents all hold actions, including on a nearly topped-out board', () => {
  for (const level of ['normal', 'hard']) {
    const game = gameFor('O');
    game.hold = 'I'; game.holdUsed = true; well(game, 16, 0);
    const actions = plan(snapshotGame(game), game.settings, level);
    assert.ok(!actions.includes('hold'));
    execute(game, actions);
  }
});

test('missing visible previews are not filled from hidden queue or RNG', () => {
  const game = gameFor('T');
  const snapshot = snapshotGame(game);
  snapshot.next = []; snapshot.hold = null;
  assert.ok(!plan(snapshot, game.settings, 'hard').includes('hold'));
  execute(game, plan(snapshot, game.settings, 'hard'));
});

test('legal paths start from mid-fall, wall-kicked, and above-board positions', () => {
  for (const type of Object.keys(SHAPES)) {
    const game = gameFor(type);
    for (let i = 0; i < 8; i++) act(game, 'left');
    act(game, 'rotate');
    for (let i = 0; i < 12; i++) act(game, 'down');
    game.holdUsed = true;
    execute(game, plan(snapshotGame(game), game.settings, 'hard'));
    assert.equal(game.alive, true);
    const raised = gameFor(type);
    raised.active.y = -3; raised.holdUsed = true;
    execute(raised, plan(snapshotGame(raised), raised.settings, 'normal'));
    assert.equal(raised.alive, true);
  }
});

test('hard lookahead sacrifices the greedy placement to clear with the next I', () => {
  const heights = [2, 1, 4, 3, 0, 3, 2, 3, 0, 1];
  const results = {};
  for (const level of ['easy', 'hard']) {
    const game = gameFor('T');
    game.holdUsed = true; game.hold = 'I'; game.queue[0] = 'I';
    for (let x = 0; x < WIDTH; x++) for (let y = HEIGHT - heights[x]; y < HEIGHT; y++) game.board[y][x] = 'J';
    const actions = plan(snapshotGame(game), game.settings, level);
    assert.ok(!actions.includes('hold'));
    execute(game, actions);
    assert.equal(game.lines, 0, 'neither first move clears immediately');
    game.holdUsed = true;
    execute(game, plan(snapshotGame(game), game.settings, 'easy'));
    results[level] = { actions, lines: game.lines, holes: holes(game.board) };
  }
  assert.notDeepEqual(results.hard.actions, results.easy.actions);
  assert.equal(results.easy.lines, 0);
  assert.equal(results.hard.lines, 1);
  assert.equal(results.hard.holes, 0);
});

test('BFS can descend then slide beneath an overhang to clear a row', () => {
  const game = gameFor('O');
  game.holdUsed = true;
  game.board[16][0] = game.board[16][1] = 'J';
  game.board[19] = Array.from({ length: WIDTH }, (_, x) => x < 2 ? null : 'J');
  const actions = plan(snapshotGame(game), game.settings, 'easy');
  assert.ok(actions.includes('down'), 'tuck requires movement after descending');
  execute(game, actions);
  assert.equal(game.lines, 1);
});

test('dead or malformed snapshots do not yield moves', () => {
  assert.deepEqual(plan(null), []);
  const snapshot = snapshotGame(gameFor());
  assert.deepEqual(plan({ ...snapshot, alive: false }), []);
  assert.deepEqual(plan({ ...snapshot, active: null }), []);
  assert.deepEqual(plan({ ...snapshot, active: { ...snapshot.active, y: -1000000 } }), []);
});

test('bounded planning performance on empty, rough, high and dig boards', t => {
  const samples = [];
  for (let i = 0; i < 12; i++) {
    const game = gameFor(Object.keys(SHAPES)[i % 7]);
    game.hold = i % 2 ? 'I' : null;
    if (i % 4 === 1) {
      for (let x = 0; x < WIDTH; x++) for (let y = HEIGHT - (x * 3 % 7); y < HEIGHT; y++) game.board[y][x] = 'J';
    }
    if (i % 4 === 2) well(game, 15, 3, 4, 'J');
    if (i % 4 === 3) { well(game, 8); game.settings.mode = 'dig'; }
    samples.push(game);
  }
  for (const level of Object.keys(levels)) {
    for (const game of samples) plan(snapshotGame(game), game.settings, level);
    const times = [];
    for (let run = 0; run < 3; run++) for (const game of samples) {
      const start = performance.now();
      const actions = plan(snapshotGame(game), game.settings, level);
      times.push(performance.now() - start);
      assert.equal(actions.at(-1), 'drop');
    }
    times.sort((a, b) => a - b);
    const average = times.reduce((sum, time) => sum + time, 0) / times.length;
    t.diagnostic(`${level}: mean ${average.toFixed(2)}ms, p95 ${times[Math.floor(times.length * .95)].toFixed(2)}ms, max ${times.at(-1).toFixed(2)}ms (${times.length} plans)`);
    assert.ok(average < 60, `${level} exceeds reasonable per-plan budget: ${average}ms`);
    assert.ok(times.at(-1) < 250, `${level} individual search stalled: ${times.at(-1)}ms`);
  }
});
