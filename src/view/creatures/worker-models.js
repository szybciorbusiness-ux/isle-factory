// Worker geometry: small round villagers in work clothes with a role hat (lumberjack: red knit beanie, beard,
// plaid shirt and denim overalls, axe; hunter: green hood with a floppy tip, leather tunic and cape, club).
// Clearly not the player's ceramic robot: soft peach faces, rosy cheeks, cloth colours, a wooden carry rack.
// Parts (each one merged geometry, instanced for all workers of a role): body, head (+hat), arm, foot, tool,
// plus the shared snack (drumstick) and the hungry thought bubble.
// Local frame: front = +x, up = +y, right = +z; origin on the ground under the body centre.
import * as THREE from 'three';
import { Parts, ball, limb, stick, cone, lathe } from './kit.js';
import { EYE, EYE_HI } from './animal-models.js';

export const WLAYOUT = {
  scale: 1.1,
  headPivot: [0, 0.37, 0],
  shoulder: [0.0, 0.305, 0.138],
  armLen: 0.1,
  foot: [0, 0, 0.066],
  pack: [-0.205, 0.175, 0],     // bottom of the carried stack (on the rack shelf)
  centerY: 0.3, headTopY: 0.74,
  shadow: [0.42, 0.38],
  eye: { p: [0.128, 0.148, 0.052], r: 0.019, s: [0.7, 1.15, 0.85] },   // must match head() below (blink lids)
  lid: '#f6cba3',
};

const SKIN = '#f6cba3', CHEEK = '#f4a08c', NOSE = '#efaf8a', BOOT = '#5b3f2a', WOOD = '#b27b47', WOOD_D = '#8a5a32';
export const ROLE_COLORS = {
  lumberjack: { shirt: '#dc5a4b', plaid: '#b6443b', pants: '#5d7fb3', strap: '#5d7fb3', button: '#f7d36b', hat: '#e2574c', cuff: '#c4473d', pom: '#fff4e0', beard: '#8b5a36' },
  hunter: { shirt: '#bb8653', plaid: '#a87545', pants: '#7a6448', belt: '#5e4330', buckle: '#f2c14e', hat: '#4f8b4b', hatIn: '#3e7040', cape: '#4f8b4b' },
};

// Remove triangles whose centroid fails keep(cx, cy, cz) (geometry must be non-indexed).
function cut(geo, keep) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.attributes.position, nor = g.attributes.normal;
  const P = [], N = [];
  for (let t = 0; t < pos.count; t += 3) {
    const cx = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3, cy = (pos.getY(t) + pos.getY(t + 1) + pos.getY(t + 2)) / 3, cz = (pos.getZ(t) + pos.getZ(t + 1) + pos.getZ(t + 2)) / 3;
    if (!keep(cx, cy, cz)) continue;
    for (let v = t; v < t + 3; v++) { P.push(pos.getX(v), pos.getY(v), pos.getZ(v)); N.push(nor.getX(v), nor.getY(v), nor.getZ(v)); }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  return out;
}

const BODY_PROFILE = [[0, 0.05], [0.085, 0.054], [0.128, 0.078], [0.15, 0.12], [0.156, 0.175], [0.15, 0.24], [0.134, 0.3], [0.104, 0.352], [0.055, 0.382], [0, 0.39]];

function body(role, q) {
  const C = ROLE_COLORS[role];
  const p = new Parts({ ao: { y0: 0.04, y1: 0.24, min: 0.8 } });
  const seg = q.seg + 4;
  const ang = (cx, cz) => Math.atan2(cz, cx);
  let face;
  if (role === 'lumberjack') {
    face = (cx, cy, cz) => {
      const a = ang(cx, cz), ax = Math.abs(a);
      if (cy < 0.17) return C.pants;
      // bib on the front, straps over the shoulders (front and back)
      if (cy < 0.29 && ax < 0.62) return cy > 0.27 && Math.abs(Math.abs(cz) - 0.05) < 0.02 ? C.button : C.pants;
      if (Math.abs(Math.abs(cz) - 0.06) < 0.024 && cy < 0.37) return C.strap;
      const i = Math.floor((a + Math.PI) / ((Math.PI * 2) / seg)), j = Math.floor(cy / 0.034);
      return (i % 3 === 0) !== (j % 2 === 0) ? C.plaid : null;
    };
  } else {
    face = (cx, cy, cz) => {
      const a = ang(cx, cz), ax = Math.abs(a);
      if (cy < 0.15) return C.pants;
      if (cy < 0.185) return ax < 0.25 ? C.buckle : C.belt;
      if (ax > 2.2 && cy < 0.37) return C.cape;                 // cape down the back
      if (Math.abs(cz - (cy - 0.26) * 0.9) < 0.022 && cx > 0) return C.belt; // strap across the chest
      return null;
    };
  }
  p.add(lathe(BODY_PROFILE, seg), C.shirt, { flat: true, faceColor: face });
  // collar
  p.add(new THREE.TorusGeometry(0.07, 0.022, 5, 12), role === 'hunter' ? C.hat : C.shirt, { r: [Math.PI / 2, 0, 0], p: [0, 0.37, 0], flat: true, ao: false });
  // carry rack on the back: two uprights, shelf, top bar
  for (const s of [-1, 1]) p.add(stick(0.014, 0.013, 0.27, 5), WOOD_D, { p: [-0.168, 0.1, s * 0.058], flat: true });
  p.add(new THREE.BoxGeometry(0.075, 0.018, 0.15), WOOD, { p: [-0.195, 0.165, 0], flat: true });
  p.add(new THREE.CylinderGeometry(0.011, 0.011, 0.14, 5), WOOD, { r: [Math.PI / 2, 0, 0], p: [-0.168, 0.355, 0], flat: true, ao: false });
  return p.merge();
}

function head(role, q) {
  const C = ROLE_COLORS[role];
  const p = new Parts({ ao: false });
  const S = q.seg + 2;
  p.add(ball(0.145, S, S - 2), SKIN, { p: [0, 0.135, 0], flat: true });
  // face: eyes, cheeks, nose
  for (const s of [-1, 1]) {
    p.add(ball(0.019, 8, 6), EYE, { p: [0.128, 0.148, s * 0.052], s: [0.7, 1.15, 0.85] });
    p.add(ball(0.0065, 5, 4), EYE_HI, { p: [0.14, 0.156, s * 0.057] });
    p.add(ball(0.026, 8, 6), CHEEK, { p: [0.118, 0.103, s * 0.088], s: [0.5, 0.8, 1] });
  }
  p.add(ball(0.022, 8, 6), NOSE, { p: [0.147, 0.118, 0], flat: true });
  // ears
  for (const s of [-1, 1]) p.add(ball(0.03, 6, 5), SKIN, { p: [0.0, 0.13, s * 0.142], s: [0.8, 1, 0.55], flat: true });
  if (role === 'lumberjack') {
    // bushy beard under the nose, round knit beanie with a fold-up cuff and a pompom
    p.add(cut(ball(1, S, S - 2), (cx) => cx > -0.15), C.beard, { s: [0.085, 0.075, 0.118], p: [0.065, 0.065, 0], flat: true, jitter: 0.05, seed: 3 });
    p.add(ball(0.03, 6, 5), C.beard, { p: [0.14, 0.098, -0.022], s: [0.8, 0.6, 1.2], flat: true });
    p.add(ball(0.03, 6, 5), C.beard, { p: [0.14, 0.098, 0.022], s: [0.8, 0.6, 1.2], flat: true });
    p.add(new THREE.SphereGeometry(0.153, S + 2, 6, 0, Math.PI * 2, 0, 1.2), C.hat, { p: [-0.008, 0.152, 0], r: [0, 0, 0.16], flat: true,
      faceColor: (cx, cy, cz) => (Math.floor((Math.atan2(cz, cx) + Math.PI) / (Math.PI / 7)) % 2 ? null : C.cuff) });
    p.add(new THREE.TorusGeometry(0.142, 0.03, 6, S + 4).rotateX(Math.PI / 2), C.cuff, { r: [0, 0, 0.16], p: [-0.017, 0.206, 0], flat: true });
    p.add(ball(0.045, 8, 6), C.pom, { p: [-0.036, 0.318, 0], flat: true, jitter: 0.06 });
  } else {
    // a green hood around the face with a floppy pointed tip down the back
    const hood = cut(ball(0.162, S + 2, S), (cx, cy, cz) => {
      const l = Math.hypot(cx, cy, cz) || 1;
      const nx = cx / l, ny = cy / l;
      if (ny < -0.42) return false;                 // open at the neck
      return !(nx > 0.38 && ny < 0.52);             // face opening
    });
    p.add(hood, C.hat, { p: [-0.01, 0.142, 0], flat: true, faceColor: (cx, cy, cz, nx) => (nx > 0.3 ? C.hatIn : null) });
    p.add(cone(0.075, 0.17, 6), C.hat, { r: [0, 0, 2.05], p: [-0.12, 0.22, 0], flat: true });
    p.add(ball(0.03, 6, 4), C.hat, { p: [-0.27, 0.15, 0], flat: true });
  }
  return p.merge();
}

function arm(role) {
  const C = ROLE_COLORS[role];
  const p = new Parts({ ao: false });
  p.add(limb(0.04, 0.032, 0.075, 7), role === 'lumberjack' ? C.shirt : C.shirt, { flat: true, faceColor: role === 'lumberjack' ? (cx, cy) => (Math.floor(-cy / 0.03) % 2 ? C.plaid : null) : null });
  p.add(ball(0.037, 8, 6), SKIN, { p: [0, -0.1, 0], flat: true });
  return p.merge();
}

function foot() {
  const p = new Parts({ ao: false });
  p.add(ball(1, 8, 6), BOOT, { s: [0.056, 0.036, 0.042], p: [0.014, 0.03, 0], flat: true, faceColor: (cx, cy, cz, nx, ny) => (ny < -0.5 ? '#46301f' : null) });
  return p.merge();
}

// Tools hang along -y from the grip (y = 0) in tool space; the head's working side faces +x (swing direction).
function axe() {
  const p = new Parts({ ao: false });
  p.add(limb(0.016, 0.019, 0.27, 6), '#9b6334', { p: [0, 0.045, 0], flat: true });
  p.add(new THREE.BoxGeometry(0.03, 0.065, 0.036), '#e48b4f', { p: [0, -0.2, 0], flat: true });
  // blade: a chunky wedge toward +x
  const blade = new THREE.CylinderGeometry(0.06, 0.06, 0.022, 3, 1, false, Math.PI / 6, Math.PI * 2);
  p.add(blade, '#d3dbe0', { r: [Math.PI / 2, 0, 0], s: [1, 1, 1], p: [0.045, -0.2, 0], flat: true, faceColor: (cx, cy, cz, nx) => (nx > 0.7 ? '#f3f6f7' : null) });
  p.add(new THREE.BoxGeometry(0.028, 0.05, 0.03), '#9aa4ae', { p: [-0.026, -0.2, 0], flat: true });
  return p.merge();
}
function club() {
  const p = new Parts({ ao: false });
  p.add(limb(0.021, 0.048, 0.25, 7), '#ad7340', { p: [0, 0.04, 0], flat: true, jitter: 0.05, seed: 4 });
  p.add(ball(0.05, 8, 6), '#ad7340', { p: [0, -0.205, 0], flat: true });
  for (const [x, y, z] of [[0.04, -0.15, 0.02], [-0.03, -0.18, -0.035], [0.02, -0.22, -0.03]]) p.add(ball(0.017, 5, 4), '#8b5a2e', { p: [x, y, z], flat: true });
  p.add(limb(0.025, 0.025, 0.05, 7), '#6b4a30', { p: [0, 0.03, 0], flat: true });
  return p.merge();
}
// Drumstick along +x: meat end at +x, bone knobs at -x. Origin at the bone's grip.
export function drumstick(p = new Parts({ ao: false }), o = {}) {
  const T = (x, y, z) => { const v = new THREE.Vector3(x, y, z).applyEuler(new THREE.Euler(...(o.r || [0, 0, 0]))).multiplyScalar(o.s || 1); return [v.x + (o.p?.[0] || 0), v.y + (o.p?.[1] || 0), v.z + (o.p?.[2] || 0)]; };
  const R = o.r || [0, 0, 0], s = o.s || 1;
  p.add(ball(1, 9, 7), '#c3713d', { s: [0.072 * s, 0.056 * s, 0.056 * s], r: R, p: T(0.06, 0, 0), flat: true, faceColor: (cx, cy, cz, nx, ny) => (ny > 0.55 ? '#dc8b52' : null) });
  p.add(new THREE.CylinderGeometry(0.014 * s, 0.016 * s, 0.07 * s, 6), '#fbf0dc', { r: [R[0], R[1], R[2] + Math.PI / 2], p: T(-0.02, 0, 0), flat: true });
  for (const zz of [-1, 1]) p.add(ball(0.019 * s, 6, 5), '#fbf0dc', { p: T(-0.058, 0, zz * 0.013), flat: true });
  return p;
}

// Thought bubble in billboard space (x right, y up, +z toward the camera): a puffy cloud with two trailing
// dots toward the head (down-left) and a drumstick inside.
function bubble() {
  const p = new Parts({ ao: false });
  const W = '#fffaf0', E = '#efe6d6';
  const fz = 0.45;
  p.add(ball(0.13, 12, 8), W, { s: [1.25, 1, fz], p: [0, 0, 0], faceColor: (cx, cy) => (cy < -0.09 ? E : null) });
  for (const [x, y, r] of [[-0.11, 0.04, 0.085], [0.1, 0.05, 0.09], [0.01, 0.095, 0.09], [-0.05, -0.07, 0.07], [0.07, -0.065, 0.07]]) p.add(ball(r, 10, 7), W, { s: [1, 1, fz], p: [x, y, 0], faceColor: (cx, cy) => (cy < -0.1 ? E : null) });
  p.add(ball(0.04, 8, 6), W, { s: [1, 1, fz], p: [-0.13, -0.16, 0] });
  p.add(ball(0.024, 8, 6), W, { s: [1, 1, fz], p: [-0.17, -0.215, 0] });
  drumstick(p, { r: [0, 0, 0.75], s: 1.15, p: [-0.005, -0.005, 0.07] });
  return p.merge();
}
function snack() {
  return drumstick(new Parts({ ao: false }), { r: [0, 0, 0], s: 1.35, p: [0.0, 0, 0] }).merge();
}

export function buildWorkerGeometries(q = { seg: 10 }) {
  const out = { foot: foot(), axe: axe().scale(1.22, 1.22, 1.22), club: club().scale(1.15, 1.15, 1.15), bubble: bubble(), snack: snack() };
  for (const role of ['lumberjack', 'hunter']) {
    out[`${role}.body`] = body(role, q);
    out[`${role}.head`] = head(role, q);
    out[`${role}.arm`] = arm(role);
  }
  return out;
}
