// Bootstrap + main loop. Loads every view module in order with an isolated fallback, so one broken
// module never takes the whole game down. See DESIGN.md for the module contract.
import * as THREE from 'three';
import * as config from './config.js';
import * as anim from './util/anim.js';
import * as noise from './util/noise.js';
import { createMap } from './world/map.js';
import { createMap as createCampMap } from './world/map-camp.js';
import { createCamp } from './sim/camp.js';
import { createSim, beltPath } from './sim/sim.js';
import { runScenario } from './debug/scenarios.js';

const MODULES = [
  ['lighting', './view/lighting.js'],
  ['sky', './view/sky.js'],
  ['terrain', './view/terrain.js'],
  ['water', './view/water.js'],
  ['items', './view/items.js'],
  ['fx', './view/fx.js'],
  ['props', './view/props.js'],
  ['buildings', './view/buildings.js'],
  ['campview', './view/camp.js'],
  ['pads', './view/pads.js'],
  ['creatures', './view/creatures.js'],
  ['player', './view/player.js'],
  ['camera', './view/camera.js'],
  ['interact', './view/interact.js'],
  ['ui', './ui/hud.js'],
  ['touch', './view/touch.js'],
  ['guide', './view/guide.js'],
  ['post', './view/post.js'],
];

const params = new URLSearchParams(location.search);

// ---------- mobile ----------
// ?mobile=1 (the /phone simulator) or a touch-first device turns on the portrait HUD + touch controls.
// ?safeTop / ?safeBottom (CSS px) fake the notch / home-indicator insets inside the simulator; on a real
// phone the env(safe-area-inset-*) defaults in index.html apply.
const mobile = params.has('mobile') || matchMedia('(pointer: coarse)').matches;
if (mobile) document.body.classList.add('mobile');
for (const [param, cssVar] of [['safeTop', '--safe-top'], ['safeBottom', '--safe-bottom']]) {
  if (params.has(param)) document.documentElement.style.setProperty(cssVar, `${Number(params.get(param)) || 0}px`);
}
const errors = [];
const errorBox = document.getElementById('errors');
function reportError(msg) {
  errors.push(msg);
  console.error(msg);
  errorBox.style.display = 'block';
  errorBox.textContent = errors.slice(-6).join('\n\n');
}
window.addEventListener('error', e => reportError(`window: ${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', e => reportError(`promise: ${e.reason?.stack || e.reason}`));

// ---------- renderer / scene / camera ----------
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: params.has('shot') });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
app.appendChild(renderer.domElement);
renderer.domElement.tabIndex = 0;

const scene = new THREE.Scene();
scene.background = new THREE.Color(config.PALETTE.sky);
const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.1, 250);

// ---------- game state ----------
const seed = Number(params.get('seed')) || 7;
// Camp mode (arcade-idle survival, GAMEPLAY.md) is the default; the old factory sandbox is ?factory.
const campMode = !params.has('factory'); // the camp is the game; ?factory opens the old sandbox
const map = campMode ? createCampMap(seed) : createMap(seed);
const sim = createSim(map, campMode ? { inventory: {} } : undefined);

// Shared UI state. interact.js and hud.js both read/write it; changes are announced on the bus.
const ui = {
  selected: null,   // building item id in hand ('belt' | 'drill' | 'chest' | 'workshop') or null
  buildDir: 0,      // direction for the next placed building (0 east, 1 south, 2 west, 3 north)
  panel: null,      // null | { type: 'craft' } | { type: 'chest' | 'workshop', id }
  hover: null,      // null | { x, z, entityId, deposit, inReach }
  pointerOverUi: false,
};

const debug = {
  paused: params.has('paused'),
  cam: params.get('cam') ? params.get('cam').split(',').map(Number) : null, // x,z[,distance]
  scenario: params.get('scenario'),
};

// ---------- quality: a PIXEL BUDGET, not a fixed resolution ----------
// The GPU cost is almost all per-pixel (post, water, clouds), so the 3D canvas renders at whatever pixel ratio
// fits `budget` pixels, capped at the screen's own pixels. A governor (below) measures real frame times and
// shrinks the budget when frames run long, grows it back when there's headroom. The HUD is DOM, always sharp.
// Modules may read ctx.quality (shadowMapSize, grassDensity, postScale, tier) to scale their own cost.
const qParam = params.get('quality'); // low | med | high (forces a starting budget)
const quality = {
  tier: mobile ? 'mobile' : 'high',
  shadowMapSize: mobile ? 1024 : 2048,
  grassDensity: mobile ? 0.5 : 1,   // 0..1 multiplier for instanced blades / tufts / flowers
  postScale: mobile ? 0.5 : 1,      // resolution multiplier for blur / extra post passes
  // render pixels: phones ~0.9 MP (402x874 at ~1.6x), desktop ~2.1 MP (1080p at 1x)
  budget: qParam === 'low' ? 0.45e6 : qParam === 'high' ? 4.5e6 : mobile ? 0.9e6 : 2.1e6,
  budgetMin: 0.3e6,
  budgetMax: mobile ? 1.6e6 : 4.5e6,
  dprMin: 0.5,
  dpr: 1,
  // The /phone simulator scales the whole phone with a CSS transform; it posts that factor here so the canvas
  // can render at the pixels actually on screen (still within the budget).
  frameScale: 1,
  fps: 0, frameMs: 0, gpuBound: false,
};
const nativeDpr = () => Math.min(3, (devicePixelRatio || 1) * quality.frameScale);
function pickDpr() {
  const px = Math.max(1, innerWidth * innerHeight);
  const fit = Math.sqrt(quality.budget / px);
  return +Math.max(quality.dprMin, Math.min(nativeDpr(), fit)).toFixed(3);
}
quality.dpr = pickDpr();
renderer.setPixelRatio(quality.dpr);
function applyDpr() {
  const next = pickDpr();
  if (Math.abs(next - quality.dpr) < 0.02) return;
  quality.dpr = next;
  renderer.setPixelRatio(next);
  resize();
}
addEventListener('message', e => {
  if (e.data?.type !== 'isle:frameScale') return;
  quality.frameScale = Math.max(0.5, Math.min(3, Number(e.data.value) || 1));
  applyDpr();
});

// Analog movement from on-screen controls (touch.js writes, player.js reads alongside the keyboard).
// move = desired direction in world xz, magnitude 0..1 (already dead-zoned); active = a thumb is on the stick.
const input = { move: { x: 0, z: 0 }, active: false };

const views = {};
// The camp reads the player's smoothed float position (falls back to the sim tile before the view exists).
const camp = campMode ? createCamp(sim, { playerPos: () => views.player?.getPosition?.() }) : null;
const ctx = {
  camp,
  THREE, renderer, scene, camera, canvas: renderer.domElement, uiRoot: document.getElementById('ui'),
  config, anim, noise, map, sim, events: sim.events, ui, views, params, debug, beltPath, input, mobile, quality,
  time: 0,
};

// ---------- modules ----------
const disabled = new Set();
const errorCounts = {};
for (const [name, path] of MODULES) {
  try {
    const mod = await import(path);
    views[name] = (await mod.create(ctx)) || {};
  } catch (e) {
    reportError(`[${name}] failed to load: ${e?.stack || e}`);
    views[name] = {};
  }
}
if (!views.camera?.update) { // fallback framing
  camera.position.set(map.start.x, 17, map.start.z + 11);
  camera.lookAt(map.start.x, 0, map.start.z);
}

if (debug.scenario) {
  try { runScenario(debug.scenario, ctx); } catch (e) { reportError(`[scenario] ${e?.stack || e}`); }
  const warm = Number(params.get('warm')) || 0;
  for (let t = 0; t < warm; t += 1 / 30) sim.update(1 / 30);
}

function tick(dt) {
  ctx.time += dt;
  sim.update(dt);
  camp?.update(dt);
  anim.update(dt);
  for (const [name] of MODULES) {
    const v = views[name];
    if (!v.update || disabled.has(name)) continue;
    try { v.update(dt, ctx.time); }
    catch (e) {
      errorCounts[name] = (errorCounts[name] || 0) + 1;
      if (errorCounts[name] === 1) reportError(`[${name}] update threw: ${e?.stack || e}`);
      if (errorCounts[name] >= 3) { disabled.add(name); reportError(`[${name}] disabled after repeated errors`); }
    }
  }
}
function render(dt = 0) {
  try {
    if (views.post?.render && !disabled.has('post')) views.post.render(dt);
    else renderer.render(scene, camera);
  } catch (e) {
    if (!disabled.has('post')) { disabled.add('post'); reportError(`[post] render threw, falling back: ${e?.stack || e}`); }
    renderer.render(scene, camera);
  }
}

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  for (const v of Object.values(views)) try { v.resize?.(w, h); } catch (e) { reportError(`resize: ${e}`); }
}
addEventListener('resize', resize);
resize();

// Frame-time governor (real timing, not animation). Every ~1 s: if the median frame is slower than ~55 fps,
// shrink the pixel budget (fast, ×0.72); if it's comfortably fast for 3 windows in a row, grow it (×1.15).
// Median, not mean, so one hitch (GC, tab switch) doesn't drop the resolution.
const perf = { samples: [], windowMs: 0, fastWindows: 0, enabled: !params.has('fixeddpr'), meter: null };
function governor(frameMs) {
  perf.samples.push(frameMs); perf.windowMs += frameMs;
  if (perf.windowMs < 1000) return;
  const s = perf.samples.sort((a, b) => a - b);
  const med = s[s.length >> 1];
  perf.samples = []; perf.windowMs = 0;
  quality.frameMs = med; quality.fps = Math.round(1000 / med);
  if (perf.meter) perf.meter.textContent = `${quality.fps} fps · ${med.toFixed(1)} ms · ${(innerWidth * innerHeight * quality.dpr * quality.dpr / 1e6).toFixed(2)} MP @${quality.dpr.toFixed(2)}x`;
  if (!perf.enabled || document.hidden) return;
  if (med > 18.5) { quality.budget = Math.max(quality.budgetMin, quality.budget * 0.72); perf.fastWindows = 0; applyDpr(); }
  else if (med < 13.5) { if (++perf.fastWindows >= 3) { perf.fastWindows = 0; quality.budget = Math.min(quality.budgetMax, quality.budget * 1.25); applyDpr(); } }
  else perf.fastWindows = 0;
}
// ?fps shows a small meter (top-right): fps, median frame ms, rendered megapixels and pixel ratio.
if (params.has('fps')) {
  perf.meter = Object.assign(document.createElement('div'), { textContent: '…' });
  Object.assign(perf.meter.style, { position: 'fixed', right: '8px', top: 'calc(var(--safe-top, 0px) + 8px)', zIndex: 98, padding: '3px 8px',
    font: '600 11px/1.4 ui-monospace, monospace', color: '#fff', background: 'rgba(40, 30, 20, 0.7)', borderRadius: '6px', pointerEvents: 'none' });
  document.body.append(perf.meter);
}

let last = performance.now();
function frame(now) {
  const raw = Math.max(0, now - last);
  const dt = Math.min(0.05, raw / 1000);
  last = now;
  if (!debug.paused) { tick(dt); render(dt); if (raw < 250) governor(raw); }
  requestAnimationFrame(frame);
}
// Warm-up one frame so the first paint is correct even when paused.
tick(1 / 60); render(1 / 60);
requestAnimationFrame(frame);

// ---------- test hooks ----------
window.__game = {
  THREE, ctx, sim, map, views, ui, errors, config, anim, camp,
  // Advance n fixed steps (default 1/60 s) and render once. Works while paused.
  step(n = 1, dt = 1 / 60) { for (let i = 0; i < n; i++) tick(dt); render(dt); return ctx.time; },
  // Advance without rendering (fast playtests); call render() when you want a frame.
  tick(n = 1, dt = 1 / 60) { for (let i = 0; i < n; i++) tick(dt); return ctx.time; },
  render() { render(0); },
  pause(on = true) { debug.paused = on; last = performance.now(); },
  // Screen position (CSS px) of a world point, for synthetic mouse clicks in tests.
  toScreen(x, y, z) {
    const v = new THREE.Vector3(x, y, z).project(camera);
    return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight };
  },
  ready: true,
};
document.body.dataset.ready = '1';
