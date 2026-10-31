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

function browserFixture(width = 1200) {
  const drawing = new Proxy({}, { get: (target, name) => target[name] || (() => {}), set: (target, name, value) => { target[name] = value; return true; } });
  const nodes = new Map();
  const all = [];
  class Node {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.type = ''; this.dataset = {}; this.children = [];
      this.textContent = ''; this.value = ''; this.checked = false; this.disabled = false;
      this.events = {}; this.className = ''; this.attributes = {}; this.animations = [];
      this.style = { values: {}, setProperty(name, value) { this.values[name] = value; }, removeProperty(name) { delete this.values[name]; } };
      this.open = false;
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
    fire(name, extra = {}) { for (const fn of this.events[name] || []) fn({ target: this, preventDefault() {}, stopPropagation() {}, ...extra }); }
    setAttribute(name, value) { this.attributes[name] = value; }
    getContext() { return drawing; }
    getBoundingClientRect() { return { left: 100, top: 100, right: 200, bottom: 300, width: 100, height: 200 }; }
    focus() { this.focused = true; }
    showModal() { this.open = true; }
    close() { this.open = false; }
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
  const audioEvents = [];
  const timerCallbacks = new Map();
  let timerId = 0;
  const windowEvents = {};
  const actions = [...html.matchAll(/<button\s+data-action="([^"]+)"/g)].map(match => {
    const button = new Node('button'); button.dataset.action = match[1]; return button;
  });
  document.querySelectorAll = selector => selector === '[data-setting]' ? all.filter(node => node.dataset.setting) : selector === '[data-action]' ? actions : selector === '.kick-button' ? all.filter(node => node.className.split(' ').includes('kick-button')) : [];
  const viewport = { height: 780, offsetTop: 0, scale: 1, events: {}, addEventListener(name, fn) { (this.events[name] ||= []).push(fn); } };
  const scrolls = [];
  const context = vm.createContext({ document, WebSocket: Socket, visualViewport: viewport,
    scrollTo(...args) { scrolls.push(args); },
    location: { protocol: 'http:', host: 'localhost:3001', port: '3001' },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    fetch: () => Promise.resolve({ json: () => Promise.resolve({ addresses: [] }) }),
    setInterval(fn) { const id = ++timerId; timerCallbacks.set(id, fn); return id; },
    setTimeout(fn) { const id = ++timerId; timerCallbacks.set(id, fn); return id; },
    clearTimeout(id) { timerCallbacks.delete(id); }, clearInterval(id) { timerCallbacks.delete(id); }, Date, console,
    addEventListener(name, fn) { (windowEvents[name] ||= []).push(fn); }, devicePixelRatio: 1, innerWidth: width, innerHeight: 900,
    confirm: () => true,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    requestAnimationFrame() { return 1; }, cancelAnimationFrame() {}, performance: { now: () => 1000 },
  });
  context.window = context;
  for (const file of ['rules.js', 'audio.js', 'effects.js', 'app.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../public', file), 'utf8'), context, { filename: file });
  vm.runInContext('audio.play = kind => audioEvents.push(kind)', Object.assign(context, { audioEvents }));
  const ws = sockets[0];
  ws.fire('open');
  ws.receive({ type: 'joined', id: '0', token: 'test' });
  const players = [0, 1, 2].map(i => ({ id: String(i), name: `玩家${i}`, team: i % 2 ? 'blue' : 'red', connected: true, ready: true, rank: null,
    game: snapshotGame(createGame(42)) }));
  const room = { code: 'ABCD', hostId: '0', roundId: 1, effects: [], status: 'lobby', settings: { ...Rules.defaults }, players, events: [], serverNow: Date.now() };
  return { nodes, ws, room, actions, audioEvents, viewport, scrolls, document, context, timers: timerCallbacks, windowEvents, body: document.body, receive: () => ws.receive({ type: 'state', room }) };
}

test('viewport lock is scoped to waiting room and released on match or leave', () => {
  const { room, receive, ws, body } = browserFixture();
  receive();
  assert.equal(body.classes.has('waiting-visible'), true);
  room.status = 'playing'; receive();
  assert.equal(body.classes.has('waiting-visible'), false);
  room.status = 'lobby'; receive();
  assert.equal(body.classes.has('waiting-visible'), true);
  ws.receive({ type: 'left' });
  assert.equal(body.classes.has('waiting-visible'), false);
});

test('mobile waiting room tracks visible viewport and resets scroll only on entry', () => {
  const { room, receive, nodes, viewport, scrolls, document, ws } = browserFixture(390);
  let blurs = 0;
  document.activeElement = { blur() { blurs++; } };
  receive();
  const style = nodes.get('roomView').style.values;
  assert.equal(style['--room-viewport-height'], '780px');
  assert.equal(style['--room-viewport-top'], '0px');
  assert.deepEqual(scrolls, [[0, 0]]);
  assert.equal(blurs, 1);
  receive();
  assert.equal(blurs, 1, 'snapshots never dismiss the chat keyboard');
  viewport.height = 430; viewport.offsetTop = 42;
  viewport.events.resize.forEach(fn => fn());
  assert.equal(style['--room-viewport-height'], '430px');
  assert.equal(style['--room-viewport-top'], '42px');
  viewport.height = 300; viewport.scale = 2;
  viewport.events.resize.forEach(fn => fn());
  assert.equal(style['--room-viewport-height'], '430px');
  viewport.scale = 1; viewport.height = 844; viewport.offsetTop = 0;
  viewport.events.resize.forEach(fn => fn());
  assert.equal(style['--room-viewport-height'], '844px');
  assert.equal(style['--room-viewport-top'], '0px');
  room.status = 'playing'; receive();
  assert.equal(style['--room-viewport-height'], undefined);
  room.status = 'lobby'; receive();
  ws.receive({ type: 'left' });
  assert.equal(style['--room-viewport-height'], undefined);
});

test('waiting viewport falls back without VisualViewport and leaves desktop layout alone', () => {
  const mobile = browserFixture(375);
  mobile.context.visualViewport = undefined;
  mobile.receive();
  assert.equal(mobile.nodes.get('roomView').style.values['--room-viewport-height'], '900px');
  const desktop = browserFixture(1440); desktop.receive();
  assert.equal(desktop.nodes.get('roomView').style.values['--room-viewport-height'], undefined);
  assert.equal(desktop.scrolls.length, 0);
});

test('real client scripts render every mode and attack configuration without runtime errors', () => {
  const { room, receive, nodes } = browserFixture();
  for (const mode of Object.keys(Rules.modes)) {
    room.settings.mode = mode;
    room.status = 'lobby';
    receive();
    assert.equal(nodes.get('presetGoal').textContent, Rules.summary(room.settings)[0]);
    assert.equal(nodes.get('attackSelect').disabled, !Rules.hostile(room.settings));
    for (const attack of Object.keys(Rules.attacks)) {
      room.settings.attack = attack;
      room.status = 'playing';
      room.deadline = Date.now() + 10000;
      room.nextEnvironmentAt = room.settings.randomGarbage ? Date.now() + 30000 : null;
      receive();
      assert.match(nodes.get('matchRulesLabel').textContent, new RegExp(Rules.modes[mode][0]));
      assert.equal(nodes.get('playerMonitors').children.length, 3);
    }
  }
});

test('client settings, team and cleanse controls send authoritative protocol actions', () => {
  const { room, receive, nodes, ws } = browserFixture();
  receive();
  const select = nodes.get('attackSelect');
  select.value = 'manual';
  select.fire('change');
  assert.equal(ws.sent.at(-1).type, 'settings');
  assert.equal(ws.sent.at(-1).settings.attack, 'manual');
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

test('cleanse button displays live energy and queued or disabled state', () => {
  const { room, receive, nodes } = browserFixture();
  room.status = 'playing';
  for (const energy of [0, 3, 6, 12]) {
    room.players[0].game.energy = energy;
    receive();
    assert.equal(nodes.get('cleanseButton').textContent, `净化 ${energy}/6`);
    assert.equal(nodes.get('cleanseButton').disabled, energy < 6);
  }
  room.players[0].game.cleanseQueued = true; receive();
  assert.equal(nodes.get('cleanseButton').textContent, '已预约 12/6');
  room.settings.cleanse = false; receive();
  assert.equal(nodes.get('cleanseButton').textContent, '净化已关闭');
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
  assert.equal(nodes.has('incomingToast'), false);
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

test('actual insertion retains attacker below board without a blocking popup', () => {
  const { room, receive, nodes } = browserFixture();
  room.status = 'playing';
  receive();
  room.effects = [{ id: 1, kind: 'clear', at: Date.now(), sourceId: '1', sourceName: '阿岚', rows: [],
    targets: [{ targetId: '0', lines: 4 }] }];
  receive();
  assert.match(nodes.get('incomingNotice').children[0].textContent, /来袭/);
  room.effects = [{ id: 2, kind: 'hit', at: Date.now(), targetId: '0', lines: 3,
    sources: [{ sourceId: '1', sourceName: '阿岚', lines: 3 }] }];
  room.players[0].game.received = 3;
  receive();
  assert.equal(nodes.has('hitOverlay'), false);
  assert.match(nodes.get('incomingNotice').children[0].textContent, /阿岚/);
  assert.match(nodes.get('incomingNotice').children[0].textContent, /已入盘/);
});

test('preset lobby exposes only preset and attack distribution with fixed rule summaries', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.equal((html.match(/<details\b/g) || []).length, 0);
  assert.doesNotMatch(html, /id="(?:modeSelect|customRules)"/);
  assert.match(html, /<dialog id="ruleOptionsDialog"/);
  const { room, receive, nodes, ws } = browserFixture();
  room.presetId = 'friends';
  receive();
  assert.equal(nodes.get('presetSelect').children.length, Object.keys(Rules.presets).length);
  assert.equal(nodes.get('presetSelect').value, 'friends');
  nodes.get('presetSelect').value = 'dig';
  nodes.get('presetSelect').fire('change');
  assert.equal(ws.sent.at(-1).type, 'preset');
  room.settings = { ...Rules.presets.dig.settings };
  room.presetId = 'dig';
  receive();
  assert.match(nodes.get('presetGoal').textContent, /8 行障碍/);
  assert.equal(nodes.get('attackSelect').disabled, true);
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

test('optional rules dialog synchronizes tags, permissions and mode-specific controls', () => {
  const { room, receive, nodes, ws } = browserFixture();
  room.presetId = 'timed'; room.settings = { ...Rules.presets.timed.settings };
  receive();
  nodes.get('openRuleOptions').fire('click');
  assert.equal(nodes.get('ruleOptionsDialog').open, true);
  assert.equal(nodes.get('durationField').classes.has('is-hidden'), false);
  assert.equal(nodes.get('goalField').classes.has('is-hidden'), true);
  nodes.get('durationSelect').value = '60'; nodes.get('durationSelect').fire('change');
  assert.equal(ws.sent.at(-1).settings.duration, 60);
  room.settings.duration = 60; receive();
  assert.ok(nodes.get('ruleTags').children.some(tag => tag.textContent === '比赛时长：1 分钟'));
  assert.equal(nodes.get('presetSelect').value, 'timed');
  const combo = nodes.get('ruleToggles').children.find(label => label.children[0].dataset.option === 'combo').children[0];
  combo.checked = true; combo.fire('change');
  assert.equal(ws.sent.at(-1).settings.combo, true);
  room.settings.combo = true; receive();
  assert.ok(nodes.get('ruleTags').children.some(tag => tag.textContent === '连击奖励：开'));
  room.hostId = '1'; receive();
  assert.equal(combo.disabled, true);
  assert.equal(nodes.get('durationSelect').disabled, true);
  const count = ws.sent.length;
  combo.fire('change'); assert.equal(ws.sent.length, count);
  room.hostId = '0'; room.settings = { ...Rules.presets.coop.settings }; receive();
  const counter = nodes.get('ruleToggles').children.find(label => label.children[0].dataset.option === 'counter').children[0];
  assert.equal(counter.disabled, true);
  assert.equal(nodes.get('wavesField').classes.has('is-hidden'), false);
  assert.equal(nodes.get('durationField').classes.has('is-hidden'), true);
  room.settings = { ...Rules.presets.dig.settings }; receive();
  assert.equal(nodes.get('digRowsField').classes.has('is-hidden'), false);
  assert.ok(nodes.get('ruleToggles').children.filter(label => !['randomGarbage', 'hotPotato'].includes(label.children[0].dataset.option)).every(label => label.classes.has('is-hidden')));
  nodes.get('ruleOptionsDialog').fire('keydown', { key: 'Escape' });
  assert.equal(nodes.get('ruleOptionsDialog').open, false);
  nodes.get('openRuleOptions').fire('click');
  ws.fire('close'); assert.equal(nodes.get('digRowsSelect').disabled, true);
  room.status = 'countdown'; room.startsAt = Date.now() + 5000; receive();
  assert.equal(nodes.get('ruleOptionsDialog').open, false);
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

test('public directory filters code/host safely, joins with nickname and disables unavailable rooms', () => {
  const { nodes, ws } = browserFixture();
  const rooms = [
    { code: 'ABCD', hostName: '<img onerror=bad>', mode: 'survival', presetId: 'friends', players: 2, online: 2, maxPlayers: 6, status: 'lobby', joinable: true },
    { code: 'EFGH', hostName: '小周', mode: 'coop', presetId: 'coop', players: 3, online: 3, maxPlayers: 6, status: 'playing', joinable: false },
  ];
  ws.receive({ type: 'roomList', rooms });
  assert.equal(nodes.get('roomDirectoryList').children.length, 2);
  assert.equal(nodes.get('roomDirectoryList').children[0].children[0].children[1].textContent, '房主：<img onerror=bad>');
  nodes.get('roomSearchInput').value = 'abcd';
  nodes.get('roomSearchInput').fire('input');
  assert.equal(nodes.get('roomDirectoryList').children.length, 1);
  nodes.get('nameInput').value = '测试玩家';
  nodes.get('roomDirectoryList').children[0].children[2].fire('click');
  assert.equal(ws.sent.at(-1).type, 'join');
  assert.equal(ws.sent.at(-1).code, 'ABCD');
  assert.equal(ws.sent.at(-1).name, '测试玩家');
  nodes.get('roomSearchInput').value = '小周'; nodes.get('roomSearchInput').fire('input');
  assert.equal(nodes.get('roomDirectoryList').children[0].children[2].disabled, true);
  nodes.get('roomSearchInput').value = '没有'; nodes.get('roomSearchInput').fire('input');
  assert.equal(nodes.get('roomDirectoryList').children.length, 0);
  assert.match(nodes.get('roomDirectoryMessage').textContent, /没有匹配/);
  nodes.get('roomSearchInput').value = ''; nodes.get('roomSearchInput').fire('input');
  ws.fire('close');
  assert.ok(nodes.get('roomDirectoryList').children.every(row => row.children[2].disabled));
  assert.match(nodes.get('roomDirectoryMessage').textContent, /连接中断/);
});

test('chat is text-only, deduplicated, preserves draft on errors and clears on leave', () => {
  const { room, receive, nodes, ws } = browserFixture();
  receive();
  ws.receive({ type: 'chatHistory', code: room.code, messages: [] });
  nodes.get('chatInput').value = '你好';
  nodes.get('chatInput').fire('keydown', { key: 'Enter', isComposing: true });
  assert.notEqual(ws.sent.at(-1)?.type, 'chat');
  nodes.get('chatInput').fire('keydown', { key: 'Enter', isComposing: false });
  assert.equal(ws.sent.at(-1).text, '你好');
  const message = { id: 1, at: Date.now(), name: '<img>', sourceId: '0', text: '<script>你好</script>' };
  ws.receive({ type: 'chatMessage', code: room.code, message });
  assert.equal(nodes.get('chatMessages').children[0].children[1].textContent, message.text);
  ws.receive({ type: 'chatMessage', code: room.code, message });
  assert.equal(nodes.get('chatMessages').children.length, 1);
  ws.receive({ type: 'chatMessage', code: 'OTHER', message: { ...message, id: 2 } });
  assert.equal(nodes.get('chatMessages').children.length, 1);
  nodes.get('chatInput').value = '保留草稿';
  nodes.get('chatForm').fire('submit');
  ws.receive({ type: 'chatError', code: room.code, message: '发送太快' });
  assert.equal(nodes.get('chatInput').value, '保留草稿');
  assert.match(nodes.get('chatStatus').textContent, /太快/);
  ws.fire('close');
  assert.equal(nodes.get('chatSend').disabled, true);
  ws.receive({ type: 'left' });
  assert.equal(nodes.get('chatMessages').children.length, 0);
  assert.equal(nodes.get('chatInput').value, '');
});

test('chat limit error releases pending send and preserves draft for retry', () => {
  const { room, receive, nodes, ws } = browserFixture();
  receive();
  nodes.get('chatInput').value = '限流后重试';
  nodes.get('chatForm').fire('submit');
  assert.equal(nodes.get('chatSend').disabled, true);
  assert.equal(nodes.get('chatStatus').textContent, '正在发送…');
  ws.receive({ type: 'chatError', code: room.code, message: '发送太快，请稍后再试。' });
  assert.equal(nodes.get('chatInput').value, '限流后重试');
  assert.equal(nodes.get('chatSend').disabled, false);
  const before = ws.sent.length;
  nodes.get('chatForm').fire('submit');
  assert.equal(ws.sent.length, before + 1);
  assert.equal(ws.sent.at(-1).text, '限流后重试');
  ws.receive({ type: 'chatMessage', code: room.code, message: { id: 1, at: Date.now(), sourceId: '0', name: '玩家0', text: '限流后重试' } });
  assert.equal(nodes.get('chatInput').value, '');
  assert.equal(nodes.get('chatSend').disabled, false);
});

test('focusing chat cancels directional repeat and new messages do not force scroll while reading', () => {
  const { room, receive, nodes, actions, timers, ws } = browserFixture();
  room.status = 'playing'; receive();
  actions.find(button => button.dataset.action === 'left').fire('pointerdown', { pointerId: 1 });
  const delay = Math.max(...timers.keys());
  nodes.get('chatInput').fire('focus');
  assert.equal(timers.has(delay), false);
  const list = nodes.get('chatMessages');
  list.scrollHeight = 1000; list.clientHeight = 200; list.scrollTop = 100;
  ws.receive({ type: 'chatMessage', code: room.code, message: { id: 1, at: Date.now(), name: '朋友', sourceId: '1', text: '新消息' } });
  assert.equal(list.scrollTop, 100);
  assert.match(nodes.get('chatUnread').textContent, /新消息/);
  nodes.get('chatLatest').fire('click');
  assert.equal(list.scrollTop, 1000);
});

test('bomb controls follow holder, clear quota and connection while mini boards track transfers', () => {
  const { room, receive, nodes, ws } = browserFixture();
  room.status = 'playing'; room.settings.hotPotato = true;
  room.bomb = { holderId: '0', cleared: 0, lit: true };
  receive();
  assert.equal(nodes.get('passBombButton').disabled, true);
  assert.equal(nodes.get('mainBombBadge').classes.has('is-hidden'), false);
  assert.equal(nodes.get('mainBombBadge').querySelector('.bomb-art').src, '/bomb.svg');
  assert.equal(nodes.get('mainBombBadge').querySelector('.bomb-caption').textContent, '[0/1]按B传递！');
  assert.equal(nodes.get('mainBoard').parentElement.classes.has('has-bomb'), true);
  assert.equal(nodes.get('mainBoard').parentElement.classes.has('bomb-lit'), true);
  room.bomb.cleared = 1; receive();
  assert.equal(nodes.get('mainBombBadge').querySelector('.bomb-caption').textContent, '[1/1]按B传递！');
  assert.equal(nodes.get('passBombButton').disabled, false);
  nodes.get('passBombButton').fire('click');
  assert.equal(ws.sent.at(-1).type, 'passBomb');
  room.bomb = { holderId: '1', cleared: 0, lit: true }; receive();
  assert.equal(nodes.get('passBombButton').disabled, true);
  assert.equal(nodes.get('mainBombBadge').classes.has('is-hidden'), true);
  const cards = nodes.get('playerMonitors').children;
  assert.equal(cards[1].classes.has('has-bomb'), true);
  assert.equal(cards[0].classes.has('has-bomb'), false);
  assert.equal(cards[1].querySelector('.bomb-caption').textContent, '消 1 行可传');
  assert.equal(cards[1].querySelector('.monitor-detail').children[0], cards[1].querySelector('.bomb-badge'));
  assert.equal(cards[1].querySelector('.bomb-art').src, '/bomb.svg');
  assert.equal(cards[1].querySelector('.bomb-badge').classes.has('is-lit'), true);
  assert.equal(cards[1].querySelector('canvas').classes.has('bomb-lit'), true);
  assert.equal(nodes.get('mainBoard').parentElement.classes.has('has-bomb'), false);
  assert.equal(nodes.get('mainBoard').parentElement.classes.has('bomb-lit'), false);
  room.bomb = { holderId: '0', cleared: 1, lit: true }; receive();
  ws.fire('close');
  assert.equal(nodes.get('mainBoard').parentElement.classes.has('bomb-lit'), false);
  assert.equal(nodes.get('mainBoard').parentElement.classes.has('has-bomb'), true);
  assert.equal(cards[1].querySelector('canvas').classes.has('has-bomb'), false);
  assert.equal(nodes.get('passBombButton').disabled, true);
  room.status = 'lobby'; room.bomb = null; receive();
  assert.equal(nodes.get('bombPanel').classes.has('is-hidden'), true);
});

test('new remote chat beeps once, history and own echoes stay silent', () => {
  const { room, receive, ws, audioEvents } = browserFixture(); receive();
  const message = { id: 1, at: Date.now(), sourceId: '1', name: '朋友', text: '你好' };
  ws.receive({ type: 'chatHistory', code: room.code, messages: [message] });
  assert.deepEqual(audioEvents, []);
  ws.receive({ type: 'chatMessage', code: room.code, message: { ...message, id: 2 } });
  ws.receive({ type: 'chatMessage', code: room.code, message: { ...message, id: 2 } });
  ws.receive({ type: 'chatMessage', code: room.code, message: { ...message, id: 3, sourceId: '0' } });
  assert.deepEqual(audioEvents, ['message']);
});

test('bomb ticks only on new local flash pulses and stops after passing', () => {
  const { room, receive, audioEvents } = browserFixture();
  room.status = 'playing'; room.settings.hotPotato = true;
  room.bomb = { holderId: '0', cleared: 0, lit: false }; receive();
  room.bomb.lit = true; receive(); receive();
  assert.equal(audioEvents.filter(kind => kind === 'bombTick').length, 1);
  room.bomb.lit = false; receive(); room.bomb.lit = true; receive();
  assert.equal(audioEvents.filter(kind => kind === 'bombTick').length, 2);
  room.bomb.holderId = '1'; receive(); room.bomb.lit = false; receive(); room.bomb.lit = true; receive();
  assert.equal(audioEvents.filter(kind => kind === 'bombTick').length, 2);
});

test('inline kick buttons are host-only in lobby and match without intercepting board controls', () => {
  const { room, receive, nodes, ws } = browserFixture(); receive();
  assert.equal(nodes.has('managePlayersButton'), false);
  assert.equal(nodes.has('managePlayersDialog'), false);
  const roster = nodes.get('waitingRoster').children;
  assert.equal(roster[0].querySelector('.kick-button'), null);
  roster[1].querySelector('.kick-button').fire('click');
  assert.equal(ws.sent.at(-1).type, 'kick');
  assert.equal(ws.sent.at(-1).id, '1');
  room.status = 'playing'; receive();
  const card = nodes.get('playerMonitors').children[1];
  assert.equal(card.tagName, 'DIV');
  let stopped = false;
  card.querySelector('.kick-button').fire('click', { stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
  assert.equal(ws.sent.at(-1).type, 'kick');
  room.hostId = '1'; receive();
  assert.equal(card.querySelector('.kick-button').classes.has('is-hidden'), true);
  const before = ws.sent.length;
  card.querySelector('.kick-button').fire('click');
  assert.equal(ws.sent.length, before);
  ws.receive({ type: 'kicked', message: '你已被房主移出房间。' });
  assert.equal(nodes.get('lobbyView').classes.has('is-hidden'), false);
  assert.match(nodes.get('lobbyMessage').textContent, /移出/);
});

test('host can add difficulty-selected bots while guests cannot', () => {
  const { room, receive, nodes, ws } = browserFixture(); receive();
  assert.equal(nodes.get('botControls').classes.has('is-hidden'), false);
  nodes.get('botLevelSelect').value = 'hard';
  nodes.get('addBotButton').fire('click');
  assert.equal(ws.sent.at(-1).type, 'addBot');
  assert.equal(ws.sent.at(-1).level, 'hard');
  room.hostId = '1'; receive();
  assert.equal(nodes.get('botControls').classes.has('is-hidden'), true);
  const before = ws.sent.length;
  nodes.get('addBotButton').fire('click');
  assert.equal(ws.sent.length, before);
});

test('nickname input limits twelve characters, respects composition and trims on blur and join', () => {
  const { nodes, ws } = browserFixture();
  const input = nodes.get('nameInput');
  input.value = '一二三四五六七八九十十一十二';
  input.fire('input', { isComposing: true });
  assert.equal(input.value, '一二三四五六七八九十十一十二');
  input.fire('compositionend');
  assert.equal(Array.from(input.value).length, 12);
  input.value = '😀'.repeat(13);
  input.fire('input');
  assert.equal(input.value, '😀'.repeat(12));
  input.value = '  小 方块  ';
  input.fire('blur');
  assert.equal(input.value, '小 方块');
  input.value = '  玩家  ';
  nodes.get('createButton').fire('click');
  assert.equal(ws.sent.at(-1).name, '玩家');
  assert.equal(input.value, '玩家');
  input.value = '长'.repeat(14);
  nodes.get('roomInput').value = 'ABCD';
  nodes.get('joinButton').fire('click');
  assert.equal(ws.sent.at(-1).name, '长'.repeat(12));
});

test('leaderboard displays only fixed top-three places and escaped names', () => {
  const { nodes, ws } = browserFixture();
  const entries = Array.from({ length: 5 }, (_, i) => ({ name: i === 0 ? '<img>' : `玩家${i}`, score: 1000 - i, mode: 'survival', rank: i + 1, at: i }));
  ws.receive({ type: 'leaderboardList', entries, storage: 'saved', available: true });
  const podium = nodes.get('leaderboardPodium');
  assert.equal(podium.children.length, 3);
  assert.equal(podium.children[0].children[1].textContent, '<img>');
  assert.equal(nodes.has('leaderboardList'), false);
  assert.equal(nodes.get('leaderboardStatus').textContent, '');
  ws.receive({ type: 'leaderboardList', entries: entries.slice(0, 1), storage: 'saved', available: true });
  assert.equal(podium.children[1].children[1].textContent, '等你上榜');
  ws.receive({ type: 'leaderboardList', entries: [], storage: 'error', available: false });
  assert.match(nodes.get('leaderboardStatus').textContent, /异常/);
});

test('leaderboard mode selector shows independent podiums, empty modes and live updates', () => {
  const { nodes, ws } = browserFixture();
  const select = nodes.get('leaderboardModeSelect');
  assert.equal(select.children.length, Object.keys(Rules.modes).length);
  assert.equal(select.value, 'survival');
  const entries = Object.keys(Rules.modes).filter(mode => mode !== 'coop').flatMap(mode =>
    Array.from({ length: 4 }, (_, i) => ({ name: `${mode}${i}`, mode, score: 100 - i, at: i, rank: i + 1 })));
  ws.receive({ type: 'leaderboardList', entries, storage: 'saved', available: true });
  for (const mode of Object.keys(Rules.modes).filter(mode => mode !== 'coop')) {
    select.value = mode;
    select.fire('change');
    assert.deepEqual(nodes.get('leaderboardPodium').children.map(node => node.children[1].textContent), [0, 1, 2].map(i => `${mode}${i}`));
    assert.ok(nodes.get('leaderboardPodium').children.every(node => node.children[1].textContent !== `${mode}3`));
  }
  select.value = 'coop'; select.fire('change');
  assert.ok(nodes.get('leaderboardPodium').children.every(node => node.children[1].textContent === '等你上榜'));
  assert.equal(nodes.has('leaderboardList'), false);
  assert.equal(nodes.get('leaderboardStatus').textContent, '');
  ws.receive({ type: 'leaderboardList', entries: [...entries, { name: '守城冠军', mode: 'coop', score: 10, at: 1, rank: 1 }], storage: 'saved', available: true });
  assert.equal(select.value, 'coop');
  assert.equal(nodes.get('leaderboardPodium').children[0].children[1].textContent, '守城冠军');
  nodes.get('refreshLeaderboardButton').fire('click');
  assert.equal(ws.sent.at(-1).type, 'leaderboard');
  assert.equal(select.value, 'coop');
});

test('finder opens from the join row, preserves errors and closes after joining', () => {
  const { nodes, ws, receive } = browserFixture(1440);
  nodes.get('findRoomsButton').fire('click');
  assert.equal(nodes.get('roomFinder').open, true);
  assert.equal(nodes.get('roomSearchInput').focused, true);
  assert.equal(ws.sent.at(-1).type, 'rooms');
  ws.receive({ type: 'error', message: '房间已经开始' });
  assert.equal(nodes.get('roomFinder').open, true);
  assert.equal(nodes.get('roomFinderError').textContent, '房间已经开始');
  ws.receive({ type: 'joined', id: '0', token: 'test' });
  assert.equal(nodes.get('roomFinder').open, false);
  receive();
  assert.equal(nodes.get('chatPanel').style.values['--chat-height'], '200px');
  nodes.get('waitingPanel').getBoundingClientRect = () => ({ height: 1200 });
  receive();
  assert.equal(nodes.get('chatPanel').style.values['--chat-height'], '1200px');
});

test('client renders team/tied results and non-host read-only settings', () => {
  const { room, receive, nodes } = browserFixture();
  room.hostId = '1';
  receive();
  assert.equal(nodes.get('presetSelect').disabled, true);
  assert.equal(nodes.get('attackSelect').disabled, true);
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
