// Animal geometry: deer, boar and rabbit, each split into the few parts that move on their own (body, head,
// ear, leg/foot, tail). Every part is one merged vertex-coloured geometry, drawn for all animals of the species
// by a single InstancedMesh. Local frame: front = +x, up = +y, right = +z; origin on the ground under the body.
// Part geometries are authored in their pivot's space (legs hang from the hip, ears/tails grow from their base).
import * as THREE from 'three';
import { Parts, ball, limb, stick, cone, capsule } from './kit.js';

export const EYE = '#2f241e', EYE_HI = '#fffaf0';

// Rig layout per species (model units; the root is scaled by `scale`).
export const LAYOUT = {
  deer: {
    scale: 1.1,
    hipY: 0.27, legLen: 0.27, legX: [0.12, -0.12], legZ: 0.056,
    head: [0.165, 0.41, 0], ear: [0.05, 0.24, 0.064], tail: [-0.2, 0.405, 0],
    centerY: 0.36, headTopY: 0.72, length: 0.55, shadow: [0.62, 0.34],
    earRest: { x: 1.05, z: 0.35 }, tailRest: 0,
    eye: { p: [0.124, 0.2, 0.068], r: 0.022, s: [0.8, 1.05, 0.7] }, lid: '#cf8a4f',
  },
  boar: {
    scale: 1.0,
    hipY: 0.135, legLen: 0.135, legX: [0.12, -0.12], legZ: 0.085,
    head: [0.19, 0.27, 0], ear: [0.035, 0.088, 0.062], tail: [-0.245, 0.29, 0],
    centerY: 0.26, headTopY: 0.46, length: 0.62, shadow: [0.66, 0.46],
    earRest: { x: 0.55, z: 0.25 }, tailRest: 0,
    eye: { p: [0.13, 0.035, 0.07], r: 0.017, s: [0.8, 1.05, 0.7] }, lid: '#7d5239',
  },
  rabbit: {
    scale: 1.3, tiltPivot: -0.08,
    feet: [-0.05, 0.036, 0.052],
    head: [0.065, 0.17, 0], ear: [0.005, 0.088, 0.026],
    centerY: 0.12, headTopY: 0.42, length: 0.3, shadow: [0.36, 0.28],
    earRest: { x: 0.14, z: 0.3 }, tailRest: 0,
    eye: { p: [0.068, 0.056, 0.05], r: 0.015, s: [0.8, 1.05, 0.7] }, lid: '#ede1cf',
  },
};

// Eyes are merged into the head; a blink draws a coat-coloured lid over each one (LAYOUT[kind].eye must match
// the eyes() call in the head below, see lidGeometry()).
const eyes = (p, x, y, z, r) => {
  for (const s of [-1, 1]) {
    p.add(ball(r, 8, 6), EYE, { p: [x, y, s * z], s: [0.8, 1.05, 0.7], ao: false });
    p.add(ball(r * 0.36, 6, 4), EYE_HI, { p: [x + r * 0.45, y + r * 0.4, s * (z + r * 0.35)], ao: false });
  }
};

function deer(q) {
  const C = { coat: '#cf8a4f', back: '#b9733e', cream: '#f6e6c8', muzzle: '#f2dcba', nose: '#3d2a22', hoof: '#4a3328', antler: '#ecd6a8', pink: '#f0b6a6', tailW: '#fdf8ee' };
  const S = q.seg;
  const coatFace = (cx, cy, cz, nx, ny) => (ny < -0.5 ? C.cream : ny > 0.82 ? C.back : null);
  const body = new Parts({ ao: { y0: 0.24, y1: 0.42, min: 0.82 } });
  body.add(ball(1, S, S - 2), C.coat, { s: [0.2, 0.108, 0.1], p: [0, 0.355, 0], flat: true, faceColor: coatFace });
  body.add(ball(1, S, S - 2), C.coat, { s: [0.1, 0.105, 0.094], p: [0.1, 0.37, 0], flat: true, faceColor: coatFace });
  body.add(ball(1, S, S - 2), C.coat, { s: [0.1, 0.1, 0.098], p: [-0.115, 0.36, 0], flat: true, faceColor: coatFace });
  // fawn spots on the back
  for (const [x, z] of [[0.03, 0.045], [-0.06, -0.04], [-0.1, 0.045], [0.08, -0.035]]) {
    const y = 0.355 + 0.108 * Math.sqrt(Math.max(0, 1 - (x / 0.2) ** 2 - (z / 0.1) ** 2)) - 0.004;
    body.add(ball(0.024, 6, 4), C.cream, { p: [x, y, z], s: [1.2, 0.45, 1], ao: false });
  }
  // little haunches over the hind legs
  for (const s of [-1, 1]) body.add(ball(1, 8, 6), C.coat, { s: [0.075, 0.08, 0.035], p: [-0.12, 0.32, s * 0.06], flat: true, faceColor: coatFace });

  const head = new Parts({ ao: false });
  head.add(stick(0.052, 0.04, 0.18, S - 2), C.coat, { r: [0, 0, -0.42], p: [0, -0.01, 0], flat: true, faceColor: (cx, cy, cz, nx) => (nx > 0.55 ? C.cream : null) });
  head.add(ball(1, S, S - 2), C.coat, { s: [0.098, 0.09, 0.084], p: [0.085, 0.182, 0], flat: true });
  head.add(ball(1, S - 2, S - 4), C.muzzle, { s: [0.062, 0.05, 0.054], p: [0.158, 0.152, 0], flat: true });
  head.add(ball(0.022, 8, 6), C.nose, { p: [0.216, 0.164, 0], s: [0.8, 0.85, 1.15] });
  eyes(head, 0.124, 0.2, 0.068, 0.022);
  for (const s of [-1, 1]) {
    head.add(stick(0.013, 0.009, 0.09, 5), C.antler, { r: [s * 0.32, 0, 0.3], p: [0.065, 0.236, s * 0.032] });
    head.add(stick(0.009, 0.007, 0.042, 5), C.antler, { r: [s * 0.3, 0, -0.75], p: [0.055, 0.28, s * 0.045] });
    head.add(ball(0.011, 6, 4), C.antler, { p: [0.04, 0.32, s * 0.058] });
  }

  const ear = new Parts({ ao: false });
  ear.add(ball(1, 8, 6), C.coat, { s: [0.022, 0.07, 0.038], p: [0, 0.062, 0], flat: true, faceColor: (cx, cy, cz, nx) => (nx > 0.35 ? C.pink : null) });

  const leg = new Parts({ ao: { y0: -0.27, y1: -0.05, min: 0.8 } });
  leg.add(limb(0.034, 0.019, 0.235, 6), C.coat, { flat: true });
  leg.add(limb(0.02, 0.023, 0.04, 6), C.hoof, { p: [0, -0.23, 0], flat: true });

  const tail = new Parts({ ao: false });
  tail.add(ball(1, 8, 6), C.tailW, { s: [0.045, 0.03, 0.03], r: [0, 0, 0.55], p: [-0.03, 0.022, 0], flat: true, faceColor: (cx, cy, cz, nx, ny) => (ny > 0.55 && nx < 0.3 ? C.coat : null) });
  return { body: body.merge(), head: head.merge(), ear: ear.merge(), leg: leg.merge(), tail: tail.merge() };
}

function boar(q) {
  const C = { coat: '#7d5239', back: '#674230', belly: '#a0714f', mane: '#4a2f22', snout: '#e9a58f', snoutEnd: '#d98d7c', nostril: '#5a3530', tusk: '#fbf3df', hoof: '#3f2a20', inner: '#c98b79' };
  const S = q.seg;
  const coatFace = (cx, cy, cz, nx, ny) => (ny < -0.45 ? C.belly : ny > 0.75 ? C.back : null);
  const body = new Parts({ ao: { y0: 0.1, y1: 0.36, min: 0.8 } });
  body.add(ball(1, S, S - 2), C.coat, { s: [0.24, 0.165, 0.158], p: [-0.01, 0.255, 0], flat: true, jitter: 0.04, seed: 5, faceColor: coatFace });
  // bristly ridge along the spine
  for (let i = 0; i < 8; i++) {
    const x = 0.16 - i * 0.042, zz = (i % 2 ? 1 : -1) * 0.014;
    const top = 0.255 + 0.165 * Math.sqrt(Math.max(0, 1 - ((x + 0.01) / 0.24) ** 2)) - 0.018;
    const h = 0.06 + (i > 1 && i < 6 ? 0.02 : 0);
    body.add(cone(0.024, h, 4), C.mane, { p: [x, top, zz], r: [zz * 6, 0, 0.55], flat: true });
  }
  const head = new Parts({ ao: { y0: -0.12, y1: 0.06, min: 0.82 } });
  head.add(ball(1, S, S - 2), C.coat, { s: [0.115, 0.108, 0.112], p: [0.055, -0.005, 0], flat: true, jitter: 0.04, seed: 9, faceColor: (cx, cy, cz, nx, ny) => (ny > 0.7 ? C.back : null) });
  head.add(new THREE.CylinderGeometry(0.052, 0.06, 0.07, 10), C.snout, { r: [0, 0, -Math.PI / 2], p: [0.165, -0.035, 0], flat: true, faceColor: (cx, cy, cz, nx) => (nx > 0.8 ? C.snoutEnd : null) });
  for (const s of [-1, 1]) {
    head.add(ball(0.011, 6, 4), C.nostril, { p: [0.2, -0.03, s * 0.019], s: [0.5, 1.2, 1] });
    head.add(cone(0.018, 0.08, 5), C.tusk, { r: [s * 0.55, 0, -0.3], p: [0.15, -0.08, s * 0.055] });
  }
  eyes(head, 0.13, 0.035, 0.07, 0.017);
  const ear = new Parts({ ao: false });
  ear.add(cone(0.044, 0.085, 4), C.coat, { s: [0.55, 1, 1], p: [0, 0, 0], flat: true, faceColor: (cx, cy, cz, nx) => (nx > 0.4 ? C.inner : null) });
  const leg = new Parts({ ao: { y0: -0.13, y1: -0.02, min: 0.82 } });
  leg.add(limb(0.042, 0.033, 0.105, 6), C.coat, { flat: true });
  leg.add(limb(0.034, 0.036, 0.035, 6), C.hoof, { p: [0, -0.1, 0], flat: true });
  const tail = new Parts({ ao: false });
  tail.add(new THREE.TorusGeometry(0.026, 0.009, 4, 9, Math.PI * 1.6), C.coat, { p: [-0.026, 0.006, 0], r: [0, 0, 0.6], flat: true });
  return { body: body.merge(), head: head.merge(), ear: ear.merge(), leg: leg.merge(), tail: tail.merge() };
}

function rabbit(q) {
  const C = { fur: '#ede1cf', belly: '#fffaf1', inner: '#f4b5ae', nose: '#ee8d8a', tip: '#c9b195', cheek: '#fffaf1' };
  const S = q.seg;
  const body = new Parts({ ao: { y0: 0, y1: 0.18, min: 0.84 } });
  body.add(ball(1, S, S - 2), C.fur, { s: [0.115, 0.104, 0.1], r: [0, 0, 0.28], p: [-0.012, 0.112, 0], flat: true, faceColor: (cx, cy, cz, nx, ny) => (nx > 0.55 && ny < 0.2 ? C.belly : null) });
  for (const s of [-1, 1]) body.add(ball(1, 8, 6), C.fur, { s: [0.06, 0.055, 0.034], p: [-0.05, 0.072, s * 0.062], flat: true });
  body.add(ball(0.046, 8, 6), C.belly, { p: [-0.122, 0.118, 0], flat: true });
  for (const s of [-1, 1]) body.add(ball(1, 6, 4), C.belly, { s: [0.03, 0.022, 0.022], p: [0.075, 0.022, s * 0.034] });
  const head = new Parts({ ao: false });
  head.add(ball(1, S, S - 2), C.fur, { s: [0.075, 0.069, 0.071], p: [0.025, 0.036, 0], flat: true });
  for (const s of [-1, 1]) head.add(ball(0.03, 8, 6), C.cheek, { p: [0.07, 0.015, s * 0.03], flat: true });
  head.add(ball(0.013, 6, 4), C.nose, { p: [0.1, 0.033, 0] });
  eyes(head, 0.068, 0.056, 0.05, 0.015);
  const ear = new Parts({ ao: false });
  ear.add(capsule(0.032, 0.13, 3, 7), C.fur, { s: [0.55, 1, 1], p: [0, 0.092, 0], flat: true, faceColor: (cx, cy, cz, nx, ny) => (cy > 0.17 ? C.tip : nx > 0.45 ? C.inner : null) });
  const foot = new Parts({ ao: false });
  foot.add(ball(1, 8, 6), C.fur, { s: [0.062, 0.024, 0.03], p: [0.022, -0.012, 0], flat: true, faceColor: (cx, cy, cz, nx, ny) => (ny < -0.4 ? C.belly : null) });
  return { body: body.merge(), head: head.merge(), ear: ear.merge(), foot: foot.merge() };
}

// Eyelid: one small white ball shared by every species and role (tinted per instance with the coat or skin
// colour, see kit.js lidMatrix). Its lower rim is darker so a closed lid reads as a little lash line.
export function lidGeometry() {
  return new Parts({ ao: false }).add(ball(1, 8, 6), '#ffffff', { flat: true, faceColor: (cx, cy) => (cy < -0.5 ? '#9a9088' : null) }).merge();
}

// q: { seg } (sphere segments; lower on mobile)
export function buildAnimalGeometries(q = { seg: 10 }) {
  return { deer: deer(q), boar: boar(q), rabbit: rabbit(q) };
}
