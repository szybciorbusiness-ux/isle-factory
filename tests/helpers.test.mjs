// Shared helpers for the sim tests (no tests of its own). Run everything with: node --test tests/*.test.mjs
import assert from 'node:assert/strict';
import { createSim, beltPath } from '../src/sim/sim.js';
import { BELT, RECIPES, BUILDINGS, DIRS } from '../src/config.js';

export const E = 0, S = 1, W = 2, N = 3;
export const SP = BELT.spacing;
export const DT = 1 / 60;
export const STEP = BELT.speed * DT; // world distance an item moves per 1/60 s tick

// All-land map, no props unless given. deposits: [[x, z, code]] (1 copper, 2 stone), water: [[x, z]],
// bridges: [[x, z, o]], props: [[kind, x, z]] ('tree' | 'rock' | 'stump').
export function flatMap(w = 40, h = 40, { deposits = [], water = [], bridges = [], props = [], start = { x: w - 1, z: h - 1 } } = {}) {
  const n = w * h;
  const land = new Uint8Array(n).fill(1), bridge = new Uint8Array(n), deposit = new Uint8Array(n);
  const idx = (x, z) => z * w + x;
  const inBounds = (x, z) => x >= 0 && z >= 0 && x < w && z < h;
  for (const [x, z, c] of deposits) deposit[idx(x, z)] = c;
  for (const [x, z] of water) land[idx(x, z)] = 0;
  for (const [x, z, o] of bridges) { land[idx(x, z)] = 0; bridge[idx(x, z)] = o; }
  const isLand = (x, z) => inBounds(x, z) && land[idx(x, z)] === 1;
  const isBridge = (x, z) => inBounds(x, z) && bridge[idx(x, z)] > 0;
  return {
    w, h, land, bridge, deposit, start: { ...start }, seed: 0, idx, inBounds, isLand, isBridge,
    props: props.map(([kind, x, z]) => ({ kind, x, z, variant: 0, rot: 0, scale: 1 })),
    depositAt: (x, z) => (isLand(x, z) ? deposit[idx(x, z)] : 0),
    isGround: (x, z) => isLand(x, z) || isBridge(x, z),
  };
}

export function makeSim(opts = {}) {
  const map = flatMap(opts.w, opts.h, opts);
  return createSim(map, { inventory: { belt: 5000, drill: 200, chest: 200, workshop: 50, ...(opts.inventory || {}) } });
}

export function run(sim, seconds, dt = DT, each) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) { sim.update(dt); if (each) each(i); }
}

export function place(sim, kind, x, z, dir = 0) {
  const r = sim.place(kind, x, z, dir);
  assert.ok(r.ok, `place ${kind} at ${x},${z}: ${r.reason}`);
  return r.entity;
}
export const belt = (sim, x, z, dir) => place(sim, 'belt', x, z, dir);
export function line(sim, x, z, dir, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(belt(sim, x + DIRS[dir][0] * i, z + DIRS[dir][1] * i, dir));
  return out;
}
export const dirTo = (x, z, nx, nz) => DIRS.findIndex(([dx, dz]) => dx === nx - x && dz === nz - z);
// Lay belts along a path of [x, z] points; each belt points at the next point (the last one gets `lastDir`).
export function pathBelts(sim, pts, lastDir) {
  return pts.map(([x, z], i) => {
    const nx = pts[i + 1];
    return belt(sim, x, z, nx ? dirTo(x, z, nx[0], nx[1]) : lastDir);
  });
}
// Closed loop through the points (the last belt points back at the first).
export function loopBelts(sim, pts) {
  return pts.map(([x, z], i) => { const [nx, nz] = pts[(i + 1) % pts.length]; return belt(sim, x, z, dirTo(x, z, nx, nz)); });
}
// Rectangular ring of belts (clockwise on screen), w x h tiles with top-left (x0, z0).
export function ringPoints(x0, z0, w, h) {
  const pts = [];
  for (let x = x0; x < x0 + w - 1; x++) pts.push([x, z0]);
  for (let z = z0; z < z0 + h - 1; z++) pts.push([x0 + w - 1, z]);
  for (let x = x0 + w - 1; x > x0; x--) pts.push([x, z0 + h - 1]);
  for (let z = z0 + h - 1; z > z0; z--) pts.push([x0, z]);
  return pts;
}
export const ring = (sim, x0, z0, w, h) => loopBelts(sim, ringPoints(x0, z0, w, h));
// Spread n items evenly along a closed loop of belts (lane order). Returns the spawned items.
export function fillLoop(sim, loop, n, types = ['stone', 'wood', 'copperOre']) {
  const lens = loop.map(b => sim.beltLength(b)), total = lens.reduce((a, b) => a + b, 0);
  const out = [];
  for (let k = 0; k < n; k++) {
    let s = (k * total) / n, i = 0;
    while (s >= lens[i] - 1e-9 && i < loop.length - 1) { s -= lens[i]; i++; }
    const it = sim.spawnBeltItem(loop[i].id, types[k % types.length], Math.max(0, s) / lens[i]);
    if (it) out.push(it);
  }
  return out;
}

// Lane-ordered list of belts for a closed loop (following each belt's exit).
export function loopOrder(sim, start) {
  const out = [start];
  let b = start;
  for (;;) {
    const n = sim.at(b.x + DIRS[b.dir][0], b.z + DIRS[b.dir][1]);
    if (!n || n === start || n.kind !== 'belt') break;
    out.push(n); b = n;
  }
  return out;
}

// ---------- observation ----------
export function beltItems(sim) {
  const out = [];
  for (const b of sim.belts) for (const it of b.items) out.push({ b, it, pos: beltPath(b, it.p) });
  return out;
}
export function snapshot(sim) {
  const m = new Map();
  for (const b of sim.belts) for (const it of b.items) m.set(it.uid, beltPath(b, it.p));
  return m;
}
// largest per-item displacement between two snapshots (items present in both)
export function maxMove(prev, cur) {
  let mx = 0;
  for (const [uid, p] of cur) { const q = prev.get(uid); if (q) mx = Math.max(mx, Math.hypot(p.x - q.x, p.z - q.z)); }
  return mx;
}
export function minDistance(sim) {
  const all = beltItems(sim);
  let mn = Infinity, pair = null;
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i].pos, c = all[j].pos;
      if (Math.abs(a.x - c.x) > 1 || Math.abs(a.z - c.z) > 1) continue;
      const d = Math.hypot(a.x - c.x, a.z - c.z);
      if (d < mn) { mn = d; pair = [all[i], all[j]]; }
    }
  }
  return { d: mn, pair };
}
const describe = e => e && `${e.it.type}#${e.it.uid} on belt(${e.b.x},${e.b.z} dir ${e.b.dir} from ${e.b.from}) p=${e.it.p.toFixed(4)}`;
// Items never closer than the spacing (0.98: chords on curves are a hair shorter than the lane distance).
export function assertNoOverlap(sim, label = '') {
  const { d, pair } = minDistance(sim);
  assert.ok(d >= SP * 0.98, `${label} items overlap: ${d.toFixed(4)} < ${SP} between ${describe(pair?.[0])} and ${describe(pair?.[1])}`);
}
// Structural invariants of every belt: items sorted front-first, on the lane, unique uids.
export function assertBeltsValid(sim, label = '') {
  const seen = new Set();
  for (const b of sim.belts) {
    for (let i = 0; i < b.items.length; i++) {
      const it = b.items[i];
      assert.ok(Number.isFinite(it.p) && it.p >= 0 && it.p <= 1.5 + 1e-9, `${label} p out of range: ${it.p} on ${b.x},${b.z}`);
      if (it.p > 1) assert.ok(i === 0 || b.items[i - 1].p > 1, `${label} only leading items may be past the exit edge`);
      if (i > 0) assert.ok(b.items[i - 1].p >= it.p, `${label} items not sorted on ${b.x},${b.z}`);
      assert.ok(!seen.has(it.uid), `${label} duplicate uid ${it.uid}`);
      seen.add(it.uid);
    }
  }
}

// ---------- item accounting ----------
// Every item in the game: inventory + placed buildings + belt items + chests + workshops + drills + craft queue.
export function census(sim) {
  const c = {};
  const add = (k, n = 1) => { if (n) c[k] = (c[k] || 0) + n; };
  for (const [k, n] of Object.entries(sim.inventory.counts)) add(k, n);
  for (const e of sim.entities.values()) {
    if (e.resource) continue;
    add(BUILDINGS[e.kind].item);
    if (e.kind === 'belt') for (const it of e.items) add(it.type);
    if (e.kind === 'chest') for (const [k, n] of Object.entries(e.items)) add(k, n);
    if (e.kind === 'workshop') {
      for (const [k, n] of Object.entries(e.input)) add(k, n);
      for (const [k, n] of Object.entries(e.output)) add(k, n);
      if (e.crafting) for (const [k, n] of Object.entries(RECIPES[e.recipe].inputs)) add(k, n);
    }
    if (e.kind === 'drill' && e.held) add(e.held);
  }
  for (const job of sim.craftQueue) for (const [k, n] of Object.entries(RECIPES[job.recipe].inputs)) add(k, n);
  return c;
}
// Items legitimately created / converted, tracked from events, so census(now) = census(start) + ledger.
export function ledger(sim) {
  const d = {};
  const add = (k, n) => { d[k] = (d[k] || 0) + n; };
  sim.events.on('drill:mined', ({ item }) => add(item, 1));
  sim.events.on('workshop:crafted', ({ entity, outputs }) => {
    for (const [k, n] of Object.entries(outputs)) add(k, n);
    for (const [k, n] of Object.entries(RECIPES[entity.recipe].inputs)) add(k, -n);
  });
  sim.events.on('craft:done', ({ recipe, outputs }) => {
    for (const [k, n] of Object.entries(outputs)) add(k, n);
    for (const [k, n] of Object.entries(RECIPES[recipe].inputs)) add(k, -n);
  });
  sim.events.on('resource:depleted', ({ drops }) => { for (const [k, n] of Object.entries(drops)) add(k, n); });
  sim.events.on('deposit:mined', ({ item }) => add(item, 1));
  return d;
}
export function assertConserved(sim, start, d, label = '') {
  const now = census(sim);
  const keys = new Set([...Object.keys(now), ...Object.keys(start), ...Object.keys(d)]);
  for (const k of keys) {
    const want = (start[k] || 0) + (d[k] || 0);
    assert.equal(now[k] || 0, want, `${label} ${k}: have ${now[k] || 0}, expected ${want}`);
  }
}
