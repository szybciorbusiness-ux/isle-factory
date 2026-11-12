// Simulation rules: resources, inventory, crafting, drills, workshops, chests, building, player, scenarios.
// Run all sim tests with: node --test tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMap } from '../src/world/map.js';
import { createSim, beltPath, PLAYER_RADIUS } from '../src/sim/sim.js';
import { runScenario, SCENARIO_NAMES } from '../src/debug/scenarios.js';
import { BUILDINGS, DIRS, PLAYER, RECIPES, START_INVENTORY } from '../src/config.js';
import {
  E, S, W, N, DT, makeSim, run, place, belt, line, census, ledger, assertConserved, beltItems, assertNoOverlap, assertBeltsValid,
} from './helpers.test.mjs';

const realSim = () => { const map = createMap(7); return { map, sim: createSim(map) }; };
const record = (sim, ...types) => { const log = []; for (const t of types) sim.events.on(t, p => log.push([t, p])); return log; };
const clearTile = (sim, x, z) => { for (let i = 0; i < 12; i++) { const e = sim.at(x, z); if (!e?.resource) return; sim.hitResource(e.id); } };
const kinds = sim => { const c = {}; for (const e of sim.entities.values()) if (!e.resource) c[e.kind] = (c[e.kind] || 0) + 1; return c; };
// every belt hands on to another belt, chest or workshop (no dead ends where items would pile up)
const openEnds = sim => [...sim.belts].filter(b => !sim.at(b.x + DIRS[b.dir][0], b.z + DIRS[b.dir][1])).map(b => `${b.x},${b.z}`);
// resources within chopping reach of a tile
const inReach = (sim, x, z) => [...sim.entities.values()].filter(e => e.resource && Math.hypot(e.x - x, e.z - z) <= PLAYER.reach + 1e-6);

// ---------- scenarios ----------
// What a scenario must keep in frame around the player (the camera target), in tiles: [half width, rows north,
// rows south]. Landscape shows ~16 x 10 tiles; a phone ~10 across, and the bottom of the screen belongs to the
// HUD / touch controls, so a layout sits a little north of the player there.
const FRAME = { landscape: [7, 4, 3], portrait: [4, 7, 4] };

test('factory scenario: everything placed by the copper patch, produces copper plates into the chest', () => {
  const { map, sim } = realSim();
  runScenario('factory', { sim, map });
  assert.deepEqual(kinds(sim), { drill: 3, belt: 8, workshop: 2, chest: 2 });
  assert.deepEqual(openEnds(sim), []);
  // framed by the patch: the player (camera target) stands in the middle of the factory, on free land
  assert.deepEqual([sim.player.x, sim.player.z], [28, 14]);
  assert.ok(Math.hypot(sim.player.x - 31, sim.player.z - 13) <= 4);
  assert.ok(sim.at(28, 14) === null && sim.isWalkable(28, 14));
  assert.deepEqual(
    { belt: sim.inventory.get('belt'), drill: sim.inventory.get('drill'), chest: sim.inventory.get('chest'), workshop: sim.inventory.get('workshop') },
    { belt: 22, drill: 1, chest: 2, workshop: 0 }, 'starting stock minus what was placed');
  assert.deepEqual([sim.inventory.get('wood'), sim.inventory.get('stone')], [20, 20], 'clearing the site pays nothing');
  // every building and the whole copper patch frame around the player in landscape and on a phone
  for (const [rx, n0, s0] of [FRAME.landscape, FRAME.portrait]) {
    const pts = [...sim.entities.values()].filter(e => !e.resource).map(e => [e.x, e.z]);
    for (let z = 0; z < map.h; z++) for (let x = 0; x < map.w; x++) if (map.depositAt(x, z) === 1 && Math.hypot(x - 31, z - 13) < 3) pts.push([x, z]);
    for (const [x, z] of pts) {
      assert.ok(Math.abs(x - sim.player.x) <= rx && z - sim.player.z >= -n0 && z - sim.player.z <= s0, `${x},${z} out of frame (${rx})`);
    }
  }
  run(sim, 40);
  const chest = sim.at(25, 17);
  assert.equal(chest.kind, 'chest');
  assert.ok((chest.items.copperPlate || 0) >= 5, `chest has ${JSON.stringify(chest.items)}`);
});

test('forest scenario puts the player next to trees and a rock, facing a tree', () => {
  const { map, sim } = realSim();
  runScenario('forest', { sim, map });
  const { x, z, dir } = sim.player;
  assert.ok(map.isLand(x, z) && sim.at(x, z) === null && sim.isWalkable(x, z), `standing on ${x},${z}`);
  const near = inReach(sim, x, z);
  assert.ok(near.filter(e => e.kind === 'tree').length >= 2, `trees by ${x},${z}`);
  assert.ok(near.some(e => e.kind === 'rock'), `a rock by ${x},${z}`);
  assert.equal(sim.at(x, z + 1)?.resource, undefined, 'nothing between the critter and the camera');
  assert.equal(sim.nearestResource(x, z, PLAYER.reach, dir)?.kind, 'tree', 'Space / E would chop a tree');
  // on the current map: a side-on swing at the tree straight east
  assert.deepEqual([x, z, dir], [15, 11, E]);
  assert.equal(sim.at(x + DIRS[dir][0], z + DIRS[dir][1])?.kind, 'tree');
  assert.ok(Math.hypot(x - map.start.x, z - map.start.z) < 12, 'not far from the start');
});

for (const portrait of [false, true]) {
  test(`belts scenario (${portrait ? 'portrait' : 'landscape'}): a lively loop with curves and a side-load merge, never jams`, () => {
    const { map, sim } = realSim();
    runScenario('belts', { sim, map, portrait });
    assert.equal(sim.belts.size, 24, 'loop of 22 + a stick of 2, nothing in the way');
    assert.deepEqual(openEnds(sim), [], 'closed loop');
    const shapes = new Set([...sim.belts].map(b => b.shape));
    assert.ok(shapes.has('left') && shapes.has('right') && shapes.has('straight'), [...shapes].join());
    const pl = sim.player;
    assert.ok(sim.isWalkable(pl.x, pl.z) && !sim.at(pl.x, pl.z), 'player on free ground');
    const [rx, n0, s0] = portrait ? FRAME.portrait : FRAME.landscape;
    for (const b of sim.belts) {
      assert.ok(Math.abs(b.x - pl.x) <= rx && b.z - pl.z >= -n0 && b.z - pl.z <= s0, `belt ${b.x},${b.z} out of frame of ${pl.x},${pl.z}`);
    }
    // nothing tall right in front of a belt (south of it) hides it from the camera
    for (const b of sim.belts) assert.notEqual(sim.at(b.x, b.z + 1)?.kind, 'tree', `tree in front of ${b.x},${b.z}`);
    assert.ok(Math.hypot(pl.x - map.start.x, pl.z - map.start.z) <= 5, 'near the start');
    const n = beltItems(sim).length;
    assert.ok(n >= 20, `${n} items`);
    const before = census(sim);
    for (let i = 0; i < 60 * 40; i++) { sim.update(DT); if (i % 6 === 0) assertNoOverlap(sim, `belts ${i}`); }
    assert.deepEqual(census(sim), before, 'closed loop: nothing appears or disappears');
    // still flowing after 40 s
    const pos = () => new Map(beltItems(sim).map(({ b, it }) => [it.uid, beltPath(b, it.p)]));
    const a = pos(); run(sim, 1); const c = pos();
    let moving = 0; for (const [uid, p] of c) if (Math.hypot(p.x - a.get(uid).x, p.z - a.get(uid).z) > 0.5) moving++;
    assert.ok(moving >= n * 0.8, `${moving}/${n} items moving`);
  });
}

test('stress scenario: hundreds of loaded belts keep flowing', () => {
  const { map, sim } = realSim();
  runScenario('stress', { sim, map });
  assert.ok(sim.belts.size >= 200, `${sim.belts.size} belts`);
  assert.deepEqual(openEnds(sim), [], 'every snake loop is closed (none crosses a channel)');
  assert.ok(sim.isWalkable(sim.player.x, sim.player.z), 'player on free ground');
  const n = beltItems(sim).length;
  assert.ok(n >= 300, `${n} items`);
  run(sim, 5);
  assertNoOverlap(sim, 'stress');
  assertBeltsValid(sim, 'stress');
  assert.equal(beltItems(sim).length, n);
});

test('scenarios: known names only, starting stock goes through the inventory API', () => {
  assert.deepEqual(SCENARIO_NAMES, ['factory', 'forest', 'belts', 'stress']);
  assert.throws(() => runScenario('quests', realSim()), /unknown scenario/);
  for (const name of SCENARIO_NAMES) for (const portrait of [false, true]) {
    const { map, sim } = realSim();
    const log = record(sim, 'inventory:changed');
    runScenario(name, { sim, map, portrait });
    const tag = `${name}${portrait ? ' (portrait)' : ''}`;
    // replaying the events from the start stock gives the final counts: nothing was written behind the bus
    const replay = { ...START_INVENTORY };
    for (const [, p] of log) { replay[p.item] = (replay[p.item] || 0) + p.delta; assert.equal(p.total, replay[p.item], `${tag} ${p.item} total`); }
    for (const [k, n] of Object.entries(sim.inventory.counts)) assert.equal(n, replay[k] || 0, `${tag}: ${k}`);
    // the starting stock itself has no world source (nothing flies to the player)
    if (name !== 'forest') assert.ok(log.some(([, p]) => p.delta > 0 && !p.source), tag);
    // clearing the site for a layout pays nothing: a belt showcase starts with belts, not a pile of wood
    if (name === 'belts' || name === 'stress') {
      assert.ok(log.some(([, p]) => p.delta > 0 && p.source), `${tag}: something was cleared`);
      assert.deepEqual([sim.inventory.get('wood'), sim.inventory.get('stone')], [0, 0], tag);
    }
  }
});

// ---------- quests are off ----------
test('no quests: a whole play-through fires no quest event, metrics still count', () => {
  const { sim } = realSim();
  const fired = [];
  sim.events.on('*', (p, t) => { if (/^quest/.test(t)) fired.push(t); });
  assert.equal(sim.quest.done, true);
  assert.equal(sim.currentQuest(), null);
  // chop two trees, break two rocks, craft planks and a drill
  const res = [...sim.entities.values()];
  for (const t of res.filter(e => e.kind === 'tree').slice(0, 2)) for (let i = 0; i < 3; i++) sim.hitResource(t.id);
  for (const r of res.filter(e => e.kind === 'rock').slice(0, 2)) for (let i = 0; i < 4; i++) sim.hitResource(r.id);
  sim.mineDeposit(19, 6);
  assert.equal(sim.craft('plank', 2), 2); run(sim, 1.3);
  assert.equal(sim.craft('drill', 1), 1); run(sim, 1.3);
  // drill on the copper patch -> belts -> chest
  for (const [x, z] of [[29, 13], [29, 14], [29, 15]]) clearTile(sim, x, z);
  assert.ok(sim.place('drill', 30, 13, W).ok);
  assert.ok(sim.place('belt', 29, 13, S).ok);
  assert.ok(sim.place('belt', 29, 14, S).ok);
  assert.ok(sim.place('chest', 29, 15).ok);
  run(sim, 13);
  assert.deepEqual(fired, []);
  assert.equal(sim.quest.done, true);
  assert.equal(sim.currentQuest(), null);
  assert.equal(sim.metrics['felled.tree'], 2);
  assert.equal(sim.metrics['placed.drill.copper'], 1);
  assert.ok(sim.metrics['stored.copperOre'] >= 5, `stored ${sim.metrics['stored.copperOre']}`);
});

// ---------- resources ----------
test('tree -> stump -> gone, with events and wood', () => {
  const { sim } = realSim();
  const log = record(sim, 'resource:hit', 'resource:depleted');
  const tree = [...sim.entities.values()].find(e => e.kind === 'tree');
  assert.equal(sim.isWalkable(tree.x, tree.z), false);
  assert.deepEqual(sim.hitResource(tree.id, 2), { depleted: false });
  sim.hitResource(tree.id); const r = sim.hitResource(tree.id);
  assert.equal(r.depleted, true);
  assert.equal(sim.inventory.get('wood'), 4);
  const stump = sim.at(tree.x, tree.z);
  assert.equal(stump.kind, 'stump');
  assert.equal(r.replacedBy, stump);
  assert.equal(sim.entities.has(tree.id), false);
  assert.equal(stump.variant, tree.variant); assert.equal(stump.rot, tree.rot);
  const dep = log.find(([t]) => t === 'resource:depleted')[1];
  assert.equal(dep.entity, tree); assert.equal(dep.replacedBy, stump); assert.deepEqual(dep.drops, { wood: 4 });
  assert.equal(log.filter(([t]) => t === 'resource:hit')[0][1].fromDir, 2);
  const r2 = sim.hitResource(stump.id);
  assert.equal(r2.depleted, true); assert.equal(r2.replacedBy, null);
  assert.equal(sim.at(tree.x, tree.z), null);
  assert.equal(sim.inventory.get('wood'), 5);
  assert.equal(sim.isWalkable(tree.x, tree.z), true);
  assert.equal(sim.hitResource(stump.id), null, 'hitting something gone is a no-op');
  assert.equal(sim.metrics['felled.tree'], 1);
  assert.equal(sim.metrics['collected.wood'], 5);
});

test('rocks break into stone after 4 hits and leave nothing', () => {
  const { sim } = realSim();
  const rock = sim.at(16, 16); // one of the map's fixed rocks, on the centre isle by the start
  assert.equal(rock.kind, 'rock');
  assert.equal(sim.isWalkable(16, 16), false);
  for (let i = 0; i < 3; i++) assert.equal(sim.hitResource(rock.id).depleted, false);
  const r = sim.hitResource(rock.id);
  assert.equal(r.depleted, true); assert.equal(r.replacedBy, null);
  assert.equal(sim.inventory.get('stone'), 5);
  assert.equal(sim.at(16, 16), null);
  assert.equal(sim.isWalkable(16, 16), true);
});

test('mineDeposit: only bare deposit tiles', () => {
  const { sim } = realSim();
  const log = record(sim, 'deposit:mined');
  assert.equal(sim.mineDeposit(30, 12), 'copperOre');
  assert.equal(sim.mineDeposit(19, 6), 'stone');
  assert.equal(sim.mineDeposit(20, 14), null, 'no deposit');
  assert.equal(sim.mineDeposit(0, 0), null, 'water');
  assert.equal(sim.mineDeposit(-5, 99), null, 'out of bounds');
  sim.inventory.add('drill', 1);
  sim.place('drill', 31, 13, W);
  assert.equal(sim.mineDeposit(31, 13), null, 'built over');
  assert.deepEqual(log.map(([, p]) => p), [{ x: 30, z: 12, item: 'copperOre' }, { x: 19, z: 6, item: 'stone' }]);
  assert.equal(sim.inventory.get('copperOre'), 1);
  assert.equal(sim.metrics['collected.stone'], 1);
});

test('inventory events carry a world source when items come from the world', () => {
  const sim = makeSim({ deposits: [[3, 3, 1]], inventory: { wood: 2 } });
  const log = record(sim, 'inventory:changed');
  sim.mineDeposit(3, 3);
  assert.deepEqual(log.at(-1)[1], { item: 'copperOre', delta: 1, total: 1, source: { x: 3, z: 3 } });
  const chest = place(sim, 'chest', 5, 5);
  assert.deepEqual(log.at(-1)[1].source, null, 'placing spends from the inventory');
  assert.equal(log.at(-1)[1].delta, -1);
  sim.storeInChest(chest.id, 'wood', 2);
  sim.takeChest(chest.id);
  assert.deepEqual(log.at(-1)[1], { item: 'wood', delta: 2, total: 2, source: { x: 5, z: 5 } });
  sim.remove(chest.id);
  assert.deepEqual(log.at(-1)[1].source, { x: 5, z: 5 });
  sim.craft('plank', 1); run(sim, 1);
  assert.deepEqual(log.at(-1)[1], { item: 'plank', delta: 2, total: 2, source: null });
  const { sim: real } = realSim();
  const l2 = record(real, 'inventory:changed');
  const tree = [...real.entities.values()].find(e => e.kind === 'tree');
  for (let i = 0; i < 3; i++) real.hitResource(tree.id);
  assert.deepEqual(l2.at(-1)[1], { item: 'wood', delta: 4, total: 4, source: { x: tree.x, z: tree.z } });
});

// ---------- placement ----------
test('canPlace rules: water, bridge, occupied, player tile, deposits, unknown', () => {
  const { map, sim } = realSim();
  assert.equal(map.isLand(0, 0), false);
  assert.deepEqual(sim.canPlace('belt', 0, 0), { ok: false, reason: 'Can\'t build on water' });
  assert.ok(map.isBridge(10, 6));
  assert.deepEqual(sim.canPlace('chest', 10, 6), { ok: false, reason: 'Can\'t build on bridges' });
  assert.equal(sim.canPlace('belt', -1, 3).ok, false);
  const tree = [...sim.entities.values()].find(e => e.kind === 'tree');
  assert.deepEqual(sim.canPlace('belt', tree.x, tree.z), { ok: false, reason: 'Something is already here' });
  const { x, z } = sim.player;
  assert.deepEqual(sim.canPlace('chest', x, z), { ok: false, reason: 'You\'re standing there' });
  assert.equal(sim.canPlace('belt', x, z).ok, true, 'belts are walkable, fine under the player');
  assert.deepEqual(sim.canPlace('drill', 20, 12), { ok: false, reason: 'Drills go on ore or stone deposits' });
  assert.equal(sim.canPlace('drill', 30, 13).ok, true);
  assert.equal(sim.canPlace('drill', 19, 6).ok, true);
  assert.equal(sim.canPlace('castle', 20, 12).ok, false);
  // place() also needs the item
  const r = sim.place('drill', 30, 13, W);
  assert.equal(r.ok, false); assert.match(r.reason, /No drills left/);
  sim.inventory.add('drill', 1);
  const ok = sim.place('drill', 30, 13, W);
  assert.equal(ok.ok, true); assert.equal(ok.entity.deposit, 'copper'); assert.equal(ok.entity.output, 'copperOre');
  assert.equal(sim.inventory.get('drill'), 0);
  assert.equal(sim.isWalkable(30, 13), false);
  assert.equal(sim.metrics['placed.drill.copper'], 1);
  // chests are not rotatable: always face south
  const c = sim.place('chest', 21, 12, W).entity;
  assert.equal(c.dir, S); assert.equal(sim.rotate(c.id), false);
  // bad direction values are normalised
  const b = sim.place('belt', 22, 12, -1).entity;
  assert.equal(b.dir, N);
  assert.equal(START_INVENTORY.belt, 10);
});

test('remove() returns the building and everything in it', () => {
  const sim = makeSim({ deposits: [[2, 2, 1]], inventory: { copperOre: 10 } });
  const bl = line(sim, 4, 5, E, 2);
  sim.spawnBeltItem(bl[0].id, 'stone', 0.2); sim.spawnBeltItem(bl[0].id, 'wood', 0.8);
  const inv = { ...sim.inventory.counts };
  assert.deepEqual(sim.remove(bl[0].id), { belt: 1, stone: 1, wood: 1 });
  assert.equal(sim.inventory.get('stone'), inv.stone + 1);
  assert.equal(sim.remove(bl[0].id), null, 'already gone');

  const chest = place(sim, 'chest', 8, 8);
  sim.storeInChest(chest.id, 'copperOre', 3);
  assert.deepEqual(sim.remove(chest.id), { chest: 1, copperOre: 3 });

  const ws = place(sim, 'workshop', 10, 10, E);
  sim.setRecipe(ws.id, 'copperPlate');
  sim.feedWorkshop(ws.id); // 4 ore
  run(sim, 0.2);           // started crafting: 2 ore in progress, 2 in the input
  assert.equal(ws.crafting, true);
  ws.output.copperPlate = 0;
  assert.deepEqual(sim.remove(ws.id), { workshop: 1, copperOre: 4 });

  const drill = place(sim, 'drill', 2, 2, E); // nothing in front: it mines one and holds it
  run(sim, BUILDINGS.drill.interval + 0.1);
  assert.equal(drill.held, 'copperOre');
  assert.deepEqual(sim.remove(drill.id), { drill: 1, copperOre: 1 });
  const { sim: real } = realSim();
  assert.equal(real.remove([...real.entities.values()].find(e => e.resource).id), null, 'resources are chopped, not removed');
});

test('items are conserved across a running factory with random building changes', () => {
  const sim = makeSim({
    w: 30, h: 30,
    deposits: [[2, 4, 1], [2, 5, 1], [2, 6, 1], [6, 2, 2], [7, 2, 2]],
    inventory: { copperOre: 20, wood: 30, plank: 20, stone: 30 },
  });
  for (const z of [4, 5, 6]) place(sim, 'drill', 2, z, E);
  line(sim, 3, 4, S, 3);                 // (3, 4..6) south, drills side-load
  line(sim, 3, 7, E, 4);                 // (3..6, 7) east
  const ws = place(sim, 'workshop', 7, 7, E);
  sim.setRecipe(ws.id, 'copperPlate');
  line(sim, 8, 7, E, 3);
  place(sim, 'chest', 11, 7);
  place(sim, 'drill', 6, 2, S); place(sim, 'drill', 7, 2, S);
  line(sim, 6, 3, S, 3); line(sim, 7, 3, S, 2); // stone, (7,3..4) side-loads into (7,5)? no: into (7,5) which is empty
  place(sim, 'chest', 6, 6);
  const plank = place(sim, 'workshop', 12, 12, S);
  sim.setRecipe(plank.id, 'plank'); sim.feedWorkshop(plank.id);
  sim.craft('belt', 3); sim.craft('chest', 1);
  const start = census(sim), d = ledger(sim);
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let step = 0; step < 300; step++) {
    run(sim, 0.1 + rnd() * 0.3);
    const ents = [...sim.entities.values()].filter(e => !e.resource);
    const e = ents[Math.floor(rnd() * ents.length)];
    const r = rnd();
    if (r < 0.15) sim.remove(e.id);
    else if (r < 0.3) sim.rotate(e.id);
    else if (r < 0.35 && e.kind === 'workshop') sim.setRecipe(e.id, rnd() < 0.5 ? 'plank' : 'copperPlate');
    else if (r < 0.4 && e.kind === 'workshop') sim.takeWorkshop(e.id);
    else if (r < 0.45 && e.kind === 'chest') sim.takeChest(e.id);
    else if (r < 0.5 && e.kind === 'workshop') sim.feedWorkshop(e.id);
    else if (r < 0.6) { // put something back somewhere free
      const kinds = ['belt', 'belt', 'belt', 'chest', 'workshop', 'drill'];
      const k = kinds[Math.floor(rnd() * kinds.length)];
      sim.place(k, 2 + Math.floor(rnd() * 12), 2 + Math.floor(rnd() * 12), Math.floor(rnd() * 4));
    } else if (r < 0.62 && sim.craftQueue.length) sim.cancelCraft(0);
    else if (r < 0.64) sim.craft('plank', 1);
    assertConserved(sim, start, d, `step ${step}`);
    assertBeltsValid(sim, `step ${step}`);
  }
  assert.ok(Object.values(d).some(v => v !== 0), 'the factory actually produced things');
});

// ---------- drills ----------
test('drills output into belts, chests and workshops, and stall when blocked', () => {
  const sim = makeSim({ deposits: [[2, 2, 1], [2, 6, 1], [2, 10, 1], [2, 14, 2]] });
  const log = record(sim, 'drill:mined', 'drill:output');
  const toBelt = place(sim, 'drill', 2, 2, E); const bl = line(sim, 3, 2, E, 3);
  const toChest = place(sim, 'drill', 2, 6, E); const chest = place(sim, 'chest', 3, 6);
  const toWs = place(sim, 'drill', 2, 10, E); const ws = place(sim, 'workshop', 3, 10, E);
  const blocked = place(sim, 'drill', 2, 14, E);
  sim.setRecipe(ws.id, 'copperPlate');
  run(sim, BUILDINGS.drill.interval * 3 + 0.05);
  assert.equal(chest.items.copperOre, 3);
  assert.equal(beltItems(sim).length, 3);
  assert.equal(bl[0].items.length + bl[1].items.length + bl[2].items.length, 3);
  // drill:output names the belt item it created
  const outs = log.filter(([t, p]) => t === 'drill:output' && p.entity === toBelt).map(([, p]) => p);
  assert.equal(outs.length, 3);
  assert.ok(outs.every(p => p.target === bl[0] && p.uid > 0));
  assert.deepEqual(new Set(beltItems(sim).map(x => x.it.uid)), new Set(outs.map(p => p.uid)));
  // nothing in front of the stone drill: it holds one item and stops working
  assert.equal(blocked.held, 'stone'); assert.equal(blocked.working, false);
  const frozen = blocked.timer;
  run(sim, 3);
  assert.equal(blocked.timer, frozen);
  assert.equal(sim.metrics['mined.stone'], 1);
  // giving it somewhere to go resumes it
  const c2 = place(sim, 'chest', 3, 14);
  run(sim, 0.05);
  assert.equal(c2.items.stone, 1); assert.equal(blocked.working, true);
  // the workshop got its ore straight from the drill
  assert.ok((ws.input.copperOre || 0) + (ws.crafting ? 2 : 0) >= 2, JSON.stringify(ws));
  void toChest; void toWs;
});

test('a drill feeding a workshop stalls once the workshop is full and resumes when emptied', () => {
  const sim = makeSim({ deposits: [[2, 2, 1]] });
  const drill = place(sim, 'drill', 2, 2, E);
  const ws = place(sim, 'workshop', 3, 2, E); // outputs east into nothing
  sim.setRecipe(ws.id, 'copperPlate');
  run(sim, 120);
  const cap = BUILDINGS.workshop.outputBuffer;
  assert.equal(ws.output.copperPlate, cap, 'output buffer full');
  assert.equal(ws.crafting, false);
  assert.equal(ws.input.copperOre, 4, 'input buffer holds 2x the recipe');
  assert.equal(drill.held, 'copperOre'); assert.equal(drill.working, false);
  assert.equal(sim.workshopAccepts(ws, 'copperOre'), false);
  assert.deepEqual(sim.takeWorkshop(ws.id), { copperPlate: cap });
  run(sim, 0.1);
  assert.equal(ws.crafting, true, 'resumes crafting');
  assert.equal(drill.held, null, 'drill unblocked');
  run(sim, 6);
  assert.ok(ws.output.copperPlate >= 2);
});

// ---------- workshops ----------
test('workshop recipe switching refunds the inputs and the job in progress', () => {
  const sim = makeSim({ inventory: { copperOre: 10, wood: 10 } });
  const ws = place(sim, 'workshop', 5, 5, E);
  const log = record(sim, 'workshop:recipe', 'inventory:changed');
  assert.equal(sim.setRecipe(ws.id, 'belt'), false, 'not a machine recipe');
  assert.equal(sim.setRecipe(ws.id, 'nope'), false);
  assert.equal(sim.setRecipe(ws.id, 'copperPlate'), true);
  assert.equal(sim.feedWorkshop(ws.id), 4);
  assert.equal(sim.feedWorkshop(ws.id), 0, 'input buffer full');
  assert.equal(sim.inventory.get('copperOre'), 6);
  run(sim, 0.5);
  assert.equal(ws.crafting, true); assert.equal(ws.input.copperOre, 2);
  assert.equal(sim.setRecipe(ws.id, 'copperPlate'), true, 'same recipe: no-op');
  assert.equal(ws.crafting, true);
  sim.setRecipe(ws.id, 'plank');
  assert.equal(sim.inventory.get('copperOre'), 10, 'all ore back');
  assert.equal(ws.crafting, false); assert.deepEqual(ws.input, {}); assert.equal(ws.recipe, 'plank');
  assert.ok(log.some(([t, p]) => t === 'inventory:changed' && p.source && p.source.x === 5));
  sim.feedWorkshop(ws.id); run(sim, 0.7);
  assert.equal(ws.output.plank, 2);
  sim.setRecipe(ws.id, null);
  assert.equal(ws.recipe, null);
  assert.equal(ws.output.plank, 2, 'finished products stay in the output');
  assert.equal(sim.feedWorkshop(ws.id), 0);
  assert.equal(log.filter(([t]) => t === 'workshop:recipe').length, 3);
});

test('workshop input buffer limits what belts deliver', () => {
  const sim = makeSim();
  const bl = line(sim, 2, 5, E, 4);
  const ws = place(sim, 'workshop', 6, 5, S);
  sim.setRecipe(ws.id, 'plank');
  for (const b of bl) for (const p of [0, 0.5]) sim.spawnBeltItem(b.id, 'wood', p);
  sim.spawnBeltItem(bl[3].id, 'stone', 0.99);
  run(sim, 3);
  // the stone at the front is not accepted: everything queues behind it
  assert.equal(bl[3].items[0].type, 'stone'); assert.equal(bl[3].items[0].p, 1);
  assert.equal(ws.input.wood || 0, 0);
  assertNoOverlap(sim);
  sim.remove(bl[3].id); belt(sim, 5, 5, E);
  run(sim, 3);
  assert.ok(ws.input.wood <= 2, `input ${ws.input.wood}`);
  assert.ok(ws.crafting || ws.output.plank > 0);
});

test('workshop output buffer stalls and resumes; outputs go onto a belt at its entry edge', () => {
  const sim = makeSim({ inventory: { wood: 100 } });
  const ws = place(sim, 'workshop', 5, 5, E);
  sim.setRecipe(ws.id, 'plank');
  const log = record(sim, 'workshop:output', 'workshop:crafted');
  for (let i = 0; i < 12; i++) { sim.feedWorkshop(ws.id); run(sim, 0.7); }
  const total = Object.values(ws.output).reduce((a, b) => a + b, 0);
  assert.ok(total <= BUILDINGS.workshop.outputBuffer, `${total}`);
  assert.ok(total >= BUILDINGS.workshop.outputBuffer - RECIPES.plank.outputs.plank, `${total}`);
  assert.equal(ws.crafting, false);
  const b = belt(sim, 6, 5, E);
  run(sim, 0.05); // the output timer is long due: the first plank leaves at once, the next one 0.3 s later
  assert.equal(b.items.length, 1);
  assert.ok(b.items[0].p < 0.1, 'enters at the entry edge');
  const out = log.filter(([t]) => t === 'workshop:output').at(-1)[1];
  assert.equal(out.uid, b.items[0].uid); assert.equal(out.target, b);
  sim.feedWorkshop(ws.id);
  run(sim, 3);
  assert.ok(log.filter(([t]) => t === 'workshop:crafted').length > 5);
});

// ---------- crafting ----------
test('crafting queue: ingredients up front, cancel refunds, timing carries over', () => {
  const sim = makeSim({ inventory: { wood: 3, stone: 1, plank: 0 } });
  const log = record(sim, 'craft:queued', 'craft:done', 'craft:cancelled', 'toast');
  assert.equal(sim.canCraft('plank', 3), true); assert.equal(sim.canCraft('plank', 4), false);
  assert.equal(sim.maxCraftable('plank'), 3);
  assert.equal(sim.maxCraftable('nope'), 0);
  assert.equal(sim.craft('nope'), 0);
  assert.equal(sim.craft('plank', 5), 3);
  assert.equal(sim.inventory.get('wood'), 0);
  assert.equal(sim.craftQueue.length, 3);
  assert.equal(sim.cancelCraft(1), true);
  assert.equal(sim.inventory.get('wood'), 1);
  assert.equal(sim.cancelCraft(7), false);
  assert.equal(sim.craft('belt', 1), 0, 'needs a plank');
  assert.match(log.find(([t]) => t === 'toast')[1].text, /Need 1 plank/);
  run(sim, RECIPES.plank.time * 2 + 0.02);
  assert.equal(sim.inventory.get('plank'), 4);
  assert.equal(sim.craftQueue.length, 0);
  assert.equal(log.filter(([t]) => t === 'craft:done').length, 2);
  assert.equal(sim.metrics['crafted.plank'], 4);
  // one big frame finishes several jobs exactly
  sim.inventory.add('wood', 5);
  sim.craft('plank', 5);
  sim.update(RECIPES.plank.time * 5 + 1e-6);
  assert.equal(sim.craftQueue.length, 0);
  assert.equal(sim.inventory.get('plank'), 14);
});

// ---------- chests ----------
test('chests: capacity, take everything, store from the inventory', () => {
  const sim = makeSim({ inventory: { stone: 100, wood: 5, copperOre: 2 } });
  const c = place(sim, 'chest', 5, 5);
  const log = record(sim, 'chest:received', 'chest:taken');
  assert.equal(sim.storeInChest(c.id, 'stone', 70), 70);
  assert.equal(sim.storeInChest(c.id, 'stone'), BUILDINGS.chest.capacity - 70);
  assert.equal(c.total, BUILDINGS.chest.capacity);
  assert.equal(sim.storeInChest(c.id, 'wood'), 0, 'full');
  assert.deepEqual(sim.takeChest(c.id), { stone: BUILDINGS.chest.capacity });
  assert.equal(sim.takeChest(c.id), null, 'empty');
  assert.equal(sim.inventory.get('stone'), 100);
  assert.equal(sim.storeInChest(c.id, null), BUILDINGS.chest.capacity, 'null stores every raw resource, up to capacity');
  assert.deepEqual(c.items, { wood: 5, stone: BUILDINGS.chest.capacity - 5 });
  sim.takeChest(c.id);
  sim.inventory.remove('stone', 80);
  assert.equal(sim.storeInChest(c.id, null), 5 + 20 + 2);
  assert.deepEqual(c.items, { wood: 5, stone: 20, copperOre: 2 });
  assert.ok(log.some(([t, p]) => t === 'chest:received' && p.count === 70));
  assert.equal(sim.metrics['stored.stone'], 70 + 10 + 75 + 20);
});

// ---------- the player (free 8-direction walking) ----------
const BLOCKING = ['chest', 'workshop', 'drill'];
// Does a circle of radius r at (wx, wz) overlap tile (x, z)?
const overlaps = (wx, wz, x, z, r = PLAYER_RADIUS) => {
  const dx = Math.max(0, Math.abs(wx - x) - 0.5), dz = Math.max(0, Math.abs(wz - z) - 0.5);
  return dx * dx + dz * dz < r * r;
};

test('setPlayer: the tile under the centre, rounded; player:moved only on a new tile', () => {
  const sim = makeSim({ start: { x: 5, z: 5 } });
  const log = record(sim, 'player:moved');
  sim.setPlayer(5, 5, E);
  assert.equal(log.length, 0, 'same tile: no event');
  assert.equal(sim.player.dir, E);
  sim.setPlayer(6.4, 4.6, S); // world coordinates are rounded to the tile they fall on
  assert.deepEqual({ ...sim.player }, { x: 6, z: 5, dir: S, wx: 6, wz: 5 });
  assert.deepEqual(log.at(-1)[1], { x: 6, z: 5, dir: S });
  sim.setPlayer(6, 5, 7);  // bad dir values are normalised; non-integers keep the facing
  assert.equal(sim.player.dir, N);
  sim.setPlayer(6, 5, 1.7);
  assert.equal(sim.player.dir, N);
  sim.setPlayer(NaN, 3);
  assert.deepEqual([sim.player.x, sim.player.z], [6, 5], 'garbage is ignored');
  assert.equal(log.length, 1);
  // setPlayerPos: every frame, events only when the tile under the centre changes
  for (let x = 6; x <= 8.0001; x += 0.05) sim.setPlayerPos(x, 5.2);
  assert.deepEqual(log.slice(1).map(([, p]) => [p.x, p.z]), [[7, 5], [8, 5]]);
  assert.equal(sim.player.wx > 7.99 && sim.player.wz === 5.2, true);
  sim.setPlayerPos(8.1, 5.2, W);
  assert.equal(sim.player.dir, W, 'a facing change goes through too');
  assert.equal(log.length, 3);
});

test('a blocking building can never be placed where the player stands', () => {
  const deposits = [];
  for (let z = 2; z < 18; z++) for (let x = 2; x < 18; x++) deposits.push([x, z, 1]);
  const sim = makeSim({ w: 20, h: 20, deposits, start: { x: 5, z: 5 } });
  // standing on a tile (grid-style calls, integers only): that tile is refused, belts are fine under the feet
  sim.setPlayer(5, 5, E);
  for (const k of BLOCKING) {
    assert.deepEqual(sim.canPlace(k, 5, 5), { ok: false, reason: 'You\'re standing there' }, k);
    assert.equal(sim.place(k, 5, 5).ok, false, k);
  }
  assert.equal(sim.canPlace('belt', 5, 5).ok, true);
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1]]) assert.equal(sim.canPlace('chest', 5 + dx, 5 + dz).ok, true, 'neighbours are free');
  // with the exact position, the footprint also blocks a neighbour it overlaps...
  sim.setPlayerPos(5.4, 5.0);
  assert.equal(sim.canPlace('drill', 6, 5).ok, false, 'body reaches over the east edge');
  assert.equal(sim.canPlace('drill', 4, 5).ok, true);
  sim.setPlayerPos(5.4, 5.4);
  assert.equal(sim.canPlace('chest', 6, 6).ok, false, 'over the corner');
  sim.setPlayerPos(5.25, 5.25);
  assert.equal(sim.canPlace('chest', 6, 6).ok, true, 'corner clear');
  assert.equal(sim.canPlace('chest', 6, 5).ok, false);
  // ...but a stale one never: the view moving to a new tile with integers resets it to that tile's centre
  sim.setPlayerPos(5.45, 5);
  sim.setPlayer(6, 5, E);
  assert.deepEqual([sim.player.wx, sim.player.wz], [6, 5]);
  assert.equal(sim.canPlace('chest', 5, 5).ok, true, 'the tile we left is free again');
  assert.equal(sim.canPlace('chest', 6, 5).ok, false);

  // a long free walk (8 directions, 4.2 tiles/s, 60 fps) with build attempts all around the critter every frame:
  // nothing blocking ever ends up under its footprint, and sim.player is always the tile under its centre
  let wx = 9, wz = 9, seed = 99;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const eight = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  let heading = eight[0], placed = 0, refused = 0, walked = 0;
  sim.setPlayer(9, 9, E);
  for (let f = 0; f < 3000; f++) {
    if (f % 25 === 0) heading = eight[Math.floor(rnd() * 8)];
    const l = Math.hypot(heading[0], heading[1]), v = PLAYER.moveSpeed / 60;
    const nx = wx + (heading[0] / l) * v, nz = wz + (heading[1] / l) * v;
    // the view's own collision: never walk into a blocking tile or off the patch
    const blocked = [[nx, nz]].some(([px, pz]) => {
      for (let tz = Math.round(pz) - 1; tz <= Math.round(pz) + 1; tz++) for (let tx = Math.round(px) - 1; tx <= Math.round(px) + 1; tx++) {
        if (overlaps(px, pz, tx, tz) && (!sim.isWalkable(tx, tz) || tx < 3 || tz < 3 || tx > 16 || tz > 16)) return true;
      }
      return false;
    });
    if (!blocked) { walked += Math.hypot(nx - wx, nz - wz); wx = nx; wz = nz; } else heading = eight[Math.floor(rnd() * 8)];
    sim.setPlayerPos(wx, wz);
    assert.deepEqual([sim.player.x, sim.player.z], [Math.round(wx), Math.round(wz)]);
    const tx = Math.round(wx) + Math.floor(rnd() * 3) - 1, tz = Math.round(wz) + Math.floor(rnd() * 3) - 1;
    const r = sim.place(BLOCKING[f % 3], tx, tz, E);
    if (r.ok) {
      placed++;
      assert.equal(overlaps(wx, wz, tx, tz), false, `placed ${r.entity.kind} at ${tx},${tz} under the player at ${wx.toFixed(2)},${wz.toFixed(2)}`);
      if (rnd() < 0.9) sim.remove(r.entity.id); // keep the field open
    } else if (r.reason === 'You\'re standing there') refused++;
    for (const e of sim.entities.values()) {
      if (!e.resource && BUILDINGS[e.kind].blocking) assert.equal(overlaps(wx, wz, e.x, e.z), false, `${e.kind} at ${e.x},${e.z} overlaps the player`);
    }
  }
  assert.ok(placed > 50 && refused > 100 && walked > 60, `placed ${placed}, refused ${refused}, walked ${walked.toFixed(1)} tiles`);
});

test('nearestResource: nearest within reach, the facing direction wins ties and near-ties', () => {
  const sim = makeSim({ props: [['tree', 5, 4], ['rock', 6, 5], ['stump', 4, 6], ['tree', 8, 5]], start: { x: 5, z: 5 } });
  const at = (x, z) => sim.at(x, z);
  assert.equal(sim.nearestResource(5, 5, 0.9), null, 'nothing that close');
  assert.equal(sim.nearestResource(5, 5, PLAYER.reach), at(5, 4), 'equal distance, no facing: lower id');
  assert.equal(sim.nearestResource(5, 5, PLAYER.reach, E), at(6, 5));
  assert.equal(sim.nearestResource(5, 5, PLAYER.reach, N), at(5, 4));
  assert.equal(sim.nearestResource(5, 5, PLAYER.reach, S), at(4, 6), 'diagonal in front beats a neighbour to the side');
  assert.equal(sim.nearestResource(5, 5, PLAYER.reach, W), at(4, 6));
  // headings in radians (atan2(dz, dx)) and vectors work too
  assert.equal(sim.nearestResource(5, 5, PLAYER.reach, -Math.PI / 2), at(5, 4));
  assert.equal(sim.nearestResource(5, 5, PLAYER.reach, Math.PI / 2 + 0.01), at(4, 6));
  assert.equal(sim.nearestResource(5, 5, PLAYER.reach, [1, 0]), at(6, 5));
  assert.equal(sim.nearestResource(5, 5, PLAYER.reach, { x: 0, z: -2 }), at(5, 4));
  // a far target straight ahead loses to a near one
  assert.equal(sim.nearestResource(5, 5, 3.5, E), at(6, 5));
  // free walking: between the rock and the far tree, the facing decides even though the rock is nearer
  assert.equal(sim.nearestResource(7.3, 5, PLAYER.reach, E), at(8, 5));
  assert.equal(sim.nearestResource(7.3, 5, PLAYER.reach, W), at(6, 5));
  assert.equal(sim.nearestResource(7.3, 5, PLAYER.reach), at(8, 5), 'no facing: nearest');
  // only resources count, and only live ones
  place(sim, 'chest', 5, 6);
  assert.equal(sim.nearestResource(5, 6.4, 0.9), null, 'buildings are not resources');
  const tree = at(5, 4);
  for (let i = 0; i < 3; i++) sim.hitResource(tree.id);
  assert.equal(sim.nearestResource(5, 5, PLAYER.reach, N).kind, 'stump', 'the stump that replaced the tree');
  sim.hitResource(at(5, 4).id);
  assert.equal(sim.nearestResource(5, 5, PLAYER.reach, N), at(6, 5), 'gone: the next best');
  // edges of the map and bad input are safe
  assert.equal(sim.nearestResource(0, 0, 2), null);
  assert.equal(sim.nearestResource(-3, 99, 5), null);
  assert.equal(sim.nearestResource(NaN, 5, 2), null);
  assert.equal(sim.nearestResource(5, 5, -1), null);
  void E; void W; void N;
});
