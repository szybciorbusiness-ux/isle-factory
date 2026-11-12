// GUIDANCE for the first 20 minutes (FIRST-20.md "Understanding"): one goal at a time, no quest list.
//  - shows the sim's own target, ctx.camp.goal (refreshed 4x/s by the sim; the same target the sim lets pay at
//    once), falling back to camp.nextGoal() on an older sim; tracks moving targets (animals) every frame
//  - a bouncing 3D arrow above the target (guide/arrow.js): glides between targets of the same kind, scales
//    out / in when the goal changes, drops in on the first tree after the robot has booted. Over a pad its tip
//    rests just above the floor plate's far (north) edge, nudged sideways when it would cover another plate
//  - 'wait' goals (stand by a busy station's pile) get a calm pulsing ring on the ground instead (guide/pulse.js)
//  - a ground trail of cream dots along the BFS path (guide/trail.js): fades after ~2 s of walking the right
//    way, comes back after 4 s idle, on a goal change, or when the robot wanders the wrong way
//  - an off-screen edge chip with the goal's item icon (guide/edge.js)
//  - up to five first-time hints in a sticker bubble beside Dug, on the side away from the goal and clear of
//    the target, the arrow, the stack counter, other plates and the HUD (guide/hints.js + guide/place.js),
//    remembered in localStorage (?fresh=1 resets). "Stand on the pad to build" waits until the logs visibly
//    land on the back (fx:itemArrived) and leaves on the first payment.
//  - quiet when not needed: nothing while the robot boots, no arrow while the goal's OWN pad / zone / pile is
//    exchanging (stray transfers elsewhere never silence it), while standing on it or swinging at it; the trail
//    dims while the robot follows it.
//  - camp complete: the arrow says goodbye (a hop, a spin, a sparkle) and guidance retires for good.
// Inactive outside camp mode. Owns one DOM layer: .guide-layer inside ctx.uiRoot.
import * as THREE from 'three';
import { damp } from '../util/anim.js';
import { reduceMotion } from '../ui/dom.js';
import { createArrow } from './guide/arrow.js';
import { createTrail } from './guide/trail.js';
import { createEdge } from './guide/edge.js';
import { createHints } from './guide/hints.js';
import { createPulse } from './guide/pulse.js';
import { overlap } from './guide/place.js';
import { tilePath, buildPolyline, polyLength } from './guide/path.js';
import { CSS } from './guide/css.js';

const POLL = 0.25;          // s between nextGoal() reads (only without camp.goal)
const BOOT = 2.5;           // s of a fresh game with no guidance (the robot boots)
const FOLLOW_FADE = 2.0;    // s of walking toward the goal before the trail fades
const IDLE_BACK = 4.0;      // s standing still before the trail comes back
const AWAY_BACK = 1.2;      // s walking away from the goal before the trail comes back
const NEAR = 2.0;           // path length under which the trail is not needed (one lonely dot reads as noise)
const ANIMAL_TOP = { deer: 0.9, boar: 0.72, rabbit: 0.5 };
const HINT_GOAL = { trees: 'gather', pad: 'pay', drop: 'drop', hunt: 'hunt' };
const ITEM_NOUN = { wood: 'wood', meat: 'meat', copperOre: 'ore', stone: 'stone', plank: 'planks', cookedMeat: 'cooked meat', copperBar: 'copper' };
const PAD_TIP_Y = 0.1;      // the arrow tip's rest height over a plate's far edge (the hop lifts it from there)
const PAD_TIP_OUT = 0.05;   // ...and how far past the edge (north), so the tip never sits on the plate's print
const NUDGE_T = 0.12;       // s between arrow-vs-plates checks
const PLACE_T = 0.12;       // s between hint obstacle measurements
const INFLIGHT_LIFE = 2.5;  // s an item counts as "in the air" without an fx:itemArrived (fx missing / culled)

export function create(ctx) {
  const { camp, sim, views, events, camera, params, mobile } = ctx;
  if (!camp) return {};

  // ---------- DOM layer ----------
  if (!document.getElementById('guide-css')) {
    const style = document.createElement('style');
    style.id = 'guide-css';
    style.textContent = CSS;
    document.head.append(style);
  }
  const layer = document.createElement('div');
  layer.className = 'guide-layer';
  layer.setAttribute('aria-hidden', 'false');
  const probe = document.createElement('div');
  probe.className = 'gl-probe';
  layer.append(probe);
  ctx.uiRoot.append(layer);

  const reduced = () => reduceMotion();
  // portrait: ~20% smaller than before (0.95), so it sits over a plate without hiding its neighbours
  const arrow = createArrow(ctx, { scale: mobile ? 0.76 : 0.8 });
  const pulse = createPulse(ctx, { scale: 1 });
  const trail = createTrail(ctx);
  const edge = createEdge(layer, views, { mobile, items: ctx.config?.ITEMS, reduced });
  const hints = createHints(layer, views, { reset: params?.has?.('fresh'), reduced, items: ctx.config?.ITEMS });

  // ---------- state ----------
  const fresh = camp.level === 0 && camp.padsDone.size === 0 && camp.time < 0.5;
  const useSimGoal = 'goal' in camp;
  const st = {
    enabled: true, clock: 0, poll: 0,
    boot: fresh && !params?.has?.('noboot') ? BOOT : 0,
    goal: null, goalObj: undefined, key: '', target: null, everShown: false,
    tiles: null, poly: null, playerTile: '',
    trailOn: false, followT: 0, idleT: 0, awayT: 0, following: false,
    lastXfer: -9, lastSwing: -9,
    safe: { top: 0, bottom: 0, left: 0, right: 0 }, safeT: 0, avoid: [],
    headY: 1.2, headT: 0,
    aim: null, nudge: 0, nudgeT: 0, nudgeSize: 1,
    retired: false,
    inflight: {}, inflightT: {}, arrived: {}, padArm: null, paidOnce: false,
    placeT: 0, obstacles: [], counterHome: null,
  };

  // ---------- events ----------
  const soon = () => { st.poll = Math.min(st.poll, 0.04); };
  const goalIs = (kinds, key, id) => { const g = st.goal; return !!g && kinds.includes(g.kind) && g[key] === id; };
  const offs = [
    events.on('pad:paid', ({ pad } = {}) => {
      // only the goal's own pad silences the arrow: a stray payment elsewhere is when the player needs it most
      if (pad && goalIs(['pay'], 'padId', pad.id)) st.lastXfer = st.clock;
      // "Stand on the pad to build" has done its job the moment anything is paid: out of the way, now
      if (!st.paidOnce) { st.paidOnce = true; hints.done('pad', { now: true }); }
      st.padArm = null;
      soon();
    }),
    events.on('pad:complete', ({ pad } = {}) => { if (String(pad?.id).startsWith('hire:')) hints.done('workers'); soon(); }),
    events.on('pad:shown', soon),
    events.on('station:drop', ({ station, by } = {}) => {
      if (by !== 'player') return;
      if (station && goalIs(['drop'], 'stationId', station.id)) st.lastXfer = st.clock;
      hints.done('drop');
      soon();
    }),
    events.on('pile:take', ({ station, by } = {}) => {
      if (by !== 'player') return;
      if (station && goalIs(['pickup', 'wait'], 'stationId', station.id)) st.lastXfer = st.clock;
      soon();
    }),
    events.on('pile:changed', soon),
    events.on('station:built', soon),
    events.on('inventory:changed', ({ item, delta, source } = {}) => {
      // items from the world fly to the pack first (fx); they are "in the air" until fx:itemArrived
      if (item && source && delta > 0) { st.inflight[item] = (st.inflight[item] || 0) + delta; st.inflightT[item] = st.clock; }
      soon();
    }),
    events.on('fx:itemArrived', ({ item, count = 1 } = {}) => {
      if (!item) return;
      st.inflight[item] = Math.max(0, (st.inflight[item] || 0) - (Number(count) || 1));
      st.arrived[item] = st.clock;
    }),
    events.on('player:eject', soon),
    events.on('resource:removed', soon),
    events.on('resource:spawned', soon),
    events.on('animal:killed', soon),
    events.on('animal:removed', soon),
    events.on('camp:swing', ({ by, target } = {}) => {
      if (by !== 'player') return;
      st.lastSwing = st.clock;
      if (target?.type === 'resource') hints.done('trees');
    }),
    events.on('animal:hit', ({ by } = {}) => { if (by === 'player') hints.done('hunt'); }),
    events.on('worker:hungry', () => { if (st.enabled && st.boot <= 0 && !st.retired) hints.want('workers'); }),
    events.on('worker:ate', () => hints.done('workers')),
    events.on('camp:complete', () => retire()),
  ];

  // ---------- target resolution ----------
  function keyOf(g) { return g ? `${g.kind}|${g.padId ?? g.stationId ?? g.entityId ?? g.animalId ?? `${g.x},${g.z}`}` : ''; }
  function resolve(g) {
    if (!g) return null;
    const t = { kind: g.kind, item: g.item || null, x: g.x, z: g.z, tipY: 1.1, stop: 0, rect: null, onTile: false, moving: false, top: 0.6 };
    switch (g.kind) {
      case 'gather': {
        const e = g.entityId != null ? sim.entities.get(g.entityId) : null;
        if (e) { t.x = e.x; t.z = e.z; }
        const kind = e?.kind || 'tree', sc = e?.scale || 1;
        t.tipY = kind === 'tree' ? 1.66 * sc + 0.5 : kind === 'rock' ? 0.85 * sc + 0.42 : 0.82;
        t.top = t.tipY - 0.35;
        t.stop = 0.8;
        t.item = g.item || (kind === 'rock' ? 'stone' : 'wood');
        break;
      }
      case 'hunt': {
        const a = g.animalId != null ? camp.animals.get(g.animalId) : null;
        if (a) { t.x = a.x; t.z = a.z; }
        t.tipY = (ANIMAL_TOP[a?.kind] ?? 0.8) + 0.38;
        t.top = ANIMAL_TOP[a?.kind] ?? 0.8;
        t.stop = 0.7; t.moving = true;
        t.item = g.item || 'meat';
        break;
      }
      case 'pay': {
        const pad = camp.pads.find(p => p.id === g.padId);
        if (pad) { const c = camp.rectCenter(pad.zone); t.x = c.x; t.z = c.z; t.rect = pad.zone; }
        t.tipY = 0.95; t.top = 0.1;
        break;
      }
      case 'drop': {
        const s = camp.stations.get(g.stationId);
        if (s?.def.zone) { const c = camp.rectCenter(s.def.zone); t.x = c.x; t.z = c.z; t.rect = s.def.zone; }
        t.tipY = 0.95; t.top = 0.3;
        break;
      }
      case 'pickup': case 'wait': {
        t.onTile = true;
        const s = camp.stations.get(g.stationId);
        const n = s?.pile?.count || 0;
        t.tipY = 0.9 + Math.min(0.5, n * 0.025);
        t.top = 0.3 + Math.min(0.5, n * 0.025);
        if (g.kind === 'wait') { t.tipY = 0.45; t.stop = 0.75; }   // the trail ends at the ring, not on the heap
        break;
      }
      default: break;
    }
    return t;
  }
  // live position of a moving target (animals) every frame
  function track(t) {
    if (!t || !st.goal) return;
    if (t.kind === 'hunt') {
      const a = camp.animals.get(st.goal.animalId);
      if (a && !a.dead) { t.x = a.x; t.z = a.z; }
    }
  }

  // ---------- helpers ----------
  const v3 = new THREE.Vector3();
  let W = innerWidth, H = innerHeight;
  function toScreen(x, y, z) {
    v3.set(x, y, z).project(camera);
    return { x: (v3.x * 0.5 + 0.5) * W, y: (-v3.y * 0.5 + 0.5) * H, behind: v3.z > 1 };
  }
  const rectOf = pts => {
    let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity;
    for (const p of pts) { if (p.x < l) l = p.x; if (p.x > r) r = p.x; if (p.y < t) t = p.y; if (p.y > b) b = p.y; }
    return { left: l, right: r, top: t, bottom: b };
  };
  const playerPos = () => {
    const p = views.player?.getPosition?.();
    return p ? { x: p.x, z: p.z } : { x: sim.player.x, z: sim.player.z };
  };
  const walk = (x, z) => sim.isWalkable(x, z);
  function measureSafe() {
    try {
      const r = probe.getBoundingClientRect();
      st.safe.top = Math.max(0, r.top);
      st.safe.bottom = Math.max(0, H - r.bottom);
    } catch { /* fine */ }
    const hb = views.ui?.hudBottom?.();
    if (mobile && Number.isFinite(hb)) st.safe.bottom = Math.max(st.safe.bottom, hb);
    st.avoid = [];
    const cluster = views.ui?.camp?.el;
    if (cluster?.isConnected) { const r = cluster.getBoundingClientRect(); if (r.width > 0) st.avoid.push(r); }
  }
  const box = new THREE.Box3();
  function measureHead(dt) {
    st.headT -= dt;
    if (st.headT > 0) return;
    st.headT = 0.25;
    const obj = views.player?.object;
    let top = 1.05;
    if (obj) { try { box.setFromObject(obj); if (Number.isFinite(box.max.y)) top = Math.max(0.8, box.max.y - (views.player.getPosition?.().y || 0)); } catch { /* fine */ } }
    const stackTop = views.player?.stackTopY?.();
    if (Number.isFinite(stackTop)) top = Math.max(top, stackTop);
    st.targetHead = Math.min(4.5, top + 0.22);
  }

  // A pad's plate as drawn (pads view), else its zone.
  function plateOf(padId) {
    const r = views.pads?.plateRect?.(padId);
    if (r && Number.isFinite(r.x)) return r;
    const pad = camp.pads.find(p => p.id === padId);
    if (!pad) return null;
    const [x, z, w, h] = pad.zone;
    return { x: x + (w - 1) / 2, z: z + (h - 1) / 2, hx: w / 2 - 0.07, hz: h / 2 - 0.07 };
  }
  function plateScreen(r, inset = 0) {
    const ix = r.hx * (1 - inset), iz = r.hz * (1 - inset);
    return rectOf([toScreen(r.x - ix, 0.03, r.z - iz), toScreen(r.x + ix, 0.03, r.z - iz), toScreen(r.x - ix, 0.03, r.z + iz), toScreen(r.x + ix, 0.03, r.z + iz)]);
  }
  // the arrow's screen box if its tip rested at (x, y, z): it points down on screen and runs up from the tip
  const camRight = new THREE.Vector3(), camUp = new THREE.Vector3();
  function arrowScreen(x, y, z, ext = arrow.extent) {
    camRight.setFromMatrixColumn(camera.matrixWorld, 0);
    camUp.setFromMatrixColumn(camera.matrixWorld, 1);
    const hw = ext.halfWidth, h = ext.height;
    const pts = [];
    for (const [u, v, lift] of [[-1, 0.42, 0], [1, 0.42, 0], [-1, 1, ext.hop], [1, 1, ext.hop], [0, 0, 0]]) {
      pts.push(toScreen(x + camRight.x * hw * u + camUp.x * h * v, y + lift + camRight.y * hw * u + camUp.y * h * v, z + camRight.z * hw * u + camUp.z * h * v));
    }
    return rectOf(pts);
  }

  // ---------- goal ----------
  function setGoal(g) {
    const key = keyOf(g);
    st.goal = g;
    const t = resolve(g);
    if (key !== st.key) {
      const old = st.target;
      st.key = key;
      st.target = t;
      onGoalChange(old, t);
    } else if (t && st.target) {
      // same goal: keep the live tracked position for animals, refresh the rest
      const keep = st.target.kind === 'hunt' ? { x: st.target.x, z: st.target.z } : null;
      Object.assign(st.target, t, keep || {});
    }
    const p = playerPos();
    st.tiles = st.target ? tilePath(camp, p, st.target) : null;
    rebuildPoly(p);
  }
  function rebuildPoly(p) {
    st.poly = st.target && st.tiles ? buildPolyline(walk, p, st.tiles, st.target) : null;
    trail.setPath(st.poly);
  }
  // Where the arrow's tip rests for target t. Over a pad: just above the plate's far (north) edge, so the arrow
  // stands north of the plate on screen and never hides its number; shifted by st.nudge (see nudgeArrow).
  function aimFor(t) {
    if (!t) return null;
    if (t.kind === 'pay' && st.goal?.padId) {
      const r = plateOf(st.goal.padId);
      if (r) return { x: r.x + st.nudge, y: PAD_TIP_Y, z: r.z - r.hz - PAD_TIP_OUT, gx: r.x, gz: r.z, plate: r };
    }
    return { x: t.x, y: t.tipY, z: t.z, gx: t.x, gz: t.z };
  }
  // A new goal: the trail draws on again from the robot; the arrow glides to a nearby target of the same kind
  // (the next tree) or scales out and back in at the new spot.
  function onGoalChange(old, t) {
    st.trailOn = !!t; st.followT = 0; st.idleT = 0; st.awayT = 0;
    st.redraw = true;
    st.nudge = 0; st.nudgeT = 0; st.nudgeSize = 1;
    if (!t || st.boot > 0 || !st.everShown || st.retired) return;
    if (t.kind === 'pay') nudgeArrow(t, true);
    const glide = !!(old && old.kind === t.kind && Math.hypot(old.x - t.x, old.z - t.z) < 7 && arrow.value > 0.3);
    const a = aimFor(t);
    st.aim = a;
    arrow.place(a.x, a.z, a.y, { glide, ground: [a.gx, a.gz] });
  }

  // Over a pad, keep the arrow off the other plates: if its screen box would cover another plate (its number /
  // icon / tag), slide it sideways along the far edge, as little as possible; keep the current slide while it
  // still clears (no hunting back and forth).
  function nudgeArrow(t, force = false) {
    const id = st.goal?.padId;
    const r = id ? plateOf(id) : null;
    if (!r) { st.nudge = 0; return; }
    const others = [];
    for (const pid of views.pads?.pads || camp.pads.map(p => p.id)) {
      if (pid === id) continue;
      const o = plateOf(pid);
      if (!o || Math.abs(o.x - r.x) > 4 || Math.abs(o.z - r.z) > 4) continue;
      const ps = plateScreen(o), wx = (ps.right - ps.left) * 0.04;   // name tags can run a little wider than the plate
      others.push({ left: ps.left - wx, right: ps.right + wx, top: ps.top, bottom: ps.bottom, k: 1 });
      // its floating emblem / ghost (what it gives) counts too, a little less
      const obj = views.pads?.padObject?.(pid);
      if (obj?.visible) {
        try {
          box.setFromObject(obj);
          if (!box.isEmpty()) {
            const c = [];
            for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const zz of [box.min.z, box.max.z]) c.push(toScreen(x, y, zz));
            others.push({ ...rectOf(c), k: 0.5 });
          }
        } catch { /* optional */ }
      }
    }
    if (!others.length) { st.nudge = 0; st.nudgeSize = 1; return; }
    const z = r.z - r.hz - PAD_TIP_OUT;
    const cost = (dx, ext) => { const a = arrowScreen(r.x + dx, PAD_TIP_Y, z, ext); a.left -= 4; a.right += 4; a.top -= 4; let c = 0; for (const o of others) c += overlap(a, o) * o.k; return c; };
    // the tip stays over the plate's far edge (it must still point at this plate); if no slide clears, a
    // slightly smaller arrow; least cover first, then the smallest slide, then the current choice
    const lim = r.hx * 0.85;
    let best = null;
    for (const size of [1, 0.8]) {
      const ext = arrow.extentFor(size);
      for (let d = 0; d <= lim + 1e-6; d += 0.1) {
        for (const sgn of d ? [1, -1] : [1]) {
          const dx = sgn * d, c = cost(dx, ext);
          const keep = !force && Math.abs(dx - st.nudge) < 0.05 && size === st.nudgeSize;
          const score = c + 60 * d + (size < 1 ? 150 : 0) - (keep ? 40 : 0);
          if (!best || score < best.score) best = { dx, size, score };
        }
      }
    }
    st.nudge = best.dx; st.nudgeSize = best.size;
  }

  // ---------- retiring (camp complete) ----------
  function retire() {
    if (st.retired) return;
    st.retired = true;
    let at = null;
    if (st.everShown && st.enabled && st.aim && st.boot <= 0) {
      // it was quiet (the player stands on the last pad): pop up over the spot it last pointed at
      at = { x: st.aim.x, y: st.aim.y + 0.35, z: st.aim.z, gx: st.aim.gx, gz: st.aim.gz };
    }
    arrow.retire(at);
    pulse.show(false);
    trail.setVisible(0);
    if (hints.current) hints.dismiss(hints.current);
  }

  // ---------- hint placement: Dug's box, where the goal is, and what not to cover ----------
  function measureObstacles(t, p) {
    const obs = [];
    // the target itself (never cover what the hint talks about)
    if (t) {
      let r = null;
      if (t.kind === 'pay' && st.goal?.padId) { const pr = plateOf(st.goal.padId); if (pr) r = plateScreen(pr); }
      else if (t.rect) { const [x, z, w, h] = t.rect; r = rectOf([toScreen(x - 0.5, 0, z - 0.5), toScreen(x + w - 0.5, 0, z + h - 0.5), toScreen(x - 0.5, 0, z + h - 0.5), toScreen(x + w - 0.5, t.top, z - 0.5)]); }
      else r = rectOf([toScreen(t.x - 0.55, 0, t.z + 0.45), toScreen(t.x + 0.55, 0, t.z + 0.45), toScreen(t.x - 0.55, t.top + 0.3, t.z - 0.3), toScreen(t.x + 0.55, t.top + 0.3, t.z - 0.3)]);
      if (r) obs.push({ r: grow(r, 3), w: 8 });
      if (st.aim && t.kind !== 'wait') obs.push({ r: grow(arrowScreen(st.aim.x, st.aim.y, st.aim.z), 2), w: 5 });
    }
    // other pads' plates (their numbers and tags)
    for (const pid of views.pads?.pads || []) {
      if (pid === st.goal?.padId) continue;
      const o = plateOf(pid);
      if (!o || Math.abs(o.x - p.x) > 7 || Math.abs(o.z - p.z) > 7) continue;
      obs.push({ r: plateScreen(o), w: 4 });
    }
    // the stack counter, where it is and where it lives (above the stack)
    try {
      const cs = document.querySelector('.cs');
      const bub = cs && cs.style.visibility !== 'hidden' ? cs.querySelector('.cs-bub') : null;
      if (bub) { const r = bub.getBoundingClientRect(); if (r.width > 0) obs.push({ r: grow(r, 6), w: 5 }); }
    } catch { /* fine */ }
    // (its home above the stack only mildly: while the hint sits up there the HUD docks it beside the stack)
    if (camp.stack.length > 0) {
      const top = views.player?.getStackTop?.(new THREE.Vector3());
      if (top) { const s = toScreen(top.x, top.y, top.z); obs.push({ r: { left: s.x - 62, right: s.x + 62, top: s.y - 66, bottom: s.y + 8 }, w: 1 }); }
    }
    // the way to the goal (the trail and where the player looks next): a corridor of small boxes
    if (t) {
      const a = toScreen(p.x, 0.4, p.z), b = toScreen(t.x, 0.2, t.z);
      let dx = b.x - a.x, dy = b.y - a.y;
      if (b.behind) { dx = -dx; dy = -dy; }
      const len = Math.min(Math.hypot(dx, dy), Math.hypot(W, H));
      if (len > 40) {
        const ux = dx / Math.hypot(dx, dy), uy = dy / Math.hypot(dx, dy);
        for (let d = 34; d < len - 10; d += 30) {
          const cx = a.x + ux * d, cy = a.y + uy * d;
          obs.push({ r: { left: cx - 14, right: cx + 14, top: cy - 14, bottom: cy + 14 }, w: 0.7 });
        }
      }
    }
    // the HUD (badge, its card, toasts, the level-up ribbon) and the edge chip
    try { for (const r of views.ui?.camp?.rects?.() || []) obs.push({ r: grow(r, 6), w: 5 }); } catch { /* fine */ }
    for (const r of st.avoid) obs.push({ r, w: 5 });
    if (edge.visible) { const e = edge.position; obs.push({ r: { left: e.x - 34, right: e.x + 34, top: e.y - 34, bottom: e.y + 34 }, w: 3 }); }
    st.obstacles = obs;
  }
  const grow = (r, g) => ({ left: r.left - g, right: r.right + g, top: r.top - g, bottom: r.bottom + g });
  function hintPlace(t, p) {
    const feet = toScreen(p.x, 0, p.z);
    if (feet.behind) return null;
    const head = toScreen(p.x, st.headY, p.z);
    const side = toScreen(p.x + 1, 0, p.z);
    const ppu = Math.max(8, Math.abs(side.x - feet.x));
    const dug = { cx: feet.x, top: Math.min(head.y, feet.y - 10), bottom: feet.y + ppu * 0.12, hw: ppu * 0.42 };
    let goalDir = null;
    if (t) {
      const g = st.aim ? toScreen(st.aim.gx ?? t.x, 0.2, st.aim.gz ?? t.z) : toScreen(t.x, 0.2, t.z);
      let dx = g.x - dug.cx, dy = g.y - (dug.top + dug.bottom) / 2;
      if (g.behind) { dx = -dx; dy = -dy; }
      const l = Math.hypot(dx, dy);
      if (l > 4) goalDir = { x: dx / l, y: dy / l };
    }
    const obstacles = [...st.obstacles, { r: { left: dug.cx - dug.hw, right: dug.cx + dug.hw, top: dug.top, bottom: dug.bottom }, w: 6 }];
    const bounds = { l: 8, r: W - 8, t: st.safe.top + 8, b: H - st.safe.bottom - 8 };
    return { dug, goalDir, obstacles, bounds };
  }

  // ---------- frame ----------
  function update(dt) {
    if (!(dt >= 0)) return;
    st.clock += dt;
    W = innerWidth; H = innerHeight;
    if (st.boot > 0) st.boot = Math.max(0, st.boot - dt);
    if (views.player?.booting) st.boot = Math.max(st.boot, 0.05);
    if (camp.complete && !st.retired) retire();

    // the goal: the sim's own (it refreshes camp.goal 4x/s; a new object each time)
    if (st.retired) { if (st.goal) setGoal(null); }
    else if (useSimGoal) { if (camp.goal !== st.goalObj) { st.goalObj = camp.goal; setGoal(camp.goal || null); } }
    else {
      st.poll -= dt;
      if (st.poll <= 0) { st.poll = POLL; let g = null; try { g = camp.nextGoal(); } catch (e) { console.error('[guide] nextGoal', e); } setGoal(g); }
    }
    st.safeT -= dt;
    if (st.safeT <= 0) { st.safeT = 0.5; measureSafe(); }
    measureHead(dt);

    const t = st.target;
    track(t);
    const p = playerPos();
    const tileKey = `${Math.round(p.x)},${Math.round(p.z)}`;
    if (t && tileKey !== st.playerTile) { st.playerTile = tileKey; st.tiles = tilePath(camp, p, t); rebuildPoly(p); }
    else if (st.poly) { st.poly[0] = [p.x, p.z]; trail.setPath(st.poly); }
    if (st.redraw && st.poly) { trail.setPath(st.poly, { redraw: true }); st.redraw = false; }

    const booting = st.boot > 0;
    const active = st.enabled && !booting && !!t && !st.retired;

    // ---- quiet: the goal's own pad / zone / pile exchanging, standing on it, swinging at it ----
    const paying = st.clock - st.lastXfer < 0.4;
    const onIt = t && ((t.rect && camp.inRect(t.rect, p.x, p.z)) || (t.onTile && Math.hypot(p.x - t.x, p.z - t.z) < 0.6));
    const swinging = st.clock - st.lastSwing < 0.75 && (t?.kind === 'gather' || t?.kind === 'hunt');
    const quiet = paying || onIt || swinging;
    const waiting = t?.kind === 'wait';

    // ---- arrow ----
    if (active) {
      if (t.kind === 'pay') { st.nudgeT -= dt; if (st.nudgeT <= 0) { st.nudgeT = NUDGE_T; nudgeArrow(t); } }
      const a = aimFor(t);
      st.aim = a;
      const ground = { ground: [a.gx, a.gz] };
      if (!st.everShown) {
        if (!waiting) { st.everShown = true; arrow.place(a.x, a.z, a.y, { glide: false, ...ground }); if (!reduced()) arrow.dropIn(); }
      } else arrow.place(a.x, a.z, a.y, { glide: true, ...ground });
      arrow.show(!quiet && !waiting);
      if (reduced()) arrow.setHop(1.1, 0.1);
      else arrow.setHop(0.86, 0.26);
      arrow.setSize(t.kind === 'pay' ? st.nudgeSize : 1);
      arrow.setShadow(t.kind !== 'gather');
    } else arrow.show(false);
    arrow.update(dt);

    // ---- wait ring ----
    if (active && waiting) { pulse.place(t.x, t.z); pulse.setDim(onIt ? 0.75 : 1); }
    pulse.show(active && waiting);
    pulse.update(dt, reduced());

    // ---- trail ----
    const speed = views.player?.speed ?? 0;
    const vel = views.player?.velocity || { x: 0, z: 0 };
    let dot = 0;
    if (st.poly && st.poly.length > 1) {
      const [ax, az] = st.poly[0];
      let k = 1;
      while (k < st.poly.length - 1 && Math.hypot(st.poly[k][0] - ax, st.poly[k][1] - az) < 0.35) k++;
      const dx = st.poly[k][0] - ax, dz = st.poly[k][1] - az, l = Math.hypot(dx, dz) || 1;
      const vl = Math.hypot(vel.x, vel.z) || 1;
      dot = (dx * vel.x + dz * vel.z) / (l * vl);
    }
    const moving = speed > 0.5;
    st.following = moving && dot > 0.5;
    if (st.following) { st.followT += dt; st.awayT = 0; }
    else if (moving && dot < -0.25) st.awayT += dt;
    else st.awayT = Math.max(0, st.awayT - dt);
    if (speed < 0.15) st.idleT += dt; else st.idleT = 0;
    if (st.trailOn && st.followT > FOLLOW_FADE) st.trailOn = false;
    if (!st.trailOn && (st.idleT > IDLE_BACK || st.awayT > AWAY_BACK)) { st.trailOn = true; st.followT = 0; st.awayT = 0; st.redraw = true; }
    const remaining = st.poly ? polyLength(st.poly) : 0;
    const trailVis = active && st.trailOn && !quiet && remaining > NEAR ? (st.following ? 0.5 : 1) : 0;
    trail.setVisible(trailVis);
    trail.update(dt);

    // ---- edge chip ----
    let off = false, tp = null, from = null;
    if (active && !quiet) {
      tp = st.aim ? toScreen(st.aim.x, st.aim.y + 0.45, st.aim.z) : toScreen(t.x, t.tipY + 0.45, t.z);
      const m = 14;
      off = tp.behind || tp.x < m || tp.x > W - m || tp.y < st.safe.top + m || tp.y > H - st.safe.bottom - m;
      if (off) from = toScreen(p.x, 0.5, p.z);
    }
    edge.update(dt, { want: off, from, to: tp, item: t?.item || null, safe: st.safe, avoid: st.avoid, W, H });

    // ---- first-time hints ----
    if (active) {
      const g = st.goal;
      const hire = String(g?.padId).startsWith('hire:');
      if (t.kind === 'gather' && t.item === 'wood' && arrow.shownFor > 0.35) hints.want('trees');
      else if (t.kind === 'pay' && hire) hints.want('workers');
      else if (t.kind === 'drop' && Math.hypot(p.x - t.x, p.z - t.z) < 3.2) {
        const noun = ITEM_NOUN[t.item] || 'it';
        hints.want('drop', { text: `Drop ${noun} here`, icon: t.item });
      } else if (t.kind === 'hunt' && arrow.shownFor > 0.2) hints.want('hunt');
      // "Stand on the pad to build": once the goal says pay, wait for the logs to visibly land on the back (the
      // sim credits them at the hit, ~1 s before they arrive); straight away if nothing is in the air
      if (t.kind === 'pay' && !hire && !hints.seen('pad') && !st.paidOnce) {
        if (!st.padArm || st.padArm.padId !== g.padId) st.padArm = { padId: g.padId, since: st.clock };
        const pad = camp.pads.find(q => q.id === g.padId);
        const need = pad ? Object.keys(pad.cost).filter(k => (pad.paid[k] || 0) < pad.cost[k]) : [];
        const landed = need.some(k => (st.arrived[k] ?? -9) >= st.padArm.since);
        const inAir = need.some(k => (st.inflight[k] || 0) > 0 && st.clock - (st.inflightT[k] ?? -9) < INFLIGHT_LIFE);
        // already stepping onto it: they got it (the first payment marks it seen); no hint that would only flash
        const z = pad?.zone, dx = z ? Math.max(z[0] - 0.5 - p.x, 0, p.x - (z[0] + z[2] - 0.5)) : 9, dz = z ? Math.max(z[1] - 0.5 - p.z, 0, p.z - (z[1] + z[3] - 0.5)) : 9;
        const there = Math.hypot(dx, dz) < 0.8;
        if (!there && (landed || (!inAir && st.clock - st.padArm.since > 0.15))) hints.want('pad');
      } else if (t.kind !== 'pay') st.padArm = null;
    }
    // a hint whose moment has passed (the goal moved on) leaves early
    const cur = hints.current;
    if (cur && cur !== 'workers' && HINT_GOAL[cur] !== t?.kind) hints.dismiss(cur);
    st.headY = damp(st.headY, st.targetHead ?? st.headY, 8, dt);
    let place = null;
    if (hints.current) {
      st.placeT -= dt;
      if (st.placeT <= 0) { st.placeT = PLACE_T; measureObstacles(active ? t : null, p); }
      place = hintPlace(active ? t : null, p);
    } else st.placeT = 0;
    hints.update(dt, place, { suppress: !st.enabled || booting || st.retired });
  }

  function resize(w, h) { W = w; H = h; st.safeT = 0; }

  if (camp.complete) retire();   // a finished camp (loaded save): no guidance at all

  const api = {
    // the goal being shown (camp.goal shape), or null (none / the camp is complete)
    get goal() { return st.goal; },
    get target() { return st.target; },
    // the trail's polyline [[x, z], ...] from the robot to the end point (null when there is none)
    get path() { return st.poly; },
    // where the arrow's tip rests (world), or null
    get aim() { return st.aim; },
    get retired() { return st.retired; },
    setEnabled(on) { st.enabled = !!on; },
    get enabled() { return st.enabled; },
    update,
    resize,
    // test / debug hooks
    state() {
      return {
        goal: st.goal, key: st.key, boot: +st.boot.toFixed(2), retired: st.retired,
        arrow: { shown: arrow.visible, v: +arrow.value.toFixed(3), x: +arrow.position.x.toFixed(2), y: +arrow.position.y.toFixed(2), z: +arrow.position.z.toFixed(2), nudge: +st.nudge.toFixed(2), size: st.nudgeSize },
        pulse: { shown: pulse.visible, v: +pulse.value.toFixed(3) },
        trail: { on: st.trailOn, opacity: +trail.opacity.toFixed(3), dots: trail.dots, length: +trail.length.toFixed(2), followT: +st.followT.toFixed(2), idleT: +st.idleT.toFixed(2) },
        edge: { shown: edge.visible, ...edge.position },
        hint: hints.current, hintsSeen: hints.count, hintRect: hints.rect,
        safe: st.safe,
      };
    },
    skipBoot() { st.boot = 0; },
    resetHints() { hints.reset(); },
    // tests: treat every first-time hint as already seen
    skipHints() { for (const id of ['trees', 'pad', 'drop', 'hunt', 'workers']) hints.done(id, { now: true }); },
    placeDebug: () => hints.debug,
    hint: (id, opts) => hints.want(id, opts),
    el: layer,
    dispose() {
      offs.forEach(off => off?.());
      arrow.dispose(); trail.dispose(); pulse.dispose();
      layer.remove();
    },
  };
  return api;
}
