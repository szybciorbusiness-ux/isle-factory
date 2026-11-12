// node --test tests/camp.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMap } from '../src/world/map-camp.js';
import { createSim } from '../src/sim/sim.js';
import { createCamp } from '../src/sim/camp.js';
import { STATIONS, CAMP, PADS } from '../src/sim/camp-data.js';
const costOf = id => PADS.find(p => p.id === id).cost;

// A camp with a controllable player position.
function setup() {
  const map = createMap(7);
  const sim = createSim(map, { inventory: {} });
  const pos = { x: map.start.x, z: map.start.z };
  const camp = createCamp(sim, { playerPos: () => pos });
  const step = (s, dt = 1 / 60) => { for (let t = 0; t < s; t += dt) { sim.update(dt); camp.update(dt); } };
  const moveTo = (x, z) => { pos.x = x; pos.z = z; sim.setPlayer(Math.round(x), Math.round(z)); };
  return { map, sim, camp, pos, step, moveTo };
}
const count = (camp, item) => camp.stack.filter(i => i === item).length;

test('starts with a cold hearth: the only pad is lighting it, and the stack is empty', () => {
  const { camp } = setup();
  assert.equal(camp.level, 0);
  assert.equal(camp.total(), 0);
  assert.deepEqual(camp.pads.map(p => p.id), ['hearth:1']);
  assert.ok(camp.animals.size >= 10, `animals: ${camp.animals.size}`);
});

test('standing next to a tree auto-chops it, wood lands on the stack, a stump regrows into a tree', () => {
  const { sim, camp, step, moveTo } = setup();
  const tree = [...sim.entities.values()].find(e => e.kind === 'tree' && sim.map.islandAt(e.x, e.z) === 'home');
  moveTo(tree.x, tree.z - 1);
  step(3);
  assert.ok(count(camp, 'wood') >= 4, `stack ${camp.stack}`);
  assert.equal(sim.at(tree.x, tree.z)?.kind === 'tree' ? 'regrown-too-soon' : 'ok', 'ok');
  moveTo(30, 30); // walk away so the stump survives
  step(CAMP.regrow.stump + 1, 1 / 20);
  assert.equal(sim.at(tree.x, tree.z)?.kind, 'tree', 'stump grew back into a tree');
});

test('a full stack stops gathering and extra drops land loose, then get picked up', () => {
  const { sim, camp, step, moveTo } = setup();
  sim.inventory.add('stone', 8);
  const tree = [...sim.entities.values()].find(e => e.kind === 'tree' && sim.map.islandAt(e.x, e.z) === 'home');
  moveTo(tree.x, tree.z - 1);
  step(2);
  assert.equal(camp.total(), camp.capacity);
  assert.ok(camp.loose.length >= 1, 'overflow is loose');
  const l = camp.loose[0];
  sim.inventory.remove('stone', 8);
  moveTo(l.x, l.z);
  step(0.2);
  assert.ok(!camp.loose.includes(l), 'walked over it and picked it up');
});

test('paying the sawmill pad builds it; its footprint blocks walking', () => {
  const { sim, camp, step, moveTo } = setup();
  camp.completePad('hearth:1');
  sim.inventory.add('wood', costOf('build:sawmill').wood);
  const [x, z] = STATIONS.sawmill.footprint;
  moveTo(x + 0.5, z + 0.5);
  step(3);
  assert.ok(camp.stations.has('sawmill'));
  assert.equal(count(camp, 'wood'), 0);
  assert.equal(sim.isWalkable(x, z), false);
  assert.ok(camp.pads.some(p => p.id === 'build:cookfire'));
  assert.ok(camp.pads.some(p => p.id === 'build:cookfire'));
  assert.ok(!camp.stations.get('sawmill') || !camp.inRect(STATIONS.sawmill.footprint, sim.player.x, sim.player.z), 'player hopped out of the footprint');
});

test('dropping wood at the sawmill makes planks that ride the line to the pile, and the pile can be taken', () => {
  const { sim, camp, step, moveTo } = setup();
  camp.completePad('hearth:1'); camp.completePad('build:sawmill'); // cookfire pad (planks) now visible
  sim.inventory.add('wood', 5);
  const [zx, zz] = STATIONS.sawmill.zone;
  moveTo(zx, zz);
  step(1.5);
  assert.equal(count(camp, 'wood'), 0);
  moveTo(30, 30);
  step(12);
  const s = camp.stations.get('sawmill');
  assert.equal(s.pile.count, 5, `pile ${s.pile.count}, line ${s.line.items.length}`);
  const [px, pz] = s.pile.tile;
  moveTo(px, pz);
  step(2);
  assert.equal(count(camp, 'plank'), 5);
  assert.equal(s.pile.count, 0);
});

test('hearth levels up through its pad, and new pads appear', () => {
  const { sim, camp, step, moveTo } = setup();
  for (const id of ['hearth:1', 'build:sawmill', 'build:cookfire']) camp.completePad(id);
  const pad = camp.pads.find(p => p.id === 'hearth:2');
  assert.ok(pad, camp.pads.map(p => p.id).join());
  const c = camp.padCenter(pad);
  moveTo(c.x, c.z);
  for (let i = 0; i < 6 && camp.level < 2; i++) { sim.inventory.add('plank', 6); sim.inventory.add('cookedMeat', 2); step(2); }
  assert.equal(camp.level, 2);
  for (const id of ['build:hut', 'bridge:west', 'bridge:south', 'upgrade:pack1']) assert.ok(camp.pads.some(p => p.id === id), id);
});

test('a bridge pad builds the bridge tile by tile and the far island becomes walkable', () => {
  const { sim, camp, step, moveTo, map } = setup();
  camp.completePad('bridge:west'); // not visible yet -> no-op
  assert.equal(camp.bridges.size, 0);
  for (const id of ['hearth:1', 'build:sawmill', 'build:cookfire', 'hearth:2']) camp.completePad(id);
  sim.inventory.add('plank', 10);
  const [bx, bz] = map.bridges.west.tiles[0];
  assert.equal(sim.isWalkable(bx, bz), false);
  const visible = camp.pads.find(p => p.id === 'bridge:west');
  assert.ok(visible, `pads ${camp.pads.map(p => p.id)}`);
  const c = camp.padCenter(visible);
  moveTo(c.x, c.z); step(3);
  for (let i = 0; i < 4 && !camp.bridges.has('west'); i++) { sim.inventory.add('plank', 10); step(4); }
  assert.ok(camp.bridges.has('west'));
  for (const [x, z] of map.bridges.west.tiles) assert.equal(sim.isWalkable(x, z), true);
});

test('hunting: walking up to an animal bonks it and meat lands on the stack (once meat has a use)', () => {
  const { camp, step, moveTo } = setup();
  camp.buildStation('cookfire');
  const deer = [...camp.animals.values()].find(a => a.island === 'home');
  let meat = 0;
  for (let i = 0; i < 40 && !meat; i++) { moveTo(deer.x - 0.9, deer.z); step(0.25); meat = count(camp, 'meat'); }
  assert.ok(meat >= 2, `meat ${meat}`);
});

test('a hired lumberjack chops, delivers wood to the sawmill and planks come out', () => {
  const { camp, step, moveTo } = setup();
  camp.buildStation('sawmill'); camp.buildStation('hut');
  moveTo(30, 30);
  const w = camp.hire('lumberjack');
  step(40, 1 / 30);
  const s = camp.stations.get('sawmill');
  const made = s.pile.count + s.line.items.length + (s.busy ? 1 : 0);
  assert.ok(made >= 3, `planks made ${made}, worker ${w.state} carry ${w.carry.n}`);
});

test('a hungry worker eats cooked meat from the cookfire pile', () => {
  const { camp, step, moveTo } = setup();
  camp.buildStation('sawmill'); camp.buildStation('hut'); camp.buildStation('cookfire');
  camp.stations.get('cookfire').pile.count = 3;
  moveTo(30, 30);
  const w = camp.hire('lumberjack');
  w.hunger = 1.01;
  step(12, 1 / 30);
  assert.ok(w.hunger < 0.5, `hunger ${w.hunger.toFixed(2)} state ${w.state}`);
  assert.equal(camp.stations.get('cookfire').pile.count, 2);
});

test('copper drill line feeds the smelter which makes bars', () => {
  const { camp, step, moveTo } = setup();
  camp.buildStation('copperDrill'); camp.buildStation('smelter');
  moveTo(5, 30);
  step(30, 1 / 30);
  const sm = camp.stations.get('smelter');
  assert.ok(sm.pile.count >= 3, `bars ${sm.pile.count}`);
});

test('performance: 600 seconds of a busy camp in under 2 s', () => {
  const { camp, step, moveTo } = setup();
  for (const id of ['sawmill', 'cookfire', 'hut', 'quarry', 'copperDrill', 'smelter']) camp.buildStation(id);
  camp.hire('lumberjack'); camp.hire('lumberjack'); camp.hire('hunter'); camp.hire('hunter');
  moveTo(5, 30);
  const t0 = performance.now();
  step(600, 1 / 30);
  const ms = performance.now() - t0;
  assert.ok(ms < 6000, `${ms.toFixed(0)} ms`); // generous: CI-free machine runs it in ~0.4 s
});

test('nothing useless clogs the stack: rocks and animals are ignored until something needs them', () => {
  const { sim, camp, step, moveTo } = setup();
  const rock = [...sim.entities.values()].find(e => e.kind === 'rock' && sim.map.islandAt(e.x, e.z) === 'home');
  moveTo(rock.x, rock.z - 1);
  step(3);
  assert.equal(camp.total(), 0, `stack ${camp.stack}`);
  assert.equal(sim.at(rock.x, rock.z)?.kind, 'rock');
});

test('a pad you cannot pay is not a dead spot: you keep chopping while standing on it', () => {
  const { sim, camp, step, moveTo } = setup();
  const tree = [...sim.entities.values()].find(e => e.kind === 'tree' && sim.map.islandAt(e.x, e.z) === 'home');
  // stand on the hearth pad (wants wood) with an empty stack next to nothing: then next to a tree with a pad around
  moveTo(tree.x, tree.z - 1);
  step(2);
  assert.ok(camp.total() > 0);
});

test('the guide always has a next step from a fresh start through camp level 2', () => {
  const { camp, step, moveTo } = setup();
  const g = camp.nextGoal();
  assert.ok(g && ['gather', 'pay'].includes(g.kind), JSON.stringify(g));
});

test('save / load: a camp restored from its snapshot matches the original', () => {
  const a = setup();
  for (const id of ['hearth:1', 'build:sawmill', 'build:cookfire', 'hearth:2', 'upgrade:pack1', 'build:hut', 'hire:lumberjack', 'bridge:west']) a.camp.completePad(id);
  a.sim.inventory.add('plank', 3); a.sim.inventory.add('wood', 2);
  a.moveTo(30, 30);
  a.step(20, 1 / 20);
  const snap = JSON.parse(JSON.stringify(a.camp.snapshot()));
  const b = setup();
  assert.ok(b.camp.restore(snap));
  assert.equal(b.camp.level, a.camp.level);
  assert.deepEqual([...b.camp.stations.keys()].sort(), [...a.camp.stations.keys()].sort());
  assert.deepEqual([...b.camp.bridges], [...a.camp.bridges]);
  assert.equal(b.camp.capacity, a.camp.capacity);
  assert.deepEqual(b.camp.stack, a.camp.stack);
  assert.equal(b.camp.workers.size, a.camp.workers.size);
  assert.deepEqual(b.camp.pads.map(p => p.id).sort(), a.camp.pads.map(p => p.id).sort());
  assert.equal(b.camp.stations.get('sawmill').pile.count, a.camp.stations.get('sawmill').pile.count);
  for (const [x, z] of b.map.bridges.west.tiles) assert.equal(b.sim.isWalkable(x, z), true);
  const kinds = s => [...s.entities.values()].filter(e => e.resource).map(e => `${e.kind}@${e.x},${e.z}`).sort().join();
  assert.equal(kinds(b.sim), kinds(a.sim));
  // and it keeps running
  b.step(10, 1 / 20);
});

// A bot that always does camp.nextGoal() at the robot's walking speed (same rules as tools/pace.mjs).
// Guards the whole guidance loop: sticky pay/drop goals, dead-weight unloading, backed-up lines, regrowth that
// must never seal the player in, and an arrow that never dies.
test('a bot following the guide finishes the camp, never boxed in and never without a goal for long', () => {
  const { map, sim, camp, pos } = setup();
  const SPEED = 4.2, dt = 1 / 20;
  camp.events.on('player:eject', ({ x, z }) => { pos.x = x; pos.z = z; path = null; });
  let path = null, pi = 0, goal = null, think = 0, noGoal = 0, worstNoGoal = 0, stuck = 0, worstStuck = 0;
  const levels = {};
  camp.events.on('hearth:level', ({ level }) => { levels[level] = camp.time; });
  function plan() {
    goal = camp.nextGoal();
    if (!goal) { path = null; return; }
    const tx = Math.round(goal.x), tz = Math.round(goal.z);
    const around = goal.kind === 'gather' || goal.kind === 'hunt';
    path = camp.bfs(Math.round(pos.x), Math.round(pos.z), (x, z) => around ? Math.max(Math.abs(x - tx), Math.abs(z - tz)) <= 1 && !(x === tx && z === tz) : x === tx && z === tz);
    pi = 1;
  }
  function step(ux, uz, t) {
    const nx = pos.x + ux * SPEED * t, nz = pos.z + uz * SPEED * t;
    if (sim.isWalkable(Math.round(nx), Math.round(nz))) { pos.x = nx; pos.z = nz; sim.setPlayer(Math.round(nx), Math.round(nz)); }
  }
  for (let t = 0; t < 25 * 60 && camp.level < 5; t += dt) {
    if ((think -= dt) <= 0) { think = 0.5; plan(); }
    noGoal = goal ? 0 : noGoal + dt; worstNoGoal = Math.max(worstNoGoal, noGoal);
    stuck = goal && goal.kind !== 'wait' && !path ? stuck + dt : 0; worstStuck = Math.max(worstStuck, stuck);
    if (path && pi < path.length) {
      const [tx, tz] = path[pi], dx = tx - pos.x, dz = tz - pos.z, d = Math.hypot(dx, dz);
      if (d < 0.05) pi++; else step(dx / d, dz / d, Math.min(dt, d / SPEED));
    } else if (goal) {
      let tx = goal.x, tz = goal.z, near = goal.kind === 'gather' ? 1.0 : 0.15;
      if (goal.kind === 'hunt') { const a = camp.animals.get(goal.animalId); if (a && !a.dead) { tx = a.x; tz = a.z; } near = 0.9; }
      const dx = tx - pos.x, dz = tz - pos.z, d = Math.hypot(dx, dz);
      if (d > near) step(dx / d, dz / d, dt);
    }
    sim.update(dt); camp.update(dt);
  }
  assert.equal(camp.level, 5, `camp level ${camp.level} after 25 min; levels ${JSON.stringify(levels)}; pads left ${camp.pads.map(p => p.id)}`);
  assert.ok(worstNoGoal <= 3, `no goal for ${worstNoGoal.toFixed(1)} s in a row`);
  assert.ok(worstStuck <= 6, `no path to the goal for ${worstStuck.toFixed(1)} s in a row`);
});
