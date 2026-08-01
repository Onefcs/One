// ── Sound effects ────────────────────────────────────────────────────────
// Everything here is synthesized on the fly via the Web Audio API — no sound
// files to fetch, license, or ship. Each function is a short envelope over an
// oscillator/noise burst tuned to read as its event (thud, crunch, twinkle,
// horn).
const Sound = (() => {
  let ctx = null;
  let muted = false;
  try { muted = localStorage.getItem('sfxMuted') === '1'; } catch (_) {}

  // AudioContext can't produce sound until a user gesture unlocks it. It's
  // created lazily (first play() call, itself always downstream of a login
  // click) and nudged awake on the page's first pointer/key event too, since
  // Safari in particular won't resume a context created outside a gesture's
  // own call stack.
  function _ctx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
    window.addEventListener(ev, () => _ctx(), { once: true, passive: true }));

  function _tone(freq, dur, { type = 'sine', gain = 0.2, endFreq, delay = 0 } = {}) {
    const c = _ctx();
    if (!c || muted) return;
    const t0 = c.currentTime + delay;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  function _noise(dur, { gain = 0.15, delay = 0, filterFreq = 1200 } = {}) {
    const c = _ctx();
    if (!c || muted) return;
    const t0 = c.currentTime + delay;
    const n = Math.max(1, Math.floor(c.sampleRate * dur));
    const buf = c.createBuffer(1, n, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = c.createBufferSource();
    src.buffer = buf;
    const filt = c.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = filterFreq;
    const g = c.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filt).connect(g).connect(c.destination);
    src.start(t0);
  }

  return {
    // Player's own attack lands on an enemy.
    hit() {
      _tone(180, 0.08, { type: 'square', gain: 0.12, endFreq: 90 });
      _noise(0.05, { gain: 0.08, filterFreq: 2500 });
    },
    // An enemy (or the event boss) dies.
    death() {
      _tone(220, 0.35, { type: 'sawtooth', gain: 0.16, endFreq: 40 });
      _noise(0.25, { gain: 0.12, filterFreq: 900 });
    },
    // Loot lands in the inventory — a kill drop or a world-drop pickup.
    loot() {
      _tone(880, 0.09, { type: 'triangle', gain: 0.14 });
      _tone(1318.5, 0.14, { type: 'triangle', gain: 0.12, delay: 0.07 });
    },
    // The event boss appears.
    bossSpawn() {
      [0, 0.14, 0.28].forEach((d, i) =>
        _tone(98, 0.5, { type: 'sawtooth', gain: 0.18 - i * 0.02, delay: d, endFreq: 82 }));
      _noise(0.6, { gain: 0.1, filterFreq: 400, delay: 0.05 });
    },
    get muted() { return muted; },
    setMuted(v) {
      muted = !!v;
      try { localStorage.setItem('sfxMuted', muted ? '1' : '0'); } catch (_) {}
    },
    toggleMuted() { this.setMuted(!muted); return muted; },
  };
})();
