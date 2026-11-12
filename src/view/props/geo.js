// Procedural low-poly geometry for the resource props (trees, rocks, stumps, deposit nuggets).
// Everything is non-indexed with one colour per face (vertex colours), so flatShading + Lambert gives
// the faceted painted look of the reference. Geometry origin = the prop's base centre on the ground.
import * as THREE from 'three';
import { mulberry32 } from '../../util/noise.js';

const C = hex => new THREE.Color(hex);
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _n = new THREE.Vector3(), _m = new THREE.Vector3(), _col = new THREE.Color();
const _vc = new THREE.Color(), _vn = new THREE.Vector3(), _r = new THREE.Vector3();

// Collects triangles. `shade(centroid, faceNormal, out)` picks one colour per face; the optional
// `vert(p, faceNormal, faceColour, outColour, outNormal)` overrides colour and normal per vertex (used by the
// trees for a smooth vertical gradient and soft, rounded normals).
class Builder {
  constructor() { this.pos = []; this.col = []; this.nrm = []; }
  tri(a, b, c, shade, vert) {
    _a.fromArray(a); _b.fromArray(b); _c.fromArray(c);
    _n.subVectors(_c, _b).cross(_m.subVectors(_a, _b)).normalize();
    _m.copy(_a).add(_b).add(_c).multiplyScalar(1 / 3);
    shade(_m, _n, _col);
    for (const p of [a, b, c]) {
      this.pos.push(p[0], p[1], p[2]);
      if (vert) {
        vert(p, _n, _col, _vc, _vn);
        this.col.push(_vc.r, _vc.g, _vc.b); this.nrm.push(_vn.x, _vn.y, _vn.z);
      } else {
        this.col.push(_col.r, _col.g, _col.b); this.nrm.push(_n.x, _n.y, _n.z);
      }
    }
  }
  quad(a, b, c, d, shade, vert) { this.tri(a, b, c, shade, vert); this.tri(a, c, d, shade, vert); }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.computeBoundingSphere();
    return g;
  }
}

const key = (x, y, z) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;

// Unit icosahedron (detail 1) with its 12 five-valent corners pushed out into leafy spikes.
// Returns an array of triangles [[x,y,z]x3] in local space (radius ~1).
function spikyBall(rng, { spike = 1.38, spikeVar = 0.18, body = 0.95, droop = 0.22, detail = 1 } = {}) {
  const src = new THREE.IcosahedronGeometry(1, detail).getAttribute('position');
  const valence = new Map();
  for (let i = 0; i < src.count; i++) { const k = key(src.getX(i), src.getY(i), src.getZ(i)); valence.set(k, (valence.get(k) || 0) + 1); }
  const disp = new Map();
  for (const [k, v] of valence) {
    const isSpike = v === 5 && detail > 0;
    disp.set(k, isSpike ? spike + (rng() - 0.5) * 2 * spikeVar : body + (rng() - 0.5) * 0.12);
  }
  const tris = [];
  for (let i = 0; i < src.count; i += 3) {
    const t = [];
    for (let j = 0; j < 3; j++) {
      const x = src.getX(i + j), y = src.getY(i + j), z = src.getZ(i + j);
      const k = key(x, y, z), r = disp.get(k), sp = valence.get(k) === 5 && detail > 0;
      // spikes droop a little so the clump reads like hanging leaves
      t.push([x * r, y * r - (sp ? droop * (1 - Math.abs(y)) : 0), z * r]);
    }
    tris.push(t);
  }
  return tris;
}

// ---------------- Trees ----------------
// The reference tree: ONE fluffy rounded cone on a short visible trunk. The crown is a continuous cone
// built from a few overlapping leaf bands (like shingles): each band's lower lip is a ring of small
// drooping leaf teeth, so the outline is leafy and jagged while the surface stays calm. Band radii follow
// one smooth profile (so it never reads as stacked separate cones) with a few big soft lumps around it.
// Colours are per vertex: a smooth vertical gradient (deep green base -> light top), a soft occlusion
// just under each overhanging lip and nothing else. Normals are bent toward a rounded volume, so the
// crown reads as a few large soft planes.
//   base / tip: y of the lowest lip and of the tip; R: widest radius, at fraction `w` of the crown height;
//   b0: bottom-lip radius as a fraction of R; bands: leaf bands; lumps: big soft bulges around the cone.
const TREE_LAYOUTS = [
  // 0: the reference cone
  { trunkTop: 0.92, base: 0.64, tip: 2.18, R: 0.54, w: 0.26, b0: 0.7, bands: 5, lumps: 3, shoulder: 0.88 },
  // 1: lower, rounder bush
  { trunkTop: 0.86, base: 0.6, tip: 1.98, R: 0.56, w: 0.3, b0: 0.72, bands: 4, lumps: 4, shoulder: 1.05 },
  // 2: tall slim cone
  { trunkTop: 0.98, base: 0.68, tip: 2.3, R: 0.5, w: 0.24, b0: 0.7, bands: 6, lumps: 3, shoulder: 0.82 },
  // 3: wide, slightly leaning bush
  { trunkTop: 0.9, base: 0.62, tip: 2.1, R: 0.56, w: 0.28, b0: 0.7, bands: 5, lumps: 2, shoulder: 0.95, lean: 0.06 },
];

// albedo (pre-light) gradient stops, bottom -> top
const LEAF = { base: C('#2f6233'), low: C('#3a7a3d'), mid: C('#4b9245'), high: C('#64aa4e'), top: C('#8cc860') };
const BARK = { dark: C('#4c2516'), mid: C('#6c361f'), light: C('#84462a') };

function leafGradient(h, out) {
  if (h < 0.3) return out.copy(LEAF.base).lerp(LEAF.low, h / 0.3);
  if (h < 0.6) return out.copy(LEAF.low).lerp(LEAF.mid, (h - 0.3) / 0.3);
  if (h < 0.86) return out.copy(LEAF.mid).lerp(LEAF.high, (h - 0.6) / 0.26);
  return out.copy(LEAF.high).lerp(LEAF.top, (h - 0.86) / 0.14);
}

// lod 'mobile' (phones, ~370 tris instead of ~700): bigger leaf teeth, a 6-sided trunk, and only the faces the
// high camera can see (the hidden caps inside the crown and the undersides of the upper lips are dropped; the
// bottom lip keeps its underside so a felled crown never shows its inside). It also appends a ~100-tri SHADOW
// PROXY (the crown's rounded cone + trunk, closed) after the visible triangles: userData.mainRange and
// shadowRange are vertex ranges for geometry.drawRange, so the same instanced mesh draws the detailed crown in
// the main pass and only the cheap proxy into the shadow map (props.js swaps the range in onBeforeShadow).
export const TREE_MOBILE_TRIS = 390;   // visible triangles per phone tree (the shadow proxy comes on top)
export function buildTree(variant, seed = 11, { lod = 'full' } = {}) {
  if (lod !== 'mobile') return buildTreeAt(variant, seed, lod, 0.22);
  // phones: the finest leaf-tooth spacing that stays within the triangle budget
  let g = null;
  for (let sp = 0.28; sp < 0.5; sp += 0.015) {
    g?.dispose();
    g = buildTreeAt(variant, seed, lod, sp);
    if (g.userData.mainRange[1] / 3 <= TREE_MOBILE_TRIS) break;
  }
  return g;
}
function buildTreeAt(variant, seed, lod, toothSpacing) {
  const L = TREE_LAYOUTS[variant % TREE_LAYOUTS.length];
  const rng = mulberry32(seed * 131 + variant * 977 + 5);
  const b = new Builder();
  const lite = lod === 'mobile';

  // ---- trunk: tapered hexagonal post + root flares (flat faceted bark, warm red-brown like the reference) ----
  const seg = lite ? 6 : 7, rb = 0.16, rt = 0.095, th = L.trunkTop;
  const barkShade = (cen, n, out) => {
    out.copy(BARK.mid).lerp(BARK.dark, THREE.MathUtils.clamp(0.45 - cen.y * 1.2, 0, 1));
    if (n.y > 0.4) out.lerp(BARK.light, 0.35);
    out.multiplyScalar(0.96 + rng() * 0.08);
  };
  const pAt = (a, r, y) => [Math.cos(a) * r, y, Math.sin(a) * r];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const ym = 0.22;
    b.quad(pAt(a0, rb, -0.02), pAt(a0, rb * 0.9, ym), pAt(a1, rb * 0.9, ym), pAt(a1, rb, -0.02), barkShade);
    b.quad(pAt(a0, rb * 0.9, ym), pAt(a0, rt, th), pAt(a1, rt, th), pAt(a1, rb * 0.9, ym), barkShade);
  }
  const roots = 4, r0 = rng() * Math.PI;
  for (let i = 0; i < roots; i++) {
    const a = r0 + (i / roots) * Math.PI * 2 + (rng() - 0.5) * 0.6, len = 0.07 + rng() * 0.05, w = 0.06;
    const dx = Math.cos(a), dz = Math.sin(a), px = -dz, pz = dx;
    const base = [dx * rb * 0.6, 0, dz * rb * 0.6];
    const tip = [dx * (rb + len), -0.01, dz * (rb + len)];
    const up = [dx * rb * 0.92, 0.16 + rng() * 0.06, dz * rb * 0.92];
    const l = [base[0] + px * w, -0.01, base[2] + pz * w], r = [base[0] - px * w, -0.01, base[2] - pz * w];
    b.tri(up, l, tip, barkShade); b.tri(up, tip, r, barkShade);
  }

  // ---- crown ----
  const y0 = L.base, y1 = L.tip, H = y1 - y0, R = L.R;
  const lean = L.lean || 0, leanA = rng() * Math.PI * 2;
  const shape = u => { // radius fraction along the crown height
    if (u <= L.w) return L.b0 + (1 - L.b0) * Math.sin((u / L.w) * Math.PI / 2);
    const s = (u - L.w) / (1 - L.w);
    return Math.max(0, 1 - Math.pow(s, L.shoulder));
  };
  // a few big soft lumps around the cone (low angular frequency), different per band height
  const lumpPh = Array.from({ length: 3 }, () => rng() * Math.PI * 2);
  const lumpAmp = 0.05 + (L.lumps || 0) * 0.012;
  const lumpAt = (a, u) => 1
    + lumpAmp * Math.sin(a * (L.lumps || 3) + lumpPh[0] + u * 2.2)
    + lumpAmp * 0.5 * Math.sin(a * 2 + lumpPh[1] - u * 3.1);
  const centre = u => [Math.cos(leanA) * lean * u * u, Math.sin(leanA) * lean * u * u]; // gentle lean toward the top
  const radiusAt = (a, u) => R * shape(u) * lumpAt(a, u);
  const ring = (u, rf, ny, phase, jit = 0) => {
    const [cx, cz] = centre(u), y = y0 + u * H;
    return Array.from({ length: ny }, (_, k) => {
      const a = phase + (k / ny) * Math.PI * 2;
      const r = radiusAt(a, u) * rf * (1 + (rng() - 0.5) * jit);
      return [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
    });
  };

  // vertex colour + normal: global gradient, a soft occlusion under the band above, rounded-volume normals
  let band = { uLip: 0, uTop: 1 };
  const cY = y0 + H * 0.3;
  const flatShade = (cen, n, out) => out.setRGB(1, 1, 1);
  const vert = (p, fn, fc, oc, on) => {
    const gh = THREE.MathUtils.clamp((p[1] - y0 + 0.08) / (H + 0.08), 0, 1);
    leafGradient(gh, oc);
    // 0 at this band's lip -> 1 where the next band overhangs it: soft shade there (the layered look)
    const k = THREE.MathUtils.clamp((p[1] - (y0 + band.uLip * H)) / Math.max(0.05, (band.uTop - band.uLip) * H), 0, 1);
    oc.multiplyScalar(1.07 - 0.3 * Math.pow(k, 1.6));
    const u = THREE.MathUtils.clamp((p[1] - y0) / H, 0, 1), [cx, cz] = centre(u);
    _r.set(p[0] - cx, (p[1] - cY) * 0.62 + 0.12, p[2] - cz).normalize();
    on.copy(fn).multiplyScalar(0.3).addScaledVector(_r, 0.7).normalize();
  };

  const nb = L.bands;
  const lips = Array.from({ length: nb }, (_, i) => (i / nb) * 0.84 * (1 + (i ? (rng() - 0.5) * 0.06 : 0)));
  for (let i = 0; i < nb; i++) {
    const uLip = lips[i];
    const last = i === nb - 1;
    const uTop = last ? 1 : lips[i + 1];
    band = { uLip, uTop };
    const rLip = R * shape(uLip);
    // leaf teeth: about one per 0.22 of rim length (0.28 on phones), at least 8 / 6 (bold leaf clumps)
    const n = Math.max(lite ? 6 : 8, Math.round((Math.PI * 2 * rLip) / toothSpacing));
    const N = n * 2, phase = rng() * Math.PI * 2;
    const droop = 0.06 + rLip * 0.08;
    const [cx, cz] = centre(uLip);
    const rim = [];
    for (let k = 0; k < N; k++) {
      const a = phase + (k / N) * Math.PI * 2 + (rng() - 0.5) * (Math.PI / N) * 0.9;
      const tooth = k % 2 === 0;
      const big = rng();
      const r = radiusAt(a, uLip) * (tooth ? 1.07 + big * 0.15 : 0.83 + rng() * 0.04);
      const y = y0 + uLip * H + (tooth ? -droop * (0.6 + big * 0.7) : 0.03 + rng() * 0.03);
      rim.push([cx + Math.cos(a) * r, y, cz + Math.sin(a) * r]);
    }
    // body of the band: a bulging ring 40% up, then a ring tucked under the next lip (or the tip)
    const um = uLip + (uTop - uLip) * 0.42;
    const mid = ring(um, 1.02, N, phase, 0.03).map((p, k) => { p[1] += (k % 2 ? 0.01 : -0.01); return p; });
    const topR = last ? null : ring(uTop + 0.02, 0.8, N, phase, 0);
    const tip = last ? [centre(1)[0], y1, centre(1)[1]] : null;
    for (let k = 0; k < N; k++) {
      const j = (k + 1) % N;
      b.quad(rim[k], mid[k], mid[j], rim[j], flatShade, vert);
      if (last) b.tri(tip, mid[j], mid[k], flatShade, vert);
      else b.quad(mid[k], topR[k], topR[j], mid[j], flatShade, vert);
    }
    if (!last && !lite) { // cap hidden inside the next band (keeps the shadow solid; phones use the proxy)
      const c = [centre(uTop)[0], y0 + (uTop + 0.03) * H, centre(uTop)[1]];
      for (let k = 0; k < N; k++) b.tri(c, topR[(k + 1) % N], topR[k], flatShade, vert);
    }
    // underside of each lip, so nothing is see-through from low angles (phones: the bottom lip only; the
    // upper ones are tucked over the band below and never face the camera)
    if (!lite || i === 0) {
      const under = [cx, y0 + uLip * H + 0.07, cz];
      for (let k = 0; k < N; k++) b.tri(under, rim[k], rim[(k + 1) % N], flatShade, vert);
    }
  }
  const mainCount = b.pos.length / 3;

  // ---- phones: shadow proxy (closed: back faces cover the whole silhouette in the depth pass) ----
  if (lite) {
    const M = 12, ph = rng() * Math.PI * 2;
    const solid = (cen, n, out) => out.setRGB(0.3, 0.5, 0.3);
    const droop = 0.06 + R * L.b0 * 0.08;
    // bottom lip (teeth: alternate radii, drooping), widest ring, two shoulders, tip
    const lip = Array.from({ length: M }, (_, k) => {
      const a = ph + (k / M) * Math.PI * 2, [cx, cz] = centre(0);
      const r = radiusAt(a, 0) * (k % 2 ? 0.95 : 1.12);
      return [cx + Math.cos(a) * r, y0 - (k % 2 ? 0.0 : droop), cz + Math.sin(a) * r];
    });
    const rings = [lip, ring(L.w, 1.04, M, ph), ring(0.5, 1.0, M, ph), ring(0.78, 1.0, M, ph)];
    const tip = [centre(1)[0], y1, centre(1)[1]];
    for (let r = 0; r < rings.length - 1; r++) {
      const A = rings[r], B = rings[r + 1];
      for (let k = 0; k < M; k++) { const j = (k + 1) % M; b.quad(A[k], B[k], B[j], A[j], solid); }
    }
    const top = rings[rings.length - 1];
    for (let k = 0; k < M; k++) b.tri(tip, top[(k + 1) % M], top[k], solid);
    const bc = [centre(0)[0], y0 + 0.02, centre(0)[1]];
    for (let k = 0; k < M; k++) b.tri(bc, lip[k], lip[(k + 1) % M], solid);
    // trunk: a 4-sided post from the ground into the crown
    for (let i = 0; i < 4; i++) {
      const a0 = (i / 4) * Math.PI * 2 + 0.4, a1 = ((i + 1) / 4) * Math.PI * 2 + 0.4;
      b.quad(pAt(a0, rb * 0.85, -0.02), pAt(a0, rt, y0 + 0.1), pAt(a1, rt, y0 + 0.1), pAt(a1, rb * 0.85, -0.02), solid);
    }
  }

  const g = b.build();
  const total = b.pos.length / 3;
  const prof = [];
  for (let u = 0; u <= 1.0001; u += 0.1) prof.push([y0 + u * H, R * shape(u)]);
  g.userData = {
    height: y1, crownY: y0 + H * 0.4, crownR: R, crownBase: y0 - 0.08, trunkR: rb,
    // crown radius along the height [y, r] (for contact when a felled tree leans on something)
    profile: prof,
    lod,
    // vertex ranges (non-indexed): what the main pass draws, and what the shadow pass draws
    mainRange: [0, mainCount],
    shadowRange: lite ? [mainCount, total - mainCount] : [0, mainCount],
  };
  if (lite) g.setDrawRange(0, mainCount);
  return g;
}

// ---------------- Rocks ----------------
// warm cream-yellow like the reference (props.js adds a warm bounce on the side faces on top of this)
const ROCK = { top: C('#f8edae'), shoulder: C('#fbe3a2'), side: C('#fedc94'), low: C('#f0c27a'), under: C('#d9a464') };
function rockShadeFor(hMax, jit) {
  return (cen, n, out) => {
    const h = THREE.MathUtils.clamp(cen.y / hMax, 0, 1);
    if (n.y > 0.72) out.copy(ROCK.top);
    else if (n.y > 0.3) out.copy(ROCK.shoulder).lerp(ROCK.top, (n.y - 0.3) * 0.8);
    else out.copy(ROCK.low).lerp(ROCK.side, Math.pow(h, 0.7));
    if (n.y < -0.2) out.copy(ROCK.under);
    // faces turned toward the sun (north-west) stay a little lighter
    if (n.y < 0.72 && (-n.x * 0.6 - n.z * 0.5) > 0.25) out.lerp(ROCK.shoulder, 0.25);
    out.multiplyScalar(jit());
  };
}
// A faceted column: rings of jittered vertices, chamfered shoulder, slightly domed top.
function prism(b, rng, { x = 0, z = 0, r, h, sides = 7, chamfer = 0.28, lean = 0 }, shade) {
  const colJ = Array.from({ length: sides }, () => 1 + (rng() - 0.5) * 0.22);
  const angJ = Array.from({ length: sides }, () => (rng() - 0.5) * 0.35);
  const rings = [[-0.05, 1.0], [h * 0.42, 1.05], [h * (1 - chamfer * 0.55), 0.98], [h, 1 - chamfer * 1.25]];
  const ringPts = rings.map(([y, rf], k) => colJ.map((cj, i) => {
    const a = ((i + 0.5 * (k % 2) * 0.3) / sides) * Math.PI * 2 + angJ[i];
    const rr = r * rf * cj * (1 + (rng() - 0.5) * 0.06);
    return [x + Math.cos(a) * rr + lean * y, y + (k === 3 ? (rng() - 0.5) * h * 0.06 : 0), z + Math.sin(a) * rr];
  }));
  for (let k = 0; k < rings.length - 1; k++) {
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides, A = ringPts[k], B = ringPts[k + 1];
      b.quad(A[i], B[i], B[j], A[j], shade);
    }
  }
  const top = ringPts[rings.length - 1];
  const cx = top.reduce((s, p) => s + p[0], 0) / sides, cz = top.reduce((s, p) => s + p[2], 0) / sides;
  const apex = [cx + (rng() - 0.5) * r * 0.2, h * 1.04, cz + (rng() - 0.5) * r * 0.2];
  for (let i = 0; i < sides; i++) b.tri(apex, top[(i + 1) % sides], top[i], shade);
}

const ROCK_LAYOUTS = [
  // 0: tall split pillar (the reference's two-lobed column)
  [{ x: -0.12, z: 0.02, r: 0.27, h: 1.0, sides: 7, chamfer: 0.17 }, { x: 0.16, z: -0.03, r: 0.24, h: 0.82, sides: 6, chamfer: 0.2 }, { x: 0.12, z: 0.3, r: 0.1, h: 0.14, sides: 5, chamfer: 0.45 }],
  // 1: big round boulder
  [{ r: 0.4, h: 0.56, sides: 8, chamfer: 0.42 }, { x: 0.37, z: 0.2, r: 0.12, h: 0.15, sides: 5, chamfer: 0.5 }],
  // 2: medium pillar + pebble
  [{ r: 0.31, h: 0.74, sides: 7, chamfer: 0.25 }, { x: -0.33, z: 0.17, r: 0.13, h: 0.2, sides: 6, chamfer: 0.45 }],
  // 3: low wide pair
  [{ x: -0.08, z: -0.05, r: 0.34, h: 0.46, sides: 7, chamfer: 0.4 }, { x: 0.27, z: 0.23, r: 0.2, h: 0.33, sides: 6, chamfer: 0.38 }],
];
export function buildRock(variant, seed = 23) {
  const rng = mulberry32(seed * 71 + variant * 313 + 9);
  const K = 1;
  const parts = ROCK_LAYOUTS[variant % ROCK_LAYOUTS.length].map(p => ({ ...p, x: (p.x || 0) * K, z: (p.z || 0) * K, r: p.r * K, h: p.h * K }));
  const hMax = Math.max(...parts.map(p => p.h));
  const shade = rockShadeFor(hMax, () => 1 + (rng() - 0.5) * 0.06);
  const b = new Builder();
  for (const p of parts) prism(b, rng, p, shade);
  const g = b.build();
  g.userData = { height: hMax, radius: Math.max(...parts.map(p => Math.hypot(p.x || 0, p.z || 0) + p.r)) };
  return g;
}

// ---------------- Stump ----------------
// the reference stump: a chunky, wide stump with a soft cream top (pale centre, a few calm rings) and dark red-brown bark
const STUMP = { top: C('#ead6ab'), ring: C('#cfae7f'), ring2: C('#dcc092'), bark: C('#64321b'), barkLight: C('#7a4023'), barkDark: C('#4a2513') };
export function buildStump(seed = 3) {
  const rng = mulberry32(seed * 19 + 4);
  const b = new Builder();
  const seg = 11, rb = 0.25, rt = 0.215, h = 0.22;
  const jit = () => 1 + (rng() - 0.5) * 0.1;
  const tops = [], bots = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2, j = 1 + (rng() - 0.5) * 0.08;
    tops.push([Math.cos(a) * rt * j, h + (rng() - 0.5) * 0.025, Math.sin(a) * rt * j]);
    bots.push([Math.cos(a) * rb * j, -0.03, Math.sin(a) * rb * j]);
  }
  const barkShade = (cen, n, out) => {
    out.copy(STUMP.bark).lerp(STUMP.barkDark, 0.4 - cen.y * 2);
    if (-n.x * 0.6 - n.z * 0.4 > 0.2) out.lerp(STUMP.barkLight, 0.4);
    out.multiplyScalar(jit());
  };
  for (let i = 0; i < seg; i++) { const j = (i + 1) % seg; b.quad(bots[i], tops[i], tops[j], bots[j], barkShade); }
  // top: bark lip, then concentric light/dark growth rings
  const ringR = [0.88, 0.74, 0.58, 0.44, 0.2];
  const ringCol = [STUMP.ring2, STUMP.top, STUMP.ring, STUMP.top, STUMP.top];
  let prev = tops;
  const lipShade = (c, n, out) => out.copy(STUMP.barkLight).multiplyScalar(jit());
  ringR.forEach((rf, k) => {
    const cur = tops.map(p => [p[0] * rf, h + 0.004 * k, p[2] * rf]);
    const col = ringCol[k];
    const shade = k === 0 ? lipShade : (c, n, out) => out.copy(ringCol[k - 1]).multiplyScalar(1 + (rng() - 0.5) * 0.04);
    for (let i = 0; i < seg; i++) { const j = (i + 1) % seg; b.quad(prev[i], cur[i], cur[j], prev[j], shade); }
    prev = cur;
    if (k === ringR.length - 1) {
      const c = [0, h + 0.02, 0];
      for (let i = 0; i < seg; i++) b.tri(c, prev[(i + 1) % seg], prev[i], (cc, n, out) => out.copy(col));
    }
  });
  // little roots
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + rng() * 0.8, len = 0.06 + rng() * 0.05, w = 0.075;
    const dx = Math.cos(a), dz = Math.sin(a), px = -dz, pz = dx;
    const up = [dx * rb * 0.92, 0.09, dz * rb * 0.92], tip = [dx * (rb + len), -0.01, dz * (rb + len)];
    b.tri(up, [dx * rb * 0.7 + px * w, -0.01, dz * rb * 0.7 + pz * w], tip, barkShade);
    b.tri(up, tip, [dx * rb * 0.7 - px * w, -0.01, dz * rb * 0.7 - pz * w], barkShade);
  }
  const g = b.build();
  g.userData = { height: h };
  return g;
}

// ---------------- Deposit nuggets ----------------
// Unit-sized jittered blob; instance scale sets the size. Faces get copper/stone tones + darker speckles.
export function buildNugget(type, seed = 5) {
  const rng = mulberry32(seed * 37 + (type === 'copper' ? 1 : 2));
  const pal = type === 'copper'
    ? { top: C('#ffad62'), side: C('#ea7f3c'), low: C('#c75e2f'), speck: C('#7e3820'), glint: C('#ffd9a0') }
    : { top: C('#fbf2dc'), side: C('#e6d6b4'), low: C('#c9b592'), speck: C('#a8987c'), glint: C('#ffffff') };
  const tris = spikyBall(rng, { detail: 1, body: 1, spike: 1.06, spikeVar: 0.05, droop: 0 });
  // extra jitter per shared vertex
  const jitter = new Map();
  const J = p => { const k = key(...p); if (!jitter.has(k)) jitter.set(k, 0.86 + rng() * 0.26); const r = jitter.get(k); return [p[0] * r, p[1] * r * 0.78, p[2] * r]; };
  const b = new Builder();
  const shade = (cen, n, out) => {
    if (n.y > 0.55) out.copy(pal.top); else if (n.y > -0.1) out.copy(pal.side); else out.copy(pal.low);
    const r = rng();
    if (r < 0.3) out.lerp(pal.speck, 0.8); else if (r > 0.93 && n.y > 0.2) out.copy(pal.glint);
    out.multiplyScalar(1 + (rng() - 0.5) * 0.08);
  };
  for (const t of tris) b.tri(J(t[0]), J(t[1]), J(t[2]), shade);
  return b.build();
}
