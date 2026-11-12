// Pooled, instanced effects + item pickup flights. One InstancedMesh per particle shape, opaque only:
// particles appear by swelling and leave by shrinking (no alpha, no sorting). See DESIGN.md "fx".
import * as THREE from 'three';
import { ease, clamp, lerp, arc } from '../util/anim.js';
import { mulberry32 } from '../util/noise.js';

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _e = new THREE.Euler(), _c = new THREE.Color();
const _z = new THREE.Vector3(0, 0, 1);

// Icosahedron with stable per-corner jitter (chunky rock / wood chips).
function jitteredIco(rng, detail = 0, amount = 0.25) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const pos = g.getAttribute('position'), seen = new Map();
  for (let i = 0; i < pos.count; i++) {
    const k = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    if (!seen.has(k)) seen.set(k, 1 + (rng() - 0.5) * 2 * amount);
    const r = seen.get(k);
    pos.setXYZ(i, pos.getX(i) * r, pos.getY(i) * r * 0.8, pos.getZ(i) * r);
  }
  g.computeVertexNormals();
  return g;
}
function leafGeometry() {
  // a small folded diamond leaf lying in the xz plane
  const v = [0, 0, -1, 0.42, 0.12, -0.05, 0, 0, 1, -0.42, 0.12, -0.05];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([...v.slice(0, 3), ...v.slice(6, 9), ...v.slice(3, 6), ...v.slice(0, 3), ...v.slice(9, 12), ...v.slice(6, 9)], 3));
  g.computeVertexNormals();
  return g;
}
function starGeometry() {
  // flat 4-point star in the xy plane (billboarded)
  const pts = [];
  const n = 4, ro = 1, ri = 0.28;
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2 + Math.PI / 2, r = i % 2 ? ri : ro;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  const p = [];
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; p.push(0, 0, 0, a[0], a[1], 0, b[0], b[1], 0); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.computeVertexNormals();
  return g;
}

export function create(ctx) {
  const { scene, events, config, views, camera, map } = ctx;
  const P = config.PALETTE;
  const rng = mulberry32(90210);
  const R = (a, b) => a + (b - a) * rng();
  let live = false; // ignore setup-time events (scenario) until the first frame
  // portrait phones show ~10 tiles across a 402 px screen: particles and flying items a touch bigger there
  const FXK = ctx.mobile ? 1.2 : 1;

  const groundAt = (x, z) => (map.isGround(Math.round(x), Math.round(z)) ? 0 : config.WATER_Y);

  // ---------------- particle systems ----------------
  class System {
    constructor(geo, mat, cap, { cast = false, billboard = false } = {}) {
      this.mesh = new THREE.InstancedMesh(geo, mat, cap);
      this.mesh.count = 0; this.mesh.visible = false; this.mesh.frustumCulled = false; this.mesh.castShadow = cast; this.mesh.receiveShadow = false;
      this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      this.cap = cap; this.billboard = billboard;
      this.parts = [];
      this.pool = [];
      scene.add(this.mesh);
    }
    spawn() {
      let p;
      if (this.parts.length >= this.cap) { p = this.parts.shift(); } // recycle the oldest
      else p = this.pool.pop() || { col: new THREE.Color() };
      p.age = 0; p.delay = 0; p.rest = false; p.sx = p.sy = p.sz = 1;
      p.vx = p.vy = p.vz = 0; p.rx = p.ry = p.rz = 0; p.wx = p.wy = p.wz = 0;
      p.drag = 0; p.grav = 0; p.bounce = 0; p.flutter = 0; p.fphase = 0; p.collide = false; p.shrinkFrom = undefined; p.linger = 0.3;
      this.parts.push(p);
      return p;
    }
    update(dt) {
      const parts = this.parts;
      let n = 0;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p.delay > 0) { p.delay -= dt; parts[n++] = p; continue; }
        p.age += dt;
        if (p.age >= p.life) { this.pool.push(p); continue; }
        integrate(p, dt);
        parts[n++] = p;
      }
      parts.length = n;
      let k = 0;
      for (const p of parts) {
        if (p.delay > 0) continue;
        const s = scaleCurve(p) * p.size * FXK;
        if (s <= 1e-4) continue;
        if (this.billboard) { _q.copy(camera.quaternion); _q2.setFromAxisAngle(_z, p.rz); _q.multiply(_q2); }
        else { _e.set(p.rx, p.ry, p.rz); _q.setFromEuler(_e); }
        _m.compose(_p.set(p.x, p.y, p.z), _q, _s.set(s * p.sx, s * p.sy, s * p.sz));
        this.mesh.setMatrixAt(k, _m);
        this.mesh.setColorAt(k, p.col);
        k++;
      }
      this.mesh.visible = k > 0;
      if (k || this.mesh.count) {
        this.mesh.count = k;
        this.mesh.instanceMatrix.needsUpdate = true;
        this.mesh.instanceColor.needsUpdate = true;
      }
    }
  }

  function integrate(p, dt) {
    if (p.rest) {
      // lying on the ground: slide to a stop and settle flat
      const f = Math.exp(-10 * dt);
      p.vx *= f; p.vz *= f;
      p.x += p.vx * dt; p.z += p.vz * dt;
      p.wx *= f; p.wy *= f; p.wz *= f;
      if (p.type === 'leaf' || p.type === 'confetti') { p.rx *= f; p.rz *= f; }
      p.ry += p.wy * dt;
      return;
    }
    p.vy += p.grav * dt;
    const d = Math.exp(-p.drag * dt);
    p.vx *= d; p.vy *= d; p.vz *= d;
    let fx = 0, fz = 0;
    if (p.flutter) {
      const w = p.age * p.ffreq + p.fphase;
      fx = Math.sin(w) * p.flutter; fz = Math.cos(w * 0.8) * p.flutter * 0.6;
      p.rz = Math.sin(w) * 0.9; // rock side to side as it drifts
    }
    p.x += (p.vx + fx) * dt; p.y += p.vy * dt; p.z += (p.vz + fz) * dt;
    p.rx += p.wx * dt; p.ry += p.wy * dt; if (!p.flutter) p.rz += p.wz * dt;
    if (p.collide) {
      const gy = groundAt(p.x, p.z) + p.size * 0.35;
      if (p.y < gy) {
        p.y = gy;
        if (p.bounce > 0 && Math.abs(p.vy) > 0.6) {
          p.vy = -p.vy * p.bounce; p.vx *= 0.55; p.vz *= 0.55; p.wx *= 0.5; p.wz *= 0.5;
        } else {
          p.vy = 0; p.rest = true; p.flutter = 0;
          // linger a beat on the ground, then shrink away
          p.life = Math.min(p.life, p.age + p.linger);
          p.shrinkFrom = p.age;
        }
      }
    } else if (p.y < groundAt(p.x, p.z) + 0.02) { p.y = groundAt(p.x, p.z) + 0.02; p.vy = Math.max(0, p.vy); }
  }

  function scaleCurve(p) {
    const k = clamp(p.age / p.life);
    switch (p.curve) {
      case 'puff': {
        // swell fast with overshoot, hold, shrink away
        const g = 0.2;
        if (k < g) return lerp(0.3, 1, ease.backOut(k / g, 2.2));
        return 1 - ease.quadIn((k - g) / (1 - g));
      }
      case 'spark': {
        const g = 0.3;
        if (k < g) return ease.backOut(k / g, 2.6);
        return 1 - ease.cubicIn((k - g) / (1 - g));
      }
      case 'poof': {
        // a cloud ball: balloons out fast with a soft overshoot, holds round, then shrinks away
        const g = 0.16;
        if (k < g) return lerp(0.35, 1, ease.backOut(k / g, 2.8));
        if (k < 0.5) return 1;
        return 1 - ease.quadIn((k - 0.5) / 0.5);
      }
      case 'star': {
        // tiny star: snaps open, twinkles once, closes
        const g = 0.18;
        if (k < g) return lerp(0.3, 1, ease.backOut(k / g, 3));
        const tw = 1 + 0.18 * Math.sin((k - g) * 18);
        return tw * (1 - ease.cubicIn((k - g) / (1 - g)));
      }
      case 'impact': {
        // contact star: opens in ~2 frames, closes over the rest
        const g = 0.22;
        if (k < g) return lerp(0.45, 1, ease.quadOut(k / g));
        return 1 - ease.quadIn((k - g) / (1 - g));
      }
      default: {
        // chips / leaves: pop in quickly, hold, shrink at the end (or after settling on the ground)
        const pin = p.age < 0.06 ? lerp(0.5, 1, ease.quadOut(p.age / 0.06)) : 1;
        const start = p.shrinkFrom !== undefined ? p.shrinkFrom : p.life * 0.72;
        const rem = p.life - start;
        const out = p.age > start && rem > 0 ? 1 - ease.cubicIn(clamp((p.age - start) / rem)) : 1;
        return pin * out;
      }
    }
  }

  const ballGeo = new THREE.IcosahedronGeometry(1, 1);
  const puffMat = new THREE.MeshLambertMaterial({ color: '#f6f8f2', emissive: '#e4f2ea', emissiveIntensity: 0.42 });
  const chipMat = new THREE.MeshLambertMaterial({ flatShading: true, emissive: '#3a2a18', emissiveIntensity: 0.35 });
  const leafMat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, emissive: '#10301a', emissiveIntensity: 0.25 });
  const sparkMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
  const confMat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, emissive: '#ffffff', emissiveIntensity: 0.15 });
  const sys = {
    puff: new System(ballGeo, puffMat, 260),
    chip: new System(jitteredIco(rng, 0, 0.28), chipMat, 220, { cast: true }),
    leaf: new System(leafGeometry(), leafMat, 200, { cast: true }),
    spark: new System(starGeometry(), sparkMat, 150, { billboard: true }),
    confetti: new System(new THREE.PlaneGeometry(1, 0.62).rotateX(-Math.PI / 2), confMat, 160, { cast: true }),
  };

  const V = v => (v?.isVector3 ? v : new THREE.Vector3(v?.x || 0, v?.y || 0, v?.z || 0));
  const LEAF_COLS = [P.leafDark, P.leafMid, P.leafLight, '#4a9443'].map(c => new THREE.Color(c));

  // ---------------- public effects ----------------
  // Chunky soft white balls that swell then shrink, drifting outward and up.
  function puff(pos, { count = 6, color = '#ffffff', size = 0.2, spread = 0.25, up = 0.6, delay = 0 } = {}) {
    pos = V(pos);
    const col = new THREE.Color(color);
    for (let i = 0; i < count; i++) {
      const p = sys.puff.spawn();
      const a = R(0, Math.PI * 2), r = R(0.3, 1) * spread;
      p.type = 'puff'; p.curve = 'puff';
      p.x = pos.x + Math.cos(a) * r * 0.6; p.y = pos.y + R(0, 0.08); p.z = pos.z + Math.sin(a) * r * 0.6;
      const sp = R(0.8, 1.6) * (0.4 + spread * 2);
      p.vx = Math.cos(a) * sp; p.vz = Math.sin(a) * sp; p.vy = up * R(0.6, 1.3);
      p.drag = 5.5; p.grav = 0.5;
      p.size = size * R(0.7, 1.25); p.life = R(0.42, 0.68); p.delay = delay + i * 0.012;
      p.col.copy(col).multiplyScalar(R(0.95, 1.03));
      p.sy = R(0.85, 1);
    }
  }
  // Dust ring: balls start near the centre and roll outward to `radius`.
  function ring(pos, { radius = 0.6, color = '#ffffff', count = 12, size = 0.15, delay = 0 } = {}) {
    pos = V(pos);
    const col = new THREE.Color(color), a0 = R(0, Math.PI * 2);
    for (let i = 0; i < count; i++) {
      const p = sys.puff.spawn();
      const a = a0 + (i / count) * Math.PI * 2 + R(-0.15, 0.15);
      p.type = 'puff'; p.curve = 'puff';
      const r0 = radius * 0.18;
      p.x = pos.x + Math.cos(a) * r0; p.y = pos.y; p.z = pos.z + Math.sin(a) * r0;
      const drag = 6, sp = (radius - r0) * drag * R(0.85, 1.1);
      p.vx = Math.cos(a) * sp; p.vz = Math.sin(a) * sp; p.vy = R(0.2, 0.5);
      p.drag = drag; p.grav = 0.3;
      p.size = size * R(0.6, 1.35); p.life = R(0.32, 0.46); p.delay = delay;
      p.col.copy(col);
    }
  }
  // Water splash: a flat ring of foam balls rolling out on the surface, plus a few droplets that hop up
  // and drop back in. pos.y should be the water surface (config.WATER_Y).
  const SPLASH = [new THREE.Color('#f4fffb'), new THREE.Color('#d6f7ec'), new THREE.Color('#bdf0e2')];
  function splash(pos, { radius = 0.6, count = 12, size = 0.12, drops = 5, delay = 0 } = {}) {
    pos = V(pos);
    const a0 = R(0, Math.PI * 2);
    for (let i = 0; i < count; i++) {
      const p = sys.puff.spawn();
      const a = a0 + (i / count) * Math.PI * 2 + R(-0.2, 0.2);
      p.type = 'puff'; p.curve = 'puff';
      const r0 = radius * 0.25;
      p.x = pos.x + Math.cos(a) * r0; p.y = pos.y + 0.02; p.z = pos.z + Math.sin(a) * r0;
      const drag = 5, sp = (radius - r0) * drag * R(0.8, 1.1);
      p.vx = Math.cos(a) * sp; p.vz = Math.sin(a) * sp; p.vy = R(0.15, 0.4);
      p.drag = drag; p.grav = -0.6;
      p.size = size * R(0.65, 1.3); p.life = R(0.38, 0.55); p.delay = delay + R(0, 0.03);
      p.sy = R(0.55, 0.75); // flattened foam
      p.col.copy(SPLASH[i % SPLASH.length]);
    }
    for (let i = 0; i < drops; i++) {
      const p = sys.puff.spawn();
      const a = R(0, Math.PI * 2), sp = R(0.4, 1.1);
      p.type = 'puff'; p.curve = 'spark';
      p.x = pos.x + Math.cos(a) * radius * 0.2; p.y = pos.y + 0.05; p.z = pos.z + Math.sin(a) * radius * 0.2;
      p.vx = Math.cos(a) * sp; p.vz = Math.sin(a) * sp; p.vy = R(1.6, 2.6);
      p.drag = 0.8; p.grav = -9;
      p.size = size * R(0.35, 0.55); p.life = R(0.4, 0.55); p.delay = delay + R(0, 0.05);
      p.col.copy(SPLASH[0]);
    }
  }
  // Leaves: burst out, then flutter down rocking side to side, settle and shrink.
  function leaves(pos, { count = 6, color, spread = 0.3, delay = 0 } = {}) {
    pos = V(pos);
    const fixed = color ? new THREE.Color(color) : null;
    for (let i = 0; i < count; i++) {
      const p = sys.leaf.spawn();
      const a = R(0, Math.PI * 2);
      p.type = 'leaf'; p.curve = 'leaf';
      p.x = pos.x + Math.cos(a) * spread * R(0.2, 1); p.y = pos.y + R(-0.1, 0.15); p.z = pos.z + Math.sin(a) * spread * R(0.2, 1);
      const sp = R(0.5, 1.4);
      p.vx = Math.cos(a) * sp; p.vz = Math.sin(a) * sp; p.vy = R(0.8, 1.8);
      p.drag = 3; p.grav = -3.2;
      p.flutter = R(0.35, 0.7); p.ffreq = R(5, 8); p.fphase = R(0, 6.28);
      p.ry = R(0, 6.28); p.wy = R(-4, 4); p.rx = R(-0.5, 0.5);
      p.size = R(0.065, 0.095); p.life = R(1.4, 2.0); p.linger = R(0.25, 0.5); p.collide = true; p.shrinkFrom = undefined;
      p.delay = delay + i * 0.015;
      p.col.copy(fixed || LEAF_COLS[Math.floor(rng() * LEAF_COLS.length)]).multiplyScalar(R(0.92, 1.08));
    }
  }
  // Faceted chips / chunks: ballistic hop, bounce once or twice, settle, shrink.
  function chips(pos, color = P.rock, { count = 5, size = 0.06, speed = 1.6, up = 2.4, dir = null, spread = 0.05, delay = 0, life = 0.85 } = {}) {
    pos = V(pos);
    const col = new THREE.Color(color);
    for (let i = 0; i < count; i++) {
      const p = sys.chip.spawn();
      let a = R(0, Math.PI * 2);
      if (dir) a = Math.atan2(dir[1], dir[0]) + R(-1.1, 1.1);
      p.type = 'chip'; p.curve = 'chip';
      p.x = pos.x + R(-spread, spread); p.y = pos.y + R(-spread, spread) * 0.5; p.z = pos.z + R(-spread, spread);
      const sp = speed * R(0.5, 1.1);
      p.vx = Math.cos(a) * sp; p.vz = Math.sin(a) * sp; p.vy = up * R(0.7, 1.15);
      p.drag = 0.6; p.grav = -11; p.bounce = 0.38; p.collide = true;
      p.rx = R(0, 6); p.ry = R(0, 6); p.rz = R(0, 6); p.wx = R(-12, 12); p.wy = R(-8, 8); p.wz = R(-12, 12);
      p.size = size * R(0.7, 1.3); p.life = life * R(0.85, 1.2); p.linger = R(0.08, 0.2); p.shrinkFrom = undefined;
      p.delay = delay;
      p.col.copy(col).multiplyScalar(R(0.88, 1.08));
    }
  }
  // Small twinkling stars that pop, rise a little and spin out.
  function sparkle(pos, { count = 6, color = '#fff4c2', spread = 0.3, size = 0.095, delay = 0 } = {}) {
    pos = V(pos);
    const col = new THREE.Color(color);
    for (let i = 0; i < count; i++) {
      const p = sys.spark.spawn();
      const a = R(0, Math.PI * 2), r = R(0.2, 1) * spread;
      p.type = 'spark'; p.curve = 'spark';
      p.x = pos.x + Math.cos(a) * r; p.y = pos.y + R(-0.05, 0.2); p.z = pos.z + Math.sin(a) * r;
      p.vx = Math.cos(a) * 0.4; p.vz = Math.sin(a) * 0.4; p.vy = R(0.4, 0.9);
      p.drag = 3; p.grav = 0; p.rz = R(0, 1); p.wz = R(-5, 5);
      p.size = size * R(0.7, 1.3); p.life = R(0.4, 0.6); p.delay = delay + i * 0.04;
      p.col.copy(col);
    }
  }
  const CONF_COLS = [P.pack, P.hat, P.uiGreen, '#4fb3e0', P.uiRed, P.flowerWhite, '#b77be0'].map(c => new THREE.Color(c));
  function confetti(pos, { count = 34, delay = 0 } = {}) {
    pos = V(pos);
    for (let i = 0; i < count; i++) {
      const p = sys.confetti.spawn();
      const a = R(0, Math.PI * 2);
      p.type = 'confetti'; p.curve = 'leaf';
      p.x = pos.x; p.y = pos.y; p.z = pos.z;
      const sp = R(0.6, 1.8);
      p.vx = Math.cos(a) * sp; p.vz = Math.sin(a) * sp; p.vy = R(3.2, 4.8);
      p.drag = 2.6; p.grav = -4.5;
      p.flutter = R(0.3, 0.6); p.ffreq = R(6, 10); p.fphase = R(0, 6.28);
      p.rx = R(0, 6); p.ry = R(0, 6); p.wx = R(-9, 9); p.wy = R(-6, 6);
      p.size = R(0.09, 0.125); p.life = R(1.8, 2.6); p.linger = R(0.3, 0.6); p.collide = true; p.shrinkFrom = undefined;
      p.delay = delay + R(0, 0.06);
      p.col.copy(CONF_COLS[i % CONF_COLS.length]);
    }
  }

  // Cute white cloud burst (an animal bonked into drumsticks, a worker's pop-in...): a tight cluster of chunky
  // soft balls that swell with overshoot and drift apart, a second smaller cluster on top, a dust ring rolling
  // out on the ground and a handful of tiny stars flung outward. pos = the centre of the thing that poofs.
  // size 1 ~ a deer (about half a tile across).
  const POOF_STARS = [new THREE.Color('#ffffff'), new THREE.Color('#fff4c2'), new THREE.Color('#ffe9a8')];
  function poof(pos, { size = 1, color = '#ffffff', stars = true, ring: withRing = true, delay = 0 } = {}) {
    pos = V(pos);
    const S = Math.max(0.3, size);
    const col = new THREE.Color(color);
    const core = Math.round((ctx.mobile ? 8 : 10) * clamp(0.75 + S * 0.25, 0.75, 1.3));
    const a0 = R(0, Math.PI * 2);
    for (let i = 0; i < core; i++) {
      const p = sys.puff.spawn();
      const a = a0 + (i / core) * Math.PI * 2 + R(-0.25, 0.25);
      const r = 0.09 * S * R(0.6, 1.1);
      p.type = 'puff'; p.curve = 'poof';
      p.x = pos.x + Math.cos(a) * r; p.y = pos.y + R(-0.06, 0.08) * S; p.z = pos.z + Math.sin(a) * r;
      const sp = R(1.1, 1.7) * S;
      p.vx = Math.cos(a) * sp; p.vz = Math.sin(a) * sp; p.vy = R(0.35, 0.9) * S;
      p.drag = 6.5; p.grav = 0.35;
      p.size = 0.17 * S * R(0.85, 1.25); p.life = R(0.5, 0.66); p.delay = delay + R(0, 0.025);
      p.col.copy(col).multiplyScalar(R(0.96, 1.02));
      p.sy = R(0.88, 1);
    }
    // the big soft middle and a little crown of balls on top: reads as one cloud, not a ring
    for (let i = 0; i < 3; i++) {
      const p = sys.puff.spawn();
      const a = R(0, Math.PI * 2);
      p.type = 'puff'; p.curve = 'poof';
      p.x = pos.x + Math.cos(a) * 0.04 * S; p.y = pos.y + (0.06 + i * 0.07) * S; p.z = pos.z + Math.sin(a) * 0.04 * S;
      p.vx = Math.cos(a) * 0.2 * S; p.vz = Math.sin(a) * 0.2 * S; p.vy = (0.7 + i * 0.25) * S;
      p.drag = 5; p.grav = 0.2;
      p.size = (0.24 - i * 0.04) * S; p.life = R(0.56, 0.7); p.delay = delay + 0.02 + i * 0.03;
      p.col.copy(col);
    }
    if (withRing) ring({ x: pos.x, y: Math.max(groundAt(pos.x, pos.z) + 0.03, pos.y - 0.25 * S), z: pos.z }, { radius: 0.55 * S, count: ctx.mobile ? 8 : 10, size: 0.085 * S, delay: delay + 0.02 });
    if (!stars) return;
    const ns = ctx.mobile ? 5 : 6, s0 = R(0, Math.PI * 2);
    for (let i = 0; i < ns; i++) {
      const p = sys.spark.spawn();
      const a = s0 + (i / ns) * Math.PI * 2 + R(-0.3, 0.3);
      p.type = 'spark'; p.curve = 'star';
      p.x = pos.x + Math.cos(a) * 0.12 * S; p.y = pos.y + R(0.02, 0.16) * S; p.z = pos.z + Math.sin(a) * 0.12 * S;
      const sp = R(1.9, 2.6) * S;
      p.vx = Math.cos(a) * sp; p.vz = Math.sin(a) * sp; p.vy = R(0.9, 1.7) * S;
      p.drag = 4.2; p.grav = -1.2; p.rz = R(0, 1.5); p.wz = R(-7, 7);
      p.size = 0.095 * S * R(0.8, 1.2); p.life = R(0.5, 0.66); p.delay = delay + 0.015 + i * 0.01;
      p.col.copy(POOF_STARS[i % POOF_STARS.length]);
    }
  }
  // Impact star: one bright 4-point star that snaps open at the contact point and closes again (~0.16 s),
  // with a couple of tiny ones flicked outward. The "bonk" frame of a hit. dir = [dx, dz] the blow travels.
  function impact(pos, { size = 1, color = '#ffffff', dir = null, small = 2, delay = 0 } = {}) {
    pos = V(pos);
    const col = new THREE.Color(color);
    const p = sys.spark.spawn();
    p.type = 'spark'; p.curve = 'impact';
    p.x = pos.x; p.y = pos.y; p.z = pos.z;
    p.rz = R(-0.35, 0.35); p.wz = R(-3, 3);
    p.size = 0.2 * size; p.life = 0.17; p.delay = delay;
    p.col.copy(col);
    const base = dir ? Math.atan2(dir[1], dir[0]) : R(0, Math.PI * 2);
    for (let i = 0; i < small; i++) {
      const q = sys.spark.spawn();
      const a = base + R(-1.3, 1.3);
      q.type = 'spark'; q.curve = 'star';
      q.x = pos.x; q.y = pos.y + R(-0.03, 0.05); q.z = pos.z;
      const sp = R(1.6, 2.4) * size;
      q.vx = Math.cos(a) * sp; q.vz = Math.sin(a) * sp; q.vy = R(0.8, 1.6) * size;
      q.drag = 5; q.grav = -2; q.rz = R(0, 1.5); q.wz = R(-8, 8);
      q.size = 0.06 * size * R(0.8, 1.2); q.life = R(0.3, 0.42); q.delay = delay + 0.01;
      q.col.copy(col);
    }
  }

  // ---------------- item flights ----------------
  // Every flying item is one instance of a per-item-type InstancedMesh (one draw call per type in the air), so
  // a 25-per-second pour costs the same as a single log. Two flavours:
  //   pickup  (world -> pack): pops up out of its source with a little fountain hop, hangs, then rushes into
  //           the pack in a stream (40-60 ms apart); each arrival squashes the pack (views.player.gulp()).
  //   throw   (pack -> pad / station): leaves the top of the stack and lobs into the target, shrinking in as
  //           it lands; a fast stream flies shorter, flatter arcs so it stays one tidy pour.
  const FLY_CAP = 64;
  const flyMeshes = new Map(); // item -> InstancedMesh
  const flights = [];
  const fallbackGeo = new THREE.BoxGeometry(0.16, 0.16, 0.16).translate(0, 0.08, 0);
  const fallbackMats = new Map();
  function flyMesh(item) {
    let m = flyMeshes.get(item);
    if (m) return m;
    try { m = views.items?.getInstanced?.(item, FLY_CAP) || null; } catch { m = null; }
    if (!m) {
      let mat = fallbackMats.get(item);
      if (!mat) { mat = new THREE.MeshLambertMaterial({ color: config.ITEMS[item]?.color || '#ffffff' }); fallbackMats.set(item, mat); }
      m = new THREE.InstancedMesh(fallbackGeo, mat, FLY_CAP);
    }
    m.count = 0; m.visible = false;
    m.frustumCulled = false; m.castShadow = !ctx.mobile; m.receiveShadow = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.name = `fxFlights:${item}`;
    m.userData.n = 0;
    scene.add(m);
    flyMeshes.set(item, m);
    return m;
  }
  const resolveTo = (to, out) => {
    let v = null;
    try { v = typeof to === 'function' ? to() : to?.isVector3 ? to : to?.getPosition?.(); } catch { v = null; }
    return v && Number.isFinite(v.x) ? out.copy(v) : out;
  };
  // Public: fly one item. to = Vector3 | () => Vector3 | { getPosition() } (followed every frame).
  // opts: { delay, onArrive, height, popHeight, mode: 'pickup' | 'throw', dur, shrink (end scale), scale }
  function flyItem(itemId, from, to, { delay = 0, onArrive, height, popHeight = 0.3, mode = 'pickup', dur, shrink, scale = 1, jitter } = {}) {
    const a = R(0, Math.PI * 2), j = jitter ?? (mode === 'throw' ? R(0, 0.04) : R(0.1, 0.24));
    const f = {
      id: itemId, from: V(from).clone(), to, delay, t: 0, onArrive, height, popHeight, mode, dur, scale,
      shrink: shrink ?? (mode === 'throw' ? 0.3 : 0.45),
      jx: Math.cos(a) * j, jz: Math.sin(a) * j, spin: R(5, 9) * (rng() < 0.5 ? -1 : 1), tumble: R(-0.5, 0.5), yaw0: R(0, Math.PI * 2),
      p0: new THREE.Vector3(), target: new THREE.Vector3(), phase: 0, flyDur: 0.4, h: 0.4,
      pos: new THREE.Vector3(), sc: 0, visible: false,
    };
    resolveTo(to, f.target);
    flights.push(f);
    return f;
  }
  const POP = 0.15;        // pickup: hop out of the source before homing in
  const LIFT = 0.06;       // throw: scale-in as it leaves the stack
  const _fq = new THREE.Quaternion(), _fe = new THREE.Euler();
  function stepFlight(f, dt) {
    let step = dt;
    if (f.delay > 0) { f.delay -= dt; if (f.delay > 0) return false; step = -f.delay; f.delay = 0; }
    f.t += step;
    f.visible = true;
    resolveTo(f.to, f.target);
    const S = f.scale * FXK;
    if (f.mode === 'throw') {
      if (f.phase === 0) {
        f.phase = 1;
        f.p0.copy(f.from);
        const d = Math.hypot(f.target.x - f.p0.x, f.target.z - f.p0.z);
        f.flyDur = f.dur ?? clamp(0.26 + d * 0.035, 0.26, 0.44);
        f.h = f.height ?? (0.38 + Math.min(d, 5) * 0.07);
      }
      const k = clamp(f.t / f.flyDur);
      const kk = k * k * (1.55 - 0.55 * k); // leave easy, rush in
      f.pos.set(lerp(f.p0.x, f.target.x, kk) + f.jx * arc(k), lerp(f.p0.y, f.target.y, kk) + arc(k) * f.h, lerp(f.p0.z, f.target.z, kk) + f.jz * arc(k));
      const tin = f.t < LIFT ? lerp(0.75, 1, ease.backOut(f.t / LIFT, 2.2)) : 1;
      f.sc = tin * (k > 0.72 ? lerp(1, f.shrink, ease.quadIn((k - 0.72) / 0.28)) : 1) * S;
      _fe.set(Math.sin(k * 3.1) * 0.5, f.yaw0 + f.spin * k * 0.45, Math.sin(k * 2.3) * 0.35);
      return k >= 1;
    }
    if (f.t < POP) {
      const k = f.t / POP;
      const e = ease.quadOut(k);
      f.pos.set(f.from.x + f.jx * e, f.from.y + f.popHeight * ease.cubicOut(k), f.from.z + f.jz * e);
      f.sc = lerp(0.4, 1, ease.backOut(k, 2.4)) * S;
      _fe.set(f.tumble * k, f.yaw0 + f.spin * f.t, 0);
      return false;
    }
    if (f.phase === 0) {
      f.phase = 1;
      f.p0.set(f.from.x + f.jx, f.from.y + f.popHeight, f.from.z + f.jz);
      const d = Math.hypot(f.target.x - f.p0.x, f.target.z - f.p0.z);
      f.flyDur = f.dur ?? clamp(0.28 + d * 0.045, 0.3, 0.56);
      f.h = f.height ?? (0.3 + Math.min(d, 6) * 0.07);
    }
    const k = clamp((f.t - POP) / f.flyDur);
    const kk = k * k * (1.6 - 0.6 * k); // hang, then rush in
    f.pos.set(lerp(f.p0.x, f.target.x, kk), lerp(f.p0.y, f.target.y, kk) + arc(k) * f.h, lerp(f.p0.z, f.target.z, kk));
    f.sc = (k < 0.62 ? 1 : lerp(1, f.shrink, ease.quadIn((k - 0.62) / 0.38))) * S;
    _fe.set(f.tumble, f.yaw0 + f.spin * f.t, 0);
    return k >= 1;
  }
  function updateFlights(dt) {
    for (const m of flyMeshes.values()) m.userData.n = 0;
    for (let i = 0; i < flights.length; i++) {
      const f = flights[i];
      let done = false;
      try { done = stepFlight(f, dt); } catch (err) { done = true; console.error('[fx] flight', err); }
      if (done) {
        flights.splice(i--, 1);
        try { f.onArrive?.(); } catch (err) { console.error('[fx] onArrive', err); }
        continue;
      }
      if (!f.visible) continue;
      const m = flyMesh(f.id);
      const n = m.userData.n;
      if (n >= FLY_CAP) continue;
      _fq.setFromEuler(_fe);
      m.setMatrixAt(n, _m.compose(f.pos, _fq, _s.setScalar(Math.max(1e-4, f.sc))));
      m.userData.n = n + 1;
    }
    for (const m of flyMeshes.values()) {
      const n = m.userData.n;
      if (n || m.count) { m.count = n; m.instanceMatrix.needsUpdate = true; }
      m.visible = n > 0;
    }
  }

  // Where carried items live: the top of the stack on the robot's back when the player view exposes it,
  // else the pack itself (falls back to the player's middle, then the sim tile).
  const playerTarget = new THREE.Vector3(), stackTarget = new THREE.Vector3();
  function packPos(out = playerTarget) {
    const pl = views.player;
    let p = null;
    try { p = pl?.getPackPosition?.(out) || null; } catch { p = null; }
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) { if (p !== out) out.copy(p); return out; }
    try { p = pl?.getPosition?.() || null; } catch { p = null; }
    if (p && Number.isFinite(p.x)) out.set(p.x, (p.y || 0) + 0.42, p.z);
    else out.set(ctx.sim.player.x, 0.45, ctx.sim.player.z);
    return out;
  }
  function stackTop(out = stackTarget) {
    let p = null;
    try { p = views.player?.getStackTop?.(out) || null; } catch { p = null; }
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) { if (p !== out) out.copy(p); return out; }
    return packPos(out).add(_p.set(0, 0.14, 0));
  }
  const playerPos = () => packPos(playerTarget);

  // Pickup flights: items gained from the world fly from their source into the backpack.
  // They are queued and resolved in the next update(): when a building is removed, the sim adds its items
  // before 'build:removed' fires, so only then do props / buildings know how long to hold the flight back.
  const STREAM = 0.048, STREAM_J = 0.008; // pickup stream: 40-56 ms between items
  const PICKUP_MAX = 12;                  // one flying item per gained item, up to this many per gain
  const pending = [];
  const offs = [];
  const on = (type, fn) => offs.push(events.on(type, p => { try { fn(p || {}); } catch (e) { console.error(`[fx] ${type}`, e); } }));
  on('inventory:changed', ({ item, delta, source }) => {
    if (!live || !source || !(delta > 0)) return;
    pending.push({ item, delta, x: source.x, z: source.z });
  });
  // A pickup from a station's pile lifts off the top of the heap (not the floor under it).
  function pileOrigin(x, z) {
    const stations = ctx.camp?.stations;
    if (!stations) return null;
    for (const s of stations.values()) {
      const t = s.pile?.tile;
      if (!t || t[0] !== x || t[1] !== z) continue;
      const p = views.campview?.pileTop?.(s.id, new THREE.Vector3());
      return p && Number.isFinite(p.y) ? p.add(_p.set(R(-0.04, 0.04), 0.02, R(-0.04, 0.04))) : null;
    }
    return null;
  }
  const streamT = new Map(); // source tile -> time its last queued item leaves (keeps back-to-back gains in one stream)
  let clock = 0;
  function flushPending() {
    if (!pending.length) return;
    for (const { item, delta, x, z } of pending.splice(0)) {
      const n = Math.min(delta, PICKUP_MAX);
      const key = `${x},${z}`;
      let base = 0;
      try {
        base = Math.max(Number(views.props?.flightDelay?.(x, z)) || 0, Number(views.buildings?.flightDelay?.(x, z) ?? 0) || 0);
      } catch { base = 0.05; }
      // continue an ongoing stream from the same place instead of overlapping it
      base = Math.max(base, (streamT.get(key) ?? -1) - clock + STREAM);
      let left = delta, at = base;
      const froms = [];
      for (let i = 0; i < n; i++) {
        let from = null;
        try { from = views.props?.flightOrigin?.(x, z, i, n) || pileOrigin(x, z) || null; } catch { from = null; }
        froms.push(from || new THREE.Vector3(x + R(-0.15, 0.15), 0.25, z + R(-0.15, 0.15)));
      }
      // eta of the last arrival: its delay + hop + the homing flight (as stepFlight sizes it, from where the pack
      // is now; a little margin for the player walking on)
      const pk = playerPos(), lf = froms[n - 1];
      const flyEst = clamp(0.28 + Math.hypot(pk.x - lf.x, pk.z - lf.z) * 0.045, 0.3, 0.56) + 0.04;
      events.emit('fx:flightsQueued', { item, count: delta, x, z, eta: base + (n - 1) * STREAM + POP + flyEst });
      for (let i = 0; i < n; i++) {
        const share = i === n - 1 ? left : Math.floor(delta / n);
        left -= share;
        const from = froms[i];
        flyItem(item, from, playerPos, {
          delay: at,
          onArrive: () => { events.emit('fx:itemArrived', { item, count: share }); views.player?.gulp?.(); },
        });
        at += STREAM + R(-STREAM_J, STREAM_J);
      }
      streamT.set(key, clock + at - STREAM);
    }
    if (streamT.size > 48) for (const [k, t] of streamT) if (t < clock - 1) streamT.delete(k);
  }

  // Throw flights from the pack: pad payments (unless the pads view draws its own) and player drops into a
  // station. Each item leaves from the stack top; a fast stream gets shorter, flatter arcs.
  const lastThrow = new Map(); // target key -> clock of the previous throw
  let throwSeq = 0;
  function throwFromPack(item, key, target, onArrive) {
    const gap = lastThrow.has(key) ? clock - lastThrow.get(key) : 1;
    lastThrow.set(key, clock);
    const fast = clamp((0.12 - gap) / 0.08);
    const from = stackTop(new THREE.Vector3());
    const d = Math.hypot(target.x - from.x, target.z - from.z);
    return flyItem(item, from, target, {
      mode: 'throw', onArrive,
      dur: clamp(0.26 + d * 0.035, 0.26, 0.44) * (1 - 0.3 * fast),
      height: (0.4 + Math.min(d, 5) * 0.07) * (1 - 0.25 * fast),
    });
  }
  const padsDrawFlights = () => {
    const pv = views.pads;
    if (pv?.drawsPaidFlights != null) return !!pv.drawsPaidFlights;
    return typeof pv?.padObject === 'function'; // the pads view in this build draws pad:paid flights itself
  };
  on('pad:paid', ({ pad, item }) => {
    if (!live || !pad || !item || padsDrawFlights()) return;
    const c = ctx.camp?.padCenter?.(pad) || { x: pad.zone[0] + (pad.zone[2] - 1) / 2, z: pad.zone[1] + (pad.zone[3] - 1) / 2 };
    // land on a little golden-angle lattice so a fast pour fans out on the plate instead of piling on one spot
    const k = throwSeq++, ang = k * 2.39996, rr = 0.1 + ((k * 0.37) % 1) * 0.16;
    const hw = (pad.zone[2] || 1) * 0.3, hh = (pad.zone[3] || 1) * 0.3;
    const to = new THREE.Vector3(c.x + Math.cos(ang) * Math.min(rr, hw), 0.1, c.z + Math.sin(ang) * Math.min(rr, hh));
    throwFromPack(item, `pad:${pad.id}`, to, () => {
      events.emit('fx:paidArrived', { pad, item });
      if (k % 3 === 0) puff(to, { count: 2, size: 0.07, spread: 0.12, up: 0.3, color: '#fffaf0' });
    });
  });
  on('station:drop', ({ station, item, by }) => {
    if (!live || by !== 'player' || !station || !item) return;
    let to = null;
    try { to = views.campview?.intakePoint?.(station.id, new THREE.Vector3()) || null; } catch { to = null; }
    if (!to || !Number.isFinite(to.x)) {
      const zone = station.def?.zone || station.def?.footprint;
      if (!zone) return;
      const c = ctx.camp?.rectCenter?.(zone) || { x: zone[0] + (zone[2] - 1) / 2, z: zone[1] + (zone[3] - 1) / 2 };
      to = new THREE.Vector3(c.x, 0.3, c.z);
    }
    to.x += R(-0.06, 0.06); to.z += R(-0.06, 0.06);
    throwFromPack(item, `station:${station.id}`, to, () => events.emit('fx:dropArrived', { station, item }));
  });

  return {
    puff, ring, splash, leaves, chips, sparkle, confetti, poof, impact, flyItem,
    get activeFlights() { return flights.length; },
    // test/debug snapshot of the flights in progress
    get flights() { return flights.map(f => ({ item: f.id, mode: f.mode, delay: f.delay, t: f.t, visible: f.visible, pos: f.pos.toArray() })); },
    // draw calls currently used by flying items (one per item type in the air)
    get flightDrawCalls() { let n = 0; for (const m of flyMeshes.values()) if (m.visible) n++; return n; },
    update(dt) {
      live = true;
      clock += dt;
      flushPending();
      for (const s of Object.values(sys)) s.update(dt);
      updateFlights(dt);
    },
    dispose() { offs.forEach(off => off()); },
  };
}
