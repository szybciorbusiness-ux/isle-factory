// Fire system for the camp: every flame tongue of every fire is one instance of a single InstancedMesh (unlit,
// vertex-coloured), embers are another, and warm ground glows a third (additive). Each fire is a handle the
// station drives every frame: base (world Matrix4 at the fire's base), size, heat 0..1 (damped here),
// plus a springy flare. All motion comes from update(dt).
import * as THREE from 'three';
import { Spring, damp } from '../../util/anim.js';
import { flameGeometry, emberGeometry, glowTexture } from './geo.js';

// Tongue presets in fire-local units (x, z offsets, width, height). Tint multiplies the flame's vertex colours.
const CORE = new THREE.Color('#fffbe8'), WARM = new THREE.Color('#ffffff'), ORANGE = new THREE.Color('#ffd0a8'), DEEP = new THREE.Color('#ffb48e');
export const FIRE_PRESETS = {
  hearth: [
    [0, 0, 0.5, 0.84, WARM], [0.17, 0.05, 0.34, 0.64, ORANGE], [-0.16, 0.07, 0.32, 0.7, ORANGE], [0.03, -0.17, 0.33, 0.62, DEEP],
    [-0.06, 0.18, 0.28, 0.52, ORANGE], [0.19, -0.13, 0.24, 0.46, DEEP], [-0.2, -0.1, 0.24, 0.48, DEEP], [0.0, 0.06, 0.22, 0.56, CORE],
    [0.1, 0.16, 0.2, 0.4, ORANGE], [-0.12, -0.18, 0.2, 0.38, DEEP],
  ],
  camp: [
    [0, 0, 0.24, 0.5, WARM], [0.1, 0.03, 0.17, 0.34, ORANGE], [-0.09, 0.05, 0.17, 0.36, ORANGE], [0.01, -0.09, 0.17, 0.32, DEEP], [0.0, 0.08, 0.12, 0.26, WARM],
  ],
  mouth: [
    [0, 0, 0.2, 0.3, WARM], [0.1, 0.0, 0.14, 0.22, ORANGE], [-0.1, 0.0, 0.14, 0.22, ORANGE],
  ],
};

export function createFireSystem(ctx, parent, { mobile = false } = {}) {
  const fires = [];
  // ---- flames ----
  const flameGeo = flameGeometry();
  const flameMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  const MAXT = 64;
  const flames = new THREE.InstancedMesh(flameGeo, flameMat, MAXT);
  flames.count = 0; flames.frustumCulled = false; flames.name = 'camp-flames';
  flames.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAXT * 3).fill(1), 3);
  parent.add(flames);

  // ---- embers ----
  const MAXE = mobile ? 40 : 90;
  const emberMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
  const embers = new THREE.InstancedMesh(emberGeometry(), emberMat, MAXE);
  embers.count = 0; embers.frustumCulled = false; embers.name = 'camp-embers';
  embers.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAXE * 3).fill(1), 3);
  parent.add(embers);
  const parts = [];
  let seed = 977;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const E0 = new THREE.Color('#fff1a6'), E1 = new THREE.Color('#ff8e3c');

  // ---- ground glows ----
  const MAXG = 8;
  const glowMat = new THREE.MeshBasicMaterial({
    map: glowTexture(), color: '#ffffff', transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const glowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const glows = new THREE.InstancedMesh(glowGeo, glowMat, MAXG);
  glows.count = 0; glows.frustumCulled = false; glows.renderOrder = 2; glows.name = 'camp-glows';
  glows.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAXG * 3).fill(1), 3);
  parent.add(glows);

  const _m = new THREE.Matrix4(), _l = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
  const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color(), _w = new THREE.Vector3();
  let time = 0;

  function add({ preset = 'camp', size = 1, heat = 1, glowRadius = 1.2, glowColor = '#ff9a4a', glowStrength = 0.35, emberRate = 3, seed: fs = 1 } = {}) {
    const tongues = (FIRE_PRESETS[preset] || FIRE_PRESETS.camp).map(([x, z, w, h, tint], i) => ({
      x, z, w, h, tint, ph: fs * 1.7 + i * 2.39, sp: 0.85 + ((i * 37 + fs * 13) % 10) / 22, yaw: i * 1.9 + fs,
    }));
    const f = {
      base: new THREE.Matrix4(), size, heat, heatNow: heat, tongues, glowRadius, glowColor: new THREE.Color(glowColor), glowStrength,
      emberRate, emberAcc: 0, boost: new Spring(0, { stiffness: 90, damping: 9 }), visible: true,
      flare(amount = 1) { this.boost.kick(amount * 6); },
      // world position of the base (after the owner updated .base)
      position(out = new THREE.Vector3()) { return out.setFromMatrixPosition(this.base); },
    };
    fires.push(f);
    return f;
  }
  function remove(f) { const i = fires.indexOf(f); if (i >= 0) fires.splice(i, 1); }

  function spawnEmber(f, k) {
    if (parts.length >= MAXE) return;
    f.base.decompose(_p, _q, _s);
    const sc = _s.y * f.size;
    const a = rnd() * Math.PI * 2, r = rnd() * 0.14 * sc;
    parts.push({
      x: _p.x + Math.cos(a) * r, y: _p.y + (0.15 + rnd() * 0.25) * sc * Math.max(0.5, k), z: _p.z + Math.sin(a) * r,
      vx: (rnd() - 0.5) * 0.25, vy: 0.55 + rnd() * 0.6, vz: (rnd() - 0.5) * 0.25,
      age: 0, life: 0.9 + rnd() * 0.8, size: (0.016 + rnd() * 0.016) * Math.min(1.6, 0.7 + sc * 0.5), ph: rnd() * 6.28,
    });
  }
  function burst(f, n = 12) { for (let i = 0; i < n; i++) spawnEmber(f, 1.6); }

  function update(dt) {
    time += dt;
    let nt = 0, ng = 0;
    for (const f of fires) {
      f.heatNow = damp(f.heatNow, f.heat, f.heat > f.heatNow ? 5 : 3, dt);
      const b = f.boost.update(dt);
      const heat = f.heatNow;
      if (!f.visible || heat < 0.02) continue;
      f.base.decompose(_p, _q, _s);
      const fsz = f.size * (1 + Math.max(-0.4, b));
      const flick = 1 + 0.05 * Math.sin(time * 9.1 + (f.tongues[0]?.ph || 0)) + 0.04 * Math.sin(time * 14.3);
      for (const t of f.tongues) {
        if (nt >= MAXT) break;
        const k = time * t.sp;
        const fl = 1 + 0.16 * Math.sin(k * 6.2 + t.ph) + 0.09 * Math.sin(k * 13.7 + t.ph * 1.7) + 0.05 * Math.sin(k * 23.1 + t.ph * 0.3);
        const hk = (0.35 + 0.65 * heat) * heat;
        const h = t.h * fsz * fl * hk, w = t.w * fsz * (0.7 + 0.3 * heat) * (1.06 - 0.06 * fl);
        _e.set(0.13 * Math.sin(k * 4.3 + t.ph), t.yaw + k * 0.6, 0.13 * Math.sin(k * 3.7 + t.ph * 1.3));
        _l.compose(_w.set(t.x * fsz, 0, t.z * fsz), _q.setFromEuler(_e), _s.set(w, h, w));
        _m.multiplyMatrices(f.base, _l);
        flames.setMatrixAt(nt, _m);
        flames.setColorAt(nt, t.tint);
        nt++;
      }
      // embers
      f.emberAcc += dt * f.emberRate * heat * (1 + Math.max(0, b) * 3);
      while (f.emberAcc >= 1) { f.emberAcc -= 1; spawnEmber(f, heat); }
      // ground glow
      if (ng < MAXG && f.glowStrength > 0) {
        f.base.decompose(_p, _q, _s);
        const r = f.glowRadius * (0.75 + 0.25 * heat) * (1 + Math.max(-0.3, b) * 0.35) * flick;
        _m.compose(_w.set(_p.x, 0.02, _p.z), _q.identity(), _s.set(r * 2, 1, r * 2));
        glows.setMatrixAt(ng, _m);
        _c.copy(f.glowColor).multiplyScalar(f.glowStrength * heat * flick * (1 + Math.max(0, b) * 0.8));
        glows.setColorAt(ng, _c);
        ng++;
      }
    }
    flames.count = nt; flames.visible = nt > 0;
    if (nt) { flames.instanceMatrix.needsUpdate = true; flames.instanceColor.needsUpdate = true; }
    glows.count = ng; glows.visible = ng > 0;
    if (ng) { glows.instanceMatrix.needsUpdate = true; glows.instanceColor.needsUpdate = true; }

    // embers: drift up, wobble, shrink
    let ne = 0;
    for (let i = parts.length - 1; i >= 0; i--) {
      const e = parts[i];
      e.age += dt;
      if (e.age >= e.life) { parts.splice(i, 1); continue; }
      e.vy = damp(e.vy, 0.25, 1.2, dt);
      e.x += (e.vx + Math.sin(e.age * 5 + e.ph) * 0.18) * dt; e.y += e.vy * dt; e.z += e.vz * dt;
    }
    for (const e of parts) {
      const k = e.age / e.life;
      const s = e.size * (k < 0.15 ? 0.6 + 0.4 * (k / 0.15) : Math.pow(1 - (k - 0.15) / 0.85, 0.8));
      _m.compose(_w.set(e.x, e.y, e.z), _q.setFromEuler(_e.set(e.age * 3 + e.ph, e.age * 2, 0)), _s.set(s, s * 1.3, s));
      embers.setMatrixAt(ne, _m);
      embers.setColorAt(ne, _c.copy(E0).lerp(E1, Math.min(1, k * 1.3)));
      ne++;
    }
    embers.count = ne; embers.visible = ne > 0;
    if (ne) { embers.instanceMatrix.needsUpdate = true; embers.instanceColor.needsUpdate = true; }
  }

  return { add, remove, update, burst, fires, meshes: [flames, embers, glows] };
}
