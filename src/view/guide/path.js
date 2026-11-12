// Path for the guide trail: BFS over walkable tiles (ctx.camp.bfs, 8-way, no corner cutting) from the robot's
// rounded tile to the goal, then string-pulled from the robot's float position with a walkable line-of-sight
// test, ending at a point just short of the target (a tree / animal) or on it (a pad / zone / pile).

// Goal predicate + end point for a resolved target (see guide.js target()).
// target: { kind, x, z, rect?: [x, z, w, h], stop: world units to stop short of (x, z) }
export function goalTest(target) {
  const tx = Math.round(target.x), tz = Math.round(target.z);
  if (target.rect) {
    const [x0, z0, w, h] = target.rect;
    return (x, z) => x >= x0 && x < x0 + w && z >= z0 && z < z0 + h;
  }
  if (target.onTile) return (x, z) => x === tx && z === tz;
  // adjacent (incl. diagonals) to the target tile
  return (x, z) => Math.max(Math.abs(x - tx), Math.abs(z - tz)) <= 1 && !(x === tx && z === tz);
}

export function tilePath(camp, from, target) {
  if (!camp?.bfs) return null;
  try { return camp.bfs(Math.round(from.x), Math.round(from.z), goalTest(target), 2600); }
  catch { return null; }
}

// Walkable line of sight between two points (tile units) with a little clearance. Samples close to either
// end skip the clearance test (the robot can stand right next to a tree; the end sits next to its target).
function los(walk, ax, az, bx, bz) {
  const d = Math.hypot(bx - ax, bz - az);
  const n = Math.max(1, Math.ceil(d / 0.18));
  for (let i = 1; i < n; i++) {
    const t = i / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
    if (!walk(Math.round(x), Math.round(z))) return false;
    const fromA = t * d, fromB = (1 - t) * d;
    if (fromA < 0.55 || fromB < 0.55) continue;
    const c = 0.3;
    if (!walk(Math.round(x + c), Math.round(z + c)) || !walk(Math.round(x - c), Math.round(z + c))
      || !walk(Math.round(x + c), Math.round(z - c)) || !walk(Math.round(x - c), Math.round(z - c))) return false;
  }
  return true;
}

// Polyline from the robot (float) through the tile path to the end point, string-pulled.
export function buildPolyline(walk, from, tiles, target) {
  if (!tiles || !tiles.length) return null;
  // end point: on the target (pad / zone / pile) or stop short of it along the last approach
  const last = tiles[tiles.length - 1];
  let ex = target.x, ez = target.z;
  if (target.stop > 0) {
    const ax = tiles.length > 1 ? tiles[tiles.length - 1][0] : from.x, az = tiles.length > 1 ? tiles[tiles.length - 1][1] : from.z;
    let dx = ax - target.x, dz = az - target.z;
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    ex = target.x + dx * target.stop; ez = target.z + dz * target.stop;
    // never further out than the last walkable tile
    if (Math.hypot(ex - target.x, ez - target.z) > Math.hypot(last[0] - target.x, last[1] - target.z)) { ex = last[0]; ez = last[1]; }
  }
  const raw = [[from.x, from.z], ...tiles.slice(1), [ex, ez]];
  // string pulling: from each anchor jump to the furthest point still in sight
  const out = [raw[0]];
  let i = 0;
  while (i < raw.length - 1) {
    let j = raw.length - 1;
    while (j > i + 1 && !los(walk, raw[i][0], raw[i][1], raw[j][0], raw[j][1])) j--;
    out.push(raw[j]);
    i = j;
  }
  return out;
}

export function polyLength(pts) {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return l;
}
