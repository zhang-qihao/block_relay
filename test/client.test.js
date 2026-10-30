'use strict';

// Executes the real browser scripts against a small DOM test double. This catches
// render/handler regressions; it deliberately does not claim visual coverage.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const Rules = require('../public/rules');
const { createGame, snapshotGame } = require('../game');

function browserFixture() {
  const drawing = new Proxy({}, { get: (target, name) => target[name] || (() => {}), set: (target, name, value) => { target[name] = value; return true; } });
  const nodes = new Map();
  const all = [];
  class Node {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.type = ''; this.dataset = {}; this.children = [];
      this.textContent = ''; this.value = ''; this.checked = false; this.disabled = false;
      this.events = {}; this.className = ''; this.attributes = {}; this.animations = [];
      this.classes = new Set();
      this.classList = {
        toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name),
        add: name => this.classes.add(name), remove: name => this.classes.delete(name),
      };
      all.push(this);
    }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    addEventListener(name, callback) { (this.events[name] ||= []).push(callback); }
    fire(name, extra = {}) { for (const fn of this.events[name] || []) fn({ target: this, preventDefault() {}, ...extra }); }
    setAttribute(name, value) { this.attributes[name] = value; }
    getContext() { return drawing; }
    getBoundingClientRect() { return { left: 100, top: 100, right: 200, bottom: 300, width: 100, height: 200 }; }
    setPointerCapture() {}
    animate(keyframes, options) {
      const animation = { keyframes, options, cancelled: false, cancel() { this.cancelled = true; }, finished: new Promise(() => {}) };
      this.animations.push(animation);
      return animation;
    }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
    querySelector(selector) {
      const children = this.children.flatMap(child => [child, ...child.descendants()]);
      return children.find(child => selector === 'canvas' ? child.tagName === 'CANVAS' : child.className.split(' ').includes(selector.slice(1))) || null;
    }
    descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  }
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  for (const match of html.matchAll(/<(\w+)([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const node = new Node(match[1]);
    const setting = match[2].match(/data-setting="([^"]+)"/);
    if (setting) node.dataset.setting = setting[1];
    nodes.set(match[3], node);
  }
  new Node().append(nodes.get('mainBoard'));
  new Node('label').append(nodes.get('attackSelect'));
  const hint = new Node();
  const document = {
    body: new Node(), hidden: false, events: {},
    getElementById: id => nodes.get(id) || null,
    createElement: tag => new Node(tag),
    querySelector: selector => selector === '.toolbar-hint' ? hint : null,
    querySelectorAll: selector => selector === '[data-setting]' ? all.filter(node => node.dataset.setting) : [],
    addEventListener() {},
  };
  const sockets = [];
  class Socket extends Node {
    static OPEN = 1;
    constructor() { super(); this.readyState = 1; this.sent = []; sockets.push(this); }
    send(message) { this.sent.push(JSON.parse(message)); }
    receive(message) { this.fire('message', { data: JSON.stringify(message) }); }
  }
  const timerCallbacks = new Map();
  let timerId = 0;
  const windowEvents = {};
  const actions = [...html.matchAll(/<button\s+data-action="([^"]+)"/g)].map(match => {
    const button = new Node('button'); button.dataset.action = match[1]; return button;
  });
  document.querySelectorAll = selector => selector === '[data-setting]' ? all.filter(node => node.dataset.setting) : selector === '[data-action]' ? actions : [];
  const context = vm.createContext({ document, WebSocket: Socket,
    location: { protocol: 'http:', host: 'localhost:3001', port: '3001' },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ addresses: [] }) }),
    setInterval(fn) { const id = ++timerId; timerCallbacks.set(id, fn); return id; },
    setTimeout(fn) { const id = ++timerId; timerCallbacks.set(id, fn); return id; },
    clearTimeout(id) { timerCallbacks.delete(id); }, clearInterval(id) { timerCallbacks.delete(id); }, Date, console,
    addEventListener(name, fn) { (windowEvents[name] ||= []).push(fn); }, devicePixelRatio: 1, innerWidth: 1200, innerHeight: 900,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    requestAnimationFrame() { return 1; }, cancelAnimationFrame() {}, performance: { now: () => 1000 },
  });
  context.window = context;
  for (const file of ['rules.js', 'audio.js', 'effects.js', 'app.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../public', file), 'utf8'), context, { filename: file });
  const ws = sockets[0];
  ws.fire('open');
  ws.receive({ type: 'joined', id: '0', token: 'test' });
  const players = [0, 1, 2].map(i => ({ id: String(i), name: `玩家${i}`, team: i % 2 ? 'blue' : 'red', connected: true, ready: true, rank: null,
    game: snapshotGame(createGame(42)) }));
  const room = { code: 'ABCD', hostId: '0', roundId: 1, effects: [], status: 'lobby', settings: { ...Rules.defaults }, players, events: [], serverNow: Date.now() };
  return { nodes, ws, room, actions, timers: timerCallbacks, windowEvents, receive: () => ws.receive({ type: 'state', room }) };
}

test('real client scripts render every mode and attack configuration without runtime errors', () => {
  const { room, receive, nodes } = browserFixture();
  for (const mode of Object.keys(Rules.modes)) {
    room.settings.mode = mode;
    room.status = 'lobby';
    receive();
    assert.equal(nodes.get('modeSelect').value, mode);
    assert.equal(nodes.get('modeDescription').textContent, Rules.modes[mode][1]);
    for (const attack of Object.keys(Rules.attacks)) {
      room.settings.attack = attack;
      room.status = 'playing';
      room.deadline = Date.now() + 10000;
      room.nextEnvironmentAt = mode === 'battle' ? Date.now() + 30000 : null;
      receive();
      assert.match(nodes.get('matchRulesLabel').textContent, new RegExp(Rules.modes[mode][0]));
      assert.equal(nodes.get('playerMonitors').children.length, 3);
    }
  }
});

test('client settings, team and cleanse controls send authoritative protocol actions', () => {
  const { room, receive, nodes, ws } = browserFixture();
  receive();
  const select = nodes.get('modeSelect');
  select.value = 'teams';
  select.fire('change');
  assert.equal(ws.sent.at(-1).type, 'settings');
  assert.equal(ws.sent.at(-1).settings.mode, 'teams');
  nodes.get('teamSelect').value = 'blue';
  nodes.get('teamSelect').fire('change');
  assert.equal(ws.sent.at(-1).team, 'blue');
  room.status = 'playing';
  room.players[0].game.energy = 6;
  receive();
  assert.equal(nodes.get('cleanseButton').disabled, false);
  nodes.get('cleanseButton').fire('click');
  assert.equal(ws.sent.at(-1).action, 'cleanse');
  room.players[0].game.cleanseQueued = true;
  receive();
  assert.equal(nodes.get('cleanseButton').disabled, true);
});

test('countdown shows actual mode, goal, attack and enabled defenses', () => {
  const { room, receive, nodes } = browserFixture();
  room.status = 'countdown';
  room.startsAt = Date.now() + 5000;
  for (const mode of Object.keys(Rules.modes)) {
    room.settings.mode = mode;
    room.settings.attack = 'split';
    receive();
    assert.equal(nodes.get('countdownMode').textContent, Rules.modes[mode][0]);
    assert.equal(nodes.get('countdownNumber').textContent, '5');
    assert.ok(nodes.get('countdownGoal').textContent.length > 5);
    assert.equal(nodes.get('countdownAttack').textContent, mode === 'coop' ? '消行自动救援队友' : !Rules.hostile(room.settings) ? '本局不发送攻击' : Rules.attacks.split[0]);
  }
  room.settings.mode = 'sprint';
  room.settings.goal = 80;
  room.settings.counter = false;
  room.settings.cleanse = false;
  receive();
  assert.match(nodes.get('countdownGoal').textContent, /80/);
  assert.doesNotMatch(nodes.get('countdownDefense').textContent, /V|先抵消/);
});

test('full-screen countdown fades in the final second once, then hides on start', () => {
  const { room, receive, nodes } = browserFixture();
  room.status = 'countdown';
  room.startsAt = Date.now() + 5000;
  receive();
  const modal = nodes.get('countdownModal');
  assert.equal(modal.classes.has('is-hidden'), false);
  assert.equal(nodes.get('boardOverlay').classes.has('is-hidden'), true);
  assert.equal(modal.animations.length, 1);
  assert.equal(modal.animations[0].options.duration, 1000);
  assert.ok(modal.animations[0].options.delay >= 3900);
  assert.equal(modal.animations[0].keyframes[1].opacity, 0);
  receive();
  assert.equal(modal.animations.length, 1);
  room.status = 'playing';
  receive();
  assert.equal(modal.classes.has('is-hidden'), true);
  assert.equal(modal.animations[0].cancelled, true);
});

test('incoming attack shows source name independently of canvas and retains recent attackers', () => {
  const { room, receive, nodes } = browserFixture();
  room.status = 'playing';
  receive();
  const attack = { id: 1, at: Date.now(), sourceId: '1', sourceName: '阿岚', rows: [], targets: [{ targetId: '0', lines: 3 }] };
  room.effects = [attack];
  receive();
  assert.equal(nodes.get('incomingToast').classes.has('is-hidden'), false);
  assert.equal(nodes.get('incomingToastText').textContent, '阿岚 攻击你 +3 行');
  assert.match(nodes.get('incomingNotice').children[0].textContent, /阿岚/);
  receive();
  assert.equal(nodes.get('incomingNotice').children.length, 1);
  room.effects.push({ ...attack, id: 2, sourceName: '小周', sourceId: '2', targets: [{ targetId: '0', lines: 1 }] });
  receive();
  assert.equal(nodes.get('incomingNotice').children.length, 2);
  assert.match(nodes.get('incomingNotice').children[1].textContent, /阿岚/);
  room.status = 'lobby';
  receive();
  assert.equal(nodes.get('incomingNotice').classes.has('is-hidden'), true);
});

test('actual insertion shows hit overlay and actual attacker after the earlier warning', () => {
  const { room, receive, nodes } = browserFixture();
  room.status = 'playing';
  receive();
  room.effects = [{ id: 1, kind: 'clear', at: Date.now(), sourceId: '1', sourceName: '阿岚', rows: [],
    targets: [{ targetId: '0', lines: 4 }] }];
  receive();
  assert.match(nodes.get('incomingToastTitle').textContent, /尚未入盘/);
  room.effects = [{ id: 2, kind: 'hit', at: Date.now(), targetId: '0', lines: 3,
    sources: [{ sourceId: '1', sourceName: '阿岚', lines: 3 }] }];
  room.players[0].game.received = 3;
  receive();
  assert.equal(nodes.get('hitOverlay').classes.has('is-hidden'), false);
  assert.match(nodes.get('hitOverlay').textContent, /阿岚/);
  assert.match(nodes.get('hitOverlay').textContent, /命中 \+3 行/);
  assert.match(nodes.get('incomingToastTitle').textContent, /实际受击/);
  assert.match(nodes.get('incomingNotice').children[0].textContent, /已入盘/);
});

test('preset lobby has one closed customization level and correct new mode summaries', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.equal((html.match(/<details\b/g) || []).length, 1);
  assert.match(html, /<details id="customRules" class="custom-rules">/);
  const { room, receive, nodes, ws } = browserFixture();
  room.presetId = 'friends';
  receive();
  assert.equal(nodes.get('presetSelect').children.length, 10);
  assert.equal(nodes.get('presetSelect').value, 'friends');
  nodes.get('presetSelect').value = 'dig';
  nodes.get('presetSelect').fire('change');
  assert.equal(ws.sent.at(-1).type, 'preset');
  room.settings = { ...Rules.presets.dig.settings };
  room.presetId = 'dig';
  receive();
  assert.match(nodes.get('presetGoal').textContent, /8 行障碍/);
  assert.equal(nodes.get('digRowsField').classes.has('is-hidden'), false);
  room.settings = { ...Rules.presets.coop.settings };
  room.presetId = 'coop';
  room.status = 'playing';
  room.wave = 2;
  room.nextWaveAt = Date.now() + 10000;
  receive();
  assert.match(nodes.get('matchClock').textContent, /2 \/ 5 波/);
  assert.equal(nodes.get('targetName').textContent, '自动救援队友');
  room.status = 'finished';
  room.outcome = { winningTeam: 'coop', winnerIds: ['0', '1', '2'], reason: '团队守城成功', results: [] };
  receive();
  assert.match(nodes.get('finishTitle').textContent, /大家赢了/);
});

test('reserve shows individual rows without numeric quantities and visualizes cancellation only', () => {
  const { room, receive, nodes } = browserFixture();
  room.status = 'playing';
  room.players[0].game.pending = 5;
  receive();
  assert.equal(nodes.get('attackQueue').children.length, 5);
  assert.ok(nodes.get('attackQueue').children.every(row => row.children.length === 10));
  assert.equal(nodes.get('attackValue').textContent, '待入盘');
  room.players[0].game.pending = 3;
  room.players[0].game.cancelled = 2;
  receive();
  assert.equal(nodes.get('attackQueue').children.length, 3);
  assert.equal(nodes.get('cancelledRows').children.length, 2);
  assert.equal(nodes.get('cancelledReserve').classes.has('is-hidden'), false);
  const previous = nodes.get('cancelledRows').children[0];
  receive();
  assert.equal(nodes.get('cancelledRows').children[0], previous, 'duplicate snapshots do not restart cancellation');
  room.players[0].game.pending = 0;
  room.players[0].game.received = 3;
  receive();
  assert.equal(nodes.get('attackValue').textContent, '空');
  assert.equal(nodes.get('cancelledRows').children.length, 2, 'insertion is not reported as cancellation');
  room.roundId = 2;
  receive();
  assert.equal(nodes.get('cancelledRows').children.length, 0);
  assert.equal(nodes.get('cancelledReserve').classes.has('is-hidden'), true);
});

test('reserve does not truncate large queues or replay historical cancellation', () => {
  const { room, receive, nodes } = browserFixture();
  room.status = 'playing';
  room.players[0].game.pending = 25;
  room.players[0].game.cancelled = 10;
  receive();
  assert.equal(nodes.get('attackQueue').children.length, 25);
  assert.equal(nodes.get('cancelledRows').children.length, 0);
});

test('manual target label and selected monitor use previous player, not first opponent', () => {
  const { room, receive, nodes } = browserFixture();
  room.status = 'playing';
  room.settings.attack = 'manual';
  receive();
  assert.equal(nodes.get('targetName').textContent, '玩家2');
  assert.equal(nodes.get('playerMonitors').children[2].attributes['aria-pressed'], 'true');
  room.players[0].targetId = '1';
  receive();
  assert.equal(nodes.get('targetName').textContent, '玩家1');
  room.players[1].game.alive = false;
  receive();
  assert.equal(nodes.get('targetName').textContent, '玩家2');
});

test('eliminated spectator selects effects, clicks board coordinates and cancels drag taps', () => {
  const { room, receive, nodes, ws } = browserFixture();
  room.status = 'playing';
  receive();
  assert.equal(nodes.get('spectatorTools').classes.has('is-hidden'), true);
  room.players[0].game.alive = false;
  receive();
  assert.equal(nodes.get('spectatorTools').classes.has('is-hidden'), false);
  assert.equal(nodes.get('spectatorEffectButtons').children.length, 5);
  const buttons = nodes.get('spectatorEffectButtons').children;
  buttons[1].fire('click');
  assert.equal(buttons[1].attributes['aria-pressed'], 'true');
  assert.equal(buttons[0].attributes['aria-pressed'], 'false');
  const card = nodes.get('playerMonitors').children[1];
  assert.equal(card.disabled, false);
  const before = ws.sent.length;
  card.fire('pointerdown', { pointerId: 1, clientX: 125, clientY: 250 });
  card.fire('pointermove', { pointerId: 1, clientX: 160, clientY: 250 });
  card.fire('click', { detail: 1, clientX: 160, clientY: 250 });
  assert.equal(ws.sent.length, before);
  card.fire('pointerdown', { pointerId: 1, clientX: 250, clientY: 250 });
  card.fire('click', { detail: 1, clientX: 250, clientY: 250 });
  assert.equal(ws.sent.length, before);
  card.fire('pointerdown', { pointerId: 1, clientX: 125, clientY: 250 });
  card.fire('click', { detail: 1, clientX: 125, clientY: 250 });
  const tap = ws.sent.at(-1);
  assert.equal(tap.type, 'spectatorTap');
  assert.equal(tap.targetId, '1');
  assert.equal(tap.effect, 'tomato');
  assert.equal(tap.x, .25);
  assert.equal(tap.y, .75);
});

test('spectator keyboard click uses board center without affecting active-player targeting', () => {
  const { room, receive, nodes, ws } = browserFixture();
  room.status = 'playing';
  room.settings.attack = 'manual';
  receive();
  const card = nodes.get('playerMonitors').children[1];
  card.fire('click', { detail: 0 });
  assert.equal(ws.sent.at(-1).type, 'target');
  room.players[0].game.alive = false;
  receive();
  card.fire('click', { detail: 0 });
  assert.equal(ws.sent.at(-1).type, 'spectatorTap');
  assert.equal(ws.sent.at(-1).x, .5);
  assert.equal(ws.sent.at(-1).y, .5);
});

test('multitouch direction continues while rotating and unrelated pointer release cannot stop it', () => {
  const { room, receive, ws, actions, timers } = browserFixture();
  room.status = 'playing'; receive();
  const left = actions.find(button => button.dataset.action === 'left');
  const rotate = actions.find(button => button.dataset.action === 'rotate');
  left.fire('pointerdown', { pointerId: 1 });
  const delay = Math.max(...timers.keys());
  const callback = timers.get(delay); timers.delete(delay); callback();
  const repeating = Math.max(...timers.keys());
  rotate.fire('pointerdown', { pointerId: 2 });
  rotate.fire('pointerup', { pointerId: 2 });
  assert.equal(timers.has(repeating), true);
  timers.get(repeating)();
  assert.equal(ws.sent.at(-1).action, 'left');
  left.fire('pointerup', { pointerId: 1 });
  assert.equal(timers.has(repeating), false);
  room.players[0].game.alive = false; receive();
  left.fire('pointerdown', { pointerId: 3 });
  assert.equal(ws.sent.at(-1).action, 'left');
  assert.equal(timers.size, 1, 'only overlay update timer remains');
});

test('gesture tap rotates, horizontal drag moves, downward drag soft drops but never hard drops', () => {
  const { room, receive, ws, nodes } = browserFixture();
  room.status = 'playing'; receive();
  nodes.get('inputModeButton').fire('click');
  const board = nodes.get('mainBoard');
  board.fire('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 120, clientY: 120 });
  board.fire('pointerup', { pointerId: 1 });
  assert.equal(ws.sent.at(-1).action, 'rotate');
  board.fire('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 120, clientY: 120 });
  board.fire('pointermove', { pointerId: 2, clientX: 165, clientY: 165 });
  board.fire('pointerup', { pointerId: 2 });
  assert.ok(ws.sent.some(message => message.action === 'right'));
  assert.ok(ws.sent.some(message => message.action === 'down'));
  assert.ok(ws.sent.every(message => message.action !== 'drop'));
  board.fire('pointerdown', { pointerId: 3, pointerType: 'touch', clientX: 120, clientY: 120 });
  room.players[0].game.alive = false; receive();
  const before = ws.sent.length;
  board.fire('pointerup', { pointerId: 3 });
  assert.equal(ws.sent.length, before);
});

test('spectator rapid clicks are sent individually without a local cooldown', () => {
  const { room, receive, nodes, ws } = browserFixture();
  room.status = 'playing';
  room.players[0].game.alive = false;
  receive();
  const card = nodes.get('playerMonitors').children[1];
  const before = ws.sent.length;
  for (let i = 0; i < 30; i++) {
    card.fire('pointerdown', { pointerId: 1, clientX: 125, clientY: 250 });
    card.fire('click', { detail: 1, clientX: 125, clientY: 250 });
  }
  assert.equal(ws.sent.length - before, 30);
  assert.ok(ws.sent.slice(before).every(message => message.type === 'spectatorTap'));
});

test('client renders team/tied results and non-host read-only settings', () => {
  const { room, receive, nodes } = browserFixture();
  room.hostId = '1';
  receive();
  assert.equal(nodes.get('modeSelect').disabled, true);
  room.status = 'finished';
  room.settings.mode = 'teams';
  room.outcome = { winningTeam: 'red', winnerIds: ['0', '2'], reason: '红队获胜', results: room.players.map(player => ({ ...player, lines: 0, score: 0, rank: player.team === 'red' ? 1 : 2, dug: 0, cancelled: 0, purified: 0 })) };
  receive();
  assert.equal(nodes.get('finishTitle').textContent, '红队获胜。');
  assert.equal(nodes.get('rematchButton').disabled, true);
  room.settings.mode = 'timed';
  room.outcome.winningTeam = null;
  receive();
  assert.equal(nodes.get('finishTitle').textContent, '本轮并列获胜。');
});
