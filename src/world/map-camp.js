// Camp map: a home island for the camp plus four islands unlocked by building bridges (pads). Pure data.
// Same shape as map.js (createMap) so every view keeps working; bridges start unbuilt (water) and the camp
// sim flips map.bridge tiles on when a bridge pad completes.
import { mulberry32, fbm2, hash2 } from '../util/noise.js';

const W = 44, H = 32;

// [x, z, w, h] in tiles
const LAND = [
  // HOME (camp) x14..28, z11..21
  [16, 11, 11, 9], [18, 20, 6, 2], [14, 13, 2, 4], [27, 14, 2, 3],
  // FOREST (west) x2..11, z7..20
  [4, 9, 8, 12], [2, 12, 2, 5], [6, 7, 4, 2],
  // NORTH meadow x15..26, z0..8
  [15, 2, 12, 7], [19, 0, 5, 2],
  // EAST copper x31..38, z10..20
  [31, 10, 8, 9], [33, 19, 4, 2],
  // SOUTH x15..24, z24..29
  [15, 24, 10, 6],
  // far decorative isles
  [40, 3, 3, 4], [0, 25, 5, 5], [36, 24, 6, 5], [29, 0, 5, 3], [0, 1, 3, 3],
];
const CARVE = [[16, 11, 2, 1], [25, 11, 2, 1], [26, 19, 1, 1], [4, 9, 1, 2], [11, 20, 1, 1], [15, 2, 1, 2], [26, 8, 1, 1],
  [38, 10, 1, 2], [31, 18, 1, 1], [15, 29, 2, 1], [24, 24, 1, 2]];
// Bridges the camp can build: id -> tiles + orientation (1 along x, 2 along z). NOT built at start.
export const BRIDGES = {
  west:  { tiles: [[13, 15], [12, 15]], orientation: 1 },
  north: { tiles: [[21, 10], [21, 9]], orientation: 2 },
  east:  { tiles: [[29, 15], [30, 15]], orientation: 1 },
  south: { tiles: [[20, 22], [20, 23]], orientation: 2 },
};
const COPPER = [[33, 12, 3, 3]];
const STONE = [[17, 4, 3, 2]];
// Islands: name -> rects (used for animal spawn regions and tree density)
export const ISLANDS = {
  home: [[16, 11, 11, 9], [18, 20, 6, 2], [14, 13, 2, 4], [27, 14, 2, 3]],
  forest: [[4, 9, 8, 12], [2, 12, 2, 5], [6, 7, 4, 2]],
  north: [[15, 2, 12, 7], [19, 0, 5, 2]],
  east: [[31, 10, 8, 9], [33, 19, 4, 2]],
  south: [[15, 24, 10, 6]],
};
// Tiles the camp keeps clear (station footprints, zones, lines, pads) — no trees/rocks spawn there.
const CAMP_CLEAR = [[14, 12, 15, 9], [16, 3, 7, 4], [32, 11, 7, 7], [12, 14, 2, 3], [20, 20, 1, 4], [28, 14, 3, 3], [20, 8, 3, 3], [10, 14, 2, 3], [31, 14, 2, 3], [19, 24, 3, 2]];
const START = { x: 21, z: 17 };

export function createMap(seed = 7) {
  const rng = mulberry32(seed);
  const n = W * H;
  const land = new Uint8Array(n), bridge = new Uint8Array(n), deposit = new Uint8Array(n);
  const idx = (x, z) => z * W + x;
  const inBounds = (x, z) => x >= 0 && z >= 0 && x < W && z < H;
  const fill = (arr, [x0, z0, w, h], v) => { for (let z = z0; z < z0 + h; z++) for (let x = x0; x < x0 + w; x++) if (inBounds(x, z)) arr[idx(x, z)] = v; };
  LAND.forEach(r => fill(land, r, 1));
  CARVE.forEach(r => fill(land, r, 0));
  for (const b of Object.values(BRIDGES)) for (const [x, z] of b.tiles) land[idx(x, z)] = 0;
  COPPER.forEach(r => fill(deposit, r, 1));
  STONE.forEach(r => fill(deposit, r, 2));
  for (let i = 0; i < n; i++) if (!land[i]) deposit[i] = 0;

  const isLand = (x, z) => inBounds(x, z) && land[idx(x, z)] === 1;
  const isBridge = (x, z) => inBounds(x, z) && bridge[idx(x, z)] > 0;
  const inRects = (rects, x, z) => rects.some(([x0, z0, w, h]) => x >= x0 && z >= z0 && x < x0 + w && z < z0 + h);
  const islandAt = (x, z) => Object.keys(ISLANDS).find(k => inRects(ISLANDS[k], x, z)) || null;

  // ---- props ----
  const props = [];
  const taken = new Uint8Array(n);
  const near = (rects, x, z) => inRects(rects, x, z);
  const free = (x, z) => isLand(x, z) && !taken[idx(x, z)] && !deposit[idx(x, z)] && !near(CAMP_CLEAR, x, z);
  const add = (kind, x, z) => { taken[idx(x, z)] = 1; props.push({ kind, x, z, variant: Math.floor(rng() * 4), rot: rng() * Math.PI * 2, scale: 0.88 + rng() * 0.24 }); };
  const DENSITY = { home: 0.0, forest: 0.62, north: 0.12, east: 0.1, south: 0.38, null: 0.3 };
  // home gets a hand-placed ring of trees around the camp so the first loop is close by
  const HOME_TREES = [[18, 19], [19, 19], [22, 19], [23, 19], [24, 18], [25, 18], [16, 18], [16, 19], [17, 19], [24, 20], [22, 21], [25, 17]];
  const ROCKS = [[24, 16], [15, 16], [17, 6], [23, 4], [25, 6], [20, 1], [18, 7], [22, 2], [36, 11], [37, 17], [32, 16], [35, 19], [17, 26], [23, 28]];
  for (const [x, z] of HOME_TREES) if (isLand(x, z) && !taken[idx(x, z)]) add('tree', x, z);
  for (const [x, z] of ROCKS) if (isLand(x, z) && !taken[idx(x, z)] && !deposit[idx(x, z)]) add('rock', x, z);
  for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
    if (!free(x, z)) continue;
    const isl = islandAt(x, z);
    if (isl === 'home') continue;
    const d = DENSITY[isl] ?? 0.3;
    const p = d * (0.55 + fbm2(x * 0.4, z * 0.4, 3, seed) * 0.9);
    if (hash2(x, z, seed + 3) < p) add('tree', x, z);
  }

  return {
    w: W, h: H, land, bridge, deposit, props, start: { ...START }, seed, kind: 'camp',
    idx, inBounds, isLand, isBridge, islandAt, islands: ISLANDS, bridges: BRIDGES,
    depositAt: (x, z) => (isLand(x, z) ? deposit[idx(x, z)] : 0),
    isGround: (x, z) => isLand(x, z) || isBridge(x, z),
    toAscii(extra = new Map()) {
      const p = new Map(props.map(q => [idx(q.x, q.z), q.kind === 'tree' ? 'T' : 'R']));
      let s = '';
      for (let z = 0; z < H; z++) {
        for (let x = 0; x < W; x++) {
          const i = idx(x, z);
          s += extra.get(i) || (x === START.x && z === START.z ? '@' : p.get(i) || (bridge[i] ? '=' : !land[i] ? (Object.values(BRIDGES).some(b => b.tiles.some(([bx, bz]) => bx === x && bz === z)) ? '~' : '.') : deposit[i] === 1 ? 'c' : deposit[i] === 2 ? 's' : '#'));
        }
        s += '\n';
      }
      return s;
    },
  };
}
