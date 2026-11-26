/* Casnt preset sound effects: synthesised with WebAudio, so there are no sound files.
   Works in the Casnt window and in overlays (browser sources). In Node it only exposes the list. */
(function (root) {
  'use strict';

  const LIST = [
    ['airhorn', 'Air horn', '📯'], ['applause', 'Applause', '👏'], ['fanfare', 'Fanfare', '🎺'], ['levelup', 'Level up', '⬆️'],
    ['coin', 'Coin', '🪙'], ['cash', 'Ka-ching', '💰'], ['ding', 'Ding', '🔔'], ['pop', 'Pop', '🫧'],
    ['whoosh', 'Whoosh', '💨'], ['laser', 'Laser', '🔫'], ['boing', 'Boing', '🦘'], ['drumroll', 'Drum roll', '🥁'],
    ['rimshot', 'Ba-dum-tss', '🥁'], ['sadtrombone', 'Sad trombone', '😢'], ['explosion', 'Explosion', '💥'], ['siren', 'Siren', '🚨'],
    ['heartbeat', 'Heartbeat', '💓'], ['magic', 'Magic', '✨'], ['error', 'Error buzz', '❌'], ['alarm', 'Alarm', '⏰'],
    ['jump', '8-bit jump', '🍄'], ['powerup', 'Power up', '⭐'], ['gameover', 'Game over', '👾'], ['thunder', 'Thunder', '⛈️'],
    ['crickets', 'Crickets', '🦗'], ['bubble', 'Bubbles', '🫧'], ['quack', 'Quack', '🦆'], ['bonk', 'Bonk', '🔨'],
  ];
  const SOUND_IDS = LIST.map((x) => x[0]);

  if (typeof module === 'object' && module.exports && typeof window === 'undefined') {
    module.exports = { LIST, SOUND_IDS };
    return;
  }

  let ctx = null;
  function ac() { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); return ctx; }

  function tone(out, t, dur, f1, f2, type = 'sine', vol = 0.3, attack = 0.005) {
    const a = ac(), o = a.createOscillator(), g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f1, t);
    if (f2 && f2 !== f1) o.frequency.exponentialRampToValueAtTime(Math.max(1, f2), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(out);
    o.start(t); o.stop(t + dur + 0.05);
  }

  let noiseBuf = null;
  function noise(out, t, dur, vol = 0.3, filter = 'lowpass', freq = 2000, q = 1, freqEnd) {
    const a = ac();
    if (!noiseBuf) {
      noiseBuf = a.createBuffer(1, a.sampleRate * 2, a.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const s = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
    s.buffer = noiseBuf;
    f.type = filter; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f).connect(g).connect(out);
    s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }

  const R = {
    airhorn(o, t) { for (let i = 0; i < 3; i++) { const s = t + i * 0.28; [440, 554, 659].forEach((f) => tone(o, s, 0.24, f, f * 0.98, 'sawtooth', 0.12)); } },
    applause(o, t) { for (let i = 0; i < 60; i++) noise(o, t + Math.random() * 1.6, 0.05, 0.25, 'bandpass', 1500 + Math.random() * 2500, 2); noise(o, t, 1.8, 0.08, 'bandpass', 2500, 0.5); },
    fanfare(o, t) { [[523, 0, 0.15], [523, 0.15, 0.15], [523, 0.3, 0.15], [659, 0.45, 0.5], [523, 0.95, 0.15], [659, 1.1, 0.6]].forEach(([f, d, l]) => { tone(o, t + d, l, f, f, 'square', 0.12); tone(o, t + d, l, f * 1.5, f * 1.5, 'sawtooth', 0.05); }); },
    levelup(o, t) { [523, 659, 784, 1047, 1319].forEach((f, i) => tone(o, t + i * 0.08, 0.14, f, f, 'square', 0.12)); tone(o, t + 0.4, 0.5, 1568, 1568, 'triangle', 0.15); },
    coin(o, t) { tone(o, t, 0.08, 988, 988, 'square', 0.15); tone(o, t + 0.08, 0.35, 1319, 1319, 'square', 0.15); },
    cash(o, t) { noise(o, t, 0.08, 0.4, 'highpass', 3000); tone(o, t + 0.05, 0.6, 2093, 2093, 'triangle', 0.25); tone(o, t + 0.12, 0.6, 2637, 2637, 'triangle', 0.18); },
    ding(o, t) { tone(o, t, 1.2, 1318, 1318, 'sine', 0.35); tone(o, t, 1.0, 2636, 2636, 'sine', 0.08); },
    pop(o, t) { tone(o, t, 0.09, 400, 1400, 'sine', 0.45, 0.002); },
    whoosh(o, t) { noise(o, t, 0.6, 0.45, 'bandpass', 300, 1.5, 4000); },
    laser(o, t) { tone(o, t, 0.35, 1800, 120, 'sawtooth', 0.18); },
    boing(o, t) { const a = ac(), osc = a.createOscillator(), g = a.createGain(), l = a.createOscillator(), lg = a.createGain();
      osc.frequency.value = 220; l.frequency.value = 14; lg.gain.value = 60; l.connect(lg).connect(osc.frequency);
      osc.frequency.exponentialRampToValueAtTime(440, t + 0.5); g.gain.setValueAtTime(0.3, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      osc.connect(g).connect(o); osc.start(t); l.start(t); osc.stop(t + 0.75); l.stop(t + 0.75); },
    drumroll(o, t) { for (let i = 0; i < 28; i++) noise(o, t + i * 0.055, 0.06, 0.15 + i * 0.01, 'bandpass', 900, 1); noise(o, t + 1.6, 0.6, 0.5, 'highpass', 4000); tone(o, t + 1.6, 0.3, 120, 60, 'sine', 0.6); },
    rimshot(o, t) { tone(o, t, 0.15, 180, 90, 'sine', 0.5); tone(o, t + 0.18, 0.15, 160, 80, 'sine', 0.5); noise(o, t + 0.38, 0.7, 0.35, 'highpass', 6000); },
    sadtrombone(o, t) { [[392, 0, 0.35], [370, 0.4, 0.35], [349, 0.8, 0.35], [330, 1.2, 0.9]].forEach(([f, d, l]) => tone(o, t + d, l, f, d > 1 ? f * 0.94 : f, 'sawtooth', 0.12)); },
    explosion(o, t) { noise(o, t, 1.6, 0.9, 'lowpass', 1200, 1, 60); tone(o, t, 0.8, 90, 30, 'sine', 0.8); },
    siren(o, t) { const a = ac(), osc = a.createOscillator(), g = a.createGain(); osc.type = 'square';
      for (let i = 0; i < 4; i++) { osc.frequency.setValueAtTime(660, t + i * 0.5); osc.frequency.linearRampToValueAtTime(990, t + i * 0.5 + 0.25); osc.frequency.linearRampToValueAtTime(660, t + i * 0.5 + 0.5); }
      g.gain.setValueAtTime(0.08, t); g.gain.setValueAtTime(0.08, t + 1.9); g.gain.exponentialRampToValueAtTime(0.0001, t + 2.0); osc.connect(g).connect(o); osc.start(t); osc.stop(t + 2.05); },
    heartbeat(o, t) { for (let i = 0; i < 3; i++) { tone(o, t + i * 0.8, 0.15, 70, 50, 'sine', 0.8); tone(o, t + i * 0.8 + 0.22, 0.15, 65, 45, 'sine', 0.6); } },
    magic(o, t) { for (let i = 0; i < 12; i++) tone(o, t + i * 0.05, 0.4, 1200 + i * 180, 1200 + i * 180, 'sine', 0.08); },
    error(o, t) { tone(o, t, 0.25, 140, 140, 'square', 0.15); tone(o, t + 0.3, 0.4, 110, 110, 'square', 0.15); },
    alarm(o, t) { for (let i = 0; i < 6; i++) tone(o, t + i * 0.2, 0.12, 1800, 1800, 'square', 0.1); },
    jump(o, t) { tone(o, t, 0.25, 300, 900, 'square', 0.15); },
    powerup(o, t) { for (let i = 0; i < 10; i++) tone(o, t + i * 0.045, 0.06, 300 + i * 90, 300 + i * 90, 'square', 0.12); },
    gameover(o, t) { [494, 466, 440, 415].forEach((f, i) => tone(o, t + i * 0.3, 0.28, f, f, 'square', 0.12)); tone(o, t + 1.2, 0.8, 392, 380, 'square', 0.12); },
    thunder(o, t) { noise(o, t, 0.2, 0.8, 'highpass', 2000); noise(o, t + 0.1, 2.5, 0.9, 'lowpass', 400, 1, 40); },
    crickets(o, t) { for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) tone(o, t + j * 0.5 + i * 0.04, 0.03, 4500, 4500, 'sine', 0.12); },
    bubble(o, t) { for (let i = 0; i < 8; i++) tone(o, t + i * 0.09 + Math.random() * 0.04, 0.08, 300 + Math.random() * 300, 900 + Math.random() * 600, 'sine', 0.2, 0.002); },
    quack(o, t) { for (let i = 0; i < 2; i++) { tone(o, t + i * 0.25, 0.18, 520, 380, 'sawtooth', 0.15); noise(o, t + i * 0.25, 0.15, 0.1, 'bandpass', 1200, 4); } },
    bonk(o, t) { tone(o, t, 0.25, 900, 200, 'triangle', 0.5, 0.001); noise(o, t, 0.08, 0.3, 'bandpass', 2500, 3); },
  };

  /** Play a preset (or a custom file URL) at volume 0..100. */
  function play(id, volume = 80, customUrl) {
    try {
      const a = ac();
      if (a.state === 'suspended') a.resume();
      const g = a.createGain();
      g.gain.value = Math.max(0, Math.min(2, volume / 100));
      g.connect(a.destination);
      if (customUrl) {
        const el = new Audio(customUrl);
        el.volume = Math.max(0, Math.min(1, volume / 100));
        el.play().catch(() => {});
        return true;
      }
      const r = R[id];
      if (!r) return false;
      r(g, a.currentTime + 0.02);
      return true;
    } catch (_) { return false; }
  }

  root.CasntSfx = { LIST, SOUND_IDS, play };
})(typeof window !== 'undefined' ? window : globalThis);
