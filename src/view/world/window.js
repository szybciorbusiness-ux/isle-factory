// View windows for instanced ground clutter on phones (grass blades, rim tufts, field tufts, flowers).
//
// Desktop draws those per map chunk with frustum culling. On a phone a chunk is mostly off screen, so instead
// each kind keeps ONE draw: its instance attributes are refilled with just the instances whose tile lies in the
// camera's ground footprint (the view frustum cut by the ground plane, grown by a margin). The refill only
// runs when the footprint, snapped to half tiles, changes (a few times a second while walking), and it copies
// whole per-tile runs, so it costs a few hundred microseconds at most. Per-instance values that animate
// (a tuft's grow factor) live in a master array; sync(name) copies them into the drawn subset.
import * as THREE from 'three';

const _ray = new THREE.Vector3(), _cam = new THREE.Vector3();
const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

// The camera's ground footprint (y = 0) as 4 xz points in CCW-agnostic order: bottom-left, bottom-right,
// top-right, top-left of the screen. Rays at or above the horizon are clamped `far` units out.
export function groundFootprint(camera, out = new Float64Array(8), far = 70) {
  camera.updateMatrixWorld();
  camera.getWorldPosition(_cam);
  for (let i = 0; i < 4; i++) {
    const [nx, ny] = CORNERS[i];
    _ray.set(nx, ny, 0.5).unproject(camera).sub(_cam);
    let x, z;
    if (_ray.y < -1e-4 && _cam.y > 0) {
      const t = -_cam.y / _ray.y;
      x = _cam.x + _ray.x * t; z = _cam.z + _ray.z * t;
      const dx = x - _cam.x, dz = z - _cam.z, d = Math.hypot(dx, dz);
      if (d > far) { x = _cam.x + dx * far / d; z = _cam.z + dz * far / d; }
    } else {
      const l = Math.hypot(_ray.x, _ray.z) || 1;
      x = _cam.x + (_ray.x / l) * far; z = _cam.z + (_ray.z / l) * far;
    }
    out[i * 2] = x; out[i * 2 + 1] = z;
  }
  return out;
}

// Shared per-frame footprint for every window (computed once per camera state).
export function createFootprint(camera, { margin = 1.6, snap = 0.5 } = {}) {
  const poly = new Float64Array(8), snapped = new Int32Array(8);
  const edges = new Float64Array(12); // per edge: nx, nz, c (inside when nx*x + nz*z + c >= -margin)
  const fp = {
    poly, margin, version: 0, fresh: false,
    bbox: [0, 0, 0, 0],
    // recompute; bumps `version` when the snapped footprint changed
    update() {
      groundFootprint(camera, poly);
      let same = fp.fresh;
      for (let i = 0; i < 8; i++) { const v = Math.round(poly[i] / snap); if (v !== snapped[i]) { snapped[i] = v; same = false; } }
      if (same) return false;
      fp.fresh = true;
      // centroid decides the inside of each edge (works for either winding)
      let cx = 0, cz = 0;
      for (let i = 0; i < 4; i++) { cx += poly[i * 2] / 4; cz += poly[i * 2 + 1] / 4; }
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let i = 0; i < 4; i++) {
        const ax = poly[i * 2], az = poly[i * 2 + 1], bx = poly[((i + 1) % 4) * 2], bz = poly[((i + 1) % 4) * 2 + 1];
        let nx = -(bz - az), nz = bx - ax;
        const l = Math.hypot(nx, nz) || 1;
        nx /= l; nz /= l;
        let c = -(nx * ax + nz * az);
        if (nx * cx + nz * cz + c < 0) { nx = -nx; nz = -nz; c = -c; }
        edges[i * 3] = nx; edges[i * 3 + 1] = nz; edges[i * 3 + 2] = c;
        x0 = Math.min(x0, ax); x1 = Math.max(x1, ax); z0 = Math.min(z0, az); z1 = Math.max(z1, az);
      }
      const m = fp.margin;
      fp.bbox[0] = x0 - m; fp.bbox[1] = z0 - m; fp.bbox[2] = x1 + m; fp.bbox[3] = z1 + m;
      fp.version++;
      return true;
    },
    inside(x, z) {
      const m = fp.margin;
      for (let i = 0; i < 4; i++) if (edges[i * 3] * x + edges[i * 3 + 1] * z + edges[i * 3 + 2] < -m) return false;
      return true;
    },
  };
  return fp;
}

// One windowed instance set. `tiles[i]` = tile index (z * w + x) of instance i. `attrs` = { name: { master
// (Float32Array, all instances, in their original order), size, target (the BufferAttribute that is drawn),
// animated (true when the owner keeps writing the master: copied by gathering, see sync) } }. setCount(n)
// applies the drawn count (mesh.count / geometry.instanceCount).
//
// Static attributes are re-sorted by tile once (row-major), so the instances of a row of tiles are one
// contiguous block and a refill is one TypedArray.set per row of the footprint.
export function createInstanceWindow({ map, tiles, attrs, setCount }) {
  const n = tiles.length, W = map.w, H = map.h;
  // instances sorted by tile (CSR): order[k] = instance id at sorted position k; tile t owns [start[t], start[t+1])
  const start = new Int32Array(W * H + 1);
  for (let i = 0; i < n; i++) start[tiles[i] + 1]++;
  for (let t = 0; t < W * H; t++) start[t + 1] += start[t];
  const fill = start.slice(0, W * H), order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[fill[tiles[i]]++] = i;
  const list = Object.values(attrs);
  for (const a of list) {
    if (a.animated) continue;
    const src = a.master, sz = a.size, sorted = new Float32Array(n * sz);
    for (let k = 0; k < n; k++) for (let c = 0; c < sz; c++) sorted[k * sz + c] = src[order[k] * sz + c];
    a.sorted = sorted;
  }
  const runs = new Int32Array(H * 2);   // [k0, k1) per footprint row
  let nRuns = 0, count = 0, version = -1;
  const win = {
    get count() { return count; },
    // refill from the footprint if it changed since the last call
    update(fp) {
      if (fp.version === version) return false;
      version = fp.version;
      const [bx0, bz0, bx1, bz1] = fp.bbox;
      const tx0 = Math.max(0, Math.floor(bx0)), tz0 = Math.max(0, Math.floor(bz0));
      const tx1 = Math.min(W - 1, Math.ceil(bx1)), tz1 = Math.min(H - 1, Math.ceil(bz1));
      count = 0; nRuns = 0;
      for (let z = tz0; z <= tz1; z++) {
        // the footprint is convex: the tiles inside it form one interval per row
        let xa = tx0;
        while (xa <= tx1 && !fp.inside(xa, z)) xa++;
        if (xa > tx1) continue;
        let xb = tx1;
        while (xb > xa && !fp.inside(xb, z)) xb--;
        const k0 = start[z * W + xa], k1 = start[z * W + xb + 1];
        if (k1 <= k0) continue;
        runs[nRuns * 2] = k0; runs[nRuns * 2 + 1] = k1; nRuns++;
        count += k1 - k0;
      }
      for (const a of list) copy(a);
      setCount(count);
      return true;
    },
    // copy one animated attribute's master values into the drawn subset
    sync(name) { const a = attrs[name]; if (a) copy(a); },
    // the master array of an attribute (original instance order: write animated values here, then sync(name))
    master: name => attrs[name]?.master || null,
  };
  function copy(a) {
    const { size, target } = a, dst = target.array;
    let d = 0;
    if (a.sorted) {
      for (let r = 0; r < nRuns; r++) {
        const k0 = runs[r * 2], k1 = runs[r * 2 + 1];
        dst.set(a.sorted.subarray(k0 * size, k1 * size), d);
        d += (k1 - k0) * size;
      }
    } else {
      const m = a.master;
      for (let r = 0; r < nRuns; r++) {
        for (let k = runs[r * 2], k1 = runs[r * 2 + 1]; k < k1; k++) {
          const s = order[k] * size;
          for (let c = 0; c < size; c++) dst[d++] = m[s + c];
        }
      }
    }
    target.needsUpdate = true;
    if (target.addUpdateRange && count > 0) { target.clearUpdateRanges?.(); target.addUpdateRange(0, count * size); }
  }
  return win;
}
