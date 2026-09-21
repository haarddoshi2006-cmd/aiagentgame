import './styles.css';
import { createCanvasContext } from './core/createCanvasContext.js';
import { createRenderLoop } from './loop/createRenderLoop.js';
import { createResizer } from './system/createResizer.js';
import { drawScene, agentAt } from './draw/scene.js';
import { fetchCompanyState } from './api/economyApi.js';
import { fetchDevTeamAgents } from './api/agentsApi.js';
import { initHud } from './hud/render.js';
import { initGameMusic } from './audio/gameMusic.js';
import { tick } from './sim/engine.js';
import { state, openModal, notify, applyBackendTeam, economyHydrateEpoch } from './state/store.js';

const { canvas, ctx } = createCanvasContext('#stage');
const { viewport } = createResizer(canvas);

initHud();
initGameMusic();

async function hydrateEconomyFromServer() {
  const epochAtStart = economyHydrateEpoch();
  try {
    const d = await fetchCompanyState();
    if (epochAtStart !== economyHydrateEpoch()) return;
    if (!d.persisted) return;
    state.economy.cash = Math.round(Number(d.balance) || 0);
    state.economy.mrr = Math.round(Number(d.active_mrr) || 0);
    state.economy.techDebt = Math.min(100, Math.max(0, Number(d.tech_debt) || 0));
    state.economy.valuation = Number(d.valuation) || 0;
    state.economy.hypeMultiplier = Number(d.hype_multiplier) || 1;
    notify();
  } catch {
    /* FastAPI not running or first run — keep baked-in defaults */
  }
}
void hydrateEconomyFromServer();

async function hydrateAgentsFromServer() {
  try {
    const payload = await fetchDevTeamAgents();
    applyBackendTeam(payload);
  } catch (e) {
    /* Vite must proxy /api/agents to dev_sim_bridge (8765) or run FastAPI on 8000 */
    console.warn('[dev-sim] Failed to load /api/agents — roster will stay empty until reload.', e);
  }
}
void hydrateAgentsFromServer();

// click on canvas -> agent
canvas.addEventListener('click', (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left);
  const y = (e.clientY - rect.top);
  const a = agentAt(x, y);
  if (a) openModal('agent-card', { agentId: a.id });
});

const startRenderLoop = createRenderLoop(({ delta }) => {
  ctx.setTransform(viewport.scale, 0, 0, viewport.scale, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, viewport.width, viewport.height);
  drawScene(ctx, viewport, Math.min(delta || 0.016, 0.05));
  tick(Math.min(delta || 0.016, 0.05));
});

startRenderLoop();
