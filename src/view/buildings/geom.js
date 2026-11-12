// Geometry toolkit for buildings + items. Everything is baked into ONE vertex-coloured, non-indexed
// BufferGeometry per moving part (position / normal / uv / color), so a whole model renders with a single
// shared MeshLambertMaterial and repeated things can be instanced. Flat-shaded parts get face normals baked
// in, so faceted and smooth parts can live in the same merged geometry and draw call.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// uv.y >= NO_TRACK marks "not part of a belt track" (the belt shader paints chevrons only where uv.y < 1.5).
export const NO_TRACK = 2;

export function rng(seed = 1) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const smooth = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

// ---------- primitive shapes ----------
export function rbox(w, h, d, r = 0.04, seg = 2) {
  const rr = Math.max(0.002, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3));
  return new RoundedBoxGeometry(w, h, d, seg, rr);
}
// Cylinder with softly rounded rims, standing on y = 0, axis +y.
export function puck(r, h, bevel = 0.02, radial = 16, bevelSeg = 3) {
  const b = Math.min(bevel, r * 0.5, h * 0.5);
  const pts = [new THREE.Vector2(0, 0)];
  for (let i = 0; i <= bevelSeg; i++) { const a = -Math.PI / 2 + (i / bevelSeg) * (Math.PI / 2); pts.push(new THREE.Vector2(r - b + Math.cos(a) * b, b + Math.sin(a) * b)); }
  for (let i = 0; i <= bevelSeg; i++) { const a = (i / bevelSeg) * (Math.PI / 2); pts.push(new THREE.Vector2(r - b + Math.cos(a) * b, h - b + Math.sin(a) * b)); }
  pts.push(new THREE.Vector2(0, h));
  return new THREE.LatheGeometry(pts, radial);
}
// Gear in the XY plane (axis z), centred, with soft bevelled edges and optional lightening holes.
export function gear(rOut, rIn, teeth, depth, { holes = 0, holeR = 0.3, bevel = 0.008 } = {}) {
  const shape = new THREE.Shape();
  const n = teeth;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, step = (Math.PI * 2) / n;
    const pts = [[rIn, a0], [rIn, a0 + step * 0.22], [rOut, a0 + step * 0.32], [rOut, a0 + step * 0.62], [rIn, a0 + step * 0.72]];
    pts.forEach(([r, a], k) => { const x = Math.cos(a) * r, y = Math.sin(a) * r; if (i === 0 && k === 0) shape.moveTo(x, y); else shape.lineTo(x, y); });
  }
  shape.closePath();
  if (holes) {
    for (let i = 0; i < holes; i++) {
      const a = (i / holes) * Math.PI * 2 + Math.PI / holes, c = rIn * 0.55, hr = rIn * holeR;
      const h = new THREE.Path();
      h.absarc(Math.cos(a) * c, Math.sin(a) * c, hr, 0, Math.PI * 2, true);
      shape.holes.push(h);
    }
  }
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 6 });
  g.translate(0, 0, -depth / 2);
  return g;
}
// Displace vertices of a (possibly non-indexed) geometry consistently: shared corners move together.
export function jitter(geo, amount, seed = 1) {
  const pos = geo.attributes.position, cache = new Map(), r = rng(seed);
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
    let o = cache.get(key);
    if (!o) { o = [(r() - 0.5) * amount, (r() - 0.5) * amount, (r() - 0.5) * amount]; cache.set(key, o); }
    pos.setXYZ(i, pos.getX(i) + o[0], pos.getY(i) + o[1], pos.getZ(i) + o[2]);
  }
  return geo;
}

// ---------- part collector ----------
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _c = new THREE.Color(), _c2 = new THREE.Color();

// opts: p [x,y,z], r [rx,ry,rz], s number|[sx,sy,sz], flat (face normals), jitter (per-face tint),
//       seed, faceColor(cx,cy,cz,nx,ny,nz) -> colour|null per triangle, ao false to skip the height darkening.
export class Parts {
  constructor({ ao = { y0: 0, y1: 0.45, min: 0.8 } } = {}) { this.geos = []; this.ao = ao; }
  add(geo, color, o = {}) {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    geo.dispose();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    const n = g.attributes.position.count;
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!o.keepUv || !g.attributes.uv) {
      const uv = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) uv[i * 2 + 1] = NO_TRACK;
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    }
    const s = o.s === undefined ? 1 : o.s;
    _e.set(...(o.r || [0, 0, 0]));
    _m.compose(_p.set(...(o.p || [0, 0, 0])), _q.setFromEuler(_e), Array.isArray(s) ? _s.set(...s) : _s.set(s, s, s));
    g.applyMatrix4(_m);
    if (o.flat) g.computeVertexNormals(); // non-indexed => per-face normals (faceted look)
    const pos = g.attributes.position, nor = g.attributes.normal;
    const cols = new Float32Array(n * 3);
    const base = new THREE.Color(color);
    const r = rng(o.seed || 7);
    const ao = o.ao === false ? null : (o.ao || this.ao);
    for (let t = 0; t < n; t += 3) {
      _c.copy(base);
      if (o.faceColor) {
        const cx = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3, cy = (pos.getY(t) + pos.getY(t + 1) + pos.getY(t + 2)) / 3, cz = (pos.getZ(t) + pos.getZ(t + 1) + pos.getZ(t + 2)) / 3;
        const fc = o.faceColor(cx, cy, cz, nor.getX(t), nor.getY(t), nor.getZ(t));
        if (fc) _c.set(fc);
      }
      if (o.jitter) { const k = 1 + (r() * 2 - 1) * o.jitter; _c.multiplyScalar(k); }
      for (let v = t; v < t + 3 && v < n; v++) {
        _c2.copy(_c);
        if (ao) _c2.multiplyScalar(ao.min + (1 - ao.min) * smooth(ao.y0, ao.y1, pos.getY(v)));
        if (o.vertexColor) o.vertexColor(_c2, pos.getX(v), pos.getY(v), pos.getZ(v));
        cols[v * 3] = _c2.r; cols[v * 3 + 1] = _c2.g; cols[v * 3 + 2] = _c2.b;
      }
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    this.geos.push(g);
    return this;
  }
  addGeometry(g) { this.geos.push(g); return this; }
  merge() {
    const g = mergeGeometries(this.geos, false);
    this.geos.forEach(x => x.dispose());
    this.geos = [];
    g.computeBoundingBox(); g.computeBoundingSphere();
    return g;
  }
}

// ---------- swept profiles (belts) ----------
// strips: [{ pts: [[lateral, y], ...] ordered so the outside is on the right of travel (left to right over
// the top), color, track: bool }]. path(s) -> { x, z, angle } in the belt's local frame (s 0..1).
// Lateral axis N = (-sin a, cos a) (for travel +x that is +z). uv = (s * uScale, track ? 0..1 across : NO_TRACK);
// uScale = lane length, so uv.x is world distance along the lane (items move at constant world speed).
export function sweep(strips, path, segs, { trackHalf = 0.3, ao = null, uScale = 1 } = {}) {
  const P = [], Nn = [], U = [], C = [];
  const col = new THREE.Color();
  const rings = [];
  for (let i = 0; i <= segs; i++) {
    const q = path(i / segs);
    rings.push({ s: i / segs, x: q.x, z: q.z, nx: -Math.sin(q.angle), nz: Math.cos(q.angle) });
  }
  for (const strip of strips) {
    const pts = strip.pts, m = pts.length;
    // 2D normals per profile point: average of neighbouring segment normals n = (-dy, dl)
    const nrm = pts.map((_, j) => {
      let nl = 0, ny = 0;
      for (const k of [j - 1, j]) {
        if (k < 0 || k >= m - 1) continue;
        const dl = pts[k + 1][0] - pts[k][0], dy = pts[k + 1][1] - pts[k][1], L = Math.hypot(dl, dy) || 1;
        nl += -dy / L; ny += dl / L;
      }
      const L = Math.hypot(nl, ny) || 1;
      return [nl / L, ny / L];
    });
    col.set(strip.color);
    const vert = (ri, j) => {
      const R = rings[ri], [l, y] = pts[j], [nl, ny] = nrm[j];
      P.push(R.x + R.nx * l, y, R.z + R.nz * l);
      Nn.push(R.nx * nl, ny, R.nz * nl);
      U.push(R.s * uScale, strip.track ? (l + trackHalf) / (2 * trackHalf) : NO_TRACK);
      let k = 1;
      if (ao) k = ao.min + (1 - ao.min) * smooth(ao.y0, ao.y1, y);
      C.push(col.r * k, col.g * k, col.b * k);
    };
    for (let i = 0; i < segs; i++) {
      for (let j = 0; j < m - 1; j++) {
        // A=(i,j) B=(i+1,j) C=(i+1,j+1) D=(i,j+1) -> (A,D,C) (A,C,B)
        vert(i, j); vert(i, j + 1); vert(i + 1, j + 1);
        vert(i, j); vert(i + 1, j + 1); vert(i + 1, j);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(Nn, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  return g;
}

// Scale a finished geometry to fit `size` (largest horizontal extent or height) with its bottom at y = 0.
export function fitMini(geo, { height = 0.22, width = 0.3 } = {}) {
  const g = geo.clone();
  g.computeBoundingBox();
  const b = g.boundingBox, sz = new THREE.Vector3(); b.getSize(sz);
  const k = Math.min(height / sz.y, width / Math.max(sz.x, sz.z));
  g.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
  g.scale(k, k, k);
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}
