// Multi-agent orchestrator (CEO chat). A prompt flows through:
//   1. Scrum Master  -> assigns coder + reviewer (in-world)
//   2–4. Real work    -> POST /api/orchestrate → dev_sim_bridge plans sprints then runs
//                       coding agent → K2 review → optional follow-up per sprint (``dev-sim-run``).
//   5. HUD / economy  -> maps K2 verdict into scores, PR feed, and HR-style rewards (final sprint).
//
// Everything emits ticker events and runs against the existing state object.

import {
  state,
  pushTick,
  toast,
  notify,
  setOrchestrateBusy,
  pushMatrixStreamLine,
  flushMatrixStreamHud,
  openModal,
  applyEconomyLedgerSnapshot,
  applyPlanningSprintsToBacklog,
  pushPlanningFeedFromText,
} from '../state/store.js';
import { planSprint, beginOrchestrateSprint, endOrchestrateSprint } from '../sim/engine.js';
import { averageTechnicalScores, TYCOON_TECH_KEYS } from '../data/tycoonRubric.js';
import { ROLE_LABELS } from '../data/personas.js';
import { pickTemplate, buildReadme, describeTemplate } from './templates.js';
import { runDevSimOrchestrate } from './devSimBridge.js';

let prCounter = 1000;
let projectCounter = 1;

const MATRIX_SNIPS = [
  'diff --git a/src/core.ts b/src/core.ts',
  'await anthropic.messages.create({ model: "claude-3-5-sonnet-latest", max_tokens: 8192',
  '[orchestrate] workspace=/tmp/dev-sim-ws … K2 review pass',
  'curl -sS -H "Authorization: Bearer $K2_API_KEY" $OPENAI_BASE_URL/chat/completions',
  'npm run build  ✓  typecheck  ✓  12 tests passed',
  'git commit -m "feat: CEO prompt — codegen + tests"',
  'class SprintLedger { balance: number; tech_debt: number',
  'POST /api/orchestrate 200  (coding_pass_1 complete)',
  'ruff check . --fix  |  black .  |  mypy src/',
  '>>> from dev_sim.review_agent import compute_k2_pr_review',
  'INFO:httpx:HTTP Request: POST https://api.k2… "200 OK"',
  'def push_workspace_to_target(workspace: Path, pr_owner: str',
  'conic-gradient(from -90deg, var(--accent) 0deg, var(--accent) 142deg',
  'export async function runDevSimOrchestrate(prompt) {',
  '[K2] verdict: approve | technical_scores: 10 keys present',
];

/** Collapse whitespace and cap length so team chat quotes the real CEO message, not boilerplate. */
function ceoPromptSnippet(text, maxLen = 220) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '(empty message)';
  if (t.length <= maxLen) return t;
  return `${t.slice(0, Math.max(1, maxLen - 1))}…`;
}

/** Small talk / greetings — not a product build request (used to keep team chat minimal). */
function isConversationalCeoPrompt(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return false;
  const t = raw.toLowerCase();
  if (raw.length > 320) return false;
  const buildy =
    /\b(make|build|create|implement|ship|pull\s*request|\bpr\b|feature|bug|fix\s+the|add\s+a\s+repo|commit|deploy|refactor|github|clone|patch|sprint|ticket|jira|endpoint|schema|migrate)\b/i.test(
      t,
    );
  if (buildy) return false;
  if (/^(hi|hello|hey|yo|hiya|howdy|good\s+(morning|afternoon|evening)|greetings)\b/i.test(t)) return true;
  if (/^(thanks|thank\s+you|thx|cheers)\b/i.test(t)) return true;
  if (/^(ok|okay|bye|goodbye|see\s+you)\b/i.test(t) && raw.length < 80) return true;
  if (raw.length < 56 && !/\n/.test(raw)) return true;
  return false;
}

let matrixIntervalId = null;

function stopMatrixStream() {
  if (matrixIntervalId != null) {
    clearInterval(matrixIntervalId);
    matrixIntervalId = null;
  }
  flushMatrixStreamHud();
  setOrchestrateBusy(false);
}

function startMatrixStream() {
  stopMatrixStream();
  setOrchestrateBusy(true);
  matrixIntervalId = setInterval(() => {
    const line = MATRIX_SNIPS[Math.floor(Math.random() * MATRIX_SNIPS.length)];
    pushMatrixStreamLine(line);
  }, 90);
}

function pickCodingAgent() {
  return state.team.find(a => !a.fired && a.agentKind === 'coding');
}

function pickReviewAgent() {
  return state.team.find(a => !a.fired && a.agentKind === 'review');
}

function pickCodingPairAgent() {
  return state.team.find(a => !a.fired && a.agentKind === 'coding_b');
}

// Sanitize the iframe content: drop scripts that escape origin.
function sanitize(html) {
  return html.replace(/window\.parent[^;]*/g, '/* removed */')
             .replace(/window\.top[^;]*/g, '/* removed */')
             .replace(/document\.cookie/g, '/* removed */');
}

/** Map K2 CodeReviewResult + verdict into the HUD “review score” shape. */
function reviewFromDevSim(review, verdict) {
  const issues = [];
  const wins = [];
  const v = String(verdict || review?.verdict || '').toLowerCase();
  let score = 60;
  const ts =
    (review && typeof review.technical_scores === 'object' && review.technical_scores) ||
    (review && typeof review.technicalScores === 'object' && review.technicalScores) ||
    null;
  const avgTechnical = ts ? averageTechnicalScores(ts) : null;

  if (review && Array.isArray(review.issues)) {
    for (const it of review.issues) {
      if (it && typeof it === 'object') {
        const line = it.summary || it.title || it.description || it.message;
        if (line) issues.push(String(line));
      } else if (it) issues.push(String(it));
    }
  }
  if (v === 'approve') {
    score = 88;
    wins.push('K2 verdict: approve');
  } else if (v === 'request_changes') {
    score = 48;
    issues.push('K2 verdict: request_changes');
  } else if (v === 'comment_only') {
    score = 66;
    wins.push('K2 verdict: comment_only');
  }
  if (review?.summary) wins.push(String(review.summary).slice(0, 160));

  return { score, issues, wins, blocked: false, technicalScores: ts, avgTechnical };
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function buildDevSimSummaryHtml(project, prompt, lp, api) {
  const url = escHtml(lp?.html_url || '#');
  const title = escHtml(project.name || project.id);
  const p = escHtml(prompt.slice(0, 800));
  const v = escHtml(String(api.verdict || ''));
  const sprintNote = Array.isArray(api.plannedSprints) && api.plannedSprints.length > 1
    ? `<p><strong>Sprints:</strong> ${api.plannedSprints.length} planned; summary reflects the <em>final</em> PR.</p>`
    : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body style="margin:0;background:#06080d;color:#e8ecf6;font-family:system-ui,sans-serif;padding:24px;min-height:100vh">
  <h1 style="margin-top:0">${title}</h1>
  <p>This CEO request was executed by the <strong>dev-sim</strong> planner, coding agent, and K2 review (see GitHub for the real diff).</p>
  ${sprintNote}
  <p><strong>Verdict:</strong> ${v}</p>
  <p><a href="${url}" style="color:#9ef0a6">Open GitHub pull request</a></p>
  <p style="opacity:0.85;white-space:pre-wrap">${p}</p>
</body></html>`;
}

function makeAgentNote(persona, text) {
  return { who: persona.displayName, role: ROLE_LABELS[persona.role], text };
}

// Bump per-agent stats so HR scoring reflects code quality.
function rewardAgent(agent, delta) {
  agent.energy = Math.max(0, Math.min(100, agent.energy + delta.energy || 0));
  agent.morale = Math.max(-100, Math.min(100, agent.morale + (delta.morale || 0)));
  agent.reputation = Math.max(0, Math.min(100, agent.reputation + (delta.rep || 0)));
  if (delta.skillKey && delta.skillVal) {
    agent.skills[delta.skillKey] = Math.max(0, Math.min(100, agent.skills[delta.skillKey] + delta.skillVal));
  }
  // also bump the engine's scoring counters via a synthetic merged PR record
  agent._codeQuality = (agent._codeQuality || 0) + (delta.quality || 0);
}

// Speech helper — canned lines (real dialogue runs in dev_sim agents on the server).
async function say(agent, kind, ctx, fallback) {
  setSpeak(agent, fallback);
  return fallback;
}
function setSpeak(agent, text) {
  agent.speaking = { text, ttl: 5 };
  agent.activity = 'speak';
  agent.activityTtl = 5;
}
function setTyping(agent) {
  agent.activity = 'type';
  agent.activityTtl = 8;
}

// Main entry point: handle a CEO prompt.
export async function runProject(prompt) {
  const projId = `PRJ-${projectCounter++}`;
  const snippet = ceoPromptSnippet(prompt, 240);
  const snippetBubble = ceoPromptSnippet(prompt, 96);
  const conversational = isConversationalCeoPrompt(prompt);
  if (!conversational) {
    pushTick('event', 'CEO', `${projId}: "${snippet}"`);
  }

  const coder = pickCodingAgent();
  const coderPair = pickCodingPairAgent();
  const reviewer = pickReviewAgent();
  if (!coder || !reviewer) {
    toast('Load the dev-sim team (start the API / bridge so /api/agents succeeds).', 'bad');
    return;
  }
  if (!state.backendPersonaPayload?.coding || !state.backendPersonaPayload?.coding_b || !state.backendPersonaPayload?.review) {
    toast('Team personas are not loaded. Start ``python run_api.py`` and reload the page.', 'bad');
    return;
  }
  const sm = reviewer;
  const tlead = reviewer;
  const arch = reviewer;

  const rev = readCeoRevenueExpectations();
  const project = {
    id: projId, prompt, phase: 'planning',
    createdAt: Date.now(),
    sm: sm.id, coder: coder.id, reviewer: tlead.id, arch: arch.id,
    log: [], html: null, sanitized: null, review: null, prId: null, name: null, readme: null,
    expectedOneTime: rev.expectedOneTime,
    expectedMonthly: rev.expectedMonthly,
  };
  state.projects = state.projects || [];
  state.projects.unshift(project);
  if (state.projects.length > 12) state.projects.pop();
  notify();

  if (!conversational) {
    emit(project, sm, `Acknowledged — ${projId}. Your message: "${snippet}"`);
    if (rev.expectedOneTime > 0 || rev.expectedMonthly > 0) {
      emit(project, sm, `Economics: +$${rev.expectedOneTime.toLocaleString()} one-time at ship · +$${rev.expectedMonthly.toLocaleString()}/mo starting next ledger sprint.`);
    }
    const pairLine = coderPair ? `, ${coderPair.displayName} pairing on implementation` : '';
    await say(sm, 'standup', { yesterday: 'triage', today: projId },
      `${projId} for "${snippetBubble}" — ${coder.displayName} on lead code${pairLine}, ${tlead.displayName} on review.`);
    pushTick('event', sm.displayName, `assigned ${coder.displayName} to ${projId}`);
    await sleep(450);
  }

  const tplKey = pickTemplate(prompt);
  const tplDesc = describeTemplate(tplKey);

  // 2–3. Server-side dev_sim: Claude coding agent → K2 PR review → optional follow-up
  project.phase = 'coding';
  notify();
  if (!conversational) {
    setTyping(coder);
    emit(project, coder, `Running dev-sim for your ask: "${snippet}"`);
    await say(coder, 'standup', { yesterday: 'CEO message', today: 'dev-sim bridge' },
      `Plan → coding agent → PR review for "${snippetBubble}" (may take a while).`);
  }

  let api;
  beginOrchestrateSprint();
  startMatrixStream();
  try {
    const orch = state.ui.orchestrateOptions || {};
    api = await runDevSimOrchestrate(prompt, {
      ...rev,
      coding: state.backendPersonaPayload?.coding,
      review: state.backendPersonaPayload?.review,
      skipPlanning: !!orch.skipPlanning,
      skipK2Review: !!orch.skipK2Review,
    });
  } catch (e) {
    project.phase = 'done';
    project.error = e?.message || String(e);
    emit(project, sm, `Bridge error: ${project.error}`);
    toast(project.error, 'bad');
    notify();
    return;
  } finally {
    stopMatrixStream();
    endOrchestrateSprint();
  }

  if (!api.ok) {
    project.phase = 'done';
    project.error = api.error || 'Unknown error';
    coder.activity = 'idle';
    coder.activityTtl = 0;
    const assistantReply = pickAssistantReplyFromOrchestrate(api);
    if (assistantReply) {
      emit(project, coder, assistantReply);
      if (conversational) {
        project.error = null;
      } else {
        emit(project, sm, `${project.error} (See coding agent reply above.)`);
        toast('Coding agent replied — no shipped build this run.', 'good');
      }
    } else {
      emit(project, sm, `dev-sim reported failure: ${project.error}`);
      toast(project.error, 'bad');
    }
    notify();
    return;
  }

  const planned = Array.isArray(api.plannedSprints) ? api.plannedSprints : [];
  const fp = api.fastPath && typeof api.fastPath === 'object' ? api.fastPath : null;
  if (fp && (fp.skipPlanning || fp.skipK2Review)) {
    const parts = [];
    if (fp.skipPlanning) parts.push('planning skipped');
    if (fp.skipK2Review) parts.push('K2 review skipped');
    pushTick('event', 'Bridge', `Fast path: ${parts.join(' · ')}.`);
  }
  if (typeof api.planningOutput === 'string' && api.planningOutput.trim()) {
    pushPlanningFeedFromText(api.planningOutput);
  }
  if (planned.length > 0) {
    const lines = planned.map((s) => `Sprint ${s.number}: ${s.title || '(untitled)'}`).join(' · ');
    emit(project, sm, `Planner split this into ${planned.length} sprint(s): ${lines}`);
    if (applyPlanningSprintsToBacklog(planned)) {
      planSprint({ quiet: true });
      pushTick('event', 'Planner', `Sprint board updated with ${planned.length} planned work item(s) from the model.`);
    }
  }

  const lp = api.lastPr;
  if (lp?.html_url) {
    const owner = String(lp.owner || '').trim();
    const repo = String(lp.repo || '').trim();
    const repoHomeUrl = owner && repo ? `https://github.com/${owner}/${repo}` : null;
    project.gh = {
      prNumber: lp.number,
      fullName: lp.fullName || (owner && repo ? `${owner}/${repo}` : ''),
      htmlUrl: lp.html_url,
      repoHomeUrl,
    };
  }

  const tpExport = api.targetPush && typeof api.targetPush === 'object' ? api.targetPush : null;
  if (tpExport && tpExport.ok === true && !tpExport.skipped && typeof tpExport.url === 'string' && tpExport.url.trim()) {
    project.targetRepoExport = {
      url: tpExport.url.trim(),
      target: typeof tpExport.target === 'string' ? tpExport.target.trim() : '',
    };
  }

  const es = api.economySnapshot;
  if (es && typeof es === 'object' && !es.error) {
    applyEconomyLedgerSnapshot({ ok: true, ...es });
    const ap1 = Math.round(Number(es.applied_one_time) || 0);
    const ap2 = Math.round(Number(es.applied_monthly_pipeline) || 0);
    if (ap1 > 0 || ap2 > 0) {
      emit(
        project,
        sm,
        `Python ledger updated: +$${ap1.toLocaleString()} cash now · +$${ap2.toLocaleString()}/mo goes live next sprint settlement.`,
      );
    }
  }

  const review = reviewFromDevSim(api.review, api.verdict);
  project.review = review;
  const apiScoresObj =
    (api.review?.technical_scores && typeof api.review.technical_scores === 'object' ? api.review.technical_scores : null) ||
    (api.review?.technicalScores && typeof api.review.technicalScores === 'object' ? api.review.technicalScores : null);
  const mergedScores =
    review.technicalScores && typeof review.technicalScores === 'object' && Object.keys(review.technicalScores).length
      ? review.technicalScores
      : apiScoresObj && Object.keys(apiScoresObj).length
        ? apiScoresObj
        : null;
  let rubricForHud = mergedScores;
  if (!rubricForHud || !Object.keys(rubricForHud).length) {
    const proxy = Math.max(1, Math.min(10, Math.round(review.score / 10)));
    rubricForHud = Object.fromEntries(TYCOON_TECH_KEYS.map((k) => [k, proxy]));
  }
  state.economy.lastTechnicalScores = { ...rubricForHud };

  const summaryHtml = buildDevSimSummaryHtml(project, prompt, lp, api);
  project.summaryHtml = summaryHtml;
  const previewRaw =
    api.previewHtml && String(api.previewHtml).trim() ? String(api.previewHtml) : null;
  project.workspacePath = typeof api.workspacePath === 'string' ? api.workspacePath : null;
  project.previewEntryPath = typeof api.previewEntryPath === 'string' ? api.previewEntryPath : null;
  project.html = previewRaw || summaryHtml;
  project.sanitized = sanitize(previewRaw || summaryHtml);

  project.phase = 'review';
  setTyping(tlead);
  emit(project, tlead, `K2 review finished (verdict: ${api.verdict || 'n/a'}).`);
  for (const w of review.wins) emit(project, tlead, `+ ${w}`);
  for (const i of review.issues) emit(project, tlead, `- ${i}`);
  await say(tlead, 'pr_review', { title: project.id, author: coder.displayName },
    review.score >= 75 ? `LGTM.` :
    review.score >= 50 ? `Minor nits. Ship with care.` :
    `Quality concerns.`);

  if (arch && arch.id !== tlead.id) {
    setSpeak(arch, 'Synced with the real PR on GitHub. Watch CI and human review.');
    emit(project, arch, `PR pipeline complete. Link in project card.`);
  }

  project.phase = 'merging';
  const prId = lp?.number != null ? `PR-${lp.number}` : `PR-${prCounter++}`;
  project.prId = prId;

  function collectBridgePrRows() {
    const rows = [];
    const seen = new Set();
    const sr = Array.isArray(api.sprintResults) ? api.sprintResults : [];
    for (const row of sr) {
      if (!row || typeof row !== 'object') continue;
      const lpRow = row.lastPr;
      if (!lpRow || typeof lpRow !== 'object') continue;
      const url = lpRow.html_url || lpRow.htmlUrl;
      if (!url || typeof url !== 'string') continue;
      if (seen.has(url)) continue;
      seen.add(url);
      rows.push({ row, lp: lpRow });
    }
    if (lp?.html_url && !seen.has(lp.html_url)) {
      rows.push({ row: { number: planned.length || 1, title: project.name, ok: true }, lp });
    }
    return rows;
  }

  let bridgePrRows = collectBridgePrRows();
  if (bridgePrRows.length === 0 && lp?.html_url) {
    bridgePrRows = [{ row: { number: planned.length || 1, title: project.name, ok: true }, lp }];
  }
  bridgePrRows.forEach(({ row, lp: lpR }, idx) => {
    const sn = row.number != null ? row.number : '?';
    const url = String(lpR.html_url || '');
    const num = lpR.number;
    const id = num != null ? `PR-${num}` : `GH-${sn}-${idx}`;
    const prTitle = String(lpR.title || row.title || `Sprint ${sn}`).slice(0, 200);
    state.prs.unshift({
      id,
      ticket: `${project.id}-S${sn}`,
      title: prTitle,
      agentId: coder.id,
      status: 'review',
      additions: Math.max(1, Math.round(String(prTitle).length / 3)),
      deletions: 0,
      comments: [
        { who: 'GitHub', text: url },
        {
          who: 'Planner',
          text: `Sprint ${sn}: ${String(row.title || '').slice(0, 100)}`,
        },
      ],
      openedAt: Date.now(),
      projectId: project.id,
      htmlUrl: url,
      ghFullName: lpR.fullName || (lpR.owner && lpR.repo ? `${lpR.owner}/${lpR.repo}` : ''),
    });
    state.stats.prs++;
  });
  if (state.prs.length > 30) state.prs.length = 30;
  project.name = guessName(prompt, tplDesc.title);
  const summaryLine = api.review?.summary
    ? String(api.review.summary).slice(0, 200)
    : `K2 verdict: ${api.verdict || 'n/a'}`;
  project.readme = buildReadme(project.name, prompt, tplKey, [
    makeAgentNote(sm, `CEO request routed to dev-sim (plan → sprints → orchestrate): "${prompt.slice(0, 120)}".`),
    rev.expectedOneTime > 0 || rev.expectedMonthly > 0
      ? makeAgentNote(
          sm,
          `Declared economics: $${rev.expectedOneTime.toLocaleString()} one-time at ship · $${rev.expectedMonthly.toLocaleString()}/mo recurring (next ledger sprint).`,
        )
      : null,
    makeAgentNote(coder, `Coding agent completed (stop=${api.codingPass1?.stop || 'n/a'}).`),
    makeAgentNote(tlead, summaryLine),
    api.followUpSkipped
      ? makeAgentNote(tlead, 'Follow-up coding pass skipped (approve verdict).')
      : makeAgentNote(coder, 'Follow-up coding pass ran after review JSON.'),
    arch && arch.id !== tlead.id ? makeAgentNote(arch, 'See GitHub PR for full diff and comments.') : null,
  ].filter(Boolean));

  if (review.score >= 50) state.stats.builds.pass++;
  else state.stats.builds.fail++;
  state.stats.commits += 3 + Math.floor(Math.random() * 5);

  pushTick('pr', coder.displayName, `opened ${prId}: ${project.name}`);
  pushTick('pr', tlead.displayName, `reviewed ${prId}: ${review.score}/100`);
  if (review.score >= 50) pushTick('pr', tlead.displayName, `merged ${prId}`);
  if (lp?.html_url) {
    toast(`PR ready: ${lp.fullName || 'GitHub'} #${lp.number}`, 'good');
  }

  // economy bump
  if (review.score >= 75) {
    state.economy.cash += 1500;
    state.economy.reputation = Math.min(100, state.economy.reputation + 3);
    toast(`${project.name} shipped! +$1,500, reputation +3`, 'good');
  } else if (review.score >= 50) {
    state.economy.cash += 600;
    toast(`${project.name} shipped (with notes). +$600`, 'good');
  } else {
    state.economy.reputation = Math.max(0, state.economy.reputation - 4);
    state.economy.techDebt = Math.min(100, state.economy.techDebt + 6);
    toast(`${project.name} shipped messy. Tech debt up.`, 'bad');
  }

  // 5. HR signal -> reward/penalize agents
  rewardAgent(coder, {
    morale: review.score >= 75 ? 8 : review.score >= 50 ? 2 : -10,
    rep: review.score >= 75 ? 6 : review.score >= 50 ? 2 : -6,
    quality: review.score,
    skillKey: 'frontend', skillVal: 1.5,
  });
  rewardAgent(tlead, { rep: 2, skillKey: 'leadership', skillVal: 0.6 });
  if (sm) rewardAgent(sm, { skillKey: 'comms', skillVal: 0.4 });
  if (review.score < 35 && coder.sprintsServed > 0) {
    coder._hrFlag = (coder._hrFlag || 0) + 1;
    pushTick('event', 'HR', `flagged ${coder.displayName} for low review score on ${prId}.`);
  }
  if (review.score >= 90) {
    pushTick('event', 'HR', `${coder.displayName} starred for excellent ${prId}.`);
  }

  project.phase = 'done';
  emit(project, sm, `${prId} merged. Sprint log updated. Next?`);
  notify();

  const avgTechnical = averageTechnicalScores(rubricForHud);
  const usedSyntheticRubric = !mergedScores || !Object.keys(mergedScores).length;
  openModal('k2-audit', {
    _runLedgerAfterClose: true,
    technicalScores: { ...rubricForHud },
    avgTechnical,
    approved: review.score >= 50,
    projectName: project.name || project.id,
    usedSyntheticRubric,
    reviewScore: review.score,
    issues: review.issues,
    wins: review.wins,
  });

  if (tpExport && tpExport.ok === true && !tpExport.skipped && tpExport.url) {
    toast(`Hackathon export pushed to ${tpExport.target || 'GitHub'} — ${tpExport.url}`, 'good');
  }

  const otClear = document.getElementById('chat-expected-onetime');
  const moClear = document.getElementById('chat-expected-monthly');
  if (otClear) otClear.value = '';
  if (moClear) moClear.value = '';
}

function guessName(prompt, fallback) {
  const m = prompt.match(/(?:called|named)\s+["']?([A-Z][\w\s]{2,30})["']?/i);
  if (m) return m[1].trim();
  const tokens = prompt.split(/\s+/).filter(w => w.length > 3 && !/^(make|build|create|me|game|like|with|that|the|and|for|please)$/i.test(w));
  if (tokens.length) return tokens.slice(0, 3).map(t => t[0].toUpperCase() + t.slice(1)).join(' ');
  return fallback;
}

let _emitNotifyRaf = 0;

/** Last coding-agent plain-text reply from ``/api/orchestrate`` when no PR shipped (e.g. ``stop: end_turn``). */
function pickAssistantReplyFromOrchestrate(api) {
  if (!api || typeof api !== 'object') return '';
  /** @param {unknown} o */
  const fromPass = (o) => {
    if (!o || typeof o !== 'object') return '';
    const raw =
      /** @type {{ assistant_text?: string; assistantText?: string }} */ (o).assistant_text ??
      /** @type {{ assistant_text?: string; assistantText?: string }} */ (o).assistantText;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : '';
  };
  const top = fromPass(api.codingPass1);
  if (top) return top;
  const sr = api.sprintResults;
  if (!Array.isArray(sr)) return '';
  for (let i = sr.length - 1; i >= 0; i -= 1) {
    const t = fromPass(sr[i]?.codingPass1);
    if (t) return t;
  }
  return '';
}

function emit(project, agent, text) {
  project.log.push({ who: agent.displayName, role: agent.role, text, ts: Date.now() });
  pushTick('chat', agent.displayName, text);
  if (!_emitNotifyRaf) {
    _emitNotifyRaf = requestAnimationFrame(() => {
      _emitNotifyRaf = 0;
      notify();
    });
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function readCeoRevenueExpectations() {
  const otEl = document.getElementById('chat-expected-onetime');
  const moEl = document.getElementById('chat-expected-monthly');
  const parseMoney = (v) => {
    const n = parseFloat(String(v ?? '').replace(/,/g, ''));
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  return {
    expectedOneTime: parseMoney(otEl?.value),
    expectedMonthly: parseMoney(moEl?.value),
  };
}
