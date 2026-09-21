# File structure (`frontend/`)

Update this file when the layout changes.

```
frontend/
├── index.html                 # Entry HTML + HUD shell; loads /src/main.js (Vite)
├── vite.config.js             # Vite root, publicDir, dist/
├── package.json
├── build.sh / install.sh      # pnpm install + vite build + copy public → dist
├── public/
│   └── assets/
│       └── game_config.json   # Runtime config placeholder
├── src/
│   ├── api/
│   │   └── economyApi.js      # GET /api/company, POST /api/simulate → FastAPI
│   ├── main.js                # Canvas, resizer, render loop, sim tick, HUD init
│   ├── styles.css             # Full layout + HUD + modals
│   ├── core/
│   │   └── createCanvasContext.js
│   ├── system/
│   │   └── createResizer.js   # DPR + canvas backing store vs CSS size
│   ├── loop/
│   │   └── createRenderLoop.js
│   ├── draw/
│   │   ├── portrait.js        # Procedural sprites / portraits
│   │   └── scene.js           # Office room, desks, FX, bubbles
│   ├── hud/
│   │   └── render.js          # DOM panels, modals, sprint board, chat
│   ├── sim/
│   │   └── engine.js          # Sprint simulation + tickets + PRs
│   ├── state/
│   │   └── store.js           # Game state, subscribe, modals, toasts
│   ├── data/
│   │   ├── personas.js        # Seed agents + candidates + backlog
│   │   ├── dialogue.js        # Stand-up / PR / retro lines
│   │   └── events.js          # Event deck, levers, achievements
│   └── agents/
│       ├── orchestrator.js    # CEO prompt → dev_sim (lead coder + K2 review; pair coder in-world)
│       ├── devSimBridge.js      # POST /api/orchestrate → bridge (plan + dev-sim-run per sprint)
│       └── templates.js       # README scaffolding + template metadata
├── developer.md
└── designer.md
```
