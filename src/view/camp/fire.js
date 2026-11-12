// Fire system for the camp: every flame tongue of every fire is one instance of a single InstancedMesh (unlit,
// vertex-coloured), embers / sparks are another, and warm ground glows a third (additive). Each fire is a handle
// the station drives every frame: base (world Matrix4 at the fire's base), size + stretch (springs, so a fire that
// grows visibly swells into its new size), heat 0..1 (damped here), active (how many of the preset's tongues burn:
// presets list their big-fire tongues last), plus a springy flare.
//
// Extras for the hearth (all drawn with the same ember instances, so they cost no draw calls):
//   column  sparks / s rising in a tall swirling column above the flame
//   crown   0..1: a ring of golden sparks circling above the flame like a crown (assembles from the fire)
// All motion comes from update(dt).
import * as THREE from 'three';
import { Spring, damp, ease, clamp } from '../../util/anim.js';
import { flameGeometry, emberGeometry, glowTexture } from './geo.js';

// Tongue presets in fire-local units (x, z offsets, width, height). Tint multiplies the flame's vertex colours.
const CORE = new THREE.Color('#fffbe8'), WARM = new THREE.Color('#ffffff'), ORANGE = new THREE.Color('#ffd0a8'), DEEP = new THREE.Color('#ffb48e');
export const FIRE_PRESETS = {
  hearth: [
    // 0-9: the camp fire (levels 1-3)
    [0, 0, 0.5, 0.84, WARM], [0.17, 0.05, 0.34, 0.64, ORANGE], [-0.16, 0.07, 0.32, 0.7, ORANGE], [0.03, -0.17, 0.33, 0.62, DEEP],
    [-0.06, 0.18, 0.28, 0.52, ORANGE], [0.19, -0.13, 0.24, 0.46, DEEP], [-0.2, -0.1, 0.24, 0.48, DEEP], [0.0, 0.06, 0.22, 0.56, CORE],
    [0.1, 0.16, 0.2, 0.4, ORANGE], [-0.12, -0.18, 0.2, 0.38, DEEP],
    // 10-12: level 4, a tall core that lifts the whole flame
    [0.01, -0.02, 0.52, 1.0, ORANGE], [-0.03, 0.04, 0.3, 1.1, WARM], [0.12, 0.08, 0.36, 0.84, ORANGE],
    // 13-20: level 5, the bonfire: a wide skirt of tongues all round
    [0.3, 0.04, 0.3, 0.62, ORANGE], [-0.29, 0.1, 0.3, 0.66, DEEP], [0.1, 0.29, 0.28, 0.56, ORANGE], [-0.1, -0.29, 0.3, 0.6, DEEP],
    [0.25, -0.22, 0.26, 0.54, ORANGE], [-0.23, -0.25, 0.26, 0.52, DEEP], [-0.22, 0.25, 0.26, 0.5, ORANGE], [0.24, 0.24, 0.24, 0.5, DEEP],
  ],
  camp: [
    [0, 0, 0.24, 0.5, WARM], [0.1, 0.03, 0.17, 0.34, ORANGE], [-0.09, 0.05, 0.17, 0.36, ORANGE], [0.01, -0.09, 0.17, 0.32, DEEP], [0.0, 0.08, 0.12, 0.26, WARM],
  ],
  mouth: [
    [0, 0, 0.2, 0.3, WARM], [0.1, 0.0, 0.14, 0.22, ORANGE], [-0.1, 0.0, 0.14, 0.22, ORANGE],
  ],
  none: [],
};

export function createFireSystem(ctx, parent, { mobile = false } = {}) {
  const fires = [];
  // ---- flames ----
  const flameGeo = flameGeometry();
  const flameMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  const MAXT = 72;
  const flames = new THREE.InstancedMesh(flameGeo, flameMat, MAXT);
  flames.count = 0; flames.frustumCulled = false; flames.name = 'camp-flames';
  flames.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAXT * 3).fill(1), 3);
  parent.add(flames);

  // ---- embers, column sparks and the crown (one instanced mesh) ----
  const MAXE = mobile ? 120 : 220;
  const emberMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
  const embers = new THREE.InstancedMesh(emberGeometry(), emberMat, MAXE);
  embers.count = 0; embers.frustumCulled = false; embers.name = 'camp-embers';
  embers.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAXE * 3).fill(1), 3);
  parent.add(embers);
  const parts = [];
  let seed = 977;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const E0 = new THREE.Color('#fff1a6'), E1 = new THREE.Color('#ff8e3c');
  const S0 = new THREE.Color('#fff4b8'), S1 = new THREE.Color('#ffb52e'), S2 = new THREE.Color('#ff6a1e');
  const G0 = new THREE.Color('#fff6c2'), G1 = new THREE.Color('#ffc928'), G2 = new THREE.Color('#ff8a1e');

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

  function add({ preset = 'camp', size = 1, stretch = 1, heat = 1, active = Infinity, glowRadius = 1.2, glowColor = '#ff9a4a', glowStrength = 0.35, emberRate = 3, column = 0, crown = 0, seed: fs = 1 } = {}) {
    const list = FIRE_PRESETS[preset] || FIRE_PRESETS.camp;
    const tongues = list.map(([x, z, w, h, tint], i) => ({
      x, z, w, h, tint, ph: fs * 1.7 + i * 2.39, sp: 0.85 + ((i * 37 + fs * 13) % 10) / 22, yaw: i * 1.9 + fs,
      // grows in / out when `active` changes (pops from the bed with a little overshoot)
      g: new Spring(i < active ? 1 : 0, { stiffness: 120, damping: 11 }),
    }));
    const f = {
      base: new THREE.Matrix4(), size, stretch, heat, heatNow: heat, active, tongues, glowRadius, glowColor: new THREE.Color(glowColor), glowStrength,
      emberRate, emberAcc: 0, column, columnAcc: 0, crown, visible: true,
      boost: new Spring(0, { stiffness: 90, damping: 9 }),
      // size / stretch / glow radius chase their targets on springs: a fire that levels up swells into its size
      sizeS: new Spring(size, { stiffness: 34, damping: 7.5 }),
      stretchS: new Spring(stretch, { stiffness: 28, damping: 6.5 }),
      glowS: new Spring(glowRadius, { stiffness: 22, damping: 5 }),
      crownNow: crown, crownT: crown > 0 ? 10 : 0, glowFlash: 0,
      flare(amount = 1) { this.boost.kick(amount * 6); },
      // jump straight to the current targets (restored state, no animation)
      snap() {
        this.sizeS.set(this.size); this.stretchS.set(this.stretch); this.glowS.set(this.glowRadius);
        this.heatNow = this.heat; this.crownNow = this.crown; this.crownT = this.crown > 0 ? 10 : 0;
        this.tongues.forEach((t, i) => t.g.set(i < this.active ? 1 : 0));
      },
      // world position of the base (after the owner updated .base)
      position(out = new THREE.Vector3()) { return out.setFromMatrixPosition(this.base); },
      // world-space height of the tallest tongue right now (for lights, sparks, the crown)
      get height() { return flameTop(this); },
    };
    fires.push(f);
    return f;
  }
  function remove(f) { const i = fires.indexOf(f); if (i >= 0) fires.splice(i, 1); }

  function flameTop(f) {
    let h = 0;
    for (let i = 0; i < f.tongues.length; i++) { const t = f.tongues[i]; h = Math.max(h, t.h * Math.max(0, t.g.value)); }
    f.base.decompose(_p, _q, _s);
    return h * f.sizeS.value * f.stretchS.value * _s.y * (0.35 + 0.65 * f.heatNow) * f.heatNow;
  }

  function spawnEmber(f, k) {
    if (parts.length >= MAXE) return;
    f.base.decompose(_p, _q, _s);
    const sc = _s.y * f.sizeS.value;
    const a = rnd() * Math.PI * 2, r = rnd() * 0.14 * sc;
    parts.push({
      kind: 0,
      x: _p.x + Math.cos(a) * r, y: _p.y + (0.15 + rnd() * 0.25) * sc * Math.max(0.5, k), z: _p.z + Math.sin(a) * r,
      vx: (rnd() - 0.5) * 0.25, vy: 0.55 + rnd() * 0.6, vz: (rnd() - 0.5) * 0.25,
      age: 0, life: 0.9 + rnd() * 0.8, size: (0.016 + rnd() * 0.016) * Math.min(1.6, 0.7 + sc * 0.5), ph: rnd() * 6.28,
    });
  }
  // a column spark: leaves the flame's upper half and climbs fast in a slow spiral round the fire's axis
  function spawnSpark(f, fast = 1) {
    if (parts.length >= MAXE) return;
    f.base.decompose(_p, _q, _s);
    const top = flameTop(f);
    parts.push({
      kind: 1, cx: _p.x, cz: _p.z,
      a: rnd() * Math.PI * 2, r: 0.04 + rnd() * 0.12, w: (rnd() < 0.5 ? -1 : 1) * (1.6 + rnd() * 1.6),
      y: _p.y + top * (0.45 + rnd() * 0.4), vy: (1.5 + rnd() * 0.9) * fast,
      age: 0, life: 1.3 + rnd() * 0.8, size: 0.042 + rnd() * 0.03, ph: rnd() * 6.28,
    });
  }
  function burst(f, n = 12) { for (let i = 0; i < n; i++) spawnEmber(f, 1.6); }
  function burstColumn(f, n = 20) { for (let i = 0; i < n; i++) spawnSpark(f, 1.25 + rnd() * 0.5); }

  let ne = 0;
  const pushEmber = (x, y, z, s, sy, rx, ry, col) => {
    if (ne >= MAXE) return;
    _m.compose(_w.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, 0)), _s.set(s, s * sy, s));
    embers.setMatrixAt(ne, _m);
    embers.setColorAt(ne, col);
    ne++;
  };

  // crown of sparks: N golden sparks (alternating high / low points, like a crown) circling above the flame, each
  // with a short fading trail. Assembling (crownT 0 -> ~1.3 s) they shoot up out of the fire one after another.
  const CROWN_N = 12;
  function drawCrown(f, dt) {
    f.crownNow = damp(f.crownNow, f.crown, f.crown > f.crownNow ? 6 : 3, dt);
    if (f.crown > 0) f.crownT += dt;
    const vis = f.crownNow * f.heatNow;
    if (vis < 0.02) return;
    f.base.decompose(_p, _q, _s);
    const sc = _s.y * f.sizeS.value;
    // the flame's thin tip pokes up through the middle of the crown
    const H = Math.max(0.6, flameTop(f)) * 0.86 + 0.06;
    const R = 0.4 * sc;
    const spin = time * 0.7;
    const sk = Math.min(1.5, sc);
    for (let i = 0; i < CROWN_N; i++) {
      const k = clamp((f.crownT - i * 0.07) / 0.62);
      if (k <= 0) continue;
      const a = spin + (i / CROWN_N) * Math.PI * 2;
      const tall = i % 2 === 0;
      const bob = 0.025 * Math.sin(time * 3.1 + i * 1.7);
      const tx = _p.x + Math.cos(a) * R, tz = _p.z + Math.sin(a) * R, ty = _p.y + H + bob;
      // fly from the heart of the fire along an arc, overshoot a touch, settle
      const ke = ease.backOut(k, 1.6);
      const x = _p.x + (tx - _p.x) * ke, z = _p.z + (tz - _p.z) * ke;
      const y = _p.y + 0.4 * sc + (ty - _p.y - 0.4 * sc) * ease.cubicOut(k) + Math.sin(k * Math.PI) * 0.25;
      const tw = 1 + 0.12 * Math.sin(time * 9 + i * 2.3);
      // crown points: upright golden spikes, tall and short in turn, standing on the band
      const s = (tall ? 0.05 : 0.04) * sk * tw * vis * (k < 1 ? 0.7 + 0.5 * k : 1);
      const sy = tall ? 2.6 : 1.7;
      pushEmber(x, y + s * sy * 0.7, z, s, sy, 0, a, _c.copy(G0).lerp(G1, 0.72 + 0.2 * Math.sin(time * 5 + i)));
      if (k < 1) continue;
      // the band: two small sparks between this point and the next, glowing orange-gold
      for (let j = 1; j <= 2; j++) {
        const aj = a + (j / 3) * (Math.PI * 2 / CROWN_N);
        pushEmber(_p.x + Math.cos(aj) * R, ty, _p.z + Math.sin(aj) * R, 0.026 * sk * vis, 1, j, aj, _c.copy(G1).lerp(G2, 0.35 + 0.3 * Math.sin(time * 4 + i + j)));
      }
    }
  }

  function update(dt) {
    time += dt;
    let nt = 0, ng = 0;
    for (const f of fires) {
      f.heatNow = damp(f.heatNow, f.heat, f.heat > f.heatNow ? 5 : 3, dt);
      const b = f.boost.update(dt);
      f.sizeS.target = f.size; f.stretchS.target = f.stretch; f.glowS.target = f.glowRadius;
      const sz = f.sizeS.update(dt), str = Math.max(0.3, f.stretchS.update(dt)), gr = Math.max(0.1, f.glowS.update(dt));
      for (let i = 0; i < f.tongues.length; i++) { const g = f.tongues[i].g; g.target = i < f.active ? 1 : 0; g.update(dt); }
      f.glowFlash = Math.max(0, f.glowFlash - dt * 1.4);
      const heat = f.heatNow;
      if (!f.visible || heat < 0.02) continue;
      f.base.decompose(_p, _q, _s);
      const fsz = sz * (1 + Math.max(-0.4, b));
      const fst = str * (1 + Math.max(-0.3, b) * 0.35);
      const flick = 1 + 0.05 * Math.sin(time * 9.1 + (f.tongues[0]?.ph || 0)) + 0.04 * Math.sin(time * 14.3);
      for (const t of f.tongues) {
        if (nt >= MAXT) break;
        const gv = t.g.value;
        if (gv <= 0.02) continue;
        const k = time * t.sp;
        const fl = 1 + 0.16 * Math.sin(k * 6.2 + t.ph) + 0.09 * Math.sin(k * 13.7 + t.ph * 1.7) + 0.05 * Math.sin(k * 23.1 + t.ph * 0.3);
        const hk = (0.35 + 0.65 * heat) * heat;
        const h = t.h * fsz * fst * fl * hk * gv, w = t.w * fsz * (0.7 + 0.3 * heat) * (1.06 - 0.06 * fl) * Math.min(1.15, gv);
        _e.set(0.13 * Math.sin(k * 4.3 + t.ph), t.yaw + k * 0.6, 0.13 * Math.sin(k * 3.7 + t.ph * 1.3));
        _l.compose(_w.set(t.x * fsz, 0, t.z * fsz), _q.setFromEuler(_e), _s.set(w, h, w));
        _m.multiplyMatrices(f.base, _l);
        flames.setMatrixAt(nt, _m);
        flames.setColorAt(nt, t.tint);
        nt++;
      }
      // embers + the spark column
      f.emberAcc += dt * f.emberRate * heat * (1 + Math.max(0, b) * 3);
      while (f.emberAcc >= 1) { f.emberAcc -= 1; spawnEmber(f, heat); }
      if (f.column > 0) {
        f.columnAcc += dt * f.column * heat * (mobile ? 0.75 : 1) * (1 + Math.max(0, b) * 2);
        while (f.columnAcc >= 1) { f.columnAcc -= 1; spawnSpark(f); }
      }
      // ground glow (its radius swells past the new size on a level-up, then settles)
      if (ng < MAXG && f.glowStrength > 0) {
        f.base.decompose(_p, _q, _s);
        const r = gr * (0.75 + 0.25 * heat) * (1 + Math.max(-0.3, b) * 0.35) * flick;
        _m.compose(_w.set(_p.x, 0.02, _p.z), _q.identity(), _s.set(r * 2, 1, r * 2));
        glows.setMatrixAt(ng, _m);
        _c.copy(f.glowColor).multiplyScalar(f.glowStrength * heat * flick * (1 + Math.max(0, b) * 0.8 + f.glowFlash));
        glows.setColorAt(ng, _c);
        ng++;
      }
    }
    flames.count = nt; flames.visible = nt > 0;
    if (nt) { flames.instanceMatrix.needsUpdate = true; flames.instanceColor.needsUpdate = true; }
    glows.count = ng; glows.visible = ng > 0;
    if (ng) { glows.instanceMatrix.needsUpdate = true; glows.instanceColor.needsUpdate = true; }

    // embers drift up, wobble, shrink; column sparks spiral up fast and cool from white to orange
    ne = 0;
    for (let i = parts.length - 1; i >= 0; i--) {
      const e = parts[i];
      e.age += dt;
      if (e.age >= e.life) { parts.splice(i, 1); continue; }
      if (e.kind === 1) {
        e.vy = damp(e.vy, 0.5, 0.9, dt);
        e.y += e.vy * dt;
        e.a += e.w * dt;
        e.r += dt * 0.07;
      } else {
        e.vy = damp(e.vy, 0.25, 1.2, dt);
        e.x += (e.vx + Math.sin(e.age * 5 + e.ph) * 0.18) * dt; e.y += e.vy * dt; e.z += e.vz * dt;
      }
    }
    for (const e of parts) {
      const k = e.age / e.life;
      if (e.kind === 1) {
        const s = e.size * (k < 0.1 ? 0.5 + 5 * k : Math.pow(1 - (k - 0.1) / 0.9, 0.7));
        _c.copy(S0).lerp(S1, Math.min(1, k * 2));
        if (k > 0.5) _c.lerp(S2, (k - 0.5) * 2);
        pushEmber(e.cx + Math.cos(e.a) * e.r, e.y, e.cz + Math.sin(e.a) * e.r, s, 1.6, 0, e.a, _c);
      } else {
        const s = e.size * (k < 0.15 ? 0.6 + 0.4 * (k / 0.15) : Math.pow(1 - (k - 0.15) / 0.85, 0.8));
        pushEmber(e.x, e.y, e.z, s, 1.3, e.age * 3 + e.ph, e.age * 2, _c.copy(E0).lerp(E1, Math.min(1, k * 1.3)));
      }
    }
    for (const f of fires) if (f.crown > 0 || f.crownNow > 0.02) drawCrown(f, dt);
    embers.count = ne; embers.visible = ne > 0;
    if (ne) { embers.instanceMatrix.needsUpdate = true; embers.instanceColor.needsUpdate = true; }
  }

  return { add, remove, update, burst, burstColumn, fires, meshes: [flames, embers, glows] };
}
