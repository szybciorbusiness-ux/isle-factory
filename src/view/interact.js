// All world input on the canvas.
//
// Mouse: hover raycast + a gliding tile highlight; click a tree / rock / stump / bare deposit and the robot walks up
// to it and keeps swinging until it is gone (deposits: keep mining while the button is held, one hit per click);
// holding moves on to the next hovered resource; a movement key or another click cancels. Click a chest or
// workshop to open it (walks closer first when farther than PLAYER.useReach); click open ground to walk there.
// Building: the ghost tracks the cursor tile, place on mousedown, drag to paint belts with auto-corners,
// right-click (drag) removes, R / Shift+R rotates, Q pipettes. Space / E: chop or mine the best target in reach
// (the one in front wins), hold to keep going; with nothing to hit, open the chest / workshop being faced.
//
// Touch (DESIGN.md 3b): tap = left click, long-press (0.45 s) on a building removes it (progress ring), one-finger
// drag with belts selected paints belts, two-finger pinch zooms, the ghost sits on the last touched tile.
// Touches that start on UI or on the touch controls never reach the canvas, so they are ignored here.
//
// The UI owns Escape, 1-4, C and Tab; this module never handles those.
//
// Camp mode (ctx.camp): the robot gathers on its own, so there is no build ghost, no tile highlight, no hover
// targets and no click-to-chop. A left click on the ground walks there (holding the button and moving the mouse
// keeps re-aiming); a click on a tree / rock walks up next to it. Wheel / pinch zoom still work.
import * as THREE from 'three';
import { findPath } from './player/path.js';

// pick volumes per entity kind: [half width, height] — lets you hover a tree by its crown, not just its tile
const PICK = { tree: [0.36, 1.5], rock: [0.4, 0.9], stump: [0.3, 0.34], belt: [0.48, 0.14], drill: [0.44, 1.0], chest: [0.42, 0.72], workshop: [0.46, 1.1] };
const HL_COLOR = { idle: new THREE.Color('#ffffff'), ok: new THREE.Color('#b9f78e'), bad: new THREE.Color('#ff8c7a') };
const COOLDOWN = { deposit: 0.08, depleted: 0.3 };
const REACH_SLACK = 0.2;    // acting distance tolerance beyond config reach (the robot stops a little short)
const ARRIVE_IN = 0.18;     // walk-to-act stops this much inside the reach
const GHOST_K = 55;         // ghost glide: ~95% in 55 ms
const LONG_PRESS = 0.45, RING_DELAY = 0.1, TAP_SLOP = 12; // touch

const isTyping = e => {
  const t = e.target;
  return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
};
const cardinal = (dx, dz) => (Math.abs(dx) >= Math.abs(dz) ? (dx >= 0 ? 0 : 2) : (dz >= 0 ? 1 : 3));
const tkey = (x, z) => `${x},${z}`;

function roundRect(path, w, r) {
  const h = w / 2;
  path.moveTo(-h + r, -h);
  path.lineTo(h - r, -h); path.quadraticCurveTo(h, -h, h, -h + r);
  path.lineTo(h, h - r); path.quadraticCurveTo(h, h, h - r, h);
  path.lineTo(-h + r, h); path.quadraticCurveTo(-h, h, -h, h - r);
  path.lineTo(-h, -h + r); path.quadraticCurveTo(-h, -h, -h + r, -h);
  return path;
}
function ringGeometry(outer, inner, r) {
  const s = roundRect(new THREE.Shape(), outer, r);
  s.holes.push(roundRect(new THREE.Path(), inner, Math.max(0.02, r - (outer - inner) / 2)));
  return new THREE.ShapeGeometry(s, 6).rotateX(-Math.PI / 2);
}

export function create(ctx) {
  const { scene, camera, canvas, sim, map, config, anim, events, ui, views } = ctx;
  const { DIRS, PLAYER, ITEMS, BUILDINGS, dirAngle } = config;
  const { Spring, damp, clamp, angleDelta, ease } = anim;
  const REACH = PLAYER.reach ?? 1.5, USE_REACH = PLAYER.useReach ?? 4, BUILD_REACH = PLAYER.buildReach ?? 10;
  const campMode = !!ctx.camp;

  canvas.style.touchAction = 'none';

  // ---------- tile highlight: thin soft-white rounded square that glides and breathes ----------
  const hlMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
  const hlFillMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
  const hl = new THREE.Group();
  const hlRing = new THREE.Mesh(ringGeometry(0.9, 0.83, 0.2), hlMat);
  const hlFill = new THREE.Mesh(new THREE.ShapeGeometry(roundRect(new THREE.Shape(), 0.83, 0.165), 6).rotateX(-Math.PI / 2), hlFillMat);
  hlRing.renderOrder = hlFill.renderOrder = 3;
  hl.add(hlFill, hlRing);
  hl.visible = false;
  scene.add(hl);
  const hlState = { alpha: 0, pulse: new Spring(1, { stiffness: 380, damping: 14 }), color: HL_COLOR.idle.clone() };

  // destination marker for click-to-walk: pops in, fades when the player gets there
  const mkMat = new THREE.MeshBasicMaterial({ color: '#fff7e6', transparent: true, opacity: 0, depthWrite: false });
  const marker = new THREE.Mesh(ringGeometry(0.62, 0.54, 0.16), mkMat);
  marker.renderOrder = 3;
  marker.visible = false;
  scene.add(marker);
  const mk = { t: -1, x: 0, z: 0, scale: new Spring(1, { stiffness: 260, damping: 13 }) };

  // long-press progress ring (touch removal): drawn on top of everything around the building's footprint
  const lpGeo = new THREE.RingGeometry(0.5, 0.6, 48, 1, Math.PI / 2, -Math.PI * 2).rotateX(-Math.PI / 2);
  const lpBgMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  const lpMat = new THREE.MeshBasicMaterial({ color: '#ff8c7a', transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  const lpBg = new THREE.Mesh(lpGeo, lpBgMat), lpRing = new THREE.Mesh(lpGeo.clone(), lpMat);
  lpBg.renderOrder = 60; lpRing.renderOrder = 61;
  const lp = new THREE.Group();
  lp.add(lpBg, lpRing);
  lp.visible = false;
  scene.add(lp);
  const lpState = { alpha: 0, progress: 0, scale: new Spring(1, { stiffness: 320, damping: 14 }) };

  // ---------- pointer / picking ----------
  const pointer = { cx: 0, cy: 0, inside: false, type: 'mouse' };
  const ndc = new THREE.Vector2();
  const raycaster = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3(), tmp = new THREE.Vector3(), box = new THREE.Box3(), pp = new THREE.Vector3();

  let hover = null, hoverKey = '';
  let leftDown = false, rightDown = false;
  let holdHarvest = false;  // the left button (or a finger) went down on something harvestable and is still held
  let drag = null;          // belt painting { last: {x, z}, placed: Map(tile -> id), warned }
  let rdrag = null;         // right-drag removal { last }
  let spaceHeld = false;
  let job = null;           // { kind: 'harvest' | 'open' | 'walk', x, z, id, deposit, walking, hits }
  let cooldown = 0, clock = 0, cursor = '', failKey = '';
  let hoverIds = { prop: null, building: null };
  // touch
  const touches = new Map();  // pointerId -> { x, y }
  let gesture = null;         // one-finger gesture { id, sx, sy, t, tile, moved, cancelled, longDone, startedJob }
  let pinch = null;           // { d0, z0 }
  let touchTile = null;       // last touched tile (the ghost sits there in build mode)
  let touchHoverT = 0;        // keeps the touch highlight a moment after the finger lifts

  const playerPos = () => views.player?.getPosition?.(pp) || pp.set(sim.player.x, 0, sim.player.z);
  const playerDist = (x, z) => { const p = playerPos(); return Math.hypot(x - p.x, z - p.z); };
  const selectedKind = () => (!campMode && ui.selected ? ITEMS[ui.selected]?.building || null : null);

  function pickAt(cx, cy, building = !!selectedKind()) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    ndc.set(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1);
    camera.updateMatrixWorld();
    raycaster.setFromCamera(ndc, camera);
    if (!raycaster.ray.intersectPlane(groundPlane, hit)) return null;
    let x = Math.round(hit.x), z = Math.round(hit.z);
    if (!building) {
      // tall things in front (larger z, toward the camera) can cover the ground point: test their volumes
      let best = Infinity, ent = null;
      for (let dz = -1; dz <= 2; dz++) for (let dx = -1; dx <= 1; dx++) {
        const e = sim.at(x + dx, z + dz);
        if (!e) continue;
        const [r, h] = PICK[e.kind] || [0.4, 0.6];
        box.min.set(e.x - r, 0, e.z - r);
        box.max.set(e.x + r, h, e.z + r);
        if (raycaster.ray.intersectBox(box, tmp)) {
          const d = tmp.distanceToSquared(raycaster.ray.origin);
          if (d < best) { best = d; ent = e; }
        }
      }
      if (ent) { x = ent.x; z = ent.z; }
    }
    if (!map.inBounds(x, z)) return null;
    return { x, z };
  }

  const harvestKind = (x, z) => {
    const e = sim.at(x, z);
    if (e) return e.resource ? 'resource' : null;
    return map.depositAt(x, z) ? 'deposit' : null;
  };
  const usable = e => !!e && (e.kind === 'chest' || e.kind === 'workshop');

  function describe(p) {
    if (!p) return null;
    const e = sim.at(p.x, p.z);
    const building = !!selectedKind();
    if (!building && !e && !map.isGround(p.x, p.z)) return null; // plain water: nothing to point at
    const d = playerDist(p.x, p.z);
    // inReach = acting right now works without walking
    let reach = REACH + REACH_SLACK;
    if (building || (e && !e.resource && !usable(e))) reach = BUILD_REACH;
    else if (usable(e)) reach = USE_REACH;
    return {
      x: p.x, z: p.z,
      entityId: e ? e.id : null,
      deposit: map.depositAt(p.x, p.z) || 0, // config.DEPOSITS code (1 copper, 2 stone), 0 = none
      inReach: d <= reach + 1e-6,
    };
  }
  function computeHover() {
    if (campMode) return null;
    if (pointer.type === 'touch') {
      if (!touchTile) return null;
      if (!selectedKind() && !gesture && touchHoverT <= 0) return null;
      return describe(touchTile);
    }
    if (!pointer.inside || ui.pointerOverUi) return null;
    return describe(pickAt(pointer.cx, pointer.cy));
  }

  // ---------- acting ----------
  function swingAt(x, z) {
    const player = views.player;
    const e = sim.at(x, z);
    const id = e?.resource ? e.id : null;
    const onImpact = () => {
      if (id != null) {
        const cur = sim.entities.get(id);
        if (!cur) return;
        const p = playerPos();
        const r = sim.hitResource(id, cardinal(cur.x - p.x, cur.z - p.z));
        views.camera?.shake?.(0.03);
        if (r?.depleted) { cooldown = COOLDOWN.depleted; if (cur.kind !== 'tree') views.camera?.shake?.(0.045); }
      } else if (harvestKind(x, z) === 'deposit') {
        if (sim.mineDeposit(x, z)) views.camera?.shake?.(0.022);
        cooldown = COOLDOWN.deposit;
      }
    };
    if (!player?.swing) { onImpact(); return true; }
    const tool = e?.resource && e.kind !== 'rock' ? 'axe' : 'pickaxe';
    let target = id != null ? views.props?.hitPoint?.(id) : null;
    if (!target || !Number.isFinite(target.x)) target = new THREE.Vector3(x, 0.1, z);
    return player.swing(target, onImpact, { tool });
  }

  function showMarker(x, z) {
    mk.t = 0; mk.x = x; mk.z = z;
    mk.scale.set(1.35); mk.scale.target = 1;
    marker.position.set(x, 0.025, z);
  }

  // Walk until within `reach` of tile (x, z), then onArrive(). Returns false when there is no way there.
  function approach(x, z, reach, onArrive, owner) {
    if (playerDist(x, z) <= reach + REACH_SLACK) { onArrive(); return true; }
    const pl = views.player;
    const t = pl?.tile || sim.player;
    const path = findPath(sim, map, t.x, t.z, (tx, tz) => Math.hypot(tx - x, tz - z) <= reach + 1e-6);
    if (!path) { if (failKey !== tkey(x, z)) sim.toast?.('Can\'t reach that', 'info'); failKey = tkey(x, z); return false; }
    if (!pl?.walkPath) { onArrive(); return true; }
    if (owner) owner.walking = true; // before walkPath: it may arrive at once
    pl.walkPath(path.length ? path : [{ x: t.x, z: t.z }], () => { if (job === owner) onArrive(); }, {
      stopWhen: (px, pz) => Math.hypot(px - x, pz - z) <= reach - ARRIVE_IN,
      onFail: () => { if (job === owner) job = null; },
    });
    if (path.length) showMarker(path[path.length - 1].x, path[path.length - 1].z);
    return true;
  }

  function cancelJob() {
    const j = job;
    job = null;
    if (j?.walking) views.player?.cancelPath?.();
  }

  function startHarvest(x, z, held) {
    const kind = harvestKind(x, z);
    if (!kind) return false;
    cancelJob();
    const e = sim.at(x, z);
    const j = { kind: 'harvest', x, z, id: e?.resource ? e.id : null, deposit: kind === 'deposit', held, walking: false, hits: 0 };
    job = j;
    if (!approach(x, z, REACH, () => { j.walking = false; }, j)) { job = null; return false; }
    failKey = '';
    return true;
  }
  function jobTargetAlive(j) {
    if (j.id != null) return sim.entities.has(j.id);
    return harvestKind(j.x, j.z) === 'deposit';
  }
  function runJob(dt) {
    const pl = views.player;
    if (!job) return;
    if (pl?.steering) { cancelJob(); return; }
    if (job.kind !== 'harvest' || job.walking) return;
    const j = job;
    j.held = j.held && (leftDown || (gesture && !gesture.cancelled)) && holdHarvest;
    if (!jobTargetAlive(j) || (j.deposit && !j.held && j.hits >= 1)) {
      job = null; // holding: updateHeld moves on to whatever harvestable is hovered next (a stump counts)
      return;
    }
    if (playerDist(j.x, j.z) > REACH + REACH_SLACK + 0.05) { approach(j.x, j.z, REACH, () => { j.walking = false; }, j); return; }
    if (pl?.busy || cooldown > 0) return;
    if (swingAt(j.x, j.z)) j.hits++;
  }

  function openPanel(e) {
    if (!sim.entities.has(e.id)) return;
    views.player?.faceTile?.(e.x, e.z);
    ui.panel = { type: e.kind, id: e.id };
    events.emit('ui:panel', { panel: ui.panel });
    views.buildings?.poke?.(e.id, 0.7);
  }
  function startOpen(e) {
    cancelJob();
    const j = { kind: 'open', x: e.x, z: e.z, id: e.id, walking: false };
    job = j;
    if (!approach(e.x, e.z, USE_REACH, () => { if (job === j) job = null; openPanel(e); }, j)) job = null;
    else if (!j.walking && job === j) job = null;
  }
  function walkTo(x, z) {
    cancelJob();
    const pl = views.player;
    const t = pl?.tile || sim.player;
    if (t.x === x && t.z === z && playerDist(x, z) < 0.15) return;
    const path = findPath(sim, map, t.x, t.z, (tx, tz) => tx === x && tz === z);
    if (!path) return;
    const j = { kind: 'walk', x, z, walking: true };
    job = j;
    // the BFS starts at the tile under the player; if that is the goal, still walk to its centre
    pl?.walkPath?.(path.length ? path : [{ x, z }], () => { if (job === j) job = null; }, { onFail: () => { if (job === j) job = null; } });
    showMarker(x, z);
  }

  // Space / E: the best harvest target within reach (in front wins), else the chest / workshop being faced.
  function bestHarvest() {
    const p = playerPos();
    const h = views.player?.heading ?? (sim.player.dir * Math.PI) / 2;
    const fx = Math.cos(h), fz = Math.sin(h);
    const R = REACH + REACH_SLACK;
    let best = null, bestScore = Infinity;
    const res = sim.nearestResource?.(p.x, p.z, R, h);
    if (res) {
      const d = Math.hypot(res.x - p.x, res.z - p.z);
      best = { x: res.x, z: res.z }; bestScore = d * (1 - 0.5 * ((res.x - p.x) * fx + (res.z - p.z) * fz) / Math.max(d, 1e-6));
    }
    for (let tz = Math.ceil(p.z - R); tz <= Math.floor(p.z + R); tz++) for (let tx = Math.ceil(p.x - R); tx <= Math.floor(p.x + R); tx++) {
      const k = harvestKind(tx, tz);
      if (!k || (k === 'resource' && sim.nearestResource)) continue;
      const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
      if (d > R) continue;
      const score = d * (1 - (0.5 * (dx * fx + dz * fz)) / Math.max(d, 1e-6));
      if (score < bestScore - 1e-9) { best = { x: tx, z: tz }; bestScore = score; }
    }
    return best;
  }
  function facedUsable() {
    const p = playerPos();
    const h = views.player?.heading ?? (sim.player.dir * Math.PI) / 2;
    const fx = Math.cos(h), fz = Math.sin(h);
    let best = null, bestScore = Infinity;
    for (const set of [sim.chests, sim.workshops]) for (const e of set || []) {
      const dx = e.x - p.x, dz = e.z - p.z, d = Math.hypot(dx, dz);
      if (d > USE_REACH + 1e-6) continue;
      const cos = (dx * fx + dz * fz) / Math.max(d, 1e-6);
      if (cos < 0.35 && d > 1.2) continue; // must be (roughly) in front unless right next to us
      const score = d * (1 - 0.6 * cos);
      if (score < bestScore) { best = e; bestScore = score; }
    }
    return best;
  }
  function actNearest() {
    if (views.player?.busy || cooldown > 0) return true;
    const t = bestHarvest();
    if (t) { swingAt(t.x, t.z); return true; }
    return false;
  }

  function setSelected(item) {
    if (ui.selected === item) return;
    ui.selected = item;
    events.emit('ui:select', { selected: item });
  }

  function tryPlace(x, z, dir, loud) {
    const kind = selectedKind();
    if (!kind) return null;
    if (playerDist(x, z) > BUILD_REACH + 1e-6) { if (loud) sim.toast?.('Too far away', 'warn'); return null; }
    const res = sim.place(kind, x, z, dir);
    if (!res?.ok) { if (loud && res?.reason) sim.toast?.(res.reason, 'warn'); return null; }
    if (kind !== 'belt') views.camera?.shake?.(0.025);
    return res.entity;
  }
  function removeAt(e, loud) {
    if (!e || e.resource) return false;
    if (playerDist(e.x, e.z) > BUILD_REACH + 1e-6) { if (loud) sim.toast?.('Too far away', 'warn'); return false; }
    if (ui.panel?.id === e.id) { ui.panel = null; events.emit('ui:panel', { panel: null }); }
    sim.remove(e.id);
    views.camera?.shake?.(0.02);
    return true;
  }

  // Camp: walk to a ground tile; a blocked tile (tree, rock, station) walks up next to it instead.
  let campHold = null; // { key } while the left button is held (re-aims as the cursor moves)
  function campWalk(t) {
    if (!t) return false;
    if (sim.isWalkable(t.x, t.z)) { walkTo(t.x, t.z); return true; }
    if (!map.isGround?.(t.x, t.z) && !map.isLand?.(t.x, t.z)) return false;
    cancelJob();
    const pl = views.player;
    const from = pl?.tile || sim.player;
    const path = findPath(sim, map, from.x, from.z, (tx, tz) => Math.hypot(tx - t.x, tz - t.z) <= 1.5);
    if (!path) return false;
    const j = { kind: 'walk', x: t.x, z: t.z, walking: true };
    job = j;
    pl?.walkPath?.(path.length ? path : [{ x: from.x, z: from.z }], () => { if (job === j) job = null; }, {
      stopWhen: (px, pz) => Math.hypot(px - t.x, pz - t.z) <= 1.05,
      onFail: () => { if (job === j) job = null; },
    });
    if (path.length) showMarker(path[path.length - 1].x, path[path.length - 1].z);
    return true;
  }

  // A primary press (mouse down, or a touch tap / touch-down on a harvestable) on tile t.
  function primaryAt(t, held) {
    if (campMode) { campWalk(t); return; }
    const kind = selectedKind();
    if (kind) {
      if (!t) return;
      const occupiedByBelt = sim.at(t.x, t.z)?.kind === 'belt';
      if (kind === 'belt' && held) drag = { last: { x: t.x, z: t.z }, placed: new Map(), warned: false };
      // starting a belt drag on an existing belt is how you extend a line, so stay quiet about it
      const e = tryPlace(t.x, t.z, ui.buildDir, !(kind === 'belt' && occupiedByBelt));
      if (e) {
        drag?.placed.set(tkey(e.x, e.z), e.id);
        if (ghost) ghost.squash.velocity -= 3.2;
      }
      return;
    }
    if (!t) return;
    const e = sim.at(t.x, t.z);
    if (harvestKind(t.x, t.z)) { holdHarvest = held; startHarvest(t.x, t.z, held); return; }
    if (usable(e)) { startOpen(e); return; }
    if (!e && sim.isWalkable(t.x, t.z)) walkTo(t.x, t.z);
  }

  function rotate(reverse) {
    if (selectedKind()) {
      ui.buildDir = (ui.buildDir + (reverse ? 3 : 1)) & 3;
      if (ghost) ghost.squash.velocity -= 1.6;
      return;
    }
    const e = hover?.entityId != null ? sim.entities.get(hover.entityId) : null;
    if (e && !e.resource && BUILDINGS[e.kind]?.rotatable) sim.rotate(e.id, reverse ? -1 : 1);
  }

  function pipette() {
    const e = hover?.entityId != null ? sim.entities.get(hover.entityId) : null;
    if (e && !e.resource) {
      const item = BUILDINGS[e.kind]?.item;
      if (item && sim.inventory.has(item)) {
        if (BUILDINGS[e.kind].rotatable) ui.buildDir = e.dir;
        setSelected(item);
        return;
      }
      if (item) sim.toast?.(`No ${ITEMS[item].name.toLowerCase()}s in your inventory`, 'info');
    }
    setSelected(null);
  }

  // ---------- mouse ----------
  const onMove = e => {
    if (e.pointerType === 'touch') { onTouchMove(e); return; }
    pointer.cx = e.clientX; pointer.cy = e.clientY; pointer.inside = true; pointer.type = e.pointerType || 'mouse';
  };
  const onLeave = e => { if (e.pointerType !== 'touch') pointer.inside = false; };
  const onDown = e => {
    if (e.pointerType === 'touch') { onTouchDown(e); return; }
    onMove(e);
    if (ui.pointerOverUi) return;
    if (campMode) {
      if (e.button !== 0 || views.player?.booting) return;
      leftDown = true;
      const t = pickAt(e.clientX, e.clientY, true);
      campHold = { key: t ? tkey(t.x, t.z) : '' };
      campWalk(t);
      return;
    }
    hover = computeHover();
    hlState.pulse.velocity -= 2.2;
    if (e.button === 0) { leftDown = true; primaryAt(hover, true); }
    else if (e.button === 2) {
      rightDown = true;
      if (ui.selected) { setSelected(null); return; }
      const ent = hover?.entityId != null ? sim.entities.get(hover.entityId) : null;
      if (ent && !ent.resource && removeAt(ent, true)) rdrag = { last: tkey(ent.x, ent.z) };
      else rdrag = { last: hover ? tkey(hover.x, hover.z) : '' };
    }
  };
  const onUp = e => {
    if (e.pointerType === 'touch') { onTouchUp(e); return; }
    if (e.button === 0) { leftDown = false; holdHarvest = false; drag = null; campHold = null; }
    if (e.button === 2) { rightDown = false; rdrag = null; }
  };
  const onWheel = e => {
    if (ui.pointerOverUi) return;
    e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    views.camera?.zoom?.(e.deltaY * k);
  };

  // ---------- touch ----------
  function onTouchDown(e) {
    if (e.target !== canvas) return;
    pointer.type = 'touch';
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { canvas.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    if (touches.size === 1) {
      const t = pickAt(e.clientX, e.clientY);
      gesture = { id: e.pointerId, sx: e.clientX, sy: e.clientY, t: 0, tile: t, moved: false, cancelled: false, longDone: false, startedJob: false };
      if (t) touchTile = t;
      touchHoverT = 0.5;
      hlState.pulse.velocity -= 2.2;
      // a finger down on a resource starts chopping at once (and keeps mining while held)
      if (!campMode && !selectedKind() && t && harvestKind(t.x, t.z)) { holdHarvest = true; startHarvest(t.x, t.z, true); gesture.startedJob = true; }
    } else if (touches.size === 2) {
      // a second finger: this is a pinch, not a tap / paint / hold
      if (gesture) {
        gesture.cancelled = true;
        if (gesture.startedJob) cancelJob();
      }
      holdHarvest = false; drag = null;
      const [a, b] = [...touches.values()];
      pinch = { d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), z0: views.camera?.zoomLevel ?? 1 };
    }
  }
  function onTouchMove(e) {
    const tp = touches.get(e.pointerId);
    if (!tp) return;
    tp.x = e.clientX; tp.y = e.clientY;
    if (pinch && touches.size >= 2) {
      const [a, b] = [...touches.values()];
      const d = Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
      views.camera?.setZoomLevel?.(pinch.z0 * (pinch.d0 / d));
      return;
    }
    const g = gesture;
    if (!g || g.id !== e.pointerId || g.cancelled) return;
    if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > TAP_SLOP) {
      g.moved = true;
      // one-finger drag with belts selected paints belts, starting on the first touched tile
      if (selectedKind() === 'belt' && g.tile) primaryAt(g.tile, true);
    }
    if (g.moved) {
      const t = pickAt(e.clientX, e.clientY);
      if (t) { touchTile = t; touchHoverT = 0.5; }
    }
  }
  function onTouchUp(e) {
    touches.delete(e.pointerId);
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* fine */ }
    if (touches.size < 2) pinch = null;
    const g = gesture;
    if (!g || g.id !== e.pointerId) return;
    gesture = null;
    holdHarvest = false;
    drag = null;
    touchHoverT = 0.45;
    if (g.cancelled || g.longDone || g.moved || g.startedJob) return;
    primaryAt(g.tile, false); // a tap is a left click
  }
  const onCancel = e => {
    if (e.pointerType !== 'touch') return;
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
    if (gesture?.id === e.pointerId) { gesture = null; holdHarvest = false; drag = null; }
  };

  function updateTouch(dt) {
    touchHoverT = Math.max(0, touchHoverT - dt);
    const g = gesture;
    let want = 0, building = null;
    if (g && !campMode && !g.cancelled && !g.moved && !g.longDone && g.tile) {
      g.t += dt;
      const e = sim.at(g.tile.x, g.tile.z);
      if (e && !e.resource) {
        building = e;
        want = clamp((g.t - RING_DELAY) / (LONG_PRESS - RING_DELAY));
        if (g.t >= LONG_PRESS) {
          g.longDone = true;
          if (removeAt(e, true)) { lpState.scale.velocity += 4; views.fx?.ring?.({ x: e.x, y: 0.05, z: e.z }, { radius: 0.55, count: 10, size: 0.08 }); }
          want = 1;
        }
      }
    }
    if (building) { lp.position.set(building.x, 0.06, building.z); lpState.progress = want; }
    else if (g?.longDone) lpState.progress = 1;
    const show = (!!building && g.t > RING_DELAY) || (g?.longDone ?? false);
    lpState.alpha = damp(lpState.alpha, show ? 1 : 0, show ? 18 : 12, dt);
    lpState.scale.update(dt);
    const n = Math.round(clamp(lpState.progress) * 48);
    lpRing.geometry.setDrawRange(0, n * 6);
    lpMat.opacity = 0.95 * lpState.alpha;
    lpBgMat.opacity = 0.35 * lpState.alpha;
    lp.scale.setScalar(lpState.scale.value * (0.92 + 0.08 * lpState.alpha));
    lp.visible = lpState.alpha > 0.01;
  }

  // ---------- keys ----------
  const onKeyDown = e => {
    if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (campMode) return;
    if (e.code === 'Space' || e.code === 'KeyE') {
      e.preventDefault();
      if (e.repeat) return;
      spaceHeld = true;
      cancelJob();
      if (!actNearest()) {
        const u = facedUsable();
        if (u) startOpen(u);
      }
    } else if (e.code === 'KeyR') {
      if (!e.repeat) rotate(e.shiftKey);
    } else if (e.code === 'KeyQ') {
      if (!e.repeat) pipette();
    }
  };
  const onKeyUp = e => { if (e.code === 'Space' || e.code === 'KeyE') spaceHeld = false; };
  const onBlur = () => { leftDown = rightDown = spaceHeld = holdHarvest = false; drag = rdrag = null; gesture = null; pinch = null; touches.clear(); };
  const onContext = e => e.preventDefault();

  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerenter', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointercancel', onCancel);
  canvas.addEventListener('contextmenu', onContext);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  addEventListener('pointerup', onUp);
  addEventListener('keydown', onKeyDown);
  addEventListener('keyup', onKeyUp);
  addEventListener('blur', onBlur);

  // ---------- build ghost ----------
  let ghost = null;
  const dying = [];
  function fallbackModel() {
    const mat = new THREE.MeshLambertMaterial({ color: '#ffffff', transparent: true, opacity: 0.55, depthWrite: false });
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, 0.8).translate(0, 0.25, 0), mat);
    return { object: m, setValid(ok) { mat.color.set(ok ? '#bff59a' : '#ff9a8a'); }, dispose() { m.geometry.dispose(); mat.dispose(); } };
  }
  function makeGhost(kind) {
    let model = null;
    try { model = views.buildings?.createModel?.(kind) || null; } catch (err) { console.error('[interact] createModel', err); }
    if (!model?.object) model = fallbackModel();
    const root = new THREE.Group();
    root.add(model.object);
    root.visible = false;
    scene.add(root);
    const dir = BUILDINGS[kind]?.rotatable ? ui.buildDir : 1;
    return {
      kind, model, root, valid: null, shown: false, appear: 0,
      grow: new Spring(0.6, { stiffness: 320, damping: 15, target: 1 }),
      squash: new Spring(1, { stiffness: 360, damping: 13 }),
      yaw: dirAngle(dir), yawVel: 0,
    };
  }
  function killGhost(g) {
    if (!g) return;
    g.dieT = 0;
    g.dieFrom = g.root.scale.x;
    dying.push(g);
  }
  function disposeGhost(g) {
    scene.remove(g.root);
    try { g.model.dispose?.(); } catch (err) { console.error('[interact] ghost dispose', err); }
  }
  const sameKindHovered = kind => !!hover && sim.at(hover.x, hover.z)?.kind === kind;

  function updateGhost(dt) {
    const kind = selectedKind();
    if ((ghost?.kind || null) !== kind) {
      killGhost(ghost);
      ghost = kind ? makeGhost(kind) : null;
    }
    for (let i = dying.length - 1; i >= 0; i--) {
      const g = dying[i];
      g.dieT += dt;
      const k = clamp(g.dieT / 0.16);
      g.root.scale.setScalar(Math.max(0.001, g.dieFrom * (1 - ease.backIn(k, 2.2))));
      if (k >= 1) { disposeGhost(g); dying.splice(i, 1); }
    }
    if (!ghost) return;
    const g = ghost;
    // hidden while painting, and over a building of the same kind (no red ghost on top of what you just placed)
    const show = !!hover && !drag && !sameKindHovered(kind);
    if (show) {
      if (!g.shown) { // appear in place: no glide in from wherever it was last
        g.root.position.set(hover.x, 0, hover.z);
        g.grow.set(0.6); g.grow.target = 1;
        g.appear = 1;
      }
      g.shown = true;
      g.root.position.x = damp(g.root.position.x, hover.x, GHOST_K, dt);
      g.root.position.z = damp(g.root.position.z, hover.z, GHOST_K, dt);
      const valid = hover.inReach && !!sim.canPlace(kind, hover.x, hover.z, ui.buildDir)?.ok && sim.inventory.has(BUILDINGS[kind].item);
      if (valid !== g.valid) g.valid = valid;
      try { g.model.setValid?.(valid); } catch (err) { console.error('[interact] setValid', err); }
    } else {
      g.shown = false;
      g.appear = damp(g.appear, 0, 20, dt);
    }
    g.grow.update(dt);
    g.squash.update(dt);
    // springy rotation toward the build direction
    const want = dirAngle(BUILDINGS[kind]?.rotatable ? ui.buildDir : 1);
    const n = Math.max(1, Math.ceil(dt / (1 / 120))), h = dt / n;
    for (let i = 0; i < n; i++) { g.yawVel += (angleDelta(g.yaw, want) * 340 - g.yawVel * 22) * h; g.yaw += g.yawVel * h; }
    g.root.rotation.y = g.yaw;
    const s = (g.shown ? g.grow.value : g.appear * g.grow.value);
    const sq = clamp(g.squash.value, 0.7, 1.3);
    g.root.scale.set(s / Math.sqrt(sq), s * sq, s / Math.sqrt(sq));
    g.root.position.y = 0.035 + 0.018 * Math.sin(clock * Math.PI * 2 / 1.7); // floats a hair above the ground
    g.root.visible = s > 0.03;
  }

  // ---------- highlight ----------
  function updateHighlight(dt) {
    const show = !!hover && !ui.pointerOverUi;
    if (show) {
      const onBelt = sim.at(hover.x, hover.z)?.kind === 'belt';
      const y = onBelt ? 0.13 : 0.022;
      if (hlState.alpha < 0.02) { // re-appearing: start on the tile, slightly small
        hl.position.set(hover.x, y, hover.z);
        hlState.pulse.set(0.82); hlState.pulse.target = 1;
      }
      hl.position.x = damp(hl.position.x, hover.x, 34, dt);
      hl.position.z = damp(hl.position.z, hover.z, 34, dt);
      hl.position.y = damp(hl.position.y, y, 20, dt);
    }
    hlState.alpha = damp(hlState.alpha, show ? 1 : 0, show ? 16 : 22, dt);
    hlState.pulse.update(dt);

    let want = HL_COLOR.idle;
    const kind = selectedKind();
    if (show && kind && (drag || !sameKindHovered(kind))) want = ghost?.valid || (drag && hover.inReach) ? HL_COLOR.ok : HL_COLOR.bad;
    hlState.color.lerp(want, 1 - Math.exp(-14 * dt));
    hlMat.color.copy(hlState.color);
    hlFillMat.color.copy(hlState.color);

    const breathe = Math.sin(clock * Math.PI * 2 / 1.6);
    const sc = hlState.pulse.value * (1 + 0.022 * breathe);
    hl.scale.set(sc, 1, sc);
    hlMat.opacity = hlState.alpha * (0.66 + 0.12 * breathe);
    hlFillMat.opacity = hlState.alpha * (kind ? 0.16 : 0.09);
    hl.visible = hlState.alpha > 0.01;
  }

  function updateHoverTargets() {
    const e = hover?.entityId != null ? sim.entities.get(hover.entityId) : null;
    const prop = e?.resource ? e.id : null, building = e && !e.resource ? e.id : null;
    if (prop !== hoverIds.prop) {
      hoverIds.prop = prop;
      views.props?.setHover?.(prop);
      if (prop != null && !selectedKind()) views.props?.poke?.(prop, 0.45);
    }
    if (building !== hoverIds.building) { hoverIds.building = building; views.buildings?.setHover?.(building); }
  }

  function updateMarker(dt) {
    if (mk.t < 0) { marker.visible = false; return; }
    mk.t += dt;
    mk.scale.update(dt);
    const p = playerPos();
    const arrived = Math.hypot(p.x - mk.x, p.z - mk.z) < 0.35;
    const life = arrived || !views.player?.moving ? Math.max(mk.t, 1.2) : Math.min(mk.t, 0.9);
    const a = mk.t < 0.12 ? mk.t / 0.12 : 1 - clamp((life - 0.9) / 0.3);
    mkMat.opacity = 0.85 * a;
    marker.scale.setScalar(mk.scale.value * (1 - 0.06 * Math.sin(mk.t * 7)));
    marker.visible = a > 0.01;
    if (a <= 0.01 && mk.t > 0.2) mk.t = -1;
  }

  // ---------- drags & held actions ----------
  function updateDrags() {
    const painting = drag && (leftDown || (gesture && !gesture.cancelled));
    if (painting && hover && selectedKind() === 'belt') {
      let { x: lx, z: lz } = drag.last;
      for (let guard = 0; (lx !== hover.x || lz !== hover.z) && guard < 64; guard++) {
        const ddx = hover.x - lx, ddz = hover.z - lz;
        const d = cardinal(ddx, ddz);
        // auto-corner: the belt we just laid turns to follow the drag
        const prevId = drag.placed.get(tkey(lx, lz));
        const prev = prevId != null ? sim.entities.get(prevId) : null;
        if (prev && prev.dir !== d) sim.rotate(prev.id, (d - prev.dir + 4) & 3);
        lx += DIRS[d][0]; lz += DIRS[d][1];
        ui.buildDir = d;
        if (!sim.inventory.has('belt')) {
          if (!drag.warned) { drag.warned = true; sim.toast?.('No belts left. Craft more', 'warn'); }
          continue;
        }
        const e = tryPlace(lx, lz, d, false);
        if (e) drag.placed.set(tkey(lx, lz), e.id);
      }
      drag.last = { x: lx, z: lz };
    }
    if (rdrag && rightDown && hover && !ui.selected) {
      const k = tkey(hover.x, hover.z);
      if (k !== rdrag.last) {
        rdrag.last = k;
        const e = sim.at(hover.x, hover.z);
        if (e && !e.resource) removeAt(e, false);
      }
    }
  }

  function updateHeld(dt) {
    if (cooldown > 0) cooldown -= dt;
    if (campMode) {
      if (campHold && leftDown && pointer.inside && pointer.type !== 'touch' && !ui.pointerOverUi) {
        const t = pickAt(pointer.cx, pointer.cy, true);
        const k = t ? tkey(t.x, t.z) : '';
        if (k && k !== campHold.key && !views.player?.steering) { campHold.key = k; campWalk(t); }
      }
      return;
    }
    if (job) return;
    const pl = views.player;
    // holding the button: pick up the next hovered resource
    const holding = (leftDown || (gesture && !gesture.cancelled)) && holdHarvest;
    if (holding && !selectedKind() && hover && harvestKind(hover.x, hover.z) && cooldown <= 0 && failKey !== tkey(hover.x, hover.z)) { startHarvest(hover.x, hover.z, true); return; }
    if (spaceHeld && !pl?.busy && cooldown <= 0) actNearest();
  }

  function updateCursor() {
    let c = 'default';
    if (campMode) { if (c !== cursor) { cursor = c; canvas.style.cursor = c; } return; }
    if (hover && !selectedKind() && pointer.type !== 'touch') {
      const e = hover.entityId != null ? sim.entities.get(hover.entityId) : null;
      if (e?.resource || usable(e) || (!e && hover.deposit)) c = 'pointer';
    }
    if (c !== cursor) { cursor = c; canvas.style.cursor = c; }
  }

  function update(dt) {
    if (!(dt > 0)) return;
    clock += dt;
    hover = computeHover();
    const key = hover ? `${hover.x},${hover.z},${hover.entityId},${hover.deposit},${hover.inReach}` : '';
    if (key !== hoverKey) {
      hoverKey = key;
      ui.hover = hover;
      events.emit('ui:hover', { hover });
    } else if (hover) hover = ui.hover; // keep the same object while nothing changed
    updateHoverTargets();
    updateTouch(dt);
    updateDrags();
    runJob(dt);
    updateHeld(dt);
    updateGhost(dt);
    updateHighlight(dt);
    updateMarker(dt);
    updateCursor();
  }

  return {
    update,
    get hover() { return hover; },
    get ghost() { return ghost; },
    get dragging() { return !!drag; }, // painting belts: the hovered tile is usually one we just placed
    get job() { return job ? { kind: job.kind, x: job.x, z: job.z, walking: !!job.walking } : null; },
    get touchTile() { return touchTile; },
    campMode,
    get longPress() { return gesture && !gesture.cancelled ? { t: gesture.t, done: gesture.longDone } : null; },
    buildReach: BUILD_REACH,
    // test helpers: act as if the pointer were over tile (x, z) / clicked it
    pointAt(x, z, y = 0) {
      const v = new THREE.Vector3(x, y, z).project(camera);
      const rect = canvas.getBoundingClientRect();
      pointer.cx = rect.left + (v.x * 0.5 + 0.5) * rect.width;
      pointer.cy = rect.top + (-v.y * 0.5 + 0.5) * rect.height;
      pointer.inside = true;
      pointer.type = 'mouse';
    },
    clickTile(x, z, held = false) { primaryAt({ x, z }, held); },
    cancel() { cancelJob(); },
    dispose() {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerenter', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointercancel', onCancel);
      canvas.removeEventListener('contextmenu', onContext);
      canvas.removeEventListener('wheel', onWheel);
      removeEventListener('pointerup', onUp);
      removeEventListener('keydown', onKeyDown);
      removeEventListener('keyup', onKeyUp);
      removeEventListener('blur', onBlur);
    },
  };
}
