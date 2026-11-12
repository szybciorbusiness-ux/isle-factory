// Camp view geometry helpers: the shared colour set, boulders / logs / cloth, flame + ember + glow shapes,
// and nice fallback item meshes (meat, cooked meat, copper bar) until items.js has its own.
// Everything is built with the buildings toolkit (Parts: merged, vertex-coloured, one Lambert material).
import * as THREE from 'three';
import { Parts, rbox, puck, gear, jitter, rng } from '../buildings/geom.js';

export { Parts, rbox, puck, gear, jitter, rng };

// Same family as buildings/models.js COL (honey wood, cream stone, copper) plus camp extras.
// No near-black anywhere: the darkest tone is a soft cocoa.
export const C = {
  wood: '#d39556', woodDark: '#b0763f', woodLight: '#e9b778', bark: '#9b6334', endGrain: '#f0cf98',
  copper: '#ec9558', copperDark: '#c97445', copperLight: '#f8b27a',
  stone: '#f1e6cc', stoneShade: '#dfd0ad', stoneDark: '#c9b993', stoneWarm: '#e8d6b0',
  hole: '#8a6248', emberBed: '#a5583a', coal: '#f08a46', coalHot: '#ffc06a', coalDim: '#c4623c',
  roof: '#e07b4c', roofDark: '#c4643c', roofLight: '#f09a66',
  steel: '#ece8df', steelDark: '#cbc5b8',
  cloth: '#f08a24', clothCream: '#fff3dc', clothRed: '#e2574c', clothGold: '#f4c430',
  glass: '#ffe39a', stew: '#e3a05a',
  meat: '#ec8a7f', meatLight: '#f7b9ae', meatDark: '#cf6b62', bone: '#fff1d6', boneShade: '#ead7b4',
  cooked: '#c97a42', cookedDark: '#9f5a2e', cookedLight: '#e6a868',
  bar: '#e8894a', barLight: '#f9b97f', barDark: '#c26a3a',
  slate: '#7d8597', slateDeep: '#666d7e', rail: '#f2e6c8', stripe: '#f8cb55',
  leaf: '#4f9a4a', flowerO: '#f39a4a', flowerW: '#fff6e6',
};

const _v = new THREE.Vector3();

// A chunky faceted boulder (cream stone / ore), sitting with its base near pos.y.
export function boulder(p, pos, r, { seed = 1, color = C.stone, s = [1, 0.78, 1], shade = C.stoneShade, jit = 0.35, detail = 0 } = {}) {
  const g = jitter(new THREE.DodecahedronGeometry(r, detail), r * jit, seed);
  p.add(g, color, { p: pos, s, flat: true, jitter: 0.07, seed, faceColor: (cx, cy, cz, nx, ny) => (ny < -0.3 ? shade : null) });
  return p;
}

// A log (cylinder) from a to b with light end-grain caps.
export function log(p, a, b, r, { color = C.wood, ends = C.endGrain, seg = 8, seed = 3 } = {}) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const len = A.distanceTo(B), mid = A.clone().add(B).multiplyScalar(0.5);
  const axis = B.clone().sub(A).normalize();
  const g = new THREE.CylinderGeometry(r, r * 1.04, len, seg, 1);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
  g.applyQuaternion(q);
  p.add(g, color, {
    p: [mid.x, mid.y, mid.z], flat: true, jitter: 0.06, seed,
    faceColor: (cx, cy, cz, nx, ny, nz) => (Math.abs(_v.set(nx, ny, nz).dot(axis)) > 0.85 ? ends : null),
  });
  return p;
}

// A beam between two points (rounded box), for posts / poles / braces.
export function beam(p, a, b, w, color, { r = 0.025, d = w } = {}) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const len = A.distanceTo(B), mid = A.clone().add(B).multiplyScalar(0.5);
  const g = rbox(w, len, d, r, 2);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize()));
  p.add(g, color, { p: [mid.x, mid.y, mid.z] });
  return p;
}

// Triangular prism (gable ends): triangle in the XY plane (base w at y=0, apex h), depth d along z.
export function gable(w, h, d) {
  const s = new THREE.Shape();
  s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(0, h); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false });
  g.translate(0, 0, -d / 2);
  return g;
}

// ---------- fire shapes ----------
// A faceted flame tongue: unit height (base y=0, tip y=1), bulge radius 0.5. Vertex colours run from a warm
// cream core at the base to orange at the tip (the material is unlit, so these are the final colours).
export function flameGeometry() {
  const pts = [];
  const prof = [[0, 0], [0.32, 0.04], [0.48, 0.16], [0.5, 0.3], [0.44, 0.46], [0.3, 0.66], [0.15, 0.84], [0, 1]];
  for (const [r, y] of prof) pts.push(new THREE.Vector2(r, y));
  let g = new THREE.LatheGeometry(pts, 7);
  g = g.toNonIndexed();
  g.computeVertexNormals();
  const pos = g.attributes.position, n = pos.count, col = new Float32Array(n * 3);
  const c0 = new THREE.Color('#fff2b8'), c1 = new THREE.Color('#ffc458'), c2 = new THREE.Color('#ff8a3c'), c = new THREE.Color();
  for (let t = 0; t < n; t += 3) {
    const y = (pos.getY(t) + pos.getY(t + 1) + pos.getY(t + 2)) / 3;
    const k = Math.min(1, y / 0.95);
    if (k < 0.45) c.copy(c0).lerp(c1, k / 0.45); else c.copy(c1).lerp(c2, (k - 0.45) / 0.55);
    // faceted look: alternate faces a touch lighter
    const f = ((t / 3) % 2) ? 1 : 0.94;
    for (let v = t; v < t + 3; v++) { col[v * 3] = c.r * f; col[v * 3 + 1] = c.g * f; col[v * 3 + 2] = c.b * f; }
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

export function emberGeometry() {
  return new THREE.OctahedronGeometry(1, 0);
}

// Soft radial gradient (white centre -> transparent), for additive ground glows.
export function glowTexture(size = 128) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.62)');
  grd.addColorStop(0.55, 'rgba(255,255,255,0.22)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------- fallback items (origin at the bottom centre, lying flat, about the size of items.js items) ----------
function drumstick(p, meat, light, dark, bone, cooked) {
  // meaty end: a faceted, slightly squashed egg toward -x
  const egg = jitter(new THREE.SphereGeometry(0.085, 9, 6), 0.008, 4);
  p.add(egg, meat, {
    p: [-0.04, 0.072, 0], s: [1.38, 0.86, 1.05], flat: true, jitter: 0.05, seed: 5,
    faceColor: (cx, cy, cz, nx, ny) => (ny > 0.55 ? light : ny < -0.4 ? dark : null),
  });
  if (cooked) {
    // grill marks across the top
    for (const x of [-0.085, -0.035, 0.015]) p.add(rbox(0.018, 0.012, 0.13, 0.005), dark, { p: [x, 0.142, 0], r: [0, 0.35, 0], ao: false });
  } else {
    // a little fat marbling
    p.add(rbox(0.07, 0.01, 0.03, 0.005), light, { p: [-0.06, 0.143, 0.02], r: [0, 0.5, 0], ao: false });
  }
  // bone shaft + knuckle
  p.add(new THREE.CylinderGeometry(0.022, 0.027, 0.13, 7), bone, { p: [0.095, 0.064, 0], r: [0, 0, Math.PI / 2 - 0.12], flat: true });
  for (const z of [-0.022, 0.022]) p.add(new THREE.SphereGeometry(0.03, 7, 5), bone, { p: [0.165, 0.074, z], flat: true, faceColor: (cx, cy, cz, nx, ny) => (ny < -0.3 ? C.boneShade : null) });
}
export function fallbackItemGeometry(id) {
  const p = new Parts({ ao: { y0: 0, y1: 0.12, min: 0.82 } });
  if (id === 'meat') drumstick(p, C.meat, C.meatLight, C.meatDark, C.bone, false);
  else if (id === 'cookedMeat') drumstick(p, C.cooked, C.cookedLight, C.cookedDark, C.bone, true);
  else if (id === 'copperBar') {
    // classic ingot: a square frustum stretched long, light top, warm bevelled sides, embossed top plate
    const g = new THREE.CylinderGeometry(0.098, 0.13, 0.075, 4, 1);
    g.rotateY(Math.PI / 4);
    p.add(g, C.bar, {
      p: [0, 0.0375, 0], s: [1.45, 1, 0.78], flat: true,
      faceColor: (cx, cy, cz, nx, ny, nz) => (ny > 0.9 ? C.barLight : ny < -0.9 ? C.barDark : Math.abs(nx) > Math.abs(nz) ? C.barDark : null),
    });
    p.add(rbox(0.13, 0.008, 0.055, 0.004), '#fbcb98', { p: [0, 0.077, 0], ao: false });
  } else return null;
  return p.merge();
}
