// Build pads (GAMEPLAY.md "Build / grow"): the dashed pad zones on the ground with a translucent ghost of what
// they build, a floating cost bubble with item icons + remaining counts and a paid bar, the paying stream from the
// player's pack into the pad, the completion moment, bridges assembling plank by plank, and the hearth level-up.
//
//   pad:shown      -> soft scale-in (0.72 -> 1, backOut) + a little bob; ghost and bubble follow a beat later
//   (standing on)  -> pad pulses brighter, dashes march faster, bubble lifts and warms up
//   pad:paid       -> an item arcs from the top of the pack into the pad (instanced, one draw call per item type);
//                     its count ticks down with a pop when it lands; the ground fill rises
//   pad:complete   -> in-flight items hurry in, the dashes snap inward (backIn), dust ring + sparkles + confetti,
//                     the ghost hands over to the rising station, the bubble flips to a check and shrinks away
//   bridge:*       -> pads/bridge.js (planks fly in from the shore pad, posts rise, ropes string themselves)
//   hearth:level   -> shockwave ring on the ground, radial burst of light rays, sparkles, a gentle camera kick
//
// Draw calls: decals 1 (instanced) + 1 per ghost + 1 per item type in flight + 1 per built bridge (5 while one
// assembles) + 2 during a level-up burst. Cost bubbles are DOM (one .pad-labels layer in ctx.uiRoot).
// All motion runs from update(dt); DOM bubbles are positioned at render time with this frame's camera.
import * as THREE from 'three';
import { ease, clamp, lerp, damp, arc, Spring } from '../util/anim.js';
import { STATIONS, UPGRADES, WORKERS } from '../sim/camp-data.js';
import { createDecals } from './pads/decal.js';
import { buildGhost, ghostMaterial, ghostDepth } from './pads/ghosts.js';
import { createBridges } from './pads/bridge.js';
import { createBurst } from './pads/burst.js';
import { createLabels } from './pads/labels.js';

// ---- tuning ----
const OUTLINE_INSET = 0.1;     // outline sits this far inside the zone's tile edges
const CORNER = 0.22;           // outline corner radius
const DECAL_Y = 0.014;
const APPEAR_T = 0.6;          // scale-in duration
const OUT_T = 0.7;             // completion moment duration
const SNAP_T = 0.2;            // dashes snap inward
// The camp view raises a built station with a 0.17 s anticipation (sunk + trembling) then bursts it out with its
// own dust ring: the dashes collapse during that anticipation and our confetti fires on the burst, so the pad
// and the station read as one beat.
const BURST_AT = 0.17;
const FLIGHT_MIN = 0.24, FLIGHT_MAX = 0.4;
const FLY_CAP = 48;            // instanced flights per item type

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();

export function create(ctx) {
  const camp = ctx.camp;
  if (!camp) return {};
  const { scene, events, views, map, config } = ctx;
  const mobile = !!ctx.mobile || ctx.quality?.tier === 'mobile';
  const FXN = mobile ? 0.6 : 1;      // particle count multiplier
  const ITEM_K = mobile ? 1.15 : 1;  // flying item scale (portrait shows fewer, bigger tiles)

  const decals = createDecals({ cap: 24 });
  scene.add(decals.mesh);
  const labels = createLabels(ctx);
  const bridges = createBridges(ctx, { quality: ctx.quality });
  const burst = createBurst(ctx);

  const pads = new Map();   // id -> view
  let time = 0;
  let showDelayUntil = 0;   // pads shown right after a completion / level-up wait for the moment to play
  let showStagger = 0;

  // ---------------- names (same words as the camp HUD's unlock list) ----------------
  const ISLAND_NAMES = { west: 'Forest', north: 'Meadow', east: 'Copper isle', south: 'Deer glade' };
  const NTH = ['', '', 'second', 'third', 'fourth', 'fifth'];
  function padName(id) {
    const [kind, raw = ''] = id.split(':');
    const [arg, nth] = raw.split('#');
    if (kind === 'build') return STATIONS[arg]?.name || arg;
    if (kind === 'hearth') return Number(arg) <= 1 ? 'Light the fire' : `Camp level ${arg}`;
    if (kind === 'bridge') return `${ISLAND_NAMES[arg] || 'New'} bridge`;
    if (kind === 'upgrade') return UPGRADES[arg]?.name || 'Upgrade';
    if (kind === 'hire') return `Hire ${nth ? `${NTH[Number(nth)] || 'another'} ` : ''}${(WORKERS[arg]?.name || arg).toLowerCase()}`;
    return id;
  }

  // ---------------- pad views ----------------
  function ensure(pad, { delay = null } = {}) {
    let v = pads.get(pad.id);
    if (v) { v.pad = pad; return v; }
    const [zx, zz, w, d] = pad.zone;
    const center = { x: zx + (w - 1) / 2, z: zz + (d - 1) / 2 };
    const group = new THREE.Group();
    group.name = `pad:${pad.id}`;
    group.position.set(center.x, 0, center.z);
    scene.add(group);
    let ghost = null;
    try {
      const info = buildGhost(pad, { map, stations: STATIONS });
      const mat = ghostMaterial();
      const mesh = new THREE.Mesh(info.geometry, mat);
      mesh.renderOrder = 4;
      mesh.castShadow = false; mesh.receiveShadow = false;
      mesh.scale.setScalar(0.001);
      const depth = new THREE.Mesh(info.geometry, ghostDepth());
      depth.renderOrder = 3;
      mesh.add(depth);
      const holder = new THREE.Group();
      holder.add(mesh);
      group.add(holder);
      ghost = { mesh, holder, info, mat };
    } catch (e) { console.error('[pads] ghost', pad.id, e); }
    const bubble = labels.create({ name: padName(pad.id), cost: pad.cost });
    // shown delay: initial pads ease in after load; pads revealed by a completion wait for that moment
    let dl = delay;
    if (dl == null) {
      if (time < showDelayUntil) { dl = showDelayUntil - time + showStagger; showStagger += 0.14; }
      else dl = 0.05;
    }
    v = {
      id: pad.id, pad, center, zone: pad.zone,
      half: [w / 2 - OUTLINE_INSET, d / 2 - OUTLINE_INSET],
      group, ghost, bubble,
      phase: 'in', t: -dl, outT: 0, doneT: -1,
      glow: 0, dash: 0, flash: 0, fillShown: 0, shadowK: 0,
      landed: Object.fromEntries(Object.keys(pad.cost).map(k => [k, pad.paid?.[k] || 0])),
      inFlight: 0,
      bob: new Spring(0, { stiffness: 170, damping: 9 }),
      thump: new Spring(0, { stiffness: 380, damping: 15 }),
      phaseOff: (pads.size * 1.7) % 6.28,
      fxDone: false,
    };
    pads.set(pad.id, v);
    refreshCounts(v);
    return v;
  }

  function totalCost(v) { return Object.values(v.pad.cost).reduce((a, n) => a + n, 0); }
  function totalLanded(v) { return Object.values(v.landed).reduce((a, n) => a + n, 0); }
  function refreshCounts(v) {
    for (const [id, n] of Object.entries(v.pad.cost)) v.bubble.setCount(id, v.phase === 'out' ? 0 : n - (v.landed[id] || 0));
    v.bubble.dirty = true;
  }

  function destroy(v) {
    scene.remove(v.group);
    if (v.ghost) { v.ghost.info.geometry.dispose(); v.ghost.mat.dispose(); }
    v.bubble.remove();
    pads.delete(v.id);
  }

  // ---------------- pay flights (pack -> pad) ----------------
  const flyMeshes = new Map(); // item -> InstancedMesh
  const flights = [];
  const fallbackGeo = new THREE.BoxGeometry(0.16, 0.16, 0.16).translate(0, 0.08, 0);
  function flyMesh(item) {
    let m = flyMeshes.get(item);
    if (m) return m;
    try { m = views.items?.getInstanced?.(item, FLY_CAP) || null; } catch { m = null; }
    if (!m) {
      m = new THREE.InstancedMesh(fallbackGeo, new THREE.MeshLambertMaterial({ color: config.ITEMS[item]?.color || '#ffffff' }), FLY_CAP);
      m.count = 0;
    }
    m.frustumCulled = false; m.castShadow = !mobile; m.receiveShadow = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.name = `padFlights:${item}`;
    scene.add(m);
    flyMeshes.set(item, m);
    return m;
  }
  const packPos = new THREE.Vector3();
  function packTop(out) {
    const pl = views.player;
    let p = null;
    try { p = pl?.getStackTop?.(out) || null; } catch { p = null; }
    if (p && Number.isFinite(p.x)) return out;
    try { p = pl?.getPackPosition?.(out) || null; } catch { p = null; }
    if (p && Number.isFinite(p.x)) return out.add(_p.set(0, 0.16, 0));
    p = pl?.getPosition?.(out);
    if (p && Number.isFinite(p.x)) return out.set(p.x, (p.y || 0) + 0.65, p.z);
    return out.set(ctx.sim.player.x, 0.65, ctx.sim.player.z);
  }
  let flightSeq = 0;
  // Where a paid item lands. The player stands on the pad, so aim somewhere they can't hide:
  //   bridge -> out over the water onto the first ghost planks; hearth -> into the fire itself;
  //   floating emblems (hire / upgrade) -> into the emblem above the player's head; stations -> the ghost.
  const _t = { x: 0, z: 0 };
  function flightTarget(v, ang, rr, k, out) {
    const [kind, raw = ''] = v.id.split(':');
    const arg = raw.split('#')[0];
    const gh = v.ghost?.info;
    if (kind === 'bridge' && map.bridges?.[arg]) {
      const b = map.bridges[arg];
      const [x0, z0] = b.tiles[0], [x1, z1] = b.tiles[Math.min(1, b.tiles.length - 1)];
      const dx = Math.sign(x1 - x0) || Math.sign(x0 - v.center.x), dz = Math.sign(z1 - z0) || Math.sign(z0 - v.center.z);
      const u = -0.25 + ((k * 0.61) % 1) * 0.75, w = Math.sin(ang) * 0.22;
      return out.set(x0 + dx * u + (dz ? w : 0), 0.02, z0 + dz * u + (dx ? w : 0));
    }
    if (kind === 'hearth') {
      const hc = camp.stationCenter?.('hearth');
      if (hc) return out.set(hc.x + Math.cos(ang) * rr * 0.8, 0.32, hc.z + Math.sin(ang) * rr * 0.8);
    }
    if (gh?.float && v.ghost) {
      const y = v.ghost.holder.position.y + gh.height * 0.55;
      return out.set(v.center.x + Math.cos(ang) * 0.08, y, v.center.z + Math.sin(ang) * 0.08);
    }
    const ty = gh ? Math.min(0.16, gh.height * 0.2) : 0.1;
    return out.set(v.center.x + Math.cos(ang) * Math.min(rr, v.half[0] * 0.6), ty, v.center.z + Math.sin(ang) * Math.min(rr, v.half[1] * 0.6));
  }
  function launch(v, item) {
    const from = packTop(new THREE.Vector3());
    // a fast stream flies shorter, flatter arcs so it stays a tidy pour and the counter keeps up
    const gap = v.lastLaunch == null ? 1 : time - v.lastLaunch;
    v.lastLaunch = time;
    const fast = clamp((0.12 - gap) / 0.07);
    // land spread along a little lattice so a fast stream fans neatly instead of piling on one spot
    const k = flightSeq++;
    const ang = k * 2.39996; // golden angle
    const rr = 0.12 + ((k * 0.37) % 1) * 0.16;
    const to = flightTarget(v, ang, rr, k, new THREE.Vector3());
    const dist = Math.hypot(to.x - from.x, to.z - from.z);
    flights.push({
      v, item, from, to,
      k: 0, rate: 1 / (clamp(FLIGHT_MIN + dist * 0.035, FLIGHT_MIN, FLIGHT_MAX) * (1 - 0.3 * fast)),
      h: (0.42 + Math.min(dist, 5) * 0.07) * (1 - 0.2 * fast),
      spin: 7 * (k % 2 ? 1 : -1), yaw0: ang,
    });
    v.inFlight++;
  }
  function landFlight(f) {
    const v = f.v;
    v.inFlight = Math.max(0, v.inFlight - 1);
    v.landed[f.item] = Math.min(v.pad.cost[f.item] ?? Infinity, (v.landed[f.item] || 0) + 1);
    v.thump.velocity = Math.max(v.thump.velocity - 2.2, -7);
    v.flash = Math.min(1, v.flash + 0.18);
    // a tiny dust tick every few items so a fast stream reads as one continuous pour
    const n = totalLanded(v);
    if (n % 3 === 1) views.fx?.puff?.({ x: f.to.x, y: f.to.y + 0.02, z: f.to.z }, { count: 2, size: 0.07, spread: 0.12, up: 0.3, color: '#fffaf0' });
  }
  function updateFlights(dt) {
    for (const m of flyMeshes.values()) m.userData.n = 0;
    for (let i = flights.length - 1; i >= 0; i--) {
      const f = flights[i];
      f.k = Math.min(1, f.k + dt * f.rate);
      if (f.k >= 1) { flights.splice(i, 1); landFlight(f); continue; }
    }
    for (const f of flights) {
      const m = flyMesh(f.item);
      const n = m.userData.n || 0;
      if (n >= FLY_CAP) continue;
      const k = f.k;
      const kk = k * k * (1.55 - 0.55 * k); // leave easy, rush in
      _p.set(lerp(f.from.x, f.to.x, kk), lerp(f.from.y, f.to.y, kk) + arc(k) * f.h, lerp(f.from.z, f.to.z, kk));
      const sc = (k < 0.14 ? lerp(0.7, 1, ease.backOut(k / 0.14, 2.2)) : k > 0.7 ? lerp(1, 0.25, ease.quadIn((k - 0.7) / 0.3)) : 1) * ITEM_K;
      _e.set(Math.sin(k * 3.1) * 0.5, f.yaw0 + f.spin * k * 0.5, Math.sin(k * 2.3) * 0.35);
      _q.setFromEuler(_e);
      m.setMatrixAt(n, _m.compose(_p, _q, _s.set(sc, sc, sc)));
      m.userData.n = n + 1;
    }
    for (const m of flyMeshes.values()) {
      const n = m.userData.n || 0;
      if (n || m.count) { m.count = n; m.instanceMatrix.needsUpdate = true; }
      m.visible = n > 0;
    }
  }

  // ---------------- completion ----------------
  function complete(v) {
    if (v.phase === 'out') return;
    v.phase = 'out'; v.outT = 0;
    // anything still in the air hurries in (lands within ~0.12 s) so it reads as one moment with the station
    for (const f of flights) if (f.v === v) f.rate = Math.max(f.rate, (1 - f.k) / 0.12);
    // revealed pads (refreshPads runs right after) wait for the moment
    showDelayUntil = Math.max(showDelayUntil, time + 0.5);
    showStagger = 0;
  }
  function completionFx(v) {
    const fx = views.fx;
    if (!fx) return;
    const kind = v.id.split(':')[0];
    const c = { x: v.center.x, y: 0.05, z: v.center.z };
    const r = Math.max(v.half[0], v.half[1]) + 0.35;
    // build pads: the rising station brings its own dust ring; everything else gets ours
    if (!(kind === 'build' && views.campview?.update)) fx.ring?.(c, { radius: r + 0.25, count: Math.round(16 * FXN), size: 0.16 });
    if (kind === 'bridge') { fx.sparkle?.({ ...c, y: 0.3 }, { count: Math.round(6 * FXN), spread: 0.4 }); return; }
    fx.sparkle?.({ ...c, y: 0.45 }, { count: Math.round(10 * FXN), spread: r * 0.8, size: 0.11 });
    fx.confetti?.({ ...c, y: 0.25 }, { count: Math.round((kind === 'build' ? 30 : 22) * FXN) });
  }

  // ---------------- hearth level-up ----------------
  function levelUp(level) {
    const hc = camp.stationCenter?.('hearth') || { x: 20.5, z: 13.5 };
    burst.play(hc.x, hc.z, 0.95);
    const fx = views.fx;
    fx?.ring?.({ x: hc.x, y: 0.05, z: hc.z }, { radius: 2.4, count: Math.round(26 * FXN), size: 0.2 });
    fx?.sparkle?.({ x: hc.x, y: 0.9, z: hc.z }, { count: Math.round(16 * FXN), spread: 1.1, size: 0.14, color: '#fff1b8' });
    fx?.sparkle?.({ x: hc.x, y: 0.6, z: hc.z }, { count: Math.round(10 * FXN), spread: 1.8, size: 0.1, delay: 0.12 });
    fx?.confetti?.({ x: hc.x, y: 0.8, z: hc.z }, { count: Math.round(44 * FXN) });
    views.camera?.shake?.(0.07);
    showDelayUntil = Math.max(showDelayUntil, time + 0.75);
    showStagger = 0;
  }

  // ---------------- events ----------------
  const offs = [];
  const on = (type, fn) => offs.push(events.on(type, p => { try { fn(p || {}); } catch (e) { console.error(`[pads] ${type}`, e); } }));
  on('pad:shown', ({ pad }) => { if (pad) ensure(pad); });
  on('pad:paid', ({ pad, item }) => {
    if (!pad || !item) return;
    const v = ensure(pad, { delay: 0 });
    // the count ticks (with a pop) as the item leaves the pack, in step with the sim; the ground fill and the
    // bar rise as items land
    if (v.doneT < 0) { v.bubble.setCount(item, pad.cost[item] - (pad.paid?.[item] ?? 0)); v.bubble.kick(item); }
    if (views.fx?.handlesPadPaid) { landFlight({ v, item, to: new THREE.Vector3(v.center.x, 0.1, v.center.z) }); return; }
    launch(v, item);
  });
  on('pad:complete', ({ pad }) => { if (!pad) return; const v = ensure(pad, { delay: 0 }); complete(v); });
  on('bridge:start', ({ bridge }) => {
    if (!bridge) return;
    const pv = [...pads.values()].find(p => p.id === `bridge:${bridge.id}`);
    bridges.start(bridge, { shore: pv ? pv.center : null });
  });
  on('bridge:built', ({ bridge }) => { if (bridge && !bridges.has(bridge.id)) bridges.builtInstantly(bridge); });
  on('hearth:level', ({ level }) => levelUp(level));

  // initial state: pads already visible + bridges already built
  camp.pads.forEach((pad, i) => ensure(pad, { delay: 0.35 + i * 0.12 }));
  for (const id of camp.bridges || []) { const b = map.bridges?.[id]; if (b) bridges.builtInstantly({ id, tiles: b.tiles, orientation: b.orientation }); }

  // ---------------- per-frame ----------------
  const pp = new THREE.Vector3();
  const r4 = [0, 0, 0, 0], s4 = [0, 0, 0, 0], e4 = [0, 0, 0, 0];
  function playerXZ() {
    const p = views.player?.getPosition?.(pp);
    if (p && Number.isFinite(p.x)) return p;
    return pp.set(ctx.sim.player.x, 0, ctx.sim.player.z);
  }

  function updatePad(v, dt, slot, player) {
    v.t += dt;
    const pad = v.pad;
    const out = v.phase === 'out';
    if (out) v.outT += dt;
    const live = v.t >= 0;
    // reconcile: the sim dropped this pad without completing it -> fade it like a completion without fx
    if (!out && !camp.pads.includes(pad)) { v.phase = 'out'; v.outT = 0; v.fxDone = true; }

    // ---- appear ----
    const ka = live ? clamp(v.t / APPEAR_T) : 0;
    if (live && !v.started) { v.started = true; v.bob.kick(1.4); }
    let scale = lerp(0.72, 1, ease.backOut(ka, 1.5));
    let alpha = ease.quadOut(clamp(ka / 0.35));

    // ---- standing on it ----
    const onPad = !out && live && camp.inRect?.(v.zone, player.x, player.z);
    v.glow = damp(v.glow, onPad ? 1 : 0, onPad ? 9 : 5, dt);
    v.bubble.setOn(onPad);
    const pulse = v.glow * (0.78 + 0.22 * Math.sin(time * 7.5 + v.phaseOff));
    v.dash += dt * (0.32 + v.glow * 1.25);
    scale *= 1 + v.glow * 0.022 * Math.sin(time * 7.5 + v.phaseOff);

    // ---- springs ----
    v.bob.update(dt); v.thump.update(dt);
    v.flash = Math.max(0, v.flash - dt * 3.2);
    const total = totalCost(v);
    const fillTarget = total > 0 ? totalLanded(v) / total : 1;
    v.fillShown = damp(v.fillShown, fillTarget, 10, dt);
    scale *= 1 + v.thump.value * 0.018;

    // ---- completion ----
    let inset = 0, dashA = 1, ghostK = 1, bubbleS = 1, bubbleA = 1, check = 0;
    if (out) {
      const t = v.outT;
      const ks = clamp(t / SNAP_T);
      inset = Math.max(-0.06, ease.backIn(ks, 2.2)) * (Math.min(v.half[0], v.half[1]) - 0.1);
      dashA = 1 - ease.quadIn(clamp((t - SNAP_T * 0.6) / 0.3));
      if (t >= BURST_AT && !v.fxDone) { v.fxDone = true; completionFx(v); v.flash = 1; }
      ghostK = 1 - clamp(t / 0.24);
      // the bubble finishes once the last hurried item has landed (its count ticks to zero first)
      if (v.doneT < 0) {
        v.doneT = 0;
        for (const id of Object.keys(v.landed)) v.landed[id] = v.pad.cost[id];
        refreshCounts(v);
        v.bubble.kick(Object.keys(v.pad.cost)[0], 1.2);
      } else if (v.doneT >= 0) v.doneT += dt;
      const tb = Math.max(0, v.doneT);
      check = v.doneT < 0 ? 0 : ease.quadOut(clamp(tb / 0.12));
      bubbleS = tb < 0.14 ? 1 + 0.12 * ease.quadOut(tb / 0.14) : 1.12 * (1 - ease.backIn(clamp((tb - 0.14) / 0.3), 1.8));
      bubbleA = 1 - clamp((tb - 0.3) / 0.14);
      v.fillShown = 1;
    }

    // ---- decal instance ----
    const bobY = v.bob.value * 0.035;
    if (slot < decals.cap && alpha * dashA > 0.002) {
      r4[0] = v.half[0]; r4[1] = v.half[1]; r4[2] = CORNER; r4[3] = inset;
      s4[0] = out ? 1 : clamp(v.fillShown); s4[1] = alpha * dashA; s4[2] = pulse; s4[3] = v.dash;
      e4[0] = v.flash * (out ? 1 : 0.35); e4[1] = out ? 0.2 : 0; e4[2] = 1 + v.glow * 0.15;
      e4[3] = v.ghost?.info.float ? v.shadowK * (1 - Math.min(1, Math.max(0, (v.ghost.holder.position.y - 0.04) * 2.5)) * 0.4) : 0;
      decals.setInstance(slot, v.center.x, DECAL_Y + Math.max(0, bobY) * 0.4, v.center.z, scale, r4, s4, e4);
      slot++;
    }

    // ---- ghost ----
    if (v.ghost) {
      const g = v.ghost, info = g.info;
      const kg = live ? clamp((v.t - 0.1) / 0.55) : 0;
      let gs = kg > 0 ? lerp(0.6, 1, ease.backOut(kg, 1.7)) : 0.001;
      let ga = ease.quadOut(clamp(kg / 0.4));
      if (out) {
        // build pads hand over to the rising station: brief swell then gone; emblems shoot up and shrink
        const t = v.outT;
        if (info.float) { g.holder.position.y = ease.quadIn(clamp(t / 0.3)) * 0.7; gs *= t < 0.08 ? 1 + t * 1.5 : Math.max(0.001, 1.12 * (1 - ease.quadIn(clamp((t - 0.08) / 0.24)))); }
        else gs *= 1 + 0.05 * Math.sin(clamp(t / 0.25) * Math.PI);
        ga *= ghostK;
      }
      v.shadowK = ga * gs;
      const th = v.thump.value;
      const sy = gs * (1 + th * 0.05), sxz = gs * (1 - th * 0.025);
      g.mesh.scale.set(sxz, Math.max(0.001, sy), sxz);
      if (info.float && !out) {
        g.holder.position.y = 0.1 + Math.sin(time * 2.1 + v.phaseOff) * 0.05 + bobY;
        if (info.kind === 'hire') g.mesh.rotation.y = Math.sin(time * 1.3 + v.phaseOff) * 0.35;
        else g.holder.rotation.x = -0.6; // emblems lean back to face the high camera (reads ~2x taller)
        if (info.kind === 'hearth') { g.mesh.scale.y *= 1 + Math.sin(time * 8.5) * 0.035 + Math.sin(time * 13.1) * 0.02; }
      } else if (!out) g.holder.position.y = Math.max(0, bobY) * 0.5;
      // emblems rock side to side (never edge-on); faster while the player stands on the pad
      if (info.spin) { v.spinT = (v.spinT || 0) + dt * (1 + v.glow * 1.5); g.mesh.rotation.y = Math.sin(v.spinT * info.spin * 1.6) * 0.55; }
      const u = g.mat.uniforms;
      u.uOpacity.value = ga;
      u.uGlow.value = pulse * 0.8 + v.flash * 0.6;
      u.uTime.value = time + v.phaseOff;
      g.mesh.visible = ga > 0.003 && gs > 0.002;
    }

    // ---- bubble ----
    const b = v.bubble;
    const gh = v.ghost?.info;
    // fixed world anchor (it doesn't jump when the player steps on; the HUD's own player bubbles sit above them)
    const anchorY = (gh?.height ?? 0.6) + 0.42 + Math.sin(time * 2.2 + v.phaseOff) * 0.035 + bobY;
    b.anchor.set(v.center.x, anchorY, v.center.z);
    const kb = live ? clamp((v.t - 0.16) / 0.45) : 0;
    b.scale = (kb > 0 ? lerp(0.7, 1, ease.backOut(kb, 1.8)) : 0) * bubbleS * (1 + v.glow * 0.07) * (1 + Math.max(-0.05, v.thump.value * -0.012));
    b.opacity = ease.quadOut(clamp(kb / 0.5)) * bubbleA;
    b.lift = v.glow * 6;
    if (b.barK !== v.fillShown) { b.barK = v.fillShown; b.fill.style.transform = `scaleX(${clamp(v.fillShown).toFixed(4)})`; }
    if (b.checkK !== check) { b.checkK = check; b.check.style.opacity = check.toFixed(3); }

    if (out && v.outT >= OUT_T && v.inFlight === 0 && v.doneT > 0.46) destroy(v);
    return slot;
  }

  let needProject = true;
  const prevOBR = scene.onBeforeRender;
  scene.onBeforeRender = function (...args) {
    if (typeof prevOBR === 'function') prevOBR.apply(this, args);
    try { labels.project(); needProject = false; } catch (e) { console.error('[pads] project', e); }
  };

  function update(dt) {
    if (!(dt >= 0)) return;
    if (needProject) { try { labels.project(); } catch { /* fine */ } }
    needProject = true;
    time += dt;
    // any visible sim pad we haven't seen (e.g. created before we subscribed)
    for (const pad of camp.pads) if (!pads.has(pad.id)) ensure(pad);
    updateFlights(dt);
    const player = playerXZ();
    let slot = 0;
    for (const v of [...pads.values()]) slot = updatePad(v, dt, slot, player);
    decals.commit(slot, time);
    labels.update(dt);
    bridges.update(dt);
    burst.update(dt);
  }

  const api = {
    // The Group placed at a pad's centre (holds its ghost); null once the pad is gone.
    padObject: id => pads.get(id)?.group || null,
    // The DOM cost bubble of a pad.
    bubble: id => pads.get(id)?.bubble?.el || null,
    // The finished (baked) mesh of a bridge, or null while it assembles / before it is built.
    bridgeObject: id => bridges.object(id),
    get flights() { return flights.length; },
    get assemblingBridges() { return bridges.assembling; },
    get pads() { return [...pads.keys()]; },
    update,
    dispose() {
      offs.forEach(off => off?.());
      scene.onBeforeRender = prevOBR;
      labels.dispose();
    },
  };
  return api;
}
