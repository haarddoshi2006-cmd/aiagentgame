/**
 * Calls the local dev_sim_bridge HTTP server: Claude planning then
 * one coding → K2 → follow-up pass per planned sprint (same as ``dev-sim-run``).
 * Vite proxies ``/api`` → port 8765 in dev/preview.
 */

const API_PREFIX = (import.meta.env.VITE_DEV_SIM_API || '').replace(/\/$/, '');

/**
 * @param {string} prompt
 * @param {{
 *   expectedOneTime?: number,
 *   expectedMonthly?: number,
 *   coding?: Record<string, unknown>,
 *   review?: Record<string, unknown>,
 *   skipPlanning?: boolean,
 *   skipK2Review?: boolean,
 * }} [opts]
 */
export async function runDevSimOrchestrate(prompt, opts = {}) {
  const expectedOneTime = Math.max(0, Number(opts.expectedOneTime) || 0);
  const expectedMonthly = Math.max(0, Number(opts.expectedMonthly) || 0);
  const body = {
    prompt,
    expected_one_time: expectedOneTime,
    expected_monthly: expectedMonthly,
    skip_planning: !!opts.skipPlanning,
    skip_k2_review: !!opts.skipK2Review,
  };
  if (opts.coding && opts.review) {
    body.coding = opts.coding;
    body.review = opts.review;
  }
  const url = `${API_PREFIX}/api/orchestrate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    // Bridge uses HTTP 422 (and 429) with JSON where ``ok: false`` but ``codingPass1`` / etc. are still present.
    if (data && typeof data === 'object' && data.ok === false) {
      return data;
    }
    const msg = data.error || res.statusText || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

/** GET /api/economy — hydrate HUD from persisted Python ledger. */
export async function fetchEconomyLedger() {
  const url = `${API_PREFIX}/api/economy`;
  const res = await fetch(url);
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) return null;
  return data;
}

/**
 * One mocked sprint settlement on the Python tycoon ledger (same host/proxy as orchestrate).
 * @param {string} projectName
 * @param {string} projectSpec
 * @param {number} expectedMrr
 * @param {number} teamStatsSum
 * @returns {Promise<Record<string, unknown>>}
 */
export async function runTycoonSprint(projectName, projectSpec, expectedMrr, teamStatsSum) {
  const url = `${API_PREFIX}/api/simulate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project_name: projectName,
      project_spec: projectSpec || '',
      expected_mrr: Number(expectedMrr) || 0,
      team_stats_sum: Math.max(0, Math.floor(Number(teamStatsSum) || 0)),
    }),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const msg = data.error || res.statusText || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}
