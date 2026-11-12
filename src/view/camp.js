// Camp view: draws the camp stations and their production lines from ctx.camp state + camp events
// (GAMEPLAY.md). Stations rise out of the ground when built, work visibly (saw spins up, pot bubbles, drills
// plunge, the smelter glows), lines carry items exactly at their sim p, outputs hop onto generous heaps, drop
// zones breathe on the ground and light up when you stand in them, and every converting station wears a little
// wooden sign (input icon -> output icon) so it explains itself (FIRST-20.md).
//
// The hearth keeps growing with the camp: a bigger, taller flame and a wider pool of light every level, a spark
// column and lit lanterns at level 4, a bonfire with a crown of sparks at level 5 (camp/stations.js, camp/fire.js).
// Pickup piles are heaps that grow taller and spill past their pallet, bump on every arrival and part around Dug
// while he wades in to take from them (camp/piles.js + drawPile here).
//
// Draw calls (everything built): ~7 station bodies + ~10 moving parts + 3 line shapes + 1 pallets +
// 3 fire systems + 1 hearth lamps + up to 7 item pools + 1 zone/ring mesh + <= 4 sign meshes (<= 46). All motion
// is driven from update(dt).
//
// API (views.campview): { object, stationObject(id), pileTop(id), pileCrest(id), zoneCenter(id), intakePoint(id),
//   inputPoint(id) (alias of intakePoint), lineEnd(id), stationTop(id), signPoint(id), coveredTiles(id),
//   createModel(id), update, info() }
import * as THREE from 'three';
import { Spring, ease, clamp } from '../util/anim.js';
import { CAMP, STATIONS } from '../sim/camp-data.js';
import { createItemPools } from './camp/itempool.js';
import { createFireSystem } from './camp/fire.js';
import { createLines, lineLayout, RIDE_Y } from './camp/lines.js';
import { pileSlot, pileLayout, pileCrest, PALLET_TOP } from './camp/piles.js';
import { createZones } from './camp/zones.js';
import { buildStationRig } from './camp/stations.js';
import { createSlots, popScale } from './camp/slots.js';
import { createSigns } from './camp/signs.js';
import { Parts, rbox, C } from './camp/geo.js';

const RISE = { anticipation: 0.17, rise: 0.42, depth: 0.45 };
const EMERGE = 0.42;               // line p over which an output slides from the station onto the belt
const FLY_LAG = 0.3;               // pack -> station flight time if fx is missing (fx says when it lands: fx:dropArrived)
const FX_WAIT = 0.75;              // longest we wait for fx:dropArrived before showing a player's drop anyway
const rectCenter = ([x, z, w, h]) => ({ x: x + (w - 1) / 2, z: z + (h - 1) / 2 });

// Signposts, in station-local space (+z = south, toward the camera): post foot and post height. The sawmill and
// the cookfire wear theirs on the side that faces the hearth (so both signs flank the middle of the camp, where you
// spend the first minutes), the quarry and the drill on the side away from their line, the smelter (boxed in by
// lines) behind its kiln. Never over the rack, basket, blade, pot or hopper.
const SIGN_MOUNT = {
  sawmill: { base: [1.32, 0, -0.32], post: 0.86 },
  cookfire: { base: [-1.42, 0, -0.32], post: 0.86 },
  smelter: { base: [0.0, 0, -0.92], post: 1.38 },
  quarry: { base: [-1.28, 0, -0.3], post: 0.86 },
  copperDrill: { base: [-1.28, 0, -0.3], post: 0.86 },
};
const SIGN_DELAY = 0.22;           // after the station has risen, the sign springs up on its post

function palletGeometry() {
  const p = new Parts({ ao: { y0: 0, y1: 0.06, min: 0.85 } });
  for (const z of [-0.3, 0, 0.3]) p.add(rbox(0.82, 0.03, 0.09, 0.012), C.woodDark, { p: [0, 0.015, z] });
  for (let i = 0; i < 5; i++) p.add(rbox(0.15, 0.03, 0.84, 0.012), i % 2 ? C.wood : C.woodLight, { p: [-0.34 + i * 0.17, 0.045, 0], jitter: 0.03, seed: i + 3 });
  return p.merge();
}
// (PALLET_TOP comes from piles.js) Dug wading into a heap pushes the items within PART.radius of him aside
const PART = { reach: 0.62, radius: 0.36 };
// heap shading: items at the foot of a heap get `low`, those `height` up and above get `high` (untinted)
const HEAP_SHADE = { low: new THREE.Color(0.7, 0.64, 0.6), high: new THREE.Color(1, 1, 1), height: 0.42 };
const _tint = new THREE.Color();

export function create(ctx) {
  const { scene, camp, events, views } = ctx;
  if (!camp) return {};
  const mobile = ctx.quality?.tier === 'mobile' || !!ctx.mobile;

  const group = new THREE.Group();
  group.name = 'campview';
  scene.add(group);

  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const pools = createItemPools(ctx, group, { castShadow: !mobile });
  const fire = createFireSystem(ctx, group, { mobile });
  const lines = createLines(ctx, group, { castShadow: !mobile });
  const zones = createZones(group);
  let signs = null;
  try { signs = createSigns(ctx, group, { castShadow: !mobile }); } catch (e) { console.error('[campview] signs', e); signs = null; }

  const pallets = new THREE.InstancedMesh(palletGeometry(), material, 8);
  pallets.count = 0; pallets.frustumCulled = false; pallets.receiveShadow = true; pallets.castShadow = false;
  group.add(pallets);

  // warm light from the hearth (desktop only: an extra light costs every lit fragment on a phone)
  let hearthLight = null;
  if (!mobile) {
    hearthLight = new THREE.PointLight('#ffb36b', 0, 7, 1.5);
    hearthLight.castShadow = false;
    group.add(hearthLight);
  }

  const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4();
  const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
  const fx = () => views.fx;

  // ---------- world hops (pile arrivals are tracked per pile; these are line sinks + station hand-offs) ----------
  const hops = [];
  function hop(item, from, to, { dur = 0.3, arc = 0.35, shrink = false, onLand, yaw = 0, scale = 1 } = {}) {
    hops.push({ item, from: from.clone(), to: to.clone(), t: 0, dur, arc, shrink, onLand, yaw, scale });
  }

  // ---------- station views ----------
  const svs = new Map();
  const sharedEnv = {
    THREE, material, pools, fire, camp, mobile, cast: true,
    get fx() { return fx(); },
    mesh(geo) { const m = new THREE.Mesh(geo, material); m.castShadow = true; m.receiveShadow = true; return m; },
    slots: n => createSlots(n),
    hop,
  };

  function addStation(id, animate) {
    if (svs.has(id)) return svs.get(id);
    const def = STATIONS[id];
    if (!def) return null;
    let rig = null;
    const env = Object.create(sharedEnv);
    env.toWorld = v => (rig ? rig.root.localToWorld(v) : v);
    env.state = () => camp.stations.get(id);
    // input count the station shows: what the sim holds minus drops that are still flying in
    env.inputShown = key => Math.max(0, (camp.stations.get(id)?.input?.[key] || 0) - (svs.get(id)?.pending.length || 0));
    rig = buildStationRig(id, env);
    if (!rig) return null;
    const c = rectCenter(def.footprint);
    rig.root.position.set(c.x, 0, c.z);
    group.add(rig.root);
    // phones: only the station bodies cast shadows (moving parts, flags and decor stay out of the shadow pass)
    if (mobile) rig.root.children.forEach((o, i) => { if (i > 0) o.traverse(m => { m.castShadow = false; }); });
    const sv = {
      id, def, rig, root: rig.root, center: new THREE.Vector3(c.x, 0, c.z),
      riseT: animate ? 0 : -1, risen: !animate,
      squash: new Spring(1, { stiffness: 250, damping: 12 }),
      lean: new Spring(0, { stiffness: 170, damping: 9 }),
      layout: def.line ? lineLayout(def, STATIONS) : null,
      lineT: animate ? -10 : 100,  // seconds since the line started rolling out
      zone: null, zoneAppear: animate ? 0 : 1,
      pile: def.pile ? {
        tile: def.pile, item: def.recipe?.out || def.auto?.out, hops: [], last: 0,
        bounce: new Spring(1, { stiffness: 300, damping: 14 }),
        full: false, fullT: 10, tagSway: new Spring(0, { stiffness: 160, damping: 6 }), takeT: 10, ring: null,
      } : null,
      leanDir: { x: 0, z: 1 },
      pending: [],     // drops still in flight (seconds left)
      triggered: {},
      sign: SIGN_MOUNT[id] && signs?.has(id) ? {
        mount: SIGN_MOUNT[id], shape: signs.shapeFor(id), t: 10, wait: animate,
        sway: new Spring(0, { stiffness: 150, damping: 7 }), twist: new Spring(0, { stiffness: 120, damping: 6 }),
        phase: [...id].reduce((a, ch) => a + ch.charCodeAt(0) * 0.37, 0) % (Math.PI * 2),
      } : null,
    };
    if (def.zone) {
      const zc = rectCenter(def.zone);
      sv.leanDir = { x: Math.sign(zc.x - c.x) * (Math.abs(zc.x - c.x) > Math.abs(zc.z - c.z) ? 1 : 0), z: Math.sign(zc.z - c.z) * (Math.abs(zc.z - c.z) >= Math.abs(zc.x - c.x) ? 1 : 0) };
      sv.zone = zones.add(def.zone, sv.center);
      sv.zone.appear = animate ? 0 : 1;
      sv.zoneItem = def.accepts?.[0] || null;
    }
    if (sv.pile) {
      sv.pile.last = camp.stations.get(id)?.pile?.count || 0;
      sv.pile.full = sv.pile.last >= CAMP.pileCap;
      // a soft pickup ring around the pallet: faint at rest, warm while you stand on it taking items
      sv.pile.ring = zones.add([def.pile[0], def.pile[1], 1, 1], null, { ring: true, grow: 0.24 });
      sv.pile.ring.appear = animate ? 0 : 0.5;
    }
    svs.set(id, sv);
    coverGround(id);
    if (animate) {
      // start hidden underground at the anticipation pose, so no frame shows the finished model
      const h = rig.height || 1.2;
      rig.root.position.y = -RISE.depth * h;
      rig.root.scale.setScalar(0.62);
      // ground rumble before it bursts out
      fx()?.puff?.(new THREE.Vector3(c.x, 0.05, c.z), { count: 7, size: 0.16, spread: 0.8, up: 0.35, color: '#f6efdf' });
    }
    return sv;
  }

  // Grass blades, tufts and flowers must not poke through station bases, belts, pallets or drop zones: ask the
  // terrain to clear every tile the station covers (it eases them away).
  function coverGround(id) {
    const cover = views.terrain?.cover;
    if (typeof cover !== 'function') return;
    const def = STATIONS[id];
    if (!def) return;
    try {
      const rect = r => { if (r) cover.call(views.terrain, r[0], r[1], r[2], r[3], 1); };
      rect(def.footprint); rect(def.zone);
      for (const t of def.line || []) cover.call(views.terrain, t[0], t[1], 1, 1, 1);
      if (def.pile) cover.call(views.terrain, def.pile[0], def.pile[1], 1, 1, 1);
    } catch (e) { console.error('[campview] terrain cover', id, e); }
  }

  // the hearth is the heart of the camp: always drawn, even before the sim lists it as a station
  addStation('hearth', false);
  for (const id of camp.stations.keys()) addStation(id, false);

  // ---------- events ----------
  const offs = [];
  const on = (type, fn) => { const off = events.on(type, fn); if (typeof off === 'function') offs.push(off); };
  on('station:built', ({ station }) => {
    const sv = svs.get(station.id);
    if (sv) { sv.squash.kick(-2.5); return; }   // already drawn (the hearth): a happy hop instead
    addStation(station.id, true);
  });
  on('station:start', ({ station }) => { const sv = svs.get(station.id); sv?.rig.onStart?.(station); });
  on('station:produced', ({ station, item }) => {
    const sv = svs.get(station.id);
    if (!sv) return;
    sv.squash.kick(-1.5);
    sv.rig.onProduced?.(station, item);
    if (sv.sign) { sv.sign.sway.kick(-0.9); sv.sign.twist.kick(0.5); }
  });
  on('station:drop', ({ station, by }) => {
    const sv = svs.get(station.id);
    if (!sv) return;
    // the item is still flying (from the pack via fx, a worker's hands, or hopping off a line): the wobble,
    // the zone flash and the rack / basket / hopper growth land with it. A player's throw lands when fx says so
    // (fx:dropArrived); the timer is only a safety net.
    const line = by && camp.stations.has(by);
    const viaFx = by === 'player' && typeof views.fx?.flyItem === 'function';
    sv.pending.push({ t: line ? 0.32 : by === 'player' ? (viaFx ? FX_WAIT : FLY_LAG) : FLY_LAG * 0.6, flash: by === 'player', fx: viaFx });
  });
  on('fx:dropArrived', ({ station }) => {
    const sv = svs.get(station?.id);
    if (!sv) return;
    const i = sv.pending.findIndex(d => d.fx);
    if (i < 0) return;
    const d = sv.pending.splice(i, 1)[0];
    intakeWobble(sv);
    if (d.flash) sv.zone?.flash();
  });
  on('pile:take', ({ station, by }) => {
    const sv = svs.get(station?.id);
    if (sv?.pile && by === 'player') sv.pile.takeT = 0;
  });
  on('line:arrived', ({ station, item, to }) => {
    const sv = svs.get(station.id);
    if (!sv?.layout) return;
    const end = lineWorld(sv, sv.layout.len, _v).clone();
    if (to) {
      const tv = svs.get(to);
      const target = tv ? intakeWorld(tv, new THREE.Vector3()) : end.clone().add(new THREE.Vector3(0.4, 0.3, 0));
      hop(item, end, target, { dur: 0.32, arc: 0.3, shrink: true, yaw: -sv.layout.at(sv.layout.len).angle });
    } else if (sv.pile) {
      sv.pile.hops.push({ from: end, t: 0, dur: 0.3, yaw: -sv.layout.at(sv.layout.len).angle });
    }
  });
  on('pile:changed', ({ station }) => {
    const sv = svs.get(station.id);
    if (!sv?.pile) return;
    const n = station.pile.count;
    if (n < sv.pile.last) sv.pile.bounce.kick(-1.4);
    sv.pile.last = n;
  });
  // pads.js plays the shockwave / light rays / camera kick; the hearth itself flares, sheds embers and grows decor
  // (the hearth rig ducks the flame for a beat, then whooshes it up into its bigger size: see stations.js)
  on('hearth:level', ({ level }) => {
    const sv = svs.get('hearth');
    if (!sv) return;
    sv.rig.levelUp?.(level);
    sv.squash.kick(level <= 1 ? -2 : -3);
    if (level <= 1) flash = 1;
  });
  // the crowning moment (level 5): after the whoosh, a second roar with a fountain of sparks and confetti
  on('camp:complete', () => {
    const sv = svs.get('hearth');
    if (!sv) return;
    later(0.55, () => {
      sv.rig.fire?.flare?.(1.6);
      sv.squash.kick(-2.4);
      fire.burst(sv.rig.fire, 34);
      fire.burstColumn?.(sv.rig.fire, 36);
      fx()?.confetti?.(new THREE.Vector3(sv.center.x, 1.6, sv.center.z), { count: 40 });
      fx()?.sparkle?.(new THREE.Vector3(sv.center.x, 2.0, sv.center.z), { count: 18, spread: 1.0, size: 0.14, color: '#ffe27a' });
    });
  });
  const timers = [];
  const later = (t, fn) => timers.push({ t, fn });
  on('worker:hired', () => svs.get('hut')?.rig.openDoor?.());

  function intakeWobble(sv) {
    sv.squash.velocity = Math.max(-1.6, sv.squash.velocity - 0.55);
    sv.lean.velocity = clamp(sv.lean.velocity + 0.55, -1.4, 1.4);
  }
  function intakeWorld(sv, out) { out.copy(sv.rig.anchors.intake); return sv.root.localToWorld(out); }
  function lineWorld(sv, p, out) {
    const q = sv.layout.at(p);
    return out.set(q.x, RIDE_Y, q.z);
  }

  // ---------- per-frame ----------
  let flash = 0, time = 0;
  const playerPos = new THREE.Vector3();
  const hasPlayer = () => !!views.player?.getPosition;

  function updateStationTransform(sv, dt) {
    const h = sv.rig.height || 1.2;
    let y = 0, g = 1, jx = 0, jz = 0;
    if (sv.riseT >= 0) {
      const prev = sv.riseT;
      sv.riseT += dt;
      const t = sv.riseT, A = RISE.anticipation;
      if (t < A) {
        g = 0.62; y = -RISE.depth * h;
        const r = 0.025 * (t / A);
        jx = Math.sin(t * 95) * r; jz = Math.cos(t * 77) * r;
      } else {
        const u = clamp((t - A) / RISE.rise);
        y = -RISE.depth * h * (1 - ease.cubicOut(u));
        g = 0.62 + 0.38 * ease.backOut(u, 1.2);
        if (prev < A) {
          // burst out: start squashed, launch into a stretch, overshoot, settle
          sv.squash.value = 0.55; sv.squash.velocity = 7.5;
          fx()?.ring?.(new THREE.Vector3(sv.center.x, 0.04, sv.center.z), { radius: 1.45, count: 16, size: 0.17, color: '#fbf3e1' });
          fx()?.puff?.(new THREE.Vector3(sv.center.x, 0.1, sv.center.z), { count: 6, size: 0.2, spread: 0.7, up: 0.7, color: '#f6efdf' });
        }
        if (prev < A + 0.36 && t >= A + 0.36) {
          const top = sv.rig.anchors.top.clone(); top.y *= 0.9; sv.root.localToWorld(top);
          fx()?.sparkle?.(top, { count: 10, spread: 0.8 });
        }
        if (t > A + RISE.rise + 0.4) sv.riseT = -1;   // the squash spring keeps settling on its own
      }
      if (t >= A + RISE.rise * 0.9 && !sv.risen) { sv.risen = true; sv.lineT = 0; }
    }
    const S = sv.squash.update(dt);
    const L = sv.lean.update(dt);
    sv.root.position.set(sv.center.x + jx, y, sv.center.z + jz);
    sv.root.scale.set(g / Math.sqrt(Math.max(0.2, S)), g * S, g / Math.sqrt(Math.max(0.2, S)));
    sv.root.rotation.set(L * 0.07 * sv.leanDir.z, 0, -L * 0.07 * sv.leanDir.x);
  }

  const pushLocal = sv => (id, local) => { _m.multiplyMatrices(sv.root.matrixWorld, local); pools.push(id, _m); };

  function drawLine(sv, st, dt) {
    const L = sv.layout;
    if (sv.lineT < 100) sv.lineT += dt;
    // belt tiles roll out one after another
    for (const tile of L.tiles) {
      const t = sv.lineT - tile.index * 0.13;
      const s = sv.lineT >= 100 ? 1 : popScale(true, t, 0.32);
      if (t >= 0 && t - dt < 0 && sv.lineT < 100) fx()?.puff?.(new THREE.Vector3(tile.x, 0.08, tile.z), { count: 4, size: 0.12, spread: 0.35, up: 0.3, color: '#f6efdf' });
      lines.push(tile, s, 0);
    }
    if (!st?.line) return;
    // riders: exactly at their p; the first EMERGE tiles slide out of the station's output onto the belt
    const out = _v2.copy(sv.rig.anchors.out); sv.root.localToWorld(out);
    const q0 = L.at(EMERGE);
    for (const it of st.line.items) {
      const p = it.p;
      let x, y, z, yaw, sc = 1;
      if (p < EMERGE) {
        const k = p / EMERGE;
        x = THREE.MathUtils.lerp(out.x, q0.x, k); z = THREE.MathUtils.lerp(out.z, q0.z, k);
        y = THREE.MathUtils.lerp(out.y, RIDE_Y, Math.pow(k, 1.35));
        yaw = -q0.angle;
        sc = 0.7 + 0.3 * ease.backOut(Math.min(1, k * 1.6), 1.8);
      } else {
        const q = L.at(p);
        x = q.x; y = RIDE_Y; z = q.z; yaw = -q.angle;
      }
      // the tile under it may still be rolling out
      const ti = Math.min(L.len - 1, Math.floor(p));
      const tileS = sv.lineT >= 100 ? 1 : clamp((sv.lineT - ti * 0.13) / 0.2);
      sc *= tileS;
      if (sc < 0.02) continue;
      _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(0, yaw, 0)), _s.set(sc, sc, sc));
      pools.push(it.item, _m);
    }
  }

  let palletN = 0;
  function drawPile(sv, st, dt) {
    const P = sv.pile;
    const [tx, tz] = P.tile;
    // pallet under the pile appears with the end of the line
    const lt = sv.layout ? sv.lineT - sv.layout.len * 0.13 : sv.lineT;
    const ps = sv.lineT >= 100 ? 1 : popScale(true, lt, 0.32);
    if (ps > 0.01) {
      _m.compose(_p.set(tx, 0, tz), _q.identity(), _s.set(ps, ps, ps));
      pallets.setMatrixAt(palletN++, _m);
    }
    const total = Math.min(st?.pile?.count || 0, CAMP.pileCap);
    while (P.hops.length > total) P.hops.shift();
    const B = P.bounce.update(dt);
    const sxz = 1 / Math.sqrt(Math.max(0.3, B));
    const staticN = total - P.hops.length;
    const slot = P.slot || (P.slot = {});
    // the heap parts around Dug while he wades in to take from it (items slide aside and settle back after)
    let plx = 0, plz = 0, inPile = false;
    if (hasPlayer()) {
      views.player.getPosition(playerPos);
      plx = playerPos.x - tx; plz = playerPos.z - tz;
      inPile = Math.abs(plx) < PART.reach && Math.abs(plz) < PART.reach;
    }
    P.part = THREE.MathUtils.damp(P.part || 0, inPile ? 1 : 0, inPile ? 9 : 4, dt);
    if (inPile) { P.plx = plx; P.plz = plz; }
    const part = P.part > 0.01 ? P.part : 0;
    // each arrival knocks a little ripple through the items around where it landed
    const R = P.ripple;
    if (R) { R.t += dt; if (R.t > 0.6) P.ripple = null; }
    const rip = R ? 0.045 * Math.exp(-R.t * 7) * Math.sin(R.t * 26) : 0;
    _e.order = 'ZXY';     // slot tilts (rx, rz) are world-space tips applied after the item's own yaw
    for (let i = 0; i < staticN; i++) {
      pileSlot(P.item, i, slot);
      const s = slot.s;
      let x = slot.x, y = slot.y, z = slot.z;
      if (R) { const d = Math.hypot(x - R.x, z - R.z); if (d < 0.42) y -= rip * (1 - d / 0.42); }
      if (part) {
        const dx = x - P.plx, dz = z - P.plz, d = Math.hypot(dx, dz) || 1e-3;
        const push = Math.max(0, PART.radius - d) * part;
        if (push > 0) { x += (dx / d) * push * 0.9; z += (dz / d) * push * 0.9; y = Math.max(-PALLET_TOP, y - push * 0.7); }
      }
      _m.compose(_p.set(tx + x * sxz, PALLET_TOP + y * B, tz + z * sxz), _q.setFromEuler(_e.set(slot.rx, slot.ry, slot.rz)), _s.set(s * sxz, s * B, s * sxz));
      // soft occlusion: the lower an item sits in the heap, the warmer and darker it is, so the mound reads as a
      // mound from the high camera
      const k = clamp((slot.y + PALLET_TOP) / HEAP_SHADE.height);
      _tint.copy(HEAP_SHADE.low).lerp(HEAP_SHADE.high, Math.sqrt(k));
      pools.push(P.item, _m, _tint);
    }
    // arrivals hop from the line end to their slot
    for (let j = 0; j < P.hops.length; j++) {
      const h = P.hops[j];
      h.t += dt;
      const k = clamp(h.t / h.dur);
      pileSlot(P.item, staticN + j, slot);
      const to = _v.set(tx + slot.x, PALLET_TOP + slot.y, tz + slot.z);
      const x = THREE.MathUtils.lerp(h.from.x, to.x, k), z = THREE.MathUtils.lerp(h.from.z, to.z, k);
      const y = THREE.MathUtils.lerp(h.from.y, to.y, k) + Math.sin(k * Math.PI) * (0.32 + Math.max(0, slot.y) * 0.3);
      const ke = ease.cubicOut(k);
      const yaw = h.yaw + (slot.ry - h.yaw) * ke;
      const s = slot.s * (k > 0.85 ? 1 + 0.14 * Math.sin((k - 0.85) / 0.15 * Math.PI) : 1);
      _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(slot.rx * ke, yaw, slot.rz * ke)), _s.set(s, s, s));
      pools.push(P.item, _m);
    }
    _e.order = 'XYZ';
    // landed hops become part of the heap (the oldest lands first): the heap bumps, a ripple runs through it, and
    // an item that slid off onto the grass kicks up a little dust
    while (P.hops.length && P.hops[0].t >= P.hops[0].dur) {
      P.hops.shift();
      P.bounce.kick(-2.1);
      pileSlot(P.item, staticN, slot);
      P.ripple = { x: slot.x, z: slot.z, t: 0 };
      if (slot.spill > 0.5 && !mobile) fx()?.puff?.(_v.set(tx + slot.x * 1.1, 0.04, tz + slot.z * 1.1), { count: 2, size: 0.07, spread: 0.12, up: 0.15, color: '#f6efdf' });
    }

    // pickup ring: faint at rest, warm while the player stands on it, flashing as items leave
    P.takeT += dt;
    if (P.ring) {
      if (sv.lineT >= 100 || lt > 0.1) P.ring.appear = total > 0 || P.hops.length ? 0.55 : 0.35;
      const on = hasPlayer() && Math.abs(plx) < 0.6 && Math.abs(plz) < 0.6;
      const taking = P.takeT < 0.3;
      P.ring.hi = taking ? 1 : on && total > 0 ? 0.45 : 0;
      if (taking || (on && total > 0)) P.ring.appear = 1;
    }

    // full (40): a little red "Full" tag gets planted on the crest of the heap and nods there
    const full = total >= CAMP.pileCap;
    if (full !== P.full) { P.full = full; P.fullT = 0; }
    P.fullT += dt;
    const tagS = popScale(P.full, P.full ? P.fullT - 0.12 : P.fullT, 0.4, 0.2);
    if (P.full && P.fullT - dt < 0.12 && P.fullT >= 0.12) { P.bounce.kick(-1.2); P.tagSway.kick(2.2); }
    if (tagS > 0.01 && signs) {
      const c = pileCrest(P.item, Math.max(1, total), _crest);
      // a slow nod every few seconds, so a full pile keeps asking to be emptied (gently)
      const env = Math.max(0, Math.sin(time * 0.55 + tx) - 0.88) / 0.12;
      const nod = Math.sin(time * 1.6) * 0.05 + env * env * Math.sin(time * 9) * 0.07;
      const sw = P.tagSway.update(dt);
      _m.compose(
        _p.set(tx + c.x * 0.5 * sxz, PALLET_TOP + (c.y - 0.07) * B, tz + c.z * 0.5 * sxz),
        _q.setFromEuler(_e.set(sw * 0.3 + nod, 0.18 * Math.sin(time * 0.8 + tx), Math.sin(time * 1.3 + tz) * 0.04)),
        _s.set(tagS, tagS, tagS),
      );
      signs.board('tag', 'full', _m);
    }
  }
  const _crest = {}, _crest2 = {};

  function drawZone(sv, dt) {
    const Z = sv.zone;
    if (!Z) return;
    if (sv.risen && sv.lineT > 0.15) Z.appear = 1;
    let hi = 0;
    if (hasPlayer()) {
      views.player.getPosition(playerPos);
      if (camp.inRect?.(sv.def.zone, playerPos.x, playerPos.z)) hi = 1;
    }
    Z.hi = hi;
    // the accepted item floats over the middle of the zone, turning slowly
    if (sv.zoneItem && Z.shown > 0.02) {
      const a = Z.shown, hiK = Z.highlight;
      const bob = Math.sin(time * (2.2 + 2.5 * hiK)) * (0.03 + 0.02 * hiK);
      const s = (1.15 + 0.15 * hiK) * popScale(true, (a - 0.01) * 0.6, 0.3);
      _m.compose(_p.set(Z.center.x, 0.07 + bob + 0.06 * hiK, Z.center.z), _q.setFromEuler(_e.set(0, time * 0.7, 0)), _s.set(s, s, s));
      pools.push(sv.zoneItem, _m);
    }
  }

  // Signpost: the post stands still (it follows the station's squash and lean), the board is bolted to its top and
  // sways gently there, nodding when the station finishes an item. It springs up just after the station rises.
  const _signM = new THREE.Matrix4(), _signL = new THREE.Matrix4();
  function drawSign(sv, dt) {
    const S = sv.sign;
    if (!S || !signs) return;
    if (S.wait) { if (!sv.risen) return; S.wait = false; S.t = -SIGN_DELAY; }
    S.t += dt;
    const k = popScale(true, S.t, 0.42);
    if (k <= 0.01) return;
    const [bx, by, bz] = S.mount.base;
    const H = S.mount.post;
    // post: unit cylinder scaled to its height (it grows with the sign)
    _signL.compose(_p.set(bx, by, bz), _q.identity(), _s.set(k, H * Math.min(1, k), k));
    _signM.multiplyMatrices(sv.root.matrixWorld, _signL);
    signs.post(_signM);
    // board on the post top
    const ph = S.phase;
    const sway = S.sway.update(dt), twist = S.twist.update(dt);
    const rx = 0.03 * Math.sin(time * 1.15 + ph) + 0.012 * Math.sin(time * 2.4 + ph * 2) + sway * 0.1;
    const ry = 0.05 * Math.sin(time * 0.7 + ph * 1.3) + twist * 0.1;
    const rz = 0.022 * Math.sin(time * 0.95 + ph * 0.7);
    // the board pops with a little stretch while it grows in
    const st = S.t > 0 && S.t < 0.42 ? 1 + 0.1 * Math.sin((S.t / 0.42) * Math.PI) : 1;
    _signL.compose(_p.set(bx, by + H * Math.min(1, k), bz), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(k, k * st, k));
    _signM.multiplyMatrices(sv.root.matrixWorld, _signL);
    signs.board(S.shape, sv.id, _signM);
  }

  function drawHops(dt) {
    for (let i = hops.length - 1; i >= 0; i--) {
      const h = hops[i];
      h.t += dt;
      const k = clamp(h.t / h.dur);
      const x = THREE.MathUtils.lerp(h.from.x, h.to.x, k), z = THREE.MathUtils.lerp(h.from.z, h.to.z, k);
      const y = THREE.MathUtils.lerp(h.from.y, h.to.y, k) + Math.sin(k * Math.PI) * h.arc;
      let s = h.scale;
      if (h.shrink) s *= k < 0.6 ? 1 : k < 0.72 ? 1 + 0.1 * ((k - 0.6) / 0.12) : 1.1 * (1 - ease.cubicIn((k - 0.72) / 0.28));
      if (s > 0.02) {
        _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(0, h.yaw + k * 0.6, 0)), _s.set(s, s, s));
        pools.push(h.item, _m);
      }
      if (h.t >= h.dur) { hops.splice(i, 1); try { h.onLand?.(); } catch (e) { console.error(e); } }
    }
  }

  function update(dt, t) {
    time += dt;
    for (let i = timers.length - 1; i >= 0; i--) {
      if ((timers[i].t -= dt) > 0) continue;
      const { fn } = timers.splice(i, 1)[0];
      try { fn(); } catch (e) { console.error('[campview] timer', e); }
    }
    pools.begin();
    lines.begin();
    signs?.begin(dt);
    palletN = 0;
    lines.advance(dt, CAMP.lineSpeed);
    for (const sv of svs.values()) {
      const st = camp.stations.get(sv.id);
      for (let i = sv.pending.length - 1; i >= 0; i--) if ((sv.pending[i].t -= dt) <= 0) { const d = sv.pending.splice(i, 1)[0]; intakeWobble(sv); if (d.flash) sv.zone?.flash(); }
      updateStationTransform(sv, dt);
      sv.root.updateMatrixWorld(true);
      sv.rig.update?.(dt, st);
      if (sv.rig.items) sv.rig.items(pushLocal(sv));
      if (sv.layout) drawLine(sv, st, dt);
      if (sv.pile) drawPile(sv, st, dt);
      drawZone(sv, dt);
      drawSign(sv, dt);
    }
    drawHops(dt);
    zones.update(dt);
    fire.update(dt);
    pools.end();
    lines.end();
    signs?.end();
    pallets.count = palletN; pallets.visible = palletN > 0;
    if (palletN) pallets.instanceMatrix.needsUpdate = true;

    // hearth light: warm, flickering, rides the flame's height, reaches further every level, flashes on a level-up
    if (hearthLight) {
      const sv = svs.get('hearth');
      const hf = sv.rig.fire;
      const lv = Math.max(1, camp.level || 0), heat = hf?.heatNow ?? 1;
      flash = Math.max(0, flash - dt * 1.6, hf?.glowFlash || 0);
      const reach = hf?.glowS ? hf.glowS.value / 1.6 : 1;   // follows the ground glow's spring (it pulses on level-up)
      const fl = 1 + 0.07 * Math.sin(time * 9.7) + 0.05 * Math.sin(time * 15.1 + 1.3) + 0.03 * Math.sin(time * 23.3);
      hearthLight.position.set(sv.center.x, 0.45 + 0.55 * Math.max(0.6, hf?.height || 0.9), sv.center.z + 0.15);
      hearthLight.intensity = heat * (0.75 + 0.38 * lv) * fl * (1 + flash * 1.4);
      hearthLight.distance = 3.4 + 2.2 * reach;
    }
  }

  // ---------- ghost models for build pads ----------
  const ghostMats = new Set();
  function createModel(id, { opacity = 0.5 } = {}) {
    const dummyFire = { add: () => ({ base: new THREE.Matrix4(), tongues: [], flare() {}, position: v => v || new THREE.Vector3() }), remove() {}, burst() {}, update() {} };
    const env = Object.create(sharedEnv);
    env.fire = dummyFire; env.hop = () => {}; env.toWorld = v => v; env.state = () => null;
    let rig = null;
    try { rig = buildStationRig(id, env); } catch (e) { console.error('[campview] ghost', id, e); }
    if (!rig) return null;
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity, depthWrite: false });
    ghostMats.add(mat);
    rig.root.traverse(o => { if (o.isMesh) { o.material = mat; o.castShadow = false; o.receiveShadow = false; } });
    const def = STATIONS[id];
    const c = rectCenter(def.footprint);
    rig.root.position.set(c.x, 0, c.z);
    return {
      object: rig.root, material: mat,
      setValid(ok) { mat.color.set(ok === false ? '#ffb0a0' : '#ffffff'); },
      setOpacity(o) { mat.opacity = o; },
      dispose() { rig.root.removeFromParent(); mat.dispose(); ghostMats.delete(mat); },
    };
  }

  // ---------- public API ----------
  const api = {
    object: group,
    stationObject: id => svs.get(id)?.root || null,
    // world point of the heap's next slot: where the next item lands, and (piles are last in, first out) where the
    // item just taken by a pile:take sat, since the sim lowers the count before it emits the event
    pileTop(id, out = new THREE.Vector3()) {
      const sv = svs.get(id), def = STATIONS[id];
      const tile = def?.pile;
      if (!tile) return null;
      const n = Math.min(camp.stations.get(id)?.pile?.count || 0, CAMP.pileCap);
      const item = sv?.pile?.item || def.recipe?.out || def.auto?.out;
      const s = pileSlot(item, Math.min(n, CAMP.pileCap - 1));
      return out.set(tile[0] + s.x, PALLET_TOP + s.y + pileLayout(item).top * s.s, tile[1] + s.z);
    },
    // highest point of a station's heap right now (e.g. for a bubble or an arrow over the pile)
    pileCrest(id, out = new THREE.Vector3()) {
      const sv = svs.get(id), def = STATIONS[id];
      if (!def?.pile) return null;
      const n = Math.min(camp.stations.get(id)?.pile?.count || 0, CAMP.pileCap);
      const item = sv?.pile?.item || def.recipe?.out || def.auto?.out;
      const c = pileCrest(item, n, _crest2);
      return out.set(def.pile[0] + c.x, PALLET_TOP + c.y, def.pile[1] + c.z);
    },
    zoneCenter(id, out = new THREE.Vector3()) {
      const def = STATIONS[id];
      if (!def?.zone) return null;
      const c = rectCenter(def.zone);
      return out.set(c.x, 0.05, c.z);
    },
    // where dropped items disappear into the station (rack / basket / hopper)
    intakePoint(id, out = new THREE.Vector3()) {
      const sv = svs.get(id);
      if (!sv) return api.zoneCenter(id, out);
      return intakeWorld(sv, out);
    },
    // same point, under the name the creatures view asks for (workers deliver here)
    inputPoint(id, out = new THREE.Vector3()) { return api.intakePoint(id, out); },
    // world centre of a station's signboard (null for stations without one)
    signPoint(id, out = new THREE.Vector3()) {
      const sv = svs.get(id);
      if (!sv?.sign) return null;
      const [bx, by, bz] = sv.sign.mount.base;
      out.set(bx, by + sv.sign.mount.post, bz);
      return sv.root.localToWorld(out);
    },
    lineEnd(id, out = new THREE.Vector3()) {
      const sv = svs.get(id);
      if (!sv?.layout) return null;
      return lineWorld(sv, sv.layout.len, out);
    },
    stationTop(id, out = new THREE.Vector3()) {
      const sv = svs.get(id);
      if (sv) { out.copy(sv.rig.anchors.top); return sv.root.localToWorld(out); }
      const def = STATIONS[id];
      if (!def) return null;
      const c = rectCenter(def.footprint);
      return out.set(c.x, 1.5, c.z);
    },
    // tiles a station covers on the ground (footprint, line, pile, drop zone); camp view already asks
    // views.terrain.cover() to clear them when the station is built
    coveredTiles(id) {
      const def = STATIONS[id];
      if (!def) return [];
      const out = [];
      const rect = r => { if (r) for (let j = 0; j < r[3]; j++) for (let i = 0; i < r[2]; i++) out.push([r[0] + i, r[1] + j]); };
      rect(def.footprint); rect(def.zone);
      for (const t of def.line || []) out.push([t[0], t[1]]);
      if (def.pile) out.push([def.pile[0], def.pile[1]]);
      return out;
    },
    createModel,
    _signs: signs,       // test hooks: the sign atlas + meshes, a station view record
    _sv: id => svs.get(id) || null,
    update,
    info() {
      let calls = 0;
      group.traverse(o => { if ((o.isMesh || o.isInstancedMesh) && o.visible && (!o.isInstancedMesh || o.count > 0)) calls++; });
      return { stations: [...svs.keys()], drawCalls: calls, items: pools.drawn, hops: hops.length, signs: signs ? signs.meshes.reduce((a, m) => a + (m.visible ? m.count : 0), 0) : 0 };
    },
    dispose() { offs.forEach(f => f()); signs?.dispose(); group.removeFromParent(); },
  };
  return api;
}
