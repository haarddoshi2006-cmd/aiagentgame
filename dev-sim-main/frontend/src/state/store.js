// Central reactive store. Plain JS — subscribe/dispatch.
import { SEED_BACKLOG, ROLES } from '../data/personas.js';
import { agentFromBackendPersona } from '../data/backendPersona.js';

const listeners = new Set();

/** Bumped on full game restart so late ``/api/economy`` / ``/api/company`` hydrates cannot overwrite fresh state. */
let _economyHydrateEpoch = 0;

export function bumpEconomyHydrateEpoch() {
  _economyHydrateEpoch += 1;
}

export function economyHydrateEpoch() {
  return _economyHydrateEpoch;
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function instantiateAgent(p) {
  return {
    ...clone(p),
    fired: false,
    sprintsServed: 0,
    energy: 80, morale: 50, focus: 70, loyalty: 60, reputation: 50, burnout: 10,
    speaking: null, // current speech text + ttl
    activity: 'idle', activityTtl: 0,
    desk: 0, // assigned by scene
    px: 0, py: 0, // pixel position in office
    /** Set true after scene.js places the sprite in front of a desk (do not use px/py === 0 alone). */
    _officePlaced: false,
  };
}

/**
 * Replace roster with three dev-sim agents from ``GET /api/agents`` (coding, coding_b, review).
 * @param {Record<string, unknown>} payload
 * @param {{ silent?: boolean }} [opts] Pass ``silent: true`` to skip ``notify`` (caller flushes once).
 */
export function applyBackendTeam(payload, opts = {}) {
  const a1 = agentFromBackendPersona(payload.coding, 'coding');
  const a2 = agentFromBackendPersona(payload.coding_b, 'coding_b');
  const a3 = agentFromBackendPersona(payload.review, 'review');
  state.team = [instantiateAgent(a1), instantiateAgent(a2), instantiateAgent(a3)];
  state.backendPersonaPayload = {
    coding: clone(payload.coding),
    coding_b: clone(payload.coding_b),
    review: clone(payload.review),
  };
  recomputeBurn();
  if (!opts.silent) notify();
}

/** Reset client game state to Day 1 defaults (does not write Python ``company-state.json``). */
export function resetGameState() {
  state.paused = false;
  state.speed = 1;
  state.sprint.number = 1;
  state.sprint.phase = 'planning';
  state.sprint.elapsed = 0;
  state.sprint.duration = 300;
  state.sprint.backlog = clone(SEED_BACKLOG);
  state.sprint.assignments = {};
  state.sprint.progress = {};
  state.team = [];
  state.backendPersonaPayload = null;
  state.candidatePool = [];
  state.prs = [];
  state.ticker = [];
  state.achievements = [];
  state.toasts = [];
  state.modal = null;
  state.ui.orchestrateBusy = false;
  state.ui.sprintDrivenByOrchestrate = false;
  state.ui.matrixLines = [];
  state.ui.sprintHeat = 0;
  Object.assign(state.economy, {
    cash: 200000,
    mrr: 3000,
    contracts: [],
    burnRate: 0,
    techDebt: 0,
    reputation: 50,
    leadershipKarma: 0,
    valuation: 0,
    activeMrr: null,
    hypeMultiplier: 1,
    sprintMonth: 1,
    lastTechnicalScores: null,
    lastSettlementBurn: null,
    lastTycoonStatus: null,
    pendingRecurringMrr: 0,
    lastSprintLedger: null,
  });
  state.stats = {
    commits: 0,
    prs: 0,
    builds: { pass: 0, fail: 0 },
    firings: 0,
    hires: 0,
    wildcardHires: 0,
    fridayShips: 0,
    profitableSprints: 0,
    zeroBugSprints: 0,
    coachUses: 0,
    sprintBugs: 0,
  };
  state.history = [];
  state.newspaperHeadlines = [];
  state.projects = [];
  state.chatLog = [];
  recomputeBurn();
}

export const state = {
  paused: false,
  speed: 1, // 1x, 2x, 4x
  sprint: {
    number: 1,
    phase: 'planning', // planning | execution | review | retro | hr
    elapsed: 0,
    duration: 300, // seconds of execution per sprint
    backlog: clone(SEED_BACKLOG),
    assignments: {}, // ticketId -> agentId
    progress: {},   // ticketId -> 0..1
  },
  team: [],
  /** Raw ``coding`` / ``coding_b`` / ``review`` persona dicts from ``GET /api/agents`` (orchestrate uses coding + review). */
  backendPersonaPayload: null,
  candidatePool: [],
  prs: [], // {id, ticket, agentId, status: open|review|merged|failed, additions, deletions, comments[]}
  ticker: [], // {ts, kind, who, text}
  achievements: [], // unlocked ids
  toasts: [], // {id, kind, text, ttl}
  modal: null, // {kind, payload}
  ui: {
    orchestrateBusy: false,
    /** When true, sprint ``execution`` tracks CEO dev-sim build (no wall-clock auto-end / fake ticket PRs). */
    sprintDrivenByOrchestrate: false,
    /** @type {string[]} */
    matrixLines: [],
    /** Mean ticket progress 0–1 during execution (drives HUD / board “heat”). */
    sprintHeat: 0,
    /** POST /api/orchestrate — skip planning and/or K2 review for shorter runs (CEO chat toggles). */
    orchestrateOptions: { skipPlanning: false, skipK2Review: false },
  },
  economy: {
    cash: 200000,
    mrr: 3000,
    contracts: [], // active client contracts
    burnRate: 0,
    techDebt: 0,
    reputation: 50,
    leadershipKarma: 0, // -100..100
    // Tycoon engine (Python /api/simulate) — synced each sprint end
    valuation: 0,
    activeMrr: null, // number after first tycoon sync; until then HUD uses `mrr`
    hypeMultiplier: 1,
    sprintMonth: 1,
    lastTechnicalScores: null, // { CodeReadability: 1-10, ... }
    lastSettlementBurn: null, // last POST /api/simulate burn_rate (monthly $)
    lastTycoonStatus: null, // CONTINUE | SERIES_A | BANKRUPT | OUTAGE_SURVIVED
    /** MRR from shipped CEO products — lands in Python ledger next sprint settlement */
    pendingRecurringMrr: 0,
    /** @type {null | { sprintMonth: number, opening: number|null, closing: number|null, lines: {label: string, amount: number, kind: string}[] }} */
    lastSprintLedger: null,
  },
  stats: {
    commits: 0, prs: 0, builds: { pass: 0, fail: 0 },
    firings: 0, hires: 0, wildcardHires: 0,
    fridayShips: 0, profitableSprints: 0, zeroBugSprints: 0, coachUses: 0,
    sprintBugs: 0,
  },
  history: [], // per-sprint snapshots
  newspaperHeadlines: [],
  projects: [], // generated projects (PR-with-iframe)
  chatLog: [], // {who, text, role, kind: 'ceo'|'agent'|'system'}
};

// recompute burn
recomputeBurn();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let scheduled = false;
export function notify() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    for (const fn of listeners) fn(state);
  });
}

export function recomputeBurn() {
  const salaries = state.team.filter(a => !a.fired).reduce((s, a) => s + Math.round(a.salary / 4), 0); // per sprint
  state.economy.burnRate = salaries + 800; // infra
}

/** Sum of 1–5 “stat tiers” per live agent skill (matches backend team_stats_sum scale). */
export function computeTeamStatsSumForTycoon() {
  const keys = ['frontend', 'backend', 'devops', 'design', 'comms', 'leadership'];
  let sum = 0;
  for (const a of state.team.filter((x) => !x.fired)) {
    const sk = a.skills || {};
    for (const k of keys) {
      const v = Number(sk[k]) || 0;
      sum += Math.max(1, Math.min(5, Math.round(v / 25) || 1));
    }
  }
  return sum;
}

/**
 * Apply JSON from POST /api/simulate (snake_case keys) onto state.economy and refresh HUD.
 * @param {Record<string, unknown>} payload
 */
export function applyTycoonApiResponse(payload) {
  if (!payload || typeof payload !== 'object') return;
  const e = state.economy;
  if (typeof payload.balance === 'number' && Number.isFinite(payload.balance)) e.cash = payload.balance;
  if (typeof payload.active_mrr === 'number' && Number.isFinite(payload.active_mrr)) {
    e.activeMrr = payload.active_mrr;
    e.mrr = payload.active_mrr;
  }
  if (typeof payload.valuation === 'number') e.valuation = payload.valuation;
  if (typeof payload.tech_debt === 'number') e.techDebt = payload.tech_debt;
  if (typeof payload.hype_multiplier === 'number') e.hypeMultiplier = payload.hype_multiplier;
  if (typeof payload.sprint_month === 'number') e.sprintMonth = payload.sprint_month;
  if (typeof payload.burn_rate === 'number') e.lastSettlementBurn = payload.burn_rate;
  if (typeof payload.status === 'string') e.lastTycoonStatus = payload.status;
  const pend =
    typeof payload.pending_recurring_mrr === 'number'
      ? payload.pending_recurring_mrr
      : typeof payload.pendingRecurringMrr === 'number'
        ? payload.pendingRecurringMrr
        : null;
  if (pend != null && Number.isFinite(pend)) e.pendingRecurringMrr = pend;
  if (payload.technical_scores && typeof payload.technical_scores === 'object') {
    e.lastTechnicalScores = { ...payload.technical_scores };
  }
  const lines = payload.ledger_lines;
  if (Array.isArray(lines)) {
    const opening =
      typeof payload.opening_balance === 'number' && Number.isFinite(payload.opening_balance)
        ? payload.opening_balance
        : null;
    const closing =
      typeof payload.closing_balance === 'number' && Number.isFinite(payload.closing_balance)
        ? payload.closing_balance
        : typeof payload.balance === 'number' && Number.isFinite(payload.balance)
          ? payload.balance
          : null;
    e.lastSprintLedger = {
      sprintMonth: typeof payload.sprint_month === 'number' ? payload.sprint_month : e.sprintMonth,
      opening,
      closing,
      lines: lines
        .filter((x) => x && typeof x === 'object')
        .map((x) => ({
          label: String(x.label || ''),
          amount: Number(x.amount) || 0,
          kind: String(x.kind || ''),
        })),
    };
  }
  notify();
}

/**
 * Merge ledger fields from GET /api/economy or orchestrate ``economySnapshot`` (snake_case).
 * @param {Record<string, unknown>} snap
 * @param {{ silent?: boolean }} [opts]
 */
export function applyEconomyLedgerSnapshot(snap, opts = {}) {
  if (!snap || typeof snap !== 'object' || snap.ok === false) return;
  const e = state.economy;
  if (typeof snap.balance === 'number' && Number.isFinite(snap.balance)) e.cash = snap.balance;
  if (typeof snap.active_mrr === 'number' && Number.isFinite(snap.active_mrr)) {
    e.activeMrr = snap.active_mrr;
    e.mrr = snap.active_mrr;
  }
  if (typeof snap.pending_recurring_mrr === 'number' && Number.isFinite(snap.pending_recurring_mrr)) {
    e.pendingRecurringMrr = snap.pending_recurring_mrr;
  }
  if (typeof snap.valuation === 'number' && Number.isFinite(snap.valuation)) e.valuation = snap.valuation;
  if (typeof snap.tech_debt === 'number' && Number.isFinite(snap.tech_debt)) e.techDebt = snap.tech_debt;
  if (typeof snap.hype_multiplier === 'number' && Number.isFinite(snap.hype_multiplier)) {
    e.hypeMultiplier = snap.hype_multiplier;
  }
  if (typeof snap.sprint_month === 'number' && Number.isFinite(snap.sprint_month)) e.sprintMonth = snap.sprint_month;
  if (!opts.silent) notify();
}

export function leadershipLabel() {
  const k = state.economy.leadershipKarma;
  if (k <= -40) return 'Tyrant';
  if (k <= -10) return 'Hard';
  if (k < 10) return 'Neutral';
  if (k < 40) return 'Mentor';
  return 'Beloved';
}

export function pushTick(kind, who, text) {
  state.ticker.push({ ts: Date.now(), kind, who, text });
  if (state.ticker.length > 80) state.ticker.shift();
  notify();
}

const _PLANNING_FEED_ASIDES = [
  'Studio: stretching legs…',
  'Studio: coffee refill ☕',
  'Studio: someone brought donuts.',
  'Studio: quick stand-up in the kitchen.',
  'Studio: CI is green on the last push.',
];

/**
 * Replace sprint backlog with tickets derived from bridge ``plannedSprints`` (planning model output).
 * @param {unknown[]} plannedSprints
 * @returns {boolean} true if backlog was updated
 */
export function applyPlanningSprintsToBacklog(plannedSprints) {
  if (!Array.isArray(plannedSprints) || plannedSprints.length === 0) return false;
  const roleCycle = ROLES.length ? ROLES : ['frontend', 'backend', 'tech_lead'];
  const tickets = plannedSprints.map((s, i) => {
    const row = s && typeof s === 'object' ? s : {};
    const n = row.number != null ? row.number : i + 1;
    const titleBit =
      (typeof row.title === 'string' && row.title.trim()) ||
      (typeof row.promptExcerpt === 'string' && row.promptExcerpt.trim()) ||
      `Planned sprint ${n}`;
    return {
      id: `PLN-${n}`,
      title: String(titleBit).slice(0, 220),
      estimate: Math.max(2, Math.min(8, 3 + (i % 4))),
      role: roleCycle[i % roleCycle.length],
      source: 'planning',
    };
  });
  state.sprint.backlog = tickets;
  return true;
}

/** Push planning model text into the live ticker in digestible lines (with occasional studio asides). */
export function pushPlanningFeedFromText(text) {
  if (!text || typeof text !== 'string') return;
  const trimmed = text.trim();
  if (!trimmed) return;
  const maxLines = 48;
  const rawLines = trimmed.split(/\n/);
  const lines = [];
  for (const raw of rawLines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.length <= 220) lines.push(line);
    else {
      for (let i = 0; i < line.length; i += 200) lines.push(line.slice(i, i + 200));
    }
    if (lines.length >= maxLines) break;
  }
  for (let i = 0; i < lines.length; i++) {
    pushTick('event', 'Planner', lines[i]);
    if (i < lines.length - 1 && Math.random() < 0.12) {
      const aside = _PLANNING_FEED_ASIDES[Math.floor(Math.random() * _PLANNING_FEED_ASIDES.length)];
      pushTick('event', 'Studio', aside);
    }
  }
}

export function toast(text, kind = 'good') {
  const id = Math.random().toString(36).slice(2);
  state.toasts.push({ id, text, kind });
  notify();
  setTimeout(() => {
    state.toasts = state.toasts.filter(t => t.id !== id);
    notify();
  }, 3600);
}

export function openModal(kind, payload) {
  state.modal = { kind, payload };
  state.paused = true;
  notify();
}
export function closeModal() {
  const m = state.modal;
  const runLedgerAfterK2 =
    m?.kind === 'k2-audit' &&
    m.payload &&
    typeof m.payload === 'object' &&
    /** @type {{ _runLedgerAfterClose?: boolean }} */ (m.payload)._runLedgerAfterClose === true;
  const wasIntro = m?.kind === 'intro';
  state.modal = null;
  state.paused = false;
  notify();
  if (runLedgerAfterK2) {
    // Defer past this ``notify`` tick so the K2 overlay unmounts before ``endSprint`` opens HR.
    queueMicrotask(() => {
      import('../sim/engine.js').then((mod) => {
        void mod.endSprint().catch((err) => {
          console.error('[simians] sprint settlement after code review', err);
        });
      });
    });
  } else if (wasIntro) {
    // First sprint used to start from the welcome footer; begin when the welcome modal closes (X).
    queueMicrotask(() => {
      import('../sim/engine.js').then((mod) => {
        mod.planSprint();
        mod.startSprint();
      });
    });
  }
}

/** CEO chat → /api/orchestrate: show Matrix stream overlay on the sprint board. */
export function setOrchestrateBusy(busy) {
  state.ui.orchestrateBusy = !!busy;
  if (busy) state.ui.matrixLines = [];
  notify();
}

/** Throttle: matrix lines arrive ~every 90ms; full-HUD ``notify`` that often makes the chat dock shimmer. */
let _matrixHudNotifyTimer = 0;

/** Cancel a pending throttled matrix repaint (``setOrchestrateBusy`` / next ``notify`` will paint). */
export function flushMatrixStreamHud() {
  if (_matrixHudNotifyTimer) {
    clearTimeout(_matrixHudNotifyTimer);
    _matrixHudNotifyTimer = 0;
  }
}

/** Append one line to the Matrix-style stream (max ~32 lines). */
export function pushMatrixStreamLine(line) {
  state.ui.matrixLines.push(String(line));
  if (state.ui.matrixLines.length > 32) state.ui.matrixLines.shift();
  if (_matrixHudNotifyTimer) return;
  _matrixHudNotifyTimer = window.setTimeout(() => {
    _matrixHudNotifyTimer = 0;
    notify();
  }, 120);
}
