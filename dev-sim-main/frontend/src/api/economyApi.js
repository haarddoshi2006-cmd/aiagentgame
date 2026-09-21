/**
 * Company ledger for initial HUD hydrate. Proxied in dev to ``dev_sim_bridge`` (8765) or FastAPI (8000).
 * @see run_api.py / dev_sim_bridge ``GET /api/company``
 */

const PREFIX = (import.meta.env.VITE_FASTAPI_URL || '').replace(/\/$/, '');

async function parseJsonOrThrow(res) {
  let body = {};
  try {
    body = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const msg = body.detail || body.message || res.statusText || `HTTP ${res.status}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return body;
}

/** Current persisted company ledger (includes `persisted` when server supports it). */
export async function fetchCompanyState() {
  const res = await fetch(`${PREFIX}/api/company`);
  return parseJsonOrThrow(res);
}

/**
 * Overwrite ``.dev-sim/company-state.json`` with Day 1 defaults (matches UI restart).
 * @param {{ retries?: number, retryDelayMs?: number }} [opts]
 */
export async function postResetCompanyState(opts = {}) {
  const retries = Math.max(1, Math.floor(Number(opts.retries) || 3));
  const retryDelayMs = Math.max(0, Math.floor(Number(opts.retryDelayMs) || 220));
  let lastErr = new Error('Company reset failed');
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${PREFIX}/api/company/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      return await parseJsonOrThrow(res);
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (i < retries - 1) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
  }
  throw lastErr;
}

/** One sprint settlement + mock K2-style technical scores (server-side). */
export async function postSimulateSprint(payload) {
  const res = await fetch(`${PREFIX}/api/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseJsonOrThrow(res);
}
