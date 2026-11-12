// Belt transport: geometry, speed, curves, side-loading, compression, loops, rotation, determinism.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beltPath, beltShape, beltLength, BELT_CURVE_LENGTH } from '../src/sim/sim.js';
import {
  E, S, W, N, SP, DT, STEP, makeSim, run, place, belt, line, pathBelts, loopBelts, ring, fillLoop, loopOrder,
  snapshot, maxMove, assertNoOverlap, minDistance, assertBeltsValid, census, ledger, assertConserved, beltItems,
} from './helpers.test.mjs';

const findItem = (sim, uid) => { for (const b of sim.belts) for (const it of b.items) if (it.uid === uid) return { b, it }; return null; };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
// Run while checking, every tick: no overlap, valid belts, and no item moving faster than the belt speed.
function runChecked(sim, seconds, label, { dt = DT, minGap } = {}) {
  let prev = snapshot(sim);
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    sim.update(dt);
    const cur = snapshot(sim);
    const mv = maxMove(prev, cur);
    assert.ok(mv <= 1.5 * dt * (1 + 1e-6) + 1e-9, `${label} tick ${i}: an item jumped ${mv.toFixed(4)}`);
    if (!minGap) assertNoOverlap(sim, `${label} tick ${i}:`);
    else assert.ok(minDistance(sim).d >= minGap, `${label} tick ${i}: squeezed to ${minDistance(sim).d}`);
    if (i % 10 === 0) assertBeltsValid(sim, `${label} tick ${i}:`);
    prev = cur;
  }
}

// ---------- geometry ----------
test('beltPath: straight and curved lanes are continuous, curves are quarter circles', () => {
  const b = { x: 5, z: 5, dir: W, from: N }; // enters from the north edge, exits west
  const a = beltPath(b, 0), c = beltPath(b, 1);
  assert.ok(near(a.x, 5) && near(a.z, 4.5), JSON.stringify(a));
  assert.ok(near(c.x, 4.5) && near(c.z, 5), JSON.stringify(c));
  // radius 0.5 around the corner (4.5, 4.5)
  for (let p = 0; p <= 1; p += 0.1) { const q = beltPath(b, p); assert.ok(near(Math.hypot(q.x - 4.5, q.z - 4.5), 0.5)); }
  // heading at the ends matches the entry / exit directions
  assert.ok(near(a.angle, Math.atan2(1, 0)), `entry heading south, got ${a.angle}`);
  assert.ok(near(Math.abs(c.angle), Math.PI), `exit heading west, got ${c.angle}`);
  // past the exit edge the path keeps going straight (side-loading)
  const st = { x: 2, z: 2, dir: E, from: W };
  assert.deepEqual([beltPath(st, 1.5).x, beltPath(st, 1.5).z], [3, 2]);
  const ext = beltPath(b, 1.25);
  assert.ok(near(ext.x, 4.25) && near(ext.z, 5));
  assert.equal(beltLength(st), 1);
  assert.equal(beltLength(b), BELT_CURVE_LENGTH);
});

test('beltShape names turns as seen travelling along the belt (screen space, +z down)', () => {
  assert.equal(beltShape({ dir: S, from: W }), 'right'); // east -> south: clockwise on screen
  assert.equal(beltShape({ dir: N, from: W }), 'left');  // east -> north
  assert.equal(beltShape({ dir: E, from: S }), 'right'); // north -> east
  assert.equal(beltShape({ dir: E, from: N }), 'left');  // south -> east
  assert.equal(beltShape({ dir: W, from: E }), 'straight');
  const sim = makeSim();
  line(sim, 2, 5, E, 2); const r = belt(sim, 4, 5, S);
  assert.equal(r.shape, 'right'); assert.equal(r.from, W);
  line(sim, 2, 9, E, 2); const l = belt(sim, 4, 9, N);
  assert.equal(l.shape, 'left'); assert.equal(l.from, W);
});

// ---------- straight runs ----------
test('items glide along a straight run at constant world speed and keep their uid', () => {
  const sim = makeSim();
  const bs = line(sim, 2, 5, E, 6);
  const it = sim.spawnBeltItem(bs[0].id, 'stone', 0);
  assert.ok(it);
  let prev = beltPath(bs[0], 0), moved = 0, stopped = false;
  for (let i = 0; i < 400; i++) {
    sim.update(DT);
    const f = findItem(sim, it.uid);
    assert.ok(f, 'item vanished');
    const p = beltPath(f.b, f.it.p), d = Math.hypot(p.x - prev.x, p.z - prev.z);
    if (!stopped && d < STEP - 1e-9) stopped = true; // reached the end
    else if (!stopped) assert.ok(near(d, STEP, 1e-9), `tick ${i}: moved ${d}`);
    else assert.ok(d < 1e-12, 'moves after stopping');
    moved += d; prev = p;
  }
  const f = findItem(sim, it.uid);
  assert.equal(f.b, bs[5]);
  assert.equal(f.it.p, 1);
  assert.ok(near(moved, 6, 1e-6), `travelled ${moved}`);
});

test('a long chain delivers in length / speed seconds', () => {
  const sim = makeSim({ w: 140, h: 10 });
  const bs = line(sim, 1, 5, E, 120);
  const chest = place(sim, 'chest', 121, 5);
  sim.spawnBeltItem(bs[0].id, 'wood', 0);
  let t = 0;
  while (!chest.total && t < 200) { sim.update(DT); t += DT; }
  assert.ok(Math.abs(t - 120 / 1.5) < 2 * DT, `took ${t}s`);
});

// ---------- curves ----------
test('curves: items keep constant world speed through left and right turns', () => {
  const sim = makeSim();
  // a snake: east, right turn south, left turn east, right turn south ...
  const pts = [[2, 2], [3, 2], [4, 2], [4, 3], [5, 3], [6, 3], [6, 4], [6, 5], [5, 5], [4, 5], [4, 6], [4, 7]];
  const bs = pathBelts(sim, pts, S);
  const shapes = bs.map(b => b.shape);
  assert.ok(shapes.includes('left') && shapes.includes('right'), shapes.join());
  const it = sim.spawnBeltItem(bs[0].id, 'stone', 0);
  let prev = beltPath(bs[0], 0), total = 0;
  for (let i = 0; i < 2000; i++) {
    sim.update(DT);
    const f = findItem(sim, it.uid);
    const p = beltPath(f.b, f.it.p), d = Math.hypot(p.x - prev.x, p.z - prev.z);
    prev = p; total += d;
    if (f.b === bs[bs.length - 1] && f.it.p === 1) break;
    // chord of an arc of length STEP with radius 0.5 is sin(STEP) ~ STEP (1e-4 relative)
    assert.ok(d <= STEP + 1e-9 && d >= Math.sin(STEP) * 0.999, `tick ${i}: step ${d} on ${f.b.shape}`);
  }
  const lane = bs.reduce((a, b) => a + beltLength(b), 0);
  assert.ok(Math.abs(total - lane) < 0.01, `travelled ${total}, lane ${lane}`);
});

// ---------- compression ----------
test('a blocked line compresses to exact spacing across belt boundaries, no overlap', () => {
  const sim = makeSim();
  const bs = line(sim, 2, 5, E, 5);
  for (const b of bs) for (const p of [0, 0.5]) sim.spawnBeltItem(b.id, 'copperOre', p);
  runChecked(sim, 6, 'compress');
  // lane coordinates measured from the start of the first belt
  const xs = beltItems(sim).map(({ b, it }) => (b.x - 2) + it.p).sort((a, b) => b - a);
  assert.equal(xs.length, 10);
  assert.ok(near(xs[0], 5, 1e-9), `front at ${xs[0]}`);
  for (let i = 1; i < xs.length; i++) assert.ok(near(xs[i - 1] - xs[i], SP, 1e-9), `gap ${i}: ${xs[i - 1] - xs[i]}`);
});

test('spacing holds while a line keeps flowing into a slow consumer', () => {
  const sim = makeSim({ deposits: [[1, 5, 2], [3, 4, 2], [5, 4, 2], [7, 4, 2]] });
  const bs = line(sim, 2, 5, E, 12);
  place(sim, 'drill', 1, 5, E);                       // feeds the entry edge
  for (const x of [3, 5, 7]) place(sim, 'drill', x, 4, S); // drop onto the middle from the side
  const chest = place(sim, 'chest', 14, 5);
  for (const b of bs) sim.spawnBeltItem(b.id, 'stone', 0.3);
  const start = census(sim), d = ledger(sim);
  runChecked(sim, 20, 'flow');
  assertConserved(sim, start, d, 'flow');
  assert.ok(chest.total > 20, `chest got ${chest.total}`);
});

test('head-on belts refuse each other and stop short without overlapping', () => {
  const sim = makeSim();
  const a = line(sim, 2, 5, E, 3), b = line(sim, 6, 5, W, 2); // (2..4) east, (6..5) west: (4,5) and (5,5) face each other
  for (const x of a) sim.spawnBeltItem(x.id, 'wood', 0.2);
  for (const x of b) sim.spawnBeltItem(x.id, 'stone', 0.2);
  runChecked(sim, 4, 'headon');
  assert.equal(a[2].items.length + a[1].items.length + a[0].items.length, 3);
  assert.equal(b[0].items.length + b[1].items.length, 2);
  assert.ok(a.every(x => x.items.every(it => it.type === 'wood')));
  const ha = beltPath(a[2], a[2].items[0].p), hb = beltPath(b[1], b[1].items[0].p);
  assert.ok(near(Math.hypot(ha.x - hb.x, ha.z - hb.z), SP, 1e-9));
});

// ---------- side-loading ----------
test('side-loading onto a straight belt: smooth merge, straight traffic first, nothing lost', () => {
  const sim = makeSim();
  const main = line(sim, 2, 5, E, 8);           // (2..9, 5)
  const side = line(sim, 5, 1, S, 4);           // (5, 1..4) -> into (5, 5) from the north
  const chest = place(sim, 'chest', 10, 5);
  assert.equal(sim.at(5, 5).shape, 'straight');
  for (const b of main.slice(0, 3)) for (const p of [0, 0.3, 0.6]) sim.spawnBeltItem(b.id, 'copperOre', p);
  for (const b of side) for (const p of [0, 0.3, 0.6]) sim.spawnBeltItem(b.id, 'stone', p);
  const n0 = beltItems(sim).length;
  assert.equal(n0, 21);
  let sawMerge = false;
  sim.events.on('*', () => {});
  let prev = snapshot(sim);
  for (let i = 0; i < 60 * 25; i++) {
    sim.update(DT);
    if (side[3].items[0]?.p > 1) sawMerge = true;
    const cur = snapshot(sim);
    assert.ok(maxMove(prev, cur) <= STEP + 1e-9, `jump at tick ${i}`);
    assertNoOverlap(sim, `merge tick ${i}`);
    prev = cur;
  }
  assert.ok(sawMerge, 'items should roll past the side belt edge while merging');
  assert.equal(chest.total, n0);
  assert.deepEqual(chest.items, { copperOre: 9, stone: 12 });
});

test('side-loading waits for a gap: a dense main line goes first', () => {
  const sim = makeSim();
  const main = line(sim, 2, 5, E, 10);
  const side = line(sim, 7, 3, S, 2); // into (7, 5) from the north
  place(sim, 'chest', 12, 5);
  // a fully compressed stream: one item every SP along the lane of the first 5 belts
  const fed = [];
  for (let k = 0; k < 18; k++) { const L = 4.9 - k * (SP + 1e-6), b = main[Math.floor(L)]; fed.push(sim.spawnBeltItem(b.id, 'wood', L - Math.floor(L))); }
  assert.ok(fed.every(Boolean), 'stream fits');
  sim.spawnBeltItem(side[1].id, 'stone', 0.9);
  // while the dense wood stream passes the junction the stone waits at the edge
  run(sim, 1.5);
  assert.equal(side[1].items.length, 1);
  assert.ok(side[1].items[0].p <= 1);
  run(sim, 6);
  assert.equal(side[1].items.length, 0, 'stone merges once the stream has passed');
});

test('two side-loaders into one belt take turns', () => {
  const sim = makeSim();
  const out = line(sim, 6, 5, E, 6);           // (6..11, 5); (6,5) is fed from both sides only
  const north = line(sim, 6, 1, S, 4);         // (6, 1..4) going south
  const south = line(sim, 6, 9, N, 4);         // (6, 9..6) going north
  place(sim, 'chest', 12, 5);
  assert.equal(sim.at(6, 5).shape, 'straight');
  for (const b of north) for (const p of [0, 0.3, 0.6]) sim.spawnBeltItem(b.id, 'wood', p);
  for (const b of south) for (const p of [0, 0.3, 0.6]) sim.spawnBeltItem(b.id, 'stone', p);
  const count = arr => arr.reduce((a, b) => a + b.items.length, 0);
  let maxDiff = 0;
  runChecked(sim, 2, 'zipper');
  for (let i = 0; i < 60 * 10; i++) { sim.update(DT); if (count(north) && count(south)) maxDiff = Math.max(maxDiff, Math.abs(count(north) - count(south))); }
  assert.ok(maxDiff <= 2, `feeders should drain evenly, diff ${maxDiff}`);
  assert.equal(count(north) + count(south) + count(out), 0);
});

test('drills drop onto curved belts and onto the last tile before a curve without crowding', () => {
  const sim = makeSim({ deposits: [[5, 6, 1], [6, 7, 1], [8, 6, 2], [9, 7, 2]] });
  // (3,7) E -> (4,7) E -> (5,7) S curve -> (5,8) S -> (5,9) S -> chest
  const bs = pathBelts(sim, [[3, 7], [4, 7], [5, 7], [5, 8], [5, 9]], S);
  assert.notEqual(bs[2].shape, 'straight');
  place(sim, 'chest', 5, 10);
  place(sim, 'drill', 5, 6, S);  // behind the curve: drops onto the middle of the arc
  place(sim, 'drill', 6, 7, W);  // the curve's open side
  for (const p of [0, 0.3, 0.6, 0.9]) { sim.spawnBeltItem(bs[0].id, 'wood', p); sim.spawnBeltItem(bs[1].id, 'wood', p); }
  const start = census(sim), d = ledger(sim);
  runChecked(sim, 15, 'curve-drop');
  assertConserved(sim, start, d, 'curve-drop');
  const chest = sim.at(5, 10);
  assert.ok((chest.items.copperOre || 0) >= 5, JSON.stringify(chest.items));
});

test('a curved belt side-loads into a straight belt (the extension leaves along the curve exit)', () => {
  const sim = makeSim();
  const main = line(sim, 2, 5, E, 7);                  // (2..8, 5)
  const feed = pathBelts(sim, [[3, 2], [4, 2], [4, 3], [4, 4]], S); // ... (4,2) is a curve E->S, (4,4) S into (4,5)
  place(sim, 'chest', 9, 5);
  assert.equal(sim.at(4, 5).shape, 'straight');
  for (const b of feed) for (const p of [0, 0.4]) sim.spawnBeltItem(b.id, 'stone', p);
  for (const b of main.slice(0, 2)) for (const p of [0, 0.5]) sim.spawnBeltItem(b.id, 'wood', p);
  const n = beltItems(sim).length;
  runChecked(sim, 12, 'curve-side');
  assert.equal(sim.at(9, 5).total, n);
});

test('items merging when the target belt is removed or rotated are pulled back, nothing lost', () => {
  for (const action of ['remove', 'rotate', 'rotate2', 'removeFeeder']) {
    const sim = makeSim();
    const main = line(sim, 2, 5, E, 6);
    const side = line(sim, 5, 2, S, 3);
    place(sim, 'chest', 8, 5);
    for (const b of side) for (const p of [0, 0.3, 0.6]) sim.spawnBeltItem(b.id, 'stone', p);
    const start = census(sim), d = ledger(sim);
    let i = 0;
    while (!(side[2].items[0]?.p > 1.2) && i++ < 600) sim.update(DT);
    assert.ok(side[2].items[0].p > 1.2, 'merge in progress');
    const target = sim.at(5, 5);
    if (action === 'remove') sim.remove(target.id);
    if (action === 'rotate') sim.rotate(target.id);
    if (action === 'rotate2') sim.rotate(target.id, 2);
    if (action === 'removeFeeder') sim.remove(side[2].id);
    assertConserved(sim, start, d, action);
    runChecked(sim, 8, action);
    assertConserved(sim, start, d, action);
    void main;
  }
});

// ---------- loops ----------
test('a 2x2 loop of curves keeps circulating when nearly full', () => {
  const sim = makeSim();
  const loop = loopBelts(sim, [[5, 5], [6, 5], [6, 6], [5, 6]]);
  assert.ok(loop.every(b => b.shape === 'right'), loop.map(b => b.shape).join());
  const total = loop.reduce((a, b) => a + beltLength(b), 0); // PI
  const cap = Math.floor(total / SP);
  const items = fillLoop(sim, loop, cap);
  assert.equal(items.length, cap, `fit ${items.length}/${cap}`);
  assert.equal(sim.spawnBeltItem(loop[0].id, 'stone', 0.37), null, 'a full loop has no room left');
  const start = new Map([...snapshot(sim)]);
  let travelled = 0, prev = snapshot(sim);
  for (let i = 0; i < 60 * 10; i++) {
    sim.update(DT);
    const cur = snapshot(sim);
    for (const [uid, p] of cur) { const q = prev.get(uid); travelled += Math.hypot(p.x - q.x, p.z - q.z); }
    assertNoOverlap(sim, `loop ${i}`);
    prev = cur;
  }
  void start;
  const avg = travelled / cap / 10;
  assert.ok(avg > 1.3, `average speed ${avg.toFixed(3)} tiles/s, should keep flowing`);
});

test('a big ring with straight runs and curves flows forever, items evenly paced', () => {
  const sim = makeSim();
  const loop = ring(sim, 3, 3, 7, 5);
  const its = fillLoop(sim, loop, 40);
  assert.equal(its.length, 40);
  runChecked(sim, 20, 'ring');
  assert.equal(beltItems(sim).length, 40);
  // after 20 s each item moved: check every item is still moving at full speed
  const a = snapshot(sim); sim.update(DT); const b = snapshot(sim);
  for (const [uid, p] of b) { const q = a.get(uid); const d = Math.hypot(p.x - q.x, p.z - q.z); assert.ok(d > STEP * 0.99, `item ${uid} crawls: ${d}`); }
});

test('a loop that closes by side-loading into itself keeps flowing', () => {
  const sim = makeSim();
  // stick (2,5)->(3,5) feeds M=(4,5) from behind; the loop comes back up x=4 into M's south side
  line(sim, 2, 5, E, 2);
  const loop = pathBelts(sim, [[4, 5], [5, 5], [6, 5], [7, 5], [7, 6], [7, 7], [6, 7], [5, 7], [4, 7], [4, 6]], N);
  assert.equal(sim.at(4, 5).shape, 'straight');
  for (const b of loop) sim.spawnBeltItem(b.id, 'copperPlate', 0.1);
  sim.spawnBeltItem(sim.at(2, 5).id, 'wood', 0.5); sim.spawnBeltItem(sim.at(3, 5).id, 'wood', 0.5);
  runChecked(sim, 30, 'six');
  const items = beltItems(sim);
  assert.equal(items.length, 12);
  assert.ok(items.every(({ b }) => loop.includes(b) || b.x === 4), 'the stick drained into the loop');
  let moving = 0; const a = snapshot(sim); run(sim, 0.5); const c = snapshot(sim);
  for (const [uid, p] of c) if (Math.hypot(p.x - a.get(uid).x, p.z - a.get(uid).z) > 0.3) moving++;
  assert.ok(moving >= 10, `${moving} of 12 moving`);
});

// ---------- rotation & shape changes ----------
test('rotating a belt refreshes its own and its neighbours\' shapes', () => {
  const sim = makeSim();
  const a = belt(sim, 5, 5, E), b = belt(sim, 6, 5, S);
  assert.equal(b.shape, 'right');
  const shapes = [];
  sim.events.on('belt:shape', ({ entity }) => shapes.push([entity.id, entity.shape]));
  sim.rotate(a.id);            // a now points south: b is no longer fed from the side
  assert.equal(a.dir, S);
  assert.equal(b.shape, 'straight');
  assert.deepEqual(shapes, [[b.id, 'straight']]);
  sim.rotate(a.id, -1);        // back to east
  assert.equal(b.shape, 'right');
  sim.rotate(b.id);            // b points west: head-on with a, a stays straight, b straight
  assert.equal(b.dir, W); assert.equal(b.shape, 'straight');
});

test('rotating or reshaping a loaded belt keeps its items on valid positions', () => {
  const sim = makeSim();
  const a = belt(sim, 5, 5, E);
  const b = belt(sim, 6, 5, E);
  belt(sim, 7, 5, E);
  for (const p of [0, 0.27, 0.54, 0.81, 1]) sim.spawnBeltItem(b.id, 'stone', p);
  assert.equal(b.items.length, 4);
  const start = census(sim), d = ledger(sim);
  sim.rotate(b.id);              // now points south, fed from the west: a right curve (shorter lane)
  assert.equal(b.shape, 'right');
  assertBeltsValid(sim, 'after rotate');
  assert.equal(b.items.length, 4);  // 4 items on a PI/4 lane: squeezed evenly, never stacked
  for (let i = 1; i < 4; i++) assert.ok(b.items[i - 1].p > b.items[i].p, 'distinct positions');
  runChecked(sim, 3, 'after-rotate', { minGap: SP * 0.95 });
  place(sim, 'chest', 6, 6);     // give it somewhere to go: once it moves the spacing is back to normal
  run(sim, 0.5);
  assertNoOverlap(sim, 'drained');
  runChecked(sim, 2, 'after-rotate-flow');
  assertConserved(sim, start, d, 'rotate');
  // shape change by a neighbour while loaded: put a feeder behind a loaded curve -> straight
  const c = belt(sim, 6, 4, S);  // behind b now -> b becomes straight (fed from the north)
  assert.equal(b.shape, 'straight');
  void a; void c;
  assertBeltsValid(sim, 'after reshape');
  runChecked(sim, 3, 'after-reshape');
  assertConserved(sim, start, d, 'reshape');
});

// ---------- determinism ----------
test('results do not depend on the order belts were placed in', () => {
  const layout = [
    ...[2, 3, 4, 5, 6, 7, 8].map(x => [x, 5, E]), [9, 5, S], [9, 6, S], [9, 7, W], [8, 7, W], [7, 7, N], [7, 6, N], // loop-ish into the line
    ...[1, 2, 3, 4].map(z => [5, z, S]),                // side-loader into (5,5)
    [10, 10, E], [11, 10, E], [12, 10, S], [12, 11, S], [12, 12, W], [11, 12, W], [10, 12, N], [10, 11, N], // a ring
  ];
  const build = order => {
    const sim = makeSim();
    for (const i of order) { const [x, z, d] = layout[i]; belt(sim, x, z, d); }
    // seed the same items by position
    for (const [x, z] of layout) for (const p of [0.1, 0.6]) sim.spawnBeltItem(sim.at(x, z).id, 'stone', p);
    run(sim, 17);
    return beltItems(sim).map(({ b, it }) => `${b.x},${b.z}:${it.p.toFixed(9)}`).sort().join('|');
  };
  const idx = layout.map((_, i) => i);
  const fwd = build(idx);
  assert.equal(build([...idx].reverse()), fwd);
  const shuffled = [...idx].sort((a, b) => ((a * 7919) % 31) - ((b * 7919) % 31));
  assert.equal(build(shuffled), fwd);
});

test('float drift: a compressed line stays exactly spaced over a long run', () => {
  const sim = makeSim();
  const bs = line(sim, 2, 5, E, 4);
  let n = 0;
  for (let k = 0; k < 14; k++) { const L = 3.99 - k * (SP + 1e-6); if (sim.spawnBeltItem(bs[Math.floor(L)].id, 'wood', L - Math.floor(L))) n++; }
  assert.equal(n, 14);
  const loop = ring(sim, 2, 10, 6, 4);
  assert.equal(fillLoop(sim, loop, 50).length, 50);
  for (let i = 0; i < 60 * 300; i++) sim.update(DT);
  const xs = bs.flatMap(b => b.items.map(it => b.x - 2 + it.p)).sort((a, b) => b - a);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i - 1] - xs[i] >= SP - 1e-9, `gap ${xs[i - 1] - xs[i]}`);
  assertBeltsValid(sim, 'drift');
  assertNoOverlap(sim, 'drift');
  assert.equal(beltItems(sim).length, 14 + 50);
});

test('variable frame times give the same flow as fixed ones (sub-stepping)', () => {
  const mk = () => { const sim = makeSim(); const bs = line(sim, 2, 5, E, 8); place(sim, 'chest', 10, 5); for (const b of bs) sim.spawnBeltItem(b.id, 'stone', 0.5); return sim; };
  const a = mk(), b = mk();
  run(a, 3, 1 / 60);
  for (let t = 0; t < 3 - 1e-9;) { const dt = [0.05, 0.004, 0.0333, 0.016][Math.floor(t * 100) % 4]; b.update(Math.min(dt, 3 - t)); t += Math.min(dt, 3 - t); }
  const pos = s => beltItems(s).map(({ b: x, it }) => x.x + it.p).sort();
  const pa = pos(a), pb = pos(b);
  assert.equal(pa.length, pb.length);
  for (let i = 0; i < pa.length; i++) assert.ok(Math.abs(pa[i] - pb[i]) < 1e-6, `${pa[i]} vs ${pb[i]}`);
  assert.equal(a.at(10, 5).total, b.at(10, 5).total);
});

test('entities stay JSON-safe (no cyclic links exposed)', () => {
  const sim = makeSim();
  const loop = loopBelts(sim, [[5, 5], [6, 5], [6, 6], [5, 6]]);
  fillLoop(sim, loop, 6);
  run(sim, 1);
  assert.doesNotThrow(() => JSON.stringify([...sim.entities.values()]));
  assert.deepEqual(Object.keys(loop[0].items[0] || { type: 0, p: 0, uid: 0 }).sort(), ['p', 'type', 'uid']);
  assert.deepEqual(Object.keys(loop[0]).sort(), ['dir', 'from', 'id', 'items', 'kind', 'shape', 'x', 'z']);
});

test('placing a belt facing the end of a loaded belt: the heads share the gap', () => {
  const sim = makeSim();
  const a = line(sim, 2, 5, E, 2);
  for (const p of [0.3, 0.7]) sim.spawnBeltItem(a[1].id, 'stone', p);
  run(sim, 1);
  assert.equal(a[1].items[0].p, 1, 'waiting at the open end');
  const b = line(sim, 5, 5, W, 2); // (5,5) then (4,5), facing a[1]
  for (const x of b) for (const p of [0.2, 0.6]) sim.spawnBeltItem(x.id, 'wood', p);
  runChecked(sim, 3, 'facing');
  const ha = beltPath(a[1], a[1].items[0].p), hb = beltPath(b[1], b[1].items[0].p);
  assert.ok(Math.abs(Math.hypot(ha.x - hb.x, ha.z - hb.z) - SP) < 1e-9);
});

test('event listeners that rebuild belts mid-tick do not duplicate or lose items', () => {
  const sim = makeSim();
  const bl = line(sim, 2, 5, E, 6);
  const chest = place(sim, 'chest', 8, 5);
  for (const b of bl) for (const p of [0.1, 0.5, 0.9]) sim.spawnBeltItem(b.id, 'stone', p);
  const start = census(sim), d = ledger(sim);
  let k = 0;
  sim.events.on('chest:received', () => {
    k++;
    if (k === 2) sim.remove(sim.at(7, 5).id);            // the belt that just delivered
    if (k === 3) sim.rotate(sim.at(4, 5).id, 2);
  });
  sim.events.on('build:removed', () => { sim.place('belt', 7, 5, E); });
  for (let i = 0; i < 600; i++) { sim.update(DT); assertConserved(sim, start, d, `tick ${i}`); assertBeltsValid(sim, `tick ${i}`); }
  assert.ok(chest.total >= 3);
});
