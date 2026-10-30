'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function fixture(supported = true) {
  let created = 0;
  const oscillators = [];
  const events = {};
  const param = { setValueAtTime() {}, exponentialRampToValueAtTime() {} };
  let context;
  class Audio {
    constructor() { created++; this.state = 'suspended'; this.currentTime = 1; this.destination = {}; context = this; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    createOscillator() {
      const o = { frequency: param, connect() {}, disconnect() {}, started: false, stopped: false,
        start() { this.started = true; }, stop() { this.stopped = true; } };
      oscillators.push(o); return o;
    }
    createGain() { return { gain: param, connect() {}, disconnect() {} }; }
  }
  const document = { hidden: false, addEventListener(name, fn) { events[name] = fn; } };
  const storage = new Map();
  const root = { document, localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } };
  if (supported) root.AudioContext = Audio;
  root.window = root;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/audio.js'), 'utf8'), root);
  const audio = root.BlockAudio.create();
  return { audio, oscillators, document, events, storage, created: () => created, context: () => context };
}
test('audio creates no context before gesture and schedules clear/hit after unlock', () => {
  const f = fixture();
  f.audio.play('clear', 4);
  assert.equal(f.created(), 0);
  f.audio.unlock();
  f.audio.play('clear', 2);
  assert.equal(f.oscillators.length, 3);
  f.audio.play('hit');
  assert.equal(f.oscillators.length, 5);
  assert.ok(f.oscillators.every(o => o.started));
  f.audio.setEnabled(false);
  assert.equal(f.audio.isEnabled(), false);
  assert.equal(f.storage.get('block-relay-sound'), 'off');
  f.audio.play('clear');
  assert.equal(f.oscillators.length, 5);
  f.audio.setEnabled(true);
  f.audio.play('hit');
  assert.equal(f.oscillators.length, 7);
});
test('audio handles unsupported, hidden pages and polyphony limits', () => {
  const unsupported = fixture(false);
  assert.doesNotThrow(() => { unsupported.audio.unlock(); unsupported.audio.play('hit'); });
  const f = fixture();
  f.audio.unlock();
  for (let i = 0; i < 20; i++) f.audio.play('clear', 4);
  assert.equal(f.oscillators.length, 12);
  f.document.hidden = true;
  f.events.visibilitychange();
  assert.ok(f.oscillators.every(o => o.stopped));
  f.audio.play('hit');
  assert.equal(f.oscillators.length, 12);
});
