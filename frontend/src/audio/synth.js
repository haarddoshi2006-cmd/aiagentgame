// Procedural Web Audio SFX bank. Zero dependencies. Zero asset files.
// Every sound is synthesized on demand from oscillators + envelopes.

const STORAGE_KEY = 'simians:audio';

let ctx = null;
let masterGain = null;
let muted = false;
let masterVolume = 0.35;

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (typeof parsed.muted === 'boolean') muted = parsed.muted;
    if (typeof parsed.volume === 'number') masterVolume = parsed.volume;
  } catch (_) {}
}
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ muted, volume: masterVolume })); } catch (_) {}
}
load();

function ensureCtx() {
  if (ctx) return ctx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  masterGain = ctx.createGain();
  masterGain.gain.value = muted ? 0 : masterVolume;
  masterGain.connect(ctx.destination);
  return ctx;
}

/** Chain BGM into the same graph as SFX so mute/volume and browser context limits stay sane. */
export function getSfxMasterGain() {
  return ensureCtx() ? masterGain : null;
}
function applyVolume() {
  if (!masterGain) return;
  masterGain.gain.setTargetAtTime(muted ? 0 : masterVolume, ctx.currentTime, 0.02);
}

export const audio = {
  unlock() { const c = ensureCtx(); if (c && c.state === 'suspended') c.resume(); },
  isMuted() { return muted; },
  setMuted(v) { muted = !!v; ensureCtx(); applyVolume(); save(); },
  toggleMute() { this.setMuted(!muted); return muted; },
  getVolume() { return masterVolume; },
  setMasterVolume(v) { masterVolume = Math.max(0, Math.min(1, v)); ensureCtx(); applyVolume(); save(); },
};

function tone({ freq = 440, dur = 0.1, type = 'square', gain = 0.4, attack = 0.005, release = 0.05, slideTo = null, delay = 0 }) {
  const c = ensureCtx(); if (!c || muted) return;
  const t0 = c.currentTime + delay;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + release);
  o.connect(g).connect(masterGain);
  o.start(t0); o.stop(t0 + dur + release + 0.02);
}

function noise({ dur = 0.1, gain = 0.3, filterFreq = 2000, delay = 0 }) {
  const c = ensureCtx(); if (!c || muted) return;
  const t0 = c.currentTime + delay;
  const buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1);
  const src = c.createBufferSource(); src.buffer = buf;
  const filt = c.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = filterFreq;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filt).connect(g).connect(masterGain);
  src.start(t0); src.stop(t0 + dur + 0.05);
}

function chord(freqs, { dur = 0.18, type = 'triangle', gain = 0.25, stagger = 0.06 } = {}) {
  freqs.forEach((f, i) => tone({ freq: f, dur, type, gain, delay: i * stagger }));
}

export const sfx = {
  click:        () => tone({ freq: 880, dur: 0.03, type: 'square', gain: 0.18 }),
  hover:        () => tone({ freq: 1320, dur: 0.02, type: 'square', gain: 0.08 }),
  open:         () => tone({ freq: 660, dur: 0.08, type: 'triangle', gain: 0.2, slideTo: 990 }),
  close:        () => tone({ freq: 660, dur: 0.08, type: 'triangle', gain: 0.2, slideTo: 330 }),
  type:         () => tone({ freq: 1400 + Math.random() * 600, dur: 0.012, type: 'square', gain: 0.06 }),
  commit:       () => { for (let i = 0; i < 5; i++) tone({ freq: 1100 + Math.random() * 500, dur: 0.018, type: 'square', gain: 0.12, delay: i * 0.025 }); },
  prOpen:       () => { tone({ freq: 520, dur: 0.08, type: 'sine', gain: 0.22, slideTo: 880 }); noise({ dur: 0.08, gain: 0.08, filterFreq: 4000, delay: 0.02 }); },
  prMerged:     () => chord([523.25, 659.25, 783.99, 1046.5], { dur: 0.16, type: 'triangle', gain: 0.28, stagger: 0.07 }),
  buildPass:    () => chord([784, 1046.5], { dur: 0.12, type: 'sine', gain: 0.25, stagger: 0.05 }),
  buildFail:    () => { [440, 330, 247, 196].forEach((f, i) => tone({ freq: f, dur: 0.18, type: 'sawtooth', gain: 0.22, delay: i * 0.09 })); },
  standup:      () => { tone({ freq: 880, dur: 0.18, type: 'sine', gain: 0.22 }); tone({ freq: 1318, dur: 0.22, type: 'sine', gain: 0.18, delay: 0.08 }); },
  retro:        () => noise({ dur: 0.45, gain: 0.18, filterFreq: 800 }),
  cash:         () => { tone({ freq: 1318, dur: 0.05, type: 'square', gain: 0.22 }); tone({ freq: 1568, dur: 0.07, type: 'square', gain: 0.22, delay: 0.05 }); },
  cashLoss:     () => { tone({ freq: 660, dur: 0.06, type: 'square', gain: 0.2, slideTo: 330 }); },
  hire:         () => chord([523, 659, 784, 1046, 1318], { dur: 0.18, type: 'square', gain: 0.22, stagger: 0.06 }),
  fire:         () => { noise({ dur: 0.18, gain: 0.4, filterFreq: 600 }); tone({ freq: 110, dur: 0.35, type: 'sawtooth', gain: 0.3, slideTo: 55, delay: 0.05 }); },
  achievement:  () => { [659, 784, 988, 1318, 1568].forEach((f, i) => tone({ freq: f, dur: 0.1, type: 'square', gain: 0.22, delay: i * 0.06 })); },
  event:        () => { tone({ freq: 1200, dur: 0.05, type: 'square', gain: 0.2 }); tone({ freq: 1600, dur: 0.05, type: 'square', gain: 0.2, delay: 0.07 }); tone({ freq: 1200, dur: 0.05, type: 'square', gain: 0.2, delay: 0.14 }); },
  warn:         () => { tone({ freq: 220, dur: 0.18, type: 'sawtooth', gain: 0.2 }); tone({ freq: 220, dur: 0.18, type: 'sawtooth', gain: 0.2, delay: 0.22 }); },
  gameOver:     () => { [392, 349, 311, 261, 196].forEach((f, i) => tone({ freq: f, dur: 0.35, type: 'triangle', gain: 0.28, delay: i * 0.18 })); },
  praise:       () => chord([784, 988, 1318], { dur: 0.14, type: 'sine', gain: 0.24, stagger: 0.05 }),
  criticize:    () => { tone({ freq: 330, dur: 0.1, type: 'sawtooth', gain: 0.22 }); tone({ freq: 247, dur: 0.14, type: 'sawtooth', gain: 0.22, delay: 0.08 }); },
  coach:        () => { tone({ freq: 660, dur: 0.08, type: 'triangle', gain: 0.2 }); tone({ freq: 990, dur: 0.1, type: 'triangle', gain: 0.2, delay: 0.06 }); },
};
