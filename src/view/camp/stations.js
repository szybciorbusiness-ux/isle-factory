// Camp station models (hearth, sawmill, cookfire, workers' hut, quarry, copper drill, smelter) in the island
// toy language: chunky rounded wood, cream stone, copper accents, faceted Lambert. Each model is built once as
// merged vertex-coloured geometry per moving part. Models sit at their footprint centre, ground y = 0,
// +x east, +z south (toward the camera), so the interesting faces look south.
//
// buildRig(id, env) -> rig: { root, height, anchors {out, intake, top}, update(dt, st, env), items(push),
//   onStart / onProduced / onDrop hooks, dispose() }. env carries the shared material, fire system, item pools, fx.
import * as THREE from 'three';
import { Spring, ease, clamp } from '../../util/anim.js';
import { Parts, rbox, puck, gear, jitter, C, boulder, log, beam, gable } from './geo.js';
import { popScale } from './slots.js';
import { DRUMSTICK } from '../items.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const cache = new Map();
const once = (k, fn) => { if (!cache.has(k)) cache.set(k, fn()); return cache.get(k); };

// ---------- shared bits ----------
function chute(p, a, b, w = 0.26, { color = C.wood, wall = C.woodDark, lip = C.copper } = {}) {
  const A = V(...a), B = V(...b);
  const d = B.clone().sub(A), len = d.length();
  const yaw = Math.atan2(-d.z, d.x), pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
  const mid = A.clone().add(B).multiplyScalar(0.5);
  // pitch about z, then yaw about y (the geometry is rotated here; Parts only translates it)
  const add = (geo, col, off) => {
    geo.rotateZ(pitch); geo.rotateY(yaw);
    const o = V(...off).applyAxisAngle(V(0, 0, 1), pitch).applyAxisAngle(V(0, 1, 0), yaw);
    p.add(geo, col, { p: [mid.x + o.x, mid.y + o.y, mid.z + o.z] });
  };
  add(rbox(len, 0.04, w, 0.015), color, [0, 0, 0]);
  for (const s of [-1, 1]) add(rbox(len, 0.08, 0.035, 0.014), wall, [0, 0.03, s * (w / 2 + 0.005)]);
  add(rbox(0.04, 0.05, w + 0.04, 0.015), lip, [len / 2 - 0.01, 0.0, 0]);
}

function flagGeometry() {
  return once('flag', () => {
    const p = new Parts({ ao: false });
    const s = new THREE.Shape();
    const w = 0.15, h = 0.46, notch = 0.1;
    s.moveTo(-w, 0); s.lineTo(w, 0); s.lineTo(w, -h); s.lineTo(0, -h + notch); s.lineTo(-w, -h); s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth: 0.024, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 1 });
    g.translate(0, 0, -0.012);
    p.add(g, C.cloth, { flat: true, faceColor: (cx, cy) => (cy > -0.07 ? C.clothCream : cy < -0.34 ? '#e57a1e' : null) });
    // gold emblem: a little flame in a ring
    p.add(new THREE.TorusGeometry(0.06, 0.012, 5, 14), C.clothGold, { p: [0, -0.2, 0.017] });
    p.add(new THREE.ConeGeometry(0.03, 0.07, 5), C.clothGold, { p: [0, -0.2, 0.019], flat: true });
    // the rod it hangs from
    p.add(new THREE.CylinderGeometry(0.016, 0.016, 0.38, 6), C.woodDark, { p: [0, 0.005, 0], r: [0, 0, Math.PI / 2] });
    for (const sx of [-1, 1]) p.add(new THREE.SphereGeometry(0.025, 6, 4), C.copper, { p: [sx * 0.19, 0.005, 0] });
    return p.merge();
  });
}

// =====================================================================================================
// HEARTH
// =====================================================================================================
// The hearth keeps growing with the camp (FIRST-20): every level a bigger, taller flame and a wider pool of warm
// light; level 4 adds a tall core with a column of sparks and lights the lanterns; level 5 is the bonfire with a
// crown of sparks circling above it.
//   size, stretch (flame height on top of size), active tongues, glow radius, glow strength, embers / s,
//   column sparks / s, crown 0..1
const HEARTH_LV = [
  [1.0, 1.0, 10, 1.3, 0.24, 2, 0, 0],
  [1.0, 1.0, 10, 1.6, 0.3, 4, 0, 0],
  [1.1, 1.22, 10, 2.05, 0.33, 6, 0, 0],
  [1.2, 1.42, 10, 2.5, 0.36, 8, 0, 0],
  [1.3, 1.45, 13, 2.95, 0.4, 9, 22, 0],
  [1.45, 1.55, 21, 3.4, 0.44, 12, 12, 1],
];
// lanterns (level 4): two lantern posts at the front corners, four paper lanterns on a string between the banner
// poles. [x, y, z] of each glowing heart in hearth-local space, and the lamp's scale.
const HEARTH_LANTERNS = [[-0.98, 0.84, 0.5], [0.98, 0.84, 0.5]];
const HEARTH_STRING = { x0: 0.8, y0: 1.47, sag: 0.16, z: -0.8 };
const HEARTH_PAPER = [-0.42, -0.15, 0.15, 0.42].map(x => [x, HEARTH_STRING.y0 - HEARTH_STRING.sag * (1 - (x / HEARTH_STRING.x0) ** 2) - 0.13, HEARTH_STRING.z]);
const HEARTH_LAMPS = [...HEARTH_LANTERNS.map(p => [...p, 0.092, 1.1, '#ffffff']), ...HEARTH_PAPER.map((p, i) => [...p, 0.078, 1.2, i % 2 ? '#ff8f66' : '#ffa24f'])];

// a thin cylinder between two points (ropes, cords, slim posts): a few dozen triangles instead of a rounded box
function rod(p, a, b, r, color, seg = 6) {
  const A = V(...a), B = V(...b);
  const len = A.distanceTo(B), mid = A.clone().add(B).multiplyScalar(0.5);
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1, true);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), B.clone().sub(A).normalize()));
  p.add(g, color, { p: [mid.x, mid.y, mid.z] });
  return p;
}

// a faceted paper-lantern / glowing-orb shape (unit radius): warm cream belly, orange caps
function lampGeometry() {
  return once('lamp', () => {
    const p = new Parts({ ao: false });
    const prof = [[0.001, -1], [0.5, -0.94], [0.86, -0.62], [1, -0.12], [1, 0.12], [0.86, 0.62], [0.5, 0.94], [0.001, 1]].map(([r, y]) => new THREE.Vector2(r, y));
    p.add(new THREE.LatheGeometry(prof, 8), '#fff3c4', { flat: true, faceColor: (cx, cy) => (Math.abs(cy) > 0.7 ? '#ffb24a' : Math.abs(cy) > 0.4 ? '#ffd877' : null) });
    for (const y of [-1, 1]) p.add(new THREE.CylinderGeometry(0.42, 0.42, 0.16, 8), '#e9772e', { p: [0, y * 1.0, 0], flat: true });
    return p.merge();
  });
}

function hearthGeometry() {
  return once('hearth', () => {
    const body = new Parts({ ao: { y0: 0, y1: 0.4, min: 0.8 } });
    body.add(puck(0.97, 0.045, 0.02, 26), C.stoneDark, { p: [0, 0, 0] });
    body.add(puck(0.86, 0.07, 0.03, 26), C.stoneShade, { p: [0, 0.0, 0] });
    // paving joints
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.2;
      body.add(rbox(0.36, 0.008, 0.022, 0.004), C.stoneDark, { p: [Math.cos(a) * 0.7, 0.071, Math.sin(a) * 0.7], r: [0, -a, 0], ao: false });
    }
    // ring of chunky stones
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * Math.PI * 2 + 0.15, r = 0.56 + ((i * 7) % 3) * 0.015;
      boulder(body, [Math.cos(a) * r, 0.12, Math.sin(a) * r], 0.135 + ((i * 5) % 4) * 0.012, { seed: 3 + i * 7, color: i % 3 === 0 ? C.stoneWarm : C.stone, s: [1.05, 0.82, 1.05] });
    }
    // ember bed + coals: their own mesh so they can go from cold ash to glowing (material tint + emissive)
    const coals = new Parts({ ao: false });
    coals.add(puck(0.45, 0.06, 0.025, 18), '#c77a4c', { p: [0, 0.05, 0] });
    const coal = ['#ffb070', '#ffd890', '#f39a5c'];
    for (let i = 0; i < 12; i++) {
      const a = i * 2.39996, r = 0.12 + (i % 4) * 0.075;
      coals.add(jitter(new THREE.DodecahedronGeometry(0.05 + (i % 3) * 0.01, 0), 0.02, 40 + i), coal[i % 3], { p: [Math.cos(a) * r, 0.12, Math.sin(a) * r], flat: true });
    }
    // teepee of logs
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.5;
      log(body, [Math.cos(a) * 0.36, 0.08, Math.sin(a) * 0.36], [Math.cos(a) * 0.07, 0.5, Math.sin(a) * 0.07], 0.05, { color: i % 2 ? C.bark : C.woodDark, seed: 9 + i });
    }

    // level 2: an outer ring of small stones + flowers
    const l2 = new Parts({ ao: { y0: 0, y1: 0.2, min: 0.85 } });
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + 0.1, r = 0.88;
      boulder(l2, [Math.cos(a) * r, 0.05, Math.sin(a) * r], 0.075 + (i % 3) * 0.01, { seed: 70 + i * 3, color: i % 2 ? C.stone : C.stoneWarm, s: [1.1, 0.7, 1.1] });
    }
    for (const [x, z, c] of [[-0.95, 0.35, C.flowerO], [0.94, -0.3, C.flowerW], [0.6, 0.86, C.flowerO], [-0.62, -0.86, C.flowerW]]) {
      l2.add(new THREE.CylinderGeometry(0.008, 0.008, 0.08, 4), C.leaf, { p: [x, 0.04, z] });
      l2.add(new THREE.IcosahedronGeometry(0.03, 0), c, { p: [x, 0.09, z], flat: true, ao: false });
    }

    // level 3: two banner poles at the back
    const l3 = new Parts({ ao: { y0: 0, y1: 0.6, min: 0.85 } });
    for (const sx of [-1, 1]) {
      const x = sx * 0.8, z = -0.8;
      l3.add(rbox(0.16, 0.08, 0.16, 0.03), C.stoneShade, { p: [x, 0.04, z] });
      beam(l3, [x, 0.06, z], [x, 1.5, z], 0.075, C.wood, { r: 0.03 });
      l3.add(new THREE.SphereGeometry(0.055, 10, 7), C.copper, { p: [x, 1.53, z] });
      beam(l3, [x, 1.38, z], [x - sx * 0.27, 1.38, z], 0.045, C.woodDark, { r: 0.018 });
    }

    // level 4: copper brazier ring, two lantern posts at the front corners (their glowing hearts are the lamps
    // mesh) and a string of paper lanterns hung high between the banner poles
    const l4 = new Parts({ ao: { y0: 0, y1: 0.4, min: 0.85 } });
    l4.add(new THREE.TorusGeometry(0.66, 0.04, 6, 36), C.copper, { p: [0, 0.27, 0], r: [Math.PI / 2, 0, 0] });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.26;
      l4.add(new THREE.BoxGeometry(0.05, 0.22, 0.05), C.copperDark, { p: [Math.cos(a) * 0.66, 0.15, Math.sin(a) * 0.66], r: [0, -a, 0] });
    }
    for (const [x, , z] of HEARTH_LANTERNS) {
      rod(l4, [x, 0.0, z], [x, 0.7, z], 0.036, C.woodDark, 6);
      l4.add(rbox(0.21, 0.045, 0.21, 0.018, 1), C.copperDark, { p: [x, 0.72, z] });
      for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) l4.add(new THREE.BoxGeometry(0.026, 0.23, 0.026), C.copper, { p: [x + dx * 0.1, 0.85, z + dz * 0.1], ao: false });
      l4.add(new THREE.ConeGeometry(0.15, 0.08, 4), C.copper, { p: [x, 1.0, z], r: [0, Math.PI / 4, 0], flat: true });
      l4.add(new THREE.SphereGeometry(0.03, 6, 4), C.copperLight, { p: [x, 1.05, z], flat: true, ao: false });
    }
    // the lantern string: a sagging rope from pole top to pole top, a short cord over each paper lantern
    const rope = x => HEARTH_STRING.y0 - HEARTH_STRING.sag * (1 - (x / HEARTH_STRING.x0) ** 2);
    for (let i = 0; i < 10; i++) {
      const xa = -HEARTH_STRING.x0 + (i / 10) * 2 * HEARTH_STRING.x0, xb = -HEARTH_STRING.x0 + ((i + 1) / 10) * 2 * HEARTH_STRING.x0;
      rod(l4, [xa, rope(xa), HEARTH_STRING.z], [xb, rope(xb), HEARTH_STRING.z], 0.009, C.woodDark, 4);
    }
    for (const [x, y, z] of HEARTH_PAPER) rod(l4, [x, rope(x), z], [x, y + 0.07, z], 0.006, C.woodDark, 4);

    // level 5: a copper crown of spikes on the ring + two tall front poles (their banners are instanced flags)
    const l5 = new Parts({ ao: { y0: 0, y1: 0.6, min: 0.85 } });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      l5.add(new THREE.ConeGeometry(0.045, 0.2, 5), i % 2 ? C.copperLight : C.clothGold, { p: [Math.cos(a) * 0.66, 0.38, Math.sin(a) * 0.66], flat: true });
    }
    for (const sx of [-1, 1]) {
      const x = sx * 0.96, z = -0.22;
      l5.add(rbox(0.16, 0.08, 0.16, 0.03), C.stoneShade, { p: [x, 0.04, z] });
      beam(l5, [x, 0.06, z], [x, 1.7, z], 0.075, C.wood, { r: 0.03 });
      l5.add(new THREE.OctahedronGeometry(0.075, 0), C.clothGold, { p: [x, 1.76, z], flat: true });
      beam(l5, [x, 1.58, z], [x - sx * 0.27, 1.58, z], 0.045, C.woodDark, { r: 0.018 });
    }
    // level 1 (the fire is lit): a pair of log seats + a kindling basket, so lighting it changes the scene too
    const l1 = new Parts({ ao: { y0: 0, y1: 0.3, min: 0.85 } });
    for (const [x, z, ry] of [[-0.56, 0.9, 0.12], [0.56, 0.9, -0.12]]) {
      const dx = Math.cos(ry) * 0.2, dz = -Math.sin(ry) * 0.2;
      log(l1, [x - dx, 0.09, z - dz], [x + dx, 0.09, z + dz], 0.085, { color: C.bark, seed: 61 });
    }
    return { body: body.merge(), coals: coals.merge(), decor: [null, l1.merge(), l2.merge(), l3.merge(), l4.merge(), l5.merge()] };
  });
}
// banner attach points per level (x, y, z, level)
const HEARTH_FLAGS = [[-0.66, 1.38, -0.8, 3], [0.66, 1.38, -0.8, 3], [-0.82, 1.58, -0.22, 5], [0.82, 1.58, -0.22, 5]];

function buildHearth(env) {
  const g = hearthGeometry();
  const root = new THREE.Group();
  root.add(env.mesh(g.body));
  // coals: cold ash at level 0, glowing once lit (tint + emissive follow the fire's heat)
  const coalMat = new THREE.MeshLambertMaterial({ vertexColors: true, color: '#8f8580', emissive: '#ff5a1e', emissiveIntensity: 0 });
  const coals = new THREE.Mesh(g.coals, coalMat);
  coals.receiveShadow = true;
  root.add(coals);
  const decor = [];
  for (let lv = 1; lv <= 5; lv++) {
    const m = env.mesh(g.decor[lv]);
    m.visible = false;
    root.add(m);
    decor[lv] = { mesh: m, t: 10, on: false };
  }
  // decor that finished growing is baked into ONE mesh (one draw call however high the camp grows)
  const settled = env.mesh(new THREE.BufferGeometry());
  settled.visible = false;
  root.add(settled);
  const bakes = new Map();
  let settledKey = '';
  // flags: one InstancedMesh for all banners (rigid cloth swinging on its rod)
  const flags = new THREE.InstancedMesh(flagGeometry(), env.material, 4);
  flags.count = 0; flags.castShadow = env.cast; flags.receiveShadow = true; flags.frustumCulled = false;
  root.add(flags);
  const flagState = HEARTH_FLAGS.map(() => ({ t: 10, on: false }));
  // lamps (level 4): the unlit glowing hearts of the lanterns, one InstancedMesh; instance colour = how lit
  const lampMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  const lamps = new THREE.InstancedMesh(lampGeometry(), lampMat, HEARTH_LAMPS.length);
  lamps.count = 0; lamps.frustumCulled = false; lamps.castShadow = false; lamps.receiveShadow = false;
  lamps.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(HEARTH_LAMPS.length * 3).fill(1), 3);
  root.add(lamps);
  const lampState = HEARTH_LAMPS.map(() => ({ t: 10, on: false, litT: 10, lit: false, sway: new Spring(0, { stiffness: 60, damping: 3 }) }));
  // the front lanterns also pool warm light on the grass (ground glows from the fire system)
  const lanternGlows = HEARTH_LANTERNS.map((p, i) => env.fire.add({ preset: 'none', size: 1, heat: 0, glowRadius: 0.62, glowColor: '#ffb24d', glowStrength: 0.26, emberRate: 0, seed: 11 + i }));
  const lanternLocal = HEARTH_LANTERNS.map(([x, , z]) => new THREE.Matrix4().makeTranslation(x, 0, z));
  const UNLIT = new THREE.Color('#9a8270'), LIT = HEARTH_LAMPS.map(l => new THREE.Color(l[5])), _lc = new THREE.Color(), _o = new THREE.Vector3();

  const fire = env.fire.add({ preset: 'hearth', size: 1, heat: 0, active: 10, glowRadius: 1.6, glowColor: '#ffa04d', glowStrength: 0.34, emberRate: 5, seed: 1 });
  const fireLocal = new THREE.Matrix4().makeTranslation(0, 0.1, 0);
  const COLD = new THREE.Color('#8f8580'), WARM = new THREE.Color('#ffffff');
  let level = -1, time = 0, smokeT = 0, whoosh = null;
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();

  // the fire's targets for a level (its springs swell it there)
  function fireFor(lv, animate) {
    const [size, stretch, active, glowR, glowS, embers, column, crown] = HEARTH_LV[clamp(lv, 0, HEARTH_LV.length - 1)];
    fire.heat = lv >= 1 ? 1 : 0;
    fire.size = size; fire.stretch = stretch; fire.active = active;
    fire.glowRadius = glowR; fire.glowStrength = glowS; fire.emberRate = embers; fire.column = column;
    if (crown > 0 && !(fire.crown > 0) && animate) fire.crownT = -0.35;   // the crown assembles just after the whoosh
    fire.crown = crown;
    if (!animate) fire.snap?.();
  }
  function setLevel(lv, animate) {
    for (let k = 1; k <= 5; k++) {
      const d = decor[k];
      const on = lv >= k;
      if (on && !d.on) { d.on = true; d.t = animate ? -(k === lv ? 0.3 : 0.05 * k) : 10; }
      if (!on && d.on) { d.on = false; d.t = animate ? 0 : 10; }
    }
    HEARTH_FLAGS.forEach((f, i) => {
      const st = flagState[i], on = lv >= f[3];
      if (on && !st.on) { st.on = true; st.t = animate ? -(0.6 + i * 0.12) : 10; }
      if (!on && st.on) { st.on = false; st.t = animate ? 0 : 10; }
    });
    // lanterns: grow in with the level-4 decor, then light one after another (posts first, then the string)
    lampState.forEach((st, i) => {
      const on = lv >= 4;
      if (on && !st.on) { st.on = true; st.t = animate ? -0.3 : 10; st.lit = true; st.litT = animate ? -(0.62 + i * 0.13) : 10; }
      if (!on && st.on) { st.on = false; st.t = animate ? 0 : 10; st.lit = false; }
    });
    level = lv;
    // a level-up's fire change waits for the whoosh (levelUp); everything else gets its fire at once
    if (!animate || !whoosh) fireFor(lv, animate);
  }
  setLevel(env.camp.level || 0, false);

  const rig = {
    id: 'hearth', root, height: 1.5,
    anchors: { out: V(0, 0.6, 0), intake: V(0, 0.4, 0.3), top: V(0, 1.6, 0), fire: V(0, 0.1, 0) },
    fire,
    get lit() { return level >= 1; },
    get level() { return level; },
    levelUp(lv) {
      if (lv <= 1) {
        // lighting the cold hearth starts small and whooshes up
        whoosh = null;
        setLevel(lv, true);
        fire.heatNow = 0.05; fire.flare(1.1); env.fire.burst(fire, 18);
        return;
      }
      // anticipation: the flame ducks for a beat, then whooshes up past its new size and settles there, bigger
      whoosh = { t: 0.17, lv };
      fire.boost.kick(-3.2);
      setLevel(lv, true);
    },
    update(dt) {
      time += dt;
      if ((env.camp.level || 0) !== level) setLevel(env.camp.level || 0, true);
      if (whoosh && (whoosh.t -= dt) <= 0) {
        const lv = whoosh.lv;
        whoosh = null;
        fireFor(lv, true);
        fire.flare(0.75 + 0.1 * lv);
        fire.sizeS.velocity += 0.45 + 0.08 * lv;          // overshoot into the new size
        fire.stretchS.velocity += 0.6 + 0.12 * lv;
        fire.glowS.velocity += 3 + 0.8 * lv;               // a pulse of warm light rolls out over the grass
        fire.glowFlash = 1;
        env.fire.burst(fire, 18 + 6 * lv);
        if (lv >= 4) env.fire.burstColumn?.(fire, 14 + 8 * (lv - 3));
      }
      root.updateMatrixWorld();
      fire.base.multiplyMatrices(root.matrixWorld, fireLocal);
      const heat = fire.heatNow;
      const fl = 1 + 0.12 * Math.sin(time * 7.7) + 0.08 * Math.sin(time * 12.9);
      coalMat.color.copy(COLD).lerp(WARM, Math.min(1, heat * 1.2));
      coalMat.emissiveIntensity = heat * (0.28 + 0.03 * Math.max(0, level)) * fl;
      // a cold hearth breathes a thin wisp of smoke, asking to be lit
      if (level < 1) {
        smokeT -= dt;
        if (smokeT <= 0) { smokeT = 1.6; env.fx?.puff?.(env.toWorld(V(0.05, 0.3, 0)), { count: 1, size: 0.09, spread: 0.03, up: 0.5, color: '#ece6dc' }); }
      }
      // level decor grows in: backOut overshoot with a stretch, a dust puff as it lands
      for (let k = 1; k <= 5; k++) {
        const d = decor[k];
        const prev = d.t;
        d.t += dt;
        const s = popScale(d.on, d.t, 0.42, 0.2);
        if (d.on && prev < 0 && d.t >= 0) env.fx?.puff?.(env.toWorld(V(0, 0.05, 0)), { count: 5, size: 0.14, spread: 0.7, up: 0.35 });
        const done = d.on && d.t >= 0.42;
        d.mesh.visible = !done && s > 0.01;
        const stretch = d.on && d.t > 0 && d.t < 0.42 ? 1 + 0.14 * Math.sin((d.t / 0.42) * Math.PI) : 1;
        d.mesh.scale.set(s, s * stretch, s);
      }
      const key = [1, 2, 3, 4, 5].filter(k => decor[k].on && decor[k].t >= 0.42).join(',');
      if (key !== settledKey) {
        settledKey = key;
        if (key && !bakes.has(key)) bakes.set(key, mergeGeometries(key.split(',').map(k => g.decor[Number(k)]), false));
        if (key) settled.geometry = bakes.get(key);
        settled.visible = !!key;
      }
      // flags: grow in, then swing gently on the rod (rotation about x) with a slower twist
      let n = 0;
      HEARTH_FLAGS.forEach(([x, y, z], i) => {
        const st = flagState[i];
        st.t += dt;
        const s = popScale(st.on, st.t, 0.45, 0.2);
        if (s <= 0.01) return;
        const sway = 0.16 * Math.sin(time * 1.9 + i * 1.3) + 0.06 * Math.sin(time * 3.7 + i);
        const flap = st.on && st.t > 0 && st.t < 0.8 ? 0.55 * Math.exp(-st.t * 5) * Math.sin(st.t * 20) : 0;
        _e.set(sway + flap, 0.12 * Math.sin(time * 0.9 + i * 2), 0);
        _m.compose(_p.set(x, y, z), _q.setFromEuler(_e), _s.set(s, s, s));
        flags.setMatrixAt(n++, _m);
      });
      flags.count = n; flags.visible = n > 0;
      if (n) flags.instanceMatrix.needsUpdate = true;
      // lamps: grow in with the decor, then light up one by one (a bright flash, a little hop, the paper ones
      // swing on the string), then a soft candle flicker
      n = 0;
      const nPost = HEARTH_LANTERNS.length;
      HEARTH_LAMPS.forEach(([x, y, z, r, sy], i) => {
        const st = lampState[i];
        st.t += dt;
        const prevLit = st.litT;
        st.litT += dt;
        const s = popScale(st.on, st.t, 0.42, 0.2);
        if (i < nPost) { const lg = lanternGlows[i]; lg.heat = 0; }
        if (s <= 0.01) return;
        if (st.lit && prevLit < 0 && st.litT >= 0) {
          st.sway.kick(i >= nPost ? 2.4 : 0.6);
          env.fx?.sparkle?.(env.toWorld(V(x, y + 0.05, z)), { count: i < nPost ? 5 : 3, spread: 0.16, size: 0.07, color: '#fff1b8' });
        }
        const lk = st.lit ? clamp(st.litT / 0.12) : 0;
        const flashK = st.lit && st.litT > 0 && st.litT < 0.8 ? Math.exp(-st.litT * 5) : 0;
        const flick = 1 + (0.05 * Math.sin(time * 8.3 + i * 1.9) + 0.03 * Math.sin(time * 13.1 + i)) * lk;
        _lc.copy(UNLIT).lerp(LIT[i], lk).multiplyScalar(flick * (1 + flashK * 0.45));
        const pop = 1 + 0.4 * flashK;
        const sw = st.sway.update(dt) + (i >= nPost ? 0.06 * Math.sin(time * 1.7 + i * 1.1) : 0);
        const hang = i >= nPost ? 0.1 : 0;   // paper lanterns swing about their cord's knot
        _q.setFromEuler(_e.set(sw * 0.3, i * 0.7, 0));
        _o.set(0, -hang, 0).applyQuaternion(_q);
        _m.compose(_p.set(x + _o.x, y + hang + _o.y, z + _o.z), _q, _s.set(r * s * pop, r * sy * s * pop, r * s * pop));
        lamps.setMatrixAt(n, _m);
        lamps.setColorAt(n, _lc);
        n++;
        if (i < nPost) {
          const lg = lanternGlows[i];
          lg.heat = lk > 0 ? 1 : 0;
          lg.glowStrength = 0.26 * (1 + flashK * 1.6);
          lg.base.multiplyMatrices(root.matrixWorld, lanternLocal[i]);
        }
      });
      lamps.count = n; lamps.visible = n > 0;
      if (n) { lamps.instanceMatrix.needsUpdate = true; lamps.instanceColor.needsUpdate = true; }
    },
    dispose() { env.fire.remove(fire); lanternGlows.forEach(f => env.fire.remove(f)); coalMat.dispose(); lampMat.dispose(); },
  };
  return rig;
}

// =====================================================================================================
// SAWMILL
// =====================================================================================================
// Layout for a near top-down camera: a small canopy over the back strip (motor + offcuts), the bench with the
// blade across the middle, and the log rack out in the open at the front-right where the wood you drop piles up.
const SAW = { blade: [-0.4, 0.5, 0.38], benchY: 0.505, benchZ: 0.38, benchX0: -0.9, benchX1: 0.24 };
function sawmillGeometry() {
  return once('sawmill', () => {
    const b = new Parts({ ao: { y0: 0, y1: 0.55, min: 0.78 } });
    b.add(rbox(1.86, 0.06, 1.86, 0.03), C.stoneShade, { p: [0, 0.03, 0] });
    for (let i = 0; i < 6; i++) b.add(rbox(1.76, 0.05, 0.285, 0.02), i % 2 ? C.wood : C.woodLight, { p: [0, 0.085, -0.75 + i * 0.3], seed: i + 2, jitter: 0.03 });
    // canopy over the back strip
    for (const sx of [-1, 1]) {
      beam(b, [sx * 0.82, 0.1, -0.86], [sx * 0.82, 1.2, -0.86], 0.1, C.woodDark, { r: 0.035 });
      beam(b, [sx * 0.82, 0.1, -0.36], [sx * 0.82, 1.06, -0.36], 0.1, C.woodDark, { r: 0.035 });
    }
    const th = 0.26, rc = [0, 1.17, -0.6];
    b.add(rbox(1.96, 0.08, 0.78, 0.035), C.roof, { p: rc, r: [th, 0, 0] });
    for (const d of [-0.24, 0.04, 0.32]) {
      const y = rc[1] - d * Math.sin(th) + 0.048 * Math.cos(th), z = rc[2] + d * Math.cos(th) + 0.048 * Math.sin(th);
      b.add(rbox(1.98, 0.022, 0.07, 0.01), d > 0.3 ? C.roofDark : C.roofLight, { p: [0, y, z], r: [th, 0, 0], ao: false });
    }
    b.add(rbox(2.0, 0.07, 0.09, 0.03), C.copper, { p: [0, rc[1] + 0.39 * Math.sin(th) + 0.04, rc[2] - 0.39 * Math.cos(th)], r: [th, 0, 0] });
    // under the canopy: motor + flywheel driving the blade, a stack of offcuts
    b.add(rbox(0.36, 0.3, 0.26, 0.07, 3), C.copper, { p: [-0.4, 0.26, -0.58] });
    b.add(rbox(0.38, 0.04, 0.28, 0.02), C.copperDark, { p: [-0.4, 0.42, -0.58] });
    b.add(puck(0.12, 0.05, 0.015, 14), C.steelDark, { p: [-0.4, 0.29, -0.43], r: [Math.PI / 2, 0, 0] });
    beam(b, [-0.4, 0.29, -0.4], [SAW.blade[0], SAW.blade[1] - 0.08, SAW.benchZ - 0.24], 0.035, C.woodDark, { r: 0.012 });
    for (let i = 0; i < 3; i++) b.add(rbox(0.5, 0.045, 0.13, 0.015), i % 2 ? C.woodLight : C.wood, { p: [0.38, 0.135 + i * 0.05, -0.6 + (i % 2) * 0.04], r: [0, 0.08 * (i - 1), 0] });
    // workbench across the middle
    const bx = (SAW.benchX0 + SAW.benchX1) / 2, bl = SAW.benchX1 - SAW.benchX0;
    b.add(rbox(bl, 0.08, 0.5, 0.03), C.wood, { p: [bx, 0.46, SAW.benchZ] });
    b.add(rbox(bl - 0.08, 0.012, 0.42, 0.006), C.woodLight, { p: [bx, 0.5, SAW.benchZ], ao: false });
    for (const x of [SAW.benchX0 + 0.1, SAW.benchX1 - 0.1]) for (const z of [SAW.benchZ - 0.18, SAW.benchZ + 0.18]) beam(b, [x, 0.1, z], [x, 0.43, z], 0.08, C.woodDark, { r: 0.025 });
    b.add(rbox(bl - 0.08, 0.18, 0.04, 0.015), C.woodDark, { p: [bx, 0.33, SAW.benchZ + 0.245] });
    b.add(rbox(0.55, 0.008, 0.05, 0.004), C.hole, { p: [SAW.blade[0], 0.507, SAW.benchZ], ao: false });
    // blade guard (copper half ring) on a post
    b.add(new THREE.TorusGeometry(0.31, 0.034, 6, 16, Math.PI), C.copper, { p: SAW.blade });
    beam(b, [SAW.blade[0], 0.5, SAW.benchZ - 0.22], [SAW.blade[0], 0.82, SAW.benchZ - 0.04], 0.05, C.copperDark, { r: 0.02 });
    // a fence rail along the back edge of the bench
    b.add(rbox(bl - 0.2, 0.06, 0.04, 0.015), C.copperDark, { p: [bx + 0.05, 0.53, SAW.benchZ - 0.2] });
    // log rack (front-right, in the open): two cradles
    for (const z of [0.3, 0.72]) {
      b.add(rbox(0.6, 0.06, 0.09, 0.02), C.bark, { p: [0.64, 0.14, z] });
      for (const x of [0.33, 0.95]) b.add(rbox(0.06, 0.16, 0.09, 0.02), C.bark, { p: [x, 0.19, z] });
    }
    // output chute at the west end, down onto the line
    chute(b, [-0.88, 0.5, 0.5], [-1.14, 0.17, 0.5], 0.3);
    return { body: b.merge() };
  });
}
function bladeGeometry() {
  return once('blade', () => {
    const p = new Parts({ ao: false });
    p.add(gear(0.255, 0.22, 20, 0.026, { holes: 3, holeR: 0.34 }), C.steel, { flat: true, faceColor: (cx, cy, cz, nx, ny, nz) => (Math.abs(nz) < 0.5 ? C.steelDark : null) });
    p.add(new THREE.CylinderGeometry(0.06, 0.06, 0.06, 12), C.copper, { r: [Math.PI / 2, 0, 0] });
    p.add(new THREE.CylinderGeometry(0.025, 0.025, 0.08, 8), C.copperLight, { r: [Math.PI / 2, 0, 0] });
    return p.merge();
  });
}
// logs lie along z in the rack: 3 + 2 + 1 (a tidy pyramid)
const RACK_SLOTS = [[0.43, 0.17, 0.51], [0.64, 0.17, 0.51], [0.85, 0.17, 0.51], [0.535, 0.355, 0.51], [0.745, 0.355, 0.51], [0.64, 0.54, 0.51]];

function buildSawmill(env) {
  const root = new THREE.Group();
  root.add(env.mesh(sawmillGeometry().body));
  const blade = env.mesh(bladeGeometry());
  blade.position.set(...SAW.blade);
  root.add(blade);
  const omega = new Spring(0, { stiffness: 26, damping: 9 });
  let angle = 0, dust = 0, logT = -1, logFrom = null;
  const rack = env.slots(RACK_SLOTS.length);
  const X0 = SAW.benchX1 - 0.12, X1 = SAW.benchX0 + 0.1;   // the log slides east -> west through the blade
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler();
  return {
    id: 'sawmill', root, height: 1.3,
    anchors: { out: V(SAW.benchX0 + 0.02, 0.52, 0.5), intake: V(0.64, 0.45, 0.51), top: V(0, 1.4, -0.2) },
    onStart(st) {
      // the top log on the rack hops onto the bench
      const k = Math.min(RACK_SLOTS.length, env.inputShown('wood') + 1) - 1;
      logFrom = RACK_SLOTS[Math.max(0, k)];
      rack.kill(k);
      logT = 0;
    },
    update(dt, st) {
      const busy = !!st?.busy;
      omega.target = busy ? 24 : 0;
      angle += omega.update(dt) * dt;
      blade.rotation.z = -angle;
      blade.position.y = SAW.blade[1] + (busy ? 0.004 * Math.sin(angle * 3) : 0);
      rack.set(Math.min(RACK_SLOTS.length, env.inputShown('wood')), dt);
      if (logT >= 0) logT += dt;
      if (busy && omega.value > 8) {
        dust -= dt;
        if (dust <= 0) {
          dust = env.mobile ? 0.2 : 0.11;
          const at = env.toWorld(V(SAW.blade[0] - 0.05, 0.62, SAW.benchZ + 0.06));
          env.fx?.chips?.(at, C.endGrain, { count: 1, size: 0.035, speed: 0.9, up: 1.7, dir: [-0.6, 0.8], life: 0.6 });
        }
      }
    },
    items(push) {
      rack.forEach((i, s) => {
        const [x, y, z] = RACK_SLOTS[i];
        _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(0, Math.PI / 2 + (i % 2 ? 0.05 : -0.04), 0)), _s.set(1.6 * s, 1.25 * s, 1.25 * s));
        push('wood', _m);
      });
      // the log being cut: hop from the rack (turning to lie along the bench), slide through the blade, shrink away
      const st = env.state();
      if (st?.busy || (logT >= 0 && logT < 0.25)) {
        const pr = st?.busy ? st.progress : 1;
        let x = X0 + (X1 - X0) * pr, y = SAW.benchY, z = SAW.benchZ, sc = 1, yaw = 0;
        if (logFrom && logT >= 0 && logT < 0.26) {
          const k = ease.cubicOut(logT / 0.26);
          x = THREE.MathUtils.lerp(logFrom[0], X0, k); z = THREE.MathUtils.lerp(logFrom[2], SAW.benchZ, k);
          y = THREE.MathUtils.lerp(logFrom[1], SAW.benchY, k) + Math.sin(k * Math.PI) * 0.32;
          yaw = (Math.PI / 2) * (1 - k);
        }
        if (pr > 0.84) sc = pr < 0.9 ? 1 + 0.06 * ((pr - 0.84) / 0.06) : 1.06 * (1 - ease.cubicIn((pr - 0.9) / 0.1));
        if (sc > 0.02) {
          _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(0, yaw, 0)), _s.set(1.55 * sc, 1.3 * sc, 1.3 * sc));
          push('wood', _m);
        }
      }
    },
  };
}

// =====================================================================================================
// COOKFIRE
// =====================================================================================================
const COOK = { apex: [0, 1.16, -0.1], hang: [0, 0.88, -0.1], spit: [0, 0.42, 0.42], fire: [0, 0.08, 0.04], basket: [-0.66, 0, -0.56] };
function cookfireGeometry() {
  return once('cookfire', () => {
    const b = new Parts({ ao: { y0: 0, y1: 0.45, min: 0.8 } });
    b.add(puck(0.94, 0.035, 0.015, 24), '#efd593', { p: [0, 0, 0] });
    for (let i = 0; i < 7; i++) {
      const a = i * 0.9 + 0.3, r = 0.75;
      b.add(jitter(new THREE.CylinderGeometry(0.11, 0.12, 0.03, 7), 0.02, 50 + i), C.stoneShade, { p: [Math.cos(a) * r, 0.04, Math.sin(a) * r * 0.95], flat: true, ao: false });
    }
    const [fx, , fz] = COOK.fire;
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + 0.2;
      boulder(b, [fx + Math.cos(a) * 0.36, 0.09, fz + Math.sin(a) * 0.36], 0.105 + (i % 3) * 0.01, { seed: 90 + i * 5, color: i % 2 ? C.stone : C.stoneWarm, s: [1, 0.8, 1] });
    }
    b.add(puck(0.28, 0.05, 0.02, 14), C.emberBed, { p: [fx, 0.03, fz], ao: false });
    for (let i = 0; i < 7; i++) { const a = i * 2.4, r = 0.06 + (i % 3) * 0.06; b.add(jitter(new THREE.DodecahedronGeometry(0.045, 0), 0.018, 70 + i), [C.coal, C.coalHot, C.coalDim][i % 3], { p: [fx + Math.cos(a) * r, 0.085, fz + Math.sin(a) * r], flat: true, ao: false }); }
    for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2 + 0.9; log(b, [fx + Math.cos(a) * 0.3, 0.07, fz + Math.sin(a) * 0.3], [fx + Math.cos(a) * 0.04, 0.26, fz + Math.sin(a) * 0.04], 0.042, { color: C.bark, seed: 20 + i }); }
    // tripod
    for (const foot of [[-0.62, 0.04, 0.14], [0.62, 0.04, 0.14], [0, 0.04, -0.74]]) beam(b, foot, COOK.apex, 0.065, C.woodDark, { r: 0.026 });
    b.add(new THREE.TorusGeometry(0.06, 0.022, 5, 12), C.copper, { p: [COOK.apex[0], COOK.apex[1] - 0.06, COOK.apex[2]], r: [Math.PI / 2, 0, 0], ao: false });
    beam(b, [COOK.apex[0], COOK.apex[1] - 0.05, COOK.apex[2]], COOK.hang, 0.02, C.steelDark, { r: 0.008 });
    // spit: forked posts + bar + crank
    for (const sx of [-1, 1]) {
      const x = sx * 0.56, z = COOK.spit[2];
      beam(b, [x, 0.03, z], [x, 0.36, z], 0.055, C.woodDark, { r: 0.02 });
      beam(b, [x, 0.34, z], [x - 0.06, 0.47, z], 0.035, C.woodDark, { r: 0.014 });
      beam(b, [x, 0.34, z], [x + 0.06, 0.47, z], 0.035, C.woodDark, { r: 0.014 });
    }
    b.add(new THREE.CylinderGeometry(0.018, 0.018, 1.32, 7), C.steelDark, { p: COOK.spit, r: [0, 0, Math.PI / 2] });
    beam(b, [0.66, COOK.spit[1], COOK.spit[2]], [0.66, COOK.spit[1] - 0.1, COOK.spit[2]], 0.025, C.copperDark, { r: 0.01 });
    // output tray on the east side, down onto the line
    chute(b, [0.62, 0.36, 0.5], [1.1, 0.16, 0.5], 0.28);
    // basket for raw meat (input buffer) at the back-west
    const [bx, , bz] = COOK.basket;
    const prof = [[0, 0], [0.17, 0], [0.2, 0.04], [0.22, 0.16], [0.235, 0.2], [0.2, 0.2], [0.19, 0.06], [0, 0.06]].map(([r, y]) => new THREE.Vector2(r, y));
    b.add(new THREE.LatheGeometry(prof, 12), C.woodLight, { p: [bx, 0.02, bz], flat: true, faceColor: (cx, cy) => (Math.floor(cy * 28) % 2 ? C.wood : null) });
    // a small woodpile at the back-east
    for (const [y, z0, z1] of [[0.07, -0.42, -0.78], [0.07, -0.6, -0.96]]) log(b, [0.52, y, z0], [0.86, y, z1], 0.055, { color: C.bark, seed: 33 });
    log(b, [0.6, 0.17, -0.5], [0.86, 0.17, -0.86], 0.05, { color: C.woodDark, seed: 35 });
    return { body: b.merge() };
  });
}
function potGeometry() {
  return once('pot', () => {
    const p = new Parts({ ao: { y0: -0.5, y1: -0.2, min: 0.82 } });
    const prof = [[0, -0.5], [0.11, -0.5], [0.2, -0.46], [0.25, -0.39], [0.255, -0.3], [0.225, -0.235], [0.245, -0.215], [0.245, -0.19], [0.205, -0.19], [0.2, -0.24]].map(([r, y]) => new THREE.Vector2(r, y));
    p.add(new THREE.LatheGeometry(prof, 14), C.copperDark, { flat: true, faceColor: (cx, cy) => (cy > -0.25 ? C.copper : cy < -0.43 ? '#a85f3c' : null) });
    p.add(new THREE.CircleGeometry(0.205, 14), C.stew, { p: [0, -0.235, 0], r: [-Math.PI / 2, 0, 0], ao: false });
    for (let i = 0; i < 4; i++) p.add(new THREE.SphereGeometry(0.028, 6, 4), i % 2 ? '#f2be7c' : '#d98f4c', { p: [Math.cos(i * 1.7) * 0.11, -0.23, Math.sin(i * 1.7) * 0.11], s: [1, 0.5, 1], ao: false });
    p.add(new THREE.TorusGeometry(0.235, 0.012, 5, 18, Math.PI), C.steelDark, { p: [0, -0.2, 0], ao: false });
    for (const sx of [-1, 1]) p.add(new THREE.SphereGeometry(0.03, 6, 4), C.copper, { p: [sx * 0.24, -0.205, 0] });
    return p.merge();
  });
}
function spitMeatGeometry(env) {
  return once('spitMeat', () => {
    const src = env.pools.geometryFor('meat');
    const p = new Parts();
    for (const [x, rx] of [[-0.24, 0.0], [0.0, 2.1], [0.24, 4.2]]) {
      const g = src.clone();
      g.translate(-DRUMSTICK.bulbX, -DRUMSTICK.meatAxisY, 0);   // centre the meaty bulge on the bar
      g.rotateY(Math.PI / 2);             // bone along z (skewered across the bar)
      g.rotateX(rx);
      g.translate(x, 0, 0);
      p.addGeometry(g);
    }
    return p.merge();
  });
}
const BASKET_SLOTS = [[-0.06, 0.08, -0.04, 0.4], [0.07, 0.08, 0.04, 2.2], [-0.02, 0.15, 0.06, 1.2], [0.03, 0.17, -0.06, 3.6]];

function buildCookfire(env) {
  const root = new THREE.Group();
  root.add(env.mesh(cookfireGeometry().body));
  const pot = env.mesh(potGeometry());
  pot.position.set(...COOK.hang);
  root.add(pot);
  const meatMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const meat = new THREE.Mesh(spitMeatGeometry(env), meatMat);
  meat.castShadow = env.cast; meat.receiveShadow = true;
  meat.position.set(...COOK.spit);
  root.add(meat);
  const fire = env.fire.add({ preset: 'camp', size: 1.05, heat: 0.4, glowRadius: 1.0, glowStrength: 0.28, emberRate: 2.5, seed: 2 });
  const fireLocal = new THREE.Matrix4().makeTranslation(...COOK.fire);
  const swing = new Spring(0, { stiffness: 30, damping: 3 });
  // spit meat: on after the hop from the basket lands, off (anticipate + shrink) when the cooked meat leaves
  let meatOn = false, meatT = 10, hopping = false;
  let spin = 0, bubble = 0, time = 0;
  const basket = env.slots(BASKET_SLOTS.length);
  const RAW = new THREE.Color('#ffffff'), DONE = new THREE.Color('#d48a5e');
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler();
  return {
    id: 'cookfire', root, height: 1.25,
    anchors: { out: V(0.66, 0.42, 0.5), intake: V(-0.66, 0.3, -0.56), top: V(0, 1.35, 0) },
    fire,
    onStart(st) {
      const k = Math.min(BASKET_SLOTS.length, env.inputShown('meat') + 1) - 1;
      basket.kill(Math.max(0, k));
      const [bx, , bz] = COOK.basket, [sx, sy, sz] = BASKET_SLOTS[Math.max(0, k)];
      hopping = true;
      env.hop('meat', env.toWorld(V(bx + sx, sy, bz + sz)), env.toWorld(V(0, COOK.spit[1] - 0.05, COOK.spit[2])), {
        dur: 0.28, arc: 0.4, onLand: () => { hopping = false; if (!meatOn) { meatOn = true; meatT = 0; } },
      });
      swing.kick(0.6);
    },
    onProduced() { swing.kick(-0.9); if (meatOn) { meatOn = false; meatT = 0; } },
    update(dt, st) {
      time += dt;
      const busy = !!st?.busy;
      fire.heat = busy ? 1 : (st?.input?.meat ? 0.6 : 0.42);
      root.updateMatrixWorld();
      fire.base.multiplyMatrices(root.matrixWorld, fireLocal);
      basket.set(Math.min(BASKET_SLOTS.length, env.inputShown('meat')), dt);
      // pot: pendulum swing + a little bob while it bubbles
      swing.target = 0;
      const sw = swing.update(dt);
      pot.rotation.z = sw * 0.12 + (busy ? 0.02 * Math.sin(time * 7.3) : 0);
      pot.rotation.x = busy ? 0.015 * Math.sin(time * 5.1) : 0;
      pot.position.y = COOK.hang[1] + (busy ? 0.008 * Math.sin(time * 11) : 0);
      if (busy) {
        bubble -= dt;
        if (bubble <= 0) {
          bubble = env.mobile ? 0.5 : 0.3;
          env.fx?.puff?.(env.toWorld(V(COOK.hang[0] + Math.sin(time * 3) * 0.08, COOK.hang[1] - 0.2, COOK.hang[2] + Math.cos(time * 2) * 0.06)), { count: 1, size: 0.075, spread: 0.06, up: 0.9, color: '#fffaf0' });
        }
      }
      // spit meat: shows while cooking, turns, browns with progress
      if (busy && !meatOn && !hopping) { meatOn = true; meatT = 0; }   // e.g. the view joined mid-cook
      meatT += dt;
      const ms = popScale(meatOn, meatT, 0.32, 0.2);
      meat.visible = ms > 0.01;
      meat.scale.setScalar(Math.max(0.001, ms));
      spin += dt * (busy ? 2.6 : 0.8);
      meat.rotation.x = spin;
      meatMat.color.copy(RAW).lerp(DONE, busy ? ease.quadInOut(st.progress) : 1);
    },
    items(push) {
      const [bx, , bz] = COOK.basket;
      basket.forEach((i, s) => {
        const [x, y, z, ry] = BASKET_SLOTS[i];
        _m.compose(_p.set(bx + x, y, bz + z), _q.setFromEuler(_e.set(0.25, ry, 0.15)), _s.set(0.85 * s, 0.85 * s, 0.85 * s));
        push('meat', _m);
      });
    },
    dispose() { env.fire.remove(fire); meatMat.dispose(); },
  };
}

// =====================================================================================================
// WORKERS' HUT
// =====================================================================================================
const HUT = { door: [0.675, 0.1, -0.58], chimney: [-0.34, 1.72, -0.42] };
function hutGeometry() {
  return once('hut', () => {
    const b = new Parts({ ao: { y0: 0, y1: 0.7, min: 0.78 } });
    const WX = 0.65, WZ = 0.68;   // wall half extents
    b.add(rbox(1.84, 0.1, 1.84, 0.04), C.stoneShade, { p: [0, 0.05, 0] });
    b.add(rbox(1.5, 0.04, 1.62, 0.02), C.stone, { p: [0, 0.11, 0] });
    // log walls with grooves and chunky corner posts
    b.add(rbox(WX * 2, 0.74, WZ * 2, 0.05), C.wood, { p: [0, 0.48, 0] });
    for (const y of [0.27, 0.45, 0.63]) {
      b.add(rbox(WX * 2 - 0.06, 0.022, 0.02, 0.008), C.woodDark, { p: [0, y, WZ + 0.002], ao: false });
      b.add(rbox(WX * 2 - 0.06, 0.022, 0.02, 0.008), C.woodDark, { p: [0, y, -WZ - 0.002], ao: false });
      b.add(rbox(0.02, 0.022, WZ * 2 - 0.06, 0.008), C.woodDark, { p: [WX + 0.002, y, 0], ao: false });
      b.add(rbox(0.02, 0.022, WZ * 2 - 0.06, 0.008), C.woodDark, { p: [-WX - 0.002, y, 0], ao: false });
    }
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) b.add(rbox(0.15, 0.8, 0.15, 0.05), C.bark, { p: [sx * WX, 0.5, sz * WZ] });
    // gable roof, ridge along z: the triangular gable faces the camera
    const th = 0.6;
    for (const sx of [-1, 1]) {
      const phi = -sx * th, c = [sx * 0.36, 1.1, 0];
      b.add(rbox(1.0, 0.09, 1.78, 0.035), C.roof, { p: c, r: [0, 0, phi] });
      // shingle rows on the slab's top: local (x' = d, y' = 0.05) -> world
      for (const d of [-0.26, 0.02, 0.3]) {
        const x = c[0] + d * Math.cos(phi) - 0.05 * Math.sin(phi), y = c[1] + d * Math.sin(phi) + 0.05 * Math.cos(phi);
        b.add(rbox(0.06, 0.024, 1.8, 0.01), C.roofDark, { p: [x, y, 0], r: [0, 0, phi], ao: false });
      }
      const ex = c[0] + sx * 0.5 * Math.cos(phi), ey = c[1] + sx * 0.5 * Math.sin(phi);
      b.add(rbox(0.08, 0.05, 1.82, 0.02), C.roofDark, { p: [ex, ey + 0.01, 0], r: [0, 0, phi] });
    }
    for (const sz of [-1, 1]) b.add(gable(WX * 2, 0.56, 0.05), C.woodLight, { p: [0, 0.84, sz * (WZ - 0.02)] });
    b.add(new THREE.CylinderGeometry(0.065, 0.065, 1.86, 10), C.copperDark, { p: [0, 1.43, 0], r: [Math.PI / 2, 0, 0] });
    // round attic window in the south gable + the front window with a flower box
    b.add(new THREE.TorusGeometry(0.09, 0.025, 6, 16), C.woodDark, { p: [0, 1.04, WZ + 0.01] });
    b.add(new THREE.CircleGeometry(0.075, 16), C.glass, { p: [0, 1.04, WZ + 0.012], ao: false });
    b.add(rbox(0.38, 0.3, 0.05, 0.02), C.woodDark, { p: [-0.2, 0.5, WZ + 0.01] });
    b.add(rbox(0.29, 0.21, 0.03, 0.01), C.glass, { p: [-0.2, 0.5, WZ + 0.03], ao: false });
    b.add(rbox(0.02, 0.21, 0.035, 0.005), C.woodDark, { p: [-0.2, 0.5, WZ + 0.04], ao: false });
    b.add(rbox(0.29, 0.02, 0.035, 0.005), C.woodDark, { p: [-0.2, 0.5, WZ + 0.04], ao: false });
    b.add(rbox(0.44, 0.08, 0.12, 0.025), C.wood, { p: [-0.2, 0.32, WZ + 0.07] });
    for (let i = 0; i < 5; i++) b.add(new THREE.IcosahedronGeometry(0.036, 0), i % 2 ? C.flowerW : C.flowerO, { p: [-0.36 + i * 0.08, 0.38, WZ + 0.07], flat: true, ao: false });
    // door frame (east face, north half) + awning + step
    b.add(rbox(0.05, 0.6, 0.46, 0.02), C.woodDark, { p: [WX + 0.01, 0.42, -0.4] });
    b.add(rbox(0.03, 0.5, 0.36, 0.01), '#7c5238', { p: [WX + 0.02, 0.37, -0.4], ao: false });
    b.add(rbox(0.22, 0.04, 0.56, 0.02), C.roofDark, { p: [WX + 0.12, 0.74, -0.4], r: [0, 0, -0.35] });
    b.add(rbox(0.2, 0.05, 0.46, 0.02), C.stoneDark, { p: [WX + 0.12, 0.135, -0.4] });
    // little bench along the south wall + a lantern by the door
    b.add(rbox(0.46, 0.05, 0.15, 0.02), C.wood, { p: [0.3, 0.27, WZ + 0.16] });
    for (const x of [0.12, 0.48]) b.add(rbox(0.07, 0.17, 0.12, 0.02), C.woodDark, { p: [x, 0.17, WZ + 0.16] });
    b.add(rbox(0.1, 0.12, 0.1, 0.02), C.glass, { p: [WX + 0.07, 0.62, -0.06], ao: false });
    b.add(new THREE.ConeGeometry(0.08, 0.07, 4), C.copper, { p: [WX + 0.07, 0.71, -0.06], r: [0, Math.PI / 4, 0], flat: true });
    b.add(rbox(0.12, 0.03, 0.12, 0.01), C.copperDark, { p: [WX + 0.07, 0.555, -0.06] });
    // chimney through the west slope
    const [cx, , cz] = HUT.chimney;
    b.add(rbox(0.26, 0.9, 0.26, 0.05), C.stone, { p: [cx, 1.24, cz], jitter: 0.03 });
    for (const y of [1.02, 1.24, 1.46]) b.add(rbox(0.27, 0.015, 0.27, 0.006), C.stoneDark, { p: [cx, y, cz], ao: false });
    b.add(rbox(0.32, 0.07, 0.32, 0.025), C.copper, { p: [cx, 1.7, cz] });
    b.add(rbox(0.16, 0.01, 0.16, 0.004), C.hole, { p: [cx, 1.737, cz], ao: false });
    // woodpile against the west wall
    for (const [y, z] of [[0.17, -0.3], [0.17, -0.1], [0.17, 0.1], [0.33, -0.2], [0.33, 0.0]]) log(b, [-0.86, y, z], [-0.72, y, z], 0.08, { color: C.bark, seed: 41 });
    return { body: b.merge() };
  });
}
function doorGeometry() {
  return once('door', () => {
    const p = new Parts({ ao: false });
    p.add(rbox(0.04, 0.5, 0.36, 0.015), C.wood, { p: [0, 0.27, 0.18] });
    for (const z of [0.07, 0.18, 0.29]) p.add(rbox(0.045, 0.48, 0.01, 0.004), C.woodDark, { p: [0, 0.27, z] });
    p.add(rbox(0.05, 0.035, 0.32, 0.01), C.copperDark, { p: [0, 0.14, 0.18] });
    p.add(rbox(0.05, 0.035, 0.32, 0.01), C.copperDark, { p: [0, 0.42, 0.18] });
    p.add(new THREE.SphereGeometry(0.025, 8, 6), C.copperLight, { p: [0.03, 0.28, 0.3] });
    return p.merge();
  });
}
function buildHut(env) {
  const root = new THREE.Group();
  root.add(env.mesh(hutGeometry().body));
  const door = env.mesh(doorGeometry());
  door.position.set(...HUT.door);
  root.add(door);
  const doorS = new Spring(0, { stiffness: 120, damping: 9 });
  let smoke = 0.4, openT = -1, time = 0;
  return {
    id: 'hut', root, height: 1.7,
    anchors: { out: V(0.9, 0.3, -0.4), intake: V(0.9, 0.3, -0.4), top: V(0, 1.75, 0), door: V(1.0, 0, -0.4) },
    openDoor() { openT = 0; doorS.kick(-3); },
    update(dt) {
      time += dt;
      if (openT >= 0) { openT += dt; doorS.target = openT < 1.4 ? 1.25 : 0; if (openT > 3) openT = -1; }
      door.rotation.y = doorS.update(dt);
      smoke -= dt;
      if (smoke <= 0) {
        smoke = (env.mobile ? 1.5 : 1.0) + Math.sin(time * 1.3) * 0.25;
        env.fx?.puff?.(env.toWorld(V(HUT.chimney[0], HUT.chimney[1] + 0.06, HUT.chimney[2])), { count: 1, size: 0.1, spread: 0.04, up: 0.75, color: '#f7f4ee' });
      }
    },
  };
}

// =====================================================================================================
// QUARRY + COPPER DRILL (one rig, two dressings)
// =====================================================================================================
const RIG = { T: [-0.12, -0.08], capY: 1.3, capBottom: 1.22, hole: 0.19 };
function rigGeometry(kind, chuteZ) {
  return once(`rig:${kind}`, () => {
    const copper = kind === 'copper';
    const [tx, tz] = RIG.T;
    const b = new Parts({ ao: { y0: 0, y1: 0.6, min: 0.78 } });
    b.add(rbox(1.86, 0.06, 1.86, 0.03), C.stoneShade, { p: [0, 0.03, 0] });
    b.add(rbox(1.24, 0.13, 1.24, 0.05, 3), C.stone, { p: [tx, 0.12, tz] });
    b.add(puck(0.2, 0.02, 0.008, 18), C.hole, { p: [tx, 0.185, tz], ao: false });
    b.add(new THREE.TorusGeometry(0.225, 0.036, 6, 22), C.copper, { p: [tx, 0.19, tz], r: [Math.PI / 2, 0, 0], ao: false });
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      beam(b, [tx + sx * 0.47, 0.18, tz + sz * 0.47], [tx + sx * 0.3, RIG.capBottom + 0.02, tz + sz * 0.3], 0.12, C.wood, { r: 0.045 });
      b.add(rbox(0.18, 0.08, 0.18, 0.03), C.copperDark, { p: [tx + sx * 0.47, 0.22, tz + sz * 0.47] });
    }
    for (const s of [-1, 1]) {
      b.add(rbox(0.82, 0.08, 0.08, 0.03), C.woodDark, { p: [tx, 0.72, tz + s * 0.385] });
      b.add(rbox(0.08, 0.08, 0.82, 0.03), C.woodDark, { p: [tx + s * 0.385, 0.72, tz] });
    }
    b.add(rbox(0.82, 0.13, 0.82, 0.05, 3), C.woodDark, { p: [tx, RIG.capBottom + 0.065, tz] });
    b.add(rbox(0.74, 0.03, 0.74, 0.012), C.wood, { p: [tx, RIG.capY + 0.01, tz], ao: false });
    // boiler on the far side from the chute, with a little stack (it puffs while working)
    const bz = -Math.sign(chuteZ) * 0.6, bx = 0.6;
    b.add(puck(0.21, 0.5, 0.06, 14), C.copper, { p: [bx, 0.06, bz] });
    for (const y of [0.18, 0.42]) b.add(new THREE.TorusGeometry(0.215, 0.02, 5, 18), C.copperDark, { p: [bx, y, bz], r: [Math.PI / 2, 0, 0], ao: false });
    b.add(new THREE.SphereGeometry(0.21, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2), C.copperLight, { p: [bx, 0.55, bz], s: [1, 0.5, 1] });
    b.add(puck(0.05, 0.3, 0.015, 10), C.copperDark, { p: [bx + 0.08, 0.6, bz], ao: false });
    beam(b, [bx - 0.15, 0.38, bz - Math.sign(bz) * 0.05], [tx + 0.32, 0.62, tz + Math.sign(bz) * 0.2], 0.05, C.copperDark, { r: 0.02 });
    // chute from the tower to the line start
    chute(b, [0.26, 0.47, chuteZ], [1.08, 0.17, chuteZ], 0.28, copper ? {} : {});
    // deposit chunks + story props
    const chunk = copper ? [C.copper, '#a55f3a', C.copperLight] : [C.stone, C.stoneWarm, C.stoneShade];
    const spots = [[-0.74, -0.7, 0.11], [-0.58, -0.82, 0.08], [-0.82, -0.5, 0.07], [-0.78, 0.66, 0.1], [-0.6, 0.8, 0.07]];
    spots.forEach(([x, z, r], i) => boulder(b, [x, 0.06 + r * 0.6, z], r, { seed: 120 + i * 3, color: chunk[i % 3], shade: copper ? '#9a5a37' : C.stoneShade }));
    if (!copper) {
      // cut stone blocks stacked at the front
      b.add(rbox(0.26, 0.18, 0.2, 0.03), C.stone, { p: [-0.2, 0.15, 0.72] });
      b.add(rbox(0.26, 0.18, 0.2, 0.03), C.stoneWarm, { p: [0.08, 0.15, 0.74] });
      b.add(rbox(0.26, 0.18, 0.2, 0.03), C.stone, { p: [-0.06, 0.33, 0.73] });
    } else {
      // a mine cart with ore at the front
      b.add(rbox(0.42, 0.18, 0.28, 0.04), C.copperDark, { p: [-0.12, 0.2, 0.72] });
      b.add(rbox(0.36, 0.03, 0.22, 0.01), '#9a5a37', { p: [-0.12, 0.3, 0.72], ao: false });
      for (const [x, z] of [[-0.2, 0.68], [-0.06, 0.76], [-0.13, 0.72]]) b.add(jitter(new THREE.DodecahedronGeometry(0.06, 0), 0.02, 8), C.copper, { p: [x, 0.33, z], flat: true, ao: false });
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.add(puck(0.05, 0.03, 0.01, 10), C.steelDark, { p: [-0.12 + sx * 0.15, 0.06, 0.72 + sz * 0.15], r: [Math.PI / 2, 0, 0] });
    }
    // spinner (gear on top) and bit (shaft + spiral)
    const spin = new Parts({ ao: false });
    spin.add(gear(0.32, 0.26, 14, 0.06, { holes: 4, holeR: 0.28 }), C.copper, { r: [-Math.PI / 2, 0, 0], p: [0, 0.035, 0], flat: true });
    spin.add(puck(0.12, 0.09, 0.03, 16), C.copperDark, { p: [0, 0.05, 0] });
    spin.add(new THREE.SphereGeometry(0.065, 12, 8), C.woodLight, { p: [0, 0.15, 0], s: [1, 0.8, 1] });
    const bit = new Parts({ ao: false });
    bit.add(new THREE.CylinderGeometry(0.045, 0.045, 0.62, 8), C.copperDark, { p: [0, -0.31, 0] });
    bit.add(puck(0.09, 0.06, 0.02, 12), C.woodDark, { p: [0, -0.38, 0] });
    const cone = new THREE.ConeGeometry(0.15, 0.3, 6, 4);
    cone.rotateX(Math.PI);
    const cp = cone.attributes.position;
    for (let i = 0; i < cp.count; i++) { const y = cp.getY(i), a = (y + 0.15) * 6, x = cp.getX(i), z = cp.getZ(i); cp.setXYZ(i, x * Math.cos(a) - z * Math.sin(a), y, x * Math.sin(a) + z * Math.cos(a)); }
    const hi = copper ? C.copperLight : C.steel, lo = copper ? C.copperDark : C.steelDark;
    bit.add(cone, hi, { p: [0, -0.6, 0], flat: true, faceColor: (cx, cy, cz) => ((Math.floor(((Math.atan2(cz, cx) - (cy + 0.6 + 0.15) * 6) / (Math.PI * 2)) * 6 + 60) % 2) ? hi : lo) });
    return { body: b.merge(), spinner: spin.merge(), bit: bit.merge(), boiler: [bx + 0.08, 0.92, bz] };
  });
}
function buildRig(env, kind, chuteZ) {
  const g = rigGeometry(kind, chuteZ);
  const [tx, tz] = RIG.T;
  const root = new THREE.Group();
  root.add(env.mesh(g.body));
  const spinner = env.mesh(g.spinner); spinner.position.set(tx, RIG.capY + 0.02, tz); root.add(spinner);
  const bit = env.mesh(g.bit); bit.position.set(tx, RIG.capBottom, tz); root.add(bit);
  const speed = new Spring(0, { stiffness: 30, damping: 10 });
  const lift = new Spring(0, { stiffness: 140, damping: 12 });
  let ang = 0, phase = 0, puffT = 0.5, lastBottom = false;
  const chunkCol = kind === 'copper' ? C.copper : C.stone;
  return {
    id: kind === 'copper' ? 'copperDrill' : 'quarry', root, height: 1.5,
    anchors: { out: V(0.3, 0.5, chuteZ), intake: V(tx, 0.3, tz), top: V(tx, 1.62, tz) },
    onProduced() { lift.kick(-1.2); },
    update(dt, st) {
      const working = !!st?.working;
      speed.target = working ? 1 : 0;
      const sp = Math.max(0, speed.update(dt));
      ang += sp * 9 * dt;
      spinner.rotation.y = ang;
      bit.rotation.y = ang * 1.3;
      // plunge: a smooth down-up stroke paced with the work, lifted clear when blocked
      phase += sp * dt * 2.6;
      const stroke = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
      lift.target = working ? 0 : 0.06;
      const l = lift.update(dt);
      bit.position.y = RIG.capBottom - stroke * 0.17 * sp + l;
      const bottom = stroke > 0.93 && sp > 0.5;
      if (bottom && !lastBottom) env.fx?.chips?.(env.toWorld(V(tx, 0.22, tz)), chunkCol, { count: env.mobile ? 2 : 3, size: 0.045, speed: 1.0, up: 1.6, life: 0.6 });
      lastBottom = bottom;
      if (working) {
        puffT -= dt;
        if (puffT <= 0) { puffT = env.mobile ? 1.0 : 0.6; env.fx?.puff?.(env.toWorld(V(...g.boiler)), { count: 1, size: 0.08, spread: 0.03, up: 0.8, color: '#f6f3ec' }); }
      }
    },
  };
}

// =====================================================================================================
// SMELTER
// =====================================================================================================
const SMELT = { kz: -0.1, mouth: [0, 0.12, 0.6], hopper: [-0.72, 0.44, 0.5], chimney: [0, 1.44, -0.1] };
function smelterGeometry() {
  return once('smelter', () => {
    const b = new Parts({ ao: { y0: 0, y1: 0.6, min: 0.8 } });
    b.add(rbox(1.86, 0.06, 1.86, 0.03), C.stoneShade, { p: [0, 0.03, 0] });
    const prof = [[0, 0.06], [0.6, 0.06], [0.67, 0.18], [0.68, 0.42], [0.6, 0.66], [0.46, 0.86], [0.28, 0.99], [0.2, 1.03], [0, 1.03]].map(([r, y]) => new THREE.Vector2(r, y));
    b.add(new THREE.LatheGeometry(prof, 12), C.stone, {
      p: [0, 0, SMELT.kz], flat: true,
      faceColor: (cx, cy, cz) => { const a = Math.atan2(cz - SMELT.kz, cx); const row = Math.floor(cy * 7.5), col = Math.floor((a / (Math.PI * 2)) * 12 + (row % 2) * 0.5 + 12); return (row + col) % 3 === 0 ? C.stoneWarm : (row + col) % 3 === 1 ? C.stoneShade : null; },
    });
    b.add(new THREE.TorusGeometry(0.69, 0.035, 6, 30), C.copper, { p: [0, 0.3, SMELT.kz], r: [Math.PI / 2, 0, 0] });
    b.add(new THREE.TorusGeometry(0.53, 0.032, 6, 26), C.copper, { p: [0, 0.76, SMELT.kz], r: [Math.PI / 2, 0, 0] });
    b.add(puck(0.17, 0.44, 0.03, 14), C.copperDark, { p: [0, 0.98, SMELT.kz] });
    b.add(puck(0.21, 0.06, 0.02, 14), C.copper, { p: [0, 1.4, SMELT.kz] });
    b.add(puck(0.12, 0.01, 0.004, 12), C.hole, { p: [0, 1.461, SMELT.kz], ao: false });
    // mouth: dark recess, copper arch, stone sill
    b.add(rbox(0.38, 0.3, 0.14, 0.04), '#7a5040', { p: [0, 0.27, 0.53], ao: false });
    b.add(new THREE.TorusGeometry(0.21, 0.05, 6, 14, Math.PI), C.copper, { p: [0, 0.3, 0.6] });
    for (const sx of [-1, 1]) b.add(rbox(0.09, 0.2, 0.09, 0.03), C.copper, { p: [sx * 0.21, 0.2, 0.6] });
    b.add(rbox(0.56, 0.07, 0.18, 0.025), C.stoneDark, { p: [0, 0.1, 0.63] });
    // intake hopper on the west side (fed by the drill line and the drop zone)
    const [hx, hy, hz] = SMELT.hopper;
    for (const dz of [-0.16, 0.16]) beam(b, [hx - 0.08, 0.06, hz + dz], [hx - 0.04, hy + 0.04, hz + dz], 0.06, C.woodDark, { r: 0.02 });
    const hp = [[0.07, 0], [0.12, 0.02], [0.26, 0.24], [0.28, 0.28], [0.25, 0.28], [0.23, 0.25]].map(([r, y]) => new THREE.Vector2(r, y));
    b.add(new THREE.LatheGeometry(hp, 10), C.copper, { p: [hx, hy, hz], flat: true, faceColor: (cx, cy) => (cy > hy + 0.24 ? C.copperLight : null) });
    b.add(puck(0.22, 0.02, 0.006, 10), '#7a5040', { p: [hx, hy + 0.07, hz], ao: false });
    beam(b, [hx + 0.1, hy + 0.04, hz - 0.03], [-0.42, 0.42, 0.22], 0.08, C.copperDark, { r: 0.03 });
    // output trough (east, north row)
    chute(b, [0.52, 0.38, -0.5], [1.08, 0.16, -0.5], 0.26, { color: C.stoneShade, wall: C.copperDark, lip: C.copper });
    // tongs + a bucket for story
    b.add(puck(0.1, 0.16, 0.02, 10), C.woodDark, { p: [0.72, 0.06, 0.7] });
    b.add(puck(0.085, 0.01, 0.004, 10), '#7a5040', { p: [0.72, 0.221, 0.7], ao: false });
    return { body: b.merge() };
  });
}
function mouthGlowGeometry() {
  return once('mouthGlow', () => {
    const s = new THREE.Shape();
    s.moveTo(-0.16, 0.12); s.lineTo(0.16, 0.12); s.lineTo(0.16, 0.3); s.absarc(0, 0.3, 0.16, 0, Math.PI, false); s.lineTo(-0.16, 0.12);
    const g = new THREE.ShapeGeometry(s, 10);
    g.translate(0, 0, 0.605);
    return g;
  });
}
const HOPPER_SLOTS = [[0, 0.07, 0], [0.09, 0.06, 0.05], [-0.08, 0.06, -0.06], [0.05, 0.13, -0.07], [-0.06, 0.14, 0.07], [0.0, 0.2, 0.0]];
function buildSmelter(env) {
  const root = new THREE.Group();
  root.add(env.mesh(smelterGeometry().body));
  const glowMat = new THREE.MeshBasicMaterial({ color: '#c06a3e' });
  const glowMesh = new THREE.Mesh(mouthGlowGeometry(), glowMat);
  root.add(glowMesh);
  const fire = env.fire.add({ preset: 'mouth', size: 0.85, heat: 0.2, glowRadius: 0.7, glowStrength: 0.3, emberRate: 0, seed: 3 });
  const smoke = env.fire.add({ preset: 'none', size: 1, heat: 0, glowStrength: 0, emberRate: 5, seed: 4 });
  smoke.tongues.length = 0;
  const fireLocal = new THREE.Matrix4().makeTranslation(...SMELT.mouth).multiply(new THREE.Matrix4().makeTranslation(0, 0.02, 0));
  const chimLocal = new THREE.Matrix4().makeTranslation(0, 1.2, SMELT.kz);
  const glow = new Spring(0.15, { stiffness: 40, damping: 9 });
  const hopper = env.slots(HOPPER_SLOTS.length);
  const DIM = new THREE.Color('#b8653e'), HOT = new THREE.Color('#ffd27a'), _c = new THREE.Color();
  let time = 0, puffT = 0.3;
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler();
  return {
    id: 'smelter', root, height: 1.5,
    anchors: { out: V(0.55, 0.4, -0.5), intake: V(SMELT.hopper[0], SMELT.hopper[1] + 0.26, SMELT.hopper[2]), top: V(0, 1.6, -0.1) },
    fire,
    onProduced() { glow.kick(3); env.fire.burst(smoke, 6); },
    update(dt, st) {
      time += dt;
      const busy = !!st?.busy;
      glow.target = busy ? 1 : (st?.input?.copperOre ? 0.38 : 0.16);
      const gv = clamp(glow.update(dt), 0, 1.4);
      const fl = 1 + 0.08 * Math.sin(time * 11.3) + 0.05 * Math.sin(time * 17.9);
      glowMat.color.copy(DIM).lerp(HOT, clamp(gv * fl, 0, 1));
      fire.heat = clamp(gv * 1.1, 0, 1);
      fire.glowStrength = 0.12 + 0.3 * gv;
      smoke.heat = busy ? 1 : 0; smoke.heatNow = smoke.heat;
      root.updateMatrixWorld();
      fire.base.multiplyMatrices(root.matrixWorld, fireLocal);
      smoke.base.multiplyMatrices(root.matrixWorld, chimLocal);
      hopper.set(Math.min(HOPPER_SLOTS.length, env.inputShown('copperOre')), dt);
      if (busy) {
        puffT -= dt;
        if (puffT <= 0) { puffT = env.mobile ? 0.8 : 0.45; env.fx?.puff?.(env.toWorld(V(...SMELT.chimney).add(V(0, 0.08, 0))), { count: 1, size: 0.1, spread: 0.04, up: 0.9, color: '#efe9e0' }); }
      }
    },
    items(push) {
      const [hx, hy, hz] = SMELT.hopper;
      hopper.forEach((i, s) => {
        const [x, y, z] = HOPPER_SLOTS[i];
        _m.compose(_p.set(hx + x, hy + y + 0.04, hz + z), _q.setFromEuler(_e.set(i * 0.7, i * 1.3, 0)), _s.set(0.8 * s, 0.8 * s, 0.8 * s));
        push('copperOre', _m);
      });
    },
    dispose() { env.fire.remove(fire); env.fire.remove(smoke); glowMat.dispose(); },
  };
}

// =====================================================================================================
export function buildStationRig(id, env) {
  switch (id) {
    case 'hearth': return buildHearth(env);
    case 'sawmill': return buildSawmill(env);
    case 'cookfire': return buildCookfire(env);
    case 'hut': return buildHut(env);
    case 'quarry': return buildRig(env, 'stone', 0.5);
    case 'copperDrill': return buildRig(env, 'copper', -0.5);
    case 'smelter': return buildSmelter(env);
    default: return null;
  }
}
