// Procedural pixel-art portrait & sprite drawing.
// Everything is rendered to canvas with no asset files.

const SKIN = ['#f1c39f', '#d49b75', '#a8744f', '#7c5235', '#4d3322'];

function drawHead(ctx, x, y, scale, p) {
  const skin = SKIN[p.skin || 0];
  // head
  rect(ctx, x + 4, y + 4, 8, 8, skin, scale);
  // hair (top + sides)
  drawHair(ctx, x, y, scale, p);
  // accessory
  drawAcc(ctx, x, y, scale, p);
  // eyes
  rect(ctx, x + 6, y + 8, 1, 1, '#000', scale);
  rect(ctx, x + 9, y + 8, 1, 1, '#000', scale);
  // mouth
  rect(ctx, x + 7, y + 10, 2, 1, '#5a2030', scale);
}

function drawHair(ctx, x, y, scale, p) {
  const HAIR = '#3a2a1a';
  switch (p.hair) {
    case 'short': rect(ctx, x + 4, y + 3, 8, 2, HAIR, scale); break;
    case 'long':
      rect(ctx, x + 4, y + 3, 8, 2, HAIR, scale);
      rect(ctx, x + 3, y + 4, 1, 6, HAIR, scale);
      rect(ctx, x + 12, y + 4, 1, 6, HAIR, scale);
      break;
    case 'curly':
      rect(ctx, x + 3, y + 2, 10, 3, HAIR, scale);
      rect(ctx, x + 2, y + 4, 1, 2, HAIR, scale);
      rect(ctx, x + 13, y + 4, 1, 2, HAIR, scale);
      break;
    case 'bun':
      rect(ctx, x + 4, y + 3, 8, 2, HAIR, scale);
      rect(ctx, x + 6, y + 1, 4, 2, HAIR, scale);
      break;
    case 'bald': /* nothing */ break;
    case 'cap':
      rect(ctx, x + 4, y + 2, 8, 2, '#2a4f8a', scale);
      rect(ctx, x + 3, y + 4, 9, 1, '#2a4f8a', scale);
      break;
    case 'hood':
      rect(ctx, x + 3, y + 2, 10, 4, '#222', scale);
      rect(ctx, x + 4, y + 4, 8, 2, SKIN[p.skin||0], scale);
      break;
    case 'mohawk':
      rect(ctx, x + 7, y + 1, 2, 4, '#ff5577', scale);
      rect(ctx, x + 5, y + 3, 6, 1, '#222', scale);
      break;
    case 'braids':
      rect(ctx, x + 4, y + 3, 8, 2, HAIR, scale);
      rect(ctx, x + 2, y + 5, 2, 5, HAIR, scale);
      rect(ctx, x + 12, y + 5, 2, 5, HAIR, scale);
      break;
    case 'ponytail':
      rect(ctx, x + 4, y + 3, 8, 2, HAIR, scale);
      rect(ctx, x + 12, y + 4, 2, 5, HAIR, scale);
      break;
    case 'beanie':
      rect(ctx, x + 4, y + 2, 8, 3, '#6c3', scale);
      rect(ctx, x + 5, y + 1, 6, 1, '#6c3', scale);
      break;
  }
}

function drawAcc(ctx, x, y, scale, p) {
  switch (p.acc) {
    case 'none':
      break;
    case 'glasses':
      rect(ctx, x + 5, y + 7, 3, 2, '#000', scale);
      rect(ctx, x + 8, y + 7, 3, 2, '#000', scale);
      rect(ctx, x + 6, y + 8, 1, 1, '#cdf', scale);
      rect(ctx, x + 9, y + 8, 1, 1, '#cdf', scale);
      break;
    case 'shades':
      rect(ctx, x + 5, y + 7, 6, 2, '#000', scale);
      break;
    case 'headset':
      rect(ctx, x + 3, y + 5, 1, 4, '#444', scale);
      rect(ctx, x + 12, y + 5, 1, 4, '#444', scale);
      rect(ctx, x + 4, y + 4, 8, 1, '#444', scale);
      rect(ctx, x + 2, y + 7, 1, 1, '#9ef', scale);
      break;
    case 'monocle':
      rect(ctx, x + 8, y + 7, 3, 3, '#ffd166', scale);
      rect(ctx, x + 9, y + 8, 1, 1, '#fff', scale);
      break;
  }
}

function drawBody(ctx, x, y, scale, tint, walk = 0) {
  // shirt
  rect(ctx, x + 3, y + 12, 10, 6, tint, scale);
  // arms
  rect(ctx, x + 2, y + 12, 1, 5, tint, scale);
  rect(ctx, x + 13, y + 12, 1, 5, tint, scale);
  // legs (animate)
  const offL = walk === 1 ? 1 : 0;
  const offR = walk === 2 ? 1 : 0;
  rect(ctx, x + 5, y + 18 - offL, 2, 3 + offL, '#1c2438', scale);
  rect(ctx, x + 9, y + 18 - offR, 2, 3 + offR, '#1c2438', scale);
}

function rect(ctx, px, py, w, h, color, s) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(px * s), Math.round(py * s), Math.round(w * s), Math.round(h * s));
}

// Sprite is 16x22 in source pixels.
export function drawAgentSprite(ctx, x, y, scale, agent, walkFrame) {
  const p = agent.portrait && typeof agent.portrait === 'object' ? agent.portrait : { hair: 'short', skin: 0, acc: 'none' };
  drawHead(ctx, x, y, scale, p);
  drawBody(ctx, x, y, scale, agent.tint, walkFrame);
  // mood tint overlay
  if (agent.morale < -20) {
    ctx.fillStyle = 'rgba(60,80,140,0.25)';
    ctx.fillRect(x * scale, y * scale, 16 * scale, 22 * scale);
  } else if (agent.morale > 60) {
    ctx.fillStyle = 'rgba(255,220,120,0.18)';
    ctx.fillRect(x * scale, y * scale, 16 * scale, 22 * scale);
  }
  // burnout glow
  if (agent.burnout > 60) {
    ctx.strokeStyle = 'rgba(255,80,80,0.6)';
    ctx.lineWidth = scale;
    ctx.strokeRect(x * scale + 1, y * scale + 1, 16 * scale - 2, 22 * scale - 2);
  }
}

// Portrait at larger size for HUD cards (renders to its own canvas, returns dataURL).
export function makePortraitDataURL(agent, size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  // background
  ctx.fillStyle = '#0c111c';
  ctx.fillRect(0, 0, size, size);
  // floor
  ctx.fillStyle = '#1c2438';
  ctx.fillRect(0, size - 6, size, 6);
  const scale = size / 16;
  drawAgentSprite(ctx, 0, -2, scale, agent, 0);
  return c.toDataURL();
}
