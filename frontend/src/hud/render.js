// HUD rendering — DOM panels driven by store subscriptions.
import {
  state, subscribe, openModal, closeModal, leadershipLabel, recomputeBurn, pushTick, toast,
  computeTeamStatsSumForTycoon, applyEconomyLedgerSnapshot, applyBackendTeam, resetGameState,
  bumpEconomyHydrateEpoch, economyHydrateEpoch,
} from '../state/store.js';
import { AGENT_KIND_LABELS, ROLE_LABELS, ROLE_SHORT } from '../data/personas.js';
import { TYCOON_TECH_KEYS } from '../data/tycoonRubric.js';
import { LEVERS, ACHIEVEMENTS } from '../data/events.js';
import {
  startSprint, advanceToNextSprint, planSprint, resetSimHudThrottle,
  actionPraise, actionCriticize, actionCoach, actionRaise, actionFire, actionHire,
} from '../sim/engine.js';
import { makePortraitDataURL } from '../draw/portrait.js';
import { whyDifferent } from '../data/dialogue.js';
import { runProject } from '../agents/orchestrator.js';
import { fetchEconomyLedger } from '../agents/devSimBridge.js';
import { fetchDevTeamAgents } from '../api/agentsApi.js';
import { fetchCompanyState, postResetCompanyState } from '../api/economyApi.js';
import { clearSpeechBubbles } from '../draw/scene.js';

/** True while a full restart is mutating state — blocks Space (pause toggle) and duplicate restart clicks. */
let _restartInProgress = false;

/** Skip rebuilding LIVE FEED DOM when the visible slice is unchanged (avoids shimmer on every sim tick). */
let _tickerFeedSig = '';

/** Roster identity line (not meters) — when unchanged we only update bar widths in-place. */
let _rosterStructSig = '';

/** Sprint ledger strip (top bar) — skip DOM rebuild when settlement snapshot unchanged. */
let _ledgerStripSig = '';

/** World events deck — skip rebuild when the last four event lines are unchanged. */
let _eventsDeckSig = '';

/** Achievement chips — skip innerHTML churn when unlock list unchanged. */
let _achievementsSig = '\0';

const portraitCache = new Map();
function portrait(agent, size = 32) {
  const key = `${agent.id}:${size}`;
  if (!portraitCache.has(key)) portraitCache.set(key, makePortraitDataURL(agent, size));
  return portraitCache.get(key);
}

// HUD number odometer (cash / MRR / valuation) — vanilla RAF, textContent only, NaN-safe (CSP-safe).
let _hudLerp = null;
let _hudRaf = 0;

function safeNum(n, fallback = 0) {
  const x = typeof n === 'number' ? n : Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function fmtMoney(n) {
  const x = Math.round(safeNum(n, 0));
  return '$' + x.toLocaleString();
}

/** Signed cash / MRR line for sprint ledger strip (+ inflow, − outflow). */
function fmtLedgerAmt(amount, kind) {
  const k = String(kind || '');
  if (k === 'mrr') return `+${fmtMoney(amount)}/mo book`;
  const n = Math.round(safeNum(amount, 0));
  if (n >= 0) return `+ ${fmtMoney(n)}`;
  return `− ${fmtMoney(Math.abs(n))}`;
}

function ledgerLineClass(kind) {
  const k = String(kind || '');
  if (k === 'credit') return 'credit';
  if (k === 'debit') return 'debit';
  if (k === 'mrr') return 'mrr';
  if (k === 'net') return 'net';
  return '';
}

function cssVarColor(name, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  const v = (raw && raw.trim()) || '';
  return v || fallback;
}

/** Series A ring: inline conic-gradient only (no custom-property animation / no eval). */
function applySeriesARingFill(ring, valuation) {
  if (!ring) return;
  const cap = 2_000_000;
  const v = Math.max(0, safeNum(valuation, 0));
  const pct = Math.min(100, cap > 0 ? (v / cap) * 100 : 0);
  const deg = (pct / 100) * 360;
  const accent = cssVarColor('--accent', '#6ad7ff');
  const bg3 = cssVarColor('--bg-3', '#1e2538');
  ring.style.background = `conic-gradient(from -90deg, ${accent} 0deg, ${accent} ${deg}deg, ${bg3} ${deg}deg)`;
}

function hudTargetsFromEconomy() {
  const e = state.economy;
  const mrrSrc = typeof e.activeMrr === 'number' && Number.isFinite(e.activeMrr) ? e.activeMrr : e.mrr;
  return {
    cash: safeNum(e.cash, 0),
    mrr: safeNum(mrrSrc, 0),
    val: safeNum(e.valuation, 0),
  };
}

function initHudLerpIfNeeded() {
  if (_hudLerp) return;
  _hudLerp = hudTargetsFromEconomy();
}

export function resetHudMoneyLerp() {
  if (_hudRaf) cancelAnimationFrame(_hudRaf);
  _hudRaf = 0;
  _hudLerp = null;
}

export function clearPortraitCache() {
  portraitCache.clear();
}

function resetHudLerpIfCorrupt() {
  if (!_hudLerp) return;
  if (
    !Number.isFinite(_hudLerp.cash) ||
    !Number.isFinite(_hudLerp.mrr) ||
    !Number.isFinite(_hudLerp.val)
  ) {
    _hudLerp = hudTargetsFromEconomy();
  }
}

function applyHudLerpToDom() {
  if (!_hudLerp) return;
  resetHudLerpIfCorrupt();
  const v = Math.max(0, safeNum(_hudLerp.val, 0));
  const seriesCap = 2_000_000;
  const pct = seriesCap > 0 ? Math.min(100, (v / seriesCap) * 100) : 0;
  const ring = qs('#valuation-ring');
  applySeriesARingFill(ring, v);
  set('stat-valuation-pct', `${pct.toFixed(0)}%`);
  set('stat-valuation-num', fmtMoney(v));
  set('stat-cash', fmtMoney(_hudLerp.cash));
  set('stat-mrr', `${fmtMoney(_hudLerp.mrr)}/mo`);
}

function hudLerpTick() {
  const targets = hudTargetsFromEconomy();
  resetHudLerpIfCorrupt();
  const rate = 0.22;
  _hudLerp.cash += (targets.cash - _hudLerp.cash) * rate;
  _hudLerp.mrr += (targets.mrr - _hudLerp.mrr) * rate;
  _hudLerp.val += (targets.val - _hudLerp.val) * rate;
  applyHudLerpToDom();
  const done =
    Math.abs(targets.cash - _hudLerp.cash) < 0.35 &&
    Math.abs(targets.mrr - _hudLerp.mrr) < 0.15 &&
    Math.abs(targets.val - _hudLerp.val) < 800;
  if (done) {
    _hudLerp.cash = targets.cash;
    _hudLerp.mrr = targets.mrr;
    _hudLerp.val = targets.val;
    applyHudLerpToDom();
    _hudRaf = 0;
  } else {
    _hudRaf = requestAnimationFrame(hudLerpTick);
  }
}

function kickHudLerpIfNeeded() {
  if (!_hudLerp) return;
  const t = hudTargetsFromEconomy();
  const far =
    Math.abs(t.cash - _hudLerp.cash) > 0.5 ||
    Math.abs(t.mrr - _hudLerp.mrr) > 0.3 ||
    Math.abs(t.val - _hudLerp.val) > 500;
  if (far && !_hudRaf) _hudRaf = requestAnimationFrame(hudLerpTick);
}

// ---------- top bar ----------
function renderTopBar() {
  const e = state.economy;
  const sm = typeof e.sprintMonth === 'number' && e.sprintMonth >= 1 ? e.sprintMonth : state.sprint.number;
  const pipe = safeNum(e.pendingRecurringMrr, 0);
  const pipeHint = pipe > 0.5 ? ` · +$${Math.round(pipe).toLocaleString()}/mo → ledger next sprint` : '';
  const orchDrive = !!state.ui.sprintDrivenByOrchestrate;
  const execHint =
    state.sprint.phase === 'execution'
      ? orchDrive
        ? ' | dev-sim build…'
        : ` | ${Math.max(0, Math.ceil(state.sprint.duration - state.sprint.elapsed))}s left`
      : '';
  const tagline = `Ledger mo. ${sm} | Sprint ${state.sprint.number} | ${capitalize(state.sprint.phase)}${execHint}${pipeHint}`;
  const tagEl = document.getElementById('tagline');
  if (tagEl && tagEl.textContent !== tagline) tagEl.textContent = tagline;
  const burnShown = e.lastSettlementBurn != null ? e.lastSettlementBurn : e.burnRate;
  const mrrShown =
    typeof e.activeMrr === 'number' && Number.isFinite(e.activeMrr) ? e.activeMrr : safeNum(e.mrr, 0);
  const net = safeNum(burnShown, 0) - mrrShown * 4;
  const runway = net > 0 ? Math.max(0, Math.floor(safeNum(e.cash, 0) / net)) : 99;
  set('stat-runway', `${isFinite(runway) && runway < 99 ? runway : '99+'} sprints`);
  set('stat-burn', fmtMoney(burnShown));
  const debtPct = safeNum(e.techDebt, 0);
  set('stat-debt', `${Math.round(debtPct)}%`);
  set('stat-rep', `${Math.round(e.reputation)}`);
  set('stat-style', leadershipLabel());

  initHudLerpIfNeeded();
  kickHudLerpIfNeeded();
  applyHudLerpToDom();

  const scores = e.lastTechnicalScores;
  const sec = scores && Number(scores.SecurityBestPractices);
  const errh = scores && Number(scores.ErrorHandling);
  const risk = scores != null && (sec < 5 || errh < 5);
  const debtWrap = qs('#stat-debt-wrap');
  if (debtWrap) {
    debtWrap.classList.toggle('stat-debt-risk', Boolean(risk) && debtPct <= 80);
    debtWrap.classList.toggle('stat-debt-crisis', debtPct > 80);
  }
  document.body.classList.toggle('td-crisis', debtPct > 80);

  renderSprintLedgerStrip();

  const topbar = qs('#topbar');
  if (topbar) {
    topbar.classList.toggle('hud-sprint-live', state.sprint.phase === 'execution');
    topbar.classList.toggle('hud-sprint-review', state.sprint.phase === 'review');
    const h = Math.ceil(topbar.getBoundingClientRect().height);
    document.documentElement.style.setProperty('--hud-topbar-height', `${h}px`);
  }
}

function ledgerStripSignature() {
  const L = state.economy.lastSprintLedger;
  if (!L || !L.lines || !L.lines.length) return '__empty__';
  return JSON.stringify({
    mo: L.sprintMonth,
    open: L.opening,
    close: L.closing,
    lines: L.lines.map((x) => [x.label, x.amount, x.kind]),
  });
}

function renderSprintLedgerStrip() {
  const root = qs('#sprint-ledger-strip');
  if (!root) return;
  const L = state.economy.lastSprintLedger;
  if (!L || !L.lines || !L.lines.length) {
    const sig = '__empty__';
    if (sig === _ledgerStripSig && root.classList.contains('ledger-empty')) return;
    _ledgerStripSig = sig;
    root.className = 'sprint-ledger-strip ledger-empty';
    root.innerHTML =
      '<span class="ledger-head">Sprint statement</span> End a sprint to see cash in (+) and burn out (−). CEO upgrades are one-time, not charged again each sprint.';
    return;
  }
  const sig = ledgerStripSignature();
  if (sig === _ledgerStripSig && root.querySelector('.ledger-rows')) return;
  _ledgerStripSig = sig;

  root.className = 'sprint-ledger-strip';
  const mo = typeof L.sprintMonth === 'number' ? L.sprintMonth : state.economy.sprintMonth;
  const open = L.opening != null ? fmtMoney(L.opening) : '—';
  const close = L.closing != null ? fmtMoney(L.closing) : '—';

  const headRow = el('div', 'ledger-head-row');
  const head = el('div', 'ledger-head', `Sprint ledger · mo. ${mo} · opening ${open} → closing ${close}`);
  const stmtBtn = el('button', 'btn btn-ghost btn-ledger-stmt', 'View statement');
  stmtBtn.id = 'btn-ledger-statement';
  stmtBtn.type = 'button';
  stmtBtn.title = 'Download a plain-text breakdown of this settlement';
  headRow.appendChild(head);
  headRow.appendChild(stmtBtn);

  const rows = el('div', 'ledger-rows');
  for (const line of L.lines) {
    const row = el('div', `ledger-line ${ledgerLineClass(line.kind)}`);
    row.appendChild(el('span', 'lbl', line.label));
    row.appendChild(el('span', 'amt', fmtLedgerAmt(line.amount, line.kind)));
    rows.appendChild(row);
  }
  root.innerHTML = '';
  root.appendChild(headRow);
  root.appendChild(rows);
}

/** Plain-text sprint ledger for downloads (matches HUD ``lastSprintLedger`` + burn notes). */
function buildLedgerStatementText() {
  const e = state.economy;
  const L = e.lastSprintLedger;
  const sm = typeof e.sprintMonth === 'number' && e.sprintMonth >= 1 ? e.sprintMonth : state.sprint.number;
  const lines = [];
  lines.push('SIMIANS INC. — SPRINT LEDGER STATEMENT');
  lines.push(`Generated (UTC): ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`Ledger month (Python settlement): ${sm}`);
  lines.push(`UI sprint number: ${state.sprint.number}`);
  lines.push(`Cash on HUD (synced): $${Math.round(safeNum(e.cash, 0)).toLocaleString()}`);
  lines.push(`MRR (HUD): $${Math.round(safeNum(typeof e.activeMrr === 'number' ? e.activeMrr : e.mrr, 0)).toLocaleString()}/mo`);
  lines.push(`Tech debt: ${Math.round(safeNum(e.techDebt, 0))}%`);
  lines.push('');
  if (L?.lines?.length) {
    lines.push('SETTLEMENT LINE ITEMS');
    if (L.opening != null) lines.push(`  Opening cash: $${Math.round(L.opening).toLocaleString()}`);
    for (const x of L.lines) {
      const amt = Number(x.amount) || 0;
      const sign = amt >= 0 ? '+' : '−';
      const abs = Math.round(Math.abs(amt)).toLocaleString();
      lines.push(`  [${x.kind}] ${x.label}`);
      lines.push(`           ${sign}$${abs}${x.kind === 'mrr' ? ' (recurring / MRR component)' : ''}`);
    }
    if (L.closing != null) lines.push(`  Closing cash: $${Math.round(L.closing).toLocaleString()}`);
  } else {
    lines.push('No settlement lines yet. Run a sprint to completion so POST /api/simulate can write the ledger.');
  }
  lines.push('');
  lines.push('BURN & BRIDGE (reference)');
  const sum = computeTeamStatsSumForTycoon();
  lines.push(`  team_stats_sum (UI roster tiers): ${sum}`);
  lines.push('  Python formula: raw_burn = team_stats_sum × $1,000 + $2,000 + active_mrr × 0.10');
  lines.push('  Demo bridge uses operating_burn = raw_burn × 0.52 (see src/dev_sim/tycoon_sprint.py).');
  if (e.lastSettlementBurn != null) {
    lines.push(`  lastSettlementBurn (this HUD): $${Math.round(e.lastSettlementBurn).toLocaleString()} / sprint`);
  }
  lines.push('');
  lines.push('— End of statement —');
  return lines.join('\n');
}

function downloadLedgerStatement() {
  const text = buildLedgerStatementText();
  const mo = typeof state.economy.sprintMonth === 'number' ? state.economy.sprintMonth : 1;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
    a.download = `simians-ledger-statement-mo-${mo}.txt`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

// ---------- roster ----------
function rosterStaticKey(a) {
  const kind = a.agentKind ? `${AGENT_KIND_LABELS[a.agentKind] || a.agentKind} · ` : '';
  const roleLine = `${kind}${ROLE_SHORT[a.role] || a.role} | ${a.seniority}`;
  return [a.id, a.fired ? '1' : '0', a.displayName, roleLine].join('\t');
}

function buildRosterCard(a) {
  const card = el('div', 'roster-card' + (a.fired ? ' fired' : '') + (a.speaking ? ' speaking' : ''));
  card.dataset.agentId = String(a.id);
  const img = el('img', 'roster-portrait');
  img.src = portrait(a, 32);
  img.alt = '';
  card.appendChild(img);

  const mid = el('div');
  mid.appendChild(el('div', 'roster-name', a.displayName));
  const kind = a.agentKind ? `${AGENT_KIND_LABELS[a.agentKind] || a.agentKind} · ` : '';
  mid.appendChild(el('div', 'roster-role', `${kind}${ROLE_SHORT[a.role] || a.role} | ${a.seniority}`));
  card.appendChild(mid);

  const meters = el('div', 'roster-meters');
  meters.appendChild(meter('energy', a.energy));
  meters.appendChild(meter('morale', (a.morale + 100) / 2));
  meters.appendChild(meter('focus', a.focus));
  card.appendChild(meters);

  return card;
}

function setMeterFill(barRoot, pct) {
  const i = barRoot?.querySelector?.('i');
  if (!i) return;
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  const prev = Number.parseFloat(String(i.style.width || '0'));
  if (Number.isFinite(prev) && Math.abs(prev - v) < 0.4) return;
  i.style.width = `${v}%`;
}

function renderRoster() {
  const root = qs('#roster');
  if (!root) return;

  const sum = computeTeamStatsSumForTycoon();
  const hintText = `Bridge burn input · team stat sum ${sum} (synced roster → POST /api/simulate)`;
  const structSig = state.team.map(rosterStaticKey).join('\n');

  let hint = root.firstElementChild;
  if (!hint || !hint.classList.contains('roster-hint')) {
    root.innerHTML = '';
    hint = el('div', 'roster-hint');
    root.appendChild(hint);
    _rosterStructSig = '';
  }
  hint.textContent = hintText;

  const nCards = root.querySelectorAll('.roster-card').length;
  const cardsMatch =
    nCards === state.team.length && structSig === _rosterStructSig && (state.team.length === 0 || nCards > 0);

  if (!cardsMatch) {
    _rosterStructSig = structSig;
    while (root.children.length > 1) root.removeChild(root.lastChild);
    for (const a of state.team) root.appendChild(buildRosterCard(a));
    return;
  }

  const cards = root.querySelectorAll('.roster-card');
  for (let i = 0; i < state.team.length; i++) {
    const a = state.team[i];
    const card = cards[i];
    if (!card || card.dataset.agentId !== String(a.id)) {
      _rosterStructSig = '';
      while (root.children.length > 1) root.removeChild(root.lastChild);
      for (const a2 of state.team) root.appendChild(buildRosterCard(a2));
      _rosterStructSig = state.team.map(rosterStaticKey).join('\n');
      return;
    }
    card.className = 'roster-card' + (a.fired ? ' fired' : '') + (a.speaking ? ' speaking' : '');
    const bars = card.querySelectorAll('.roster-meters .minibar');
    setMeterFill(bars[0], a.energy);
    setMeterFill(bars[1], (a.morale + 100) / 2);
    setMeterFill(bars[2], a.focus);
  }
}

function meter(kind, val) {
  const m = el('div', 'minibar ' + kind);
  const i = el('i'); i.style.width = Math.max(0, Math.min(100, val)) + '%';
  m.appendChild(i);
  return m;
}

// ---------- ticker ----------
function tickerLineSig(t) {
  return `${t.kind}\t${t.who}\t${t.text}`;
}

function renderTicker() {
  const root = qs('#ticker');
  if (!root) return;
  const items = state.ticker.slice(-30);
  const sig = items.map(tickerLineSig).join('\n');
  if (sig === _tickerFeedSig && root.childElementCount === items.length) return;
  _tickerFeedSig = sig;
  root.innerHTML = '';
  for (const t of items) {
    const div = el('div', `tick ${t.kind}`);
    div.innerHTML = `<span class="who">${escapeHtml(t.who)}</span> ${escapeHtml(t.text)}`;
    root.appendChild(div);
  }
}

// ---------- sprint board ----------
/** When only ``matrixLines`` change during orchestrate, patch the overlay instead of wiping the board (less flicker). */

function renderBoard() {
  const root = qs('#board');
  const structureSig = [
    state.sprint.phase,
    String(Math.round(Math.min(1, Math.max(0, state.ui?.sprintHeat || 0)) * 100)),
    String(!!state.ui?.orchestrateBusy),
    (state.sprint.backlog || []).map((t) => `${t.id}:${t.title}`).join('|'),
    JSON.stringify(state.sprint.progress || {}),
    JSON.stringify(state.sprint.assignments || {}),
  ].join('\n');

  const matrixText = (state.ui.matrixLines || []).slice(-36).join('\n');
  if (
    state.ui?.orchestrateBusy &&
    root?.dataset?.boardStructSig === structureSig &&
    root.querySelector('.matrix-board-overlay')
  ) {
    const pre = root.querySelector('.matrix-board-overlay .matrix-stream');
    if (pre && root.dataset.matrixStreamSig !== matrixText) {
      pre.textContent = matrixText;
      root.dataset.matrixStreamSig = matrixText;
    }
    return;
  }

  if (root) {
    root.dataset.boardStructSig = structureSig;
    root.dataset.matrixStreamSig = matrixText;
  }
  root.innerHTML = '';
  if (state.sprint.phase === 'execution') {
    const heat = Math.round(Math.min(1, Math.max(0, state.ui.sprintHeat || 0)) * 100);
    const strip = el('div', 'board-velocity-strip');
    const track = el('div', 'board-velocity-track');
    const fill = document.createElement('i');
    fill.style.width = heat + '%';
    track.appendChild(fill);
    strip.appendChild(el('div', 'board-velocity-label', 'SPRINT THROUGHPUT'));
    strip.appendChild(track);
    root.appendChild(strip);
  }
  const cols = [
    { key: 'todo', title: 'TODO', filter: (p) => p === 0 },
    { key: 'doing', title: 'DOING', filter: (p) => p > 0 && p < 0.6 },
    { key: 'review', title: 'REVIEW', filter: (p) => p >= 0.6 && p < 1 },
    { key: 'done', title: 'DONE', filter: (p) => p >= 1 },
  ];
  for (const c of cols) {
    const col = el('div', 'board-col');
    col.appendChild(el('div', 'board-col-title', c.title));
    for (const t of state.sprint.backlog) {
      const p = state.sprint.progress[t.id] || 0;
      if (!c.filter(p)) continue;
      const aid = state.sprint.assignments[t.id];
      const agent = state.team.find(a => a.id === aid);
      const card = el('div', 'ticket' + (p >= 1 ? ' done' : ''));
      card.style.borderLeftColor = agent?.tint || 'var(--accent-2)';
      card.innerHTML = `
        <div class="id">${t.id}</div>
        <div>${escapeHtml(t.title)}</div>
        <div class="who">${agent ? escapeHtml(agent.displayName) : '-'}</div>
      `;
      col.appendChild(card);
    }
    root.appendChild(col);
  }
  if (state.ui?.orchestrateBusy) {
    const ov = el('div', 'matrix-board-overlay');
    ov.appendChild(el('div', 'matrix-head', 'NEURAL BUILD PIPELINE // AI DEV TEAM'));
    const pre = document.createElement('pre');
    pre.className = 'matrix-stream';
    const lines = state.ui.matrixLines || [];
    pre.textContent = lines.slice(-36).join('\n');
    ov.appendChild(pre);
    root.appendChild(ov);
  }
}

// ---------- PR feed ----------
function prCommentHtml(c) {
  if (!c || typeof c !== 'object') return '';
  const who = escapeHtml(c.who || '');
  const raw = String(c.text || '');
  const isUrl = /^https:\/\/github\.com\//i.test(raw.trim());
  const body = isUrl
    ? `<a href="${escapeHtml(raw.trim())}" target="_blank" rel="noopener noreferrer">${escapeHtml(raw.trim())}</a>`
    : escapeHtml(raw);
  return `<div class="pr-diff">${who}: ${body}</div>`;
}

function renderPRs() {
  const root = qs('#prfeed');
  root.innerHTML = '';
  for (const pr of state.prs.slice(0, 6)) {
    const author = state.team.find(a => a.id === pr.agentId);
    const card = el('div', `pr-card ${pr.status}`);
    const ghLink =
      pr.htmlUrl && typeof pr.htmlUrl === 'string'
        ? `<div class="pr-meta"><a href="${escapeHtml(pr.htmlUrl)}" target="_blank" rel="noopener noreferrer">Open on GitHub</a></div>`
        : '';
    const metaName = pr.ghFullName ? escapeHtml(pr.ghFullName) : '';
    card.innerHTML = `
      <div class="pr-head">
        <div class="pr-title">${escapeHtml(pr.id)}: ${escapeHtml(pr.title)}</div>
        <div class="pr-meta">${pr.status}</div>
      </div>
      <div class="pr-meta">by ${author ? escapeHtml(author.displayName) : '-'}
        | <span class="diff-add">+${pr.additions}</span>
        / <span class="diff-del">-${pr.deletions}</span>${metaName ? ` | ${metaName}` : ''}</div>
      ${ghLink}
      ${(pr.comments || []).slice(-2).map((c) => prCommentHtml(c)).join('')}
    `;
    root.appendChild(card);
  }
  if (state.prs.length === 0) {
    root.innerHTML = '<div class="pr-meta">No PRs yet -- sprint not started.</div>';
  }
}

// ---------- events deck ----------
function renderEventsDeck() {
  const root = qs('#eventsdeck');
  if (!root) return;
  const recent = state.ticker.filter(t => t.kind === 'event' && t.who === 'World').slice(-4).reverse();
  const sig = recent.length === 0 ? '__empty__' : recent.map((r) => r.text).join('\n');
  const childCount = root.childElementCount;
  const expectChildren = recent.length === 0 ? 1 : recent.length;
  if (sig === _eventsDeckSig && childCount === expectChildren) return;
  _eventsDeckSig = sig;

  root.innerHTML = '';
  if (recent.length === 0) {
    root.innerHTML = '<div class="pr-meta" style="padding:8px">Random events will appear during sprints.</div>';
    return;
  }
  for (const r of recent) {
    const card = el('div', 'evt-card');
    const parts = r.text.split(' -- ');
    const title = parts[0] || r.text;
    const desc = parts[1] || '';
    card.innerHTML = `<div class="evt-icon">[*]</div><div class="evt-title">${escapeHtml(title)}</div><div class="pr-meta" style="margin-top:2px">${escapeHtml(desc)}</div>`;
    root.appendChild(card);
  }
}

// ---------- bottom levers ----------
function renderLevers() {
  const root = qs('#leverstrip');
  root.innerHTML = '';
  /** Spend levers stay off only while CEO chat is driving ``/api/orchestrate`` (not plain sprint execution). */
  const leversLocked = !!state.ui.orchestrateBusy || !!state.ui.sprintDrivenByOrchestrate;
  for (const lv of LEVERS) {
    const cashTooLow = state.economy.cash < lv.cost;
    const off = cashTooLow || leversLocked;
    const b = el('button', 'lever' + (off ? ' disabled' : ''));
    b.disabled = off;
    if (leversLocked && !cashTooLow) {
      b.title = 'Unavailable while the team is running a dev-sim build from chat.';
    } else if (cashTooLow) {
      b.title = 'Not enough cash.';
    } else {
      b.title = '';
    }
    b.innerHTML = `
      <div><span class="lever-icon">[+]</span> <span class="lever-name">${lv.name}</span></div>
      <div class="pr-meta">${lv.blurb}</div>
      <div class="lever-cost">${lv.cost ? '$' + lv.cost.toLocaleString() : 'free'}</div>
    `;
    b.addEventListener('click', () => {
      if (leversLocked || state.economy.cash < lv.cost) return;
      state.economy.cash -= lv.cost;
      lv.apply(state);
      pushTick('event', 'CEO', `purchased: ${lv.name}.`);
      const once = lv.cost > 0 ? ' One-time purchase — not billed again next sprint.' : '';
      toast(`${lv.name}: ${lv.blurb}${once}`, 'good');
    });
    root.appendChild(b);
  }

  const ach = qs('#achievements');
  if (ach) {
    const achSig = state.achievements.join(',');
    if (achSig !== _achievementsSig) {
      _achievementsSig = achSig;
      ach.innerHTML = '';
      const unlocked = state.achievements.slice(-4);
      for (const id of unlocked) {
        const a = ACHIEVEMENTS.find(x => x.id === id);
        if (!a) continue;
        ach.appendChild(el('div', 'ach', '[*] ' + a.name));
      }
    }
  }
}

// ---------- toasts ----------
/** Stable toast nodes — full ``innerHTML`` clears on every ``notify`` restarted CSS animations (rapid blink). */
const _toastEls = new Map();
let _toastListSig = '';

function renderToasts() {
  const root = qs('#toasts');
  const list = state.toasts || [];
  const sig = list.map((t) => `${t.id}\t${t.kind ?? ''}\t${t.text}`).join('|');
  if (sig === _toastListSig) return;
  _toastListSig = sig;

  const nextIds = new Set(list.map((t) => t.id));

  for (const id of [..._toastEls.keys()]) {
    if (!nextIds.has(id)) {
      _toastEls.get(id)?.remove();
      _toastEls.delete(id);
    }
  }

  for (const t of list) {
    let div = _toastEls.get(t.id);
    if (!div) {
      div = el('div', 'toast ' + (t.kind || ''), t.text);
      _toastEls.set(t.id, div);
    } else {
      const cls = 'toast ' + (t.kind || '');
      if (div.className !== cls) div.className = cls;
      if (div.textContent !== String(t.text)) div.textContent = t.text;
    }
  }
  for (let i = 0; i < list.length; i++) {
    const div = _toastEls.get(list[i].id);
    const next = i + 1 < list.length ? _toastEls.get(list[i + 1].id) : null;
    // Avoid ``appendChild`` every notify — moving an in-tree node restarts CSS animations / flickers.
    if (div.nextSibling !== next) root.insertBefore(div, next);
  }
}

// ---------- modals ----------
/** Last ``modalRenderSignature()`` — skip DOM wipe/rebuild when unchanged (stops intro blink on every ``notify``). */
let _modalRenderSig = '';

function modalRenderSignature() {
  if (!state.modal) return '';
  const { kind, payload } = state.modal;
  try {
    switch (kind) {
      case 'intro':
      case 'agents-help':
      case 'newspaper':
      case 'game-over':
        return kind;
      case 'agent-card':
        return `agent-card:${payload?.agentId ?? ''}`;
      case 'candidate-picker':
        return `candidate-picker:${payload?.firedId ?? ''}`;
      case 'hr-review': {
        const rows = Array.isArray(payload?.scores) ? payload.scores : [];
        return `hr-review:${rows.map((s) => `${s.agentId}:${s.total}:${s.flag ?? ''}`).join('|')}`;
      }
      case 'project': {
        const id = payload?.projectId;
        const proj = (state.projects || []).find((x) => x.id === id);
        if (!proj) return `project:${id}:missing`;
        return [
          'project',
          id,
          proj.phase ?? '',
          proj.prId ?? '',
          String(proj.error ?? '').slice(0, 160),
          proj.review?.score ?? '',
          (proj.html || '').length,
          (proj.readme || '').length,
          String(proj.gh?.htmlUrl || ''),
          String(proj.gh?.repoHomeUrl || ''),
          String(proj.targetRepoExport?.url || ''),
        ].join('\t');
      }
      case 'k2-audit':
        return `k2-audit:${JSON.stringify(payload ?? null)}`;
      default:
        return `${kind}:${JSON.stringify(payload ?? null)}`;
    }
  } catch {
    return `${kind}:invalid`;
  }
}

function renderModal() {
  const root = qs('#modal-root');
  if (!state.modal) {
    root.innerHTML = '';
    root.classList.remove('open');
    _modalRenderSig = '';
    return;
  }
  const sig = modalRenderSignature();
  if (sig === _modalRenderSig && root.classList.contains('open') && root.querySelector('.modal')) {
    return;
  }
  _modalRenderSig = sig;
  root.innerHTML = '';
  root.classList.add('open');
  switch (state.modal.kind) {
    case 'intro': renderIntroModal(root); break;
    case 'agent-card': renderAgentCardModal(root, state.modal.payload.agentId); break;
    case 'hr-review': renderHRReviewModal(root, state.modal.payload.scores); break;
    case 'candidate-picker': renderCandidatePickerModal(root, state.modal.payload.firedId); break;
    case 'newspaper': renderNewspaperModal(root); break;
    case 'game-over': renderGameOverModal(root); break;
    case 'project': renderProjectModal(root, state.modal.payload.projectId); break;
    case 'agents-help': renderAgentsHelpModal(root); break;
    case 'k2-audit': renderK2AuditModal(root, state.modal.payload); break;
  }
}

function modalShell(title, bodyEl, footerEl) {
  const wrap = el('div', 'modal');
  const head = el('div', 'modal-head');
  head.appendChild(el('div', 'modal-title', title));
  const close = el('button', 'x-close', 'X');
  close.addEventListener('click', closeModal);
  head.appendChild(close);
  wrap.appendChild(head);
  const body = el('div', 'modal-body');
  body.appendChild(bodyEl);
  wrap.appendChild(body);
  if (footerEl) {
    const foot = el('div', 'modal-foot');
    foot.appendChild(footerEl);
    wrap.appendChild(foot);
  }
  return wrap;
}

function renderIntroModal(root) {
  const body = el('div', 'intro-card');
  body.innerHTML = `
    <h1>SIMIANS</h1>
    <p style="color:var(--ink-1);max-width:520px;margin:20px auto 0;line-height:1.6">
      You are the CEO of a tiny software studio staffed by AI engineers.
      They have personalities, opinions, and a habit of opening pull requests
      at the worst possible moment. Ship products. Make money. Decide who stays.
    </p>
    <div class="intro-features">
      <div><b>Live agents</b> Each engineer has skills, mood, focus, loyalty, and an opinion of you.</div>
      <div><b>Chat to build</b> Bottom-left, ask the team for any game. They write the code, review it, and ship a PR with a playable preview.</div>
      <div><b>Real sprints</b> Stand-ups, PR reviews, retros, builds -- all play out on screen.</div>
      <div><b>Money loop</b> Salaries, MRR, contracts, raises, runway. Do not go broke.</div>
      <div><b>HR pressure</b> End-of-sprint scoreboard. Fire underperformers. Pick a contrasting replacement.</div>
    </div>
    <p style="color:var(--ink-2);font-size:11px">Tip: Click any agent (sprite or roster card) for their persona, meters, and action wheel.</p>
    <p style="color:var(--ink-2);font-size:11px;margin-top:8px">Close this dialog (X) to begin Sprint 1.</p>
  `;
  root.appendChild(modalShell('Welcome, CEO', body, null));
}

function renderAgentCardModal(root, agentId) {
  const a = state.team.find(x => x.id === agentId);
  if (!a) return;
  const body = el('div', 'persona-card');
  // left
  const left = el('div');
  const img = el('img');
  img.src = portrait(a, 200);
  img.className = 'persona-portrait';
  img.style.imageRendering = 'pixelated';
  left.appendChild(img);
  // radar
  const radar = drawRadar(a.skills, 200);
  const rwrap = el('div', 'radar-wrap');
  rwrap.appendChild(radar);
  left.appendChild(rwrap);
  body.appendChild(left);

  // right
  const right = el('div');
  right.innerHTML = `
    <div class="persona-name">${escapeHtml(a.displayName)}${a.fired ? ' <span style="color:var(--bad);font-size:12px">[FIRED]</span>' : ''}</div>
    <div class="persona-role">${a.agentKind ? escapeHtml(AGENT_KIND_LABELS[a.agentKind] || a.agentKind) + ' · ' : ''}${escapeHtml(ROLE_LABELS[a.role] || a.role)} | ${a.seniority} | ${a.yearsExperience}y exp | $${a.salary.toLocaleString()}/mo</div>
    <div class="persona-bio">${escapeHtml(a.bio)}</div>
    <div class="chip-row">
      ${a.traits.map(t => `<span class="chip trait">${escapeHtml(t)}</span>`).join('')}
      <span class="chip">${a.communicationStyle}</span>
      <span class="chip">${a.workStyle.replace(/_/g, ' ')}</span>
    </div>
    <div class="chip-row">
      ${a.preferredStack.map(s => `<span class="chip like">+ ${escapeHtml(s)}</span>`).join('')}
      ${a.dislikedStack.map(s => `<span class="chip dis">- ${escapeHtml(s)}</span>`).join('')}
    </div>
    <div style="font-size:11px;color:var(--ink-2);font-style:italic;margin-top:6px">"${escapeHtml(a.quirks)}"</div>
  `;
  // meters grid
  const grid = el('div', 'meters-grid');
  grid.appendChild(meterRow('Energy', a.energy, 'bar-energy'));
  grid.appendChild(meterRow('Morale', (a.morale + 100) / 2, 'bar-morale'));
  grid.appendChild(meterRow('Focus', a.focus, 'bar-focus'));
  grid.appendChild(meterRow('Loyalty', a.loyalty, 'bar-loyalty'));
  grid.appendChild(meterRow('Reputation', a.reputation, 'bar-rep'));
  grid.appendChild(meterRow('Burnout', a.burnout, 'bar-burn'));
  right.appendChild(grid);

  // skills pills
  const skillGrid = el('div', 'skills-grid');
  for (const [k, v] of Object.entries(a.skills)) {
    const p = el('div', 'skill-pill');
    p.innerHTML = `<span>${k}</span><span class="lvl">${Math.round(v)}</span>`;
    skillGrid.appendChild(p);
  }
  right.appendChild(skillGrid);

  if (!a.fired) {
    const wheel = el('div', 'action-wheel');
    wheel.appendChild(actionBtn('Praise (+morale)', 'btn-primary', () => actionPraise(a.id)));
    wheel.appendChild(actionBtn('Criticize (-morale)', '', () => actionCriticize(a.id)));
    wheel.appendChild(actionBtn('Coach 1:1 (-$1.5k)', '', () => actionCoach(a.id)));
    wheel.appendChild(actionBtn('Give Raise', '', () => actionRaise(a.id)));
    wheel.appendChild(actionBtn('Send to Conference', '', () => {
      if (state.economy.cash < 2500) return;
      state.economy.cash -= 2500;
      Object.keys(a.skills).forEach(k => a.skills[k] = Math.min(100, a.skills[k] + 6));
      a.morale = Math.min(100, a.morale + 10);
      pushTick('event', 'CEO', `sent ${a.displayName} to a conference.`);
      toast(`${a.displayName}: skills +6.`, 'good');
    }));
    wheel.appendChild(actionBtn('Fire X', 'btn-bad', () => {
      if (confirm(`Fire ${a.displayName}? This will hurt team morale and trigger a hire.`)) {
        actionFire(a.id);
      }
    }));
    right.appendChild(wheel);
  }
  body.appendChild(right);

  root.appendChild(modalShell(a.displayName, body));
}

function meterRow(label, val, cls) {
  const r = el('div', 'meter-row');
  r.innerHTML = `<div class="lbl"><span>${label}</span><span class="val">${Math.round(val)}</span></div>
    <div class="meter-bar ${cls}"><i style="width:${Math.max(0, Math.min(100, val))}%"></i></div>`;
  return r;
}

function actionBtn(label, cls, fn) {
  const b = el('button', 'btn ' + cls, label);
  b.addEventListener('click', fn);
  return b;
}

/** K2 rubric radar: scores are 1–10 per axis. */
function drawTycoonRadar(canvas, scores) {
  const size = canvas.width;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 36;
  const keys = TYCOON_TECH_KEYS;
  const n = keys.length;
  ctx.strokeStyle = '#2a3550';
  for (let g = 1; g <= 5; g++) {
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const px = cx + Math.cos(a) * (r * g / 5);
      const py = cy + Math.sin(a) * (r * g / 5);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.strokeStyle = '#334060';
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(110, 215, 255, 0.22)';
  ctx.strokeStyle = '#6ad7ff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  keys.forEach((k, i) => {
    const raw = scores && scores[k];
    const v = Math.max(0, Math.min(10, Number(raw) || 0)) / 10;
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const px = cx + Math.cos(a) * r * v;
    const py = cy + Math.sin(a) * r * v;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.fillStyle = '#b6c0d8';
  ctx.font = '9px JetBrains Mono, ui-monospace, monospace';
  keys.forEach((k, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const px = cx + Math.cos(a) * (r + 18);
    const py = cy + Math.sin(a) * (r + 18) + 3;
    ctx.textAlign = 'center';
    const short = k.replace(/([A-Z])/g, ' $1').trim().split(/\s+/).slice(0, 2).join(' ');
    ctx.fillText(short.length > 14 ? short.slice(0, 13) + '…' : short, px, py);
  });
}

function renderK2AuditModal(root, payload) {
  const technicalScores = payload?.technicalScores || {};
  const avgTechnical = typeof payload?.avgTechnical === 'number' ? payload.avgTechnical : 0;
  const approved = Boolean(payload?.approved);
  const projectName = payload?.projectName || 'Sprint';
  const usedSynthetic = Boolean(payload?.usedSyntheticRubric);
  const reviewScore = typeof payload?.reviewScore === 'number' ? payload.reviewScore : null;
  const wins = Array.isArray(payload?.wins) ? payload.wins : [];
  const issues = Array.isArray(payload?.issues) ? payload.issues : [];

  const body = el('div', 'k2-audit-body');
  const hero = el('div', 'k2-audit-hero');
  hero.innerHTML = `
    <h2 class="k2-audit-title">Staff engineer audit</h2>
    <p class="k2-audit-sub">${escapeHtml(projectName)}</p>
  `;
  body.appendChild(hero);

  if (usedSynthetic && reviewScore != null) {
    const syn = el('p', 'k2-audit-synthetic');
    syn.style.cssText = 'color:var(--ink-2);font-size:11px;margin:0 0 12px;line-height:1.45;max-width:520px';
    syn.textContent =
      `The API did not return per-metric K2 scores; the radar uses a proxy grid derived from the overall review score (${reviewScore}/100). When the bridge returns technical_scores, full detail appears here automatically.`;
    body.appendChild(syn);
  }

  if (wins.length || issues.length) {
    const box = el('div', 'k2-audit-verdict-box');
    box.style.cssText = 'font-size:11px;color:var(--ink-1);margin-bottom:12px;line-height:1.45;max-width:520px';
    if (wins.length) {
      const w = el('div');
      w.innerHTML = `<b style="color:var(--good)">Highlights</b><ul style="margin:4px 0 0 16px;padding:0">${wins.map((x) => `<li>${escapeHtml(String(x))}</li>`).join('')}</ul>`;
      box.appendChild(w);
    }
    if (issues.length) {
      const iss = el('div');
      iss.style.marginTop = wins.length ? '8px' : '0';
      iss.innerHTML = `<b style="color:var(--bad)">Findings</b><ul style="margin:4px 0 0 16px;padding:0">${issues.map((x) => `<li>${escapeHtml(String(x))}</li>`).join('')}</ul>`;
      box.appendChild(iss);
    }
    body.appendChild(box);
  }

  const layout = el('div', 'k2-audit-layout');
  const rw = el('div', 'k2-radar-wrap');
  const c = document.createElement('canvas');
  c.className = 'k2-radar-canvas';
  c.width = 300;
  c.height = 300;
  drawTycoonRadar(c, technicalScores);
  rw.appendChild(c);
  layout.appendChild(rw);

  const stamp = el('div', `k2-audit-stamp ${approved ? 'approved' : 'rejected'}`);
  stamp.textContent = approved ? 'APPROVED' : 'NEEDS FOLLOW-UP';
  layout.appendChild(stamp);
  body.appendChild(layout);

  const stats = el('div', 'k2-audit-stats');
  stats.textContent = `Average rubric score: ${avgTechnical.toFixed(2)} / 10 (10 K2 metrics)`;
  body.appendChild(stats);

  const footBtn = el('button', 'btn btn-primary', 'Continue');
  footBtn.addEventListener('click', closeModal);
  root.appendChild(modalShell('Code review', body, footBtn));
}

function drawRadar(skills, size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const cx = size / 2, cy = size / 2, r = size / 2 - 20;
  const keys = Object.keys(skills);
  const n = keys.length;
  ctx.strokeStyle = '#2a3550';
  for (let g = 1; g <= 4; g++) {
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const px = cx + Math.cos(a) * (r * g / 4);
      const py = cy + Math.sin(a) * (r * g / 4);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(110,215,255,0.3)';
  ctx.strokeStyle = '#6ad7ff';
  ctx.beginPath();
  keys.forEach((k, i) => {
    const v = skills[k] / 100;
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const px = cx + Math.cos(a) * r * v;
    const py = cy + Math.sin(a) * r * v;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#b6c0d8';
  ctx.font = '10px JetBrains Mono';
  keys.forEach((k, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const px = cx + Math.cos(a) * (r + 12);
    const py = cy + Math.sin(a) * (r + 12) + 3;
    ctx.textAlign = 'center';
    ctx.fillText(k.slice(0, 8), px, py);
  });
  return c;
}

function renderHRReviewModal(root, scores) {
  const body = el('div');
  const head = el('div');
  head.innerHTML = `
    <p style="color:var(--ink-1);margin:0 0 12px">
      End of <b>Sprint ${state.sprint.number}</b>. The numbers below feed into HR decisions.
      Star performers shine. Flagged underperformers are eligible to be fired.
    </p>
  `;
  body.appendChild(head);

  const grid = el('div', 'hr-grid');
  for (const sc of scores) {
    const a = state.team.find(x => x.id === sc.agentId);
    if (!a) continue;
    const card = el('div', 'hr-card' + (sc.flag === 'star' ? ' star' : sc.flag === 'underperformer' ? ' flagged' : ''));
    if (sc.flag === 'star') card.appendChild(el('div', 'hr-flag star', '* STAR'));
    if (sc.flag === 'underperformer') card.appendChild(el('div', 'hr-flag', '! AT RISK'));
    const img = el('img');
    img.src = portrait(a, 56);
    img.className = 'hr-portrait';
    img.style.cssText = 'width:56px;height:56px;margin:0 auto 4px;display:block;image-rendering:pixelated';
    card.appendChild(img);
    card.appendChild(el('div', 'hr-name', a.displayName));
    card.appendChild(el('div', 'hr-role', ROLE_LABELS[a.role]));
    card.appendChild(el('div', 'hr-score' + (sc.total < 40 ? ' bad' : ''), String(sc.total)));
    card.appendChild(el('div', 'hr-breakdown',
      `Quant ${sc.quant} | Qual ${sc.qual}\nFit ${sc.fit} | Player ${sc.player}\n${sc.completed} done | ${sc.merged} merged | ${sc.failed} fail`));
    grid.appendChild(card);
  }
  body.appendChild(grid);

  const headline = state.newspaperHeadlines[state.newspaperHeadlines.length - 1];
  if (headline) {
    const np = el('div');
    np.style.cssText = 'margin-top:16px;padding:12px;background:var(--bg-2);border-left:3px solid var(--gold);font-style:italic;font-size:12px;color:var(--ink-1)';
    np.textContent = '"' + headline + '"';
    body.appendChild(np);
  }

  const foot = el('div');
  foot.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap';
  const live = (state.team || []).filter((a) => !a.fired);
  const scoreById = new Map(scores.map((s) => [s.agentId, s]));
  if (live.length) {
    const sel = el('select');
    sel.style.cssText = 'padding:8px;background:var(--bg-2);color:var(--ink-0);border:1px solid var(--line);border-radius:6px;font-family:inherit';
    sel.appendChild(new Option('Let someone go (opens replacement hire)…', ''));
    for (const a of live) {
      const sc = scoreById.get(a.id);
      const tag =
        sc?.flag === 'underperformer' ? ' · at risk' : sc?.flag === 'star' ? ' · star' : '';
      const scTxt = sc ? ` · score ${sc.total}` : '';
      sel.appendChild(new Option(`${a.displayName}${scTxt}${tag}`, a.id));
    }
    foot.appendChild(sel);
    const fireBtn = el('button', 'btn btn-bad', 'Let go & hire >');
    fireBtn.addEventListener('click', () => {
      if (!sel.value) return;
      actionFire(sel.value);
    });
    foot.appendChild(fireBtn);
  }
  const cont = el('button', 'btn btn-primary', 'Continue >');
  cont.addEventListener('click', () => { closeModal(); advanceToNextSprint(); });
  foot.appendChild(cont);

  root.appendChild(modalShell(`HR Review | Sprint ${state.sprint.number}`, body, foot));
}

function renderCandidatePickerModal(root, firedId) {
  const fired = state.team.find(a => a.id === firedId);
  if (!fired) return;
  const body = el('div');
  const pool = state.candidatePool;
  if (!pool.length) {
    body.innerHTML = `<p style="color:var(--ink-1);margin:0 0 16px">
      <b>${escapeHtml(fired.displayName)}</b> has left the company.
      There is no candidate pool (the live team is the three dev-sim agents from the API). Run short-handed or reload after restoring the API roster.
    </p>`;
    const skip = el('button', 'btn', 'Continue >');
    skip.addEventListener('click', () => {
      closeModal();
      if (state.sprint.phase === 'review') advanceToNextSprint();
    });
    root.appendChild(modalShell('Team change', body, skip));
    return;
  }

  body.innerHTML = `<p style="color:var(--ink-1);margin:0 0 16px">
    <b>${escapeHtml(fired.displayName)}</b> has left the company.
    The system surfaces <b>3 candidates</b> deliberately weighted to contrast -- high contrast, moderate, and a wildcard.
  </p>`;

  const sameRole = pool.filter(c => c.role === fired.role);
  const others = pool.filter(c => c.role !== fired.role);
  const ranked = [...sameRole, ...others];
  function contrast(c) {
    const sd = new Set([...fired.traits, ...c.traits]);
    const both = fired.traits.filter(t => c.traits.includes(t)).length;
    return sd.size - both * 2 + (fired.communicationStyle !== c.communicationStyle ? 2 : 0)
      + (fired.workStyle !== c.workStyle ? 2 : 0);
  }
  ranked.sort((a, b) => contrast(b) - contrast(a));
  const high = ranked[0];
  const mid = ranked[Math.floor(ranked.length / 2)];
  const wild = ranked.length > 2 ? ranked[ranked.length - 1] : ranked[1];
  const picks = [
    { tag: 'HIGH CONTRAST', cls: 'contrast-high', cand: high },
    { tag: 'MODERATE FIT', cls: '', cand: mid },
    { tag: 'WILDCARD', cls: 'wildcard', cand: wild },
  ].filter(p => p.cand);

  const grid = el('div', 'cand-grid');
  for (const pk of picks) {
    const c = pk.cand;
    const card = el('div', 'cand-card ' + pk.cls);
    card.appendChild(el('div', 'cand-tag', pk.tag));
    const img = el('img');
    img.src = portrait(c, 80);
    img.style.cssText = 'width:80px;height:80px;margin:0 auto 6px;display:block;background:var(--bg-3);border-radius:6px;image-rendering:pixelated';
    card.appendChild(img);
    card.appendChild(el('div', 'cand-name', c.displayName));
    card.appendChild(el('div', 'cand-role', `${ROLE_LABELS[c.role]} | ${c.seniority}`));
    card.appendChild(el('div', 'cand-salary', `$${c.salary.toLocaleString()}/mo`));
    card.appendChild(el('div', 'cand-why', whyDifferent(fired, c)));
    const diff = el('div', 'cand-diff');
    diff.innerHTML = `
      <div class="row"><span class="from">${fired.communicationStyle}</span><span class="arrow">-&gt;</span><span class="to">${c.communicationStyle}</span></div>
      <div class="row"><span class="from">${fired.workStyle.replace(/_/g,' ')}</span><span class="arrow">-&gt;</span><span class="to">${c.workStyle.replace(/_/g,' ')}</span></div>
      <div class="row"><span class="from">${fired.traits.join(', ')}</span><span class="arrow">-&gt;</span><span class="to">${c.traits.join(', ')}</span></div>
    `;
    card.appendChild(diff);
    const hireBtn = el('button', 'btn btn-primary', 'Hire >');
    hireBtn.style.marginTop = '10px';
    hireBtn.addEventListener('click', () => {
      actionHire(c.id, fired.id);
      closeModal();
      if (state.sprint.phase === 'review') advanceToNextSprint();
    });
    card.appendChild(hireBtn);
    grid.appendChild(card);
  }
  body.appendChild(grid);

  const skip = el('button', 'btn', 'Run Short-Handed (skip hire)');
  skip.addEventListener('click', () => {
    closeModal();
    if (state.sprint.phase === 'review') advanceToNextSprint();
  });
  root.appendChild(modalShell('Replacement Candidates', body, skip));
}

function renderGameOverModal(root) {
  const body = el('div');
  body.style.textAlign = 'center';
  body.innerHTML = `
    <h2 style="color:var(--bad);font-size:28px;margin:0">BANKRUPT</h2>
    <p style="color:var(--ink-1)">You ran out of cash on Sprint ${state.sprint.number}.</p>
    <p style="color:var(--ink-2);font-size:11px">Final stats: ${state.stats.commits} commits | ${state.stats.prs} PRs | ${state.stats.firings} firings | Reputation ${Math.round(state.economy.reputation)}.</p>
    <p style="color:var(--ink-2);font-size:11px">Leadership style: <b>${leadershipLabel()}</b>.</p>
  `;
  const restart = el('button', 'btn btn-primary', 'Reload page to try again');
  restart.addEventListener('click', () => location.reload());
  root.appendChild(modalShell('Game Over', body, restart));
}

function renderNewspaperModal(root) {
  const body = el('div', 'newspaper');
  body.innerHTML = `
    <div class="dateline">SPRINT ${state.sprint.number} EDITION | SIMIAN TIMES</div>
    <h1>${escapeHtml(state.newspaperHeadlines[state.newspaperHeadlines.length - 1] || 'Quiet sprint at Simians Inc.')}</h1>
    <p>${state.newspaperHeadlines.slice(0, -1).reverse().map(escapeHtml).join('  ')}
    Reporters note that the team's morale and reputation continue to evolve based on CEO decisions, sprint velocity, and market reception.</p>
  `;
  root.appendChild(modalShell('The Simian Times', body));
}

// ---------- generated projects ----------
const LS_ORCH_SKIP_PLAN = 'dev-sim-orch-skip-planning';
const LS_ORCH_SKIP_K2 = 'dev-sim-orch-skip-k2';

function openProjectPreviewTab(sanitizedHtml) {
  const html = String(sanitizedHtml || '').trim();
  if (!html) {
    toast('No preview HTML for this project yet.', 'bad');
    return;
  }
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener,noreferrer');
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}

function renderProjects() {
  const root = qs('#projects');
  if (!root) return;
  root.innerHTML = '';
  const projects = state.projects || [];
  if (projects.length === 0) {
    root.innerHTML =
      '<div class="pr-meta" style="padding:8px">No shipped projects yet. Open team chat and send a build request.</div>';
    return;
  }
  for (const p of projects) {
    const card = el('div', `proj-card ${p.phase}`);
    const score = p.review?.score;
    if (score != null) {
      const span = el('span', `pscore ${score < 50 ? 'bad' : ''}`, `${score}/100`);
      card.appendChild(span);
    }
    card.appendChild(el('div', 'ptitle', p.name || p.id));
    card.appendChild(
      el('div', 'pmeta', `${p.id} | ${p.phase}${p.prId ? ` | ${p.prId}` : ''}`),
    );
    if (p.gh?.htmlUrl || p.gh?.repoHomeUrl || p.targetRepoExport?.url) {
      const linkRow = el('div', 'pmeta proj-card-links');
      linkRow.style.cssText =
        'display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:11px;line-height:1.35';
      if (p.gh?.htmlUrl) {
        const a = document.createElement('a');
        a.href = p.gh.htmlUrl;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = p.gh.prNumber != null ? `PR #${p.gh.prNumber}` : 'Pull request';
        a.style.cssText = 'color:var(--accent-2);text-decoration:underline;text-underline-offset:2px';
        linkRow.appendChild(a);
      }
      if (p.gh?.repoHomeUrl) {
        const a = document.createElement('a');
        a.href = p.gh.repoHomeUrl;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = 'Repository';
        a.title = p.gh.fullName ? `github.com/${p.gh.fullName}` : '';
        a.style.cssText = 'color:var(--accent);text-decoration:underline;text-underline-offset:2px';
        linkRow.appendChild(a);
      }
      if (p.targetRepoExport?.url) {
        const a = document.createElement('a');
        a.href = p.targetRepoExport.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = p.targetRepoExport.target ? `Export: ${p.targetRepoExport.target}` : 'Export branch';
        a.title = p.targetRepoExport.url;
        a.style.cssText = 'color:var(--gold);text-decoration:underline;text-underline-offset:2px';
        linkRow.appendChild(a);
      }
      card.appendChild(linkRow);
    }
    const hint = el('div', 'pmeta');
    const pr = (p.prompt || '').slice(0, 60);
    hint.textContent = pr + ((p.prompt || '').length > 60 ? '...' : '');
    card.appendChild(hint);

    const actions = el('div', 'proj-card-actions');
    const runBtn = el('button', 'btn btn-primary btn-tiny', '▶ Run game');
    runBtn.type = 'button';
    runBtn.title = 'Open playable HTML preview in a new tab';
    if (!p.sanitized || !String(p.sanitized).trim()) {
      runBtn.disabled = true;
      runBtn.classList.add('disabled');
      runBtn.title = 'Preview not available for this project';
    }
    runBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      openProjectPreviewTab(p.sanitized);
    });
    const detailsBtn = el('button', 'btn btn-ghost btn-tiny', 'Details');
    detailsBtn.type = 'button';
    detailsBtn.title = 'Team log, README, GitHub, audit';
    detailsBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      openModal('project', { projectId: p.id });
    });
    actions.appendChild(runBtn);
    actions.appendChild(detailsBtn);
    card.appendChild(actions);

    card.addEventListener('click', () => openModal('project', { projectId: p.id }));
    root.appendChild(card);
  }
}

// ---------- chat dock ----------
let chatActiveTab = 'log';
function renderChatLog() {
  const root = qs('#chatlog');
  if (!root) return;
  root.innerHTML = '';
  const items = (state.chatLog || []).slice(-40);
  for (const m of items) {
    const div = el('div', 'chat-msg ' + (m.kind || 'system'));
    if (m.kind === 'agent' || m.kind === 'ceo') {
      const who = el('span', 'who', m.who);
      div.appendChild(who);
    }
    const t = document.createTextNode(m.text);
    div.appendChild(t);
    root.appendChild(div);
  }
  root.scrollTop = root.scrollHeight;
}

function pushChat(kind, who, text) {
  state.chatLog = state.chatLog || [];
  state.chatLog.push({ kind, who, text, ts: Date.now() });
  if (state.chatLog.length > 80) state.chatLog.shift();
  renderChatLog();
}

// expose so orchestrator can mirror its log into the chat panel
subscribe(() => {
  // mirror most recent ticker chat lines into the chat dock
  const ticks = (state.ticker || []).filter(t => t.kind === 'chat').slice(-20);
  const seen = new Set((state.chatLog || []).map(m => m.who + ':' + m.text));
  for (const t of ticks) {
    const k = t.who + ':' + t.text;
    if (!seen.has(k)) {
      pushChat('agent', t.who, t.text);
      seen.add(k);
    }
  }
  // ``renderProjects`` is already invoked from ``renderAll`` — duplicating it here caused extra DOM churn.
});

function renderProjectModal(root, projectId) {
  const p = (state.projects || []).find(x => x.id === projectId);
  if (!p) return;
  const body = el('div');

  const sum = el('div');
  sum.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:11px;color:var(--ink-2)';
  sum.innerHTML = `
    <div><b style="color:var(--ink-0)">${escapeHtml(p.name || p.id)}</b> | ${p.id} ${p.prId ? '| ' + p.prId : ''} | phase: <b>${p.phase}</b></div>
    <div>${p.review ? `Review: <b style="color:${p.review.score < 50 ? 'var(--bad)' : 'var(--accent)'}">${p.review.score}/100</b>` : ''}</div>
  `;
  body.appendChild(sum);

  const brief = el('div');
  brief.style.cssText = 'font-size:11px;color:var(--ink-1);font-style:italic;margin-bottom:12px;padding:8px;background:var(--bg-2);border-left:3px solid var(--accent-2);border-radius:0 4px 4px 0';
  brief.textContent = '"' + p.prompt + '"';
  body.appendChild(brief);

  const tabs = el('div', 'proj-tabs');
  const tabKeys = [['preview', 'PLAY'], ['chat', 'TEAM CHAT'], ['code', 'CODE'], ['readme', 'README'], ['audit', 'AUDIT']];
  const content = el('div');
  let active = 'preview';
  function paint() {
    content.innerHTML = '';
    Array.from(tabs.children).forEach(b => b.classList.toggle('active', b.dataset.k === active));
    if (active === 'preview') {
      const wrap = el('div', 'proj-iframe-wrap');
      if (p.sanitized) {
        const iframe = document.createElement('iframe');
        iframe.sandbox = 'allow-scripts';
        iframe.srcdoc = p.sanitized;
        wrap.appendChild(iframe);
      } else {
        wrap.innerHTML = '<div style="color:var(--ink-2)">Build still in progress...</div>';
      }
      content.appendChild(wrap);
    } else if (active === 'chat') {
      const log = el('div', 'proj-log');
      if (p.log.length === 0) log.innerHTML = '<div style="color:var(--ink-2)">No log yet.</div>';
      for (const m of p.log) {
        const row = el('div', 'log-row');
        row.innerHTML = `<span class="who">${escapeHtml(m.who)}</span> <span style="font-size:9px;color:var(--ink-2)">${escapeHtml(ROLE_LABELS[m.role] || m.role || '')}</span><br>${escapeHtml(m.text)}`;
        log.appendChild(row);
      }
      content.appendChild(log);
    } else if (active === 'code') {
      const c = el('div', 'proj-code');
      c.textContent = p.html || 'No code yet.';
      content.appendChild(c);
    } else if (active === 'readme') {
      const r = el('div', 'proj-readme');
      r.textContent = p.readme || 'No README yet.';
      content.appendChild(r);
    } else if (active === 'audit') {
      const wrap = el('div');
      const ts =
        (p.review?.technicalScores && typeof p.review.technicalScores === 'object' ? p.review.technicalScores : null) ||
        (state.economy?.lastTechnicalScores && typeof state.economy.lastTechnicalScores === 'object'
          ? state.economy.lastTechnicalScores
          : null);
      if (!ts || typeof ts !== 'object') {
        wrap.innerHTML = '<p style="color:var(--ink-2);font-size:12px;line-height:1.5">No staff audit yet. End a sprint to run settlement and generate K2-style rubric scores on the server.</p>';
        content.appendChild(wrap);
      } else {
        const intro = el('p');
        intro.style.cssText = 'color:var(--ink-1);font-size:11px;margin:0 0 10px;line-height:1.5';
        intro.textContent = 'Latest technical audit (1–10 per metric) from the last sprint settlement.';
        wrap.appendChild(intro);
        const table = el('table', 'audit-table');
        const thead = document.createElement('thead');
        thead.innerHTML = '<tr><th>Metric</th><th>Score</th></tr>';
        table.appendChild(thead);
        const tbody = document.createElement('tbody');
        for (const key of TYCOON_TECH_KEYS) {
          const tr = document.createElement('tr');
          const v = ts[key];
          const n = typeof v === 'number' ? v : Number(v);
          const cell = Number.isFinite(n) ? `${n} / 10` : '—';
          tr.innerHTML = `<td>${escapeHtml(key)}</td><td>${escapeHtml(cell)}</td>`;
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        wrap.appendChild(table);
        content.appendChild(wrap);
      }
    }
  }
  for (const [k, label] of tabKeys) {
    const b = el('button', '', label);
    b.dataset.k = k;
    b.addEventListener('click', () => { active = k; paint(); });
    tabs.appendChild(b);
  }
  body.appendChild(tabs);
  body.appendChild(content);
  paint();

  const foot = el('div');
  foot.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
  if (p.gh?.htmlUrl) {
    const ghBtn = el(
      'a',
      'btn btn-primary',
      p.gh.prNumber != null ? `View PR #${p.gh.prNumber} on GitHub` : 'View PR on GitHub',
    );
    ghBtn.href = p.gh.htmlUrl;
    ghBtn.target = '_blank';
    ghBtn.rel = 'noopener noreferrer';
    ghBtn.style.textDecoration = 'none';
    foot.appendChild(ghBtn);
  }
  if (p.gh?.repoHomeUrl) {
    const repoBtn = el('a', 'btn btn-ghost', 'GitHub repository');
    repoBtn.href = p.gh.repoHomeUrl;
    repoBtn.target = '_blank';
    repoBtn.rel = 'noopener noreferrer';
    repoBtn.style.textDecoration = 'none';
    foot.appendChild(repoBtn);
  }
  if (p.targetRepoExport?.url) {
    const exBtn = el(
      'a',
      'btn btn-ghost',
      p.targetRepoExport.target ? `Export: ${p.targetRepoExport.target}` : 'Exported branch',
    );
    exBtn.href = p.targetRepoExport.url;
    exBtn.target = '_blank';
    exBtn.rel = 'noopener noreferrer';
    exBtn.title = p.targetRepoExport.url;
    exBtn.style.textDecoration = 'none';
    foot.appendChild(exBtn);
  }
  if (!p.gh?.htmlUrl && !p.gh?.repoHomeUrl && !p.targetRepoExport?.url) {
    const errText = p.error || p.ghError;
    if (errText) {
      const err = el('div');
      err.style.cssText = 'color:var(--bad);font-size:11px;align-self:center';
      err.textContent = String(errText).slice(0, 240);
      foot.appendChild(err);
    }
  }
  if (p.html || p.sanitized) {
    const runGame = el('button', 'btn btn-primary', '▶ Run game');
    runGame.title = 'Play the shipped HTML preview in a new tab';
    if (!p.sanitized || !String(p.sanitized).trim()) {
      runGame.disabled = true;
      runGame.classList.add('disabled');
    }
    runGame.addEventListener('click', () => openProjectPreviewTab(p.sanitized));
    foot.appendChild(runGame);
    const dl = el('button', 'btn', 'Download index.html');
    dl.addEventListener('click', () => downloadFile(`${slug(p.name || p.id)}.html`, p.sanitized));
    foot.appendChild(dl);
    if (p.readme) {
      const dr = el('button', 'btn', 'Download README.md');
      dr.addEventListener('click', () => downloadFile(`README-${slug(p.name || p.id)}.md`, p.readme));
      foot.appendChild(dr);
    }
  }

  root.appendChild(modalShell(`${p.name || p.id}`, body, foot));
}

function downloadFile(name, content) {
  const blob = new Blob([content], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }

function renderAgentsHelpModal(root) {
  const body = el('div');
  body.innerHTML = `
    <p style="color:var(--ink-1);font-size:12px;margin-top:0;line-height:1.55">
      CEO prompts are sent to the <strong>dev_sim_bridge</strong> HTTP service, which runs
      <code>dev-sim-run</code>-style flow: <strong>Claude planning</strong> splits the CEO ask into sprints, then each sprint runs
      Claude coding → K2 PR review → optional follow-up. In team chat you can enable <strong>Skip planning</strong>
      (one shot on your full prompt) and/or <strong>Skip K2 review</strong> (no quality gate or follow-up pass) for faster runs.
      Ending a game sprint calls <code>POST /api/simulate</code> to sync cash, MRR, valuation, and tech debt with the Python ledger;
      on load the HUD uses <code>GET /api/economy</code>. CEO chat can include <b>expected one-time</b> and <b>expected monthly</b>
      revenue; one-time hits cash when the agent ships, monthly is applied on the <b>next</b> ledger settlement.
      Put secrets in <code>.dev-sim/.env</code> (loaded first) or <code>.env</code> at the repo root —
      <code>ANTHROPIC_API_KEY</code>, <code>GITHUB_TOKEN</code>, <code>K2_API_KEY</code>, plus optional <code>TARGET_GITHUB_REPO</code>.
    </p>
    <pre style="font-size:11px;background:var(--panel);padding:12px;border-radius:8px;overflow:auto;line-height:1.45">
# Terminal 1 — from repo root
python -m dev_sim_bridge

# Terminal 2 — frontend
cd frontend &amp;&amp; npm run dev
    </pre>
    <p style="color:var(--ink-2);font-size:11px;margin-bottom:0">
      Vite proxies <code>/api</code> to <code>http://127.0.0.1:8765</code>. For a production build served elsewhere, set
      <code>VITE_DEV_SIM_API</code> to the bridge base URL when building.
    </p>
  `;
  const foot = el('div');
  const close = el('button', 'btn btn-primary', 'Close');
  close.addEventListener('click', closeModal);
  foot.appendChild(close);
  root.appendChild(modalShell('Real agents (dev-sim)', body, foot));
}

function qs(s) { return document.querySelector(s); }
function set(id, v) { const e = document.getElementById(id); if (e) e.textContent = v; }
function el(tag, cls = '', text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ---------- public init ----------
export function initHud() {
  const rosterRoot = qs('#roster');
  if (rosterRoot && !rosterRoot.dataset.delegatedClick) {
    rosterRoot.dataset.delegatedClick = '1';
    rosterRoot.addEventListener('click', (e) => {
      const card = e.target.closest('.roster-card[data-agent-id]');
      if (!card) return;
      openModal('agent-card', { agentId: card.dataset.agentId });
    });
  }

  const topbar = qs('#topbar');
  if (topbar && !topbar.dataset.ledgerStmtClick) {
    topbar.dataset.ledgerStmtClick = '1';
    topbar.addEventListener('click', (e) => {
      if (!e.target.closest('#btn-ledger-statement')) return;
      e.preventDefault();
      downloadLedgerStatement();
    });
  }

  qs('#btn-restart-game')?.addEventListener('click', () => {
    if (_restartInProgress) return;
    if (
      !confirm(
        'Restart the whole game?\n\n' +
          'Progress resets to Day 1 in the browser (sprint, roster, PRs, chat, projects).\n' +
          'The Python ledger (.dev-sim/company-state.json) is reset to starting cash/MRR so the next sprint matches.',
      )
    ) {
      return;
    }
    const restartBtn = qs('#btn-restart-game');
    _restartInProgress = true;
    if (restartBtn) restartBtn.disabled = true;
    bumpEconomyHydrateEpoch();

    void (async () => {
      try {
        state.modal = null;
        state.paused = true;
        resetGameState();
        clearSpeechBubbles();
        clearPortraitCache();
        _tickerFeedSig = '';
        _rosterStructSig = '';
        _ledgerStripSig = '';
        _eventsDeckSig = '';
        _achievementsSig = '\0';
        resetHudMoneyLerp();
        resetSimHudThrottle();
        document.body.classList.remove('td-crisis');

        /** @type {Record<string, unknown> | null} */
        let agentsPayload = null;
        try {
          agentsPayload = await fetchDevTeamAgents();
        } catch {
          /* summarized in outcome toast */
        }
        const rosterOk =
          !!agentsPayload &&
          typeof agentsPayload === 'object' &&
          agentsPayload.coding &&
          agentsPayload.review;

        let serverLedgerReset = false;
        try {
          await postResetCompanyState({ retries: 4, retryDelayMs: 200 });
          serverLedgerReset = true;
        } catch {
          /* summarized in outcome toast */
        }

        /** @type {Record<string, unknown> | null} */
        let co = null;
        try {
          co = await fetchCompanyState();
        } catch {
          /* keep defaults from resetGameState */
        }

        if (rosterOk) applyBackendTeam(/** @type {Record<string, unknown>} */ (agentsPayload), { silent: true });
        if (co) applyEconomyLedgerSnapshot({ ok: true, ...co }, { silent: true });
        planSprint({ quiet: true });

        state.paused = false;
        startSprint();

        const issues = [];
        if (!rosterOk) issues.push('team did not reload from /api/agents');
        if (!serverLedgerReset) issues.push('server ledger reset was not confirmed (is dev_sim_bridge on :8765?)');
        if (issues.length === 0) toast('Game restarted from Day 1.', 'good');
        else {
          toast(
            `Restarted in the browser, but: ${issues.join('; ')}. Fix the API, then use Restart again if needed.`,
            'bad',
          );
        }
      } finally {
        _restartInProgress = false;
        if (restartBtn) restartBtn.disabled = false;
      }
    })();
  });

  // chat dock
  const chatToggle = qs('#chat-toggle');
  const chatDock = qs('#chatdock');
  const chatForm = qs('#chatform');
  const chatInput = qs('#chatinput');
  function openChat() {
    chatDock.classList.add('open');
    chatToggle.classList.add('hide');
    chatToggle.setAttribute('aria-expanded', 'true');
    setTimeout(() => chatInput?.focus(), 50);
    if ((state.chatLog || []).length === 0) {
      pushChat('system', '', 'Tip: ask the team to build any game. Try "make me snake" or "build a flappy bird with neon colors".');
    }
    renderChatLog();
  }
  function closeChat() {
    chatDock.classList.remove('open');
    chatToggle.classList.remove('hide');
    chatToggle.setAttribute('aria-expanded', 'false');
  }
  chatToggle.addEventListener('click', openChat);
  const chatHideBtn = qs('#btn-chat-hide');
  if (chatHideBtn) chatHideBtn.addEventListener('click', () => closeChat());

  const orchPlan = qs('#orch-skip-planning');
  const orchK2 = qs('#orch-skip-k2-review');
  if (orchPlan && orchK2) {
    state.ui.orchestrateOptions = state.ui.orchestrateOptions || {};
    orchPlan.checked = localStorage.getItem(LS_ORCH_SKIP_PLAN) === '1';
    orchK2.checked = localStorage.getItem(LS_ORCH_SKIP_K2) === '1';
    state.ui.orchestrateOptions.skipPlanning = orchPlan.checked;
    state.ui.orchestrateOptions.skipK2Review = orchK2.checked;
    orchPlan.addEventListener('change', () => {
      state.ui.orchestrateOptions.skipPlanning = orchPlan.checked;
      localStorage.setItem(LS_ORCH_SKIP_PLAN, orchPlan.checked ? '1' : '0');
    });
    orchK2.addEventListener('change', () => {
      state.ui.orchestrateOptions.skipK2Review = orchK2.checked;
      localStorage.setItem(LS_ORCH_SKIP_K2, orchK2.checked ? '1' : '0');
    });
  }
  // close on Escape while focus is inside the chat dock
  chatDock.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || !chatDock.classList.contains('open')) return;
      e.preventDefault();
      closeChat();
      chatToggle.focus();
    },
    true,
  );
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = chatInput.value.trim();
    if (!v) return;
    chatInput.value = '';
    pushChat('ceo', 'CEO', v);
    runProject(v).catch(err => {
      pushChat('system', '', 'Error: ' + (err?.message || err));
    });
  });

  qs('#btn-agents-help').addEventListener('click', () => openModal('agents-help', {}));

  const economyHydrateAtInit = economyHydrateEpoch();
  void fetchEconomyLedger().then((d) => {
    if (economyHydrateAtInit !== economyHydrateEpoch()) return;
    if (d && d.ok !== false) applyEconomyLedgerSnapshot(d);
  });

  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.target instanceof HTMLElement && e.target.isContentEditable) return;
    if (e.code === 'Space' && _restartInProgress) {
      e.preventDefault();
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      state.paused = !state.paused;
      renderTopBar();
    } else if (e.code === 'Digit1') {
      state.speed = 1;
      renderTopBar();
    } else if (e.code === 'Digit2') {
      state.speed = 2;
      renderTopBar();
    } else if (e.code === 'Digit4') {
      state.speed = 4;
      renderTopBar();
    }
  });

  renderAll();
  subscribe(renderAll);
  openModal('intro', {});
}

function renderAll() {
  renderTopBar();
  renderRoster();
  renderTicker();
  renderBoard();
  renderPRs();
  renderEventsDeck();
  renderLevers();
  renderToasts();
  renderProjects();
  renderModal();
}
