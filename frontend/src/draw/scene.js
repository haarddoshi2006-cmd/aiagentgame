// The pixel-art office scene. Renders desks, agents, speech bubbles, FX.
import { state, openModal } from '../state/store.js';
import { drawAgentSprite } from '../draw/portrait.js';

const TILE = 16;
const ROOM_W = 32; // tiles
const ROOM_H = 18;

// FX particles
const fx = [];

export function spawnFx(kind, x, y) {
  for (let i = 0; i < 8; i++) {
    fx.push({
      kind, x, y,
      vx: (Math.random() - 0.5) * 2,
      vy: -Math.random() * 2 - 1,
      life: 1,
      ttl: 1,
    });
  }
}

function deskFor(i) {
  // Three desks: two coders (left / mid) and PR review (right), matching GET /api/agents roster order
  const positions = [
    { x: 8, y: 7 },
    { x: 15, y: 7 },
    { x: 23, y: 7 },
  ];
  return positions[i] || positions[0];
}

// agent home target
function targetForAgent(agent, idx) {
  const d = deskFor(idx);
  // walk to a tile in front of desk
  return { x: d.x * TILE, y: (d.y + 1) * TILE };
}

// initialize positions on first render (and after new agents replace the roster)
function ensurePositions(viewportW, viewportH) {
  const room = computeRoom(viewportW, viewportH);
  const offsetX = room.x;
  const offsetY = room.y;
  const tile = room.tile;
  let i = 0;
  for (const a of state.team) {
    if (a.fired) continue;
    if (!a._officePlaced) {
      const t = targetForAgent(a, i);
      a.px = offsetX + (t.x * tile) / TILE;
      a.py = offsetY + (t.y * tile) / TILE;
      a.tx = a.px;
      a.ty = a.py;
      a.deskIdx = i;
      a._officePlaced = true;
    }
    i++;
  }
}

function hudTopReservePx() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--hud-topbar-height').trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : 120;
}

function computeRoom(vw, vh) {
  // pick integer scale that fits room into available space
  const topR = hudTopReservePx();
  const availW = vw - 320 - 320 - 24; // panels each side
  const availH = vh - topR - 88 - 16;
  const tile = Math.max(2, Math.floor(Math.min(availW / ROOM_W, availH / ROOM_H)));
  const w = ROOM_W * tile;
  const h = ROOM_H * tile;
  const x = Math.floor((vw - w) / 2);
  const y = topR + Math.floor((vh - topR - 88 - h) / 2);
  return { x, y, w, h, tile };
}

let walkPhase = 0;
let lastT = 0;
let bubbleEls = new Map();
const bubbleLayer = document.createElement('div');
bubbleLayer.id = 'bubble-layer';
bubbleLayer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:8;';
document.body.appendChild(bubbleLayer);

const bubbleStyle = document.createElement('style');
bubbleStyle.textContent = `
.bub {
  position: absolute;
  background: #fff;
  color: #111;
  border: 2px solid #111;
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 11px;
  max-width: 220px;
  font-family: 'JetBrains Mono', monospace;
  transform: translate(-50%, -100%);
  white-space: pre-wrap;
  pointer-events: auto;
  cursor: pointer;
  animation: bubIn .15s;
  box-shadow: 0 4px 0 rgba(0,0,0,.4);
}
.bub::after {
  content: '';
  position: absolute;
  bottom: -8px;
  left: 50%;
  transform: translateX(-50%);
  border: 6px solid transparent;
  border-top-color: #111;
}
.bub.commit { background: #d8fadf; }
.bub.celebrate { background: #fff3c0; }
.bub.speak { background: #fff; }
@keyframes bubIn { from { transform: translate(-50%, -90%) scale(.8); opacity: 0; } }
`;
document.head.appendChild(bubbleStyle);

/** Remove all speech-bubble DOM nodes (e.g. after game restart). */
export function clearSpeechBubbles() {
  for (const el of bubbleEls.values()) {
    el.remove();
  }
  bubbleEls.clear();
}

function syncBubbles() {
  const seen = new Set();
  for (const a of state.team) {
    if (a.fired) continue;
    if (a.speaking && a.spriteScreenX != null) {
      let el = bubbleEls.get(a.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'bub speak';
        el.addEventListener('click', () => openModal('agent-card', { agentId: a.id }));
        bubbleLayer.appendChild(el);
        bubbleEls.set(a.id, el);
      }
      el.textContent = a.speaking.text;
      el.style.left = a.spriteScreenX + 'px';
      el.style.top = (a.spriteScreenY - 6) + 'px';
      seen.add(a.id);
    }
  }
  for (const [id, el] of bubbleEls) {
    if (!seen.has(id)) { el.remove(); bubbleEls.delete(id); }
  }
}

export function drawScene(ctx, viewport, dt) {
  walkPhase += dt;
  const vw = viewport.width;
  const vh = viewport.height;
  ensurePositions(vw, vh);

  const room = computeRoom(vw, vh);
  const { x: ox, y: oy, w: rw, h: rh, tile } = room;

  // background gradient
  const g = ctx.createLinearGradient(0, 0, 0, vh);
  g.addColorStop(0, '#06080d');
  g.addColorStop(1, '#0c111c');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, vw, vh);

  // room floor (checkered)
  for (let ty = 0; ty < ROOM_H; ty++) {
    for (let tx = 0; tx < ROOM_W; tx++) {
      const isWall = ty === 0 || ty === ROOM_H - 1 || tx === 0 || tx === ROOM_W - 1;
      if (isWall) ctx.fillStyle = '#1a223a';
      else ctx.fillStyle = (tx + ty) % 2 ? '#13192a' : '#171f33';
      ctx.fillRect(ox + tx * tile, oy + ty * tile, tile, tile);
    }
  }
  // window strip on top
  for (let i = 0; i < 4; i++) {
    const wx = ox + (3 + i * 7) * tile;
    ctx.fillStyle = '#3a5a8a';
    ctx.fillRect(wx, oy + tile, tile * 3, tile * 2);
    ctx.fillStyle = '#6ad7ff';
    ctx.fillRect(wx + 2, oy + tile + 2, tile * 3 - 4, tile * 2 - 4);
    ctx.fillStyle = '#3a5a8a';
    ctx.fillRect(wx + tile * 1.5 - 1, oy + tile, 2, tile * 2);
  }

  // desks — one per roster seat (coding, coding_b, review)
  const desks = [0, 1, 2].map((i) => deskFor(i));
  for (const d of desks) {
    drawDesk(ctx, ox + d.x * tile, oy + d.y * tile, tile);
  }

  // pot plants in corners
  drawPlant(ctx, ox + tile * 2, oy + tile * (ROOM_H - 3), tile);
  drawPlant(ctx, ox + tile * (ROOM_W - 3), oy + tile * (ROOM_H - 3), tile);

  // server rack
  drawServer(ctx, ox + tile * 1, oy + tile * 6, tile);
  // coffee machine
  drawCoffee(ctx, ox + tile * (ROOM_W - 2), oy + tile * 9, tile);

  // agents — move towards target, draw sprite, save screen pos
  for (const a of state.team) {
    if (a.fired) continue;
    const t = targetForAgent(a, a.deskIdx ?? 0);
    const tx = ox + t.x * tile / TILE;
    const ty = oy + t.y * tile / TILE;

    // wander a bit when idle
    if (a.activity === 'idle' && Math.random() < 0.005) {
      a.tx = tx + (Math.random() - 0.5) * tile * 3;
      a.ty = ty + (Math.random() - 0.5) * tile * 1.5;
    } else if (a.activity !== 'idle') {
      a.tx = tx;
      a.ty = ty;
    }
    a.tx = a.tx ?? tx;
    a.ty = a.ty ?? ty;

    const dx = a.tx - a.px;
    const dy = a.ty - a.py;
    const dist = Math.hypot(dx, dy);
    if (dist > 1) {
      a.px += dx / dist * 30 * dt;
      a.py += dy / dist * 30 * dt;
    }
    const moving = dist > 1.5;
    const wf = moving ? (Math.floor(walkPhase * 6) % 2 === 0 ? 1 : 2) : 0;
    const sscale = tile / TILE; // sprite scale to match tile
    drawAgentSprite(ctx, a.px / sscale, a.py / sscale - 22, sscale, a, wf);
    a.spriteScreenX = a.px + 8 * sscale;
    a.spriteScreenY = a.py - 22 * sscale;

    // commit FX
    if (a.activity === 'celebrate' && a.activityTtl > 1.5) {
      drawCelebrate(ctx, a.px + 8 * sscale, a.py - 26 * sscale, walkPhase);
    }
    if (a.activity === 'type') {
      drawTypingDots(ctx, a.px + 8 * sscale, a.py - 30 * sscale, walkPhase);
    }
  }

  // FX particles
  for (let i = fx.length - 1; i >= 0; i--) {
    const p = fx[i];
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.08;
    p.life -= dt * 1.5;
    if (p.life <= 0) { fx.splice(i, 1); continue; }
    ctx.fillStyle = p.kind === 'bad' ? '#ff6b81' : '#ffd166';
    ctx.fillRect(Math.round(p.x), Math.round(p.y), 3, 3);
  }

  syncBubbles();
}

function drawDesk(ctx, x, y, t) {
  // desk top
  ctx.fillStyle = '#3a2e1a';
  ctx.fillRect(x, y + t, t * 3, t);
  // legs
  ctx.fillStyle = '#1a1410';
  ctx.fillRect(x, y + t * 2, t / 2, t);
  ctx.fillRect(x + t * 2.5, y + t * 2, t / 2, t);
  // monitor
  ctx.fillStyle = '#222';
  ctx.fillRect(x + t * 0.6, y, t * 1.8, t);
  ctx.fillStyle = '#5ee0a0';
  ctx.fillRect(x + t * 0.7, y + 2, t * 1.6, t - 4);
  // keyboard
  ctx.fillStyle = '#888';
  ctx.fillRect(x + t * 0.4, y + t + 2, t * 2.2, t / 4);
  // coffee mug
  ctx.fillStyle = '#fff';
  ctx.fillRect(x + t * 2.4, y + t - 4, 6, 6);
}

function drawPlant(ctx, x, y, t) {
  ctx.fillStyle = '#5b3a20';
  ctx.fillRect(x, y + t, t, t / 2);
  ctx.fillStyle = '#3aaa55';
  ctx.fillRect(x - 2, y, t + 4, t);
  ctx.fillStyle = '#5ee0a0';
  ctx.fillRect(x + 2, y - 4, t - 4, t);
}

function drawServer(ctx, x, y, t) {
  ctx.fillStyle = '#222';
  ctx.fillRect(x, y, t, t * 3);
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#5ee0a0' : '#ffd166';
    ctx.fillRect(x + 4, y + 4 + i * 6, 4, 2);
  }
}

function drawCoffee(ctx, x, y, t) {
  ctx.fillStyle = '#5a1a1a';
  ctx.fillRect(x, y, t, t * 1.5);
  ctx.fillStyle = '#222';
  ctx.fillRect(x + 4, y + 4, t - 8, t / 2);
  ctx.fillStyle = '#ffd166';
  ctx.fillRect(x + 6, y + 6, 2, 2);
}

function drawCelebrate(ctx, x, y, phase) {
  for (let i = 0; i < 5; i++) {
    const a = phase * 4 + i * 1.2;
    const px = x + Math.cos(a) * 12;
    const py = y + Math.sin(a) * 4 - 6;
    ctx.fillStyle = ['#ffd166', '#9ef0a6', '#6ad7ff'][i % 3];
    ctx.fillRect(Math.round(px), Math.round(py), 3, 3);
  }
}

function drawTypingDots(ctx, x, y, phase) {
  for (let i = 0; i < 3; i++) {
    const visible = (Math.floor(phase * 4) + i) % 3 === 0;
    if (visible) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(x - 6 + i * 5, y, 3, 3);
    }
  }
}

// hit test agent at screen coords
export function agentAt(sx, sy) {
  const tile = Math.max(2, 16);
  for (const a of state.team) {
    if (a.fired) continue;
    if (a.spriteScreenX == null) continue;
    if (Math.abs(sx - a.spriteScreenX) < 16 && Math.abs(sy - a.spriteScreenY - 8) < 22) return a;
  }
  return null;
}
