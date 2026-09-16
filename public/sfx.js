// Criticality duel audio — procedural Web Audio SFX (zero audio assets) plus a
// royalty-free background music track. Everything is fire-and-forget: sounds
// never block input or the turn clock.
// Browsers require a user gesture before audio can start, so the game calls
// SFX.unlock() on the first pointer/key interaction.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : Number(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, String(v)); } catch {} },
};

export const SFX = {
  _ctx: null, _master: null, _sfxBus: null, _musicBus: null, _noise: null,
  _musicEl: null, _musicSrc: null,
  // Play counts per cue — handy for verifying sounds fired in a playtest.
  stats: { whoosh: 0, slam: 0, hit: 0, dot: 0, heal: 0, flick: 0, tick: 0 },
  vol: {
    master: store.get('sfxVolMaster', 0.8),
    sfx: store.get('sfxVolSfx', 0.8),
    music: store.get('sfxVolMusic', 0.35),
  },

  _ok() { return this._ctx && this._ctx.state === 'running'; },

  // Create (or resume) the audio context. Safe to call repeatedly.
  unlock() {
    try {
      if (!this._ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        const c = (this._ctx = new AC());
        this._master = c.createGain();
        this._sfxBus = c.createGain();
        this._musicBus = c.createGain();
        this._sfxBus.connect(this._master);
        this._musicBus.connect(this._master);
        this._master.connect(c.destination);
        this._applyVols();
        // 1s of seeded white noise, reused by every noise-based cue.
        const rand = mulberry32(0xc411ca1);
        const buf = c.createBuffer(1, c.sampleRate, c.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = rand() * 2 - 1;
        this._noise = buf;
      }
      if (this._ctx.state === 'suspended') this._ctx.resume();
    } catch { /* audio unavailable — game plays on silently */ }
  },

  _applyVols() {
    if (!this._ctx) return;
    const t = this._ctx.currentTime;
    this._master.gain.setTargetAtTime(Math.max(0, this.vol.master), t, 0.02);
    this._sfxBus.gain.setTargetAtTime(Math.max(0, this.vol.sfx), t, 0.02);
    this._musicBus.gain.setTargetAtTime(Math.max(0, this.vol.music) * 0.6, t, 0.02);
  },

  // kind: 'master' | 'sfx' | 'music', v: 0..1
  setVol(kind, v) {
    this.vol[kind] = Math.max(0, Math.min(1, v));
    store.set('sfxVol' + kind[0].toUpperCase() + kind.slice(1), this.vol[kind]);
    this._applyVols();
  },

  // Mute toggle: zeroes master but remembers the previous level to restore.
  toggleMute() {
    if (this.vol.master > 0) {
      this._preMute = this.vol.master;
      this.setVol('master', 0);
    } else {
      this.setVol('master', this._preMute > 0 ? this._preMute : 0.8);
    }
  },

  _tone({ f = 440, f1 = null, type = 'sine', dur = 0.2, vol = 0.2, at = 0 }) {
    if (!this._ok()) return;
    try {
      const c = this._ctx, t0 = c.currentTime + at;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t0);
      if (f1) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(vol, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
      o.connect(g); g.connect(this._sfxBus);
      o.start(t0); o.stop(t0 + dur + 0.05);
    } catch {}
  },

  _noiseHit({ dur = 0.3, vol = 0.3, type = 'bandpass', f = 1000, f1 = null, q = 1, at = 0 }) {
    if (!this._ok()) return;
    try {
      const c = this._ctx, t0 = c.currentTime + at;
      const src = c.createBufferSource(); src.buffer = this._noise; src.loop = true;
      const flt = c.createBiquadFilter(); flt.type = type; flt.Q.value = q;
      flt.frequency.setValueAtTime(f, t0);
      if (f1) flt.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
      const g = c.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(vol, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
      src.connect(flt); flt.connect(g); g.connect(this._sfxBus);
      src.start(t0); src.stop(t0 + dur + 0.05);
    } catch {}
  },

  /* ---- the cue set ---- */

  // Card leaves the hand and arcs to board center.
  whoosh() { this.stats.whoosh++; this._noiseHit({ dur: 0.55, vol: 0.32, type: 'bandpass', f: 600, f1: 4200, q: 1.4 }); },

  // The slam beat: card punches down and dissolves.
  slam() {
    this.stats.slam++;
    this._tone({ f: 95, f1: 36, type: 'sine', dur: 0.3, vol: 0.5 });
    this._noiseHit({ dur: 0.22, vol: 0.22, type: 'lowpass', f: 320 });
  },

  // Hit impact, scaled by damage like the visuals.
  hit(amount = 0) {
    this.stats.hit++;
    const t = Math.max(0, Math.min(1, amount / 1200));
    this._tone({ f: 170, f1: 55, type: 'triangle', dur: 0.18 + 0.2 * t, vol: 0.25 + 0.35 * t });
    this._noiseHit({ dur: 0.1 + 0.16 * t, vol: 0.2 + 0.3 * t, type: 'highpass', f: 800 });
    if (amount >= 500) this._tone({ f: 62, f1: 30, type: 'sine', dur: 0.35, vol: 0.4 });
  },

  // Subtle DoT tick.
  dot() { this.stats.dot++; this._tone({ f: 1400, type: 'square', dur: 0.045, vol: 0.07 }); },

  // Heal / HoT.
  heal() {
    this.stats.heal++;
    this._tone({ f: 659, dur: 0.18, vol: 0.16 });
    this._tone({ f: 880, dur: 0.24, vol: 0.16, at: 0.09 });
  },

  // Discard flick.
  flick() { this.stats.flick++; this._noiseHit({ dur: 0.07, vol: 0.14, type: 'highpass', f: 2500 }); },

  // Turn timer running down (last 5s).
  tick() { this.stats.tick++; this._tone({ f: 1050, type: 'square', dur: 0.035, vol: 0.055 }); },

  // Buff-sequence blips during the card showcase: rising for damage-up, falling for damage-down.
  buffUp() { this._tone({ f: 520, f1: 780, type: 'sine', dur: 0.09, vol: 0.12 }); },
  buffDown() { this._tone({ f: 520, f1: 340, type: 'sine', dur: 0.09, vol: 0.12 }); },

  /* ---- background music ---- */

  _ensureMusic() {
    if (this._musicEl) return true; // already built — allow restart after pause
    if (!this._ctx) return false;
    try {
      const el = document.createElement('audio');
      el.src = 'audio/duel-theme.mp3';
      el.loop = true;
      el.preload = 'auto';
      this._musicSrc = this._ctx.createMediaElementSource(el);
      this._musicSrc.connect(this._musicBus);
      this._musicEl = el;
      return true;
    } catch { return false; }
  },

  // Start the duel theme. Autoplay policy may reject the first attempt when
  // called outside a user gesture — the game retries on the next pointerdown.
  musicStart() {
    this.unlock();
    if (!this._ensureMusic()) return;
    try {
      const p = this._musicEl.play();
      if (p && p.catch) p.catch(() => {
        const retry = () => { this.unlock(); this._musicEl.play().catch(() => {}); };
        document.addEventListener('pointerdown', retry, { once: true });
        document.addEventListener('keydown', retry, { once: true });
      });
    } catch {}
  },

  musicStop() {
    try { if (this._musicEl) this._musicEl.pause(); } catch {}
  },
};
