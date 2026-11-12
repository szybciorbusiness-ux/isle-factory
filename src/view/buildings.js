// Buildings view: belts (one instanced, GPU-bent mesh with scrolling chevrons, items riding them), drills, chests,
// workshops, ghost previews, hover highlight and every build / machine reaction animation. Reads the sim, never
// mutates it.
import * as THREE from 'three';
import {
  beltBendGeometry, beltCapGeometry, bendPath, bendOf, laneLength, BELT_TOP, drillParts, DRILL, chestParts, CHEST,
  workshopParts, WORKSHOP, wholeModel, COL,
} from './buildings/models.js';
import { createBeltUniforms, makeBeltMaterial, makeBeltDepthMaterial, CHEVRONS_PER_TILE } from './buildings/beltMaterial.js';

// ---------- tuning (module-local) ----------
const T = {
  dropH: 1.4, dropT: 0.3, beltDropH: 0.6, beltDropT: 0.2,      // placement fall
  landSquash: 0.7, beltLandSquash: 0.62,
  removeGrow: 0.08, removeShrink: 0.2, removeHop: 0.1,         // anticipation (grow + hop) then shrink away
  pressSquash: 0.16,                                            // long-press charge squash at full press
  lidPeek: 0.5, lidWide: 1.05,                                  // chest lid: item about to arrive / hopping in
  hopT: 0.24, hopH: 0.16,                                       // rotate hop
  spawnT: 0.26, spawnArc: 0.16, absorbT: 0.24,                  // belt item hand-offs
  appearT: 0.22, vanishT: 0.16,                                 // items that appear / vanish without a source
  itemSettle: 17, itemYawSettle: 12, itemYawJump: 0.7,          // jump absorption: critically damped rates (1/s)
  itemMaxSlip: 3, itemJoinCarry: 0.7,                           // cap on absorbed velocity (tiles/s); side-load swing
  drillSpin: 12, drillPlungeHz: 1.6, drillPlunge: 0.06,
  hammerHz: 1.9, hammerLift: 0.62, gearSpin: 3.4, puffEvery: 0.45,
  ghostOpacity: 0.7,
  hoverLift: 0.055, beltHoverLift: 0.03,
};
const VALID_TINT = new THREE.Color('#ecffe4'), VALID_EMIS = new THREE.Color('#1b3311');
const BAD_TINT = new THREE.Color('#ff6f66'), BAD_EMIS = new THREE.Color('#7a1d16');
const GLOW_OFF = new THREE.Color(COL.glowOff), GLOW_ON = new THREE.Color(COL.glowOn);
const BUILD_KINDS = new Set(['belt', 'drill', 'chest', 'workshop']);
const Y = new THREE.Vector3(0, 1, 0);
const REMOVE_T = T.removeGrow + T.removeShrink;

export function create(ctx) {
  const { scene, sim, events, config, anim } = ctx;
  const { Spring, Wobble, ease, clamp, lerp, damp, angleDelta, arc } = anim;
  const { DIRS, dirAngle, opposite, BELT, RECIPES } = config;
  const fx = () => ctx.views.fx;
  const itemsView = () => ctx.views.items;

  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const beltUniforms = createBeltUniforms(COL.stripe, COL.belt);
  const beltMat = makeBeltMaterial(beltUniforms, {}, { bend: true });   // world belts (instanced, bent on the GPU)
  const beltStaticMat = makeBeltMaterial(beltUniforms);                  // static models (icons)
  const beltDepthMat = makeBeltDepthMaterial();
  const itemMat = itemsView()?.getMaterial?.() || new THREE.MeshLambertMaterial({ vertexColors: true });

  const views = new Map();     // entity id -> view (alive)
  const beltViews = new Set(); // alive + dying belts
  const dying = new Set();     // non-belt views playing their removal
  const ghosts = new Set();
  let started = false;         // entities placed before the first frame appear settled (scenarios / loads)
  let capsDirty = true;
  let clock = 0, frameDt = 1 / 60;
  let hoverId = null;
  let pressId = null, pressK = 0; // long-press removal charge (setPress)

  // scratch
  const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _q = new THREE.Quaternion();
  const _p = new THREE.Vector3(), _s = new THREE.Vector3(), H = new THREE.Vector3();
  const LP = { x: 0, z: 0, angle: 0 };

  // =====================================================================================
  // Instanced pools
  // =====================================================================================
  // data: name + item size of an optional per-instance float attribute; color: per-instance colour (highlight).
  function pool(geo, material, name, cap0 = 64, { data = null, color = false, depth = null } = {}) {
    const P = { mesh: null, cap: 0, n: 0, attr: null };
    P.grow = need => {
      if (P.mesh && need <= P.cap) return;
      let cap = Math.max(P.cap * 2, cap0, 16);
      while (cap < need) cap *= 2;
      const m = new THREE.InstancedMesh(geo, material, cap);
      m.name = name; m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (depth) m.customDepthMaterial = depth;
      if (data) {
        const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * data.size), data.size);
        a.setUsage(THREE.DynamicDrawUsage);
        if (P.attr) a.array.set(P.attr.array);
        geo.setAttribute(data.name, a); P.attr = a;
      }
      if (color) { // created up front so the program never recompiles when a highlight starts
        m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
        m.instanceColor.setUsage(THREE.DynamicDrawUsage);
        if (P.mesh?.instanceColor) m.instanceColor.array.set(P.mesh.instanceColor.array);
      }
      if (P.mesh) { m.instanceMatrix.array.set(P.mesh.instanceMatrix.array); scene.remove(P.mesh); P.mesh.dispose(); }
      scene.add(m);
      P.mesh = m; P.cap = cap;
    };
    P.begin = () => { P.n = 0; };
    P.push = matrix => { if (P.n >= P.cap) P.grow(P.n + 1); P.mesh.setMatrixAt(P.n, matrix); return P.n++; };
    P.setData = (i, a, b = 0, c = 0, d = 0) => { const s = data.size, arr = P.attr.array; arr[i * s] = a; if (s > 1) arr[i * s + 1] = b; if (s > 2) arr[i * s + 2] = c; if (s > 3) arr[i * s + 3] = d; };
    P.setColor = (i, r, g, b) => { const arr = P.mesh.instanceColor.array; arr[i * 3] = r; arr[i * 3 + 1] = g; arr[i * 3 + 2] = b; };
    P.end = () => {
      if (!P.mesh) return;
      P.mesh.count = P.n; P.mesh.visible = P.n > 0;
      if (P.n) {
        P.mesh.instanceMatrix.needsUpdate = true;
        if (P.attr) P.attr.needsUpdate = true;
        if (color) P.mesh.instanceColor.needsUpdate = true;
      }
    };
    P.grow(cap0);
    return P;
  }
  const beltPool = pool(beltBendGeometry(), beltMat, 'belts', 64, { data: { name: 'beltData', size: 4 }, depth: beltDepthMat });
  const capPool = pool(beltCapGeometry(), mat, 'belts:caps', 64, { color: true });
  const itemPools = new Map();
  const itemPool = type => {
    if (!itemPools.has(type)) {
      const geo = itemsView()?.getGeometry?.(type) || new THREE.BoxGeometry(0.18, 0.18, 0.18).translate(0, 0.09, 0);
      itemPools.set(type, pool(geo, itemMat, `belt-items:${type}`, 64));
    }
    return itemPools.get(type);
  };

  // =====================================================================================
  // Views
  // =====================================================================================
  const localFrom = e => (e.kind === 'belt' ? (((e.from ?? opposite(e.dir)) - e.dir) & 3) : 2);

  function baseView(e, animate) {
    const v = {
      e, id: e.id, kind: e.kind, x: e.x, z: e.z,
      yaw: new Spring(dirAngle(e.dir ?? 0), { stiffness: 230, damping: 19 }),
      sq: new Spring(1, { stiffness: 340, damping: 12 }),
      pulse: new Spring(1, { stiffness: 320, damping: 15 }),
      lift: new Spring(0, { stiffness: 320, damping: 14 }), hl: 0, hoverOn: 0,
      press: new Spring(0, { stiffness: 420, damping: 17 }), pressTint: 0,
      k: 1, y: 0, twist: 0, t: 0, hopT: 1e9,
      phase: animate ? 'drop' : 'idle', seed: (e.id * 0.6180339) % 1,
    };
    if (animate) { v.k = 0.75; v.y = e.kind === 'belt' ? T.beltDropH : T.dropH; }
    return v;
  }

  function addView(e, animate) {
    if (!BUILD_KINDS.has(e.kind) || views.has(e.id)) return;
    const v = baseView(e, animate);
    views.set(e.id, v);
    if (e.kind === 'belt') {
      v.M = new THREE.Matrix4();
      v.capIn = new Spring(0, { stiffness: 260, damping: 15 });
      v.capOut = new Spring(0, { stiffness: 260, damping: 15 });
      // same spring as yaw: when a drag re-points a belt round a corner, yaw and bend move in step and the entry
      // edge stays put while the exit swings round
      v.bend = new Spring(bendOf(localFrom(e)), { stiffness: 230, damping: 19 });
      v.from = e.from;
      v.capsInit = true; v.off = 0; v.offT = 0; v.up = null;
      v.gapP = 0; v.gapN = 0; v.gapPT = 0; v.gapNT = 0; // rail openings for side-loaders (+ / - lateral side)
      beltViews.add(v);
      capsDirty = true;
      return v;
    }
    v.root = new THREE.Group();
    v.root.rotation.order = 'YXZ';
    v.root.name = `building:${e.kind}:${e.id}`;
    v.lean = new Spring(0, { stiffness: 220, damping: 10 });
    v.tilt = new Wobble({ freq: 4.5, decay: 6.5 });
    v.meshes = [];
    const add = (geo, material = mat, pos) => {
      const m = new THREE.Mesh(geo, material);
      m.castShadow = true; m.receiveShadow = true;
      if (pos) m.position.set(...pos);
      v.root.add(m); v.meshes.push(m);
      return m;
    };
    if (e.kind === 'drill') {
      const parts = drillParts(e.deposit || 'copper');
      add(parts.body);
      v.spinner = add(parts.spinner, mat, [0, DRILL.capTop, 0]);
      v.bit = add(parts.bit, mat, [0, DRILL.capBottom - 0.02, 0]);
      v.act = new Spring(e.working === false ? 0 : 1, { stiffness: 26, damping: 10 });
      v.bitKick = new Spring(0, { stiffness: 240, damping: 11 });
      v.spinA = v.seed * 6; v.plungePh = v.seed * 6;
      v.held = itemsView()?.createItemMesh?.(e.output || 'copperOre') || null;
      if (v.held) {
        v.held.position.set(...DRILL.heldAt); v.held.rotation.set(0, 0.6, -0.42); v.held.visible = false;
        v.root.add(v.held);
        v.heldS = new Spring(0, { stiffness: 300, damping: 14 });
      }
    } else if (e.kind === 'chest') {
      const parts = chestParts();
      add(parts.body);
      v.lidMesh = add(parts.lid, mat, CHEST.hinge);
      v.lid = new Spring(0, { stiffness: 210, damping: 9 });
      v.lidHold = 0; v.landT = 0;
    } else if (e.kind === 'workshop') {
      const parts = workshopParts();
      add(parts.body);
      v.hammer = add(parts.hammer, mat, WORKSHOP.pivot);
      v.gear = add(parts.gear, mat, WORKSHOP.gear);
      v.glowMat = new THREE.MeshBasicMaterial({ color: GLOW_OFF.clone() });
      v.glow = add(parts.glow, v.glowMat); v.glow.castShadow = false;
      v.act = new Spring(e.crafting ? 1 : 0, { stiffness: 40, damping: 12 });
      v.ph = v.seed; v.gearA = v.seed * 3; v.puffT = 0.1;
      v.floats = []; v.floatRecipe = undefined;
      syncFloat(v, false);
    }
    scene.add(v.root);
    applyRoot(v);
    return v;
  }

  // Floating recipe-output item above a workshop.
  function syncFloat(v, animate = true) {
    const recipe = v.e.recipe || null;
    if (recipe === v.floatRecipe) return;
    v.floatRecipe = recipe;
    for (const f of v.floats) if (!f.leaving) { f.leaving = true; f.s.target = 0; f.s.velocity += 2; }
    const out = recipe && RECIPES[recipe] && Object.keys(RECIPES[recipe].outputs)[0];
    const mesh = out && itemsView()?.createItemMesh?.(out);
    if (!mesh) return;
    mesh.castShadow = true;
    const f = { mesh, s: new Spring(animate ? 0.3 : 1, { stiffness: 260, damping: 13, target: 1 }), spin: v.seed * 6, leaving: false };
    if (animate) f.s.velocity = 3;
    mesh.position.set(...WORKSHOP.floatAt);
    v.root.add(mesh);
    v.floats.push(f);
  }

  function removeView(e) {
    const v = views.get(e.id);
    if (!v) return;
    views.delete(e.id);
    v.phase = 'remove'; v.t = 0; v.hopT = 1e9; v.kBase = v.k; v.yBase = v.y;
    if (v.kind === 'belt') capsDirty = true;
    else dying.add(v);
  }

  function disposeView(v) {
    if (v.kind === 'belt') {
      beltViews.delete(v);
      // its items shrank away with it: forget them quietly (no vanish puff)
      for (const it of v.e.items || []) { itemState.delete(it.uid); itemAnims.delete(it.uid); }
      return;
    }
    dying.delete(v);
    v.root.removeFromParent();
    v.glowMat?.dispose();
    v.hmat?.dispose();
    for (const f of v.floats || []) f.mesh.removeFromParent();
    v.held?.removeFromParent();
  }

  // ---------- shared transform animation (drop / squash / remove / rotate hop / hover) ----------
  function animateCommon(v, dt) {
    v.t += dt;
    v.yaw.update(dt); v.sq.update(dt); v.pulse.update(dt);
    // hover: a warm brighten (eased) plus a tiny springy lift and boop
    const on = v.id === hoverId && v.phase !== 'remove' ? 1 : 0;
    if (on && !v.hoverOn) v.sq.velocity += 0.7;
    v.hoverOn = on;
    v.lift.target = on; v.lift.update(dt);
    v.hl = damp(v.hl, on, on ? 16 : 9, dt);
    // long-press charge (setPress): squash down + rose tint while held; letting go (or the removal starting)
    // springs it back up past rest, which doubles as the removal's anticipation pop
    const pk = v.id === pressId && v.phase !== 'remove' ? pressK : 0;
    v.press.target = pk; v.press.update(dt);
    v.pressTint = damp(v.pressTint, pk, pk > v.pressTint ? 18 : 10, dt);
    if (v.phase === 'drop') {
      const belt = v.kind === 'belt', dur = belt ? T.beltDropT : T.dropT, H0 = belt ? T.beltDropH : T.dropH;
      const u = clamp(v.t / dur);
      v.y = H0 * (1 - ease.quadIn(u));
      v.k = lerp(0.75, 1, ease.cubicOut(u));
      v.sq.value = 1 + 0.16 * ease.quadIn(u); v.sq.velocity = 0; // stretch as it speeds up
      if (u >= 1) {
        v.phase = 'idle'; v.y = 0; v.k = 1;
        v.sq.value = belt ? T.beltLandSquash : T.landSquash; v.sq.velocity = 0;
        land(v);
      }
    } else if (v.phase === 'remove') {
      const g = T.removeGrow, s = T.removeShrink, hop = v.kind === 'belt' ? 0.04 : T.removeHop;
      // starts from wherever it was (it may be removed mid-drop or mid-hop): nothing jumps. A quick grow and a
      // little hop up (picked up), then it shrinks away with a twist into a dust ring.
      if (v.t < g) {
        const a = ease.quadOut(v.t / g);
        v.k = v.kBase * (1 + 0.14 * a); v.y = v.yBase + hop * a; v.sq.target = 1.06;
      } else {
        const u = clamp((v.t - g) / s);
        v.k = v.kBase * 1.14 * (1 - ease.cubicIn(u));
        v.y = v.yBase + hop + 0.06 * ease.quadOut(u);
        v.twist = 0.55 * ease.cubicIn(u);
        if (u >= 1) { v.done = true; vanish(v); }
      }
    }
    if (v.hopT < T.hopT) {
      v.hopT += dt;
      const u = clamp(v.hopT / T.hopT);
      v.y = T.hopH * arc(u) * (v.kind === 'belt' ? 0.6 : 1);
      if (u >= 1) { v.y = 0; v.sq.value = 0.86; v.sq.velocity = 0; v.hopT = 1e9; }
    }
  }
  const liftOf = v => Math.max(-0.004, v.lift.value) * (v.kind === 'belt' ? T.beltHoverLift : T.hoverLift);
  function scaleOf(v) {
    const s = Math.max(0, v.k * v.pulse.value), sq = Math.max(0.3, v.sq.value * (1 - T.pressSquash * v.press.value));
    return [s / Math.sqrt(sq), s * sq];
  }
  // tiny nervous shiver while a long-press charges (radians of extra yaw)
  const shiverOf = v => (v.pressTint > 0.25 ? 0.03 * (v.pressTint - 0.25) * Math.sin(clock * 58 + v.seed * 9) : 0);
  function applyRoot(v) {
    const [sxz, sy] = scaleOf(v);
    v.root.position.set(v.x, v.y + liftOf(v), v.z);
    v.root.rotation.set(v.tilt.value * 0.5, v.yaw.value + v.twist + shiverOf(v), v.tilt.value + (v.lean?.value || 0));
    v.root.scale.set(sxz, sy, sxz);
    v.root.updateMatrixWorld(true);
    applyHighlight(v);
  }
  // Highlight colour multipliers: hover = warm brighten, long-press = soft rose (wins while charging).
  const HL_RGB = [0.22, 0.2, 0.14], PRESS_RGB = [0.16, -0.1, -0.1];
  function tintOf(v, out) {
    const p = clamp(v.pressTint), h = v.hl * (1 - p);
    for (let i = 0; i < 3; i++) out[i] = 1 + HL_RGB[i] * h + PRESS_RGB[i] * p;
    return out;
  }
  const _tint = [1, 1, 1];
  // Per-building material (made on first hover / press, never shared), so a highlight never tints other buildings.
  function applyHighlight(v) {
    if (!v.hmat) {
      if (v.hl < 0.002 && v.pressTint < 0.002) return;
      v.hmat = mat.clone();
      v.hmat.name = `building-hover:${v.id}`;
      for (const m of v.meshes) if (m.material === mat) m.material = v.hmat;
    }
    const [r, g, b] = tintOf(v, _tint), h = v.hl * (1 - clamp(v.pressTint));
    v.hmat.color.setRGB(r, g, b);
    v.hmat.emissive.setRGB(0.06 * h + 0.05 * v.pressTint, 0.05 * h + 0.012 * v.pressTint, 0.03 * h + 0.012 * v.pressTint);
  }
  // Bend as drawn: the spring may overshoot a little past a quarter turn, in step with the yaw spring.
  const bendVal = v => clamp(v.bend.value, -1.25, 1.25);
  function beltMatrix(v) {
    let [sxz, sy] = scaleOf(v);
    // belts tile seamlessly: while settling they may bulge (half as much as buildings: they sit in chains) but never
    // shrink and open gaps at the joins
    if (v.phase === 'idle') sxz = 1 + Math.max(0, sxz - 1) * 0.5;
    const a = v.yaw.value + v.twist + shiverOf(v);
    let px = v.x, pz = v.z;
    if (v.pin) {
      // re-pointed round a corner (drag): keep the entry edge where its feeder is while yaw + bend swing the exit
      // round. The shift is exactly 0 at rest (straight or curved), so it fades out by itself. A landing bulge
      // still spreads about the centre (min) so the exit does not lurch forward.
      bendPath(bendVal(v), 0, LP);
      const c = Math.cos(a), s = Math.sin(a), k = Math.min(sxz, 1);
      px += v.pin.x - (LP.x * c + LP.z * s) * k;
      pz += v.pin.z - (-LP.x * s + LP.z * c) * k;
      if (v.yaw.settled && v.bend.settled) v.pin = null;
    } else if (v.slide) {
      px += v.slide.x; pz += v.slide.z;
      const k = Math.exp(-14 * frameDt);
      v.slide.x *= k; v.slide.z *= k;
      if (Math.abs(v.slide.x) + Math.abs(v.slide.z) < 1e-4) v.slide = null;
    }
    _q.setFromAxisAngle(Y, a);
    v.M.compose(_p.set(px, v.y + liftOf(v), pz), _q, _s.set(sxz, sy, sxz));
    return v.M;
  }
  // World position of a local point on a view (buildings: via root; belts: via M).
  function worldOf(v, x, y, z, out = new THREE.Vector3()) {
    out.set(x, y, z);
    if (v.root) return v.root.localToWorld(out);
    return out.applyMatrix4(v.M);
  }

  function land(v) {
    const f = fx();
    const pos = new THREE.Vector3(v.x, 0.03, v.z);
    if (v.kind === 'belt') f?.ring?.(pos, { radius: 0.5, count: 8, size: 0.06, color: '#fff8e8' });
    else {
      f?.ring?.(pos, { radius: 0.72, count: 12, size: 0.09, color: '#fff8e8' });
      f?.puff?.(pos, { count: 4, spread: 0.35, size: 0.1, up: 0.4, color: '#fff8e8' });
    }
  }
  // Removal finished: a soft dust ring where it stood (smaller than the landing one).
  function vanish(v) {
    if (!started) return;
    const f = fx();
    const pos = new THREE.Vector3(v.x, 0.04, v.z);
    if (v.kind === 'belt') f?.ring?.(pos, { radius: 0.36, count: 6, size: 0.05, color: '#fff8e8' });
    else {
      f?.ring?.(pos, { radius: 0.5, count: 9, size: 0.075, color: '#fff8e8' });
      f?.puff?.(new THREE.Vector3(v.x, 0.25, v.z), { count: 3, spread: 0.2, size: 0.08, up: 0.5, color: '#fff8e8' });
    }
  }

  // =====================================================================================
  // Belt caps (rounded bumpers where a run starts / ends) + stripe offsets along chains
  // =====================================================================================
  function computeCaps() {
    capsDirty = false;
    for (const v of beltViews) {
      if (v.phase === 'remove') continue;
      const b = v.e;
      const [dx, dz] = DIRS[b.dir];
      const f = sim.at(b.x + dx, b.z + dz);
      // no bumper where the run continues, or where it hands items to a chest / workshop (items would pass through it)
      const outT = f && ((f.kind === 'belt' && f.dir !== opposite(b.dir)) || f.kind === 'chest' || f.kind === 'workshop') ? 0 : 1;
      const from = b.from ?? opposite(b.dir);
      const [sx, sz] = DIRS[from];
      const s = sim.at(b.x + sx, b.z + sz);
      const pointsHere = s && s.dir != null && s.x + DIRS[s.dir][0] === b.x && s.z + DIRS[s.dir][1] === b.z;
      const feeds = pointsHere && s.kind === 'belt';
      // ... nor where a drill / workshop behind it pushes its output onto the belt
      const inT = pointsHere && (feeds || s.kind === 'drill' || s.kind === 'workshop') ? 0 : 1;
      v.capOut.target = outT; v.capIn.target = inT;
      // side-loaders: a belt on a side (not the one this belt curves in from) pointing into it opens that rail
      v.gapPT = v.gapNT = 0;
      for (const [side, key] of [[(b.dir + 1) & 3, 'gapPT'], [(b.dir + 3) & 3, 'gapNT']]) {
        if (side === from) continue;
        const n = sim.at(b.x + DIRS[side][0], b.z + DIRS[side][1]);
        if (n && n.kind === 'belt' && n.x + DIRS[n.dir][0] === b.x && n.z + DIRS[n.dir][1] === b.z) v[key] = 1;
      }
      v.up = feeds ? views.get(s.id) || null : null;
      if (v.capsInit) { v.capOut.set(outT); v.capIn.set(inT); v.gapP = v.gapPT; v.gapN = v.gapNT; }
    }
    // stripe offsets: distance along the chain from its first belt, modulo the stripe period. Straights are a whole
    // number of periods long, so only curves upstream shift a belt's offset.
    const P = 1 / CHEVRONS_PER_TILE, done = new Set();
    for (const v of beltViews) {
      if (v.phase === 'remove' || done.has(v)) continue;
      const chain = [], seen = new Set();
      let c = v;
      while (c && !done.has(c) && !seen.has(c)) { chain.push(c); seen.add(c); c = c.up; }
      let off = c && done.has(c) ? (c.offT + laneLength(localFrom(c.e))) % P : 0;
      for (let i = chain.length - 1; i >= 0; i--) {
        const b = chain[i];
        b.offT = off; done.add(b);
        if (b.capsInit) { b.off = off; b.capsInit = false; }
        off = (off + laneLength(localFrom(b.e))) % P;
      }
    }
  }

  // =====================================================================================
  // Belt items. Every item is keyed by its uid (stable from drill to chest). Its pose comes straight from the lane
  // (bendPath through the belt's animated matrix); on top of that each item carries a world offset and a yaw offset
  // that soak up any discontinuity (side-load joins turn 90 degrees, rotate / remove pulls items back, respacing).
  // The offsets are critically damped springs that start from the item's drawn momentum, so a jump never snaps,
  // a side-load swings round its corner instead of turning on the spot, and the settle eases in and out.
  // =====================================================================================
  const itemState = new Map(); // uid -> { bid, p, x, y, z, vx, vz, yaw, type, ox, oy, oz, ovx, ovy, ovz, oyaw, oyawV, app, f }
  // One critically damped step of an offset (o, v) toward 0 at rate w (exact for any dt).
  const _cd = [0, 0];
  function critStep(o, v, w, dt) {
    const e = Math.exp(-w * dt), c = v + w * o;
    _cd[0] = (o + c * dt) * e; _cd[1] = (v - w * c * dt) * e;
    return _cd;
  }
  const itemAnims = new Map(); // uid -> { t, dur, from: Vector3, arcH, s0 } (hop out of a drill / workshop)
  const transients = [];       // items hopping into a chest / workshop, or vanishing
  let frameNo = 0;

  // The item a drill / workshop just pushed out gets a hop from its chute onto the belt (or into a building).
  function registerSpawn(src, item, fromLocal, uid, target) {
    const v = views.get(src.id);
    const from = v ? worldOf(v, ...fromLocal) : new THREE.Vector3(src.x, 0.3, src.z);
    if (target && (target.kind === 'chest' || target.kind === 'workshop')) {
      const chest = target.kind === 'chest';
      const to = new THREE.Vector3(lerp(from.x, target.x, 0.7), chest ? 0.36 : 0.34, lerp(from.z, target.z, 0.7));
      transients.push({ type: item, from, to, yaw: v ? v.yaw.value : 0, t: 0, dur: T.absorbT * 1.3, arcH: 0.4, shrinkFrom: 0.5 });
      expectLanding(target, T.absorbT * 1.3);
      return;
    }
    if (uid) itemAnims.set(uid, { t: 0, dur: T.spawnT, from, arcH: T.spawnArc, s0: 0.55 });
  }
  // A belt item went into a chest / workshop: hop it from where it was drawn last frame into the building.
  function absorb(uid, f) {
    const st = itemState.get(uid);
    itemState.delete(uid); itemAnims.delete(uid);
    if (!st || !started) return;
    const chest = f.kind === 'chest';
    const k = chest ? 0.78 : 0.5;
    const to = new THREE.Vector3(lerp(st.x, f.x, k), chest ? 0.36 : 0.34, lerp(st.z, f.z, k));
    transients.push({ type: st.type, from: new THREE.Vector3(st.x, st.y, st.z), to, yaw: st.yaw, t: 0, dur: chest ? T.absorbT * 1.25 : T.absorbT, arcH: chest ? 0.5 : 0.22, shrinkFrom: chest ? 0.55 : 0.3 });
    expectLanding(f, chest ? T.absorbT * 1.25 : T.absorbT);
  }
  // A chest holds its lid wide open while an item hops in, and thuds (squash + lid shut with a bounce) as it lands.
  function expectLanding(target, dur) {
    const cv = views.get(target.id);
    if (cv?.kind === 'chest' && cv.phase === 'idle') cv.landT = Math.max(cv.landT || 0, dur * 0.82);
  }

  function updateItems(dt) {
    frameNo++;
    for (const P of itemPools.values()) P.begin();
    const maxStep = BELT.speed * dt * 1.6 + 0.012;
    for (const v of beltViews) {
      const items = v.e.items;
      if (!items?.length) continue;
      const b = bendVal(v), len = laneLength(localFrom(v.e)), beltYaw = v.yaw.value + v.twist;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        let st = itemState.get(it.uid);
        const fresh = !st;
        if (fresh) {
          st = {
            bid: v.id, p: it.p, x: 0, y: 0, z: 0, vx: 0, vz: 0, yaw: 0, type: it.type,
            ox: 0, oy: 0, oz: 0, ovx: 0, ovy: 0, ovz: 0, oyaw: 0, oyawV: 0, app: 1, f: 0,
          };
          if (started && !itemAnims.has(it.uid)) st.app = 0; // appeared from nowhere (tests, scenarios): grow in
          itemState.set(it.uid, st);
        }
        bendPath(b, it.p, LP);
        _m2.makeTranslation(LP.x, BELT_TOP, LP.z);
        _m.multiplyMatrices(v.M, _m2);
        const nx = _m.elements[12], ny = _m.elements[13], nz = _m.elements[14];
        const nyaw = beltYaw - LP.angle;
        let held = false; // this frame's drawn position is already set by momentum: skip the offset step
        if (!fresh && st.f === frameNo - 1 && dt > 0) {
          // continuity in lane space: anything but a normal glide or a normal hand-off is a jump to soak up
          const sideJoin = st.bid !== v.id && st.p > 1.25 && Math.abs(it.p - 0.5) < 0.25;
          let jump;
          if (st.bid === v.id) { const ds = (it.p - st.p) * len; jump = ds < -0.012 || ds > maxStep; }
          else jump = !(sideJoin || (st.p > 0.9 && st.p <= 1.0001 && it.p < 0.4));
          if (jump || sideJoin) {
            // the drawn item keeps its momentum this frame; the offset carries the difference to the lane (position
            // and velocity) and eases it out, so the item swings onto its new path instead of turning on the spot
            const moving = Math.hypot(st.vx, st.vz) > BELT.speed * 0.3 ? BELT.speed : 0;
            const hx = Math.cos(nyaw) * moving, hz = -Math.sin(nyaw) * moving;
            // a side-load join is the same world point by contract: most of the old momentum carries into the corner
            // (a swing of ~2-3 cm past the centre line) so the turn is rounded, not a hard 90 degree kink
            const k = jump ? 1 : T.itemJoinCarry;
            st.ox = st.x + k * st.vx * dt - nx; st.oz = st.z + k * st.vz * dt - nz;
            if (jump) { st.oy = st.y - ny; st.ovy = 0; }
            st.ovx = k * (st.vx - hx); st.ovz = k * (st.vz - hz);
            held = true;
            const sl = Math.hypot(st.ovx, st.ovz);
            if (sl > T.itemMaxSlip) { st.ovx *= T.itemMaxSlip / sl; st.ovz *= T.itemMaxSlip / sl; }
          }
          const d = angleDelta(st.yaw, nyaw + st.oyaw);
          if (Math.abs(d) > T.itemYawJump) st.oyaw -= d; // side-load join (90 degrees) or a re-pointed belt
        }
        // ease the offsets back to the lane
        if (!held) {
          let r = critStep(st.ox, st.ovx, T.itemSettle, dt); st.ox = r[0]; st.ovx = r[1];
          r = critStep(st.oy, st.ovy, T.itemSettle, dt); st.oy = r[0]; st.ovy = r[1];
          r = critStep(st.oz, st.ovz, T.itemSettle, dt); st.oz = r[0]; st.ovz = r[1];
          if (Math.abs(st.ox) + Math.abs(st.oy) + Math.abs(st.oz) + 0.05 * (Math.abs(st.ovx) + Math.abs(st.ovy) + Math.abs(st.ovz)) < 1e-4) st.ox = st.oy = st.oz = st.ovx = st.ovy = st.ovz = 0;
        }
        { const r = critStep(st.oyaw, st.oyawV, T.itemYawSettle, dt); st.oyaw = r[0]; st.oyawV = r[1]; }
        if (Math.abs(st.oyaw) + 0.05 * Math.abs(st.oyawV) < 1e-4) st.oyaw = st.oyawV = 0;
        _m2.makeRotationY(-LP.angle + st.oyaw).setPosition(LP.x, BELT_TOP, LP.z);
        _m.multiplyMatrices(v.M, _m2);
        _p.set(nx + st.ox, ny + st.oy, nz + st.oz);
        let s = 1;
        if (st.app < 1) { st.app = Math.min(1, st.app + dt / T.appearT); s = lerp(0.6, 1, ease.backOut(st.app, 2.2)); }
        const a = itemAnims.get(it.uid);
        if (a) {
          a.t += dt;
          const u = clamp(a.t / a.dur);
          _p.lerpVectors(a.from, _p, ease.sineInOut(u));
          _p.y += a.arcH * arc(u);
          s *= lerp(a.s0, 1, ease.backOut(u, 2.2));
          if (u >= 1) itemAnims.delete(it.uid);
        }
        if (s !== 1) { _m2.makeScale(s, s, s); _m.multiply(_m2); }
        _m.setPosition(_p);
        itemPool(it.type).push(_m);
        if (!fresh && st.f === frameNo - 1 && dt > 0) { st.vx = (_p.x - st.x) / dt; st.vz = (_p.z - st.z) / dt; }
        else st.vx = st.vz = 0;
        st.bid = v.id; st.p = it.p; st.type = it.type; st.f = frameNo;
        st.x = _p.x; st.y = _p.y; st.z = _p.z; st.yaw = nyaw + st.oyaw;
      }
    }
    // items that left the belts without a chest / workshop taking them: shrink away where they were
    for (const [uid, st] of itemState) {
      if (st.f === frameNo) continue;
      itemState.delete(uid); itemAnims.delete(uid);
      if (started && st.f === frameNo - 1) transients.push({ type: st.type, from: new THREE.Vector3(st.x, st.y, st.z), to: new THREE.Vector3(st.x, st.y, st.z), yaw: st.yaw, t: 0, dur: T.vanishT, arcH: 0.04, shrinkFrom: 0 });
    }
    // transients hopping into buildings / vanishing
    for (let i = transients.length - 1; i >= 0; i--) {
      const tr = transients[i];
      tr.t += dt;
      const u = clamp(tr.t / tr.dur);
      _p.lerpVectors(tr.from, tr.to, ease.sineInOut(u));
      _p.y = lerp(tr.from.y, tr.to.y, u) + tr.arcH * arc(u);
      const s = 1 - 0.9 * ease.cubicIn(clamp((u - tr.shrinkFrom) / (1 - tr.shrinkFrom)));
      _q.setFromAxisAngle(Y, tr.yaw);
      _m.compose(_p, _q, _s.set(s, s, s));
      itemPool(tr.type).push(_m);
      if (u >= 1) transients.splice(i, 1);
    }
    for (const P of itemPools.values()) P.end();
  }

  // =====================================================================================
  // Per-kind updates
  // =====================================================================================
  function hammerCurve(c) {
    if (c < 0.55) return ease.sineInOut(c / 0.55);
    if (c < 0.7) return 1;
    if (c < 0.8) return 1 - ease.quadIn((c - 0.7) / 0.1);
    const u = (c - 0.8) / 0.2;
    return 0.12 * Math.sin(Math.PI * u) * (1 - u);
  }

  function updateDrill(v, dt) {
    const e = v.e;
    v.act.target = v.phase === 'remove' ? 0 : (e.working ? 1 : 0);
    v.act.update(dt); v.bitKick.update(dt); v.lean.update(dt);
    const a = Math.max(0, v.act.value);
    v.spinA += dt * T.drillSpin * a;
    v.plungePh += dt * Math.PI * 2 * T.drillPlungeHz * a;
    v.bit.rotation.y = v.spinA;
    v.spinner.rotation.y = -v.spinA * 0.42;
    const plunge = -T.drillPlunge * (0.5 - 0.5 * Math.cos(v.plungePh)) * Math.min(1, a * 1.5);
    v.bit.position.y = DRILL.capBottom - 0.02 + plunge + v.bitKick.value;
    // working: a soft chug in time with the plunge; blocked / spun down: slow breathing
    const idle = 1 - Math.min(1, a * 2);
    if (v.phase === 'idle') v.sq.target = 1 + 0.018 * Math.sin(v.plungePh) * Math.min(1, a) + 0.012 * Math.sin(clock * 2.4 + v.seed * 6) * idle;
    else v.sq.target = 1;
    // held ore resting in the chute while blocked
    if (v.held) {
      const show = !!e.held && v.phase !== 'remove';
      v.heldS.target = show ? 1 : 0;
      if (show && !v.held.visible) { v.held.visible = true; v.heldS.value = 0.35; v.heldS.velocity = 2; }
      v.heldS.update(dt);
      if (!show && v.heldS.value < 0.05) { v.heldS.set(0); v.held.visible = false; }
      const s = Math.max(0.001, v.heldS.value) * 0.9;
      v.held.scale.set(s, s, s);
    }
  }

  // A belt pointing into this chest has an item about to drop in (and there is room for it).
  const CHEST_CAP = config.BUILDINGS?.chest?.capacity ?? 80;
  function chestIncoming(e) {
    if ((e.total || 0) >= CHEST_CAP) return false;
    for (let d = 0; d < 4; d++) {
      const n = sim.at(e.x + DIRS[d][0], e.z + DIRS[d][1]);
      if (!n || n.kind !== 'belt' || n.x + DIRS[n.dir][0] !== e.x || n.z + DIRS[n.dir][1] !== e.z) continue;
      if (n.items?.[0]?.p > 0.6) return true; // items are sorted front-first
    }
    return false;
  }

  function updateChest(v, dt) {
    // the lid peeks open for an item that is about to arrive, opens wide while it hops in, then shuts with a bounce
    if (v.landT > 0) {
      v.landT -= dt;
      v.lid.target = T.lidWide;
      if (v.landT <= 0) { v.landT = 0; v.sq.velocity -= 1.6; v.lid.target = 0; v.lid.velocity = Math.min(v.lid.velocity, -2); }
    } else if (v.lidHold <= 0) v.lid.target = v.phase === 'idle' && chestIncoming(v.e) ? T.lidPeek : 0;
    v.lid.update(dt);
    if (v.lid.value < 0) { v.lid.value = 0; if (v.lid.velocity < 0) v.lid.velocity *= -0.32; }
    if (v.lidHold > 0) { v.lidHold -= dt; if (v.lidHold <= 0) v.lid.target = 0; }
    v.lidMesh.rotation.z = v.lid.value;
  }

  function updateWorkshop(v, dt) {
    const e = v.e;
    syncFloat(v, true);
    v.act.target = v.phase === 'remove' ? 0 : (e.crafting ? 1 : 0);
    v.act.update(dt); v.lean.update(dt);
    const a = clamp(v.act.value, 0, 1.2);
    const c0 = v.ph % 1;
    v.ph += dt * T.hammerHz * Math.min(1, a * 2.5);
    const c1 = v.ph % 1;
    v.hammer.rotation.z = T.hammerLift * hammerCurve(c1) * Math.min(1, a);
    if (a > 0.3 && ((c0 < 0.8 && c1 >= 0.8) || (c1 < c0 && c0 < 0.8))) {
      v.sq.velocity -= 1.3 * a; // thump
    }
    v.gearA += dt * T.gearSpin * a;
    v.gear.rotation.y = v.gearA;
    v.glowMat.color.copy(GLOW_OFF).lerp(GLOW_ON, clamp(a));
    if (e.crafting && v.phase === 'idle') {
      v.puffT -= dt;
      if (v.puffT <= 0) {
        v.puffT = T.puffEvery * (0.85 + 0.3 * Math.abs(Math.sin(v.ph * 7.1)));
        fx()?.puff?.(worldOf(v, ...WORKSHOP.chimneyTop), { count: 1, size: 0.085, spread: 0.04, up: 1.1, color: '#f7f3ea' });
      }
    } else v.puffT = 0.12;
    // floating output item
    for (let i = v.floats.length - 1; i >= 0; i--) {
      const f = v.floats[i];
      f.s.update(dt);
      f.spin += dt * 0.9;
      const s = Math.max(0, f.s.value);
      f.mesh.scale.setScalar(Math.max(0.0001, s));
      f.mesh.position.set(WORKSHOP.floatAt[0], WORKSHOP.floatAt[1] + 0.045 * Math.sin(clock * 2.3 + v.seed * 6), WORKSHOP.floatAt[2]);
      f.mesh.rotation.set(0.18 * Math.sin(clock * 1.7 + v.seed), f.spin, 0);
      if (f.leaving && f.s.value < 0.02) { f.mesh.removeFromParent(); v.floats.splice(i, 1); }
    }
  }

  // =====================================================================================
  // Events
  // =====================================================================================
  const on = (type, fn) => events.on(type, p => { try { fn(p); } catch (err) { console.error(`[buildings] ${type}`, err); } });
  on('build:placed', ({ entity }) => { if (entity && !entity.resource) addView(entity, started); capsDirty = true; });
  on('build:removed', ({ entity }) => { if (entity) removeView(entity); capsDirty = true; });
  on('build:rotated', ({ entity }) => {
    const v = entity && views.get(entity.id);
    capsDirty = true;
    if (!v) return;
    v.yaw.target = v.yaw.target + angleDelta(v.yaw.target, dirAngle(entity.dir));
    let spin = true;
    if (v.kind === 'belt') {
      v.bend.target = bendOf(localFrom(entity));
      // same entry side as before (a drag turning a corner re-points the belt): it bends round, no hop
      spin = entity.from !== v.from;
      v.from = entity.from;
      const f = entity.from ?? opposite(entity.dir);
      const pin = !spin && v.phase !== 'remove' ? { x: DIRS[f][0] * 0.5, z: DIRS[f][1] * 0.5 } : null;
      if (v.pin && !pin) v.slide = { x: v.M.elements[12] - v.x, z: v.M.elements[14] - v.z };
      v.pin = pin;
    }
    if (spin && v.phase === 'idle') v.hopT = 0;
  });
  on('belt:shape', ({ entity }) => {
    const v = entity && views.get(entity.id);
    capsDirty = true;
    if (!v) return;
    v.bend.target = bendOf(localFrom(entity));
    v.from = entity.from;
    if (v.pin) { // a pinned corner swing is interrupted: hand its current shift to a short glide back to centre
      const px = v.M.elements[12] - v.x, pz = v.M.elements[14] - v.z;
      v.pin = null; v.slide = { x: px, z: pz };
    }
    if (v.phase === 'idle') v.pulse.velocity += 0.7;
  });
  on('drill:mined', ({ entity }) => {
    const v = entity && views.get(entity.id);
    if (!v) return;
    v.bitKick.velocity += 1.4;
    const col = entity.deposit === 'stone' ? '#f3ead2' : '#f6c39a';
    fx()?.puff?.(worldOf(v, ...DRILL.hole), { count: 3, size: 0.07, spread: 0.12, up: 0.5, color: col });
  });
  on('drill:output', ({ entity, item, uid, target }) => {
    const v = entity && views.get(entity.id);
    if (v) { v.lean.velocity += 1.2; v.sq.velocity -= 1.2; }
    if (entity) registerSpawn(entity, item, DRILL.chuteEnd, uid, target);
  });
  on('chest:received', ({ entity, count, uid }) => {
    if (uid && entity) absorb(uid, entity);
    const v = entity && views.get(entity.id);
    if (!v || v.phase !== 'idle') return;
    if (v.landT > 0) return; // an item is hopping in: the thud comes when it lands
    const big = (count || 1) > 1;
    v.lid.velocity = Math.max(v.lid.velocity, big ? 9 : 6);
    v.sq.velocity -= big ? 2.6 : 1.5;
  });
  on('chest:taken', ({ entity }) => {
    const v = entity && views.get(entity.id);
    if (!v || v.phase !== 'idle') return;
    v.lid.target = 1.9; v.lid.velocity += 4; v.lidHold = 0.42;
    v.sq.velocity += 2.2;
  });
  on('workshop:crafted', ({ entity }) => {
    const v = entity && views.get(entity.id);
    if (!v) return;
    v.sq.value = Math.min(v.sq.value, 0.84); v.sq.velocity = 0;
    v.pulse.velocity += 1.2;
    for (const f of v.floats) if (!f.leaving) f.s.velocity += 5;
    fx()?.sparkle?.(worldOf(v, ...WORKSHOP.floatAt), { count: 5, spread: 0.22, size: 0.06, color: '#fff2b8' });
  });
  on('workshop:received', ({ entity, uid }) => {
    if (uid && entity) absorb(uid, entity);
    const v = entity && views.get(entity.id);
    if (v && v.phase === 'idle') v.tilt.hit(0.05);
  });
  on('workshop:output', ({ entity, item, uid, target }) => {
    const v = entity && views.get(entity.id);
    if (v) v.lean.velocity += 0.8;
    if (entity) registerSpawn(entity, item, WORKSHOP.hatch, uid, target);
  });
  on('workshop:recipe', ({ entity }) => { const v = entity && views.get(entity.id); if (v) { syncFloat(v, started); if (started) v.pulse.velocity += 1; } });

  for (const e of sim.entities.values()) if (!e.resource) addView(e, false);

  // =====================================================================================
  // Ghost previews (createModel) + static models for icons
  // =====================================================================================
  function createModel(kind, { ghost = true } = {}) {
    const geo = wholeModel(kind);
    const object = new THREE.Group();
    object.name = `${ghost ? 'ghost' : 'model'}:${kind}`;
    const inner = new THREE.Group();
    object.add(inner);
    if (!geo) return { object, setValid() {}, dispose() { object.removeFromParent(); } };
    if (!ghost) {
      const m = new THREE.Mesh(geo, kind === 'belt' ? beltStaticMat : mat);
      m.castShadow = true; m.receiveShadow = true;
      inner.add(m);
      return { object, setValid() {}, dispose() { object.removeFromParent(); } };
    }
    // two-pass translucent: depth prepass then colour with LessEqual, so it reads as one solid glassy toy
    const depthMat = new THREE.MeshBasicMaterial({ colorWrite: false, transparent: true, opacity: 0 });
    depthMat.depthWrite = true;
    const colMat = kind === 'belt'
      ? makeBeltMaterial(beltUniforms, { transparent: true, opacity: T.ghostOpacity, depthWrite: false })
      : new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: T.ghostOpacity, depthWrite: false });
    colMat.color.copy(VALID_TINT); colMat.emissive.copy(VALID_EMIS);
    const dm = new THREE.Mesh(geo, depthMat); dm.renderOrder = 40;
    const cm = new THREE.Mesh(geo, colMat); cm.renderOrder = 41;
    inner.add(dm, cm);
    const g = {
      object, inner, colMat, valid: true, t: 0,
      pulse: new Spring(0.85, { stiffness: 300, damping: 14, target: 1 }),
      wob: new Wobble({ freq: 7, decay: 7 }),
      yaw: null, // optional springy facing via setDir
    };
    ghosts.add(g);
    return {
      object,
      setValid(ok) {
        ok = !!ok;
        if (ok === g.valid) return;
        g.valid = ok;
        if (ok) g.pulse.velocity += 1.6; else { g.wob.hit(0.09); g.pulse.velocity -= 0.8; }
      },
      // Optional: spring the ghost's facing instead of snapping object.rotation.y.
      setDir(d) {
        const target = dirAngle(d);
        if (!g.yaw) g.yaw = new Spring(target, { stiffness: 260, damping: 18 });
        else g.yaw.target = g.yaw.target + angleDelta(g.yaw.target, target);
      },
      dispose() {
        ghosts.delete(g);
        object.removeFromParent();
        depthMat.dispose(); colMat.dispose();
      },
    };
  }

  function updateGhosts(dt) {
    const k = 1 - Math.exp(-14 * dt);
    for (const g of ghosts) {
      g.t += dt;
      g.pulse.update(dt);
      const tint = g.valid ? VALID_TINT : BAD_TINT, emis = g.valid ? VALID_EMIS : BAD_EMIS;
      g.colMat.color.lerp(tint, k); g.colMat.emissive.lerp(emis, k);
      const s = g.pulse.value;
      g.inner.scale.set(s, s, s);
      g.inner.position.y = 0.05 + 0.025 * Math.sin(g.t * 3.1);
      g.inner.rotation.z = g.wob.update(dt);
      if (g.yaw) { g.yaw.update(dt); g.inner.rotation.y = g.yaw.value - (g.object.rotation.y || 0); }
    }
  }

  // =====================================================================================
  // Frame
  // =====================================================================================
  const proxies = new Map(); // belt id -> Object3D (meshFor for instanced belts)
  const CAPS = [['capOut', 1, 0], ['capIn', 0, Math.PI]];

  function updateBelts(dt) {
    beltPool.begin(); capPool.begin();
    const P = 1 / CHEVRONS_PER_TILE;
    for (const v of beltViews) {
      animateCommon(v, dt);
      if (v.done) { disposeView(v); continue; }
      v.capIn.update(dt); v.capOut.update(dt); v.bend.update(dt);
      { // glide the stripe offset (wrapping) instead of jumping when an upstream curve appears / goes
        let d = (v.offT - v.off) % P; if (d > P / 2) d -= P; if (d < -P / 2) d += P;
        v.off = (((v.off + d * (1 - Math.exp(-9 * dt))) % P) + P) % P;
      }
      const M = beltMatrix(v);
      const b = bendVal(v);
      // shader highlight: >= 0 warm hover brighten, < 0 long-press rose (see beltMaterial.js)
      const pt = clamp(v.pressTint), hl = pt > 0.002 ? -pt : v.hl;
      v.gapP = damp(v.gapP, v.gapPT, 12, dt); v.gapN = damp(v.gapN, v.gapNT, 12, dt);
      const gaps = Math.round(clamp(v.gapP) * 255) + 256 * Math.round(clamp(v.gapN) * 255);
      beltPool.setData(beltPool.push(M), v.off, b, hl, gaps);
      const [tr, tg, tb] = tintOf(v, _tint);
      for (const [key, p, flip] of CAPS) {
        const c = v[key].value;
        if (c < 0.02) continue;
        bendPath(b, p, LP);
        _q.setFromAxisAngle(Y, -LP.angle + flip);
        _m2.compose(H.set(LP.x, 0, LP.z), _q, _s.set(c, Math.min(c, 1.15), c));
        _m.multiplyMatrices(M, _m2);
        capPool.setColor(capPool.push(_m), tr, tg, tb);
      }
      const px = proxies.get(v.id);
      if (px) { px.position.set(v.x, v.y, v.z); px.rotation.y = v.yaw.value; }
    }
    beltPool.end(); capPool.end();
    for (const [id, px] of proxies) if (!views.has(id)) { px.removeFromParent(); proxies.delete(id); }
  }

  function update(dt) {
    started = true;
    clock += dt; frameDt = dt;
    beltUniforms.uBeltPhase.value = (beltUniforms.uBeltPhase.value + dt * BELT.speed * CHEVRONS_PER_TILE) % 1;
    if (capsDirty) computeCaps();
    updateBelts(dt);
    updateItems(dt);
    // buildings
    for (const set of [views, dying]) {
      for (const v of set.values()) {
        if (v.kind === 'belt') continue;
        animateCommon(v, dt);
        if (v.kind === 'drill') updateDrill(v, dt);
        else if (v.kind === 'chest') updateChest(v, dt);
        else if (v.kind === 'workshop') updateWorkshop(v, dt);
        v.tilt.update(dt);
        applyRoot(v);
        if (v.done) disposeView(v);
      }
    }
    updateGhosts(dt);
  }

  return {
    createModel,
    meshFor(id) {
      const v = views.get(id);
      if (!v) return null;
      if (v.root) return v.root;
      let px = proxies.get(id);
      if (!px) { px = new THREE.Object3D(); px.name = `belt:${id}`; px.position.set(v.x, 0, v.z); scene.add(px); proxies.set(id, px); }
      return px;
    },
    // Soft hover highlight (eases in / out: warm brighten + a tiny springy lift). One building at a time;
    // null clears it. Ids that are not buildings are ignored.
    setHover(id) { hoverId = id ?? null; },
    get hoverId() { return hoverId; },
    // Long-press removal charge: setPress(id, k) with k 0..1 as the ring fills squashes the building down with a
    // soft rose tint and a tiny shiver; setPress(null) (cancelled) lets it spring back. When the removal fires, the
    // release spring is the anticipation pop of the removal animation. One building at a time.
    setPress(id, k = 1) { pressId = id ?? null; pressK = pressId == null ? 0 : clamp(Number(k) || 0); },
    // Seconds until a building being removed on tile (x, z) has finished shrinking away (0 when none is).
    // Also right when sim.remove() fires inventory:changed, before build:removed reaches this view.
    flightDelay(x, z) {
      let best = 0;
      for (const set of [beltViews, dying]) for (const v of set) if (v.phase === 'remove' && v.x === x && v.z === z) best = Math.max(best, REMOVE_T - v.t);
      for (const v of views.values()) if (v.x === x && v.z === z && sim.entities.get(v.id) !== v.e) best = Math.max(best, REMOVE_T);
      return Math.max(0, best);
    },
    // Small squash "boop" for a building (e.g. when its panel opens).
    poke(id, amount = 1) { const v = views.get(id); if (v) v.sq.velocity -= 2.4 * amount; },
    // Top-centre world point of a building (for UI anchors / fx).
    topOf(id) {
      const v = views.get(id);
      if (!v) return null;
      const h = v.kind === 'belt' ? 0.15 : v.kind === 'chest' ? 0.6 : v.kind === 'drill' ? 1.0 : 1.05;
      return new THREE.Vector3(v.x, h + v.y + liftOf(v), v.z);
    },
    get beltPhase() { return beltUniforms.uBeltPhase.value; },
    // Test / debug: render state of one belt (stripe offset, bend, yaw, hover) and one belt item (drawn pose).
    debugBelt(id) {
      const v = views.get(id) || [...beltViews].find(b => b.id === id);
      return v && v.kind === 'belt' ? { off: v.off, offT: v.offT, bend: v.bend.value, bendT: v.bend.target, yaw: v.yaw.value, hl: v.hl, press: v.press.value, lift: liftOf(v), phase: v.phase, gaps: [v.gapP, v.gapN], pinned: !!v.pin, M: [...v.M.elements] } : null;
    },
    debugItem(uid) { const st = itemState.get(uid); return st ? { ...st } : null; },
    // Test / debug: live counts, to check nothing is orphaned.
    stats() {
      let roots = 0;
      scene.traverse(o => { if (o.name?.startsWith?.('building:')) roots++; });
      return {
        views: views.size, belts: beltViews.size, dying: dying.size, roots, ghosts: ghosts.size, proxies: proxies.size,
        beltInstances: beltPool.n, capInstances: capPool.n, itemStates: itemState.size, itemAnims: itemAnims.size,
        transients: transients.length, itemInstances: [...itemPools.values()].reduce((a, P) => a + P.n, 0),
      };
    },
    update,
  };
}
