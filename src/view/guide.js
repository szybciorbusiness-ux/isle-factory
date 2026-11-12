// GUIDANCE for the first 20 minutes (FIRST-20.md "Understanding"): one goal at a time, no quest list.
//  - reads ctx.camp.nextGoal() every ~0.25 s (sooner after anything that can change it) and tracks moving
//    targets (animals) every frame
//  - a bouncing 3D arrow above the target (guide/arrow.js): glides between targets of the same kind, scales
//    out / in when the goal changes, drops in on the first tree after the robot has booted
//  - a ground trail of cream dots along the BFS path (guide/trail.js): fades after ~2 s of walking the right
//    way, comes back after 4 s idle, on a goal change, or when the robot wanders the wrong way
//  - an off-screen edge chip with the goal's item icon (guide/edge.js)
//  - up to five first-time hints in a sticker bubble above the robot (guide/hints.js), remembered in
//    localStorage (?fresh=1 resets)
//  - quiet when not needed: nothing while the robot boots, no arrow while standing on a pad / zone / pile
//    that is paying out or while swinging at the goal, the trail dims while the robot follows it.
// Inactive outside camp mode. Owns one DOM layer: .guide-layer inside ctx.uiRoot.
import * as THREE from 'three';
import { damp } from '../util/anim.js';
import { reduceMotion } from '../ui/dom.js';
import { createArrow } from './guide/arrow.js';
import { createTrail } from './guide/trail.js';
import { createEdge } from './guide/edge.js';
import { createHints } from './guide/hints.js';
import { tilePath, buildPolyline, polyLength } from './guide/path.js';
import { CSS } from './guide/css.js';

const POLL = 0.25;          // s between nextGoal() reads
const BOOT = 2.5;           // s of a fresh game with no guidance (the robot boots)
const FOLLOW_FADE = 2.0;    // s of walking toward the goal before the trail fades
const IDLE_BACK = 4.0;      // s standing still before the trail comes back
const AWAY_BACK = 1.2;      // s walking away from the goal before the trail comes back
const NEAR = 2.0;           // path length under which the trail is not needed (one lonely dot reads as noise)
const ANIMAL_TOP = { deer: 0.9, boar: 0.72, rabbit: 0.5 };
const HINT_GOAL = { trees: 'gather', pad: 'pay', drop: 'drop', hunt: 'hunt' };
const ITEM_NOUN = { wood: 'wood', meat: 'meat', copperOre: 'ore', stone: 'stone', plank: 'planks', cookedMeat: 'cooked meat', copperBar: 'copper' };

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
  const arrow = createArrow(ctx, { scale: mobile ? 0.95 : 0.8 });
  const trail = createTrail(ctx);
  const edge = createEdge(layer, views, { mobile, items: ctx.config?.ITEMS, reduced });
  const hints = createHints(layer, views, { reset: params?.has?.('fresh'), reduced, items: ctx.config?.ITEMS });

  // ---------- state ----------
  const fresh = camp.level === 0 && camp.padsDone.size === 0 && camp.time < 0.5;
  const st = {
    enabled: true, clock: 0, poll: 0,
    boot: fresh && !params?.has?.('noboot') ? BOOT : 0,
    goal: null, key: '', target: null, everShown: false,
    tiles: null, poly: null, playerTile: '',
    trailOn: false, followT: 0, idleT: 0, awayT: 0, following: false,
    lastXfer: -9, lastSwing: -9,
    safe: { top: 0, bottom: 0, left: 0, right: 0 }, safeT: 0, avoid: [],
    headY: 1.2, headT: 0, liftT: 0,
  };

  // ---------- events: re-read the goal soon after anything that can change it ----------
  const soon = () => { st.poll = Math.min(st.poll, 0.04); };
  const offs = [
    events.on('pad:paid', () => { st.lastXfer = st.clock; hints.done('pad'); soon(); }),
    events.on('pad:complete', ({ pad } = {}) => { if (String(pad?.id).startsWith('hire:')) hints.done('workers'); soon(); }),
    events.on('pad:shown', soon),
    events.on('station:drop', ({ by } = {}) => { if (by === 'player') { st.lastXfer = st.clock; hints.done('drop'); } soon(); }),
    events.on('pile:take', ({ by } = {}) => { if (by === 'player') { st.lastXfer = st.clock; soon(); } }),
    events.on('pile:changed', soon),
    events.on('station:built', soon),
    events.on('inventory:changed', soon),
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
    events.on('worker:hungry', () => { if (st.enabled && st.boot <= 0) hints.want('workers'); }),
    events.on('worker:ate', () => hints.done('workers')),
  ];

  // ---------- target resolution ----------
  function keyOf(g) { return g ? `${g.kind}|${g.padId ?? g.stationId ?? g.entityId ?? g.animalId ?? `${g.x},${g.z}`}` : ''; }
  function resolve(g) {
    if (!g) return null;
    const t = { kind: g.kind, item: g.item || null, x: g.x, z: g.z, tipY: 1.1, stop: 0, rect: null, onTile: false, moving: false };
    switch (g.kind) {
      case 'gather': {
        const e = g.entityId != null ? sim.entities.get(g.entityId) : null;
        if (e) { t.x = e.x; t.z = e.z; }
        const kind = e?.kind || 'tree', sc = e?.scale || 1;
        t.tipY = kind === 'tree' ? 1.66 * sc + 0.5 : kind === 'rock' ? 0.85 * sc + 0.42 : 0.82;
        t.stop = 0.8;
        t.item = g.item || (kind === 'rock' ? 'stone' : 'wood');
        break;
      }
      case 'hunt': {
        const a = g.animalId != null ? camp.animals.get(g.animalId) : null;
        if (a) { t.x = a.x; t.z = a.z; }
        t.tipY = (ANIMAL_TOP[a?.kind] ?? 0.8) + 0.38;
        t.stop = 0.7; t.moving = true;
        t.item = g.item || 'meat';
        break;
      }
      case 'pay': {
        const pad = camp.pads.find(p => p.id === g.padId);
        if (pad) { const c = camp.rectCenter(pad.zone); t.x = c.x; t.z = c.z; t.rect = pad.zone; }
        t.tipY = 0.95;
        break;
      }
      case 'drop': {
        const s = camp.stations.get(g.stationId);
        if (s?.def.zone) { const c = camp.rectCenter(s.def.zone); t.x = c.x; t.z = c.z; t.rect = s.def.zone; }
        t.tipY = 0.95;
        break;
      }
      case 'pickup': case 'wait': {
        t.onTile = true;
        const s = camp.stations.get(g.stationId);
        const n = s?.pile?.count || 0;
        t.tipY = 0.9 + Math.min(0.5, n * 0.025);
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

  // ---------- goal polling ----------
  function pollGoal() {
    let g = null;
    try { g = camp.nextGoal(); } catch (e) { console.error('[guide] nextGoal', e); }
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
    // path
    const p = playerPos();
    st.tiles = st.target ? tilePath(camp, p, st.target) : null;
    rebuildPoly(p);
  }
  function rebuildPoly(p) {
    st.poly = st.target && st.tiles ? buildPolyline(walk, p, st.tiles, st.target) : null;
    trail.setPath(st.poly);
  }
  // A new goal: the trail draws on again from the robot; the arrow glides to a nearby target of the same kind
  // (the next tree) or scales out and back in at the new spot.
  function onGoalChange(old, t) {
    st.trailOn = !!t; st.followT = 0; st.idleT = 0; st.awayT = 0;
    st.redraw = true;
    if (!t || st.boot > 0 || !st.everShown) return;
    const glide = !!(old && old.kind === t.kind && Math.hypot(old.x - t.x, old.z - t.z) < 7 && arrow.value > 0.3);
    t.lift = t.kind === 'pay' ? clearOfBubble(t) : null;
    st.liftT = 0.1;
    const a = t.lift || { x: t.x, y: t.tipY, z: t.z };
    arrow.place(a.x, a.z, a.y, { glide, ground: [t.x, t.z] });
  }

  // Where the arrow's tip goes so it sits centred just above the pad's DOM cost bubble: the point on the camera
  // ray through (bubble centre, bubble top - gap) nearest the pad in xz. null when the pad shows no bubble or
  // the default tip height already clears it.
  const rayO = new THREE.Vector3(), rayD = new THREE.Vector3();
  function clearOfBubble(t) {
    const el = st.goal?.padId ? views.pads?.bubble?.(st.goal.padId) : null;
    if (!el?.isConnected) return null;
    const op = el.style.opacity === '' ? 1 : Number(el.style.opacity);
    if (!(op > 0.2) || el.style.visibility === 'hidden') return null;
    const r = el.getBoundingClientRect();
    if (r.height < 4 || r.bottom < 0 || r.top > H) return null;
    const sx = (r.left + r.right) / 2, sy = r.top - (mobile ? 5 : 8);
    const tipS = toScreen(t.x, t.tipY, t.z);
    if (tipS.y < sy) return null;
    // a bubble nudged sideways (label de-cluttering) no longer marks the pad: point at the pad itself then
    if (Math.abs(sx - tipS.x) > Math.max(26, r.width * 0.45)) return null;
    rayO.setFromMatrixPosition(camera.matrixWorld);
    rayD.set((sx / W) * 2 - 1, -(sy / H) * 2 + 1, 0.5).unproject(camera).sub(rayO).normalize();
    const hx = rayD.x, hz = rayD.z, hl = hx * hx + hz * hz;
    if (hl < 1e-6) return null;
    const d = ((t.x - rayO.x) * hx + (t.z - rayO.z) * hz) / hl;
    return { x: rayO.x + rayD.x * d, y: rayO.y + rayD.y * d, z: rayO.z + rayD.z * d };
  }

  // ---------- frame ----------
  function update(dt) {
    if (!(dt >= 0)) return;
    st.clock += dt;
    W = innerWidth; H = innerHeight;
    if (st.boot > 0) st.boot = Math.max(0, st.boot - dt);
    if (views.player?.booting) st.boot = Math.max(st.boot, 0.05);

    st.poll -= dt;
    if (st.poll <= 0) { st.poll = POLL; pollGoal(); }
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
    const active = st.enabled && !booting && !!t;

    // ---- quiet: paying out / standing on it / swinging at it ----
    const paying = st.clock - st.lastXfer < 0.4;
    const onIt = t && ((t.rect && camp.inRect(t.rect, p.x, p.z)) || (t.onTile && Math.hypot(p.x - t.x, p.z - t.z) < 0.6));
    const swinging = st.clock - st.lastSwing < 0.75 && (t?.kind === 'gather' || t?.kind === 'hunt');
    const quiet = paying || onIt || swinging;

    // ---- arrow ----
    if (active) {
      // a pad's DOM cost bubble floats over the pad: rest the arrow's tip just above it, never behind it
      st.liftT -= dt;
      if (st.liftT <= 0) { st.liftT = 0.1; t.lift = t.kind === 'pay' ? clearOfBubble(t) : null; }
      const a = t.lift || { x: t.x, y: t.tipY, z: t.z };
      const ground = { ground: [t.x, t.z] };
      if (!st.everShown) { st.everShown = true; arrow.place(a.x, a.z, a.y, { glide: false, ...ground }); if (!reduced()) arrow.dropIn(); }
      else arrow.place(a.x, a.z, a.y, { glide: true, ...ground });
      arrow.show(!quiet);
      if (t.kind === 'wait') { arrow.setHop(1.25, 0.14); arrow.setSize(0.86); }
      else if (reduced()) { arrow.setHop(1.1, 0.1); arrow.setSize(1); }
      else { arrow.setHop(0.86, 0.26); arrow.setSize(1); }
      arrow.setShadow(t.kind !== 'gather');
    } else arrow.show(false);
    arrow.update(dt);

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
      tp = t.lift ? toScreen(t.lift.x, t.lift.y + 0.45, t.lift.z) : toScreen(t.x, t.tipY + 0.45, t.z);
      const m = 14;
      off = tp.behind || tp.x < m || tp.x > W - m || tp.y < st.safe.top + m || tp.y > H - st.safe.bottom - m;
      if (off) from = toScreen(p.x, 0.5, p.z);
    }
    edge.update(dt, { want: off, from, to: tp, item: t?.item || null, safe: st.safe, avoid: st.avoid, W, H });

    // ---- first-time hints ----
    if (active) {
      const g = st.goal;
      if (t.kind === 'gather' && t.item === 'wood' && arrow.shownFor > 0.35) hints.want('trees');
      else if (t.kind === 'pay') {
        if (String(g?.padId).startsWith('hire:')) hints.want('workers');
        else hints.want('pad');
      } else if (t.kind === 'drop' && Math.hypot(p.x - t.x, p.z - t.z) < 3.2) {
        const noun = ITEM_NOUN[t.item] || 'it';
        hints.want('drop', { text: `Drop ${noun} here`, icon: t.item });
      } else if (t.kind === 'hunt' && arrow.shownFor > 0.2) hints.want('hunt');
    }
    // a hint whose moment has passed (the goal moved on) leaves early
    const cur = hints.current;
    if (cur && cur !== 'workers' && HINT_GOAL[cur] !== t?.kind) hints.dismiss(cur);
    st.headY = damp(st.headY, st.targetHead ?? st.headY, 8, dt);
    const anchor = toScreen(p.x, st.headY, p.z);
    hints.update(dt, anchor.behind ? null : anchor, { suppress: !st.enabled || booting });
  }

  function resize(w, h) { W = w; H = h; st.safeT = 0; }

  const api = {
    // the goal being shown (camp.nextGoal() shape), or null
    get goal() { return st.goal; },
    get target() { return st.target; },
    // the trail's polyline [[x, z], ...] from the robot to the end point (null when there is none)
    get path() { return st.poly; },
    setEnabled(on) { st.enabled = !!on; },
    get enabled() { return st.enabled; },
    update,
    resize,
    // test / debug hooks
    state() {
      return {
        goal: st.goal, key: st.key, boot: +st.boot.toFixed(2),
        arrow: { shown: arrow.visible, v: +arrow.value.toFixed(3), x: +arrow.position.x.toFixed(2), y: +arrow.position.y.toFixed(2), z: +arrow.position.z.toFixed(2) },
        trail: { on: st.trailOn, opacity: +trail.opacity.toFixed(3), dots: trail.dots, length: +trail.length.toFixed(2), followT: +st.followT.toFixed(2), idleT: +st.idleT.toFixed(2) },
        edge: { shown: edge.visible, ...edge.position },
        hint: hints.current, hintsSeen: hints.count,
        safe: st.safe,
      };
    },
    skipBoot() { st.boot = 0; },
    resetHints() { hints.reset(); },
    hint: (id, opts) => hints.want(id, opts),
    el: layer,
    dispose() {
      offs.forEach(off => off?.());
      arrow.dispose(); trail.dispose();
      layer.remove();
    },
  };
  return api;
}
