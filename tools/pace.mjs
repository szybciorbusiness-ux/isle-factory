// Pacing bot: plays the camp headless by always doing camp.nextGoal(), walking at the robot's real speed,
// and prints when each beat lands. Use it to tune src/sim/camp-data.js toward FIRST-20.md.
//   node tools/pace.mjs [minutes=25] [--verbose]
import { createMap } from '../src/world/map-camp.js';
import { createSim } from '../src/sim/sim.js';
import { createCamp } from '../src/sim/camp.js';
import { PLAYER } from '../src/config.js';

const minutes = Number(process.argv[2]) || 25;
const verbose = process.argv.includes('--verbose');
const map = createMap(7);
const sim = createSim(map, { inventory: {} });
const pos = { x: map.start.x, z: map.start.z };
const camp = createCamp(sim, { playerPos: () => pos });
const fmt = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

const log = [];
const note = (what) => log.push({ t: camp.time, what });
camp.events.on('pad:complete', ({ pad }) => note(`pad ${pad.id}`));
camp.events.on('player:eject', ({ x, z }) => { pos.x = x; pos.z = z; path = null; });
camp.events.on('hearth:level', ({ level }) => note(`** camp level ${level}`));
camp.events.on('bridge:built', ({ bridge }) => note(`bridge ${bridge.id} done`));
camp.events.on('worker:hired', ({ worker }) => note(`worker ${worker.role}`));
let firstPlank = false, firstCooked = false;
camp.events.on('pile:changed', ({ station }) => {
  if (!firstPlank && station.id === 'sawmill') { firstPlank = true; note('first plank on the pile'); }
  if (!firstCooked && station.id === 'cookfire') { firstCooked = true; note('first cooked meat'); }
});

// --- bot movement ---
let path = null, pi = 0, goal = null, goalKey = '', think = 0;
const kinds = {};
function plan() {
  goal = camp.nextGoal();
  const key = goal ? `${goal.kind}:${goal.padId || goal.stationId || goal.entityId || goal.animalId}` : 'none';
  if (key !== goalKey && verbose) console.log(fmt(camp.time), 'goal', key, goal?.item || '');
  goalKey = key;
  if (!goal) { path = null; return; }
  const sx = Math.round(pos.x), sz = Math.round(pos.z);
  let isGoal;
  if (goal.kind === 'gather' || goal.kind === 'hunt') {
    const tx = Math.round(goal.x), tz = Math.round(goal.z);
    isGoal = (x, z) => Math.max(Math.abs(x - tx), Math.abs(z - tz)) <= 1 && !(x === tx && z === tz);
  } else {
    const tx = Math.round(goal.x), tz = Math.round(goal.z);
    isGoal = (x, z) => x === tx && z === tz;
  }
  path = camp.bfs(sx, sz, isGoal);
  pi = 1;
}
function move(dt) {
  if (!path || pi >= path.length) {
    // close the last bit like a player walking into it (a moving animal, or a tree / zone centre)
    let tx = goal?.x, tz = goal?.z, near = 0.15;
    if (goal?.kind === 'hunt') { const a = camp.animals.get(goal.animalId); if (!a || a.dead) return; tx = a.x; tz = a.z; near = 0.9; }
    else if (goal?.kind === 'gather') near = 1.0;
    if (tx == null) return;
    const dx = tx - pos.x, dz = tz - pos.z, d = Math.hypot(dx, dz);
    if (d > near) step(dx / d, dz / d, dt);
    return;
  }
  const [tx, tz] = path[pi];
  const dx = tx - pos.x, dz = tz - pos.z, d = Math.hypot(dx, dz);
  if (d < 0.05) { pi++; return; }
  step(dx / d, dz / d, Math.min(dt, d / PLAYER.moveSpeed));
}
function step(ux, uz, dt) {
  const nx = pos.x + ux * PLAYER.moveSpeed * dt, nz = pos.z + uz * PLAYER.moveSpeed * dt;
  if (sim.isWalkable(Math.round(nx), Math.round(nz))) { pos.x = nx; pos.z = nz; sim.setPlayer(Math.round(nx), Math.round(nz)); }
}

const dt = 1 / 20;
let waitT = 0;
for (let t = 0; t < minutes * 60; t += dt) {
  if ((think -= dt) <= 0) { think = 0.5; plan(); }
  if (goal) kinds[goal.kind] = (kinds[goal.kind] || 0) + dt;
  if (goal?.kind === 'wait') waitT += dt;
  move(dt);
  sim.update(dt);
  camp.update(dt);
}

console.log(`\nPacing over ${minutes} min (bot follows camp.nextGoal at ${PLAYER.moveSpeed} tiles/s)\n`);
for (const { t, what } of log) console.log(`${fmt(t).padStart(6)}  ${what}`);
console.log(`\ntime by goal kind: ${Object.entries(kinds).map(([k, v]) => `${k} ${fmt(v)}`).join(', ')}`);
console.log(`final: level ${camp.level}, capacity ${camp.capacity}, workers ${camp.workers.size}, bridges ${[...camp.bridges].join(',') || '-'}, pads left ${camp.pads.map(p => p.id).join(', ')}`);
