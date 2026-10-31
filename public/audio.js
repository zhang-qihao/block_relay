(function (root) {
  'use strict';
  function create() {
    let context = null;
    let enabled = true;
    const voices = new Set();
    try { enabled = root.localStorage.getItem('block-relay-sound') !== 'off'; } catch {}
    function stop() {
      for (const voice of voices) {
        try { voice.stop(); } catch {}
        voice.onended();
      }
      voices.clear();
    }
    function unlock() {
      if (!enabled || root.document.hidden) return;
      try {
        const Audio = root.AudioContext || root.webkitAudioContext;
        if (!Audio) return;
        if (!context) context = new Audio();
        if (context.state === 'suspended') Promise.resolve(context.resume()).catch(() => {});
      } catch { context = null; }
    }
    function setEnabled(value) {
      enabled = Boolean(value);
      try { root.localStorage.setItem('block-relay-sound', enabled ? 'on' : 'off'); } catch {}
      if (!enabled) stop();
      else unlock();
    }
    function connectVoice(source, gain) {
      voices.add(source);
      source.onended = () => {
        if (!voices.delete(source)) return;
        source.disconnect();
        gain.disconnect();
        if ('buffer' in source) source.buffer = null;
      };
      source.connect(gain);
      gain.connect(context.destination);
    }
    function tone(frequency, start, duration, type, volume, endFrequency) {
      if (voices.size >= 12) return;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, start);
      if (endFrequency) oscillator.frequency.exponentialRampToValueAtTime(endFrequency, start + duration);
      gain.gain.setValueAtTime(.001, start);
      gain.gain.exponentialRampToValueAtTime(volume, start + .008);
      gain.gain.exponentialRampToValueAtTime(.001, start + duration);
      connectVoice(oscillator, gain);
      oscillator.start(start);
      oscillator.stop(start + duration + .02);
    }
    function burst(start) {
      if (voices.size >= 12) return;
      const duration = .38;
      const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * duration), context.sampleRate);
      const samples = buffer.getChannelData(0);
      // Locally generated, softened noise: no downloads or persistent sample cache.
      let low = 0;
      for (let i = 0; i < samples.length; i++) {
        const noise = Math.random() * 2 - 1;
        low = low * .75 + noise * .25;
        samples[i] = low * .8 + noise * .2;
      }
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = buffer;
      connectVoice(source, gain);
      gain.gain.setValueAtTime(.001, start);
      gain.gain.exponentialRampToValueAtTime(.18, start + .008);
      gain.gain.exponentialRampToValueAtTime(.001, start + duration);
      source.start(start);
      source.stop(start + duration + .02);
    }
    function play(kind, lines = 1) {
      if (!enabled || !context || context.state !== 'running' || root.document.hidden) return;
      try {
        const now = context.currentTime;
        if (kind === 'clear') {
          const count = Math.max(1, Math.min(4, lines));
          for (let i = 0; i < count + 1; i++) tone(440 * Math.pow(2, i / 5), now + i * .035, .12, 'triangle', .045);
        } else if (kind === 'message') {
          tone(660, now, .09, 'sine', .04);
          tone(880, now + .08, .12, 'sine', .03);
        } else if (kind === 'bombTick') {
          tone(1000, now, .055, 'triangle', .035, 750);
        } else if (kind === 'bomb') {
          tone(150, now, .55, 'sine', .11, 28);
          tone(85, now + .015, .32, 'triangle', .055, 32);
          burst(now);
        } else if (kind === 'hit') {
          tone(150, now, .23, 'sawtooth', .035, 48);
          tone(68, now + .02, .22, 'sine', .07, 35);
        }
      } catch { stop(); }
    }
    root.document.addEventListener('visibilitychange', () => { if (root.document.hidden) stop(); });
    return { unlock, play, stop, setEnabled, isEnabled: () => enabled };
  }
  root.BlockAudio = { create };
})(window);
