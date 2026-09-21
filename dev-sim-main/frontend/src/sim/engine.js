// Simulation engine — drives the live sprint: agents take tickets, commit, open PRs,
// argue in stand-ups, and produce events.
import {
  state,
  notify,
  pushTick,
  toast,
  recomputeBurn,
  openModal,
  leadershipLabel,
  computeTeamStatsSumForTycoon,
  applyTycoonApiResponse,
} from '../state/store.js';
import { runTycoonSprint } from '../agents/devSimBridge.js';
import { ROLE_LABELS } from '../data/personas.js';
import { buildSyntheticCandidatePool } from '../data/backendPersona.js';
import { makeStandup, makePRComment, makeRetro, makeQuip, makeCommitMsg, whyDifferent } from '../data/dialogue.js';
import { EVENT_DECK, ACHIEVEMENTS } from '../data/events.js';
import { spawnFx } from '../draw/scene.js';

let prCounter = 1;

/** Sim tick runs every animation frame; full DOM HUD rebuild must stay throttled to avoid flicker. */
let _hudNotifyAccum = 0;
const HUD_NOTIFY_PERIOD = 0.12; // ~8 Hz — roster/board/top bar; canvas still redraws every frame

/** Call after a full game restart so the next HUD tick can fire immediately. */
export function resetSimHudThrottle() {
  _hudNotifyAccum = HUD_NOTIFY_PERIOD;
}

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// assign tickets to agents based on role + skill match at sprint start
/** @param {{ quiet?: boolean }} [opts] If ``quiet``, skip the ticker line (used during full game restart). */
export function planSprint(opts = {}) {
  const s = state.sprint;
  s.assignments = {};
  s.progress = {};
  const live = state.team.filter(a => !a.fired);
  for (const t of s.backlog) {
    const candidates = live.filter(a => a.role === t.role);
    const pool = candidates.length ? candidates : live;
    // prefer least-loaded
    const counts = {};
    Object.values(s.assignments).forEach(id => { counts[id] = (counts[id] || 0) + 1; });
    pool.sort((a, b) => (counts[a.id] || 0) - (counts[b.id] || 0));
    s.assignments[t.id] = pool[0]?.id || null;
    s.progress[t.id] = 0;
  }
  if (!opts.quiet) {
    pushTick('event', 'Scrum', `Sprint ${s.number} planned · ${s.backlog.length} tickets, ${live.length} engineers.`);
  }
}

// per-tick velocity for an agent
function velocityFor(agent) {
  const skill = (agent.skills.frontend + agent.skills.backend + agent.skills.devops) / 3;
  const energy = agent.energy / 100;
  const morale = (agent.morale + 100) / 200;
  const focus = agent.focus / 100;
  const debtPenalty = 1 - state.economy.techDebt / 200;
  return (0.4 + skill / 200) * (0.5 + energy * 0.5) * (0.6 + morale * 0.4) * (0.6 + focus * 0.4) * debtPenalty;
}

// --- simulation tick --- runs every game-second
let standupTimer = 0;
let chatterTimer = 0;
let eventTimer = 0;
/** Phase accumulator for synthetic sprint heat while CEO orchestrate drives execution. */
let _orchDrivePhase = 0;

export function tick(dt) {
  if (state.paused) return;
  const speed = state.speed;
  const t = dt * speed;

  // update agent transient meters
  for (const a of state.team) {
    if (a.fired) continue;
    if (a.activityTtl > 0) a.activityTtl -= t;
    if (a.activityTtl <= 0) a.activity = 'idle';
    if (a.speaking) {
      a.speaking.ttl -= t;
      if (a.speaking.ttl <= 0) a.speaking = null;
    }
    // slow drains
    a.energy = clamp(a.energy - 0.4 * t);
    a.focus  = clamp(a.focus  + (Math.random() < 0.5 ? -0.3 : 0.2) * t);
    if (a.energy < 30) a.burnout = clamp(a.burnout + 0.6 * t);
    else a.burnout = clamp(a.burnout - 0.2 * t);
  }

  if (state.sprint.phase === 'execution') {
    state.sprint.elapsed += t;
    progressTickets(t);
    updateSprintHeat();
    standupTimer += t;
    chatterTimer += t;
    eventTimer += t;

    if (standupTimer > 25) { standupTimer = 0; runStandup(); }
    if (chatterTimer > 6 + Math.random() * 4) { chatterTimer = 0; runChatter(); }
    if (eventTimer > 35 + Math.random() * 15) { eventTimer = 0; drawRandomEvent(); }

    if (state.sprint.elapsed >= state.sprint.duration) {
      void endSprint().catch((err) => {
        pushTick('event', 'System', `Sprint settlement error: ${err?.message || err}`);
        notify();
      });
    }
  } else {
    state.ui.sprintHeat = 0;
  }

  checkAchievements();
  _hudNotifyAccum += t;
  if (_hudNotifyAccum >= HUD_NOTIFY_PERIOD) {
    _hudNotifyAccum = 0;
    notify();
  }
}

function updateSprintHeat() {
  const s = state.sprint;
  let sum = 0;
  let n = 0;
  for (const ticket of s.backlog) {
    sum += Math.min(1, Math.max(0, s.progress[ticket.id] || 0));
    n++;
  }
  state.ui.sprintHeat = n ? sum / n : 0;
}

function clamp(v) { return Math.max(-100, Math.min(100, v)); }

function progressTickets(dt) {
  const s = state.sprint;
  for (const ticket of s.backlog) {
    if (s.progress[ticket.id] >= 1) continue;
    const aid = s.assignments[ticket.id];
    const agent = state.team.find(a => a.id === aid && !a.fired);
    if (!agent) continue;
    const v = velocityFor(agent) / Math.max(1, ticket.estimate);
    const before = s.progress[ticket.id];
    s.progress[ticket.id] = Math.min(1, before + v * dt * 0.05);
    // commit firings
    if (Math.floor(before * 10) !== Math.floor(s.progress[ticket.id] * 10)) {
      onCommit(agent, ticket);
    }
    // mark done
    if (s.progress[ticket.id] >= 1 && before < 1) {
      onTicketDone(agent, ticket);
    }
  }
}

function onCommit(agent, ticket) {
  state.stats.commits++;
  agent.activity = 'type';
  agent.activityTtl = 1.4;
  pushTick('commit', agent.displayName, makeCommitMsg(ticket));
  // small skill XP
  const k = ticket.role === 'frontend' ? 'frontend' : ticket.role === 'backend' ? 'backend' : ticket.role === 'solutions_architect' ? 'devops' : 'comms';
  agent.skills[k] = Math.min(100, agent.skills[k] + 0.4);
}

function onTicketDone(agent, ticket) {
  if (ticket?.source === 'planning') {
    pushTick('pr', agent.displayName, `shipped planned work: ${ticket.title}`);
    agent.activity = 'celebrate';
    agent.activityTtl = 2;
    agent.speaking = { text: 'Synced with bridge work.', ttl: 2 };
    if (Number.isFinite(agent.px) && Number.isFinite(agent.py)) {
      spawnFx('good', agent.px + 10, agent.py - 18);
    }
    return;
  }
  // open PR
  const pr = {
    id: `PR-${prCounter++}`,
    ticket: ticket.id,
    title: ticket.title,
    agentId: agent.id,
    status: 'review',
    additions: 30 + Math.floor(Math.random() * 240),
    deletions: 5 + Math.floor(Math.random() * 80),
    comments: [],
    openedAt: Date.now(),
  };
  state.prs.unshift(pr);
  if (state.prs.length > 20) state.prs.pop();
  state.stats.prs++;
  pushTick('pr', agent.displayName, `opened ${pr.id}: ${ticket.title}`);
  agent.activity = 'celebrate';
  agent.activityTtl = 2;
  agent.speaking = { text: 'PR up!', ttl: 2 };
  if (Number.isFinite(agent.px) && Number.isFinite(agent.py)) {
    spawnFx('good', agent.px + 10, agent.py - 18);
  }
  // schedule reviews
  scheduleReview(pr, agent);
  // build pass/fail
  const buildOk = Math.random() > Math.min(0.35, 0.05 + state.economy.techDebt / 200);
  setTimeout(() => {
    if (state.paused) return;
    if (buildOk) {
      state.stats.builds.pass++;
      pushTick('build-pass', agent.displayName, `build passed for ${pr.id}`);
    } else {
      state.stats.builds.fail++;
      state.stats.sprintBugs++;
      pushTick('build-fail', agent.displayName, `build FAILED for ${pr.id}`);
      pr.status = 'failed';
      shakeStage();
      if (Number.isFinite(agent.px) && Number.isFinite(agent.py)) {
        spawnFx('bad', agent.px + 10, agent.py - 14);
      }
    }
    notify();
  }, 2500 + Math.random() * 2000);
}

function scheduleReview(pr, author) {
  const reviewers = state.team.filter(a => !a.fired && a.id !== author.id);
  const r1 = rand(reviewers);
  if (!r1) return;
  setTimeout(() => {
    if (state.paused) return;
    const ctx = { peer: author.displayName, ticket: pr.ticket };
    const comment = makePRComment(r1, ctx);
    pr.comments.push({ who: r1.displayName, text: comment });
    pushTick('pr', r1.displayName, `reviewed ${pr.id}: "${comment.slice(0, 48)}${comment.length > 48 ? '…' : ''}"`);
    // chance to merge after review
    if (pr.status !== 'failed' && Math.random() > 0.3) {
      pr.status = 'merged';
      pushTick('pr', r1.displayName, `merged ${pr.id}`);
      // small reputation bump
      state.economy.reputation = Math.min(100, state.economy.reputation + 0.4);
    }
    notify();
  }, 3000 + Math.random() * 4000);
}

function runStandup() {
  const live = state.team.filter(a => !a.fired);
  const a = rand(live);
  if (!a) return;
  const peer = rand(live.filter(x => x.id !== a.id))?.displayName || 'team';
  const ticketIds = Object.keys(state.sprint.assignments).filter(t => state.sprint.assignments[t] === a.id);
  const ticket = ticketIds[0] || 'CAL-X';
  const text = makeStandup(a, { ticket, peer, next: 'review queue', risk: 'the parser scope' });
  a.speaking = { text, ttl: 4.5 };
  a.activity = 'speak';
  a.activityTtl = 4.5;
  pushTick('standup', a.displayName, text);
}

function runChatter() {
  const live = state.team.filter(a => !a.fired);
  const a = rand(live);
  if (!a) return;
  if (a.speaking) return;
  if (Math.random() < 0.4) {
    a.speaking = { text: makeQuip(), ttl: 2.5 };
    a.activity = 'speak';
    a.activityTtl = 2.5;
  }
}

function drawRandomEvent() {
  const card = rand(EVENT_DECK);
  card.apply(state);
  pushTick('event', 'World', `${card.title} — ${card.desc}`);
  toast(`${card.title}: ${card.desc}`, 'gold');
}

function checkAchievements() {
  for (const a of ACHIEVEMENTS) {
    if (state.achievements.includes(a.id)) continue;
    try {
      if (a.test(state)) {
        state.achievements.push(a.id);
        toast(`Achievement: ${a.name}`, 'gold');
      }
    } catch {}
  }
}

// --- sprint phase transitions ---

export function startSprint() {
  state.ui.sprintDrivenByOrchestrate = false;
  state.sprint.phase = 'execution';
  state.sprint.elapsed = 0;
  recomputeBurn();
  for (const a of state.team) if (!a.fired) a.sprintsServed++;
  pushTick('event', 'CEO', `Sprint ${state.sprint.number} STARTED. Burn $${state.economy.burnRate.toLocaleString()}/sprint.`);
  /* pushTick already notify()s — immediate HUD refresh for sprint start */
}

/** Enter ``execution`` for the duration of ``POST /api/orchestrate`` (no fake ticket PRs / no wall-clock sprint end). */
export function beginOrchestrateSprint() {
  state.ui.sprintDrivenByOrchestrate = true;
  _orchDrivePhase = 0;
  state.sprint.phase = 'execution';
  state.sprint.elapsed = 0;
  recomputeBurn();
  pushTick('event', 'Bridge', `Sprint ${state.sprint.number} · execution linked to dev-sim build.`);
  notify();
}

/** Leave orchestrate-driven execution (returns to planning; does not run HR / tycoon — settlement runs after closing the code-review audit modal). */
export function endOrchestrateSprint() {
  if (!state.ui.sprintDrivenByOrchestrate) return;
  state.ui.sprintDrivenByOrchestrate = false;
  _orchDrivePhase = 0;
  state.ui.sprintHeat = 0;
  if (state.sprint.phase === 'execution') {
    state.sprint.phase = 'planning';
    state.sprint.elapsed = 0;
    pushTick('event', 'Bridge', `dev-sim build finished — sprint idle (planning).`);
  }
  notify();
}

function sprintSpecText() {
  const titles = (state.sprint.backlog || []).slice(0, 5).map((t) => t.title || t.id).join('; ');
  return `Sprint ${state.sprint.number} scope: ${titles}`.slice(0, 4000);
}

export async function endSprint() {
  state.sprint.phase = 'review';
  // Python tycoon ledger: mock audit + monthly settlement (POST /api/simulate)
  const teamSum = computeTeamStatsSumForTycoon();
  const expectedMrr =
    typeof state.economy.activeMrr === 'number' ? state.economy.activeMrr : state.economy.mrr;
  try {
    const payload = await runTycoonSprint(
      `Sprint ${state.sprint.number}`,
      sprintSpecText(),
      Number(expectedMrr),
      teamSum,
    );
    applyTycoonApiResponse(payload);
    recomputeBurn();
    const tp = payload && typeof payload === 'object' ? payload.targetPush : null;
    if (tp && tp.ok === true && !tp.skipped && tp.url) {
      toast(`Post-sprint GitHub export: ${tp.url}`, 'good');
    }
    const burn = state.economy.lastSettlementBurn ?? state.economy.burnRate;
    const mrrForCompare =
      typeof state.economy.activeMrr === 'number' && Number.isFinite(state.economy.activeMrr)
        ? state.economy.activeMrr
        : state.economy.mrr;
    if (state.economy.cash > 0 && mrrForCompare * 4 > burn) state.stats.profitableSprints++;
    if (payload.status === 'SERIES_A') {
      toast('Series A: valuation reached $2M!', 'gold');
    } else if (payload.status === 'OUTAGE_SURVIVED') {
      toast('Production outage: SLA penalty. Tech debt partially reset.', 'bad');
    } else if (payload.status === 'BANKRUPT') {
      toast('Bankrupt (company balance depleted).', 'bad');
    }
  } catch (err) {
    toast(`Tycoon sync failed: ${err?.message || err}. Using local fallback.`, 'bad');
    const opening = state.economy.cash;
    const burn = state.economy.burnRate;
    const rev = state.economy.mrr * 4;
    state.economy.cash -= burn;
    state.economy.cash += rev;
    state.economy.lastSprintLedger = {
      sprintMonth: state.economy.sprintMonth,
      opening,
      closing: state.economy.cash,
      lines: [
        { label: 'Recurring revenue (local estimate)', amount: rev, kind: 'credit' },
        { label: 'Operating burn (local estimate)', amount: -burn, kind: 'debit' },
        { label: 'Net change to cash', amount: state.economy.cash - opening, kind: 'net' },
      ],
    };
    notify();
    if (state.economy.cash > 0 && state.economy.mrr * 4 > state.economy.burnRate) state.stats.profitableSprints++;
  }
  if (state.stats.sprintBugs === 0) state.stats.zeroBugSprints++;
  state.stats.sprintBugs = 0;
  if (Math.random() < 0.3) state.stats.fridayShips++;
  for (const a of state.team) {
    if (a.fired) continue;
    a.speaking = { text: makeRetro(a, { peer: rand(state.team.filter(x => x.id !== a.id))?.displayName || 'team' }), ttl: 6 };
    a.activity = 'speak';
    a.activityTtl = 6;
  }
  const scores = computeScores();
  state.history.push({
    sprint: state.sprint.number,
    cash: state.economy.cash,
    mrr: state.economy.mrr,
    rep: state.economy.reputation,
    scores,
  });
  generateHeadline();
  openModal('hr-review', { scores });
  if (state.economy.cash <= 0) {
    setTimeout(() => openModal('game-over', {}), 200);
  }
  notify();
}

export function computeScores() {
  // per-agent score 0..100 from quant + qual + fit
  const live = state.team.filter(a => !a.fired);
  return live.map(a => {
    const tickets = Object.entries(state.sprint.progress)
      .filter(([id, p]) => state.sprint.assignments[id] === a.id);
    const completed = tickets.filter(([_, p]) => p >= 1).length;
    const partial = tickets.reduce((s, [_, p]) => s + p, 0);
    const myPRs = state.prs.filter(p => p.agentId === a.id);
    const merged = myPRs.filter(p => p.status === 'merged').length;
    const failed = myPRs.filter(p => p.status === 'failed').length;
    const skillAvg = Object.values(a.skills).reduce((s, v) => s + v, 0) / 6;

    const quant = clampPos(completed * 12 + partial * 4 + merged * 6 - failed * 8 + (a._codeQuality || 0) / 4);
    const qual = clampPos((a.morale + 100) / 4 + skillAvg / 4);
    const fit = clampPos(a.loyalty / 2 + (a.energy - a.burnout) / 4);
    const playerSignal = clampPos(a.reputation / 2);
    const total = Math.round(quant * 0.45 + qual * 0.25 + fit * 0.15 + playerSignal * 0.15);

    let flag = null;
    if (a.sprintsServed > 1 && total < 35) flag = 'underperformer';
    if ((a._hrFlag || 0) >= 2 && total < 50) flag = 'underperformer';
    if (total > 80) flag = 'star';

    return {
      agentId: a.id, total, quant: Math.round(quant), qual: Math.round(qual),
      fit: Math.round(fit), player: Math.round(playerSignal), flag,
      completed, merged, failed,
    };
  });
}

function clampPos(v) { return Math.max(0, Math.min(100, v)); }

function generateHeadline() {
  const lines = [
    `Simians Inc. closes sprint ${state.sprint.number} with $${state.economy.cash.toLocaleString()} in the bank.`,
    `Reputation: ${Math.round(state.economy.reputation)}. Leadership style: ${leadershipLabel()}.`,
    `Tech debt now ${Math.round(state.economy.techDebt)}%.`,
  ];
  state.newspaperHeadlines.push(lines.join(' '));
  if (state.newspaperHeadlines.length > 6) state.newspaperHeadlines.shift();
}

export function advanceToNextSprint() {
  state.sprint.number++;
  state.sprint.phase = 'planning';
  state.sprint.elapsed = 0;
  state.prs = state.prs.filter(p => p.status === 'merged').slice(0, 4);
  // restore some energy / morale and reset per-sprint counters
  for (const a of state.team) {
    if (a.fired) continue;
    a.energy = Math.min(100, a.energy + 25);
    a.focus = Math.min(100, a.focus + 10);
    a._codeQuality = 0;
    // _hrFlag persists across sprints intentionally so repeated low scores accumulate
  }
  // Tech debt is driven by the Python tycoon engine at sprint end; no local creep here.
  // refill backlog with cycled items
  state.sprint.backlog = state.sprint.backlog.map(t => ({ ...t, id: t.id + '.' + state.sprint.number }));
  planSprint();
  startSprint();
}

// --- player actions ---

export function actionPraise(agentId) {
  const a = state.team.find(x => x.id === agentId);
  if (!a) return;
  a.morale = Math.min(100, a.morale + 12);
  a.loyalty = Math.min(100, a.loyalty + 6);
  a.reputation = Math.min(100, a.reputation + 4);
  state.economy.leadershipKarma = Math.min(100, state.economy.leadershipKarma + 2);
  pushTick('event', 'CEO', `praised ${a.displayName}. They light up.`);
  toast(`${a.displayName}: morale up.`, 'good');
}

export function actionCriticize(agentId) {
  const a = state.team.find(x => x.id === agentId);
  if (!a) return;
  a.morale = Math.max(-100, a.morale - 18);
  a.loyalty = Math.max(0, a.loyalty - 8);
  a.focus = Math.min(100, a.focus + 8);
  state.economy.leadershipKarma = Math.max(-100, state.economy.leadershipKarma - 3);
  pushTick('event', 'CEO', `criticized ${a.displayName}. Cold silence.`);
  toast(`${a.displayName}: morale down, focus up.`, 'bad');
}

export function actionCoach(agentId) {
  const a = state.team.find(x => x.id === agentId);
  if (!a) return;
  if (state.economy.cash < 1500) { toast('Not enough cash for 1:1 coaching session.', 'bad'); return; }
  state.economy.cash -= 1500;
  state.stats.coachUses++;
  Object.keys(a.skills).forEach(k => { a.skills[k] = Math.min(100, a.skills[k] + 4); });
  a.morale = Math.min(100, a.morale + 8);
  a.loyalty = Math.min(100, a.loyalty + 12);
  state.economy.leadershipKarma = Math.min(100, state.economy.leadershipKarma + 3);
  pushTick('event', 'CEO', `1:1 with ${a.displayName}: skills +4, loyalty +12.`);
  toast(`${a.displayName} levelled up.`, 'good');
}

export function actionRaise(agentId) {
  const a = state.team.find(x => x.id === agentId);
  if (!a) return;
  const hike = Math.round(a.salary * 0.15);
  if (state.economy.cash < hike * 4) { toast('Cannot afford the raise.', 'bad'); return; }
  a.salary += hike;
  a.loyalty = Math.min(100, a.loyalty + 25);
  a.morale = Math.min(100, a.morale + 15);
  state.economy.leadershipKarma = Math.min(100, state.economy.leadershipKarma + 1);
  recomputeBurn();
  pushTick('event', 'CEO', `gave ${a.displayName} a raise (+$${hike.toLocaleString()}).`);
  toast(`${a.displayName} signed.`, 'good');
}

export function actionFire(agentId) {
  const a = state.team.find(x => x.id === agentId);
  if (!a || a.fired) return;
  a.fired = true;
  state.stats.firings++;
  state.economy.leadershipKarma = Math.max(-100, state.economy.leadershipKarma - 6);
  // morale shock to team
  state.team.forEach(o => { if (o.id !== a.id && !o.fired) o.morale = Math.max(-100, o.morale - 8); });
  recomputeBurn();
  pushTick('fired', 'CEO', `let ${a.displayName} go.`);
  toast(`${a.displayName} has been let go.`, 'bad');
  if (!state.candidatePool.length) {
    state.candidatePool = buildSyntheticCandidatePool();
  }
  openModal('candidate-picker', { firedId: a.id });
}

export function actionHire(candidateId, firedId) {
  const cand = state.candidatePool.find(c => c.id === candidateId);
  if (!cand) return;
  if (state.economy.cash < cand.salary) { toast('Cannot afford signing.', 'bad'); return; }
  const prev = state.team.find((x) => x.id === firedId);
  // remove from pool
  state.candidatePool = state.candidatePool.filter(c => c.id !== candidateId);
  // pay first salary
  state.economy.cash -= cand.salary;
  // add to team
  const newAgent = {
    ...JSON.parse(JSON.stringify(cand)),
    fired: false, sprintsServed: 0,
    energy: 90, morale: 70, focus: 80, loyalty: 70, reputation: 50, burnout: 0,
    speaking: { text: 'Excited to be here.', ttl: 4 },
    activity: 'speak', activityTtl: 4, desk: 0, px: 0, py: 0, _officePlaced: false,
    agentKind: prev?.agentKind,
    gitIdentity: prev?.gitIdentity ?? cand.gitIdentity ?? null,
  };
  // replace fired slot
  const idx = state.team.findIndex(a => a.id === firedId);
  if (idx >= 0) state.team[idx] = newAgent; else state.team.push(newAgent);
  state.stats.hires++;
  if (cand.traits.includes('rockstar') || cand.traits.includes('chaotic_good')) state.stats.wildcardHires++;
  recomputeBurn();
  pushTick('hired', 'CEO', `hired ${cand.displayName}.`);
  toast(`Welcome, ${cand.displayName}!`, 'good');
}

function shakeStage() {
  const c = document.getElementById('stage');
  if (!c) return;
  c.classList.remove('shake');
  void c.offsetWidth;
  c.classList.add('shake');
}
