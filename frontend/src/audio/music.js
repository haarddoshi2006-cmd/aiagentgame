// Adaptive 2-layer chiptune background music. Zero dependencies.
// Crossfades between calm and tense layers based on company state.

import { getSfxMasterGain } from './synth.js';

let ctx = null;
let masterGain = null;
let calmGain = null;
let tenseGain = null;
let timer = null;
let step = 0;
let running = false;
let baseVolume = 0.60;

const CALM_PROG  = [
  [261.63, 329.63, 392.00],
  [220.00, 277.18, 329.63],
  [174.61, 220.00, 261.63],
  [196.00, 246.94, 293.66],
];
const TENSE_PROG = [
  [196.00, 233.08, 293.66],
  [174.61, 207.65, 261.63],
  [155.56, 185.00, 233.08],
  [146.83, 174.61, 220.00],
];
const STEP_MS = 220;

function ensureCtx() {
  if (ctx) return ctx;
  const sfxMaster = getSfxMasterGain();
  if (!sfxMaster) return null;
  ctx = sfxMaster.context;
  masterGain = ctx.createGain();
  masterGain.gain.value = baseVolume;
  masterGain.connect(sfxMaster);
  calmGain = ctx.createGain(); calmGain.gain.value = 1.0; calmGain.connect(masterGain);
  tenseGain = ctx.createGain(); tenseGain.gain.value = 0.0; tenseGain.connect(masterGain);
  return ctx;
}

function blip(destGain, freq, type, dur, gain) {
  if (!ctx) return;
  const t0 = ctx.currentTime;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(destGain);
  o.start(t0); o.stop(t0 + dur + 0.02);
}

function tick() {
  if (!running || !ctx) return;
  const beat = step % 8;
  const bar  = Math.floor(step / 8) % 4;
  const calmChord = CALM_PROG[bar];
  blip(calmGain, calmChord[beat % 3], 'triangle', 0.18, 0.22);
  if (beat === 0) blip(calmGain, calmChord[0] / 2, 'sine', 0.4, 0.18);
  const tenseChord = TENSE_PROG[bar];
  blip(tenseGain, tenseChord[beat % 3], 'square', 0.14, 0.16);
  if (beat % 4 === 0) blip(tenseGain, tenseChord[0] / 2, 'sawtooth', 0.3, 0.22);
  step++;
  timer = setTimeout(tick, STEP_MS);
}

export const music = {
  start() {
    if (running) return;
    if (!ensureCtx()) return;
    if (ctx.state === 'suspended') ctx.resume();
    running = true; step = 0; tick();
  },
  stop() {
    running = false;
    if (timer) { clearTimeout(timer); timer = null; }
  },
  setVolume(v) {
    baseVolume = Math.max(0, Math.min(1, v));
    if (masterGain) masterGain.gain.setTargetAtTime(baseVolume, ctx.currentTime, 0.05);
  },
  update({ runwayMonths = 12, morale = 0.7, bankrupt = false } = {}) {
    if (!ctx || !calmGain || !tenseGain) return;
    let stress = 0;
    const rm = Number(runwayMonths);
    const mo = Number(morale);
    const runwayOk = Number.isFinite(rm);
    const moraleOk = Number.isFinite(mo);
    if (runwayOk && rm < 12) stress += (12 - rm) / 12 * 0.6;
    if (moraleOk && mo < 0.6) stress += (0.6 - mo) * 0.6;
    if (bankrupt) stress = 1;
    stress = Math.max(0, Math.min(1, stress));
    if (!Number.isFinite(stress)) stress = 0;
    const t = ctx.currentTime;
    try {
      calmGain.gain.setTargetAtTime(1 - stress, t, 0.5);
      tenseGain.gain.setTargetAtTime(stress, t, 0.5);
    } catch (_) {
      calmGain.gain.value = 1 - stress;
      tenseGain.gain.value = stress;
    }
  },
};
