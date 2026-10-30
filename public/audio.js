(function (root) {
  'use strict';
  function create() {
    let context = null;
    let enabled = true;
    const voices = new Set();
    try { enabled = root.localStorage.getItem('block-relay-sound') !== 'off'; } catch {}
    function stop() {
      for (const voice of voices) { try { voice.stop(); } catch {} }
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
      oscillator.connect(gain);
      gain.connect(context.destination);
      voices.add(oscillator);
      oscillator.onended = () => { voices.delete(oscillator); oscillator.disconnect(); gain.disconnect(); };
      oscillator.start(start);
      oscillator.stop(start + duration + .02);
    }
    function play(kind, lines = 1) {
      if (!enabled || !context || context.state !== 'running' || root.document.hidden) return;
      try {
        const now = context.currentTime;
        if (kind === 'clear') {
          const count = Math.max(1, Math.min(4, lines));
          for (let i = 0; i < count + 1; i++) tone(440 * Math.pow(2, i / 5), now + i * .035, .12, 'triangle', .045);
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
