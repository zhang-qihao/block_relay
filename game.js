'use strict';

const WIDTH = 10;
const HEIGHT = 20;
const SHAPES = {
  I: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
  J: [[1, 0, 0], [1, 1, 1], [0, 0, 0]],
  L: [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
  O: [[1, 1], [1, 1]],
  S: [[0, 1, 1], [1, 1, 0], [0, 0, 0]],
  T: [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
  Z: [[1, 1, 0], [0, 1, 1], [0, 0, 0]],
};
const TYPES = Object.keys(SHAPES);
const { defaults, normalize } = require('./public/rules');

function enqueueGarbage(game, lines, now = Date.now(), source = {}) {
  if (!game.alive || lines <= 0) return;
  game.garbage.push({ lines, readyAt: now + (game.settings.buffer ? 2000 : 0),
    sourceId: source.sourceId || null, sourceName: source.sourceName || '环境障碍',
    hole: game.settings.packetHole ? Math.floor(game.garbageRandom() * WIDTH) : null });
  game.pending += lines;
}

function explodeGarbage(game, lines = 3) {
  if (!game.alive) return;
  const hole = Math.floor(game.garbageRandom() * WIDTH);
  for (let i = 0; i < lines; i++) {
    if (game.board.shift().some(Boolean)) game.alive = false;
    game.board.push(Array.from({ length: WIDTH }, (_, x) => x === hole ? null : 'G'));
  }
  game.received += lines;
  // Keep the falling piece above the rising stack without resetting its lock delay.
  game.active = { ...game.active, y: game.active.y - lines };
  if (collides(game)) game.alive = false;
}

function cancelGarbage(game, amount) {
  let cancelled = 0;
  while (amount > 0 && game.garbage.length) {
    const packet = game.garbage[0];
    const count = Math.min(amount, packet.lines);
    packet.lines -= count;
    amount -= count;
    cancelled += count;
    if (!packet.lines) game.garbage.shift();
  }
  game.pending -= cancelled;
  game.cancelled += cancelled;
  return cancelled;
}

function cleanseBoard(game) {
  const indices = [];
  for (let y = HEIGHT - 1; y >= 0 && indices.length < 2; y--) {
    if (game.board[y].includes('G')) indices.push(y);
  }
  if (indices.length) {
    game.board = [
      ...Array.from({ length: indices.length }, () => Array(WIDTH).fill(null)),
      ...game.board.filter((_, y) => !indices.includes(y)),
    ];
    game.purified += indices.length;
    return indices.length;
  }
  return cancelGarbage(game, 2);
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function fillQueue(game) {
  while (game.queue.length < 8) {
    const bag = TYPES.slice();
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(game.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    game.queue.push(...bag);
  }
}

function collides(game, piece = game.active) {
  return piece.matrix.some((row, dy) => row.some((cell, dx) => {
    if (!cell) return false;
    const x = piece.x + dx;
    const y = piece.y + dy;
    return x < 0 || x >= WIDTH || y >= HEIGHT || (y >= 0 && Boolean(game.board[y][x]));
  }));
}

function spawn(game, type) {
  fillQueue(game);
  const next = type || game.queue.shift();
  game.active = {
    type: next,
    matrix: SHAPES[next].map(row => row.slice()),
    x: Math.floor((WIDTH - SHAPES[next].length) / 2),
    y: 0,
  };
  game.fallTime = 0;
  game.lockTime = 0;
  game.touchedGround = false;
  game.lockResets = 0;
  fillQueue(game);
  if (collides(game)) game.alive = false;
}

function createGame(seed = Date.now(), settings = defaults) {
  const game = {
    board: Array.from({ length: HEIGHT }, () => Array(WIDTH).fill(null)),
    active: null, queue: [], hold: null, holdUsed: false,
    score: 0, lines: 0, level: 1, sent: 0, received: 0,
    pending: 0, garbage: [], alive: true, fallTime: 0, lockTime: 0, lockResets: 0,
    energy: 0, cleanseQueued: false, combo: 0, dug: 0, cancelled: 0, purified: 0, helped: 0,
    settings: normalize({ ...defaults, ...settings }), random: seededRandom(seed), garbageRandom: seededRandom(seed ^ 0x9e3779b9),
  };
  if (game.settings.mode === 'dig') {
    const layoutRandom = seededRandom(seed ^ 0x51a7);
    for (let i = 0; i < game.settings.digRows; i++) {
      const hole = Math.floor(layoutRandom() * WIDTH);
      game.board.shift();
      game.board.push(Array.from({ length: WIDTH }, (_, x) => x === hole ? null : 'G'));
    }
  }
  spawn(game);
  return game;
}

function grounded(game) {
  return collides(game, { ...game.active, y: game.active.y + 1 });
}

function resetLock(game) {
  game.touchedGround = true;
  if (game.lockResets < 15) {
    game.lockTime = 0;
    game.lockResets++;
  }
}

function lock(game, now = Date.now(), random = Math.random) {
  let aboveTop = false;
  game.active.matrix.forEach((row, dy) => row.forEach((cell, dx) => {
    if (!cell) return;
    const y = game.active.y + dy;
    if (y < 0) aboveTop = true;
    else game.board[y][game.active.x + dx] = game.active.type;
  }));
  if (aboveTop) {
    game.alive = false;
    return { locked: true, cleared: 0, attack: 0 };
  }
  const clearedRows = game.board.flatMap((row, y) => row.every(Boolean) ? [{ y, cells: row.slice() }] : []);
  const full = clearedRows.map(row => row.cells);
  const cleared = full.length;
  const dug = full.filter(row => row.includes('G')).length;
  game.board = [
    ...Array.from({ length: cleared }, () => Array(WIDTH).fill(null)),
    ...game.board.filter(row => !row.every(Boolean)),
  ];
  game.score += [0, 100, 300, 500, 800][cleared] * game.level;
  game.lines += cleared;
  game.dug += dug;
  game.level = 1 + Math.floor(game.lines / 10);
  game.combo = cleared ? game.combo + 1 : 0;
  if (game.settings.cleanse) game.energy = Math.min(12, game.energy + cleared);
  let attack = ['practice', 'dig'].includes(game.settings.mode) ? 0 : cleared +
    (cleared && game.settings.combo ? Math.min(3, game.combo - 1) : 0);
  const cancelledBefore = game.cancelled;
  if (game.settings.counter) attack -= cancelGarbage(game, attack);
  if (game.settings.digBonus) cancelGarbage(game, dug);
  let purified = 0;
  if (game.cleanseQueued) {
    if (game.settings.cleanse && game.energy >= 6) {
      purified = cleanseBoard(game);
      if (purified) game.energy -= 6;
    }
    game.cleanseQueued = false;
  }
  // Defenses resolve before ready garbage is added, always between pieces.
  let incoming = 0;
  const hits = [];
  const incomingHoles = [];
  game.garbage = game.garbage.filter(packet => {
    if (packet.readyAt > now) return true;
    incoming += packet.lines;
    for (let i = 0; i < packet.lines; i++) incomingHoles.push(packet.hole ?? Math.floor(random() * WIDTH));
    hits.push({ sourceId: packet.sourceId, sourceName: packet.sourceName, lines: packet.lines });
    return false;
  });
  game.pending -= incoming;
  for (let i = 0; i < incoming; i++) {
    if (game.board.shift().some(Boolean)) game.alive = false;
    const hole = incomingHoles[i];
    game.board.push(Array.from({ length: WIDTH }, (_, x) => x === hole ? null : 'G'));
  }
  game.received += incoming;
  game.holdUsed = false;
  if (game.alive) spawn(game);
  return { locked: true, cleared, clearedRows, attack: game.settings.mode === 'sprint' ? 0 : attack, dug, purified, hits, incoming,
    cancelled: game.cancelled - cancelledBefore };
}

function act(game, action, now = Date.now()) {
  if (!game.alive) return { changed: false, cleared: 0 };
  let result = { changed: false, cleared: 0 };
  const wasGrounded = grounded(game);
  if (action === 'left' || action === 'right' || action === 'down') {
    const candidate = { ...game.active };
    if (action === 'down') candidate.y++;
    else candidate.x += action === 'left' ? -1 : 1;
    if (!collides(game, candidate)) {
      game.active = candidate;
      if (action === 'down') game.score++;
      else if (wasGrounded) resetLock(game);
      result.changed = true;
    }
  } else if (action === 'rotate' || action === 'rotateBack') {
    const matrix = game.active.matrix;
    const rotated = matrix.map((row, y) => row.map((_, x) =>
      action === 'rotate' ? matrix[matrix.length - 1 - x][y] : matrix[x][matrix.length - 1 - y]));
    for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [-2, 0], [2, 0], [0, -1], [-1, -1], [1, -1], [0, -2]]) {
      const candidate = { ...game.active, matrix: rotated, x: game.active.x + dx, y: game.active.y + dy };
      if (!collides(game, candidate)) {
        game.active = candidate;
        if (wasGrounded) resetLock(game);
        result.changed = true;
        break;
      }
    }
  } else if (action === 'drop') {
    while (!grounded(game)) { game.active.y++; game.score += 2; }
    result = { changed: true, ...lock(game, now) };
  } else if (action === 'cleanse' && game.settings.cleanse && game.energy >= 6 && !game.cleanseQueued) {
    game.cleanseQueued = true;
    result.changed = true;
  } else if (action === 'hold' && !game.holdUsed) {
    const previous = game.hold;
    game.hold = game.active.type;
    spawn(game, previous);
    game.holdUsed = true;
    result.changed = true;
  }
  return result;
}

function tickGame(game, elapsed, now = Date.now()) {
  if (!game.alive) return { changed: false, cleared: 0 };
  const onGround = grounded(game);
  if (onGround) game.touchedGround = true;
  if (onGround || (game.touchedGround && game.lockResets >= 15)) game.lockTime += elapsed;
  if (onGround) {
    if (game.lockTime >= 450) return { changed: true, ...lock(game, now) };
  } else {
    if (game.lockResets < 15) game.lockTime = 0;
    game.fallTime += elapsed;
    const interval = Math.max(90, 800 * Math.pow(0.82, game.level - 1));
    if (game.fallTime >= interval) {
      game.fallTime = 0;
      game.active.y++;
      return { changed: true, cleared: 0 };
    }
  }
  return { changed: false, cleared: 0 };
}

function snapshotGame(game) {
  return {
    board: game.board, active: game.active, next: game.queue.slice(0, 3),
    hold: game.hold, holdUsed: game.holdUsed,
    score: game.score, lines: game.lines, level: game.level,
    sent: game.sent, received: game.received, pending: game.pending, alive: game.alive,
    energy: game.energy, cleanseQueued: game.cleanseQueued, combo: game.combo,
    dug: game.dug, cancelled: game.cancelled, purified: game.purified, helped: game.helped,
    garbageRows: game.board.filter(row => row.includes('G')).length,
    garbageReadyAt: game.garbage[0]?.readyAt || null,
  };
}

module.exports = { WIDTH, HEIGHT, SHAPES, createGame, collides, act, lock, tickGame, snapshotGame, enqueueGarbage, cancelGarbage, explodeGarbage };
