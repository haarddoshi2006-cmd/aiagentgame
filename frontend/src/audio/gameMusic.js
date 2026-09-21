/**
 * Binds procedural BGM from ``music.js`` (frontend-branch audio) to dev-sim HUD state.
 * Unlocks Web Audio on first user gesture; updates calm/tense mix from economy + team morale.
 */
import { audio } from './synth.js';
import { music } from './music.js';
import { subscribe, state } from '../state/store.js';

let unlocked = false;
let playing = false;

function safeNum(n, fallback = 0) {
  const x = typeof n === 'number' ? n : Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function pushMusicFromState() {
  if (!playing) return;
  const e = state.economy;
  const burnShown = e.lastSettlementBurn != null ? e.lastSettlementBurn : e.burnRate;
  const mrrShown =
    typeof e.activeMrr === 'number' && Number.isFinite(e.activeMrr) ? e.activeMrr : safeNum(e.mrr, 0);
  const net = safeNum(burnShown, 0) - mrrShown * 4;
  const runwaySprints = net > 0 ? Math.max(0, Math.floor(safeNum(e.cash, 0) / net)) : 99;

  const live = (state.team || []).filter((a) => !a.fired);
  let morale01 = 0.72;
  if (live.length) {
    const sum = live.reduce((s, a) => s + (a.morale + 100) / 200, 0);
    morale01 = sum / live.length;
  }

  const bankrupt = safeNum(e.cash, 0) <= 0 || state.modal?.kind === 'game-over';

  const m = Number(morale01);
  const moraleClamped = Number.isFinite(m) ? Math.max(0, Math.min(1, m)) : 0.72;
  try {
    music.update({
      runwayMonths: Math.min(24, runwaySprints),
      morale: moraleClamped,
      bankrupt,
    });
  } catch (_) {
    /* Non-finite Web Audio params must never break the UI thread */
  }
}

export function initGameMusic() {
  const unlock = () => {
    if (unlocked) return;
    unlocked = true;
    audio.unlock();
    playing = true;
    music.start();
    pushMusicFromState();
    window.removeEventListener('pointerdown', unlock, true);
  };
  window.addEventListener('pointerdown', unlock, { passive: true, capture: true });

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'm' && e.key !== 'M') return;
    if (e.repeat) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) {
      return;
    }
    audio.toggleMute();
  });

  subscribe(() => {
    pushMusicFromState();
  });
}
