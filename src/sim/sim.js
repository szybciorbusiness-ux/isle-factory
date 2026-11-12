// Factory simulation. Pure logic: no three.js, no DOM. Runs in node for tests.
// Views never mutate entities directly; they call the API below and listen to events.
import {
  DIRS, opposite, ITEMS, RECIPES, BUILDINGS, RESOURCES, DEPOSITS, BELT, START_INVENTORY, RESOURCE_ITEMS,
} from '../config.js';

// The player's footprint on the ground (world units, ~ the critter's egg radius). A blocking building is refused
// on every tile this circle overlaps, so the critter can never end up inside one. Keep it >= the player view's
// collision circle (src/view/player/motion.js RADIUS, 0.27 today); the view may import this one instead.
export const PLAYER_RADIUS = 0.28;
// nearestResource: how strongly the facing direction wins over raw distance (0 = nearest only). A target straight
// ahead counts as (1 - FACING_BIAS) times its distance, one straight behind as (1 + FACING_BIAS) times.
const FACING_BIAS = 0.5;

// ---------- Event bus ----------
export function createEvents() {
  const map = new Map();
  const on = (type, fn) => { if (!map.has(type)) map.set(type, new Set()); map.get(type).add(fn); return () => map.get(type)?.delete(fn); };
  const emit = (type, payload = {}) => {
    for (const fn of map.get(type) || []) { try { fn(payload, type); } catch (e) { console.error(`[event ${type}]`, e); } }
    for (const fn of map.get('*') || []) { try { fn(payload, type); } catch (e) { console.error('[event *]', e); } }
  };
  return { on, emit, once: (type, fn) => { const off = on(type, (p, t) => { off(); fn(p, t); }); return off; } };
}

// ---------- Belt geometry (shared by sim + views) ----------
// Every belt carries one lane down its middle. A straight lane is 1 long; a curve is a quarter circle of radius 0.5
// around the corner shared by its entry and exit edges, so its lane is PI/4 long. Items glide at a constant WORLD
// speed (BELT.speed tiles/s) and keep BELT.spacing world units apart along the lane, so `p` advances faster on curves.
export const BELT_CURVE_LENGTH = Math.PI / 4;
export function beltLength(belt) {
  return belt.from == null || belt.from === opposite(belt.dir) ? 1 : BELT_CURVE_LENGTH;
}

// Returns { x, z, angle } world position of an item at progress p (0 entry edge -> 1 exit edge).
// angle = heading in radians on the xz-plane (atan2(dz, dx)).
// p > 1 only while an item side-loads onto the next belt: it keeps going straight past this belt's exit edge,
// p - 1 = world distance past the edge (at most 0.5, the next belt's centre line). Never clamp p in views.
export function beltPath(belt, p) {
  const [dx, dz] = DIRS[belt.dir];
  if (p > 1) {
    const d = p - 0.5;
    return { x: belt.x + dx * d, z: belt.z + dz * d, angle: Math.atan2(dz, dx) };
  }
  if (belt.from == null || belt.from === opposite(belt.dir)) {
    return { x: belt.x + dx * (p - 0.5), z: belt.z + dz * (p - 0.5), angle: Math.atan2(dz, dx) };
  }
  if (p < 0) p = 0;
  // quarter circle around the corner shared by the entry side and the exit side
  const [sx, sz] = DIRS[belt.from];
  const cx = belt.x + (sx + dx) * 0.5, cz = belt.z + (sz + dz) * 0.5;
  const a0 = Math.atan2(-dz, -dx); // entry point relative to corner = -D * 0.5
  const a1 = Math.atan2(-sz, -sx); // exit point relative to corner = -S * 0.5
  let da = a1 - a0; if (da > Math.PI) da -= Math.PI * 2; if (da < -Math.PI) da += Math.PI * 2;
  const a = a0 + da * p;
  const x = cx + Math.cos(a) * 0.5, z = cz + Math.sin(a) * 0.5;
  const tangent = a + Math.sign(da) * Math.PI / 2;
  return { x, z, angle: Math.atan2(Math.sin(tangent), Math.cos(tangent)) };
}
// 'straight' | 'left' | 'right' (turn direction as seen travelling along the belt, screen space with +z down):
// e.g. entering from the west edge and leaving south (east -> south) is a clockwise, 'right' turn on screen.
export function beltShape(belt) {
  if (belt.from === opposite(belt.dir)) return 'straight';
  return belt.from === ((belt.dir + 1) & 3) ? 'right' : 'left';
}

// ---------- Belt transport model ----------
// Each belt's lane is measured in world units s = p * length. Per tick, belts are processed downstream-first (a
// belt after the belt it feeds), so a compressed line moves as one piece, and an item's limit across a belt
// boundary is the next belt's tail: the spacing invariant holds over the whole network, not just inside a belt.
// Hand-overs move the item object itself (uid is stable from drill to chest).
// Side-loading: the item rolls straight past its belt's exit edge onto the target's centre line (0.5 further),
// then joins the target lane at its middle. While it slides in, the target's items behind it wait (and the
// target's own feeder yields), items ahead are kept at least BELT.spacing away in world space. Straight-through
// traffic has priority; two side-loaders into the same belt take turns.
const SP = BELT.spacing;
const EPS = 1e-7;
const HALF = 0.5;           // distance from a side edge to a straight lane (= how far a side-loaded item travels)
const MAX_STEP = 1 / 30;    // update() sub-steps larger dt
const NONE = 0, ENTER = 1, SIDE = 2, SINK = 3, INJECT = 4, HEADON = 5;
const byFront = (a, b) => b.p - a.p;
const sOf = (len, it) => (it.p > 1 ? len + it.p - 1 : it.p * len);
function insertSorted(items, it) {
  let i = 0;
  while (i < items.length && items[i].p >= it.p) i++;
  items.splice(i, 0, it);
}

// ---------- Simulation ----------
export function createSim(map, { inventory: startInv = START_INVENTORY } = {}) {
  const events = createEvents();
  const entities = new Map();
  const grid = new Int32Array(map.w * map.h); // entity id per tile, 0 = empty
  const belts = new Set(), drills = new Set(), chests = new Set(), workshops = new Set();
  let nextId = 1, itemUid = 1, time = 0, tick = 0;
  // x, z: the tile under the player's centre. wx, wz: its exact feet position when the view reports it through
  // setPlayerPos (else the tile centre).
  const player = { x: map.start.x, z: map.start.z, dir: 1, wx: map.start.x, wz: map.start.z };
  const metrics = Object.create(null); // counters ('felled.tree', 'stored.copperPlate', ...) for tests and stats
  const craftQueue = []; // { recipe, t, time }
  // Quests are gone (free sandbox). Kept as an inert, always-done record so old readers of sim.quest /
  // sim.currentQuest() keep working; no quest event is ever emitted.
  const quest = { index: 0, value: 0, done: true };

  const at = (x, z) => (map.inBounds(x, z) ? entities.get(grid[map.idx(x, z)]) || null : null);
  const bump = (key, n = 1) => { metrics[key] = (metrics[key] || 0) + n; };
  const tileOf = w => Math.floor(w + 0.5); // world coordinate -> tile index (tile x spans x - 0.5 .. x + 0.5)
  // Does the player's footprint touch tile (x, z)?
  function playerOn(x, z) {
    if (x === player.x && z === player.z) return true;
    const dx = Math.max(0, Math.abs(player.wx - x) - 0.5), dz = Math.max(0, Math.abs(player.wz - z) - 0.5);
    return dx * dx + dz * dz < PLAYER_RADIUS * PLAYER_RADIUS - 1e-9;
  }
  const toast = (text, kind = 'warn') => events.emit('toast', { text, kind });
  const normDir = d => (((Number(d) | 0) % 4) + 4) % 4;

  // ---------- inventory ----------
  const counts = Object.fromEntries(Object.keys(ITEMS).map(k => [k, 0]));
  const inventory = {
    counts,
    get: item => counts[item] || 0,
    has: (item, n = 1) => (counts[item] || 0) >= n,
    hasAll: req => Object.entries(req).every(([k, n]) => (counts[k] || 0) >= n),
    // source: optional { x, z } world point the items came from (views fly them to the player)
    add(item, n = 1, source = null) {
      if (!n) return;
      counts[item] = (counts[item] || 0) + n;
      events.emit('inventory:changed', { item, delta: n, total: counts[item], source });
    },
    remove(item, n = 1) {
      if ((counts[item] || 0) < n) return false;
      if (!n) return true;
      counts[item] -= n;
      events.emit('inventory:changed', { item, delta: -n, total: counts[item], source: null });
      return true;
    },
  };
  for (const [k, n] of Object.entries(startInv)) counts[k] = n;

  function addEntity(e) {
    e.id = nextId++;
    entities.set(e.id, e);
    grid[map.idx(e.x, e.z)] = e.id;
    if (e.kind === 'belt') belts.add(e);
    else if (e.kind === 'drill') drills.add(e);
    else if (e.kind === 'chest') chests.add(e);
    else if (e.kind === 'workshop') workshops.add(e);
    return e;
  }
  function dropEntity(e) {
    entities.delete(e.id);
    if (grid[map.idx(e.x, e.z)] === e.id) grid[map.idx(e.x, e.z)] = 0;
    belts.delete(e); drills.delete(e); chests.delete(e); workshops.delete(e);
  }

  // resources from the map
  for (const p of map.props) {
    const def = RESOURCES[p.kind];
    addEntity({ kind: p.kind, x: p.x, z: p.z, hp: def.hp, maxHp: def.hp, variant: p.variant, rot: p.rot, scale: p.scale, resource: true });
  }

  // ---------- belt items ----------
  // { type, p, uid } + a hidden tick stamp so an item handed over this tick is not moved twice.
  function makeItem(type, p) {
    const it = { type, p, uid: itemUid++ };
    Object.defineProperty(it, 'tk', { value: -1, writable: true, enumerable: false });
    return it;
  }

  // ---------- belt shapes ----------
  // A belt is curved when nothing feeds it from behind and exactly one belt feeds it from a side.
  const feedsInto = (b, x, z) => b && b.kind === 'belt' && b.x + DIRS[b.dir][0] === x && b.z + DIRS[b.dir][1] === z;
  function computeFrom(belt) {
    const back = opposite(belt.dir);
    const behind = at(belt.x + DIRS[back][0], belt.z + DIRS[back][1]);
    if (feedsInto(behind, belt.x, belt.z)) return back;
    const sides = [(belt.dir + 1) & 3, (belt.dir + 3) & 3].filter(s => feedsInto(at(belt.x + DIRS[s][0], belt.z + DIRS[s][1]), belt.x, belt.z));
    return sides.length === 1 ? sides[0] : back;
  }
  // After any build change around (x, z): fix belt shapes, then rebuild the links at once (so a side-load in
  // progress into a removed / turned belt is pulled back before anything renders).
  function refreshBeltsAround(x, z) {
    dirty = true;
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const b = at(x + dx, z + dz);
      if (!b || b.kind !== 'belt') continue;
      const from = computeFrom(b);
      if (from !== b.from) {
        b.from = from; b.shape = beltShape(b);
        respace(b);
        events.emit('belt:shape', { entity: b });
      }
    }
    relink();
  }
  // After a belt changed shape/direction: keep its items on the lane, sorted and (where they fit) spaced.
  function respace(b) {
    const items = b.items, n = items.length;
    if (!n) return;
    items.sort(byFront);
    const len = beltLength(b);
    let first = 0, ahead = Infinity;
    while (first < n && items[first].p > 1) { ahead = len + items[first].p - 1; first++; } // mid-merge items stay
    for (let i = first; i < n; i++) {
      let s = (Number.isFinite(items[i].p) ? items[i].p : 0) * len;
      if (s > len) s = len;
      if (s > ahead - SP) s = ahead - SP;
      items[i].p = s / len; ahead = s;
    }
    if (n > first && items[n - 1].p < 0) {
      // crowded: pack from the entry edge forward
      let s = 0;
      for (let i = n - 1; i >= first; i--) { const cur = Math.max(items[i].p * len, s); items[i].p = cur / len; s = cur + SP; }
      if (items[first].p > 1 + EPS) {
        // more items than fit on this shape: spread them evenly, they space out again as soon as the belt moves
        const k = n - first;
        for (let i = first; i < n; i++) items[i].p = k === 1 ? 1 : (n - 1 - i) / (k - 1);
      }
    }
  }

  // ---------- belt links (rebuilt lazily after any build change) ----------
  // Stored in a hidden `_l` record per belt (non-enumerable, so entities stay JSON-safe).
  let dirty = true, linkStamp = 0, linkVersion = 0;
  const order = [], path = [];
  function attachLink(b) {
    Object.defineProperty(b, '_l', {
      value: { len: 1, next: null, mode: NONE, feeder: null, sides: null, merger: null, lastSide: -1, vis: 0 },
      writable: true, enumerable: false,
    });
  }
  function relink() {
    dirty = false; linkStamp++; linkVersion++;
    for (const b of belts) {
      const l = b._l;
      l.len = beltLength(b); l.feeder = null; l.sides = null; l.merger = null;
      const [dx, dz] = DIRS[b.dir];
      const n = at(b.x + dx, b.z + dz);
      l.next = n;
      if (!n) l.mode = NONE;
      else if (n.kind === 'belt') {
        l.mode = n.dir === opposite(b.dir) ? HEADON : n.from === opposite(b.dir) ? ENTER : beltShape(n) === 'straight' ? SIDE : INJECT;
      } else l.mode = n.kind === 'chest' || n.kind === 'workshop' ? SINK : NONE;
    }
    for (const b of belts) {
      const l = b._l;
      if (l.mode === ENTER) l.next._l.feeder = b;
      else if (l.mode === SIDE) (l.next._l.sides ||= []).push(b);
    }
    // items already past an exit edge (mid side-load) keep going only if that merge is still possible
    for (const b of belts) {
      if (!b.items.length || b.items[0].p <= 1) continue;
      const l = b._l;
      if (l.mode === SIDE && !l.next._l.merger) { l.next._l.merger = b; continue; }
      for (const it of b.items) if (it.p > 1) it.p = 1;
      respace(b);
    }
    // processing order: every belt after the belt it feeds (loops are cut at one arbitrary but fixed point).
    // Sorted by tile so the result never depends on placement order.
    order.length = 0;
    for (let i = 0; i < grid.length; i++) {
      if (!grid[i]) continue;
      const b = entities.get(grid[i]);
      if (!b || b.kind !== 'belt') continue;
      let cur = b;
      while (cur && cur._l.vis !== linkStamp) {
        cur._l.vis = linkStamp; path.push(cur);
        const m = cur._l.mode;
        cur = m === ENTER || m === SIDE || m === INJECT ? cur._l.next : null;
      }
      for (let i = path.length - 1; i >= 0; i--) order.push(path[i]);
      path.length = 0;
    }
  }

  // virtual lane coordinate of the item(s) merging into a belt: the last one past `a`'s exit edge
  function mergerQ(a) {
    const items = a.items;
    let q = 0;
    for (let i = 0; i < items.length && items[i].p > 1; i++) q = items[i].p - 1;
    return q;
  }
  // lowest occupied lane coordinate of belt n (Infinity when it has room all the way to its entry)
  function laneTail(n) {
    const l = n._l, items = n.items;
    let t = items.length ? sOf(l.len, items[items.length - 1]) : Infinity;
    if (l.merger) { const q = mergerQ(l.merger); if (q < t) t = q; }
    return t;
  }
  // How far (0..HALF) past the exit edge a side-loading item may be without crowding the target's items.
  function mergeRoom(n, mid) {
    const items = n.items, len = n._l.len;
    let e = HALF;
    for (let i = 0; i < items.length; i++) {
      const d = sOf(len, items[i]) - mid;
      if (d > -SP && d < SP) { const m = HALF - Math.sqrt(SP * SP - d * d); if (m < e) e = m; }
    }
    return e;
  }
  // Highest lane coordinate a newly joined item may take (behind the next item ahead of the middle).
  function roomAhead(n, mid) {
    const items = n.items, len = n._l.len;
    let r = Infinity;
    for (let i = 0; i < items.length; i++) { const q = sOf(len, items[i]); if (q >= mid - EPS && q - SP < r) r = q - SP; }
    return r;
  }
  // May belt b start sliding an item onto the middle of belt n?
  function canCommit(b, n) {
    const nl = n._l;
    if (nl.merger && nl.merger !== b) return false;
    const items = n.items, mid = nl.len * 0.5;
    // anything on the first half of the target lane has right of way...
    if (items.length && sOf(nl.len, items[items.length - 1]) < mid - EPS) return false;
    // ...and so does the item about to roll in from the target's own feeder
    const c = nl.feeder;
    if (c && c.items.length && sOf(c._l.len, c.items[0]) - c._l.len > -SP + EPS) return false;
    // two side-loaders take turns
    if (nl.lastSide === b.dir && nl.sides && nl.sides.length > 1) {
      for (const o of nl.sides) if (o !== b && o.items.length && sOf(o._l.len, o.items[0]) >= o._l.len - 0.05) return false;
    }
    return true;
  }
  // Is the middle of belt n free for an item dropped onto it from the side?
  function midFree(n) {
    const l = n._l;
    if (l.merger) return false;
    const mid = l.len * 0.5, items = n.items;
    for (let i = 0; i < items.length; i++) { const d = sOf(l.len, items[i]) - mid; if (d > -SP + EPS && d < SP - EPS) return false; }
    return true;
  }

  function moveBelt(b, v) {
    const items = b.items;
    if (!items.length) return;
    const l = b._l, len = l.len;
    const mqLim = l.merger ? mergerQ(l.merger) - SP : Infinity; // items behind a merging item wait for it
    if (l.mode === SIDE) { moveSide(b, l, v, mqLim); return; }
    let prev = Infinity, i = 0;
    const head = items[0];
    if (head.tk === tick) { prev = head.p * len; i = 1; }
    else {
      const s = head.p * len;
      let lim = l.mode === ENTER ? len + laneTail(l.next) - SP : l.mode === HEADON ? headOnLimit(l) : len;
      if (s <= mqLim + EPS && mqLim < lim) lim = mqLim;
      let ns = s + v; if (ns > lim) ns = lim; if (ns < s) ns = s;
      if (ns >= len - EPS && (l.mode === ENTER || l.mode === SINK || l.mode === INJECT) && handOver(b, l, head, ns)) {
        prev = l.mode === ENTER ? ns : Infinity; // the next item is now items[0]
      } else {
        if (ns > len) ns = len;
        head.p = ns / len; prev = ns; i = 1;
      }
    }
    for (; i < items.length; i++) {
      const it = items[i];
      const s = it.p * len;
      if (it.tk === tick) { prev = s; continue; }
      let lim = prev - SP; if (lim > len) lim = len;
      if (s <= mqLim + EPS && mqLim < lim) lim = mqLim;
      let ns = s + v; if (ns > lim) ns = lim; if (ns < s) ns = s;
      it.p = ns / len; prev = ns;
    }
  }
  // Two belts pointing at each other share the gap: our head may come up to SP short of theirs.
  function headOnLimit(l) {
    const o = l.next, oh = o.items[0];
    return oh ? l.len - SP + (o._l.len - Math.min(o._l.len, sOf(o._l.len, oh))) : l.len;
  }
  // Head of belt b reached its exit edge: pass it on. Returns true when it left b.
  function handOver(b, l, it, ns) {
    const nx = l.next;
    if (l.mode === ENTER) {
      const nl = nx._l;
      let q = ns - l.len; if (q < 0) q = 0; else if (q > nl.len) q = nl.len;
      b.items.shift(); it.p = q / nl.len; it.tk = tick; nx.items.push(it);
      return true;
    }
    if (l.mode === SINK) {
      if (!accepts(nx, it.type)) return false;
      b.items.shift();
      receive(nx, it.type, it.uid, b);
      return true;
    }
    if (l.mode === INJECT) {
      if (!midFree(nx)) return false;
      b.items.shift(); it.p = 0.5; it.tk = tick; insertSorted(nx.items, it);
      return true;
    }
    return false;
  }
  function moveSide(b, l, v, mqLim) {
    const items = b.items, len = l.len, nx = l.next, nl = nx._l, mid = nl.len * 0.5;
    let prev = Infinity, i = 0;
    while (i < items.length) {
      const it = items[i];
      const s = sOf(len, it);
      if (it.tk === tick) { prev = s; i++; continue; }
      let lim = prev - SP;
      if (s <= mqLim + EPS && mqLim < lim) lim = mqLim;
      let merging = it.p > 1;
      if (!merging && s + v >= len - EPS && lim > len + EPS && canCommit(b, nx)) {
        merging = true; nl.merger = b; nl.lastSide = b.dir;
      }
      if (!merging) {
        if (lim > len) lim = len;
        let ns = s + v; if (ns > lim) ns = lim; if (ns < s) ns = s;
        it.p = ns / len; prev = ns; i++;
        continue;
      }
      const eMax = mergeRoom(nx, mid);
      let target = s + v; if (target > lim) target = lim;
      if (i === 0 && eMax >= HALF - EPS && target >= len + HALF - EPS) {
        // on the target's centre line: join its lane
        let q = mid + (target - len - HALF);
        const room = roomAhead(nx, mid);
        if (q > room) q = room; if (q < mid) q = mid;
        items.shift(); it.p = q / nl.len; it.tk = tick; insertSorted(nx.items, it);
        prev = len + HALF;
        continue;
      }
      let ns = target; if (ns > len + eMax) ns = len + eMax; if (ns < s) ns = s;
      it.p = ns > len ? 1 + (ns - len) : ns / len;
      prev = ns; i++;
    }
    if (nl.merger === b && !(items.length && items[0].p > 1)) nl.merger = null;
  }

  function updateBelts(v) {
    const version = linkVersion;
    for (let i = 0; i < order.length; i++) {
      if (dirty || linkVersion !== version) break; // an event listener rebuilt something mid-tick: carry on next tick
      moveBelt(order[i], v);
    }
  }

  // ---------- buildings receiving / emitting items ----------
  function accepts(t, type) {
    if (t.kind === 'chest') return t.total < BUILDINGS.chest.capacity;
    if (t.kind === 'workshop') return workshopAccepts(t, type);
    return false;
  }
  function receive(t, type, uid, from) {
    if (t.kind === 'chest') {
      t.items[type] = (t.items[type] || 0) + 1; t.total++;
      bump(`stored.${type}`);
      events.emit('chest:received', { entity: t, item: type, uid, from });
    } else {
      t.input[type] = (t.input[type] || 0) + 1;
      events.emit('workshop:received', { entity: t, item: type, uid, from });
    }
  }
  // A building outputs onto a belt: at its entry edge when it sits behind the belt's entry, else onto the middle.
  function insertOnBelt(t, type, dir) {
    if (t.dir === opposite(dir)) return null; // head-on
    if (opposite(dir) === t.from) {
      if (laneTail(t) < SP - EPS) return null;
      const it = makeItem(type, 0); t.items.push(it);
      return it;
    }
    if (!midFree(t)) return null;
    const it = makeItem(type, 0.5); insertSorted(t.items, it);
    return it;
  }
  // Drill / workshop output in its facing direction. Returns the receiving entity or null; outUid = new belt item.
  let outUid = 0;
  function output(src, type) {
    outUid = 0;
    const [dx, dz] = DIRS[src.dir];
    const t = at(src.x + dx, src.z + dz);
    if (!t) return null;
    if (t.kind === 'belt') { const it = insertOnBelt(t, type, src.dir); if (!it) return null; outUid = it.uid; return t; }
    if (!accepts(t, type)) return null;
    receive(t, type, 0, src);
    return t;
  }

  // ---------- drills ----------
  function drillOut(d) {
    const item = d.held;
    const t = output(d, item);
    if (!t) return;
    d.held = null;
    events.emit('drill:output', { entity: d, item, target: t, uid: outUid });
  }
  function updateDrills(dt) {
    const interval = BUILDINGS.drill.interval;
    for (const d of drills) {
      if (d.held) drillOut(d);
      if (!d.held) {
        d.timer += dt;
        if (d.timer >= interval) {
          d.timer -= interval; if (d.timer >= interval) d.timer = 0;
          d.held = d.output;
          bump(`mined.${d.output}`);
          events.emit('drill:mined', { entity: d, item: d.output });
          drillOut(d);
        }
        d.progress = Math.min(1, d.timer / interval);
      }
      d.working = !d.held;
    }
  }

  // ---------- workshops ----------
  function workshopAccepts(w, item) {
    const r = w.recipe && RECIPES[w.recipe];
    if (!r || !r.inputs[item]) return false;
    return (w.input[item] || 0) < r.inputs[item] * 2;
  }
  const sumValues = o => { let n = 0; for (const k in o) n += o[k]; return n; };
  const outputTotal = w => sumValues(w.output);
  function updateWorkshops(dt) {
    const cap = BUILDINGS.workshop.outputBuffer, interval = BUILDINGS.workshop.outputInterval;
    for (const w of workshops) {
      const r = w.recipe ? RECIPES[w.recipe] : null;
      if (r && !w.crafting && outputTotal(w) + sumValues(r.outputs) <= cap && Object.entries(r.inputs).every(([k, n]) => (w.input[k] || 0) >= n)) {
        for (const [k, n] of Object.entries(r.inputs)) w.input[k] -= n;
        w.crafting = true; w.progress = 0;
        events.emit('workshop:start', { entity: w });
      }
      if (w.crafting) {
        if (!r) { w.crafting = false; w.progress = 0; } else {
          w.progress = Math.min(1, w.progress + dt / r.time);
          if (w.progress >= 1) {
            w.crafting = false; w.progress = 0;
            for (const [k, n] of Object.entries(r.outputs)) { w.output[k] = (w.output[k] || 0) + n; bump(`machined.${k}`, n); }
            events.emit('workshop:crafted', { entity: w, outputs: { ...r.outputs } });
          }
        }
      }
      w.outTimer += dt;
      if (w.outTimer >= interval) {
        let item = null;
        for (const k in w.output) if (w.output[k] > 0) { item = k; break; }
        if (!item) w.outTimer = interval;
        else {
          const t = output(w, item);
          if (t) {
            w.output[item]--; w.outTimer = 0;
            events.emit('workshop:output', { entity: w, item, target: t, uid: outUid });
          }
        }
      }
    }
  }

  // ---------- hand crafting ----------
  function updateCrafting(dt) {
    let left = dt;
    while (craftQueue.length && left > 0) {
      const job = craftQueue[0];
      job.t += left; left = 0;
      if (job.t < job.time) break;
      left = job.t - job.time; job.t = job.time;
      craftQueue.shift();
      const r = RECIPES[job.recipe];
      for (const [k, n] of Object.entries(r.outputs)) { inventory.add(k, n); bump(`crafted.${k}`, n); }
      events.emit('craft:done', { recipe: job.recipe, outputs: { ...r.outputs } });
    }
  }

  function stepSim(dt) {
    time += dt; tick++;
    if (dirty) relink();
    updateDrills(dt);
    updateWorkshops(dt);
    if (dirty) relink();
    updateBelts(BELT.speed * dt);
    updateCrafting(dt);
  }

  // ---------- public API ----------
  const sim = {
    map, events, entities, inventory, player, metrics, craftQueue, quest,
    get time() { return time; },
    at, beltPath, beltShape, beltLength,
    belts, drills, chests, workshops,

    // Fixed-size sub-steps (<= 1/30 s) keep big frames exact.
    update(dt) {
      if (!(dt > 0)) return;
      const n = Math.max(1, Math.ceil(dt / MAX_STEP - 1e-9));
      const h = dt / n;
      for (let i = 0; i < n; i++) stepSim(h);
    },

    // Tile walkable for the player: ground and no blocking entity.
    isWalkable(x, z) {
      if (!map.isGround(x, z)) return false;
      const e = at(x, z);
      if (!e) return true;
      if (e.resource) return !RESOURCES[e.kind].blocking;
      return !BUILDINGS[e.kind].blocking;
    },
    // The tile under the player's centre (call it whenever that tile changes). Non-integer x / z are rounded to
    // the tile they fall on. dir: 0..3 (anything else keeps the current facing). Emits player:moved on a new tile.
    setPlayer(x, z, dir = player.dir) {
      const tx = tileOf(Number(x)), tz = tileOf(Number(z));
      if (!Number.isFinite(tx) || !Number.isFinite(tz)) return;
      const moved = tx !== player.x || tz !== player.z;
      player.x = tx; player.z = tz;
      if (Number.isInteger(dir)) player.dir = normDir(dir);
      // the exact position only stays while it still lies on this tile (a teleport resets it to the centre)
      if (tileOf(player.wx) !== tx || tileOf(player.wz) !== tz) { player.wx = tx; player.wz = tz; }
      if (moved) events.emit('player:moved', { x: tx, z: tz, dir: player.dir });
    },
    // Additive, optional: the player's exact feet position in world units, cheap to call every frame (no event
    // unless the tile under the centre changes, which it forwards to setPlayer). With it, canPlace also refuses
    // blocking buildings on neighbour tiles the critter's footprint (PLAYER_RADIUS) overlaps.
    setPlayerPos(wx, wz, dir) {
      wx = Number(wx); wz = Number(wz);
      if (!Number.isFinite(wx) || !Number.isFinite(wz)) return;
      player.wx = wx; player.wz = wz;
      const tx = tileOf(wx), tz = tileOf(wz);
      if (tx !== player.x || tz !== player.z || (Number.isInteger(dir) && normDir(dir) !== player.dir)) sim.setPlayer(tx, tz, dir);
    },

    // { ok, reason }
    canPlace(kind, x, z, dir = 0) {
      const def = BUILDINGS[kind];
      if (!def) return { ok: false, reason: 'Unknown building' };
      if (!map.isLand(x, z)) return { ok: false, reason: map.isBridge(x, z) ? 'Can\'t build on bridges' : 'Can\'t build on water' };
      if (at(x, z)) return { ok: false, reason: 'Something is already here' };
      if (def.blocking && playerOn(x, z)) return { ok: false, reason: 'You\'re standing there' };
      if (def.needsDeposit && !map.depositAt(x, z)) return { ok: false, reason: 'Drills go on ore or stone deposits' };
      return { ok: true, reason: '' };
    },
    // Places from inventory. Returns { ok, reason, entity }.
    place(kind, x, z, dir = 0) {
      const def = BUILDINGS[kind];
      const check = sim.canPlace(kind, x, z, dir);
      if (!check.ok) return check;
      if (!inventory.has(def.item)) return { ok: false, reason: `No ${ITEMS[def.item].name.toLowerCase()}s left. Craft more` };
      inventory.remove(def.item);
      const e = { kind, x, z, dir: def.rotatable ? normDir(dir) : 1 };
      if (kind === 'belt') { e.items = []; e.from = opposite(e.dir); e.shape = 'straight'; attachLink(e); }
      if (kind === 'drill') { const dep = DEPOSITS[map.depositAt(x, z)]; e.deposit = dep.id; e.output = dep.item; e.timer = 0; e.progress = 0; e.held = null; e.working = true; }
      if (kind === 'chest') { e.items = {}; e.total = 0; }
      if (kind === 'workshop') { e.recipe = null; e.input = {}; e.output = {}; e.progress = 0; e.crafting = false; e.outTimer = 0; }
      addEntity(e);
      if (kind === 'belt') { e.from = computeFrom(e); e.shape = beltShape(e); }
      refreshBeltsAround(x, z);
      bump(`placed.${kind}`);
      if (kind === 'drill') bump(`placed.drill.${e.deposit}`);
      events.emit('build:placed', { entity: e });
      return { ok: true, reason: '', entity: e };
    },
    rotate(id, by = 1) {
      const e = entities.get(id);
      if (!e || e.resource || !BUILDINGS[e.kind].rotatable) return false;
      e.dir = normDir(e.dir + by);
      if (e.kind === 'belt') { e.from = computeFrom(e); e.shape = beltShape(e); respace(e); }
      refreshBeltsAround(e.x, e.z);
      events.emit('build:rotated', { entity: e });
      return true;
    },
    // Picks a building back up. Its item and contents return to the inventory.
    remove(id) {
      const e = entities.get(id);
      if (!e || e.resource) return null;
      const returned = { [BUILDINGS[e.kind].item]: 1 };
      const give = (k, n) => { if (n > 0) returned[k] = (returned[k] || 0) + n; };
      // (the removed entity keeps its contents so views can animate them; it is no longer in the sim)
      if (e.kind === 'belt') e.items.forEach(it => give(it.type, 1));
      if (e.kind === 'chest') Object.entries(e.items).forEach(([k, n]) => give(k, n));
      if (e.kind === 'workshop') {
        Object.entries(e.input).forEach(([k, n]) => give(k, n));
        Object.entries(e.output).forEach(([k, n]) => give(k, n));
        if (e.crafting && RECIPES[e.recipe]) Object.entries(RECIPES[e.recipe].inputs).forEach(([k, n]) => give(k, n));
      }
      if (e.kind === 'drill' && e.held) give(e.held, 1);
      dropEntity(e);
      refreshBeltsAround(e.x, e.z);
      for (const [k, n] of Object.entries(returned)) inventory.add(k, n, { x: e.x, z: e.z });
      events.emit('build:removed', { entity: e, returned });
      return returned;
    },

    // Hit a tree / rock / stump once. fromDir: direction from the player to the target.
    // opts.collect = false (camp): drops are returned, not added to the inventory; the caller decides where they go.
    hitResource(id, fromDir = 1, { collect = true } = {}) {
      const e = entities.get(id);
      if (!e || !e.resource) return null;
      e.hp--;
      events.emit('resource:hit', { entity: e, fromDir, hp: e.hp });
      if (e.hp > 0) return { depleted: false };
      const def = RESOURCES[e.kind];
      dropEntity(e);
      let replacedBy = null;
      if (def.becomes) {
        const nd = RESOURCES[def.becomes];
        replacedBy = addEntity({ kind: def.becomes, x: e.x, z: e.z, hp: nd.hp, maxHp: nd.hp, variant: e.variant, rot: e.rot, scale: e.scale, resource: true });
      }
      if (e.kind === 'tree') bump('felled.tree');
      events.emit('resource:depleted', { entity: e, fromDir, drops: { ...def.drops }, replacedBy });
      if (collect) for (const [k, n] of Object.entries(def.drops)) { inventory.add(k, n, { x: e.x, z: e.z }); bump(`collected.${k}`, n); }
      else for (const [k, n] of Object.entries(def.drops)) bump(`collected.${k}`, n);
      return { depleted: true, drops: { ...def.drops }, replacedBy, entity: e, kind: e.kind, x: e.x, z: e.z, variant: e.variant, rot: e.rot, scale: e.scale };
    },
    // Camp: put a resource back (regrowth). Emits resource:spawned { entity, grow } so props can grow it in.
    spawnResource(kind, x, z, { variant = 0, rot = 0, scale = 1, grow = false } = {}) {
      const def = RESOURCES[kind];
      if (!def || !map.isLand(x, z) || at(x, z)) return null;
      const e = addEntity({ kind, x, z, hp: def.hp, maxHp: def.hp, variant, rot, scale, resource: true });
      events.emit('resource:spawned', { entity: e, grow });
      return e;
    },
    // Camp: remove a resource without drops (a stump regrowing into a tree, a building clearing its footprint).
    removeResource(id, { regrow = false } = {}) {
      const e = entities.get(id);
      if (!e || !e.resource) return null;
      dropEntity(e);
      events.emit('resource:removed', { entity: e, regrow });
      return e;
    },
    // Additive helper for the Space / E control: the resource (tree, rock, stump) nearest to world point (x, z)
    // whose tile centre lies within `radius` tiles (Euclidean, so reach 1.5 covers the 8 neighbours), or null.
    // dir (optional) prefers targets in the facing direction: a direction index 0..3, a heading in radians
    // (atan2(dz, dx), any non-integer number) or a vector [dx, dz] / { x, z }. Score = distance * (1 - 0.5 cos a),
    // a = angle between the facing and the target, so something straight ahead beats an equally near target to
    // the side or behind, but a much closer one still wins. Ties go to the lower entity id (deterministic).
    nearestResource(x, z, radius = 1.5, dir) {
      x = Number(x); z = Number(z); radius = Number(radius);
      if (!Number.isFinite(x) || !Number.isFinite(z) || !(radius >= 0)) return null;
      let fx = 0, fz = 0;
      if (Array.isArray(dir)) { fx = Number(dir[0]) || 0; fz = Number(dir[1]) || 0; }
      else if (dir && typeof dir === 'object') { fx = Number(dir.x ?? dir.dx) || 0; fz = Number(dir.z ?? dir.dz) || 0; }
      else if (Number.isInteger(dir)) [fx, fz] = DIRS[normDir(dir)];
      else if (Number.isFinite(dir)) { fx = Math.cos(dir); fz = Math.sin(dir); }
      const fl = Math.hypot(fx, fz);
      if (fl > 1e-9) { fx /= fl; fz /= fl; } else { fx = fz = 0; }
      const r2 = radius * radius + 1e-9;
      let best = null, bestScore = Infinity;
      for (let tz = Math.ceil(z - radius); tz <= Math.floor(z + radius); tz++) {
        for (let tx = Math.ceil(x - radius); tx <= Math.floor(x + radius); tx++) {
          const dx = tx - x, dz = tz - z, d2 = dx * dx + dz * dz;
          if (d2 > r2) continue;
          const e = at(tx, tz);
          if (!e || !e.resource) continue;
          const d = Math.sqrt(d2);
          const cos = d > 1e-9 ? (dx * fx + dz * fz) / d : 1;
          const score = d * (1 - FACING_BIAS * cos);
          if (score < bestScore - 1e-9 || (score < bestScore + 1e-9 && best && e.id < best.id)) { best = e; bestScore = score; }
        }
      }
      return best;
    },
    // Hand-mine one item from a deposit tile with nothing built on it.
    mineDeposit(x, z) {
      const code = map.depositAt(x, z);
      if (!code || at(x, z)) return null;
      const item = DEPOSITS[code].item;
      events.emit('deposit:mined', { x, z, item });
      inventory.add(item, 1, { x, z });
      bump(`collected.${item}`);
      return item;
    },

    // ---------- crafting ----------
    canCraft: (recipe, n = 1) => !!RECIPES[recipe] && Object.entries(RECIPES[recipe].inputs).every(([k, c]) => inventory.get(k) >= c * n),
    maxCraftable(recipe) {
      const r = RECIPES[recipe];
      if (!r) return 0;
      return Math.min(...Object.entries(r.inputs).map(([k, c]) => Math.floor(inventory.get(k) / c)));
    },
    // Queues hand crafts; ingredients are taken now. Returns how many were queued.
    craft(recipe, n = 1) {
      const r = RECIPES[recipe];
      if (!r || !r.hand) return 0;
      const count = Math.min(n, sim.maxCraftable(recipe));
      if (count <= 0) {
        const missing = Object.entries(r.inputs).filter(([k, c]) => inventory.get(k) < c).map(([k, c]) => `${c - inventory.get(k)} ${ITEMS[k].name.toLowerCase()}`);
        toast(`Need ${missing.join(' and ')}`);
        return 0;
      }
      for (let i = 0; i < count; i++) {
        for (const [k, c] of Object.entries(r.inputs)) inventory.remove(k, c);
        craftQueue.push({ recipe, t: 0, time: r.time });
      }
      events.emit('craft:queued', { recipe, count });
      return count;
    },
    cancelCraft(index) {
      const job = craftQueue[index];
      if (!job) return false;
      craftQueue.splice(index, 1);
      for (const [k, c] of Object.entries(RECIPES[job.recipe].inputs)) inventory.add(k, c);
      events.emit('craft:cancelled', { recipe: job.recipe });
      return true;
    },

    // ---------- chests & workshops ----------
    takeChest(id) {
      const e = entities.get(id);
      if (!e || e.kind !== 'chest' || !e.total) return null;
      const items = { ...e.items };
      e.items = {}; e.total = 0;
      for (const [k, n] of Object.entries(items)) if (n) inventory.add(k, n, { x: e.x, z: e.z });
      events.emit('chest:taken', { entity: e, items });
      return items;
    },
    // Moves items from the inventory into a chest. item null = every raw resource. Returns how many moved.
    storeInChest(id, item, n = Infinity) {
      const e = entities.get(id);
      if (!e || e.kind !== 'chest') return 0;
      if (item == null) {
        let moved = 0;
        for (const k of RESOURCE_ITEMS) moved += sim.storeInChest(id, k, n - moved);
        return moved;
      }
      const space = BUILDINGS.chest.capacity - e.total;
      const k = Math.min(n, space, inventory.get(item));
      if (!(k > 0)) return 0;
      inventory.remove(item, k);
      e.items[item] = (e.items[item] || 0) + k; e.total += k;
      bump(`stored.${item}`, k);
      events.emit('chest:received', { entity: e, item, count: k });
      return k;
    },
    setRecipe(id, recipe) {
      const e = entities.get(id);
      if (!e || e.kind !== 'workshop' || (recipe && !RECIPES[recipe]?.machine)) return false;
      recipe = recipe || null;
      if (e.recipe === recipe) return true;
      for (const [k, n] of Object.entries(e.input)) if (n) inventory.add(k, n, { x: e.x, z: e.z });
      if (e.crafting && RECIPES[e.recipe]) for (const [k, n] of Object.entries(RECIPES[e.recipe].inputs)) inventory.add(k, n, { x: e.x, z: e.z });
      e.recipe = recipe; e.input = {}; e.crafting = false; e.progress = 0;
      events.emit('workshop:recipe', { entity: e });
      return true;
    },
    // Fills a workshop's input buffer from the inventory.
    feedWorkshop(id) {
      const e = entities.get(id);
      if (!e || e.kind !== 'workshop' || !e.recipe) return 0;
      let moved = 0;
      for (const [k, n] of Object.entries(RECIPES[e.recipe].inputs)) {
        const want = Math.min(n * 2 - (e.input[k] || 0), inventory.get(k));
        if (want > 0) { inventory.remove(k, want); e.input[k] = (e.input[k] || 0) + want; moved += want; events.emit('workshop:received', { entity: e, item: k, count: want }); }
      }
      return moved;
    },
    takeWorkshop(id) {
      const e = entities.get(id);
      if (!e || e.kind !== 'workshop') return null;
      const items = { ...e.output };
      e.output = {};
      for (const [k, n] of Object.entries(items)) if (n) inventory.add(k, n, { x: e.x, z: e.z });
      return items;
    },
    workshopAccepts,
    currentQuest: () => null, // quests are off: always null (kept for API compatibility)
    toast,

    // Debug / scenario helper: put a new item straight onto a belt at progress p (0..1) if it fits there
    // (spacing to its neighbours, including across belt edges). Returns the item or null.
    spawnBeltItem(id, type, p = 0) {
      const b = entities.get(id);
      if (!b || b.kind !== 'belt' || !ITEMS[type]) return null;
      if (dirty) relink();
      const l = b._l, len = l.len;
      const s = Math.min(1, Math.max(0, Number(p) || 0)) * len;
      for (const o of b.items) if (Math.abs(sOf(len, o) - s) < SP - EPS) return null;
      if (l.merger && Math.abs(mergerQ(l.merger) - s) < SP - EPS) return null;
      if (l.mode === ENTER) { const t = laneTail(l.next); if (len + t - s < SP - EPS) return null; }
      if (l.mode === HEADON && s > headOnLimit(l) + EPS) return null;
      if (l.feeder && l.feeder.items.length) {
        const c = l.feeder;
        if (s - (sOf(c._l.len, c.items[0]) - c._l.len) < SP - EPS) return null;
      }
      const it = makeItem(type, s / len);
      insertSorted(b.items, it);
      return it;
    },
  };
  return sim;
}
