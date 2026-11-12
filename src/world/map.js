// Island layout. Pure data, deterministic. Islands are unions of chunky rectangles (the blocky,
// lobed outline of the reference), with bridges, ore deposits, trees and rocks placed by rules.
import { mulberry32, fbm2, hash2 } from '../util/noise.js';

const W = 44, H = 32;

// [x, z, w, h] in tiles
const LAND = [
  // main island
  [13, 9, 16, 11], [7, 11, 7, 8], [9, 8, 5, 4], [16, 5, 8, 5], [28, 11, 7, 7], [26, 7, 5, 3], [15, 19, 9, 4], [11, 18, 5, 3],
  // north-west forest isle
  [6, 1, 6, 5],
  // south-east copper isle
  [29, 21, 7, 5],
  // far decorative isles (peek through the clouds)
  [38, 4, 4, 4], [1, 23, 5, 5], [17, 27, 6, 4], [39, 19, 4, 6], [34, 0, 6, 2], [0, 6, 3, 3],
];
const CARVE = [[24, 18, 3, 2], [13, 9, 2, 1], [28, 17, 1, 1], [22, 5, 2, 1], [7, 17, 2, 2], [15, 22, 2, 1],
  // one-tile channels split the big landmass into a cluster of smaller isles joined by two-tile land necks,
  // so shorelines (sand rims, tufts, glowing shallows) are everywhere, like the reference
  [13, 11, 1, 3], [13, 16, 1, 3],          // forest isle | centre   (neck z 14-15)
  [15, 9, 4, 1], [21, 9, 4, 1],            // north isle / centre    (neck x 19-20)
  [24, 10, 1, 3], [24, 15, 1, 3],          // centre | copper isle   (neck z 13-14)
  [15, 19, 3, 1], [20, 19, 4, 1],          // centre / south isle    (neck x 18-19)
];
// bridges: [x, z, length, orientation] orientation 1 = runs along x, 2 = runs along z
const BRIDGES = [[10, 6, 2, 2], [31, 18, 3, 2]];
const COPPER = [[30, 12, 3, 3], [31, 22, 3, 2]];
const STONE = [[18, 6, 3, 2]];
const FOREST = [[6, 1, 6, 5], [7, 11, 6, 8], [9, 8, 5, 3], [11, 18, 4, 3], [15, 19, 5, 3], [16, 10, 3, 2]];
const FIXED_ROCKS = [[24, 11], [16, 16], [22, 7], [26, 15], [14, 12], [33, 15], [19, 21]];
const START = { x: 22, z: 16 };

export function createMap(seed = 7) {
  const rng = mulberry32(seed);
  const n = W * H;
  const land = new Uint8Array(n);     // 1 = land
  const bridge = new Uint8Array(n);   // 0 none, 1 along x, 2 along z
  const deposit = new Uint8Array(n);  // 0 none, 1 copper, 2 stone (see config DEPOSITS)
  const idx = (x, z) => z * W + x;
  const inBounds = (x, z) => x >= 0 && z >= 0 && x < W && z < H;
  const fill = (arr, [x0, z0, w, h], v) => { for (let z = z0; z < z0 + h; z++) for (let x = x0; x < x0 + w; x++) if (inBounds(x, z)) arr[idx(x, z)] = v; };

  LAND.forEach(r => fill(land, r, 1));
  CARVE.forEach(r => fill(land, r, 0));
  for (const [x, z, len, o] of BRIDGES) {
    for (let i = 0; i < len; i++) {
      const bx = o === 1 ? x + i : x, bz = o === 2 ? z + i : z;
      land[idx(bx, bz)] = 0; bridge[idx(bx, bz)] = o;
    }
  }
  COPPER.forEach(r => fill(deposit, r, 1));
  STONE.forEach(r => fill(deposit, r, 2));
  for (let i = 0; i < n; i++) if (!land[i]) deposit[i] = 0;

  const isLand = (x, z) => inBounds(x, z) && land[idx(x, z)] === 1;
  const isBridge = (x, z) => inBounds(x, z) && bridge[idx(x, z)] > 0;

  // ---- props ----
  const props = [];
  const taken = new Uint8Array(n);
  const nearBridge = (x, z) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => isBridge(x + dx, z + dz));
  const nearStart = (x, z) => Math.max(Math.abs(x - START.x), Math.abs(z - START.z)) <= 3;
  const inRects = (rects, x, z) => rects.some(([x0, z0, w, h]) => x >= x0 && z >= z0 && x < x0 + w && z < z0 + h);
  const reachable = (x, z) => inRects(LAND.slice(0, 10), x, z); // decorative far isles get trees too, just sparser
  const free = (x, z) => isLand(x, z) && !taken[idx(x, z)] && !deposit[idx(x, z)] && !nearBridge(x, z) && !nearStart(x, z);
  const add = (kind, x, z) => {
    taken[idx(x, z)] = 1;
    props.push({ kind, x, z, variant: Math.floor(rng() * 4), rot: rng() * Math.PI * 2, scale: 0.88 + rng() * 0.24 });
  };

  for (const [x, z] of FIXED_ROCKS) if (free(x, z)) add('rock', x, z);
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
    if (!free(x, z)) continue;
    const forest = inRects(FOREST, x, z);
    const nse = fbm2(x * 0.35, z * 0.35, 3, seed);
    let p = forest ? 0.35 + nse * 0.45 : reachable(x, z) ? 0.035 : 0.3;
    if (hash2(x, z, seed + 3) < p) add('tree', x, z);
    else if (!forest && reachable(x, z) && hash2(x, z, seed + 9) < 0.025) add('rock', x, z);
  }

  return {
    w: W, h: H, land, bridge, deposit, props, start: { ...START }, seed,
    idx, inBounds, isLand, isBridge,
    depositAt: (x, z) => (isLand(x, z) ? deposit[idx(x, z)] : 0),
    // Walkable ground (ignores entities): land or bridge.
    isGround: (x, z) => isLand(x, z) || isBridge(x, z),
    toAscii() {
      const p = new Map(props.map(q => [idx(q.x, q.z), q.kind === 'tree' ? 'T' : 'R']));
      let s = '';
      for (let z = 0; z < H; z++) {
        for (let x = 0; x < W; x++) {
          const i = idx(x, z);
          s += x === START.x && z === START.z ? '@' : p.get(i) || (bridge[i] ? '=' : !land[i] ? '.' : deposit[i] === 1 ? 'c' : deposit[i] === 2 ? 's' : '#');
        }
        s += '\n';
      }
      return s;
    },
  };
}
