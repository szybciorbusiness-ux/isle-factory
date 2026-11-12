// Island outline tracing, shared by terrain.js (geometry) and water.js (shore distance field).
//
// The land union is traced into closed loops of unit tile edges (land always on the RIGHT of travel,
// so outer loops run clockwise on screen and holes run counter-clockwise). Every loop can then be
// turned into a rounded "ring" at any inward offset d (d > 0 moves into the land, d < 0 out over the
// water). Convex corners are filleted with radius RC - d and concave corners with RV + d, so every
// ring of a loop is concentric with the others and has the SAME point count: rings at different
// offsets can be stitched into strips directly (sand lip, bevel, cliff wall...).

export const RC = 0.25;  // convex fillet radius at d = 0
export const RV = 0.12;  // concave fillet radius at d = 0
export const ARC_SEGS = 6;

const right = (dx, dz) => [-dz, dx];

// -> [{ corners: [{x, z, ax, az, bx, bz, convex}], area, outer }]
export function traceLoops(map, solid = (x, z) => map.isLand(x, z)) {
  const { w, h } = map;
  const out = new Map(); // corner key -> edges starting there
  const key = (i, j) => (i + 2) * 8192 + (j + 2);
  const edges = [];
  const add = (si, sj, ei, ej) => {
    const e = { si, sj, ei, ej, dx: ei - si, dz: ej - sj, used: false };
    edges.push(e);
    const k = key(si, sj);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(e);
  };
  for (let z = 0; z < h; z++) for (let x = 0; x < w; x++) {
    if (!solid(x, z)) continue;
    // corner (i, j) is world (i - 0.5, j - 0.5)
    if (!solid(x, z - 1)) add(x, z, x + 1, z);             // north side, heading east
    if (!solid(x + 1, z)) add(x + 1, z, x + 1, z + 1);     // east side, heading south
    if (!solid(x, z + 1)) add(x + 1, z + 1, x, z + 1);     // south side, heading west
    if (!solid(x - 1, z)) add(x, z + 1, x, z);             // west side, heading north
  }

  const loops = [];
  for (const start of edges) {
    if (start.used) continue;
    const seq = [];
    let e = start;
    while (e && !e.used) {
      e.used = true;
      seq.push(e);
      const cand = (out.get(key(e.ei, e.ej)) || []).filter(c => !c.used || c === start);
      if (!cand.length) break;
      let next = cand[0];
      if (cand.length > 1) {
        // diagonal pinch: take the right turn so touching islands stay separate loops
        const [rx, rz] = right(e.dx, e.dz);
        next = cand.find(c => c.dx === rx && c.dz === rz) || cand[0];
      }
      if (next === start) break;
      e = next;
    }
    if (seq.length < 4) continue;
    // corners where the heading changes
    const corners = [];
    const n = seq.length;
    for (let i = 0; i < n; i++) {
      const a = seq[i], b = seq[(i + 1) % n];
      if (a.dx === b.dx && a.dz === b.dz) continue;
      const [rx, rz] = right(a.dx, a.dz);
      corners.push({
        x: a.ei - 0.5, z: a.ej - 0.5,
        ax: a.dx, az: a.dz, bx: b.dx, bz: b.dz,
        convex: b.dx === rx && b.dz === rz,
      });
    }
    let area = 0;
    for (let i = 0; i < corners.length; i++) {
      const p = corners[i], q = corners[(i + 1) % corners.length];
      area += p.x * q.z - q.x * p.z;
    }
    area *= 0.5;
    loops.push({ corners, area, outer: area > 0 });
  }
  return loops;
}

// Rounded ring of a loop at inward offset d.
// -> { pts: Float32Array [x, z, ...], nrm: Float32Array [nx, nz, ...] (outward, toward water) }
export function ring(loop, d, segs = ARC_SEGS) {
  const cs = loop.corners;
  const count = cs.length * (segs + 1);
  const pts = new Float32Array(count * 2);
  const nrm = new Float32Array(count * 2);
  let k = 0;
  for (const c of cs) {
    const [rax, raz] = right(c.ax, c.az);
    const [rbx, rbz] = right(c.bx, c.bz);
    const cdx = c.x + (rax + rbx) * d, cdz = c.z + (raz + rbz) * d;
    const r = Math.max(0.005, c.convex ? RC - d : RV + d);
    const ox = cdx + (c.bx - c.ax) * r, oz = cdz + (c.bz - c.az) * r;
    for (let s = 0; s <= segs; s++) {
      const phi = (s / segs) * Math.PI * 0.5;
      const ux = -c.bx * Math.cos(phi) + c.ax * Math.sin(phi);
      const uz = -c.bz * Math.cos(phi) + c.az * Math.sin(phi);
      pts[k * 2] = ox + ux * r;
      pts[k * 2 + 1] = oz + uz * r;
      const sg = c.convex ? 1 : -1;
      nrm[k * 2] = ux * sg;
      nrm[k * 2 + 1] = uz * sg;
      k++;
    }
  }
  return { pts, nrm, count };
}

// Point-in-polygon (even-odd) against a flat [x, z, ...] array.
export function insidePoly(pts, x, z) {
  let inside = false;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i * 2], zi = pts[i * 2 + 1], xj = pts[j * 2], zj = pts[j * 2 + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// Group loops into islands: each outer loop with the hole loops it contains.
export function groupIslands(loops) {
  const outers = loops.filter(l => l.outer).map(l => ({ outer: l, holes: [], poly: ring(l, 0, 1).pts }));
  for (const l of loops) {
    if (l.outer) continue;
    const p = l.corners[0];
    // probe a point just inside the hole's water (left of the incoming edge)
    const px = p.x - p.ax * 0.5 + p.az * 0.25, pz = p.z - p.az * 0.5 - p.ax * 0.25;
    const owner = outers.find(o => insidePoly(o.poly, px, pz)) || outers[0];
    owner?.holes.push(l);
  }
  return outers;
}
