/**
 * FastAPI economy endpoints (`dev_sim.api`).
 * Dev server proxies `/api/*` → http://127.0.0.1:8000 (see `vite.config.ts`).
 */

const prefix = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

export type SprintRequest = {
  project_name: string;
  project_spec: string;
  expected_mrr: number;
  team_stats_sum: number;
};

export type SettlementStatus = 'SERIES_A' | 'BANKRUPT' | 'OUTAGE_SURVIVED' | 'CONTINUE';

export type SprintResponse = {
  project_name: string;
  technical_scores: Record<string, number>;
  tech_debt_delta: number;
  actual_mrr: number;
  balance: number;
  valuation: number;
  tech_debt: number;
  hype_multiplier: number;
  active_mrr: number;
  burn_rate: number;
  sprint_month: number;
  status: SettlementStatus;
};

async function parseJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function simulateSprint(payload: SprintRequest): Promise<SprintResponse> {
  const res = await fetch(`${prefix}/api/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await parseJson(res)) as Record<string, unknown>;
  if (!res.ok) {
    const detail = body.detail ?? body.message ?? res.statusText;
    const msg = typeof detail === 'string' ? detail : JSON.stringify(detail);
    throw new Error(msg || `HTTP ${res.status}`);
  }
  return body as SprintResponse;
}

export async function fetchCompany(): Promise<Record<string, unknown>> {
  const res = await fetch(`${prefix}/api/company`);
  const body = await parseJson(res);
  if (!res.ok) throw new Error((body as { message?: string }).message ?? res.statusText);
  return body as Record<string, unknown>;
}
