// Numeric checks for the player's free movement (src/view/player/motion.js). Run from the project root:
//   node src/view/player/motion.check.mjs            (summary)       --verbose   (per-scenario numbers)
// Drives the motion core with fixed dt 1/60, 1/120, 1/144 and a jittery 1/30..1/144 mix, holding inputs on a
// timeline, and checks smoothness, frame-rate independence, collisions, corner forgiveness and paths.
import { createMotion, RADIUS } from './motion.js';
import { findPath } from './path.js';
import { createMap } from '../../world/map.js';
import { createSim } from '../../sim/sim.js';
import * as config from '../../config.js';

const verbose = process.argv.includes('--verbose');
const SPEED = config.PLAYER.moveSpeed;
let fails = 0;
const ok = (cond, msg) => { if (!cond) { fails++; console.log('  FAIL', msg); } else if (verbose) console.log('  ok  ', msg); };

// deterministic jittery dt sequence in [1/144, 1/30]
function dtSeq(kind, T) {
  const out = [];
  let t = 0, r = 12345;
  const rnd = () => ((r = (r * 1103515245 + 12345) >>> 0) / 4294967296);
  while (t < T - 1e-9) {
    let dt = kind === 'jitter' ? 1 / 144 + rnd() * (1 / 30 - 1 / 144) : 1 / kind;
    dt = Math.min(dt, T - t);
    out.push(dt); t += dt;
  }
  return out;
}

// Run a motion core over `T` seconds. timeline: [[t, ix, iz], ...] (input changes at those times).
// Inputs change only at frame boundaries, like key events between frames.
// exact: true splits a frame at an input change (tests that the integrator itself is dt-independent).
function run(walk, start, timeline, T, dtKind, heading = 0, exact = false) {
  const m = createMotion({ isWalkable: walk, moveSpeed: SPEED, x: start[0], z: start[1], heading });
  const rec = [];
  let t = 0, ti = 0;
  for (const dt of dtSeq(dtKind, T)) {
    while (ti < timeline.length && timeline[ti][0] <= t + 1e-9) { m.setInput(timeline[ti][1], timeline[ti][2]); ti++; }
    const x0 = m.state.x, z0 = m.state.z;
    if (exact && ti < timeline.length && timeline[ti][0] < t + dt - 1e-9) {
      const a = timeline[ti][0] - t;
      m.step(a); m.setInput(timeline[ti][1], timeline[ti][2]); ti++; m.step(dt - a);
    } else m.step(dt);
    t += dt;
    const s = m.state;
    rec.push({ t, dt, x: s.x, z: s.z, vx: s.vx, vz: s.vz, h: s.heading, jump: Math.hypot(s.x - x0, s.z - z0) });
  }
  return { m, rec };
}
const at = (rec, t) => { // linear interpolation of the record at time t
  let i = rec.findIndex(r => r.t >= t - 1e-9);
  if (i <= 0) return rec[Math.max(0, i)];
  const a = rec[i - 1], b = rec[i], k = (t - a.t) / (b.t - a.t);
  return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k, h: a.h + Math.atan2(Math.sin(b.h - a.h), Math.cos(b.h - a.h)) * k };
};
function stats(rec) {
  let maxJumpRatio = 0, maxD2 = 0, maxDV = 0, maxDH = 0;
  for (let i = 0; i < rec.length; i++) {
    const r = rec[i];
    maxJumpRatio = Math.max(maxJumpRatio, r.jump / (SPEED * r.dt));
    if (i >= 2) {
      // second difference of position, normalised to an acceleration (tiles/s^2) so mixed dt compare
      const a = rec[i - 2], b = rec[i - 1];
      const v1x = (b.x - a.x) / b.dt, v1z = (b.z - a.z) / b.dt, v2x = (r.x - b.x) / r.dt, v2z = (r.z - b.z) / r.dt;
      maxD2 = Math.max(maxD2, Math.hypot(v2x - v1x, v2z - v1z) / ((r.dt + b.dt) / 2));
    }
    if (i >= 1) {
      const p = rec[i - 1];
      maxDV = Math.max(maxDV, Math.hypot(r.vx - p.vx, r.vz - p.vz) / r.dt);
      maxDH = Math.max(maxDH, Math.abs(Math.atan2(Math.sin(r.h - p.h), Math.cos(r.h - p.h))) / r.dt);
    }
  }
  return { maxJumpRatio, maxAcc: maxD2, maxDV, maxDH };
}
// count sign flips of the acceleration along the walking axis while input is constant (jitter / stutter)
function accSignFlips(rec, axis, t0, t1) {
  let flips = 0, prev = 0;
  for (let i = 2; i < rec.length; i++) {
    const r = rec[i];
    if (r.t < t0 || r.t > t1) continue;
    const a = rec[i - 2], b = rec[i - 1];
    const acc = ((r[axis] - b[axis]) / r.dt - (b[axis] - a[axis]) / b.dt);
    const sg = Math.abs(acc) < 1e-6 ? 0 : Math.sign(acc);
    if (sg && prev && sg !== prev) flips++;
    if (sg) prev = sg;
  }
  return flips;
}

// ---------- open field ----------
const open = () => true;
console.log('open field: straight walk, reversal, 90-degree turn, stop');
{
  const timeline = [[0, 0, 0], [0.1, 1, 0], [1.0, -1, 0], [1.6, 0, 1], [2.2, 0, 0]];
  const runs = {}, exact = {};
  for (const k of [60, 120, 144, 'jitter']) { runs[k] = run(open, [0, 0], timeline, 2.6, k); exact[k] = run(open, [0, 0], timeline, 2.6, k, 0, true); }
  for (const k of [60, 144, 'jitter']) {
    let maxErr = 0, maxErrH = 0;
    for (const t of [0.2, 0.5, 0.9, 1.1, 1.3, 1.7, 2.0, 2.3, 2.6]) {
      const a = at(exact[120].rec, t), b = at(exact[k].rec, t);
      maxErr = Math.max(maxErr, Math.hypot(a.x - b.x, a.z - b.z));
    }
    ok(maxErr < 0.012, `frame-rate independence ${k} vs 120 Hz (inputs at the same instants): max position difference ${maxErr.toFixed(4)} tiles`);
  }
  // with inputs only seen at frame boundaries, the difference stays within one frame of walking
  for (const k of [60, 144, 'jitter']) {
    let maxErr = 0;
    for (const t of [0.5, 0.9, 1.5, 2.0, 2.6]) { const a = at(runs[120].rec, t), b = at(runs[k].rec, t); maxErr = Math.max(maxErr, Math.hypot(a.x - b.x, a.z - b.z)); }
    const frame = SPEED * Math.max(...runs[k].rec.map(r => r.dt));
    ok(maxErr <= frame * 2.5, `${k} vs 120 Hz (inputs at frame boundaries): ${maxErr.toFixed(3)} tiles <= input-timing bound ${(frame * 2.5).toFixed(3)}`);
  }
  for (const k of [60, 120, 144, 'jitter']) {
    const st = stats(runs[k].rec);
    ok(st.maxJumpRatio <= 1.0001, `${k}: no frame moves farther than speed*dt (max ${st.maxJumpRatio.toFixed(3)} x)`);
    // the exponential approach bounds acceleration by k * |dv|: 38 * 4.2 on a stop, 23 * 8.4 on a reversal
    ok(st.maxAcc < 200, `${k}: acceleration bounded by the approach rate (max ${st.maxAcc.toFixed(1)} tiles/s^2 = ${(st.maxAcc / 3600).toFixed(4)} tiles per frame^2 at 60 Hz)`);
    // while the input is held steady, second differences decay to nothing
    const steady = runs[k].rec.filter(r => r.t > 0.55 && r.t < 0.95);
    let sd = 0;
    for (let i = 2; i < steady.length; i++) sd = Math.max(sd, Math.abs((steady[i].x - steady[i - 1].x) / steady[i].dt - (steady[i - 1].x - steady[i - 2].x) / steady[i - 1].dt));
    ok(sd < 0.01, `${k}: steady walk velocity changes by < 0.01 tiles/s per frame (max ${sd.toExponential(2)})`);
    if (verbose) console.log('       ', k, JSON.stringify(Object.fromEntries(Object.entries(st).map(([a, b]) => [a, +b.toFixed(3)]))));
    const flips = accSignFlips(runs[k].rec, 'x', 0.35, 0.95);
    ok(flips === 0, `${k}: steady walk has no acceleration sign flips (stutter): ${flips}`);
  }
  const r = runs[60].rec;
  // responsiveness: first frame after the key press already moves
  const first = r.find(q => q.t > 0.1 + 1e-9);
  ok(first.vx > 0.25 * SPEED, `zero input lag: velocity after the first frame = ${(first.vx / SPEED * 100).toFixed(0)}% of top speed`);
  const t90 = r.find(q => q.t > 0.1 && q.vx >= 0.9 * SPEED).t - 0.1;
  ok(t90 > 0.07 && t90 < 0.13, `accelerates to 90% in ${t90.toFixed(3)} s`);
  // reversal passes through zero smoothly: the velocity changes sign exactly once, monotonically
  const rev = r.filter(q => q.t > 1.0 && q.t < 1.4);
  let mono = true; for (let i = 1; i < rev.length; i++) if (rev[i].vx > rev[i - 1].vx + 1e-9) mono = false;
  ok(mono, 'reversal: velocity goes monotonically from +v through 0 to -v (no snap, no skid)');
  const tRev = rev.find(q => q.vx <= -0.9 * SPEED)?.t - 1.0;
  ok(tRev < 0.2, `reversal reaches 90% reverse speed in ${tRev?.toFixed(3)} s`);
  // heading during the reversal turns toward the camera (+z, sin(h) > 0)
  const mid = r.filter(q => q.t > 1.0 && q.t < 1.25).map(q => Math.sin(q.h));
  ok(Math.max(...mid) > 0.9, `reversal turns through the camera-facing side (max sin(heading) ${Math.max(...mid).toFixed(2)})`);
  // 90-degree turn: heading from 180deg (west) to 90deg (south) in ~0.1-0.12 s
  const turn = r.filter(q => q.t > 1.6);
  const hT = turn.find(q => Math.abs(Math.atan2(Math.sin(q.h - Math.PI / 2), Math.cos(q.h - Math.PI / 2))) < 0.1)?.t - 1.6;
  ok(hT > 0.06 && hT < 0.16, `90-degree turn completes (within 6 deg) in ${hT?.toFixed(3)} s`);
  // the turn arcs: during the turn the path curves (both components non-zero for a while)
  const arcFrames = turn.filter(q => q.t < 1.8 && Math.abs(q.vx) > 0.15 * SPEED && Math.abs(q.vz) > 0.15 * SPEED).length;
  ok(arcFrames >= 3, `turn arcs naturally (${arcFrames} frames with both velocity components > 15%)`);
  // stop: at rest within ~0.08-0.12 s and little slide
  const stop = r.filter(q => q.t > 2.2);
  const tStop = stop.find(q => Math.hypot(q.vx, q.vz) < 0.05 * SPEED)?.t - 2.2;
  const p0 = at(r, 2.2), p1 = r[r.length - 1];
  ok(tStop < 0.1, `stops (speed < 5%) in ${tStop?.toFixed(3)} s, slides ${Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(3)} tiles`);
  // diagonals normalised
  const d = run(open, [0, 0], [[0, 1, 1]], 1, 60).rec.at(-1);
  ok(Math.abs(Math.hypot(d.vx, d.vz) - SPEED) < 0.01, `diagonal speed ${Math.hypot(d.vx, d.vz).toFixed(3)} = moveSpeed`);
  // analog stick: speed scales with the magnitude; above 1 is clamped
  for (const mag of [0.3, 0.5, 1, 1.6]) {
    const q = run(open, [0, 0], [[0, mag * 0.6, mag * 0.8]], 1, 60).rec.at(-1);
    const want = SPEED * Math.min(1, mag);
    ok(Math.abs(Math.hypot(q.vx, q.vz) - want) < 0.01, `analog magnitude ${mag}: speed ${Math.hypot(q.vx, q.vz).toFixed(3)} (want ${want.toFixed(2)})`);
  }
  // heading never pivots: turn rate capped, and smooth (no angular-velocity jumps beyond the spring)
  for (const k of [60, 144, 'jitter']) {
    const st = stats(runs[k].rec);
    ok(st.maxDH <= 30.01, `${k}: heading turn rate <= 30 rad/s (max ${st.maxDH.toFixed(1)})`);
  }
}

// ---------- synthetic walls ----------
// '#' = solid. Map rows are z, columns x.
function grid(rows) {
  return (x, z) => z >= 0 && z < rows.length && x >= 0 && x < rows[0].length && rows[z][x] !== '#';
}
console.log('walls: sliding, corners, 1-tile gap, tunnelling');
{
  const W = grid([
    '##########',
    '#........#',
    '#........#',
    '#####.####',   // a 1-tile gap at x = 5
    '#........#',
    '#........#',
    '##########',
  ]);
  for (const k of [60, 'jitter', 30]) {
    // walk straight north toward the gap from 0.35 tiles off-centre: corner forgiveness threads it
    for (const off of [-0.38, -0.25, 0.2, 0.36]) {
      const { rec } = run(W, [5 + off, 5], [[0, 0, -1]], 1.6, k);
      const end = rec.at(-1);
      ok(end.z < 2.2, `${k}: threads the 1-tile gap from ${off >= 0 ? '+' : ''}${off} (ends at z ${end.z.toFixed(2)})`);
      ok(stats(rec).maxJumpRatio <= 1.0001, `${k}: no jumps while threading from ${off}`);
    }
    // far off-centre: no gap within reach -> stops against the wall, no jitter
    const { rec: far } = run(W, [2, 5], [[0, 0, -1]], 1, k);
    const fe = far.at(-1);
    ok(Math.abs(fe.z - (3.5 + RADIUS)) < 0.01 && Math.abs(fe.x - 2) < 1e-6, `${k}: stops flush against a plain wall (z ${fe.z.toFixed(3)})`);
    // diagonal into the wall: slides along it
    const { rec: sl } = run(W, [2, 5], [[0, 1, -1]], 0.8, k);
    const se = sl.at(-1);
    ok(se.x > 4.2, `${k}: slides along the wall on diagonal input (x ${se.x.toFixed(2)})`);
    // tunnelling: huge dt
    const m = createMotion({ isWalkable: W, moveSpeed: SPEED, x: 2, z: 5 });
    m.setInput(0, -1);
    for (let i = 0; i < 4; i++) m.step(0.5);
    ok(m.state.z > 3.5, `no tunnelling at dt 0.5 (z ${m.state.z.toFixed(2)})`);
  }
  // convex corner: walking east along z = 2.6 (circle overlaps the corner of the wall row below) glides past
  const { rec: cr } = run(grid([
    '########',
    '#......#',
    '#......#',
    '#..#####',
    '########',
  ]), [1.5, 2.3], [[0, 1, 0]], 1, 60);
  ok(cr.at(-1).x > 5.35 && stats(cr).maxJumpRatio <= 1.0001, `rounds a convex corner without snagging (x ${cr.at(-1).x.toFixed(2)})`);
}

// ---------- the real map ----------
console.log('real map: coastline, paths');
{
  const map = createMap();
  const sim = createSim(map);
  const walk = (x, z) => sim.isWalkable(x, z);
  // east from the start into the water channel: stops at the shore
  const { rec } = run(walk, [22, 16], [[0, 1, 0]], 1.2, 'jitter');
  ok(Math.abs(rec.at(-1).x - (23.5 - RADIUS)) < 0.01, `stops at the shoreline (x ${rec.at(-1).x.toFixed(3)})`);
  // slide down along the coast with south-east input
  const { rec: slide } = run(walk, [23, 15], [[0, 1, 1]], 0.8, 'jitter');
  const minX = Math.min(...slide.map(r => r.x)), maxX = Math.max(...slide.map(r => r.x));
  ok(maxX <= 23.5 - RADIUS + 1e-6 && slide.at(-1).z > 17, `slides along the coastline (x stays <= ${maxX.toFixed(3)}, z -> ${slide.at(-1).z.toFixed(2)})`);
  // paths: BFS to a far tile and arrive
  for (const [gx, gz] of [[15, 13], [27, 13], [22, 10], [30, 9], [14, 17]]) {
    const m = createMotion({ isWalkable: walk, moveSpeed: SPEED, x: 22, z: 16 });
    const pts = findPath(sim, map, 22, 16, (x, z) => x === gx && z === gz);
    let arrived = false;
    m.follow(pts, { onArrive: () => { arrived = true; } });
    let maxJ = 0, T = 0;
    for (let i = 0; i < 900 && !arrived; i++) { const x0 = m.state.x, z0 = m.state.z; m.step(1 / 60); T += 1 / 60; maxJ = Math.max(maxJ, Math.hypot(m.state.x - x0, m.state.z - z0) / (SPEED / 60)); }
    ok(arrived && Math.hypot(m.state.x - gx, m.state.z - gz) < 0.08, `path to (${gx}, ${gz}), ${pts.length} tiles: arrives in ${T.toFixed(2)} s at (${m.state.x.toFixed(2)}, ${m.state.z.toFixed(2)}), max frame step ${maxJ.toFixed(3)} x speed*dt`);
  }
}

console.log(fails ? `${fails} check(s) failed` : 'all movement checks passed');
process.exitCode = fails ? 1 : 0;
