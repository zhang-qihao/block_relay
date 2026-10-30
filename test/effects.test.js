'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(reduced = false) {
  let time = 1000;
  let sequence = 0;
  const frames = new Map();
  const calls = [];
  const resolved = [];
  const listeners = {};
  const animations = [];
  const incoming = [];
  const hits = [];
  const ctx = new Proxy({}, {
    get: (target, name) => name === 'measureText' ? value => ({ width: value.length * 10 }) :
      (...args) => calls.push({ name, args, color: target.fillStyle, stroke: target.strokeStyle }),
    set: (target, name, value) => { target[name] = value; return true; },
  });
  const rects = {
    self: { left: 200, top: 50, width: 300, height: 600, right: 500, bottom: 650 },
    other: { left: 700, top: 200, width: 90, height: 180, right: 790, bottom: 380 },
    third: { left: 850, top: 200, width: 90, height: 180, right: 940, bottom: 380 },
  };
  const makeElement = id => ({
    getBoundingClientRect: () => rects[id],
    animate() {
      const animation = { cancelled: false, cancel() { this.cancelled = true; }, finished: new Promise(() => {}) };
      animations.push(animation);
      return animation;
    },
  });
  const elements = Object.fromEntries(Object.keys(rects).map(id => [id, makeElement(id)]));
  const document = { hidden: false, addEventListener(name, fn) { listeners[name] = fn; } };
  const motion = { matches: reduced, addEventListener() {} };
  const root = {
    document, innerWidth: 1100, innerHeight: 800, devicePixelRatio: 1,
    matchMedia: () => motion, performance: { now: () => time },
    requestAnimationFrame(fn) { const id = ++sequence; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  root.window = root;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/effects.js'), 'utf8'), root);
  const controller = root.BlockEffects.create({
    canvas: { width: 0, height: 0, getContext: () => ctx },
    onIncoming: attack => incoming.push(attack),
    onHit: hit => hits.push(hit),
    resolve(id) { resolved.push(id); return elements[id] ? { element: elements[id], name: id } : null; },
  });
  function frame(at) {
    time = at;
    const callbacks = [...frames.values()];
    frames.clear();
    for (const fn of callbacks) fn(at);
  }
  const row = { y: 19, cells: Array(10).fill('I') };
  const room = { code: 'ABCD', roundId: 1, status: 'playing', effects: [] };
  function event(id, sourceId = 'self', targets = [{ targetId: 'other', lines: 2 }]) {
    return { id, sourceId, targets, rows: [row], cancelled: 0, at: 1000 };
  }
  controller.sync(room, 'self', 1000);
  return { controller, calls, resolved, frames, frame, rects, room, event, document, listeners, animations, incoming, hits };
}

test('effects play outgoing/incoming and third-party attacks using player board anchors', () => {
  const f = fixture();
  f.room.effects = [f.event(1), f.event(2, 'other', [{ targetId: 'self', lines: 3 }]), f.event(3, 'other', [{ targetId: 'third', lines: 1 }])];
  f.controller.sync(f.room, 'self', 1000);
  assert.equal(f.frames.size, 1);
  f.frame(1100);
  assert.ok(f.resolved.includes('self') && f.resolved.includes('other') && f.resolved.includes('third'));
  f.frame(1500);
  assert.ok(f.calls.some(call => call.name === 'fillText' && call.args[0] === 'other → 你 +3' && call.color === '#ed8198'));
  assert.ok(f.calls.some(call => call.name === 'fillText' && call.args[0] === 'self → other +2' && call.color === '#53d9e5'));
  f.frame(1900);
  assert.ok(f.calls.some(call => call.name === 'fillText' && call.args[0] === 'other 攻击你 +3 行'));
  assert.ok(f.animations.length >= 2);
  f.frame(2700);
  assert.equal(f.frames.size, 0, 'RAF stops after all effects finish');
});

test('repeated snapshots do not replay, reconnect and new room establish a fresh baseline', () => {
  const f = fixture();
  f.room.effects = [f.event(10)];
  f.controller.sync(f.room, 'self', 1000);
  f.frame(2700);
  f.controller.sync(f.room, 'self', 1000);
  assert.equal(f.frames.size, 0);
  f.controller.clear(true);
  f.room.effects.push(f.event(11));
  f.controller.sync(f.room, 'self', 1000);
  assert.equal(f.frames.size, 0, 'first reconnect state must not replay history');
  f.room.code = 'EFGH';
  f.room.effects = [];
  f.controller.sync(f.room, 'self', 1000);
  f.room.effects.push(f.event(1));
  f.controller.sync(f.room, 'self', 1000);
  assert.equal(f.frames.size, 1, 'old room IDs do not suppress new room events');
});

test('all/split multiple destinations play, fully cancelled clears do not cause impacts', () => {
  const f = fixture();
  f.room.effects = [f.event(1, 'self', [{ targetId: 'other', lines: 2 }, { targetId: 'third', lines: 1 }])];
  f.controller.sync(f.room, 'self', 1000);
  f.frame(1950);
  assert.ok(f.resolved.includes('other') && f.resolved.includes('third'));
  assert.equal(f.animations.length, 2);
  f.controller.clear(true);
  f.room.effects = [];
  f.controller.sync(f.room, 'self', 1000);
  f.room.effects = [{ ...f.event(2, 'self', []), cancelled: 2 }];
  const before = f.animations.length;
  f.controller.sync(f.room, 'self', 1000);
  f.frame(2000);
  assert.equal(f.animations.length, before);
  assert.ok(f.calls.some(call => call.name === 'fillText' && /抵消 2/.test(call.args[0])));
});

test('reduced motion shows directional labels but no movement or shake', () => {
  const f = fixture(true);
  f.room.effects = [f.event(1), f.event(2, 'other', [{ targetId: 'self', lines: 3 }])];
  f.controller.sync(f.room, 'self', 1000);
  assert.equal(f.incoming[0].sourceName, 'other');
  assert.equal(f.incoming[0].lines, 3);
  f.frame(1300);
  assert.ok(f.calls.some(call => call.name === 'fillText' && /self → other \+2/.test(call.args[0])));
  assert.equal(f.animations.length, 0);
  assert.equal(f.calls.filter(call => call.name === 'translate').length, 0);
  f.frame(1800);
  assert.equal(f.frames.size, 0);
});

test('offscreen mobile target uses a visible edge with its name, never scrolls', () => {
  const f = fixture();
  f.rects.other = { left: 1300, top: 900, right: 1390, bottom: 1080, width: 90, height: 180 };
  f.room.effects = [f.event(1)];
  f.controller.sync(f.room, 'self', 1000);
  f.frame(1900);
  const hit = f.calls.find(call => call.name === 'fillText' && /other \+2 待接收/.test(call.args[0]));
  assert.ok(hit);
  assert.ok(hit.args[1] >= 0 && hit.args[1] <= 1100 && hit.args[2] <= 800);
  assert.equal(f.animations.length, 0, 'offscreen board is not shaken');
});

test('incoming source is announced even without source geometry or row animation data', () => {
  const f = fixture();
  const attack = { ...f.event(1, 'departed', [{ targetId: 'self', lines: 4 }]), sourceName: '阿岚', rows: [] };
  f.room.effects = [attack];
  f.controller.sync(f.room, 'self', 1000);
  assert.equal(f.incoming.length, 1);
  assert.equal(f.incoming[0].sourceName, '阿岚');
  assert.equal(f.incoming[0].lines, 4);
  f.controller.sync(f.room, 'self', 1000);
  assert.equal(f.incoming.length, 1);
  f.room.effects.push({ ...f.event(2, 'departed', [{ targetId: 'self', lines: 2 }]), sourceName: '阿岚' });
  f.controller.sync(f.room, 'self', 1000);
  f.frame(1500);
  assert.ok(f.calls.some(call => call.name === 'fillText' && /阿岚 → 你/.test(call.args[0])));
});

test('actual hit plays at garbage insertion even long after launch and without cleared rows', () => {
  const f = fixture();
  f.room.effects = [f.event(1, 'other', [{ targetId: 'self', lines: 3 }])];
  f.controller.sync(f.room, 'self', 1000);
  f.frame(2700);
  assert.equal(f.hits.length, 0);
  f.room.effects = [{ id: 2, kind: 'hit', at: 8000, targetId: 'self', lines: 2,
    sources: [{ sourceId: 'other', sourceName: '阿岚', lines: 2 }] }];
  f.controller.sync(f.room, 'self', 8000);
  assert.equal(f.hits.length, 1);
  assert.equal(f.hits[0].sources[0].sourceName, '阿岚');
  f.frame(2900);
  assert.ok(f.calls.some(call => call.name === 'fillText' && /实际受击 \+2 行/.test(call.args[0])));
  f.controller.sync(f.room, 'self', 8000);
  assert.equal(f.hits.length, 1);
});

test('returning from a hidden tab does not swallow the first new hit snapshot', () => {
  const f = fixture();
  f.document.hidden = true;
  f.listeners.visibilitychange();
  f.document.hidden = false;
  f.room.effects = [{ id: 1, kind: 'hit', at: 1000, targetId: 'self', lines: 2,
    sources: [{ sourceId: 'other', sourceName: '阿岚', lines: 2 }] }];
  f.controller.sync(f.room, 'self', 1000);
  assert.equal(f.hits.length, 1);
  assert.equal(f.frames.size, 1);
});

test('cooperative rescue uses green feedback without an attack warning', () => {
  const f = fixture();
  f.room.effects = [{ id: 1, kind: 'rescue', at: 1000, sourceId: 'other', sourceName: '队友', targets: [{ targetId: 'self', lines: 2 }] }];
  f.controller.sync(f.room, 'self', 1000);
  f.frame(1300);
  assert.equal(f.incoming.length, 0);
  assert.equal(f.hits.length, 0);
  assert.ok(f.calls.some(call => call.name === 'fillText' && /救援 −2 行/.test(call.args[0]) && call.color === '#77d5ad'));
});

test('stale events, hidden tabs and lobby transitions cannot replay attacks', () => {
  const f = fixture();
  f.room.effects = [f.event(1)];
  f.controller.sync(f.room, 'self', 4000);
  assert.equal(f.frames.size, 0);
  f.room.effects.push(f.event(2));
  f.controller.sync(f.room, 'self', 1000);
  f.frame(1900);
  f.document.hidden = true;
  f.listeners.visibilitychange();
  assert.equal(f.frames.size, 0);
  assert.ok(f.animations.every(animation => animation.cancelled));
  f.document.hidden = false;
  f.controller.sync(f.room, 'self', 1000);
  assert.equal(f.frames.size, 0);
  f.room.status = 'lobby';
  f.room.effects.push(f.event(3));
  f.controller.sync(f.room, 'self', 1000);
  assert.equal(f.frames.size, 0);
});
