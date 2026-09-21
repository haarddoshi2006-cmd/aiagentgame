# Economy dashboard (React + TypeScript)

Separate from the canvas **CEO Mode** app in `../frontend/`. This UI drives the **FastAPI** tycoon ledger in `src/dev_sim/api.py`.

## Run

Terminal 1 — repo root:

```bash
python run_api.py
```

Terminal 2 — this folder:

```bash
cd economy-dashboard
npm install
npm run dev
```

Open **http://localhost:5174**. Vite proxies `/api/simulate` and `/api/company` to **http://127.0.0.1:8000**.

## Layout

| Area | Role |
|------|------|
| `src/services/api.ts` | `simulateSprint(payload)` → `POST /api/simulate` |
| `src/context/GameContext.tsx` | Bank, valuation, tech debt, MRR; roster; `hireAgent` / `fireAgent`; `team_stats_sum`; sprint runner + victory / bankrupt modals |
| `src/components/SimulateSprintPanel.tsx` | Project name, spec, expected MRR; submit button |
| `src/components/TechnicalAudit.tsx` | 10-metric rubric grid from `technical_scores` |
| `src/components/RosterPanel.tsx` | Edit stats (1–5) and roster size (burn driver) |

Optional: `VITE_API_URL=http://127.0.0.1:8000` at build time if you serve the SPA without the dev proxy.
