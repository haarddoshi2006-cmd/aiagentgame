// Game templates — small, real, runnable HTML+JS mini-games.
// Used as deterministic fallback (no API key) and as scaffolds the LLM can extend.
// Each template returns a complete self-contained HTML string (canvas + JS).

function shell(title, bodyJs, instructions) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
  html,body{margin:0;background:#06080d;color:#e8ecf6;font-family:'JetBrains Mono',monospace;overflow:hidden;height:100%}
  canvas{display:block;background:#0c111c;image-rendering:pixelated}
  #wrap{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px}
  #hud{position:fixed;top:8px;left:8px;font-size:12px;color:#9ef0a6;text-shadow:0 0 6px #5ee0a0}
  #help{position:fixed;bottom:8px;left:50%;transform:translateX(-50%);font-size:11px;color:#7c89a8}
</style>
</head>
<body>
<div id="wrap"><canvas id="c" width="640" height="400"></canvas></div>
<div id="hud">Score: <span id="s">0</span></div>
<div id="help">${instructions}</div>
<script>
${bodyJs}
</script>
</body>
</html>`;
}

const templates = {
  pong: {
    title: 'Pong',
    instructions: 'Move mouse vertically. Beat the AI.',
    code: `
const c=document.getElementById('c'),x=c.getContext('2d');
let ball={x:320,y:200,vx:4,vy:3,r:6},p1={y:170,h:60},p2={y:170,h:60},score=[0,0];
c.addEventListener('mousemove',e=>{const r=c.getBoundingClientRect();p1.y=e.clientY-r.top-30});
function step(){
  ball.x+=ball.vx;ball.y+=ball.vy;
  if(ball.y<6||ball.y>394)ball.vy*=-1;
  // ai
  p2.y+=Math.sign(ball.y-(p2.y+30))*3;
  // collide
  if(ball.x<18&&ball.y>p1.y&&ball.y<p1.y+60){ball.vx=Math.abs(ball.vx)+0.3;}
  if(ball.x>622&&ball.y>p2.y&&ball.y<p2.y+60){ball.vx=-Math.abs(ball.vx)-0.3;}
  if(ball.x<0){score[1]++;reset(1)} if(ball.x>640){score[0]++;reset(-1)}
  draw();requestAnimationFrame(step);
}
function reset(d){ball.x=320;ball.y=200;ball.vx=4*d;ball.vy=(Math.random()-.5)*6;document.getElementById('s').textContent=score.join(' - ')}
function draw(){
  x.fillStyle='#0c111c';x.fillRect(0,0,640,400);
  x.fillStyle='#9ef0a6';x.fillRect(8,p1.y,8,60);x.fillRect(624,p2.y,8,60);
  x.beginPath();x.arc(ball.x,ball.y,ball.r,0,Math.PI*2);x.fill();
  x.fillStyle='#2a3550';for(let i=0;i<400;i+=12)x.fillRect(318,i,4,6);
}
step();`,
  },

  snake: {
    title: 'Snake',
    instructions: 'Arrow keys. Eat the apples. Do not bite yourself.',
    code: `
const c=document.getElementById('c'),x=c.getContext('2d'),G=20,W=32,H=20;
let snake=[{x:10,y:10}],dir={x:1,y:0},apple={x:5,y:5},score=0,t=0,alive=true;
addEventListener('keydown',e=>{const k=e.key;
  if(k==='ArrowUp'&&dir.y!==1)dir={x:0,y:-1};
  else if(k==='ArrowDown'&&dir.y!==-1)dir={x:0,y:1};
  else if(k==='ArrowLeft'&&dir.x!==1)dir={x:-1,y:0};
  else if(k==='ArrowRight'&&dir.x!==-1)dir={x:1,y:0};
});
function step(){
  if(alive&&++t%6===0){
    const h={x:snake[0].x+dir.x,y:snake[0].y+dir.y};
    if(h.x<0||h.y<0||h.x>=W||h.y>=H||snake.some(s=>s.x===h.x&&s.y===h.y)){alive=false}
    else{snake.unshift(h);
      if(h.x===apple.x&&h.y===apple.y){score++;document.getElementById('s').textContent=score;
        apple={x:Math.floor(Math.random()*W),y:Math.floor(Math.random()*H)};
      }else snake.pop();}
  }
  draw();requestAnimationFrame(step);
}
function draw(){
  x.fillStyle='#0c111c';x.fillRect(0,0,640,400);
  x.fillStyle='#ff6b81';x.fillRect(apple.x*G,apple.y*G,G,G);
  x.fillStyle='#9ef0a6';snake.forEach((s,i)=>x.fillRect(s.x*G,s.y*G,G-1,G-1));
  if(!alive){x.fillStyle='#fff';x.font='28px monospace';x.fillText('GAME OVER',230,200);}
}
step();`,
  },

  breakout: {
    title: 'Breakout',
    instructions: 'Mouse to move. Clear the bricks.',
    code: `
const c=document.getElementById('c'),x=c.getContext('2d');
let pad={x:280,w:80},ball={x:320,y:300,vx:3,vy:-3},bricks=[],score=0;
for(let r=0;r<4;r++)for(let i=0;i<10;i++)bricks.push({x:i*64,y:40+r*22,w:60,h:18,col:['#ff6b81','#ffd166','#5ee0a0','#6ad7ff'][r],alive:true});
c.addEventListener('mousemove',e=>{const r=c.getBoundingClientRect();pad.x=Math.max(0,Math.min(560,e.clientX-r.left-40))});
function step(){
  ball.x+=ball.vx;ball.y+=ball.vy;
  if(ball.x<6||ball.x>634)ball.vx*=-1;
  if(ball.y<6)ball.vy*=-1;
  if(ball.y>380&&ball.x>pad.x&&ball.x<pad.x+80){ball.vy=-Math.abs(ball.vy);ball.vx+=(ball.x-pad.x-40)/20}
  if(ball.y>400){ball.x=320;ball.y=300;ball.vx=3;ball.vy=-3;score=Math.max(0,score-2);document.getElementById('s').textContent=score}
  bricks.forEach(b=>{if(b.alive&&ball.x>b.x&&ball.x<b.x+b.w&&ball.y>b.y&&ball.y<b.y+b.h){b.alive=false;ball.vy*=-1;score++;document.getElementById('s').textContent=score}});
  draw();requestAnimationFrame(step);
}
function draw(){
  x.fillStyle='#0c111c';x.fillRect(0,0,640,400);
  bricks.forEach(b=>{if(b.alive){x.fillStyle=b.col;x.fillRect(b.x,b.y,b.w,b.h)}});
  x.fillStyle='#9ef0a6';x.fillRect(pad.x,388,80,8);
  x.beginPath();x.arc(ball.x,ball.y,6,0,Math.PI*2);x.fill();
}
step();`,
  },

  tetris: {
    title: 'Tetris',
    instructions: 'Arrow keys. Up = rotate.',
    code: `
const c=document.getElementById('c'),x=c.getContext('2d'),G=20,W=12,H=20;
const SHAPES=[[[1,1,1,1]],[[1,1],[1,1]],[[0,1,0],[1,1,1]],[[1,1,0],[0,1,1]],[[0,1,1],[1,1,0]],[[1,0,0],[1,1,1]],[[0,0,1],[1,1,1]]];
const COL=['#9ef0a6','#ffd166','#c79bff','#ff6b81','#6ad7ff','#ff8fc8','#5ee0a0'];
let grid=Array(H).fill(0).map(()=>Array(W).fill(0)),piece=spawn(),score=0,t=0;
function spawn(){const i=Math.floor(Math.random()*7);return{s:SHAPES[i],c:i+1,x:4,y:0}}
function rot(s){return s[0].map((_,i)=>s.map(r=>r[i]).reverse())}
function fits(p,dx,dy,s){s=s||p.s;for(let y=0;y<s.length;y++)for(let xx=0;xx<s[y].length;xx++)if(s[y][xx]){const nx=p.x+xx+dx,ny=p.y+y+dy;if(nx<0||nx>=W||ny>=H)return false;if(ny>=0&&grid[ny][nx])return false}return true}
function lock(){piece.s.forEach((r,y)=>r.forEach((v,xx)=>{if(v&&piece.y+y>=0)grid[piece.y+y][piece.x+xx]=piece.c}));
  for(let y=H-1;y>=0;y--)if(grid[y].every(v=>v)){grid.splice(y,1);grid.unshift(Array(W).fill(0));score+=10;document.getElementById('s').textContent=score;y++}
  piece=spawn();if(!fits(piece,0,0)){grid=Array(H).fill(0).map(()=>Array(W).fill(0));score=0}}
addEventListener('keydown',e=>{const k=e.key;
  if(k==='ArrowLeft'&&fits(piece,-1,0))piece.x--;
  else if(k==='ArrowRight'&&fits(piece,1,0))piece.x++;
  else if(k==='ArrowDown'&&fits(piece,0,1))piece.y++;
  else if(k==='ArrowUp'){const r=rot(piece.s);if(fits(piece,0,0,r))piece.s=r}
});
function step(){
  if(++t%30===0){if(fits(piece,0,1))piece.y++;else lock()}
  x.fillStyle='#0c111c';x.fillRect(0,0,640,400);
  const ox=200;
  for(let y=0;y<H;y++)for(let xx=0;xx<W;xx++){if(grid[y][xx]){x.fillStyle=COL[grid[y][xx]-1];x.fillRect(ox+xx*G,y*G,G-1,G-1)}}
  piece.s.forEach((r,y)=>r.forEach((v,xx)=>{if(v){x.fillStyle=COL[piece.c-1];x.fillRect(ox+(piece.x+xx)*G,(piece.y+y)*G,G-1,G-1)}}));
  x.strokeStyle='#2a3550';x.strokeRect(ox,0,W*G,H*G);
  requestAnimationFrame(step);
}
step();`,
  },

  asteroids: {
    title: 'Asteroids',
    instructions: 'WASD or arrows. Space to shoot.',
    code: `
const c=document.getElementById('c'),x=c.getContext('2d');
let ship={x:320,y:200,a:0,vx:0,vy:0},rocks=[],bullets=[],score=0,keys={};
for(let i=0;i<6;i++)rocks.push(newRock());
function newRock(){return{x:Math.random()*640,y:Math.random()*400,vx:(Math.random()-.5)*2,vy:(Math.random()-.5)*2,r:20+Math.random()*16}}
addEventListener('keydown',e=>{keys[e.key]=1;if(e.key===' ')bullets.push({x:ship.x,y:ship.y,vx:Math.cos(ship.a)*8+ship.vx,vy:Math.sin(ship.a)*8+ship.vy,life:60})});
addEventListener('keyup',e=>{keys[e.key]=0});
function step(){
  if(keys['ArrowLeft']||keys['a'])ship.a-=0.08;
  if(keys['ArrowRight']||keys['d'])ship.a+=0.08;
  if(keys['ArrowUp']||keys['w']){ship.vx+=Math.cos(ship.a)*0.15;ship.vy+=Math.sin(ship.a)*0.15}
  ship.x+=ship.vx;ship.y+=ship.vy;ship.vx*=0.99;ship.vy*=0.99;
  ship.x=(ship.x+640)%640;ship.y=(ship.y+400)%400;
  rocks.forEach(r=>{r.x=(r.x+r.vx+640)%640;r.y=(r.y+r.vy+400)%400});
  bullets=bullets.filter(b=>{b.x+=b.vx;b.y+=b.vy;b.life--;return b.life>0});
  bullets.forEach(b=>rocks.forEach(r=>{if(r.r>0&&Math.hypot(b.x-r.x,b.y-r.y)<r.r){r.r=0;b.life=0;score++;document.getElementById('s').textContent=score;rocks.push(newRock())}}));
  rocks=rocks.filter(r=>r.r>0);
  x.fillStyle='#0c111c';x.fillRect(0,0,640,400);
  x.strokeStyle='#9ef0a6';x.lineWidth=2;
  rocks.forEach(r=>{x.beginPath();x.arc(r.x,r.y,r.r,0,Math.PI*2);x.stroke()});
  x.fillStyle='#ffd166';bullets.forEach(b=>x.fillRect(b.x-1,b.y-1,3,3));
  x.save();x.translate(ship.x,ship.y);x.rotate(ship.a);
  x.beginPath();x.moveTo(12,0);x.lineTo(-8,-6);x.lineTo(-8,6);x.closePath();x.stroke();x.restore();
  requestAnimationFrame(step);
}
step();`,
  },

  flappy: {
    title: 'Flappy',
    instructions: 'Click or space to flap. Avoid pipes.',
    code: `
const c=document.getElementById('c'),x=c.getContext('2d');
let bird={y:200,v:0},pipes=[{x:640,gap:160}],score=0,alive=true;
function flap(){if(!alive){bird={y:200,v:0};pipes=[{x:640,gap:160}];score=0;alive=true;document.getElementById('s').textContent=0}else bird.v=-7}
addEventListener('keydown',e=>{if(e.key===' ')flap()});
c.addEventListener('click',flap);
function step(){
  if(alive){bird.v+=0.4;bird.y+=bird.v;
    pipes.forEach(p=>p.x-=3);
    if(pipes[pipes.length-1].x<400)pipes.push({x:640,gap:80+Math.random()*220});
    pipes=pipes.filter(p=>p.x>-60);
    if(bird.y<0||bird.y>400)alive=false;
    pipes.forEach(p=>{if(p.x<340&&p.x>260&&(bird.y<p.gap||bird.y>p.gap+120))alive=false;
      if(p.x===299){score++;document.getElementById('s').textContent=score}});
  }
  x.fillStyle='#0c111c';x.fillRect(0,0,640,400);
  x.fillStyle='#5ee0a0';pipes.forEach(p=>{x.fillRect(p.x,0,60,p.gap);x.fillRect(p.x,p.gap+120,60,400)});
  x.fillStyle='#ffd166';x.beginPath();x.arc(300,bird.y,12,0,Math.PI*2);x.fill();
  if(!alive){x.fillStyle='#fff';x.font='22px monospace';x.fillText('Click to retry',230,200)}
  requestAnimationFrame(step);
}
step();`,
  },

  runner: {
    title: 'Runner',
    instructions: 'Space or click to jump.',
    code: `
const c=document.getElementById('c'),x=c.getContext('2d');
let p={y:340,vy:0,grounded:true},obs=[{x:640,w:20,h:30}],score=0,alive=true,t=0;
function jump(){if(!alive){p={y:340,vy:0,grounded:true};obs=[{x:640,w:20,h:30}];score=0;alive=true;document.getElementById('s').textContent=0}else if(p.grounded){p.vy=-10;p.grounded=false}}
addEventListener('keydown',e=>{if(e.key===' ')jump()});c.addEventListener('click',jump);
function step(){
  if(alive){p.vy+=0.5;p.y+=p.vy;if(p.y>340){p.y=340;p.vy=0;p.grounded=true}
    obs.forEach(o=>o.x-=4+score*0.05);
    if(obs[obs.length-1].x<400+Math.random()*200)obs.push({x:640,w:20+Math.random()*20,h:20+Math.random()*40});
    obs=obs.filter(o=>o.x>-30);
    obs.forEach(o=>{if(o.x<120&&o.x>60&&p.y>340-o.h)alive=false;if(o.x===60){score++;document.getElementById('s').textContent=score}});
    t++;
  }
  x.fillStyle='#0c111c';x.fillRect(0,0,640,400);
  x.strokeStyle='#2a3550';for(let i=0;i<10;i++){x.beginPath();x.moveTo((i*80-t*2)%640,370);x.lineTo((i*80-t*2)%640+40,370);x.stroke()}
  x.fillStyle='#9ef0a6';x.fillRect(80,p.y,30,30);
  x.fillStyle='#ff6b81';obs.forEach(o=>x.fillRect(o.x,370-o.h,o.w,o.h));
  if(!alive){x.fillStyle='#fff';x.font='22px monospace';x.fillText('Click to retry',230,200)}
  requestAnimationFrame(step);
}
step();`,
  },

  match3: {
    title: 'Match 3',
    instructions: 'Click two adjacent gems to swap.',
    code: `
const c=document.getElementById('c'),x=c.getContext('2d'),N=8,G=44,OX=144,OY=24;
const COL=['#ff6b81','#ffd166','#9ef0a6','#6ad7ff','#c79bff'];
let g=[],sel=null,score=0;
function init(){g=[];for(let y=0;y<N;y++){g[y]=[];for(let xx=0;xx<N;xx++)g[y][xx]=Math.floor(Math.random()*5)}}
init();
c.addEventListener('click',e=>{const r=c.getBoundingClientRect();const xx=Math.floor((e.clientX-r.left-OX)/G),y=Math.floor((e.clientY-r.top-OY)/G);if(xx<0||xx>=N||y<0||y>=N)return;
  if(!sel){sel={xx,y}}else{if(Math.abs(sel.xx-xx)+Math.abs(sel.y-y)===1){[g[sel.y][sel.xx],g[y][xx]]=[g[y][xx],g[sel.y][sel.xx]];if(!resolve()){[g[sel.y][sel.xx],g[y][xx]]=[g[y][xx],g[sel.y][sel.xx]]}}sel=null}});
function resolve(){let any=false,marked=Array(N).fill(0).map(()=>Array(N).fill(false));
  for(let y=0;y<N;y++)for(let xx=0;xx<N-2;xx++)if(g[y][xx]===g[y][xx+1]&&g[y][xx]===g[y][xx+2]){marked[y][xx]=marked[y][xx+1]=marked[y][xx+2]=true;any=true}
  for(let y=0;y<N-2;y++)for(let xx=0;xx<N;xx++)if(g[y][xx]===g[y+1][xx]&&g[y][xx]===g[y+2][xx]){marked[y][xx]=marked[y+1][xx]=marked[y+2][xx]=true;any=true}
  if(any){for(let xx=0;xx<N;xx++){let col=[];for(let y=0;y<N;y++)if(!marked[y][xx])col.push(g[y][xx]);else score++;while(col.length<N)col.unshift(Math.floor(Math.random()*5));for(let y=0;y<N;y++)g[y][xx]=col[y]}document.getElementById('s').textContent=score;setTimeout(resolve,80)}
  return any}
function step(){
  x.fillStyle='#0c111c';x.fillRect(0,0,640,400);
  for(let y=0;y<N;y++)for(let xx=0;xx<N;xx++){x.fillStyle=COL[g[y][xx]];x.fillRect(OX+xx*G+2,OY+y*G+2,G-4,G-4)}
  if(sel){x.strokeStyle='#fff';x.lineWidth=2;x.strokeRect(OX+sel.xx*G,OY+sel.y*G,G,G)}
  requestAnimationFrame(step);
}
step();`,
  },

  shooter: {
    title: 'Space Shooter',
    instructions: 'Arrow keys. Space to shoot.',
    code: `
const c=document.getElementById('c'),x=c.getContext('2d');
let ship={x:320,y:340},bullets=[],enemies=[],score=0,keys={},t=0;
addEventListener('keydown',e=>{keys[e.key]=1;if(e.key===' ')bullets.push({x:ship.x,y:ship.y-10})});
addEventListener('keyup',e=>{keys[e.key]=0});
function step(){
  if(keys['ArrowLeft'])ship.x-=4;if(keys['ArrowRight'])ship.x+=4;
  ship.x=Math.max(20,Math.min(620,ship.x));
  bullets=bullets.filter(b=>{b.y-=8;return b.y>0});
  if(++t%40===0)enemies.push({x:Math.random()*600+20,y:0,vx:(Math.random()-.5)*2});
  enemies.forEach(e=>{e.y+=2;e.x+=e.vx;if(e.x<20||e.x>620)e.vx*=-1});
  enemies=enemies.filter(e=>{const hit=bullets.find(b=>Math.hypot(b.x-e.x,b.y-e.y)<14);if(hit){hit.y=-99;score++;document.getElementById('s').textContent=score;return false}return e.y<400});
  x.fillStyle='#0c111c';x.fillRect(0,0,640,400);
  for(let i=0;i<30;i++){x.fillStyle='#fff';x.fillRect((i*73+t)%640,(i*97)%400,1,1)}
  x.fillStyle='#9ef0a6';x.beginPath();x.moveTo(ship.x,ship.y-10);x.lineTo(ship.x-12,ship.y+10);x.lineTo(ship.x+12,ship.y+10);x.fill();
  x.fillStyle='#ffd166';bullets.forEach(b=>x.fillRect(b.x-1,b.y-6,3,8));
  x.fillStyle='#ff6b81';enemies.forEach(e=>{x.fillRect(e.x-12,e.y-8,24,16)});
  requestAnimationFrame(step);
}
step();`,
  },
};

// Match the user prompt to a template (very loose).
export function pickTemplate(prompt) {
  const p = prompt.toLowerCase();
  const matches = [
    [['pong', 'paddle', 'tennis'], 'pong'],
    [['snake'], 'snake'],
    [['breakout', 'brick'], 'breakout'],
    [['tetris', 'block', 'puzzle drop'], 'tetris'],
    [['asteroid', 'space rock'], 'asteroids'],
    [['flappy', 'bird', 'flap'], 'flappy'],
    [['runner', 'jump', 'platformer', 'dino'], 'runner'],
    [['match', 'gem', 'candy', 'bejew'], 'match3'],
    [['shoot', 'shooter', 'invader', 'space'], 'shooter'],
  ];
  for (const [keys, key] of matches) {
    if (keys.some(k => p.includes(k))) return key;
  }
  // default: shooter (energetic)
  return 'shooter';
}

export function buildTemplate(key, customizations = {}) {
  const t = templates[key];
  if (!t) return null;
  let code = t.code;
  // simple customizations: title/colors via search-replace
  let title = customizations.title || t.title;
  return shell(title, code, t.instructions);
}

export const TEMPLATE_KEYS = Object.keys(templates);

export function describeTemplate(key) {
  const t = templates[key];
  return t ? { title: t.title, instructions: t.instructions } : null;
}

// Also produce a README for any generated game.
export function buildReadme(name, prompt, key, agentNotes) {
  const tpl = templates[key];
  return `# ${name}

> Generated by Simians Inc.'s AI engineering team.

## The Brief

> ${prompt}

## What was built

A complete, self-contained ${tpl ? tpl.title : 'mini-game'} in a single HTML file.
Open \`index.html\` in any modern browser. No build step. No dependencies.

**Controls:** ${tpl ? tpl.instructions : 'see in-game help'}

## Engineering notes (from the team)

${agentNotes.map(n => `- **${n.who}** (${n.role}): ${n.text}`).join('\n')}

## Tech

- Pure HTML5 Canvas + vanilla JS
- One file, zero dependencies
- ~${tpl ? tpl.code.split('\n').length : 50} lines of game logic

## License
MIT
`;
}
