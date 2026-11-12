// Debug scenarios: ?scenario=<name>[&warm=<seconds>]. They only use the public sim API, so they double
// as an integration check. Views pick up the entities through the normal build:placed events.
//
//   factory  a small running factory by the east copper patch (drills -> belts -> workshop -> chest)
//   forest   player standing next to trees and a rock (within PLAYER.reach), for chop / mine tests
//   belts    belt showcase on the centre isle by the start: straight runs, left + right curves, a side-load merge
//            and a loop that never stops (closed, seeded with items). Best without warm: the first seconds show
//            the stick's items merging and the loop backing up behind the junction. Portrait screens get the same
//            loop turned upright (5 x 10 tiles) so it fits the ~10 tiles a phone shows across.
//   stress   ~210 belts in snake loops over the isles with ~500 items, all flowing.
import { PLAYER } from '../config.js';

// Hit any resource on the tile until it is gone (tree -> stump -> nothing). The drops are taken back, so a
// scenario's stock is exactly what give() set, however many trees its layout had to clear.
function clear(sim, x, z) {
  const before = { ...sim.inventory.counts };
  for (let i = 0; i < 12; i++) {
    const e = sim.at(x, z);
    if (!e || !e.resource) break;
    sim.hitResource(e.id);
  }
  for (const [k, n] of Object.entries(sim.inventory.counts)) {
    const extra = n - (before[k] || 0);
    if (extra > 0) sim.inventory.remove(k, extra);
  }
}
// Starting stock for a scenario: tops the inventory up (or down) to these counts through the inventory API, so
// inventory:changed fires (no source: nothing flies, the HUD just settles before the first frame).
function give(sim, items) {
  for (const [k, n] of Object.entries(items)) {
    const d = n - sim.inventory.get(k);
    if (d > 0) sim.inventory.add(k, d);
    else if (d < 0) sim.inventory.remove(k, -d);
  }
}

const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const dirTo = ([x, z], [nx, nz]) => DIRS.findIndex(([dx, dz]) => dx === nx - x && dz === nz - z);
// Belts along a list of tiles, each pointing at the next one; `close` points the last one back at the first.
// Resources on the way are cleared first.
function lay(sim, pts, { close = false, lastDir = 0 } = {}) {
  const out = [];
  pts.forEach((p, i) => {
    const next = pts[i + 1] || (close ? pts[0] : null);
    clear(sim, p[0], p[1]);
    const r = sim.place('belt', p[0], p[1], next ? dirTo(p, next) : lastDir);
    if (r.ok) out.push(r.entity);
  });
  return out;
}
// Items along belts given in lane order, `gaps` (world units, cycled) apart. Spacing is enforced by the sim.
const ITEM_MIX = ['copperOre', 'stone', 'wood', 'copperPlate', 'plank'];
function seed(sim, belts, gaps, { phase = 0, types = ITEM_MIX } = {}) {
  let at = phase, total = 0, k = 0, n = 0;
  for (const b of belts) {
    const len = sim.beltLength(b);
    while (at < total + len - 1e-6) {
      if (sim.spawnBeltItem(b.id, types[n % types.length], (at - total) / len)) n++;
      at += gaps[k++ % gaps.length];
    }
    total += len;
  }
  return n;
}
// Hamiltonian loop over a w x h rectangle (h even): rows snake east / west over x0+1.., column x0 runs back
// north. Returns the belts in lane order. Lots of left and right curves.
function snake(sim, x0, z0, w, h) {
  const pts = [];
  for (let r = 0; r < h; r++) {
    for (let i = 0; i < w - 1; i++) pts.push([r % 2 === 0 ? x0 + 1 + i : x0 + w - 1 - i, z0 + r]);
  }
  for (let z = z0 + h - 1; z >= z0; z--) pts.push([x0, z]);
  return lay(sim, pts, { close: true });
}
// Resources within chopping reach of tile (x, z) (the 8 neighbours at reach 1.5), with their offsets.
function around(sim, x, z) {
  const out = [];
  const r = Math.floor(PLAYER.reach);
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      if ((!dx && !dz) || Math.hypot(dx, dz) > PLAYER.reach + 1e-6) continue;
      const e = sim.at(x + dx, z + dz);
      if (e?.resource) out.push({ e, dx, dz });
    }
  }
  return out;
}

// Portrait screen (the /phone simulator, a phone held upright, a tall window)? Layouts that are wider than
// ~9 tiles get a tall variant there. ctx.portrait (boolean) overrides; node tests without a window fall back
// to ctx.mobile.
function isPortrait(ctx) {
  if (typeof ctx.portrait === 'boolean') return ctx.portrait;
  const w = globalThis.innerWidth, h = globalThis.innerHeight;
  if (w > 0 && h > 0) return h > w;
  return !!ctx.mobile;
}

const SCENARIOS = {
  // A small running factory by the east copper patch:
  // 3 drills -> belt down x=29 -> curve west -> workshop (copper plates) -> belts -> chest.
  factory(ctx) {
    const { sim } = ctx;
    give(sim, { wood: 20, stone: 20, plank: 20, copperOre: 6, copperPlate: 10, belt: 30, drill: 4, chest: 4, workshop: 2 });
    const tiles = [[30, 12], [30, 13], [30, 14], [29, 12], [29, 13], [29, 14], [29, 15], [28, 15], [27, 15], [26, 15], [25, 15], [25, 16], [25, 17], [26, 13], [27, 13], [28, 13], [28, 12], [27, 12], [26, 12]];
    tiles.forEach(([x, z]) => clear(sim, x, z));
    // in the middle of it, next to the drill line: the camera frames the whole factory, the chest clear of the HUD
    sim.setPlayer(28, 14, 0);
    for (const z of [12, 13, 14]) sim.place('drill', 30, z, 2);
    for (const z of [12, 13, 14]) sim.place('belt', 29, z, 1);
    sim.place('belt', 29, 15, 2);
    sim.place('belt', 28, 15, 2);
    const ws = sim.place('workshop', 27, 15, 2).entity;
    if (ws) sim.setRecipe(ws.id, 'copperPlate');
    sim.place('belt', 26, 15, 2);
    sim.place('belt', 25, 15, 1);
    sim.place('belt', 25, 16, 1);
    sim.place('chest', 25, 17, 1);
    // a second, idle workshop + chest to show the other states
    sim.place('workshop', 27, 12, 1);
    sim.place('chest', 26, 12, 1);
  },

  // A free tile near the start with at least two trees and a rock within reach, facing a tree. Nothing may
  // stand right in front of it (south, toward the camera) or the critter is hidden; a tree straight east / west
  // is preferred (a side-on swing, like the reference), then one to the north.
  // On the current map: (15, 11), the centre isle's north-west corner: trees east and north-east, a rock
  // south-west, channels to the west and north.
  forest(ctx) {
    const { sim, map } = ctx;
    let best = null;
    for (let z = 0; z < map.h; z++) {
      for (let x = 0; x < map.w; x++) {
        if (!map.isLand(x, z) || sim.at(x, z) || sim.at(x, z + 1)?.resource) continue;
        const near = around(sim, x, z);
        const trees = near.filter(n => n.e.kind === 'tree'), rocks = near.filter(n => n.e.kind === 'rock');
        if (trees.length < 2 || !rocks.length) continue;
        const side = trees.find(n => n.dx && !n.dz), north = trees.find(n => !n.dx && n.dz < 0);
        const score = (side ? 0 : north ? 3 : 6) + (rocks.some(n => !n.dx || !n.dz) ? 0 : 2)
          + Math.hypot(x - map.start.x, z - map.start.z);
        if (!best || score < best.score) best = { x, z, score, face: side || north || trees[0] };
      }
    }
    if (!best) { sim.setPlayer(map.start.x, map.start.z, 1); return; }
    const { dx, dz } = best.face;
    sim.setPlayer(best.x, best.z, dx > 0 ? 0 : dx < 0 ? 2 : dz < 0 ? 3 : 1);
  },

  // A closed "6" on the centre isle, the same shape in both orientations (22 loop belts + a 2-belt stick).
  // Landscape (10 x 5 tiles): the stick (14..15, 12) feeds M = (16, 12) from behind; the loop runs east along
  // z = 12, turns right down x = 23 (the east channel is just beyond), right along z = 15, left at (18, 15),
  // right twice round (18, 16) / (16, 16) and comes back up x = 16, side-loading into M.
  // Portrait (phones, 5 x 10 tiles, the same "6" turned a quarter clockwise): the stick comes down the north
  // neck (20, 8..9) into M = (20, 10); the loop runs south down x = 20, west along z = 17, north up x = 17,
  // hooks round (16, 12) / (16, 10) and comes back east along z = 10, side-loading into M.
  // The player stands inside the loop, framed so the whole loop clears the HUD. Resources on the way are cleared.
  belts(ctx) {
    const { sim } = ctx;
    give(sim, { belt: 40, chest: 2 });
    const portrait = isPortrait(ctx);
    let loop, stick;
    if (portrait) {
      sim.setPlayer(18, 14, 1);
      loop = lay(sim, [
        [20, 10], [20, 11], [20, 12], [20, 13], [20, 14], [20, 15], [20, 16], [20, 17],
        [19, 17], [18, 17], [17, 17],
        [17, 16], [17, 15], [17, 14], [17, 13], [17, 12],
        [16, 12], [16, 11], [16, 10],
        [17, 10], [18, 10], [19, 10],
      ], { close: true });
      stick = lay(sim, [[20, 8], [20, 9]], { lastDir: 1 });
      // trees right in front of the top and bottom runs would hide them from the camera
      clear(sim, 17, 11); clear(sim, 18, 11); clear(sim, 18, 18);
    } else {
      sim.setPlayer(19, 14, 1);
      loop = lay(sim, [
        [16, 12], [17, 12], [18, 12], [19, 12], [20, 12], [21, 12], [22, 12], [23, 12],
        [23, 13], [23, 14], [23, 15],
        [22, 15], [21, 15], [20, 15], [19, 15], [18, 15],
        [18, 16], [17, 16], [16, 16],
        [16, 15], [16, 14], [16, 13],
      ], { close: true });
      stick = lay(sim, [[14, 12], [15, 12]], { lastDir: 0 });
    }
    // groups of three with breathing room between them, plus a compressed queue on the stick
    seed(sim, loop.slice(1), [0.3, 0.3, 0.95], { phase: 0.2 });
    seed(sim, stick, [0.28], { phase: 0.05, types: ['wood', 'copperOre'] });
  },

  // ~210 belts in five snake loops (centre isle, east copper isle, north stone isle, south isle, west forest
  // isle), each seeded with items 0.4 apart. Every loop sits on one isle, so all of them are closed.
  stress(ctx) {
    const { sim } = ctx;
    give(sim, { belt: 2000 });
    sim.setPlayer(13, 14, 1); // the neck between the forest isle and the centre isle
    const areas = [[14, 10, 10, 8], [25, 11, 10, 6], [16, 6, 8, 2], [15, 20, 9, 2], [7, 11, 6, 6]];
    areas.forEach(([x, z, w, h], i) => seed(sim, snake(sim, x, z, w, h), [0.4], { phase: 0.1 + i * 0.07 }));
  },
};

export const SCENARIO_NAMES = Object.keys(SCENARIOS);
export function runScenario(name, ctx) {
  const s = SCENARIOS[name];
  if (!s) throw new Error(`unknown scenario "${name}" (have: ${SCENARIO_NAMES.join(', ')})`);
  s(ctx);
}
