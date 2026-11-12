// Grid BFS for click-to-walk, plus string-pulling so free movement walks straight lines instead of a
// staircase. findPath returns the tiles to walk through (excluding the start), [] when the start already
// satisfies the goal, or null when no goal tile is reachable.
const NB = [[1, 0], [0, 1], [-1, 0], [0, -1]];

export function findPath(sim, map, sx, sz, isGoal, maxNodes = 4000) {
  if (isGoal(sx, sz)) return [];
  const w = map.w, h = map.h;
  if (sx < 0 || sz < 0 || sx >= w || sz >= h) return null;
  const prev = new Int32Array(w * h).fill(-1);
  const start = sz * w + sx;
  prev[start] = start;
  const queue = [start];
  for (let qi = 0; qi < queue.length && qi < maxNodes; qi++) {
    const cur = queue[qi], cx = cur % w, cz = (cur - cx) / w;
    // prefer continuing straight: try the direction we arrived from first, so paths have fewer corners
    const from = prev[cur], fdx = cx - (from % w), fdz = cz - Math.floor(from / w);
    const order = fdx || fdz ? [[fdx, fdz], ...NB.filter(([x, z]) => x !== fdx || z !== fdz)] : NB;
    for (const [dx, dz] of order) {
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= w || nz >= h) continue;
      const ni = nz * w + nx;
      if (prev[ni] !== -1 || !sim.isWalkable(nx, nz)) continue;
      prev[ni] = cur;
      if (isGoal(nx, nz)) {
        const out = [];
        for (let i = ni; i !== start; i = prev[i]) out.push({ x: i % w, z: Math.floor(i / w) });
        return out.reverse();
      }
      queue.push(ni);
    }
  }
  return null;
}

// Does a circle of radius r fit everywhere along the segment a -> b? (samples every 0.08 tiles)
export function segmentClear(isWalkable, ax, az, bx, bz, r) {
  const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / 0.08));
  for (let i = 0; i <= n; i++) {
    const px = ax + ((bx - ax) * i) / n, pz = az + ((bz - az) * i) / n;
    for (let tz = Math.round(pz - r); tz <= Math.round(pz + r); tz++) for (let tx = Math.round(px - r); tx <= Math.round(px + r); tx++) {
      if (isWalkable(tx, tz)) continue;
      const cx = Math.min(Math.max(px, tx - 0.5), tx + 0.5), cz = Math.min(Math.max(pz, tz - 0.5), tz + 0.5);
      if ((px - cx) ** 2 + (pz - cz) ** 2 < r * r) return false;
    }
  }
  return true;
}

// String-pull a tile path: keep only the waypoints needed so every straight leg is clear for radius r.
// The final waypoint is always kept (it is where the player should stop).
export function smoothPath(isWalkable, sx, sz, pts, r) {
  if (!pts || pts.length < 2) return pts;
  const out = [];
  let ax = sx, az = sz, i = 0;
  while (i < pts.length) {
    let j = pts.length - 1;
    while (j > i && !segmentClear(isWalkable, ax, az, pts[j].x, pts[j].z, r)) j--;
    out.push(pts[j]);
    ax = pts[j].x; az = pts[j].z;
    i = j + 1;
  }
  return out;
}
