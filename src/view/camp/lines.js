// Production lines: short conveyors in the existing belt style (slate bed, cream rails, warm chevrons that
// scroll at exactly CAMP.lineSpeed), laid from a station's footprint edge through each path tile.
// One InstancedMesh per tile shape (straight / left / right) holds every line tile in the camp; a per-instance
// beltOff (= tile index along its line) keeps the chevrons continuous, and uv.x is in "p units" (one tile = 1)
// so stripes and riders move together even on curves (the sim advances p at a constant rate per tile).
import * as THREE from 'three';
import * as BM from '../buildings/models.js';
import * as BMat from '../buildings/beltMaterial.js';
import { beltPath } from '../../sim/sim.js';
import { DIRS, dirAngle, dirFromDelta } from '../../config.js';
import { Parts, rbox, C } from './geo.js';

export const RIDE_Y = BM.BELT_TOP ?? 0.088;

const rectTiles = ([x, z, w, h]) => { const out = []; for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out.push([x + i, z + j]); return out; };

// Layout of one station's line: tiles with (dir, from) for beltPath, and the cells before/after the line.
export function lineLayout(def, STATIONS) {
  const path = def.line;
  if (!path?.length) return null;
  const adjacentIn = (rect, [x, z]) => rectTiles(rect).find(([tx, tz]) => Math.abs(tx - x) + Math.abs(tz - z) === 1) || null;
  const first = path[0], last = path[path.length - 1];
  const prev0 = adjacentIn(def.footprint, first) || [first[0] - 1, first[1]];
  let next = null;
  if (def.pile) next = def.pile;
  else if (def.to && STATIONS[def.to]) next = adjacentIn(STATIONS[def.to].footprint, last);
  if (!next) { const before = path.length > 1 ? path[path.length - 2] : prev0; next = [last[0] * 2 - before[0], last[1] * 2 - before[1]]; }
  const tiles = path.map(([x, z], i) => {
    const prev = i === 0 ? prev0 : path[i - 1];
    const nxt = i === path.length - 1 ? next : path[i + 1];
    const from = dirFromDelta(prev[0] - x, prev[1] - z);
    const dir = dirFromDelta(nxt[0] - x, nxt[1] - z);
    const lf = ((from - dir) + 4) & 3; // 2 straight, 1 enters from local +z, 3 from local -z
    return { x, z, dir, from, lf, index: i };
  });
  const len = tiles.length;
  const L = { tiles, len, next, prev: prev0 };
  L.at = (p, out = {}) => {
    const k = Math.max(0, Math.min(len - 1, Math.floor(p)));
    const local = Math.max(0, Math.min(1, p - k));
    const q = beltPath(tiles[k], local);
    out.x = q.x; out.z = q.z; out.angle = q.angle;
    return out;
  };
  // world point at the line end (p = len) and the start (p = 0)
  L.end = L.at(len);
  L.start = L.at(0);
  return L;
}

// ---------- belt tile meshes ----------
function tileGeometry(lf) {
  let g = null;
  try {
    const src = BM.beltGeometry?.(lf);
    if (src) {
      g = src.clone();
      if (g.attributes.beltOff) g.deleteAttribute('beltOff');
      // uv.x: world distance along the lane -> p units (the lane is laneLength long)
      const L = BM.laneLength?.(lf) ?? 1;
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) / L);
      uv.needsUpdate = true;
    }
  } catch { g = null; }
  if (!g) {
    // plain fallback: slate slab + cream rails (no curve shape; still continuous enough to read)
    const p = new Parts();
    p.add(rbox(1, 0.088, 0.62, 0.02), C.slate, { p: [0, 0.044, 0] });
    for (const s of [-1, 1]) p.add(rbox(1, 0.15, 0.12, 0.04), C.rail, { p: [0, 0.075, s * 0.37] });
    g = p.merge();
  }
  return g;
}

export function createLines(ctx, parent, { castShadow = true } = {}) {
  const uniforms = BMat.createBeltUniforms ? BMat.createBeltUniforms(C.stripe) : null;
  let mat;
  try { mat = uniforms && BMat.makeBeltMaterial ? BMat.makeBeltMaterial(uniforms) : null; } catch { mat = null; }
  if (!mat) mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const CHEV = BMat.CHEVRONS_PER_TILE || 3;

  const CAP = 24;
  const meshes = {};
  for (const lf of [2, 1, 3]) {
    const g = tileGeometry(lf);
    const off = new THREE.InstancedBufferAttribute(new Float32Array(CAP), 1);
    off.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('beltOff', off);
    const m = new THREE.InstancedMesh(g, mat, CAP);
    m.count = 0; m.frustumCulled = false; m.castShadow = castShadow; m.receiveShadow = true;
    m.name = `camp-line:${lf}`;
    parent.add(m);
    meshes[lf] = { mesh: m, off, n: 0 };
  }

  const _m = new THREE.Matrix4(), _r = new THREE.Matrix4(), _s = new THREE.Matrix4();
  return {
    material: mat,
    begin() { for (const k in meshes) meshes[k].n = 0; },
    // one line tile: scale s (rollout animation), lift y
    push(tile, s = 1, y = 0) {
      if (s <= 0.001) return;
      const M = meshes[tile.lf] || meshes[2];
      if (M.n >= CAP) return;
      _r.makeRotationY(dirAngle(tile.dir));
      _s.makeScale(s, s, s);
      _m.makeTranslation(tile.x, y, tile.z).multiply(_r).multiply(_s);
      M.mesh.setMatrixAt(M.n, _m);
      M.off.setX(M.n, tile.index);
      M.n++;
    },
    end() {
      for (const k in meshes) {
        const M = meshes[k];
        M.mesh.count = M.n; M.mesh.visible = M.n > 0;
        if (M.n) { M.mesh.instanceMatrix.needsUpdate = true; M.off.needsUpdate = true; }
      }
    },
    // chevrons scroll at exactly the item speed (p units per second)
    advance(dt, speed) { if (uniforms) uniforms.uBeltPhase.value = (uniforms.uBeltPhase.value + dt * speed * CHEV) % 1; },
    meshes: Object.values(meshes).map(M => M.mesh),
  };
}

export { DIRS };
