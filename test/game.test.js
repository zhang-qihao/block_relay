'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const { createGame, act, tickGame, collides, lock, enqueueGarbage } = require('../game');
const { createApp } = require('../server');
const Rules = require('../public/rules');
const fs = require('node:fs');
const path = require('node:path');

test('all client element IDs exist', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'DOM IDs must be unique');
  for (const match of script.matchAll(/(?:\$|\btext|\brenderPiece)\('([^']+)'/g)) {
    assert.ok(ids.includes(match[1]), `Missing DOM element: ${match[1]}`);
  }
});

function setupClear(game, count) {
  game.board = Array.from({ length: 20 }, () => Array(10).fill(null));
  for (let y = 20 - count; y < 20; y++) game.board[y] = Array.from({ length: 10 }, (_, x) => x === 4 ? null : 'J');
  game.active = { type: 'I', matrix: [[1], [1], [1], [1]], x: 4, y: 0 };
}

for (const count of [1, 2, 3, 4]) {
  test(`clears ${count} lines and preserves board dimensions`, () => {
    const game = createGame(42);
    setupClear(game, count);
    const result = act(game, 'drop');
    assert.equal(result.cleared, count);
    assert.deepEqual(result.clearedRows.map(row => row.y), Array.from({ length: count }, (_, i) => 20 - count + i));
    assert.ok(result.clearedRows.every(row => row.cells.length === 10 && row.cells[4] === 'I' && row.cells.every(Boolean)));
    assert.equal(game.lines, count);
    assert.equal(game.board.length, 20);
    assert.ok(game.board.every(row => row.length === 10));
    assert.equal(game.alive, true);
  });
}

test('same seed provides same seven-bag sequence', () => {
  const a = createGame(888);
  const b = createGame(888);
  assert.equal(a.active.type, b.active.type);
  assert.deepEqual(a.queue, b.queue);
  assert.equal(new Set([a.active.type, ...a.queue.slice(0, 6)]).size, 7);
});

test('walls, rotation and hold do not allow illegal positions', () => {
  const game = createGame(4);
  for (let i = 0; i < 20; i++) act(game, 'left');
  assert.equal(collides(game), false);
  act(game, 'rotate');
  assert.equal(collides(game), false);
  const type = game.active.type;
  act(game, 'hold');
  assert.equal(game.hold, type);
  const current = game.active.type;
  act(game, 'hold');
  assert.equal(game.active.type, current);
  act(game, 'drop');
  assert.equal(game.holdUsed, false);
});

test('garbage waits until lock and each row has one hole', () => {
  const game = createGame(8, { buffer: false, counter: false });
  enqueueGarbage(game, 3);
  act(game, 'left');
  assert.equal(game.pending, 3);
  act(game, 'drop');
  assert.equal(game.pending, 0);
  assert.equal(game.received, 3);
  for (const row of game.board.slice(-3)) {
    assert.equal(row.filter(cell => cell === 'G').length, 9);
    assert.equal(row.filter(cell => cell === null).length, 1);
  }
});

test('overflow from incoming garbage eliminates player', () => {
  const game = createGame(9, { buffer: false });
  game.board[0][0] = 'J';
  enqueueGarbage(game, 1);
  act(game, 'drop');
  assert.equal(game.alive, false);
});

test('gravity and lock delay advance pieces', () => {
  const game = createGame(10);
  const y = game.active.y;
  tickGame(game, 800);
  assert.equal(game.active.y, y + 1);
  while (!collides(game, { ...game.active, y: game.active.y + 1 })) game.active.y++;
  assert.equal(tickGame(game, 400).changed, false);
  assert.equal(tickGame(game, 50).locked, true);
});

test('locking above board ends game safely', () => {
  const game = createGame(5);
  game.active = { type: 'O', matrix: [[1, 1], [1, 1]], x: 4, y: -1 };
  assert.equal(lock(game).cleared, 0);
  assert.equal(game.alive, false);
});

async function client(url) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  ws.on('message', raw => {
    const message = JSON.parse(raw.toString());
    inbox.push(message);
    for (const notify of [...waiters]) notify();
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return {
    ws,
    send(data) { ws.send(JSON.stringify(data)); },
    wait(predicate) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { remove(); reject(new Error('Timed out waiting for protocol message')); }, 3000);
        const remove = () => { clearTimeout(timeout); const index = waiters.indexOf(check); if (index >= 0) waiters.splice(index, 1); };
        const check = () => {
          const index = inbox.findIndex(predicate);
          if (index < 0) return;
          const message = inbox[index];
          inbox.splice(0, index + 1);
          remove();
          resolve(message);
        };
        waiters.push(check);
        check();
      });
    },
  };
}

test('room capacity, malformed messages and game state validation', async t => {
  const app = createApp();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const url = `ws://127.0.0.1:${app.server.address().port}/ws`;
  const host = await client(url);
  host.ws.send('not json');
  await host.wait(data => data.type === 'error' && data.message.includes('格式'));
  host.send({ type: 'create', name: '<script>not markup</script>' });
  const identity = await host.wait(data => data.type === 'joined');
  const initial = await host.wait(isState(room => room.players.length === 1));
  const room = app.rooms.get(initial.room.code);
  assert.equal(room.settings.attack, 'random');
  host.send({ type: 'action', action: 'drop' });
  host.send({ type: 'ready', ready: true });
  await host.wait(isState(value => value.players[0].ready));
  assert.equal(room.players.get(identity.id).game, null);
  for (let i = 0; i < 5; i++) {
    const guest = await client(url);
    guest.send({ type: 'join', code: room.code, name: `玩家${i}` });
    await guest.wait(data => data.type === 'joined');
  }
  assert.equal(room.players.size, 6);
  const extra = await client(url);
  extra.send({ type: 'join', code: room.code, name: '第七人' });
  await extra.wait(data => data.type === 'error' && data.message.includes('满'));
  extra.send({ type: 'resume', token: 'invalid' });
  await extra.wait(data => data.type === 'resumeFailed');
  assert.equal(room.players.size, 6);
});

for (const attack of Object.keys(Rules.attacks)) {
  test(`WebSocket ${attack}: settings, four-player attack distribution and defense`, async t => {
    const { room, clients, ids } = await connectedRoom(t, { attack, buffer: false, counter: false }, 4);
    await readyAndStart(clients);
    const self = room.players.get(ids[0]);
    setupClear(self.game, 4);
    clients[0].send({ type: 'action', action: 'drop' });
    const updated = await clients[0].wait(isState(value => value.players.find(player => player.id === ids[0]).game?.lines === 4));
    const targets = updated.room.players.filter(player => player.id !== ids[0]);
    assert.equal(targets.reduce((sum, player) => sum + player.game.pending, 0), attack === 'all' ? 12 : 4);
    const effect = updated.room.effects.at(-1);
    assert.equal(effect.sourceId, ids[0]);
    assert.equal(effect.sourceName, '房主');
    assert.equal(effect.rows.length, 4);
    assert.equal(effect.cancelled, 0);
    for (const target of effect.targets) assert.equal(target.lines, targets.find(player => player.id === target.targetId).game.pending);
    assert.equal(effect.targets.reduce((sum, target) => sum + target.lines, 0), attack === 'all' ? 12 : 4);
    assert.equal(updated.room.roundId, 1);
    if (attack === 'split') assert.deepEqual(targets.map(player => player.game.pending).sort(), [1, 1, 2]);
    else if (attack !== 'all') assert.equal(targets.filter(player => player.game.pending > 0).length, 1);
  });
}

async function connectedRoom(t, settings, count = 3, appOptions = { countdownMs: 10 }) {
  const app = createApp(appOptions);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const url = `ws://127.0.0.1:${app.server.address().port}/ws`;
  const clients = [], ids = [];
  const host = await client(url);
  clients.push(host);
  host.send({ type: 'create', name: '房主' });
  ids.push((await host.wait(data => data.type === 'joined')).id);
  const initial = await host.wait(isState(value => value.players.length === 1));
  const room = app.rooms.get(initial.room.code);
  if (settings) {
    host.send({ type: 'settings', settings });
    await host.wait(isState(value => Object.entries(settings).every(([key, value2]) => value.settings[key] === value2)));
  }
  for (let i = 1; i < count; i++) {
    const guest = await client(url);
    clients.push(guest);
    guest.send({ type: 'join', code: room.code, name: `玩家${i}` });
    ids.push((await guest.wait(data => data.type === 'joined')).id);
  }
  if (count > 1) await host.wait(isState(value => value.players.length === count));
  return { app, room, clients, ids, url };
}
async function readyAndStart(clients) {
  for (const player of clients) player.send({ type: 'ready', ready: true });
  await clients[0].wait(isState(value => value.players.every(player => player.ready)));
  clients[0].send({ type: 'start' });
  return clients[0].wait(isState(value => value.status === 'playing'));
}

test('WebSocket settings permissions, validation, ready reset and immutable in-game rules', async t => {
  const { room, clients: [a, b] } = await connectedRoom(t, { attack: 'round' }, 2);
  b.send({ type: 'settings', settings: { attack: 'all' } });
  await b.wait(data => data.type === 'error' && data.message.includes('房主'));
  a.send({ type: 'settings', settings: { duration: -1 } });
  await a.wait(data => data.type === 'error' && data.message.includes('无效'));
  assert.equal(room.settings.duration, 180);
  a.send({ type: 'settings', settings: { attack: 'random' } });
  await a.wait(isState(value => value.settings.attack === 'random' && value.players.every(player => !player.ready)));
  a.send({ type: 'ready', ready: true });
  await a.wait(isState(value => value.players[0].ready));
  a.send({ type: 'settings', settings: { attack: 'random' } });
  await a.wait(isState(value => value.players[0].ready));
  await readyAndStart([a, b]);
  a.send({ type: 'settings', settings: { attack: 'manual' } });
  await a.wait(data => data.type === 'error' && data.message.includes('大厅'));
  assert.equal(room.settings.attack, 'random');
  a.send({ type: 'target', id: [...room.players.keys()][1] });
  await a.wait(data => data.type === 'error' && data.message.includes('自动'));
});

test('manual default targets are synchronized before anyone attacks and refreshed on leaving', async t => {
  const { room, clients, ids } = await connectedRoom(t, { attack: 'manual' }, 5);
  const started = await readyAndStart(clients);
  assert.deepEqual(started.room.players.map(player => player.targetId), [ids[4], ids[0], ids[1], ids[2], ids[3]]);
  clients[4].send({ type: 'leave' });
  const changed = await clients[0].wait(isState(value => value.players.length === 4));
  assert.equal(changed.room.players[0].targetId, ids[3]);
  assert.equal(room.players.get(ids[0]).targetId, ids[3]);
});

test('WebSocket manual cooldown cannot be bypassed but dead target can be replaced', async t => {
  const { room, clients: [a, b, c], ids } = await connectedRoom(t, { cooldown: true, attack: 'manual' });
  await readyAndStart([a, b, c]);
  a.send({ type: 'target', id: ids[1] });
  await a.wait(isState(value => value.players[0].targetId === ids[1]));
  a.send({ type: 'target', id: ids[2] });
  await a.wait(data => data.type === 'error' && data.message.includes('冷却'));
  room.players.get(ids[1]).game.alive = false;
  a.send({ type: 'target', id: ids[2] });
  await a.wait(isState(value => value.players[0].targetId === ids[2]));
});

test('WebSocket teams: balanced setup, change-team readiness, no friendly fire and team victory', async t => {
  const { room, clients, ids } = await connectedRoom(t, { mode: 'teams', buffer: false, attack: 'manual' }, 4);
  clients[1].send({ type: 'team', team: 'red' });
  await clients[0].wait(isState(value => value.players[1].team === 'red' && value.players.every(player => !player.ready)));
  for (const player of clients) player.send({ type: 'ready', ready: true });
  await clients[0].wait(isState(value => value.players.every(player => player.ready)));
  clients[0].send({ type: 'start' });
  await clients[0].wait(data => data.type === 'error' && data.message.includes('人数'));
  clients[1].send({ type: 'team', team: 'blue' });
  await clients[0].wait(isState(value => value.players[1].team === 'blue'));
  await readyAndStart(clients);
  clients[0].send({ type: 'target', id: ids[2] });
  await clients[0].wait(data => data.type === 'error' && data.message.includes('队友'));
  setupClear(room.players.get(ids[0]).game, 4);
  clients[0].send({ type: 'action', action: 'drop' });
  await clients[0].wait(isState(value => value.players[0].game.lines === 4));
  assert.equal(room.players.get(ids[2]).game.pending, 0);
  assert.equal(room.players.get(ids[3]).game.pending, 4);
  room.players.get(ids[1]).game.alive = false;
  room.players.get(ids[3]).game.alive = false;
  const end = await clients[0].wait(isState(value => value.status === 'finished'));
  assert.equal(end.room.outcome.winningTeam, 'red');
});

test('WebSocket timed deadline rejects late inputs and preserves tied results', async t => {
  const { room, clients, ids } = await connectedRoom(t, { mode: 'timed' });
  await readyAndStart(clients);
  room.players.get(ids[0]).game.lines = 10;
  room.players.get(ids[1]).game.lines = 10;
  room.deadline = Date.now() - 1;
  const score = room.players.get(ids[0]).game.score;
  clients[0].send({ type: 'action', action: 'drop' });
  const end = await clients[0].wait(isState(value => value.status === 'finished'));
  assert.equal(room.players.get(ids[0]).game.score, score);
  assert.deepEqual(end.room.outcome.winnerIds, ids.slice(0, 2));
});

test('WebSocket sprint finishes immediately after target clear', async t => {
  const { room, clients, ids } = await connectedRoom(t, { mode: 'sprint', goal: 20 });
  await readyAndStart(clients);
  const game = room.players.get(ids[0]).game;
  game.lines = 19;
  setupClear(game, 1);
  clients[0].send({ type: 'action', action: 'drop' });
  const end = await clients[0].wait(isState(value => value.status === 'finished'));
  assert.deepEqual(end.room.outcome.winnerIds, [ids[0]]);
  assert.equal(game.lines, 20);
});

test('WebSocket practice allows single player and host stop, no attacks', async t => {
  const { room, clients: [a], ids } = await connectedRoom(t, { mode: 'practice' }, 1);
  await readyAndStart([a]);
  setupClear(room.players.get(ids[0]).game, 4);
  a.send({ type: 'action', action: 'drop' });
  const cleared = await a.wait(isState(value => value.players[0].game.lines === 4));
  assert.deepEqual(cleared.room.effects[0].targets, []);
  assert.equal(cleared.room.effects[0].rows.length, 4);
  assert.equal(room.status, 'playing');
  assert.equal(room.players.get(ids[0]).game.sent, 0);
  a.send({ type: 'endPractice' });
  const end = await a.wait(isState(value => value.status === 'finished'));
  assert.match(end.room.outcome.reason, /练习/);
});

test('WebSocket environment garbage, purification, reconnect and rematch preserve settings', async t => {
  const { room, clients, ids, url } = await connectedRoom(t, { mode: 'battle', digBonus: true });
  await readyAndStart(clients);
  room.nextEnvironmentAt = Date.now() - 1;
  await clients[0].wait(isState(value => value.players[0].game.pending === 1));
  const game = room.players.get(ids[0]).game;
  game.energy = 6;
  game.board[19][0] = 'G';
  clients[0].send({ type: 'action', action: 'cleanse' });
  await clients[0].wait(isState(value => value.players[0].game.cleanseQueued));
  clients[0].send({ type: 'action', action: 'drop' });
  await clients[0].wait(isState(value => value.players[0].game.purified === 1));
  assert.equal(game.energy, 0);
  const token = room.players.get(ids[1]).token;
  const disconnected = new Promise(resolve => clients[1].ws.once('close', resolve));
  clients[1].ws.close();
  await disconnected;
  await clients[0].wait(isState(value => !value.players[1].connected));
  const resumed = await client(url);
  resumed.send({ type: 'resume', token });
  await resumed.wait(data => data.type === 'joined');
  const synced = await resumed.wait(isState(value => value.players[1].connected));
  assert.equal(synced.room.settings.digBonus, true);
  for (const player of room.players.values()) if (player.id !== ids[0]) player.game.alive = false;
  await clients[0].wait(isState(value => value.status === 'finished'));
  clients[0].send({ type: 'rematch' });
  const lobby = await clients[0].wait(isState(value => value.status === 'lobby'));
  assert.equal(lobby.room.settings.mode, 'battle');
  assert.equal(lobby.room.settings.digBonus, true);
  assert.equal(lobby.room.outcome, null);
});

test('WebSocket six-player teams handle departures and preserve complete result roster', async t => {
  const { room, clients, ids } = await connectedRoom(t, { mode: 'teams' }, 6);
  await readyAndStart(clients);
  for (const index of [1, 3, 5]) {
    clients[index].send({ type: 'leave' });
    await clients[index].wait(data => data.type === 'left');
  }
  const end = await clients[0].wait(isState(value => value.status === 'finished'));
  assert.equal(end.room.outcome.winningTeam, 'red');
  assert.equal(end.room.outcome.results.length, 6);
  assert.deepEqual(end.room.outcome.winnerIds, [ids[0], ids[2], ids[4]]);
  assert.equal(room.players.size, 3);
});

test('WebSocket countdown cancellation and expired disconnect clean up correctly', async t => {
  const { app, room, clients: [a, b], ids } = await connectedRoom(t, { mode: 'battle' }, 2);
  for (const player of [a, b]) player.send({ type: 'ready', ready: true });
  await a.wait(isState(value => value.players.every(player => player.ready)));
  a.send({ type: 'start' });
  await a.wait(isState(value => value.status === 'countdown'));
  room.startsAt = Date.now() + 10000;
  b.send({ type: 'leave' });
  const lobby = await a.wait(isState(value => value.status === 'lobby' && value.players.length === 1));
  assert.equal(lobby.room.deadline, null);
  assert.equal(lobby.room.nextEnvironmentAt, null);
  assert.equal(lobby.room.players[0].game, null);
  const serverSocket = room.players.get(ids[0]).ws;
  const serverDisconnected = new Promise(resolve => serverSocket.once('close', resolve));
  const disconnected = new Promise(resolve => a.ws.once('close', resolve));
  a.ws.close();
  await Promise.all([disconnected, serverDisconnected]);
  room.players.get(ids[0]).disconnectedAt = Date.now() - 31000;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(app.rooms.has(room.code), false);
});

test('WebSocket practice stop is host-only and the last remaining player may continue', async t => {
  const { room, clients: [a, b, c], ids } = await connectedRoom(t, { mode: 'practice' }, 3);
  await readyAndStart([a, b, c]);
  b.send({ type: 'endPractice' });
  await b.wait(data => data.type === 'error' && data.message.includes('房主'));
  for (const id of ids.slice(1)) room.players.get(id).game.alive = false;
  a.send({ type: 'action', action: 'left' });
  await a.wait(isState(value => value.players.filter(player => player.game.alive).length === 1));
  assert.equal(room.status, 'playing');
  a.send({ type: 'endPractice' });
  await a.wait(isState(value => value.status === 'finished'));
});

test('default countdown is five seconds and blocks movement and gravity', async t => {
  const { room, clients: [a, b] } = await connectedRoom(t, null, 2, {});
  for (const client of [a, b]) client.send({ type: 'ready', ready: true });
  await a.wait(isState(value => value.players.every(player => player.ready)));
  const before = Date.now();
  a.send({ type: 'start' });
  const countdown = await a.wait(isState(value => value.status === 'countdown'));
  assert.ok(countdown.room.startsAt - before >= 5000);
  assert.ok(countdown.room.startsAt - countdown.room.serverNow <= 5000);
  const game = room.players.values().next().value.game;
  const initial = JSON.stringify(game.active);
  a.send({ type: 'action', action: 'drop' });
  a.send({ type: 'action', action: 'left' });
  b.send({ type: 'action', action: 'down' });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(JSON.stringify(game.active), initial);
  assert.equal(game.score, 0);
  assert.equal(room.status, 'countdown');
});

test('clear effects reflect cancellation, gravity locking and practice without phantom targets', async t => {
  const { room, clients, ids } = await connectedRoom(t, { counter: true, buffer: false });
  await readyAndStart(clients);
  const game = room.players.get(ids[0]).game;
  enqueueGarbage(game, 2);
  setupClear(game, 2);
  clients[0].send({ type: 'action', action: 'drop' });
  let update = await clients[0].wait(isState(value => value.effects.length === 1));
  assert.equal(update.room.effects[0].cancelled, 2);
  assert.deepEqual(update.room.effects[0].targets, []);
  setupClear(game, 1);
  game.active.y = 16;
  game.lockTime = 450;
  update = await clients[0].wait(isState(value => value.effects.length === 2));
  assert.equal(update.room.effects[1].rows[0].y, 19);
  assert.equal(update.room.effects[1].targets[0].lines, 1);
  assert.ok(update.room.effects[1].id > update.room.effects[0].id);
  // Old records expire from the bounded snapshot history.
  room.effects[0].at = Date.now() - 6000;
  clients[0].send({ type: 'action', action: 'left' });
  update = await clients[0].wait(isState(value => value.effects.length === 1));
  assert.equal(update.room.effects[0].id, 2);
});

test('real delayed garbage insertion produces a sourced hit after partial cancellation', async t => {
  const { room, clients: [a, b], ids } = await connectedRoom(t, { buffer: true, counter: true }, 2);
  await readyAndStart([a, b]);
  setupClear(room.players.get(ids[0]).game, 4);
  a.send({ type: 'action', action: 'drop' });
  const warning = await b.wait(isState(value => value.players[1].game?.pending === 4));
  assert.equal(warning.room.effects.some(effect => effect.kind === 'hit'), false);
  const victim = room.players.get(ids[1]).game;
  setupClear(victim, 1);
  b.send({ type: 'action', action: 'drop' });
  const countered = await b.wait(isState(value => value.players[1].game.cancelled === 1));
  assert.equal(countered.room.players[1].game.pending, 3);
  assert.equal(countered.room.players[1].game.received, 0);
  // Simulate the buffer expiring without slowing the test by two real seconds.
  victim.garbage[0].readyAt = Date.now() - 1;
  b.send({ type: 'action', action: 'drop' });
  const landed = await b.wait(isState(value => value.players[1].game.received === 3));
  const hit = landed.room.effects.find(effect => effect.kind === 'hit');
  assert.equal(hit.targetId, ids[1]);
  assert.equal(hit.lines, 3);
  assert.deepEqual(hit.sources, [{ sourceId: ids[0], sourceName: '房主', lines: 3 }]);
  assert.equal(landed.room.players[1].game.board.slice(-3).every(row => row.includes('G')), true);
  const observed = await a.wait(isState(value => value.effects.some(effect => effect.kind === 'hit')));
  assert.deepEqual(observed.room.effects.find(effect => effect.kind === 'hit'), hit);
});

test('incoming packets retain source metadata through FIFO cancellation and environment hits', () => {
  const game = createGame(42, { buffer: true });
  enqueueGarbage(game, 2, 1000, { sourceId: 'a', sourceName: '阿岚' });
  enqueueGarbage(game, 3, 1000, { sourceId: 'b', sourceName: '小周' });
  enqueueGarbage(game, 1, 1000);
  setupClear(game, 3);
  const result = act(game, 'drop', 3000);
  assert.equal(result.incoming, 3);
  assert.deepEqual(result.hits, [
    { sourceId: 'b', sourceName: '小周', lines: 2 },
    { sourceId: null, sourceName: '环境障碍', lines: 1 },
  ]);
});

test('WebSocket presets are host-only, reset ready, mark custom and retain chosen settings', async t => {
  const { room, clients: [a, b] } = await connectedRoom(t, null, 2);
  b.send({ type: 'preset', id: 'dig' });
  await b.wait(data => data.type === 'error' && data.message.includes('房主'));
  a.send({ type: 'preset', id: 'unknown' });
  await a.wait(data => data.type === 'error' && data.message.includes('无效'));
  a.send({ type: 'preset', id: 'dig' });
  await a.wait(isState(value => value.presetId === 'dig' && value.players.every(player => !player.ready)));
  assert.equal(room.settings.cleanse, false);
  a.send({ type: 'ready', ready: true });
  await a.wait(isState(value => value.players[0].ready));
  a.send({ type: 'preset', id: 'dig' });
  await a.wait(isState(value => value.presetId === 'dig' && value.players[0].ready));
  a.send({ type: 'settings', settings: { digRows: 4, cleanse: true } });
  await a.wait(isState(value => value.presetId === 'custom' && value.settings.digRows === 4));
  assert.equal(room.settings.cleanse, false);
  await readyAndStart([a, b]);
  a.send({ type: 'preset', id: 'friends' });
  await a.wait(data => data.type === 'error' && data.message.includes('大厅'));
});

test('WebSocket same-tick topout is a tie regardless of join order', async t => {
  const { room, clients, ids } = await connectedRoom(t, null, 2);
  await readyAndStart(clients);
  for (const id of ids) {
    const game = room.players.get(id).game;
    game.active = { type: 'O', matrix: [[1, 1], [1, 1]], x: 4, y: 18 };
    game.lockTime = 450;
    game.board[1][4] = 'J';
    game.queue[0] = 'O';
  }
  const end = await clients[0].wait(isState(value => value.status === 'finished'));
  assert.deepEqual(end.room.outcome.winnerIds, []);
  assert.equal(end.room.players.every(player => !player.game.alive), true);
  assert.deepEqual(end.room.outcome.results.map(player => player.rank), [1, 1]);
});

test('WebSocket solo dig completion and coop rescue/waves/success integrate end to end', async t => {
  const dig = await connectedRoom(t, { mode: 'dig', digRows: 4 }, 1);
  await readyAndStart(dig.clients);
  const game = dig.room.players.get(dig.ids[0]).game;
  const hole = game.board[19].indexOf(null);
  game.active = { type: 'I', matrix: [[1], [1], [1], [1]], x: hole, y: 0 };
  dig.clients[0].send({ type: 'action', action: 'drop' });
  const finish = await dig.clients[0].wait(isState(value => value.status === 'finished'));
  assert.deepEqual(finish.room.outcome.winnerIds, dig.ids);
  assert.equal(finish.room.players[0].game.dug, 4);
  assert.equal(finish.room.players[0].game.sent, 0);
  const coop = await connectedRoom(t, { mode: 'coop', waves: 3 }, 2);
  await readyAndStart(coop.clients);
  const [a, b] = coop.ids.map(id => coop.room.players.get(id));
  enqueueGarbage(b.game, 3);
  setupClear(a.game, 2);
  coop.clients[0].send({ type: 'action', action: 'drop' });
  const rescued = await coop.clients[0].wait(isState(value => value.players[0].game.helped === 2));
  assert.equal(rescued.room.players[1].game.pending, 1);
  assert.equal(rescued.room.effects.some(effect => effect.kind === 'rescue'), true);
  assert.equal(rescued.room.effects.filter(effect => effect.kind === 'clear').every(effect => !effect.targets.length), true);
  coop.room.nextWaveAt = Date.now() - 1;
  await coop.clients[0].wait(isState(value => value.wave === 1));
  coop.room.wave = 3;
  coop.room.nextWaveAt = null;
  coop.room.coopEndsAt = Date.now() - 1;
  const win = await coop.clients[0].wait(isState(value => value.status === 'finished'));
  assert.equal(win.room.outcome.winningTeam, 'coop');
  assert.equal(win.room.outcome.winnerIds.length, 2);
  coop.clients[0].send({ type: 'rematch' });
  const lobby = await coop.clients[0].wait(isState(value => value.status === 'lobby'));
  assert.equal(lobby.room.wave, 0);
  assert.equal(lobby.room.nextWaveAt, null);
});

test('new modes preserve progress on reconnect and end correctly after final active departure', async t => {
  const coop = await connectedRoom(t, { mode: 'coop' }, 2);
  await readyAndStart(coop.clients);
  const token = coop.room.players.get(coop.ids[1]).token;
  coop.room.wave = 2;
  const closed = new Promise(resolve => coop.clients[1].ws.once('close', resolve));
  coop.clients[1].ws.close();
  await closed;
  await coop.clients[0].wait(isState(value => !value.players[1].connected));
  const resumed = await client(coop.url);
  resumed.send({ type: 'resume', token });
  await resumed.wait(data => data.type === 'joined');
  const snapshot = await resumed.wait(isState(value => value.wave === 2));
  assert.equal(snapshot.room.settings.mode, 'coop');
  coop.clients[0].send({ type: 'leave' });
  await resumed.wait(isState(value => value.players.length === 1));
  assert.equal(coop.room.status, 'playing');
  const victim = coop.room.players.get(coop.ids[1]);
  victim.game.alive = false;
  const lost = await resumed.wait(isState(value => value.status === 'finished'));
  assert.equal(lost.room.outcome.winningTeam, null);
  assert.deepEqual(lost.room.outcome.winnerIds, []);
});

test('same-tick sprint target completion awards both players', async t => {
  const { room, clients, ids } = await connectedRoom(t, { mode: 'sprint', goal: 20 }, 2);
  await readyAndStart(clients);
  for (const id of ids) {
    const game = room.players.get(id).game;
    game.lines = 19;
    setupClear(game, 1);
    game.active.y = 16;
    game.lockTime = 450;
  }
  const end = await clients[0].wait(isState(value => value.status === 'finished'));
  assert.deepEqual(end.room.outcome.winnerIds, ids);
  assert.deepEqual(end.room.outcome.results.map(player => player.rank), [1, 1]);
});

test('spectator taps validate permissions, coordinates, rate limit and do not change gameplay', async t => {
  const { room, clients: [a, b, c], ids } = await connectedRoom(t, null, 3);
  const tap = { type: 'spectatorTap', targetId: ids[1], effect: 'glass', x: .25, y: .75 };
  a.send(tap);
  await a.wait(data => data.type === 'tapError');
  await readyAndStart([a, b, c]);
  a.send(tap);
  await a.wait(data => data.type === 'tapError');
  room.players.get(ids[0]).game.alive = false;
  await b.wait(isState(value => value.players[0].game && !value.players[0].game.alive));
  for (const patch of [{ targetId: ids[0] }, { targetId: 'other-room' }, { effect: 'unknown' }, { x: -1 }, { y: 1.1 }, { x: '0.5' }, { x: null }]) {
    a.send({ ...tap, ...patch });
    await a.wait(data => data.type === 'tapError');
  }
  const before = room.players.get(ids[1]).game;
  const totals = [before.score, before.lines, before.pending, before.sent];
  for (const effect of Object.keys(Rules.spectatorEffects)) {
    room.players.get(ids[0]).lastTapAt = null;
    a.send({ ...tap, effect, sourceName: 'fake name' });
    const update = await b.wait(isState(value => value.interactions.some(item => item.effect === effect)));
    const last = update.room.interactions.at(-1);
    assert.equal(last.sourceId, ids[0]);
    assert.equal(last.sourceName, '房主');
    assert.equal(last.x, .25);
    assert.equal(last.y, .75);
  }
  assert.deepEqual([before.score, before.lines, before.pending, before.sent], totals);
  a.send(tap);
  await a.wait(data => data.type === 'tapError' && data.message.includes('慢'));
  room.players.get(ids[0]).lastTapAt = null;
  room.tapTimes = Array(8).fill(Date.now());
  a.send(tap);
  await a.wait(data => data.type === 'tapError');
  room.players.get(ids[2]).game.alive = false;
  await b.wait(isState(value => value.status === 'finished'));
  a.send(tap);
  await a.wait(data => data.type === 'tapError');
  a.send({ type: 'rematch' });
  const lobby = await a.wait(isState(value => value.status === 'lobby'));
  assert.deepEqual(lobby.room.interactions, []);
});

const isState = predicate => data => data.type === 'state' && predicate(data.room);

test('three clients: room, attacks, targeting, reconnect, finish and rematch', async t => {
  const app = createApp({ countdownMs: 20 });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const response = await fetch(base);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /mainBoard/);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  for (const file of ['/app.js', '/styles.css', '/effects.js']) {
    const resource = await fetch(`${base}${file}`);
    assert.equal(resource.status, 200);
    assert.ok((await resource.text()).length > 100);
  }
  assert.equal((await fetch(`${base}/..%2fserver.js`)).status, 404);
  assert.equal((await fetch(`${base}/api/info`)).status, 200);

  const url = `ws://127.0.0.1:${address.port}/ws`;
  const a = await client(url);
  const b = await client(url);
  const c = await client(url);
  a.send({ type: 'create', name: '甲' });
  const aIdentity = await a.wait(data => data.type === 'joined');
  const initial = await a.wait(isState(room => room.players.length === 1));
  const code = initial.room.code;
  assert.match(code, /^[A-Z2-9]{4}$/);
  a.send({ type: 'start' });
  await a.wait(data => data.type === 'error' && data.message.includes('2'));
  b.send({ type: 'join', code, name: '乙' });
  const bIdentity = await b.wait(data => data.type === 'joined');
  c.send({ type: 'join', code, name: '丙' });
  const cIdentity = await c.wait(data => data.type === 'joined');
  await a.wait(isState(room => room.players.length === 3));
  b.send({ type: 'start' });
  await b.wait(data => data.type === 'error' && data.message.includes('房主'));
  a.send({ type: 'start' });
  await a.wait(data => data.type === 'error' && data.message.includes('准备'));
  b.send({ type: 'ready', ready: true });
  c.send({ type: 'ready', ready: true });
  await a.wait(isState(room => room.players.length === 3 && room.players.every(player => player.ready)));
  const room = app.rooms.get(code);
  a.send({ type: 'settings', settings: { counter: false, buffer: false, attack: 'manual' } });
  await a.wait(isState(value => !value.settings.counter && !value.settings.buffer));
  for (const client of [a, b, c]) client.send({ type: 'ready', ready: true });
  await a.wait(isState(value => value.players.every(player => player.ready)));
  a.send({ type: 'start' });
  const started = await a.wait(isState(value => value.status === 'playing'));
  assert.equal(new Set(started.room.players.map(player => player.game.active.type)).size, 1);

  const playerA = room.players.get(aIdentity.id);
  const playerB = room.players.get(bIdentity.id);
  const playerC = room.players.get(cIdentity.id);
  a.send({ type: 'target', id: cIdentity.id });
  await a.wait(isState(value => value.players.find(player => player.id === aIdentity.id)?.targetId === cIdentity.id));
  setupClear(playerA.game, 4);
  a.send({ type: 'action', action: 'drop' });
  const attacked = await c.wait(isState(value => value.players.find(player => player.id === cIdentity.id)?.game?.pending === 4));
  assert.equal(attacked.room.players.find(player => player.id === aIdentity.id).game.sent, 4);
  assert.equal(playerB.game.pending, 0);
  c.send({ type: 'action', action: 'drop' });
  await a.wait(isState(value => value.players.find(player => player.id === cIdentity.id)?.game?.received === 4));
  assert.equal(playerC.game.board.slice(-4).every(row => row.filter(cell => cell === 'G').length === 9), true);

  setupClear(playerA.game, 1);
  a.send({ type: 'action', action: 'drop' });
  await c.wait(isState(value => value.players.find(player => player.id === cIdentity.id)?.game?.pending === 1));
  assert.equal(playerA.game.sent, 5);

  const closed = new Promise(resolve => b.ws.once('close', resolve));
  b.ws.close();
  await closed;
  await a.wait(isState(value => !value.players.find(player => player.id === bIdentity.id)?.connected));
  const bAgain = await client(url);
  bAgain.send({ type: 'resume', token: bIdentity.token });
  assert.equal((await bAgain.wait(data => data.type === 'joined')).id, bIdentity.id);
  await a.wait(isState(value => value.players.find(player => player.id === bIdentity.id)?.connected));

  playerB.game.alive = false;
  playerC.game.alive = false;
  const finished = await a.wait(isState(value => value.status === 'finished'));
  assert.equal(finished.room.players.find(player => player.id === aIdentity.id).rank, 1);
  assert.equal(new Set(finished.room.players.filter(player => player.id !== aIdentity.id).map(player => player.rank)).size, 1);
  assert.equal(finished.room.players.find(player => player.id !== aIdentity.id).rank, 2);
  a.send({ type: 'rematch' });
  const lobby = await a.wait(isState(value => value.status === 'lobby' && value.players.length === 3));
  assert.ok(lobby.room.players.every(player => player.game === null));
  a.send({ type: 'leave' });
  await a.wait(data => data.type === 'left');
  const hostChanged = await bAgain.wait(isState(value => value.players.length === 2));
  assert.equal(hostChanged.room.hostId, bIdentity.id);
});
