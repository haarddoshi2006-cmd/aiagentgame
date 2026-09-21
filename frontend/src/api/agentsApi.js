/**
 * Load three dev-sim agents (coding, coding_b, review) from the backend.
 * Vite proxies ``/api/agents`` to ``dev_sim_bridge`` on port 8765 (``python -m dev_sim_bridge``).
 * Alternatively run ``python run_api.py`` on 8000 and point Vite at that port.
 */

function unwrapAgentsPayload(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.ok && data.coding && data.coding_b && data.review) {
    return { coding: data.coding, coding_b: data.coding_b, review: data.review };
  }
  if (data.coding && data.coding_b && data.review) {
    return { coding: data.coding, coding_b: data.coding_b, review: data.review };
  }
  return null;
}

export async function fetchDevTeamAgents(seed) {
  const q = seed != null && seed !== '' ? `?seed=${encodeURIComponent(String(seed))}` : '';
  const r = await fetch(`/api/agents${q}`);
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(t || `HTTP ${r.status}`);
  }
  const data = await r.json();
  const inner = unwrapAgentsPayload(data);
  if (!inner) throw new Error('Invalid /api/agents response');
  return inner;
}
