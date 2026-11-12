// Building models, built once and cached as merged vertex-coloured geometries (one per moving part).
// Front / output faces local +x. Ground is y = 0. Used by buildings.js (world + ghosts) and items.js (minis).
import * as THREE from 'three';
import { beltPath, beltLength } from '../../sim/sim.js';
import { Parts, rbox, puck, gear, sweep, jitter, fitMini } from './geom.js';

// Module-local colours (the PALETTE wood / copper / stone / belt family plus the shades it does not have).
// Higher key than the raw palette: warm honey wood, no near-black anywhere (the darkest tone is a soft cocoa), and a
// lifted blue-grey slate for the belts so a run reads as a toy track on the bright grass, not a black stripe.
export const COL = {
  wood: '#d8a265', woodDark: '#b5804c', woodLight: '#eec48b',
  copper: '#ec9558', copperDark: '#c97445', copperLight: '#f8b27a',
  stone: '#f1e6cc', stoneShade: '#dfd0ad', stoneDark: '#c9b993',
  hole: '#8a6248', belt: '#7d8597', beltDeep: '#666d7e', rail: '#f2e6c8', stripe: '#f8cb55',
  glowOff: '#a07b5c', glowOn: '#ffd884', anvil: '#b2aca2', hollow: '#9a6a43',
};

// ---------- belts ----------
export const BELT_TOP = 0.088;  // track surface height: items ride here
const TRACK = 0.3;              // half width of the moving track
const RAIL_C = 0.367, RAIL_HW = 0.064, RAIL_TOP = 0.15, RAIL_R = 0.05, BED = 0.062;

function railStrips(side) { // side -1 left (-lateral), +1 right
  const out = [], top = [];
  const outer = RAIL_C + RAIL_HW, inner = RAIL_C - RAIL_HW;
  // lower outer wall (dark bed colour)
  const wall = [[outer, 0], [outer, BED]];
  // rounded rail cap: outer wall top -> arc -> arc -> inner wall down to the track
  top.push([outer, BED], [outer, RAIL_TOP - RAIL_R]);
  for (let i = 1; i <= 4; i++) { const a = (i / 4) * Math.PI / 2; top.push([outer - RAIL_R + Math.cos(a) * RAIL_R, RAIL_TOP - RAIL_R + Math.sin(a) * RAIL_R]); }
  for (let i = 1; i <= 4; i++) { const a = Math.PI / 2 + (i / 4) * Math.PI / 2; top.push([inner + RAIL_R + Math.cos(a) * RAIL_R, RAIL_TOP - RAIL_R + Math.sin(a) * RAIL_R]); }
  top.push([inner, BELT_TOP]);
  // profile points are given for the right rail going outward->inward; mirror / reorder per side so that the
  // traversal always runs left-to-right (outside on the right of travel).
  const mapPts = pts => (side < 0 ? pts.map(([l, y]) => [-l, y]) : pts.slice().reverse().map(([l, y]) => [l, y]));
  if (side < 0) { out.push({ pts: mapPts(wall), color: COL.beltDeep }); out.push({ pts: mapPts(top), color: COL.rail }); }
  else { out.push({ pts: mapPts(top), color: COL.rail }); out.push({ pts: mapPts(wall), color: COL.beltDeep }); }
  return out;
}
function beltStrips() {
  return [
    ...railStrips(-1),
    { pts: [[-TRACK - 0.005, BELT_TOP], [-TRACK * 0.5, BELT_TOP], [0, BELT_TOP], [TRACK * 0.5, BELT_TOP], [TRACK + 0.005, BELT_TOP]], color: COL.belt, track: true },
    ...railStrips(1),
  ];
}
// Local belt frames: dir 0 (exit +x); local "from" 2 = straight, 1 = left curve, 3 = right curve.
export const LOCAL_BELT = { 2: { x: 0, z: 0, dir: 0, from: 2 }, 1: { x: 0, z: 0, dir: 0, from: 1 }, 3: { x: 0, z: 0, dir: 0, from: 3 } };
export const localPath = (lf, p) => beltPath(LOCAL_BELT[lf], p);
export const laneLength = lf => beltLength(LOCAL_BELT[lf]);

// ---------- bendable belts ----------
// World belts are ONE instanced geometry that the belt shader bends per instance, so a belt that turns into a curve
// (drag auto-corners, a feeder appearing at its side) morphs smoothly instead of swapping meshes.
// bend b: 0 straight, +1 = local from 1 (enters from +z), -1 = local from 3 (enters from -z). The path is traced
// backward from the fixed exit (0.5, 0): a constant-curvature arc turning b * 90 degrees whose length goes from 1
// (straight) to PI/4 (the sim's quarter circle of radius 0.5), so at b = 0 / +-1 it is exactly beltPath.
// Keep in sync with beltBend() in beltMaterial.js.
export const bendOf = lf => (lf === 1 ? 1 : lf === 3 ? -1 : 0);
export const bendLength = b => 1 + (Math.PI / 4 - 1) * Math.min(1, Math.abs(b));
export function bendPath(b, p, out = {}) {
  if (p > 1) { out.x = p - 0.5; out.z = 0; out.angle = 0; return out; } // side-loading: straight on past the exit
  if (p < 0) {
    if (Math.abs(b) < 1e-6) { out.x = p - 0.5; out.z = 0; out.angle = 0; return out; }
    p = 0;
  }
  const L = bendLength(b), k = b * (Math.PI / 2) / L, sg = (1 - p) * L, ks = k * sg;
  if (Math.abs(k) < 1e-3) { out.x = 0.5 - sg; out.z = 0.5 * ks * sg; }
  else { out.x = 0.5 - Math.sin(ks) / k; out.z = (1 - Math.cos(ks)) / k; }
  out.angle = -ks;
  return out;
}

const cache = new Map();
const once = (key, fn) => { if (!cache.has(key)) cache.set(key, fn()); return cache.get(key); };

const BELT_AO = { y0: 0, y1: 0.12, min: 0.88 };
// Static belt shapes (ghosts, icons, the item mini).
export function beltGeometry(lf) {
  return once(`belt${lf}`, () => {
    const segs = lf === 2 ? 2 : 14;
    const g = sweep(beltStrips(), p => localPath(lf, p), segs, { trackHalf: TRACK, ao: BELT_AO, uScale: laneLength(lf) });
    g.computeBoundingBox(); g.computeBoundingSphere();
    return g;
  });
}
// The bendable world belt: position = (p, y, lateral), normal = (0, ny, lateral n), uv = (p, across | NO_TRACK).
// Only valid with the bend belt material, which places every vertex on bendPath.
export function beltBendGeometry() {
  return once('beltBend', () => {
    const g = sweep(beltStrips(), p => ({ x: p, z: 0, angle: 0 }), 12, { trackHalf: TRACK, ao: BELT_AO, uScale: 1 });
    g.boundingBox = new THREE.Box3(new THREE.Vector3(-0.6, 0, -0.6), new THREE.Vector3(0.6, 0.2, 0.6));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.1, 0), 0.86);
    return g;
  });
}
// Run-end bumper, in an "edge frame": origin at the tile edge midpoint, outward +x, lateral z.
export function beltCapGeometry() {
  return once('beltCap', () => {
    const p = new Parts({ ao: { y0: 0, y1: 0.14, min: 0.8 } });
    p.add(rbox(0.1, 0.16, 0.88, 0.045, 3), COL.copper, { p: [-0.03, 0.08, 0] });
    p.add(rbox(0.04, 0.03, 0.62, 0.012), COL.copperLight, { p: [0.012, 0.115, 0], ao: false });
    return p.merge();
  });
}
// Chevrons as real geometry, for the mini belt item (the world belts paint them in the shader).
function chevronParts(p, x0, n = 2) {
  for (let i = 0; i < n; i++) {
    const x = x0 + i * 0.33;
    for (const s of [-1, 1]) p.add(rbox(0.075, 0.014, 0.27, 0.006), COL.stripe, { p: [x - 0.05, BELT_TOP + 0.005, s * 0.115], r: [0, -s * 0.42, 0], ao: false });
  }
}

// Whole belt (straight + both bumpers), used for ghosts / icons / the item mini.
export function beltWhole({ chevrons = false } = {}) {
  return once(`beltWhole${chevrons}`, () => {
    const p = new Parts();
    const straight = beltGeometry(2).clone();
    straight.deleteAttribute('beltOff'); // instanced-only attribute added by the world belt pool
    p.addGeometry(straight);
    const cap = beltCapGeometry();
    p.addGeometry(cap.clone().applyMatrix4(new THREE.Matrix4().makeTranslation(0.5, 0, 0)));
    p.addGeometry(cap.clone().applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI).setPosition(-0.5, 0, 0)));
    if (chevrons) chevronParts(p, -0.2, 2);
    return p.merge();
  });
}

// ---------- drill ----------
// parts: body (static), spinner (gear on top, spins about y; origin on the axis at the cap top),
// bit (shaft + spiral bit; origin on the axis at the cap underside, hangs down).
export const DRILL = { capTop: 0.9, capBottom: 0.8, chuteEnd: [0.47, 0.26, 0], hole: [0, 0.19, 0], heldAt: [0.39, 0.3, 0] };
export function drillParts(deposit = 'copper') {
  return once(`drill:${deposit}`, () => {
    const body = new Parts({ ao: { y0: 0, y1: 0.5, min: 0.78 } });
    // stone base: plinth + slab
    body.add(rbox(0.9, 0.07, 0.9, 0.03), COL.stoneShade, { p: [0, 0.035, 0] });
    body.add(rbox(0.82, 0.15, 0.82, 0.055, 3), COL.stone, { p: [0, 0.115, 0] });
    // hole with a copper collar
    body.add(puck(0.15, 0.02, 0.008, 18), COL.hole, { p: [0, 0.188, 0], ao: false });
    body.add(new THREE.TorusGeometry(0.16, 0.028, 6, 22), COL.copper, { p: [0, 0.192, 0], r: [Math.PI / 2, 0, 0], ao: false });
    // leaning wooden posts (chunky A-frame tower) standing in copper shoes
    const lean = 0.1, ph = 0.66;
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      body.add(rbox(0.11, ph, 0.11, 0.042, 3), COL.wood, { p: [sx * 0.255, 0.19 + ph / 2, sz * 0.255], r: [-sz * lean, 0, sx * lean], seed: 3 + sx + sz * 2 });
      body.add(rbox(0.15, 0.07, 0.15, 0.03), COL.copperDark, { p: [sx * 0.285, 0.215, sz * 0.285], ao: false });
    }
    // cross beams
    for (const s of [-1, 1]) {
      body.add(rbox(0.5, 0.075, 0.075, 0.03), COL.woodDark, { p: [0, 0.5, s * 0.25] });
      body.add(rbox(0.075, 0.075, 0.5, 0.03), COL.woodDark, { p: [s * 0.25, 0.5, 0] });
    }
    // top cap
    body.add(rbox(0.56, 0.1, 0.56, 0.04, 3), COL.woodDark, { p: [0, 0.85, 0] });
    body.add(rbox(0.5, 0.03, 0.5, 0.012), COL.wood, { p: [0, 0.9, 0], ao: false });
    // output chute on +x: sloped trough with side walls and a copper lip
    const slope = -0.42;
    body.add(rbox(0.3, 0.04, 0.22, 0.015), COL.wood, { p: [0.33, 0.33, 0], r: [0, 0, slope] });
    for (const s of [-1, 1]) body.add(rbox(0.3, 0.08, 0.035, 0.015), COL.woodDark, { p: [0.33, 0.36, s * 0.12], r: [0, 0, slope] });
    body.add(rbox(0.04, 0.05, 0.25, 0.015), COL.copper, { p: [0.475, 0.255, 0], r: [0, 0, slope] });
    // a little pile of what it digs, on the back-left of the base
    const pile = deposit === 'stone' ? [COL.stone, '#cbbd99'] : [COL.copper, '#9a5a37'];
    for (const [x, z, s, k] of [[-0.31, 0.3, 0.055, 0], [-0.25, 0.33, 0.045, 1], [-0.33, 0.22, 0.04, 1]]) {
      body.add(jitter(new THREE.DodecahedronGeometry(s, 0), s * 0.4, 9 + k), pile[k], { p: [x, 0.19 + s * 0.6, z], flat: true, jitter: 0.08, ao: false });
    }

    const spin = new Parts({ ao: false });
    spin.add(gear(0.25, 0.2, 12, 0.05, { holes: 4, holeR: 0.28 }), COL.copper, { r: [-Math.PI / 2, 0, 0], p: [0, 0.03, 0], flat: true });
    spin.add(puck(0.1, 0.08, 0.025, 16), COL.copperDark, { p: [0, 0.045, 0] });
    spin.add(new THREE.SphereGeometry(0.055, 12, 8), COL.woodLight, { p: [0, 0.13, 0], s: [1, 0.8, 1] });

    const bit = new Parts({ ao: false });
    bit.add(new THREE.CylinderGeometry(0.035, 0.035, 0.46, 8), COL.copperDark, { p: [0, -0.23, 0] });
    bit.add(puck(0.07, 0.05, 0.015, 12), COL.woodDark, { p: [0, -0.28, 0] });
    // spiral bit: twisted faceted cone with alternating facet colours, so spinning reads clearly
    const cone = new THREE.ConeGeometry(0.115, 0.22, 6, 4);
    cone.rotateX(Math.PI); // tip down
    const cp = cone.attributes.position;
    for (let i = 0; i < cp.count; i++) {
      const y = cp.getY(i), a = (y + 0.11) * 7, x = cp.getX(i), z = cp.getZ(i);
      cp.setXYZ(i, x * Math.cos(a) - z * Math.sin(a), y, x * Math.sin(a) + z * Math.cos(a));
    }
    bit.add(cone, COL.copper, {
      p: [0, -0.44, 0], flat: true,
      faceColor: (cx, cy, cz) => ((Math.floor(((Math.atan2(cz, cx) - (cy + 0.44 + 0.11) * 7) / (Math.PI * 2)) * 6 + 60) % 2) ? COL.copperLight : COL.copperDark),
    });
    return { body: body.merge(), spinner: spin.merge(), bit: bit.merge() };
  });
}

// ---------- chest ----------
// parts: body, lid (origin on the hinge at the back top edge; opens with +rotation.z).
export const CHEST = { hinge: [-0.31, 0.41, 0] };
export function chestParts() {
  return once('chest', () => {
    const body = new Parts({ ao: { y0: 0, y1: 0.42, min: 0.76 } });
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) body.add(rbox(0.13, 0.06, 0.13, 0.025), COL.woodDark, { p: [sx * 0.24, 0.03, sz * 0.3] });
    body.add(rbox(0.62, 0.36, 0.78, 0.05, 3), COL.wood, { p: [0, 0.23, 0] });
    // plank grooves on all four faces
    for (const y of [0.17, 0.29]) {
      body.add(rbox(0.02, 0.016, 0.7, 0.006), COL.woodDark, { p: [0.31, y, 0] });
      body.add(rbox(0.02, 0.016, 0.7, 0.006), COL.woodDark, { p: [-0.31, y, 0] });
      body.add(rbox(0.54, 0.016, 0.02, 0.006), COL.woodDark, { p: [0, y, 0.39] });
      body.add(rbox(0.54, 0.016, 0.02, 0.006), COL.woodDark, { p: [0, y, -0.39] });
    }
    // dark hollow seen when the lid swings open
    body.add(rbox(0.5, 0.012, 0.64, 0.005), COL.hollow, { p: [0, 0.41, 0], ao: false });
    // copper bands
    for (const s of [-1, 1]) body.add(rbox(0.65, 0.37, 0.075, 0.02), COL.copper, { p: [0, 0.235, s * 0.235] });
    // copper corner caps along the bottom front
    for (const s of [-1, 1]) body.add(rbox(0.07, 0.1, 0.07, 0.025), COL.copperDark, { p: [0.29, 0.1, s * 0.37] });

    const lid = new Parts({ ao: { y0: -0.02, y1: 0.18, min: 0.86 } });
    lid.add(rbox(0.66, 0.13, 0.82, 0.06, 3), COL.wood, { p: [0.33, 0.055, 0] });
    lid.add(rbox(0.54, 0.07, 0.7, 0.035, 3), COL.woodLight, { p: [0.33, 0.115, 0] });
    for (const s of [-1, 1]) lid.add(rbox(0.68, 0.18, 0.08, 0.04, 3), COL.copper, { p: [0.33, 0.07, s * 0.235] });
    for (const z of [-0.33, 0, 0.33]) lid.add(rbox(0.5, 0.012, 0.018, 0.005), COL.woodDark, { p: [0.33, 0.151, z * 0.42], ao: false });
    // latch with keyhole
    lid.add(rbox(0.06, 0.16, 0.14, 0.025), COL.copper, { p: [0.67, 0.0, 0] });
    lid.add(rbox(0.012, 0.04, 0.026, 0.006), COL.hole, { p: [0.702, -0.02, 0], ao: false });
    return { body: body.merge(), lid: lid.merge() };
  });
}

// ---------- workshop ----------
// parts: body, hammer (origin at its pivot; +rotation.z lifts the head), gear (horizontal, spins about y),
// glow (window panes; drawn with a per-workshop basic material), and anchor points.
export const WORKSHOP = {
  pivot: [-0.1, 0.9, 0], gear: [-0.2, 0.69, 0.25], chimneyTop: [-0.24, 1.08, -0.24],
  hatch: [0.47, 0.24, 0], floatAt: [0.12, 1.34, 0.1], anvilTop: 0.78,
};
export function workshopParts() {
  return once('workshop', () => {
    const W = WORKSHOP;
    const body = new Parts({ ao: { y0: 0, y1: 0.55, min: 0.76 } });
    body.add(rbox(0.94, 0.07, 0.94, 0.03), COL.stoneShade, { p: [0, 0.035, 0] });
    body.add(rbox(0.88, 0.1, 0.88, 0.045, 3), COL.stoneShade, { p: [0, 0.11, 0] });
    body.add(rbox(0.74, 0.46, 0.74, 0.05, 3), COL.stone, { p: [-0.01, 0.38, 0] });
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) body.add(rbox(0.11, 0.48, 0.11, 0.035), COL.wood, { p: [-0.01 + sx * 0.35, 0.39, sz * 0.35] });
    // roof slab + rim
    body.add(rbox(0.86, 0.09, 0.86, 0.04, 3), COL.woodDark, { p: [-0.01, 0.645, 0] });
    body.add(rbox(0.76, 0.03, 0.76, 0.014), COL.woodLight, { p: [-0.01, 0.695, 0], ao: false });
    // output hatch on +x
    body.add(rbox(0.05, 0.27, 0.36, 0.025), COL.copper, { p: [0.37, 0.32, 0] });
    body.add(rbox(0.04, 0.19, 0.26, 0.02), COL.hole, { p: [0.385, 0.315, 0], ao: false });
    body.add(rbox(0.13, 0.035, 0.3, 0.015), COL.copperDark, { p: [0.43, 0.2, 0], r: [0, 0, -0.25] });
    // round window frames on the sides (panes are the glow part)
    for (const s of [-1, 1]) body.add(new THREE.TorusGeometry(0.075, 0.022, 6, 18), COL.copper, { p: [-0.05, 0.4, s * 0.372], ao: false });
    // chimney
    body.add(puck(0.095, 0.36, 0.02, 14), COL.stone, { p: [W.chimneyTop[0], 0.69, W.chimneyTop[2]] });
    body.add(puck(0.12, 0.06, 0.02, 14), COL.copper, { p: [W.chimneyTop[0], 1.0, W.chimneyTop[2]], ao: false });
    body.add(puck(0.075, 0.012, 0.004, 12), COL.hole, { p: [W.chimneyTop[0], 1.058, W.chimneyTop[2]], ao: false });
    // anvil on the roof front
    body.add(rbox(0.2, 0.06, 0.18, 0.02), COL.stoneDark, { p: [0.21, 0.725, 0] });
    body.add(rbox(0.14, 0.03, 0.14, 0.012), COL.anvil, { p: [0.21, 0.765, 0], ao: false });
    // hammer frame: two posts and an axle
    for (const s of [-1, 1]) body.add(rbox(0.06, 0.26, 0.05, 0.02), COL.woodDark, { p: [W.pivot[0], 0.81, s * 0.085] });
    body.add(new THREE.CylinderGeometry(0.028, 0.028, 0.24, 10), COL.copperDark, { p: [W.pivot[0], W.pivot[1], 0], r: [Math.PI / 2, 0, 0], ao: false });
    // gear post
    body.add(puck(0.05, 0.03, 0.01, 10), COL.copperDark, { p: [W.gear[0], 0.69, W.gear[2]], ao: false });

    const ham = new Parts({ ao: false });
    // arm from pivot toward +x, head over the anvil (head bottom at anvil top when rotation.z = 0)
    const headX = 0.31, headDrop = W.pivot[1] - W.anvilTop; // 0.12
    ham.add(rbox(0.36, 0.065, 0.065, 0.025), COL.woodDark, { p: [0.16, 0, 0] });
    ham.add(rbox(0.14, 0.13, 0.18, 0.04, 3), COL.copper, { p: [headX, -headDrop + 0.065, 0] });
    ham.add(rbox(0.15, 0.03, 0.19, 0.014), COL.copperLight, { p: [headX, -headDrop + 0.125, 0] });
    ham.add(puck(0.05, 0.03, 0.012, 10), COL.copperLight, { p: [0, -0.015, 0], r: [Math.PI / 2, 0, 0] });

    const gr = new Parts({ ao: false });
    gr.add(gear(0.15, 0.12, 9, 0.045, { holes: 3, holeR: 0.3 }), COL.copper, { r: [-Math.PI / 2, 0, 0], p: [0, 0.035, 0], flat: true });
    gr.add(puck(0.055, 0.05, 0.015, 12), COL.copperDark, { p: [0, 0.04, 0] });

    const glow = new Parts({ ao: false });
    for (const s of [-1, 1]) glow.add(new THREE.CircleGeometry(0.068, 16), '#ffffff', { p: [-0.05, 0.4, s * 0.371], r: [0, s > 0 ? 0 : Math.PI, 0] });
    return { body: body.merge(), hammer: ham.merge(), gear: gr.merge(), glow: glow.merge() };
  });
}

// ---------- static whole models (ghosts, icons, item minis) ----------
const tr = (g, x, y, z, ry = 0) => g.clone().applyMatrix4(new THREE.Matrix4().makeRotationY(ry).setPosition(x, y, z));
export function wholeModel(kind) {
  return once(`whole:${kind}`, () => {
    const p = new Parts();
    if (kind === 'belt') return beltWhole({ chevrons: false });
    if (kind === 'drill') {
      const d = drillParts('copper');
      p.addGeometry(d.body.clone()).addGeometry(tr(d.spinner, 0, DRILL.capTop, 0)).addGeometry(tr(d.bit, 0, DRILL.capBottom - 0.02, 0));
    } else if (kind === 'chest') {
      const c = chestParts();
      p.addGeometry(c.body.clone()).addGeometry(tr(c.lid, ...CHEST.hinge));
    } else if (kind === 'workshop') {
      const w = workshopParts();
      const glow = w.glow.clone();
      const col = glow.attributes.color, c = new THREE.Color(COL.glowOff);
      for (let i = 0; i < col.count; i++) col.setXYZ(i, c.r, c.g, c.b);
      p.addGeometry(w.body.clone()).addGeometry(tr(w.hammer, ...WORKSHOP.pivot)).addGeometry(tr(w.gear, ...WORKSHOP.gear)).addGeometry(glow);
    } else return null;
    return p.merge();
  });
}
export function miniModel(kind) {
  return once(`mini:${kind}`, () => {
    const g = kind === 'belt' ? beltWhole({ chevrons: true }) : wholeModel(kind);
    if (!g) return null;
    if (kind === 'belt') {
      const m = fitMini(g, { height: 1, width: 0.3 });
      m.scale(1, 1.6, 1); // a touch chunkier so it reads at item size
      return m;
    }
    return fitMini(g, { height: 0.24, width: 0.26 });
  });
}
