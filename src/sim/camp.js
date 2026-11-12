// Camp simulation: the arcade-idle survival loop layered on top of sim.js.
// The player's carried stack IS sim.inventory (capped by camp.capacity). The camp adds auto-gathering,
// stations with production lines and pickup piles, build pads, the hearth's levels, bridges, roaming
// animals, workers, regrowth and loose items. Pure logic (runs in node); views read state + events.
//
// Needs from sim.js: at, entities, events, inventory, map, player, isWalkable, hitResource(id, dir, {collect}),
// spawnResource(kind, x, z, opts), removeResource(id). (Additive API; see GAMEPLAY.md.)
import { DIRS, RESOURCES } from '../config.js';
import { mulberry32 } from '../util/noise.js';
import {
  CAMP, STATIONS, PADS, UPGRADES, ANIMALS, ANIMAL_SPAWNS, ANIMAL_RESPAWN, WORKERS, HUNGER_TIME, MAX_LEVEL,
} from './camp-data.js';

const CARRY_ITEMS = ['wood', 'stone', 'meat', 'cookedMeat', 'plank', 'copperOre', 'copperBar'];
const inRect = ([x, z, w, h], px, pz, pad = 0) => px >= x - 0.5 - pad && px <= x + w - 0.5 + pad && pz >= z - 0.5 - pad && pz <= z + h - 0.5 + pad;
const rectTiles = ([x, z, w, h]) => { const out = []; for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) out.push([x + i, z + j]); return out; };
const rectCenter = ([x, z, w, h]) => ({ x: x + (w - 1) / 2, z: z + (h - 1) / 2 });
const dirToward = (dx, dz) => (Math.abs(dx) >= Math.abs(dz) ? (dx >= 0 ? 0 : 2) : (dz >= 0 ? 1 : 3));

export function createCamp(sim, { playerPos = null, seed = 11 } = {}) {
  const { map, events, inventory } = sim;
  const rng = mulberry32(seed);
  const getPlayer = () => { const p = playerPos?.(); return p ? { x: p.x, z: p.z } : { x: sim.player.x, z: sim.player.z }; };

  // ---------- walkability: built station footprints block ----------
  const blockers = new Set();
  const baseWalkable = sim.isWalkable.bind(sim);
  sim.isWalkable = (x, z) => baseWalkable(x, z) && !blockers.has(map.idx(x, z));
  sim.blockers = blockers;
  // the hearth is always there (cold at level 0): solid from the start
  for (const [x, z] of rectTiles(STATIONS.hearth.footprint)) blockers.add(map.idx(x, z));
  // tiles animals keep off: every station's zone, line and pile (they wander, they don't stand in the camp's works)
  const campTiles = new Set();
  for (const def of Object.values(STATIONS)) {
    for (const r of [def.footprint, def.zone]) if (r) for (const [x, z] of rectTiles(r)) campTiles.add(map.idx(x, z));
    for (const [x, z] of def.line || []) campTiles.add(map.idx(x, z));
    if (def.pile) campTiles.add(map.idx(def.pile[0], def.pile[1]));
  }
  for (const pd of PADS) for (const [x, z] of rectTiles(pd.zone)) campTiles.add(map.idx(x, z));

  // ---------- state ----------
  const camp = {
    events, sim,
    level: 0,                  // 0 = the hearth is cold; lighting it is the first pad
    capacity: CAMP.capacity,
    gatherSpeed: 1,
    stack: [],                 // carried items bottom -> top (mirrors inventory counts of CARRY_ITEMS)
    stations: new Map(),       // id -> station state (only built ones)
    pads: [],                  // visible, unfinished pads
    padsDone: new Set(),
    bridges: new Set(),        // built bridge ids
    upgrades: new Set(),
    hired: new Set(),          // hire pad ids completed
    animals: new Map(),
    workers: new Map(),
    loose: [],                 // { id, item, x, z, t }
    time: 0,
    complete: false,
  };
  let nextId = 1;
  const later = [];            // scheduled callbacks { t, fn }
  const schedule = (delay, fn) => later.push({ t: camp.time + delay, fn });

  // ---------- the carried stack ----------
  const total = () => camp.stack.length;
  camp.total = total;
  camp.free = () => Math.max(0, camp.capacity - total());
  // keep camp.stack in sync with inventory changes made by anyone
  events.on('inventory:changed', ({ item, delta }) => {
    if (!CARRY_ITEMS.includes(item)) return;
    if (delta > 0) for (let i = 0; i < delta; i++) camp.stack.push(item);
    else for (let i = 0; i < -delta; i++) { const k = camp.stack.lastIndexOf(item); if (k >= 0) camp.stack.splice(k, 1); }
  });
  for (const item of CARRY_ITEMS) for (let i = 0; i < inventory.get(item); i++) camp.stack.push(item);

  // Give items to the player: what fits goes on the stack (flies from `source`), the rest lands loose.
  function givePlayer(item, n, source) {
    const fit = Math.min(n, camp.free());
    if (fit > 0) inventory.add(item, fit, source);
    for (let i = fit; i < n; i++) dropLoose(item, source.x + (rng() - 0.5) * 0.7, source.z + (rng() - 0.5) * 0.7);
    if (fit < n) events.emit('camp:stackFull', {});
    return fit;
  }
  function dropLoose(item, x, z) {
    const l = { id: nextId++, item, x, z, t: 0 };
    camp.loose.push(l);
    events.emit('loose:spawned', { loose: l });
  }

  // ---------- stations ----------
  function buildStation(id) {
    const def = STATIONS[id];
    const s = {
      id, def, built: true,
      input: {}, busy: false, progress: 0, timer: 0,
      line: def.line ? { path: def.line, items: [] } : null,
      pile: def.pile ? { tile: def.pile, item: def.recipe?.out || def.auto?.out, count: 0 } : null,
    };
    camp.stations.set(id, s);
    for (const [x, z] of rectTiles(def.footprint)) blockers.add(map.idx(x, z));
    // anything standing on the footprint (stumps, loose items) gets cleared
    for (const [x, z] of rectTiles(def.footprint)) { const e = sim.at(x, z); if (e?.resource) sim.removeResource?.(e.id); }
    events.emit('station:built', { station: s });
    // the player paid standing on the pad: hop them out to the nearest free tile (views animate the hop)
    const p = getPlayer();
    if (inRect(def.footprint, p.x, p.z, 0.25)) {
      const c = rectCenter(def.footprint);
      const out = bfs(Math.round(p.x), Math.round(p.z), (x, z) => !inRect(def.footprint, x, z) && sim.isWalkable(x, z), 400);
      const dest = out ? out[out.length - 1] : [Math.round(c.x), Math.round(c.z + def.footprint[3])];
      sim.setPlayer(dest[0], dest[1]);
      events.emit('player:eject', { x: dest[0], z: dest[1], from: { x: p.x, z: p.z } });
    }
    // workers caught inside are moved out too
    for (const w of camp.workers.values()) {
      if (!inRect(def.footprint, w.x, w.z, 0.2)) continue;
      const out = bfs(Math.round(w.x), Math.round(w.z), (x, z) => !inRect(def.footprint, x, z) && sim.isWalkable(x, z), 400);
      if (out) { const [x, z] = out[out.length - 1]; w.x = x; w.z = z; w.path = null; setState(w, 'seek'); }
    }
    return s;
  }
  const accepts = (s, item) => !!s.def.accepts?.includes(item) && (s.input[item] || 0) < CAMP.inputCap;
  function stationInput(s, item, by) {
    s.input[item] = (s.input[item] || 0) + 1;
    events.emit('station:drop', { station: s, item, by });
  }
  function pushLine(s, item) {
    const items = s.line.items;
    const last = items[items.length - 1];
    if (last && last.p < CAMP.lineSpacing) return false;
    items.push({ item, p: 0, uid: nextId++ });
    return true;
  }
  function updateStations(dt) {
    for (const s of camp.stations.values()) {
      const def = s.def;
      // production
      if (def.recipe) {
        if (!s.busy && Object.entries(def.recipe.in).every(([k, n]) => (s.input[k] || 0) >= n) && lineHasRoom(s)) {
          for (const [k, n] of Object.entries(def.recipe.in)) s.input[k] -= n;
          s.busy = true; s.progress = 0;
          events.emit('station:start', { station: s });
        }
        if (s.busy) {
          s.progress = Math.min(1, s.progress + dt / def.recipe.time);
          if (s.progress >= 1 && pushOut(s, def.recipe.out)) { s.busy = false; s.progress = 0; }
        }
      } else if (def.auto) {
        if (!s.held) {
          s.timer += dt; s.progress = Math.min(1, s.timer / def.auto.time);
          if (s.timer >= def.auto.time) { s.timer = 0; s.progress = 0; s.held = def.auto.out; events.emit('station:start', { station: s }); }
        }
        if (s.held && pushOut(s, s.held)) s.held = null;
        s.working = !s.held;
      }
      // line
      if (s.line) {
        const len = s.line.path.length;
        const items = s.line.items;
        for (let i = 0; i < items.length; i++) {
          const limit = i === 0 ? len : items[i - 1].p - CAMP.lineSpacing;
          items[i].p = Math.max(items[i].p, Math.min(items[i].p + CAMP.lineSpeed * dt, limit));
        }
        const head = items[0];
        if (head && head.p >= len) {
          if (deliverLineEnd(s, head)) items.shift();
          else head.p = len;
        }
      }
    }
  }
  const lineHasRoom = s => !s.line || !s.line.items.length || s.line.items[s.line.items.length - 1].p >= CAMP.lineSpacing;
  function pushOut(s, item) {
    if (s.line) { if (!pushLine(s, item)) return false; }
    else if (s.pile) { if (s.pile.count >= CAMP.pileCap) return false; s.pile.count++; events.emit('pile:changed', { station: s }); }
    events.emit('station:produced', { station: s, item });
    return true;
  }
  function deliverLineEnd(s, head) {
    if (s.def.to) {
      const t = camp.stations.get(s.def.to);
      if (!t || !accepts(t, head.item)) return false;
      stationInput(t, head.item, s.id);
      events.emit('line:arrived', { station: s, item: head.item, to: t.id });
      return true;
    }
    if (s.pile.count >= CAMP.pileCap) return false;
    s.pile.count++;
    events.emit('line:arrived', { station: s, item: head.item });
    events.emit('pile:changed', { station: s });
    return true;
  }

  // ---------- pads ----------
  const padState = def => ({ ...def, paid: Object.fromEntries(Object.keys(def.cost).map(k => [k, 0])), shownAt: camp.time });
  function requirementsMet(r) {
    if (r.level && camp.level < r.level) return false;
    if (r.built && !r.built.every(id => camp.stations.has(id))) return false;
    if (r.bridges && !r.bridges.every(id => camp.bridges.has(id))) return false;
    if (r.upgrades && !r.upgrades.every(id => camp.upgrades.has(id))) return false;
    if (r.hired && !r.hired.every(id => camp.hired.has(id))) return false;
    return true;
  }
  function refreshPads() {
    for (const def of PADS) {
      if (camp.padsDone.has(def.id) || camp.pads.some(p => p.id === def.id)) continue;
      if (def.id.startsWith('hearth:') && Number(def.id.split(':')[1]) !== camp.level + 1) continue;
      // one pad per zone at a time (e.g. the second hire waits for the first)
      if (camp.pads.some(p => p.zone.join() === def.zone.join())) continue;
      if (!requirementsMet(def.requires)) continue;
      const pad = padState(def);
      camp.pads.push(pad);
      events.emit('pad:shown', { pad });
    }
  }
  const padRemaining = pad => Object.entries(pad.cost).reduce((a, [k, n]) => a + n - pad.paid[k], 0);
  camp.padRemaining = padRemaining;
  function completePad(pad) {
    camp.pads.splice(camp.pads.indexOf(pad), 1);
    camp.padsDone.add(pad.id);
    events.emit('pad:complete', { pad });
    const [kind, arg] = pad.id.split(':');
    const what = arg?.split('#')[0];
    if (kind === 'build') buildStation(what);
    if (kind === 'hearth') { camp.level = Number(what); events.emit('hearth:level', { level: camp.level }); if (camp.level >= MAX_LEVEL) { camp.complete = true; events.emit('camp:complete', {}); } }
    if (kind === 'bridge') buildBridge(what);
    if (kind === 'upgrade') applyUpgrade(what);
    if (kind === 'hire') { camp.hired.add(pad.id); hire(what); }
    refreshPads();
  }
  function applyUpgrade(id) {
    const u = UPGRADES[id];
    camp.upgrades.add(id);
    if (u.capacity) { camp.capacity = u.capacity; events.emit('capacity:changed', { capacity: camp.capacity }); }
    if (u.gatherSpeed) camp.gatherSpeed = u.gatherSpeed;
    events.emit('upgrade', { id, upgrade: u });
  }

  // ---------- bridges ----------
  function buildBridge(id) {
    const b = map.bridges[id];
    const bridge = { id, tiles: b.tiles, orientation: b.orientation, built: 0 };
    events.emit('bridge:start', { bridge });
    b.tiles.forEach(([x, z], i) => schedule(0.35 + i * 0.32, () => {
      map.bridge[map.idx(x, z)] = b.orientation;
      bridge.built = i + 1;
      events.emit('bridge:plank', { bridge, index: i, tile: [x, z] });
      if (i === b.tiles.length - 1) { camp.bridges.add(id); events.emit('bridge:built', { bridge }); refreshPads(); }
    }));
  }

  // ---------- player transfers: pads, station zones, piles, loose items ----------
  const xfer = { key: null, timer: 0, interval: CAMP.payStart };
  function transferTick(key, dt, fn) {
    if (xfer.key !== key) { xfer.key = key; xfer.timer = CAMP.payStart * 0.6; xfer.interval = CAMP.payStart; }
    xfer.timer -= dt;
    let guard = 0;
    while (xfer.timer <= 0 && guard++ < 6) {
      if (!fn()) { xfer.timer = 0.05; return false; }
      xfer.interval = Math.max(CAMP.payMin, xfer.interval * CAMP.payRamp);
      xfer.timer += xfer.interval;
    }
    return true;
  }
  // Take the top-most stack item that `want(item)` accepts.
  function takeFromStack(want) {
    for (let i = camp.stack.length - 1; i >= 0; i--) {
      const item = camp.stack[i];
      if (want(item)) { inventory.remove(item, 1); return item; }
    }
    return null;
  }
  function updatePlayerTransfers(dt, p) {
    // loose items: walk over them
    for (const l of [...camp.loose]) {
      if (Math.hypot(l.x - p.x, l.z - p.z) < 0.6 && camp.free() > 0) {
        camp.loose.splice(camp.loose.indexOf(l), 1);
        inventory.add(l.item, 1, { x: l.x, z: l.z });
        events.emit('loose:taken', { loose: l });
      }
    }
    // pads first, then station zones, then piles
    // A pad / zone / pile only "holds" the player when it can actually exchange something; otherwise the player
    // just walks over it and keeps gathering (no dead spots).
    for (const pad of camp.pads) {
      if (!inRect(pad.zone, p.x, p.z)) continue;
      if (!camp.stack.some(it => (pad.paid[it] ?? Infinity) < pad.cost[it])) continue;
      transferTick(`pad:${pad.id}`, dt, () => {
        const item = takeFromStack(it => (pad.paid[it] ?? Infinity) < pad.cost[it]);
        if (!item) return false;
        pad.paid[item]++;
        events.emit('pad:paid', { pad, item });
        if (padRemaining(pad) <= 0) { completePad(pad); return false; }
        return true;
      });
      return 'pad';
    }
    for (const s of camp.stations.values()) {
      if (!s.def.zone || !inRect(s.def.zone, p.x, p.z)) continue;
      if (!camp.stack.some(it => accepts(s, it))) continue;
      transferTick(`zone:${s.id}`, dt, () => {
        const item = takeFromStack(it => accepts(s, it));
        if (!item) return false;
        stationInput(s, item, 'player');
        return true;
      });
      return 'zone';
    }
    for (const s of camp.stations.values()) {
      if (!s.pile || !inRect([s.pile.tile[0], s.pile.tile[1], 1, 1], p.x, p.z, 0.1)) continue;
      if (!s.pile.count || camp.free() <= 0 || stillNeeded(s.pile.item) <= 0) continue;
      transferTick(`pile:${s.id}`, dt, () => {
        if (!s.pile.count || camp.free() <= 0 || stillNeeded(s.pile.item) <= 0) return false;
        s.pile.count--;
        inventory.add(s.pile.item, 1, { x: s.pile.tile[0], z: s.pile.tile[1] });
        events.emit('pile:take', { station: s, item: s.pile.item, by: 'player' });
        events.emit('pile:changed', { station: s });
        return true;
      });
      return 'pile';
    }
    xfer.key = null;
    return null;
  }

  // ---------- gathering (player + workers share the hit path) ----------
  const reserved = new Map(); // entity/animal id -> worker id
  function hitResourceFor(entityId, fromDir, collector) {
    const res = sim.hitResource(entityId, fromDir, { collect: false });
    if (res?.depleted) {
      for (const [k, n] of Object.entries(res.drops || {})) collector(k, n);
      reserved.delete(entityId);
      if (res.replacedBy) scheduleRegrow(res.replacedBy.id, 'stump');
      // a cleared stump grows a fresh tree on the empty tile; a broken rock comes back as a rock
      else if (res.kind === 'stump') scheduleRespawn('tree', res.x, res.z, res, CAMP.regrow.stump);
      else if (res.kind === 'rock') scheduleRespawn('rock', res.x, res.z, res, CAMP.regrow.rock);
    }
    return res;
  }
  function scheduleRegrow(stumpId, kind) {
    schedule(CAMP.regrow[kind], () => {
      const s = sim.entities.get(stumpId);
      if (!s || s.kind !== 'stump') return;
      const { x, z, variant, rot, scale } = s;
      sim.removeResource?.(stumpId, { regrow: true });
      const tree = sim.spawnResource?.('tree', x, z, { variant, rot, scale, grow: true });
      if (tree) events.emit('camp:regrow', { entity: tree });
    });
  }
  function scheduleRespawn(kind, x, z, info, delay) {
    if (x == null) return;
    schedule(delay, function retry() {
      if (sim.at(x, z) || blockers.has(map.idx(x, z)) || near(getPlayer(), x, z, 1.2)) { schedule(5, retry); return; }
      const e = sim.spawnResource?.(kind, x, z, { variant: info?.variant, rot: info?.rot, scale: info?.scale, grow: true });
      if (e) events.emit('camp:regrow', { entity: e });
    });
  }
  const near = (p, x, z, r) => Math.hypot(p.x - x, p.z - z) < r;

  function nearestResource(px, pz, radius) {
    let best = null, bestD = Infinity;
    const r = Math.ceil(radius);
    const tx = Math.round(px), tz = Math.round(pz);
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const e = sim.at(tx + dx, tz + dz);
      if (!e?.resource || reserved.has(e.id)) continue;
      const d = Math.hypot(e.x - px, e.z - pz);
      if (d <= radius && d < bestD) { best = e; bestD = d; }
    }
    return best;
  }
  function nearestAnimal(px, pz, radius, skipReserved = true) {
    let best = null, bestD = Infinity;
    for (const a of camp.animals.values()) {
      if (a.dead || (skipReserved && reserved.has(a.id))) continue;
      const d = Math.hypot(a.x - px, a.z - pz);
      if (d <= radius && d < bestD) { best = a; bestD = d; }
    }
    return best;
  }

  // Only gather what has a use right now (a visible pad wants it, or a built station converts it), so the stack
  // never clogs with stone or raw meat you can't spend yet. Rocks and animals are scenery until then.
  // How many more of `item` the visible pads still want, beyond what's already on the stack.
  function stillNeeded(item) {
    let n = 0;
    for (const p of camp.pads) n += Math.max(0, (p.cost[item] || 0) - (p.paid[item] || 0));
    return n - camp.stack.filter(i => i === item).length;
  }
  camp.stillNeeded = stillNeeded;
  function useful(item) {
    if (camp.pads.some(p => (p.cost[item] || 0) - (p.paid[item] || 0) > 0)) return true;
    for (const s of camp.stations.values()) if (s.def.accepts?.includes(item)) return true;
    return false;
  }
  camp.useful = useful;
  const KIND_ITEM = { tree: 'wood', stump: 'wood', rock: 'stone' };
  const swing = { cooldown: 0 };
  function updatePlayerGather(dt, p, inZone) {
    swing.cooldown -= dt;
    if (swing.cooldown > 0 || inZone || camp.free() <= 0) return;
    const animal = useful('meat') ? nearestAnimal(p.x, p.z, CAMP.huntRadius, false) : null;
    let res = null;
    if (!animal) {
      const near = nearestResource(p.x, p.z, CAMP.gatherRadius);
      if (near && useful(KIND_ITEM[near.kind])) res = near;
      else if (near) {
        // the nearest is not useful (a rock): look for a useful one in reach instead
        let best = null, bd = Infinity;
        const tx = Math.round(p.x), tz = Math.round(p.z);
        for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
          const e = sim.at(tx + dx, tz + dz);
          if (!e?.resource || reserved.has(e.id) || !useful(KIND_ITEM[e.kind])) continue;
          const d = Math.hypot(e.x - p.x, e.z - p.z);
          if (d <= CAMP.gatherRadius && d < bd) { best = e; bd = d; }
        }
        res = best;
      }
    }
    if (!animal && !res) return;
    const target = animal
      ? { type: 'animal', id: animal.id, kind: animal.kind, x: animal.x, z: animal.z }
      : { type: 'resource', id: res.id, kind: res.kind, x: res.x, z: res.z };
    const tool = animal ? 'club' : res.kind === 'rock' ? 'pick' : 'axe';
    swing.cooldown = CAMP.swingTime / camp.gatherSpeed;
    const fromDir = dirToward(target.x - p.x, target.z - p.z);
    events.emit('camp:swing', { by: 'player', target, tool, fromDir, hitIn: CAMP.hitDelay });
    schedule(CAMP.hitDelay, () => {
      if (target.type === 'animal') hitAnimal(target.id, 'player', p);
      else hitResourceFor(target.id, fromDir, (item, n) => givePlayer(item, n, { x: target.x, z: target.z }));
    });
  }

  // ---------- animals ----------
  const islandTiles = {};
  for (const [name, rects] of Object.entries(map.islands || {})) {
    islandTiles[name] = rects.flatMap(rectTiles).filter(([x, z]) => map.isLand(x, z));
  }
  const animalCounts = name => [...camp.animals.values()].filter(a => a.island === name && !a.dead);
  function spawnAnimal(kind, island) {
    const tiles = islandTiles[island]?.filter(([x, z]) => sim.isWalkable(x, z) && !campTiles.has(map.idx(x, z)) && !near(getPlayer(), x, z, 3));
    if (!tiles?.length) return null;
    const [x, z] = tiles[Math.floor(rng() * tiles.length)];
    const def = ANIMALS[kind];
    const a = { id: `a${nextId++}`, kind, island, x, z, heading: rng() * Math.PI * 2, hp: def.hp, maxHp: def.hp, state: 'idle', timer: 0.5 + rng() * 2, tx: x, tz: z, speed: 0, dead: false, fleeT: 0 };
    camp.animals.set(a.id, a);
    events.emit('animal:spawned', { animal: a });
    return a;
  }
  for (const [island, list] of Object.entries(ANIMAL_SPAWNS)) for (const [kind, count] of list) for (let i = 0; i < count; i++) spawnAnimal(kind, island);

  const sameIsland = (a, x, z) => map.islandAt?.(Math.round(x), Math.round(z)) === a.island;
  function clearLine(a, x, z) {
    for (let i = 1; i <= 8; i++) {
      const t = i / 8, sx = a.x + (x - a.x) * t, sz = a.z + (z - a.z) * t;
      if (!sim.isWalkable(Math.round(sx), Math.round(sz)) || !sameIsland(a, sx, sz) || campTiles.has(map.idx(Math.round(sx), Math.round(sz)))) return false;
    }
    return true;
  }
  function pickWander(a, minR, maxR, away = null) {
    for (let k = 0; k < 14; k++) {
      let ang = rng() * Math.PI * 2;
      if (away) ang = Math.atan2(a.z - away.z, a.x - away.x) + (rng() - 0.5) * 1.6;
      const r = minR + rng() * (maxR - minR);
      const x = a.x + Math.cos(ang) * r, z = a.z + Math.sin(ang) * r;
      if (clearLine(a, x, z)) { a.tx = x; a.tz = z; return true; }
    }
    return false;
  }
  function hitAnimal(id, by, from) {
    const a = camp.animals.get(id);
    if (!a || a.dead) return;
    a.hp--;
    events.emit('animal:hit', { animal: a, by });
    if (a.hp > 0) {
      a.state = 'flee'; a.fleeT = 1.1; pickWander(a, 1.5, 2.6, from);
      return;
    }
    a.dead = true; a.state = 'dead';
    reserved.delete(id);
    const drops = { ...ANIMALS[a.kind].drops };
    events.emit('animal:killed', { animal: a, drops, by });
    if (by === 'player') for (const [k, n] of Object.entries(drops)) givePlayer(k, n, { x: a.x, z: a.z });
    schedule(0.6, () => { camp.animals.delete(a.id); events.emit('animal:removed', { animal: a }); });
    schedule(ANIMAL_RESPAWN + rng() * 8, () => spawnAnimal(a.kind, a.island));
    return drops;
  }
  function updateAnimals(dt) {
    const p = getPlayer();
    for (const a of camp.animals.values()) {
      if (a.dead) continue;
      const def = ANIMALS[a.kind];
      if (a.state === 'flee') { a.fleeT -= dt; if (a.fleeT <= 0) { a.state = 'idle'; a.timer = 0.8 + rng(); } }
      if (a.state === 'idle') {
        a.timer -= dt; a.speed = 0;
        if (a.timer <= 0) { if (pickWander(a, 1.2, 3.2)) a.state = 'walk'; else a.timer = 1; }
      }
      if (a.state === 'walk' || a.state === 'flee') {
        const sp = a.state === 'flee' ? def.fleeSpeed : def.speed;
        const dx = a.tx - a.x, dz = a.tz - a.z, d = Math.hypot(dx, dz);
        if (d < 0.05) { if (a.state === 'walk') { a.state = 'idle'; a.timer = 1.2 + rng() * 2.8; } a.speed = 0; continue; }
        const step = Math.min(d, sp * dt);
        a.x += (dx / d) * step; a.z += (dz / d) * step;
        a.heading = Math.atan2(dz, dx);
        a.speed = sp;
      }
      // skittish: a deer/rabbit that the player rushes at hops away a little (boars stand their ground)
      if (a.kind !== 'boar' && a.state === 'idle' && Math.hypot(p.x - a.x, p.z - a.z) < 0.9) { a.state = 'flee'; a.fleeT = 0.5; pickWander(a, 0.8, 1.4, p); }
    }
  }

  // ---------- workers ----------
  function bfs(sx, sz, isGoal, maxNodes = 2500) {
    const W = map.w, H = map.h;
    const start = map.idx(sx, sz);
    const prev = new Int32Array(W * H).fill(-2);
    prev[start] = -1;
    const q = [start];
    for (let qi = 0; qi < q.length && qi < maxNodes; qi++) {
      const cur = q[qi];
      const cx = cur % W, cz = (cur / W) | 0;
      if (isGoal(cx, cz)) {
        const path = [];
        for (let c = cur; c !== -1; c = prev[c]) path.push([c % W, (c / W) | 0]);
        return path.reverse();
      }
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const nx = cx + dx, nz = cz + dz;
        if (!map.inBounds(nx, nz)) continue;
        const ni = map.idx(nx, nz);
        if (prev[ni] !== -2 || !sim.isWalkable(nx, nz)) continue;
        if (dx && dz && (!sim.isWalkable(cx + dx, cz) || !sim.isWalkable(cx, cz + dz))) continue;
        prev[ni] = cur; q.push(ni);
      }
    }
    return null;
  }
  camp.bfs = bfs;
  const adjacentTo = (tx, tz, r = 1) => (x, z) => Math.max(Math.abs(x - tx), Math.abs(z - tz)) <= r && !(x === tx && z === tz);

  function hire(role) {
    const hut = camp.stations.get('hut');
    const door = hut?.def.door || [map.start.x, map.start.z];
    const def = WORKERS[role];
    const w = { id: `w${nextId++}`, role, x: door[0], z: door[1], heading: Math.PI / 2, state: 'seek', path: null, pi: 0, carry: { item: null, n: 0 }, cap: def.carry, timer: 0, hunger: 0, hungry: false, target: null, speed: 0 };
    camp.workers.set(w.id, w);
    events.emit('worker:hired', { worker: w });
    return w;
  }
  camp.hire = hire;
  const setState = (w, state) => { if (w.state !== state) { w.state = state; events.emit('worker:state', { worker: w }); } };
  function walk(w, dt, speedMul) {
    if (!w.path || w.pi >= w.path.length) { w.speed = 0; return true; }
    const def = WORKERS[w.role];
    let budget = def.speed * speedMul * dt;
    while (budget > 0 && w.pi < w.path.length) {
      const [tx, tz] = w.path[w.pi];
      const dx = tx - w.x, dz = tz - w.z, d = Math.hypot(dx, dz);
      if (d <= budget) { w.x = tx; w.z = tz; budget -= d; w.pi++; continue; }
      w.x += (dx / d) * budget; w.z += (dz / d) * budget; w.heading = Math.atan2(dz, dx); budget = 0;
    }
    w.speed = def.speed * speedMul;
    return w.pi >= w.path.length;
  }
  function goTo(w, isGoal) {
    const path = bfs(Math.round(w.x), Math.round(w.z), isGoal);
    if (!path) return false;
    w.path = path; w.pi = 1;
    return true;
  }
  function updateWorkers(dt) {
    const cook = camp.stations.get('cookfire');
    for (const w of camp.workers.values()) {
      const def = WORKERS[w.role];
      w.hunger += dt / HUNGER_TIME;
      const wantsFood = w.hunger >= 1;
      if (wantsFood && !w.hungry && !(cook?.pile.count > 0)) { w.hungry = true; events.emit('worker:hungry', { worker: w }); }
      const speedMul = w.hungry ? 0.5 : 1;
      // go eat when there's food
      if (wantsFood && cook?.pile.count > 0 && w.state !== 'toFood' && w.state !== 'eat') {
        const [px, pz] = cook.pile.tile;
        if (goTo(w, adjacentTo(px, pz, 1))) { releaseTarget(w); setState(w, 'toFood'); }
      }
      switch (w.state) {
        case 'toFood': {
          if (walk(w, dt, 1)) { setState(w, 'eat'); w.timer = 0.8; }
          break;
        }
        case 'eat': {
          w.timer -= dt; w.speed = 0;
          if (w.timer <= 0) {
            if (cook?.pile.count > 0) { cook.pile.count--; events.emit('pile:changed', { station: cook }); events.emit('pile:take', { station: cook, item: 'cookedMeat', by: w.id }); w.hunger = 0; w.hungry = false; events.emit('worker:ate', { worker: w }); }
            setState(w, 'seek');
          }
          break;
        }
        case 'seek': {
          w.speed = 0;
          if (w.carry.n >= w.cap) { startDeliver(w); break; }
          const found = def.target === 'tree' ? seekTree(w) : seekAnimal(w);
          if (!found) { if (w.carry.n > 0) startDeliver(w); else { setState(w, 'idle'); w.timer = 1.5; } }
          break;
        }
        case 'idle': {
          w.timer -= dt; w.speed = 0;
          if (w.timer <= 0) setState(w, 'seek');
          break;
        }
        case 'toTarget': {
          const t = targetPos(w);
          if (!t) { setState(w, 'seek'); break; }
          // hunters re-path when the animal wanders off
          if (def.target === 'animal' && (w.repath -= dt) <= 0) { w.repath = 0.8; if (!goTo(w, adjacentTo(Math.round(t.x), Math.round(t.z), 1))) { releaseTarget(w); setState(w, 'seek'); break; } }
          const arrived = walk(w, dt, speedMul);
          if (arrived || Math.hypot(t.x - w.x, t.z - w.z) < (def.target === 'animal' ? 1.3 : 1.05)) { setState(w, 'work'); w.timer = def.workTime * 0.5; }
          break;
        }
        case 'work': {
          const t = targetPos(w);
          w.speed = 0;
          if (!t) { setState(w, w.carry.n > 0 && w.carry.n >= w.cap ? 'deliver' : 'seek'); if (w.state === 'deliver') startDeliver(w); break; }
          if (def.target === 'animal' && Math.hypot(t.x - w.x, t.z - w.z) > 1.6) { setState(w, 'seek'); break; }
          w.heading = Math.atan2(t.z - w.z, t.x - w.x);
          w.timer -= dt * speedMul;
          if (w.timer <= 0) {
            w.timer = def.workTime;
            const fromDir = dirToward(t.x - w.x, t.z - w.z);
            events.emit('camp:swing', { by: w.id, target: { ...w.target, x: t.x, z: t.z }, tool: def.target === 'tree' ? 'axe' : 'club', fromDir, hitIn: CAMP.hitDelay });
            const tgt = w.target;
            schedule(CAMP.hitDelay, () => {
              const collect = (item, n) => {
                if (!w.carry.item || w.carry.item === item) { w.carry.item = item; const k = Math.min(n, w.cap - w.carry.n); w.carry.n += k; events.emit('worker:carry', { worker: w, item, n: k }); }
              };
              if (tgt.type === 'animal') { const drops = hitAnimalBy(tgt.id, w); if (drops) Object.entries(drops).forEach(([k, n]) => collect(k, n)); }
              else hitResourceFor(tgt.id, fromDir, collect);
            });
          }
          break;
        }
        case 'deliver': {
          if (walk(w, dt, speedMul)) { setState(w, 'drop'); w.timer = 0.2; }
          break;
        }
        case 'drop': {
          const s = camp.stations.get(def.deliver);
          w.speed = 0;
          w.timer -= dt;
          if (w.timer <= 0) {
            w.timer = 0.16;
            if (w.carry.n > 0 && s && accepts(s, w.carry.item)) {
              w.carry.n--; stationInput(s, w.carry.item, w.id);
              if (w.carry.n === 0) { w.carry.item = null; setState(w, 'seek'); }
            } else if (w.carry.n === 0) setState(w, 'seek');
          }
          break;
        }
      }
    }
  }
  function hitAnimalBy(id, w) { const a = camp.animals.get(id); return a ? hitAnimal(id, w.id, w) : null; }
  function releaseTarget(w) { if (w.target) reserved.delete(w.target.id); w.target = null; }
  function targetPos(w) {
    if (!w.target) return null;
    if (w.target.type === 'animal') { const a = camp.animals.get(w.target.id); return a && !a.dead ? a : null; }
    const e = sim.entities.get(w.target.id);
    return e ? e : null;
  }
  function seekTree(w) {
    const path = bfs(Math.round(w.x), Math.round(w.z), (x, z) => {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const e = sim.at(x + dx, z + dz);
        if (e && (e.kind === 'tree' || e.kind === 'stump') && !reserved.has(e.id)) { w._found = e; return true; }
      }
      return false;
    });
    if (!path) return false;
    const e = w._found;
    reserved.set(e.id, w.id);
    w.target = { type: 'resource', id: e.id, kind: e.kind };
    w.path = path; w.pi = 1;
    setState(w, 'toTarget');
    return true;
  }
  function seekAnimal(w) {
    let best = null, bestD = Infinity;
    for (const a of camp.animals.values()) {
      if (a.dead || reserved.has(a.id)) continue;
      const d = Math.hypot(a.x - w.x, a.z - w.z);
      if (d < bestD && bfs(Math.round(w.x), Math.round(w.z), adjacentTo(Math.round(a.x), Math.round(a.z), 1), 1800)) { best = a; bestD = d; }
      if (best && bestD < 6) break;
    }
    if (!best) return false;
    reserved.set(best.id, w.id);
    w.target = { type: 'animal', id: best.id, kind: best.kind };
    w.repath = 0;
    if (!goTo(w, adjacentTo(Math.round(best.x), Math.round(best.z), 1))) { releaseTarget(w); return false; }
    setState(w, 'toTarget');
    return true;
  }
  function startDeliver(w) {
    releaseTarget(w);
    const s = camp.stations.get(WORKERS[w.role].deliver);
    if (!s) { setState(w, 'idle'); w.timer = 2; return; }
    const zone = s.def.zone;
    if (goTo(w, (x, z) => inRect(zone, x, z))) setState(w, 'deliver');
    else { setState(w, 'idle'); w.timer = 2; }
  }

  // ---------- main update ----------
  camp.update = dt => {
    camp.time += dt;
    for (let i = later.length - 1; i >= 0; i--) if (later[i].t <= camp.time) { const { fn } = later[i]; later.splice(i, 1); fn(); }
    const p = getPlayer();
    const zone = updatePlayerTransfers(dt, p);
    updatePlayerGather(dt, p, zone);
    updateStations(dt);
    updateAnimals(dt);
    updateWorkers(dt);
    for (const l of [...camp.loose]) { l.t += dt; if (l.t > CAMP.looseLife) { camp.loose.splice(camp.loose.indexOf(l), 1); events.emit('loose:expired', { loose: l }); } }
  };

  // ---------- guidance: the ONE next thing to do (FIRST-20.md) ----------
  // Returns { kind: 'pay'|'drop'|'pickup'|'gather'|'hunt'|'wait', x, z, item?, padId?, stationId?, entityId?, animalId? }
  // or null. Main-line pad = the first visible pad in PADS order. Pure read: safe to call every frame (throttle).
  const RAW_SOURCE = { wood: 'tree', stone: 'rock', meat: 'animal' };
  const PRODUCED_BY = { plank: 'sawmill', cookedMeat: 'cookfire', copperBar: 'smelter', stone: 'quarry' };
  function stationFor(item) { for (const s of camp.stations.values()) if (s.def.accepts?.includes(item)) return s; return null; }
  function nearestReachable(kind, from) {
    const fx = Math.round(from.x), fz = Math.round(from.z);
    if (kind === 'animal') {
      let best = null, bd = Infinity;
      for (const a of camp.animals.values()) {
        if (a.dead) continue;
        const d = Math.hypot(a.x - from.x, a.z - from.z);
        if (d < bd && bfs(fx, fz, adjacentTo(Math.round(a.x), Math.round(a.z), 1), 1600)) { best = a; bd = d; }
      }
      return best ? { animalId: best.id, x: best.x, z: best.z } : null;
    }
    const kinds = kind === 'tree' ? ['tree', 'stump'] : [kind];
    let found = null;
    bfs(fx, fz, (x, z) => {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const e = sim.at(x + dx, z + dz);
        if (e && kinds.includes(e.kind)) { found = e; return true; }
      }
      return false;
    }, 2400);
    return found ? { entityId: found.id, x: found.x, z: found.z } : null;
  }
  camp.mainPad = () => PADS.map(d => camp.pads.find(p => p.id === d.id)).find(Boolean) || null;
  camp.nextGoal = () => {
    const p = getPlayer();
    const carried = id => camp.stack.filter(i => i === id).length;
    const pad = camp.mainPad();
    const need = pad ? Object.fromEntries(Object.entries(pad.cost).map(([k, n]) => [k, n - pad.paid[k]]).filter(([, n]) => n > 0)) : {};
    const at = (o, extra) => ({ ...extra, x: o.x, z: o.z });
    // 1) carrying something the main pad needs -> pay it; else any other visible pad that wants it (nearest)
    if (pad && Object.keys(need).some(k => carried(k) > 0)) {
      const c = rectCenter(pad.zone);
      return at(c, { kind: 'pay', padId: pad.id, item: Object.keys(need).find(k => carried(k) > 0) });
    }
    {
      let best = null, bd = Infinity;
      for (const q of camp.pads) {
        const item = Object.keys(q.cost).find(k => q.paid[k] < q.cost[k] && carried(k) > 0);
        if (!item || need[item] > 0) continue;
        const c = rectCenter(q.zone), d = Math.hypot(c.x - p.x, c.z - p.z);
        if (d < bd) { bd = d; best = at(c, { kind: 'pay', padId: q.id, item }); }
      }
      // only detour for it when the stack is getting full, or the main pad can't use what we hold
      if (best && (camp.free() <= 2 || !Object.keys(need).some(k => camp.useful(k)))) return best;
    }
    // 2) carrying a raw input a built station converts (and nothing on the pad wants it) -> drop it
    for (const item of new Set(camp.stack)) {
      const s = stationFor(item);
      if (s && accepts(s, item) && !(need[item] > 0)) return at(rectCenter(s.def.zone), { kind: 'drop', stationId: s.id, item });
    }
    if (!pad) return null;
    // 3) get what the main pad needs: from a pile if one has it, else from its producer's input, else gather raw
    for (const item of Object.keys(need)) {
      if (camp.free() <= 0) break;
      for (const s of camp.stations.values()) if (s.pile?.item === item && s.pile.count > 0) return { kind: 'pickup', stationId: s.id, item, x: s.pile.tile[0], z: s.pile.tile[1] };
      const producer = camp.stations.get(PRODUCED_BY[item]);
      if (producer && (producer.busy || producer.line?.items.length || Object.values(producer.input).some(n => n > 0) || producer.def.auto)) {
        // it's being made: wait near the pile unless we can feed it more
        const rawIn = producer.def.recipe && Object.keys(producer.def.recipe.in)[0];
        if (rawIn && RAW_SOURCE[rawIn] && camp.free() > 0) { const t = nearestReachable(RAW_SOURCE[rawIn], p); if (t) return { kind: RAW_SOURCE[rawIn] === 'animal' ? 'hunt' : 'gather', item: rawIn, ...t }; }
        if (producer.pile) return { kind: 'wait', stationId: producer.id, item, x: producer.pile.tile[0], z: producer.pile.tile[1] };
      }
      const raw = producer?.def.recipe ? Object.keys(producer.def.recipe.in)[0] : item;
      const src = RAW_SOURCE[raw];
      if (src && camp.free() > 0) { const t = nearestReachable(src, p); if (t) return { kind: src === 'animal' ? 'hunt' : 'gather', item: raw, ...t }; }
    }
    // full stack of the wrong things: drop at any station that takes them
    return null;
  };

  // ---------- save / load ----------
  // snapshot(): plain JSON of everything that matters for progress. restore(snap) must run on a fresh camp
  // BEFORE the views are created (main.js does that), so views build the restored world without animations.
  camp.snapshot = () => {
    const p = getPlayer();
    return {
      v: 1, time: camp.time, level: camp.level, capacity: camp.capacity, gatherSpeed: camp.gatherSpeed,
      padsDone: [...camp.padsDone], paid: Object.fromEntries(camp.pads.map(q => [q.id, { ...q.paid }])),
      bridges: [...camp.bridges], upgrades: [...camp.upgrades], hired: [...camp.hired],
      stations: [...camp.stations.values()].map(s => ({ id: s.id, input: { ...s.input }, pile: s.pile?.count || 0 })),
      stack: [...camp.stack],
      player: { x: +p.x.toFixed(2), z: +p.z.toFixed(2) },
      workers: [...camp.workers.values()].map(w => ({ role: w.role, x: +w.x.toFixed(2), z: +w.z.toFixed(2), hunger: +w.hunger.toFixed(3) })),
      resources: [...sim.entities.values()].filter(e => e.resource).map(e => [e.kind, e.x, e.z, e.hp, e.variant, +e.rot.toFixed(3), +e.scale.toFixed(3)]),
      loose: camp.loose.map(l => [l.item, +l.x.toFixed(2), +l.z.toFixed(2)]),
    };
  };
  camp.restore = snap => {
    if (!snap || snap.v !== 1) return false;
    // world resources: make the map's trees / rocks / stumps match the save, regrowing what was cut
    const want = new Map(snap.resources.map(r => [`${r[1]},${r[2]}`, r]));
    for (const e of [...sim.entities.values()]) if (e.resource && want.get(`${e.x},${e.z}`)?.[0] !== e.kind) sim.removeResource(e.id);
    for (const [kind, x, z, hp, variant, rot, scale] of snap.resources) {
      let e = sim.at(x, z);
      if (!e) e = sim.spawnResource(kind, x, z, { variant, rot, scale });
      if (e?.resource) { e.hp = hp; if (e.kind === 'stump') scheduleRegrow(e.id, 'stump'); }
    }
    for (const pr of map.props) if (!sim.at(pr.x, pr.z) && !blockers.has(map.idx(pr.x, pr.z))) scheduleRespawn(pr.kind, pr.x, pr.z, pr, CAMP.regrow[pr.kind === 'rock' ? 'rock' : 'stump'] * (0.4 + rng() * 0.6));
    // progress, in the order it happened (pads are data-ordered; stations/bridges/upgrades/hires replay silently)
    camp.level = snap.level;
    for (const id of snap.padsDone) {
      camp.padsDone.add(id);
      const [kind, arg] = id.split(':'); const what = arg?.split('#')[0];
      if (kind === 'build' && !camp.stations.has(what)) buildStation(what);
      if (kind === 'upgrade') applyUpgrade(what);
      if (kind === 'hire') camp.hired.add(id);
    }
    for (const id of snap.bridges) { for (const [x, z] of map.bridges[id].tiles) map.bridge[map.idx(x, z)] = map.bridges[id].orientation; camp.bridges.add(id); }
    camp.capacity = snap.capacity; camp.gatherSpeed = snap.gatherSpeed;
    camp.complete = camp.level >= MAX_LEVEL;
    for (const s of snap.stations) { const st = camp.stations.get(s.id); if (st) { st.input = { ...s.input }; if (st.pile) st.pile.count = s.pile; } }
    camp.pads.length = 0; refreshPads();
    for (const q of camp.pads) if (snap.paid[q.id]) Object.assign(q.paid, snap.paid[q.id]);
    // what you were carrying, in order
    for (const item of snap.stack) inventory.add(item, 1);
    // workers, where they were
    for (const w of snap.workers) { const nw = hire(w.role); nw.x = w.x; nw.z = w.z; nw.hunger = w.hunger; }
    for (const [item, x, z] of snap.loose || []) dropLoose(item, x, z);
    // the player
    sim.setPlayer(Math.round(snap.player.x), Math.round(snap.player.z));
    camp.time = snap.time || 0;
    return true;
  };

  // helpers for views / tests
  camp.inRect = inRect;
  camp.rectCenter = rectCenter;
  camp.stationCenter = id => rectCenter(STATIONS[id].footprint);
  camp.padCenter = pad => rectCenter(pad.zone);
  camp.hitAnimal = (id, by = 'player') => hitAnimal(id, by, getPlayer());
  camp.givePlayer = givePlayer;
  camp.buildStation = buildStation;
  camp.completePad = id => { const pad = camp.pads.find(p => p.id === id); if (pad) completePad(pad); };
  camp.CARRY_ITEMS = CARRY_ITEMS;

  refreshPads();
  return camp;
}
