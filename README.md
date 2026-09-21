# Simians — CEO Mode

Pixel-art studio sim: you run a small software company. Engineers have personas, the office animates, sprints tick, money and HR matter.

> **Entertainment + Media** (game subtrack) · frontend / CEO UX

---

## What’s in the repo

- **`frontend/`** — Vite + vanilla JS + Canvas 2D. Procedural sprites and HUD; no bundled image assets. A **local tick engine** drives stand-ups, tickets, PRs, and events when you are not on a live bridge build.
- **`dev_sim_bridge/`** — Python HTTP server (**8765**): team roster (`/api/agents`), CEO **`/api/orchestrate`** (planning → coding → review), and tycoon endpoints (`/api/simulate`, `/api/company`, `/api/economy`, …) used at sprint settlement.
- **`src/dev_sim/`** — FastAPI app and tycoon logic; also runnable alone via **`python run_api.py`** on **8000** (not the default Vite proxy target).

---

## Run it

### Frontend

From **`frontend/`** (uses **`package-lock.json`** — `npm`):

```bash
cd frontend
npm install
npm run dev       # http://localhost:5173
npm run build
npm run preview
```

Close the **welcome** dialog (X) to start Sprint 1.

### Optional backends

**Typical dev setup:** one Python process serves everything the UI calls:

```bash
# repo root
python -m dev_sim_bridge
```

`frontend/vite.config.js` proxies **`/api/*`** to **127.0.0.1:8765** for `dev` and `preview`.

**Ledger API only** (no agent bridge), from repo root:

```bash
python run_api.py   # http://127.0.0.1:8000
```

To use that instead of the bridge, change the Vite `server.proxy` / `preview.proxy` targets from **8765** to **8000**.

### CEO chat → real agents

With the bridge running, team chat hits **`/api/orchestrate`**: planning (unless skipped), coding agent opens a PR, K2-style review (optional **skip K2** fast path), optional follow-up. After a successful run, a **staff audit** modal runs; closing it triggers **sprint settlement** (tycoon sync + **HR review** modal). Chat **Agents** summarizes toggles and env vars.

### Economy dashboard (optional)

See [`economy-dashboard/README.md`](economy-dashboard/README.md) for the separate React app.

---

## Features (high level)

| Area | Notes |
|------|--------|
| **Team** | Roster from **`GET /api/agents`** when the bridge is up (coding + second coding + review). Meters, skills radar, persona modal. |
| **Sprints** | Phases planning → execution → review/HR; board + ticker; orchestrate links execution to a real build. |
| **Money** | Cash, MRR, burn, runway, spend levers, tech debt, reputation, leadership karma, game over at zero cash. |
| **HR** | Per-sprint scores, flags, fire flow → candidate picker with contrast scoring. |
| **Polish** | Events deck, achievements, headlines, optional CRT (`document.body.classList.add('crt')`). |

---

## Layout

```
frontend/
  index.html
  src/
    main.js                 # canvas loop + HUD
    styles.css
    state/store.js          # single store + modals/toasts
    sim/engine.js           # sprint tick, settlement hooks
    hud/render.js           # DOM + modals
    draw/scene.js           # office + sprites
    agents/orchestrator.js  # CEO → bridge
    agents/devSimBridge.js  # /api/orchestrate, tycoon fetch
    data/                   # personas, dialogue, events
dev_sim_bridge/             # Python bridge (8765)
src/dev_sim/                # FastAPI + tycoon (run_api.py → 8000)
```

---

## Extending

- **Personas / roster** — `frontend/src/data/personas.js` and backend **`/api/agents`** payload shape consumed in `store.js` / `backendPersona.js`.
- **Live activity** — replace or augment ticket/PR progression in `sim/engine.js`; ticker and HUD accept pushed events.
- **Scoring** — `computeScores()` in `engine.js` feeds the HR modal; keep `{ agentId, total, quant, qual, fit, player, flag }`-style rows.

For CI, add a job that `cd frontend && npm ci && npm run build` (upload `frontend/dist` if you want artifacts).
