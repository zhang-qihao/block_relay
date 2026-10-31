'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function fixture(supported = true) {
  let created = 0;
  const oscillators = [];
  const sources = [];
  const gains = [];
  const buffers = [];
  const events = {};
  const param = () => ({ values: [], ramps: [],
    setValueAtTime(...args) { this.values.push(args); },
    exponentialRampToValueAtTime(...args) { this.ramps.push(args); } });
  const source = () => ({ connect() {}, disconnects: 0, started: false, stopped: false,
    disconnect() { this.disconnects++; },
    start(at) { this.started = true; this.startAt = at; },
    stop(at) { this.stopped = true; this.stopAt = at; } });
  let context;
  class Audio {
    constructor() { created++; this.state = 'suspended'; this.currentTime = 1; this.sampleRate = 8000; this.destination = {}; context = this; }
    resume() { this.state = 'running'; return Promise.resolve(); }
    createOscillator() {
      const o = { ...source(), frequency: param() };
      oscillators.push(o); return o;
    }
    createGain() {
      const gain = { gain: param(), connect() {}, disconnects: 0, disconnect() { this.disconnects++; } };
      gains.push(gain); return gain;
    }
    createBuffer(channels, length, rate) {
      const data = new Float32Array(length);
      const buffer = { channels, length, rate, getChannelData: () => data };
      buffers.push(buffer); return buffer;
    }
    createBufferSource() {
      const s = { ...source(), buffer: null };
      sources.push(s); return s;
    }
  }
  const document = { hidden: false, addEventListener(name, fn) { events[name] = fn; } };
  const storage = new Map();
  const root = { document, localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } };
  if (supported) root.AudioContext = Audio;
  root.window = root;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/audio.js'), 'utf8'), root);
  const audio = root.BlockAudio.create();
  return { audio, oscillators, sources, gains, buffers, document, events, storage, created: () => created, context: () => context };
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
test('bomb requires unlock and synthesizes a falling bass with local noise', () => {
  const f = fixture();
  f.audio.play('bomb');
  assert.equal(f.created(), 0);
  assert.equal(f.sources.length, 0);
  f.audio.unlock();
  f.context().state = 'suspended';
  f.audio.play('bomb');
  assert.equal(f.oscillators.length, 0);
  f.audio.unlock();
  f.audio.play('bomb');
  assert.equal(f.oscillators.length, 2);
  assert.equal(f.sources.length, 1);
  assert.equal(f.buffers.length, 1);
  assert.deepEqual(f.oscillators[0].frequency.values, [[150, 1]]);
  assert.deepEqual(f.oscillators[0].frequency.ramps, [[28, 1.55]]);
  assert.ok(f.buffers[0].getChannelData(0).some(value => value !== 0));
  assert.ok(f.buffers[0].getChannelData(0).every(value => Math.abs(value) <= 1));
  assert.equal(f.buffers[0].length, 3040);
  for (const voice of [...f.oscillators, ...f.sources]) {
    assert.ok(voice.started);
    assert.ok(voice.stopAt > voice.startAt && voice.stopAt - voice.startAt < 1);
  }
  const unsupported = fixture(false);
  assert.doesNotThrow(() => { unsupported.audio.unlock(); unsupported.audio.play('bomb'); });
});

test('bomb shares the 12 voice budget and releases nodes and buffers on natural completion', () => {
  const f = fixture();
  f.audio.unlock();
  for (let i = 0; i < 20; i++) f.audio.play('bomb');
  assert.equal(f.oscillators.length, 8);
  assert.equal(f.sources.length, 4);
  assert.equal(f.buffers.length, 4, 'saturated playback does not allocate noise buffers');
  f.audio.play('hit');
  assert.equal(f.oscillators.length, 8, 'bomb and other sounds share the same budget');
  for (const voice of [...f.oscillators, ...f.sources]) { voice.onended(); voice.onended(); }
  assert.ok([...f.oscillators, ...f.sources, ...f.gains].every(node => node.disconnects === 1));
  assert.ok(f.sources.every(source => source.buffer === null));
  f.audio.play('bomb');
  assert.equal(f.oscillators.length, 10);
  assert.equal(f.sources.length, 5, 'completed voices free capacity');
});

for (const mode of ['mute', 'hidden', 'stop']) {
  test(`bomb ${mode} immediately stops and releases active resources`, () => {
    const f = fixture();
    f.audio.unlock();
    f.audio.play('bomb');
    if (mode === 'mute') f.audio.setEnabled(false);
    else if (mode === 'hidden') { f.document.hidden = true; f.events.visibilitychange(); }
    else f.audio.stop();
    const voices = [...f.oscillators, ...f.sources];
    assert.ok(voices.every(voice => voice.stopped && voice.stopAt === undefined));
    assert.ok([...voices, ...f.gains].every(node => node.disconnects === 1));
    assert.equal(f.sources[0].buffer, null);
    for (const voice of voices) voice.onended();
    assert.ok([...voices, ...f.gains].every(node => node.disconnects === 1), 'late ended callbacks are idempotent');
    if (mode !== 'stop') {
      f.audio.play('bomb');
      assert.equal(f.oscillators.length, 2);
      assert.equal(f.sources.length, 1);
      if (mode === 'mute') f.audio.setEnabled(true);
      else f.document.hidden = false;
    }
    f.audio.play('bomb');
    assert.equal(f.sources.length, 2);
  });
}

for (const kind of ['message', 'bombTick']) {
  test(`${kind} respects unlock, mute and background state`, () => {
    const f = fixture();
    f.audio.play(kind); assert.equal(f.created(), 0);
    f.audio.unlock(); f.audio.play(kind);
    assert.equal(f.oscillators.length, kind === 'message' ? 2 : 1);
    const count = f.oscillators.length;
    f.audio.setEnabled(false); f.audio.play(kind);
    assert.equal(f.oscillators.length, count);
    f.audio.setEnabled(true); f.document.hidden = true; f.audio.play(kind);
    assert.equal(f.oscillators.length, count);
  });
}

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
