// The carried stack on the robot's back (camp mode): ctx.camp.stack (bottom -> top) drawn as real item meshes
// on the power-pack lid, one InstancedMesh per item type (views.items geometry, so the stack matches the flights,
// lines and piles).
//
// Layout: a crisscross (log-cabin) stack, two items per layer: even layers lie front-to-back side by side, odd
// layers lie across the back one behind the other. Logs show light end caps and bark on alternate layers from
// any angle, so it always reads as "a stack of things", never a pole. Capacity 10 is about the robot's height,
// 30 a proud tower about three times that.
//
// Feel: the column is a soft cantilever. Its base rides the pack (it inherits part of the body's lean and bank)
// and two under-damped springs bend it: it lags behind acceleration (starts, stops) and swings outward in turns;
// a twist spring makes the top trail when the robot spins. Taller stacks are softer (a lower, lazier sway) and
// lean back a little, away from the head. Every foot contact gives the column a small accordion squeeze.
//
// Arrivals: fx flies gathered items to getTop() and calls player.gulp() on arrival. Items still in the air are
// hidden here (inventory:changed with a source -> hidden until fx:itemArrived, or a timeout); then they pop onto
// the top: drop in from a little above, scale up from 0.55 with an overshoot and a squash. Leaving items are flown
// from the top by fx / pads, so here they simply go, with a small upward bounce of what remains. Entries keep
// their identity across changes (greedy match), so a mid-stack removal slides the items above into place.
//
// Everything is driven by update(dt): no clocks.
import * as THREE from 'three';
import { PACK_TOP as ROBOT_PACK_TOP } from './model.js';
import { PACK_TOP as DUG_PACK_TOP } from './dug.js';
const PACK_TOP = new URLSearchParams(location.search).has('robot') ? ROBOT_PACK_TOP : DUG_PACK_TOP;

const CAP = 48;                // instances per item type (capacity tops out at 30; slack for tests)
const ITEM_SCALE = 1.06;       // world scale of carried items at robot scale 1.3 (flights and piles draw them at 1)
const NEST = 0.92;             // layers sit a touch into each other, like a real pile
const GAP = 0.006;             // between the two items of a layer
const LIFT = 0.004;            // first layer's gap above the lid
const BACK = 0.05;             // the column sits this far behind the lid centre (clear of the head), at scale 1.3
const LEAN_BACK = 0.1;         // static backward bend (rad at the tip) of a tall stack
const PUSH_F = 0.85, PUSH_L = 0.65; // how hard the body's acceleration (tiles/s^2) pushes the column (rad/s per tile/s)
const TALL = 2.6;            // world height that counts as "tall" (softest springs, full lean)
const TWIST_FOLLOW = 0.4;     // share of the upper body's swing twist the stack follows
const HIDE_MAX = 2.6;          // s an in-flight item may stay hidden before it shows anyway

const TAU = Math.PI * 2;

export function createStack(ctx, rig, { scale = 1.3 } = {}) {
  const { scene, anim, views, events } = ctx;
  const { Spring, damp, clamp, lerp } = anim;
  const camp = ctx.camp;
  const back = BACK * (scale / 1.3);
  const ITEM_S = ITEM_SCALE * Math.sqrt(scale / 1.3); // a bigger robot (phones) carries a touch bigger items

  const group = new THREE.Group();
  group.name = 'player-stack';
  scene.add(group);

  // ---------- item types ----------
  let ownMat = null;
  const material = () => views.items?.getMaterial?.() || (ownMat ||= new THREE.MeshLambertMaterial({ vertexColors: true }));
  const isPlaceholder = g => {
    if (!g) return true;
    if (!g.boundingBox) g.computeBoundingBox();
    const s = g.boundingBox.getSize(new THREE.Vector3());
    return Math.abs(s.x - 0.18) < 0.004 && Math.abs(s.y - 0.18) < 0.004 && Math.abs(s.z - 0.18) < 0.004;
  };
  let fallbackGeo = null; // the camp view's drumstick / ingot meshes while items.js still draws plain boxes
  import('../camp/geo.js').then(m => { fallbackGeo = m.fallbackItemGeometry || null; refreshPlaceholders(); }).catch(() => {});

  const types = new Map(); // id -> { mesh, h, w, yaw0, round, n, placeholder }
  const _s = new THREE.Vector3();
  function measure(t) {
    const g = t.mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const b = g.boundingBox, s = b.getSize(_s);
    t.h = Math.max(0.05, b.max.y - Math.max(0, b.min.y));
    const long = Math.max(s.x, s.z), short = Math.min(s.x, s.z);
    t.yaw0 = s.z > s.x * 1.1 ? Math.PI / 2 : 0;          // the long axis runs front-to-back (local x)
    t.round = long < short * 1.15;                         // stones, ore: any yaw looks fine
    t.w = t.round ? long : short;                          // width across the back
    t.cz = (b.max.z + b.min.z) / 2; t.cx = (b.max.x + b.min.x) / 2;
  }
  function typeOf(id) {
    let t = types.get(id);
    if (t) return t;
    let geo = null;
    try { geo = views.items?.getGeometry?.(id) || null; } catch { geo = null; }
    const placeholder = isPlaceholder(geo);
    if (placeholder && fallbackGeo) { try { geo = fallbackGeo(id) || geo; } catch { /* keep */ } }
    if (!geo) geo = new THREE.BoxGeometry(0.18, 0.18, 0.18).translate(0, 0.09, 0);
    const mesh = new THREE.InstancedMesh(geo, material(), CAP);
    mesh.count = 0; mesh.visible = false;
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.raycast = () => {};
    mesh.name = `player-stack:${id}`;
    group.add(mesh);
    t = { id, mesh, h: 0.17, w: 0.17, yaw0: 0, round: false, cx: 0, cz: 0, n: 0, placeholder: placeholder && !fallbackGeo };
    measure(t);
    types.set(id, t);
    return t;
  }
  function refreshPlaceholders() {
    for (const t of types.values()) {
      if (!t.placeholder || !fallbackGeo) continue;
      let g = null;
      try { g = fallbackGeo(t.id) || null; } catch { g = null; }
      if (!g) continue;
      t.mesh.geometry = g; t.placeholder = false;
      measure(t);
    }
  }

  // ---------- what is shown: the sim's stack minus items still flying in ----------
  const inflight = [];                    // { item, n, t }
  let clock = 0, rngState = 97531;
  const rnd = () => ((rngState = (rngState * 1103515245 + 12345) >>> 0) / 4294967296);
  const offs = [];
  const on = (type, fn) => { if (events?.on) offs.push(events.on(type, p => { try { fn(p || {}); } catch (e) { console.error(`[player] stack ${type}`, e); } })); };
  on('inventory:changed', ({ item, delta, source }) => {
    if (!(delta > 0) || !source || !views.fx?.flyItem) return;
    inflight.push({ item, n: delta, t: clock + HIDE_MAX });
  });
  on('fx:itemArrived', ({ item, count = 1 }) => {
    let left = Math.max(1, count | 0);
    for (let i = 0; i < inflight.length && left > 0; i++) {
      const f = inflight[i];
      if (f.item !== item) continue;
      const k = Math.min(left, f.n);
      f.n -= k; left -= k;
    }
    for (let i = inflight.length - 1; i >= 0; i--) if (inflight[i].n <= 0) inflight.splice(i, 1);
  });

  // ---------- springs ----------
  const bendF = new Spring(0, { stiffness: 200, damping: 11 });   // + = top toward the robot's front
  const bendL = new Spring(0, { stiffness: 200, damping: 11 });   // + = top toward the robot's right (+z)
  const twist = new Spring(0, { stiffness: 160, damping: 10 });   // yaw trail of the top
  const comp = new Spring(0, { stiffness: 320, damping: 12 });    // accordion: + stretches, - squeezes
  let height = 0;                                                  // smoothed column height (world)

  // a gather that didn't fit: the stack gives a tired little wobble (the HUD shows "Full")
  let fullCool = 0;
  on('camp:stackFull', () => { if (fullCool > 0) return; fullCool = 0.6; bendL.velocity += (rnd() < 0.5 ? -1 : 1) * 0.9; comp.velocity -= 0.5; });

  const hiddenBy = new Map();
  const want = [];
  function computeWant() {
    want.length = 0;
    const stack = camp?.stack || [];
    hiddenBy.clear();
    for (const f of inflight) hiddenBy.set(f.item, (hiddenBy.get(f.item) || 0) + f.n);
    // hide the top-most occurrences of each in-flight type (collected top -> bottom, then flipped)
    for (let i = stack.length - 1; i >= 0; i--) {
      const id = stack[i];
      const h = hiddenBy.get(id) || 0;
      if (h > 0) { hiddenBy.set(id, h - 1); continue; }
      want.push(id);
    }
    want.reverse();
    // keep the bookkeeping honest: anything paid away while still in the air can't be waiting any more
    for (const f of inflight) {
      let have = 0;
      for (const id of stack) if (id === f.item) have++;
      if (f.n > have) f.n = have;
    }
  }

  // ---------- entries (identity kept across changes) ----------
  let entries = [];
  const newEntry = item => {
    const t = typeOf(item);
    return {
      item, t, fresh: true, yawT: 0, yawC: 0,
      ys: new Spring(0, { stiffness: 380, damping: 21 }),
      ls: new Spring(0, { stiffness: 300, damping: 24 }),
      fs: new Spring(0, { stiffness: 300, damping: 24 }),
      pop: new Spring(0.55, { stiffness: 520, damping: 15, target: 1 }),
      yaw: t.round ? rnd() * TAU : (rnd() - 0.5) * 0.14 + (rnd() < 0.5 ? 0 : Math.PI),
      ox: (rnd() - 0.5) * 0.02,
    };
  };
  function sync() {
    let same = want.length === entries.length;
    if (same) for (let i = 0; i < want.length; i++) if (entries[i].item !== want[i]) { same = false; break; }
    if (same) return false;
    const next = [];
    let j = 0, removed = 0, added = 0;
    for (let i = 0; i < want.length; i++) {
      const id = want[i];
      let k = j;
      while (k < entries.length && entries[k].item !== id) k++;
      if (k < entries.length) { removed += k - j; next.push(entries[k]); j = k + 1; }
      else { next.push(newEntry(id)); added++; }
    }
    removed += entries.length - j;
    entries = next;
    if (added) comp.velocity -= 0.3 * Math.min(3, added);
    if (removed) { comp.velocity += 0.5; const top = entries[entries.length - 1]; if (top) top.pop.velocity += 1.1; }
    return true;
  }
  // layer targets: pairs, crisscross; each layer as tall as its taller item
  function layout() {
    let y = LIFT;
    for (let i = 0, L = 0; i < entries.length; i += 2, L++) {
      const a = entries[i], b = entries[i + 1];
      const ha = a.t.h * ITEM_S, hb = b ? b.t.h * ITEM_S : 0;
      const w = Math.max(a.t.w, b ? b.t.w : a.t.w) * ITEM_S * 0.5 + GAP;
      const across = L % 2 === 1; // odd layers lie across the back
      const pair = b ? [a, b] : [a];
      pair.forEach((e, k) => {
        const off = k === 0 ? -w : w;
        e.ys.target = y;
        e.ls.target = across ? 0 : off;
        e.fs.target = across ? off : 0;
        e.yawT = e.t.yaw0 + (across ? Math.PI / 2 : 0) + e.yaw;
        if (e.fresh) {
          e.fresh = false;
          e.ys.value = e.ys.target + 0.22; e.ls.value = e.ls.target * 1.3; e.fs.value = e.fs.target * 1.3;
          e.yawC = e.yawT;
        }
      });
      y += Math.max(ha, hb) * NEST;
    }
    return entries.length ? y : 0;
  }

  const base = new THREE.Vector3(), top = new THREE.Vector3(), v = new THREE.Vector3();
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), qBend = new THREE.Quaternion(), qItem = new THREE.Quaternion(), qYaw = new THREE.Quaternion();
  const e3 = new THREE.Euler(), sv = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
  let yawNow = 0, groundY = 0, topLift = 0, ready = false;
  // column shape: offset (forward, lateral) and slope at height y
  const shape = { f: 0, l: 0, sf: 0, sl: 0 };
  let baseF = 0, baseL = 0;
  function columnAt(y) {
    const Hs = Math.max(height, 0.6);
    shape.f = baseF * y + (bendF.value * y * y) / (2 * Hs);
    shape.l = baseL * y + (bendL.value * y * y) / (2 * Hs);
    shape.sf = baseF + (bendF.value * y) / Hs;
    shape.sl = baseL + (bendL.value * y) / Hs;
    return shape;
  }
  // robot-local (forward, up, right) -> world, around the stack base
  const toWorld = (f, y, l, out) => {
    const c = Math.cos(yawNow), s = Math.sin(yawNow);
    f -= back;
    return out.set(base.x + c * f - s * l, base.y + y, base.z + s * f + c * l);
  };

  // info: { yaw (the pack's heading), twist (upper-body twist inside yaw), center (body axis, world), lean, bank (body angles, rad), fwdAcc, latAcc, headingVel, speed01,
  //         step (foot-contact strength this frame, 0 = none), land (landing impulse), ground }
  function update(dt, info) {
    if (!(dt > 0)) return;
    clock += dt;
    fullCool = Math.max(0, fullCool - dt);
    for (let i = inflight.length - 1; i >= 0; i--) if (inflight[i].t < clock || inflight[i].n <= 0) inflight.splice(i, 1);
    computeWant();
    sync();
    const hTarget = layout();

    // the base rides the pack lid
    rig.pack.localToWorld(base.copy(PACK_TOP));
    // the upper body twists for a swing while walking; the stack only follows part of it (a tower whipping
    // round with every swing reads as frantic): unwind the rest around the body's axis
    const tw = (info.twist || 0) * (1 - TWIST_FOLLOW);
    if (tw && info.center) {
      const dx = base.x - info.center.x, dz = base.z - info.center.z, c = Math.cos(tw), sn = Math.sin(tw);
      base.x = info.center.x + dx * c + dz * sn; base.z = info.center.z - dx * sn + dz * c;
    }
    yawNow = info.yaw - tw;
    groundY = info.ground || 0;
    height = damp(height, hTarget, 10, dt);
    const hn = clamp(height / TALL);

    // springs: taller = softer and lazier; inertia from the body's acceleration and spin
    const k = lerp(240, 95, hn), d = lerp(13, 7.5, hn);
    bendF.stiffness = bendL.stiffness = k; bendF.damping = bendL.damping = d;
    twist.stiffness = lerp(200, 110, hn); twist.damping = lerp(12, 8, hn);
    // the body's acceleration pushes the column (a force, not a target): it trails a start, swings past upright
    // after a stop and leans out of a turn, at the column's own (height-dependent) rhythm
    bendF.target = -LEAN_BACK * hn - 0.06 * (info.speed01 || 0) * hn;
    bendL.target = 0;
    bendF.velocity += clamp(-(info.fwdAcc || 0), -70, 70) * PUSH_F * dt;
    bendL.velocity += clamp(-(info.latAcc || 0), -70, 70) * PUSH_L * dt;
    twist.target = clamp(-(info.headingVel || 0) * 0.045, -0.45, 0.45);
    bendF.update(dt); bendL.update(dt); twist.update(dt);
    bendF.value = clamp(bendF.value, -0.55, 0.55); bendL.value = clamp(bendL.value, -0.5, 0.5);
    if (info.step > 0) comp.velocity -= 0.6 * info.step;
    if (info.land > 0) { comp.velocity -= info.land; bendF.velocity += info.land * 0.4; }
    comp.update(dt);
    // the base inherits part of the body's lean and bank (the pack is strapped to it)
    baseF = clamp((info.lean || 0) * 0.45, -0.25, 0.25);
    baseL = clamp((info.bank || 0) * 0.45, -0.25, 0.25);

    // ---------- draw ----------
    for (const t of types.values()) t.n = 0;
    qYaw.setFromAxisAngle(Y, -yawNow);
    const squeeze = clamp(1 + comp.value, 0.86, 1.14);
    const n = entries.length;
    topLift = LIFT;
    for (let i = 0; i < n; i++) {
      const e = entries[i];
      e.ys.update(dt); e.ls.update(dt); e.fs.update(dt); e.pop.update(dt);
      e.yawC = anim.dampAngle(e.yawC, e.yawT, 14, dt);
      const t = e.t;
      const yi = Math.max(0, e.ys.value) * squeeze;
      const half = t.h * ITEM_S * 0.5;
      topLift = Math.max(topLift, yi + t.h * ITEM_S);
      if (t.n >= CAP) continue;
      const u = height > 0 ? clamp(yi / height) : 0;
      columnAt(yi + half);
      // the item's centre sits on the (bent) column; its bottom is half a height below along the slope
      const f = shape.f + e.fs.value + e.ox - shape.sf * half, l = shape.l + e.ls.value - shape.sl * half;
      toWorld(f, yi, l, v);
      e3.set(shape.sl, 0, -shape.sf, 'XYZ');
      qBend.setFromEuler(e3);
      qItem.setFromAxisAngle(Y, e.yawC + twist.value * u);
      q.copy(qYaw).multiply(qBend).multiply(qItem);
      // a fresh item lands with a squash (volume kept)
      const sc = ITEM_S * Math.max(0.05, e.pop.value);
      const sq = clamp(1 - (e.pop.value - 1) * 0.6, 0.8, 1.25);
      sv.set(sc / Math.sqrt(sq), sc * sq, sc / Math.sqrt(sq));
      m4.compose(v, q, sv);
      t.mesh.setMatrixAt(t.n++, m4);
    }
    for (const t of types.values()) {
      t.mesh.count = t.n;
      t.mesh.visible = t.n > 0;
      if (t.n) t.mesh.instanceMatrix.needsUpdate = true;
    }
    // the top of the stack (for flights, the HUD counter, the guide)
    columnAt(topLift);
    toWorld(shape.f, topLift, shape.l, top);
    ready = true;
  }

  return {
    group,
    update,
    // world point on top of the carried stack (the pack lid when empty)
    getTop(out = new THREE.Vector3()) { return ready ? out.copy(top) : null; },
    // height of that point above the robot's ground
    topY() { return ready ? top.y - groundY : null; },
    get count() { return entries.length; },
    get height() { return height; },
    get hidden() { let n = 0; for (const f of inflight) n += f.n; return n; },
    get drawCalls() { let n = 0; for (const t of types.values()) if (t.mesh.visible) n++; return n; },
    _entries: () => entries,
    _springs: { bendF, bendL, twist, comp },
    dispose() {
      for (const off of offs) try { off?.(); } catch { /* fine */ }
      scene.remove(group);
      for (const t of types.values()) t.mesh.dispose();
    },
  };
}
