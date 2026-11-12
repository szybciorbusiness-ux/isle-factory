// Creature toolkit: a vertex-coloured part collector (one merged geometry per moving part), the shared
// Lambert material with a per-instance white "hit flash", instanced part pools fed from invisible Object3D
// rigs, and the soft contact-shadow texture. Owned by the creatures module (src/view/creatures.js).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _c = new THREE.Color(), _c2 = new THREE.Color();
const smooth = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

// Small deterministic PRNG (per creature, so headless shots are reproducible).
export function rng(seed = 1) {
  let s = (Math.imul(seed | 0, 2654435761) >>> 0) || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
export const hashStr = str => { let h = 2166136261; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619); return h >>> 0; };

// ---------- part collector ----------
// add(geo, colour, { p, r, s, flat, faceColor(cx,cy,cz,nx,ny,nz) -> colour|null, jitter, seed, ao:false|{y0,y1,min} })
export class Parts {
  constructor({ ao = null } = {}) { this.geos = []; this.ao = ao; }
  add(geo, color, o = {}) {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    geo.dispose();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    const s = o.s === undefined ? 1 : o.s;
    _e.set(...(o.r || [0, 0, 0]));
    _m.compose(_p.set(...(o.p || [0, 0, 0])), _q.setFromEuler(_e), Array.isArray(s) ? _s.set(...s) : _s.set(s, s, s));
    g.applyMatrix4(_m);
    if (o.flat || !g.attributes.normal) g.computeVertexNormals(); // non-indexed -> face normals (faceted)
    const pos = g.attributes.position, nor = g.attributes.normal, n = pos.count;
    const cols = new Float32Array(n * 3);
    const base = new THREE.Color(color);
    const r = rng(o.seed || 7);
    const ao = o.ao === false ? null : (o.ao || this.ao);
    for (let t = 0; t < n; t += 3) {
      _c.copy(base);
      if (o.faceColor) {
        const cx = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3, cy = (pos.getY(t) + pos.getY(t + 1) + pos.getY(t + 2)) / 3, cz = (pos.getZ(t) + pos.getZ(t + 1) + pos.getZ(t + 2)) / 3;
        const fc = o.faceColor(cx, cy, cz, nor.getX(t), nor.getY(t), nor.getZ(t));
        if (fc) _c.set(fc);
      }
      if (o.jitter) _c.multiplyScalar(1 + (r() * 2 - 1) * o.jitter);
      for (let v = t; v < t + 3 && v < n; v++) {
        _c2.copy(_c);
        if (ao) _c2.multiplyScalar(ao.min + (1 - ao.min) * smooth(ao.y0, ao.y1, pos.getY(v)));
        cols[v * 3] = _c2.r; cols[v * 3 + 1] = _c2.g; cols[v * 3 + 2] = _c2.b;
      }
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    this.geos.push(g);
    return this;
  }
  merge() {
    const g = mergeGeometries(this.geos, false);
    this.geos.forEach(x => x.dispose());
    this.geos = [];
    g.computeBoundingBox(); g.computeBoundingSphere();
    return g;
  }
}

// ---------- shapes (all centred unless noted) ----------
export const ball = (r = 1, w = 10, h = 8) => new THREE.SphereGeometry(r, w, h);
// Tapered limb hanging from its pivot at y = 0 down to y = -len.
export const limb = (rTop, rBot, len, seg = 6) => new THREE.CylinderGeometry(rTop, rBot, len, seg, 1).translate(0, -len / 2, 0);
// Tapered stick standing on y = 0 up to y = len.
export const stick = (rBot, rTop, len, seg = 6) => new THREE.CylinderGeometry(rTop, rBot, len, seg, 1).translate(0, len / 2, 0);
export const cone = (r, h, seg = 6) => new THREE.ConeGeometry(r, h, seg, 1).translate(0, h / 2, 0);
export const capsule = (r, len, cap = 3, radial = 8) => new THREE.CapsuleGeometry(r, len, cap, radial);
// Lathe of [[r, y], ...] around +y.
export const lathe = (pts, seg = 14) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(Math.max(0.0005, r), y)), seg);

// ---------- material: Lambert + per-instance white flash ----------
// Every instance carries a white "hit flash" (0..1): the diffuse blends to white and a little emissive is added,
// so a hit reads as a bright white pop without changing any materials. Batched (PartBatch): the flash rides in
// the per-instance colour's alpha as 1 - flash (opaque output ignores alpha). Instanced fallback (PartPool):
// a per-instance `iFlash` attribute.
export function creatureMaterial() {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n#ifndef USE_BATCHING\nattribute float iFlash;\n#endif\nvarying float vFlash;')
      .replace('#include <begin_vertex>', [
        '#include <begin_vertex>',
        '#if defined( USE_BATCHING_COLOR )',
        'vFlash = 1.0 - getBatchingColor( getIndirectIndex( gl_DrawID ) ).a;',
        '#elif defined( USE_BATCHING )',
        'vFlash = 0.0;',
        '#else',
        'vFlash = iFlash;',
        '#endif',
      ].join('\n'));
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFlash;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), vFlash * 0.85);\ntotalEmissiveRadiance += vec3(0.95, 0.97, 0.92) * vFlash * 0.75;');
  };
  m.customProgramCacheKey = () => 'creature-flash-v2';
  return m;
}

// ---------- batched parts (the default: one draw call for many part types) ----------
// A PartBatch is one THREE.BatchedMesh holding every part geometry of a group (e.g. all bodies, heads, legs and
// tools of every species and role). Each frame the rigs push matrices into per-part slots; a slot reuses its
// instance ids in order and hides the ones it did not use this frame. With WEBGL_multi_draw the whole batch is a
// single draw call (plus one in the shadow pass when it casts), whatever the mix of species on screen.
//   const b = new PartBatch(root, mat, [[key, geometry, capHint], ...], { cast });
//   b.begin(); b.slot(key).push(matrix, flash, tint); ...; b.end();
// All geometries must share the same attributes (position, normal, color) and be non-indexed (Parts.merge()).
const _v4 = new THREE.Vector4();
class BatchSlot {
  constructor(batch, gid) { this.batch = batch; this.gid = gid; this.ids = []; this.n = 0; this.shown = 0; }
  begin() { this.n = 0; }
  push(matrix, flash = 0, tint = null) {
    const m = this.batch.mesh;
    let id = this.ids[this.n];
    if (id === undefined) { id = this.batch.alloc(this.gid); this.ids.push(id); }
    this.n++;
    m.setMatrixAt(id, matrix);
    if (tint) _v4.set(tint.r, tint.g, tint.b, 1 - flash); else _v4.set(1, 1, 1, 1 - flash);
    m.setColorAt(id, _v4);
    m.setVisibleAt(id, true);   // no-op when already visible
  }
  end() {
    const m = this.batch.mesh;
    for (let i = this.n; i < this.shown; i++) m.setVisibleAt(this.ids[i], false);
    this.shown = this.n;
    return this.n;
  }
}
export class PartBatch {
  constructor(parent, material, entries, { cast = false, receive = true, name = 'creatures:batch' } = {}) {
    let verts = 0, cap = 0;
    for (const [, g, c] of entries) { verts += g.attributes.position.count; cap += c || 8; }
    const m = new THREE.BatchedMesh(Math.max(16, cap), verts, verts, material);
    m.perObjectFrustumCulled = false;   // a few hundred small parts: culling and sorting cost more CPU than they save
    m.sortObjects = false;
    m.frustumCulled = false;
    m.castShadow = cast; m.receiveShadow = receive; m.name = name;
    m.visible = false;
    m.raycast = () => {};               // rewritten every frame: never a pick target
    this.mesh = m; this.parent = parent;
    this.slots = new Map();
    for (const [key, g] of entries) this.slots.set(key, new BatchSlot(this, m.addGeometry(g)));
    this.count = 0;
    parent.add(m);
  }
  slot(key) { return this.slots.get(key); }
  alloc(gid) {
    const m = this.mesh;
    if (m.instanceCount >= m.maxInstanceCount) m.setInstanceCount(m.maxInstanceCount * 2);
    return m.addInstance(gid);
  }
  begin() { for (const s of this.slots.values()) s.begin(); }
  end() {
    let n = 0;
    for (const s of this.slots.values()) n += s.end();
    this.count = n;
    this.mesh.visible = n > 0;
  }
  dispose() { this.parent.remove(this.mesh); this.mesh.dispose(); }
}
// True when BatchedMesh can draw a whole batch in one call (WebGL2 + WEBGL_multi_draw). Without the extension
// three loops one draw per instance, so the instanced PartPools are the better fallback there.
export function canBatch(renderer) {
  try { return !!THREE.BatchedMesh && !!renderer?.extensions?.has?.('WEBGL_multi_draw'); } catch { return false; }
}

// ---------- blinks ----------
// Lid closure 0..1 for one creature: a quick blink every few seconds (now and then a double blink), plus a
// held "squint" for expressions (eyes squeezed on a hit, happy closed eyes while munching).
export class Blink {
  constructor(rnd, { every = [2.2, 5.5] } = {}) {
    this.rnd = rnd; this.every = every;
    this.wait = 0.6 + rnd() * every[1]; this.t = -1; this.gap = 0; this.again = false;
    this.squint = 0; this.squintT = 0; this.hold = 0;
    this.value = 0;
  }
  // a closed-eyes beat: hold `dur` seconds at `amount`
  close(dur = 0.18, amount = 1) { this.hold = Math.max(this.hold, dur); this.squintT = Math.max(this.squintT, amount); }
  update(dt, want = 0) {
    if (this.gap > 0) { this.gap -= dt; if (this.gap <= 0) this.t = 0; }
    else if (this.t < 0) {
      this.wait -= dt;
      if (this.wait <= 0) { this.t = 0; this.again = this.rnd() < 0.18; this.wait = this.every[0] + this.rnd() * (this.every[1] - this.every[0]); }
    }
    let b = 0;
    if (this.t >= 0) {
      const t = (this.t += dt);
      // shut fast (55 ms), hold a beat (45 ms), open a little slower (95 ms)
      if (t < 0.055) b = smooth(0, 1, t / 0.055);
      else if (t < 0.1) b = 1;
      else if (t < 0.195) b = 1 - smooth(0, 1, (t - 0.1) / 0.095);
      else { this.t = -1; if (this.again) { this.again = false; this.gap = 0.07; } } // now and then a double blink
    }
    this.hold -= dt;
    if (this.hold <= 0) this.squintT = 0;
    const sq = Math.max(this.squintT, want);
    this.squint += (sq - this.squint) * (1 - Math.exp(-(sq > this.squint ? 40 : 14) * dt));
    this.value = Math.max(b, this.squint);
    return this.value;
  }
}

// One eyelid instance matrix: the lid is a white unit ball (tinted with the coat) that grows down from the top of
// the eye as `c` goes 0 -> 1. eye = { p: [x, y, z], r, s: [sx, sy, sz] } in head space; side = -1 | 1 (z mirror).
const _lm = new THREE.Matrix4(), _lp = new THREE.Vector3(), _ls = new THREE.Vector3(), _lq = new THREE.Quaternion();
export const LID_GROW = 1.2;
export function lidMatrix(out, headMatrix, eye, side, c) {
  const k = LID_GROW, ry = eye.r * eye.s[1] * k;
  const cc = Math.max(0.02, c);
  _lp.set(eye.p[0] + eye.r * 0.08, eye.p[1] + ry * (1 - cc), side * eye.p[2]);
  _ls.set(eye.r * eye.s[0] * k, ry * cc, eye.r * eye.s[2] * k);
  _lm.compose(_lp, _lq.identity(), _ls);
  return out.multiplyMatrices(headMatrix, _lm);
}

// ---------- instanced pools ----------
// A pool is one InstancedMesh (one draw call) that is refilled every frame from rig nodes:
//   pool.begin(); pool.push(node.matrixWorld, flash, tint); ...; pool.end();
// It grows (rebuilds the mesh) if more instances are pushed than it holds.
export class PartPool {
  constructor(parent, geometry, material, cap, { cast = false, receive = true, flash = true, name = 'creature-part', renderOrder = 0 } = {}) {
    this.parent = parent; this.geometry = geometry; this.material = material;
    this.opts = { cast, receive, flash, name, renderOrder };
    this.n = 0; this.wantCap = 0;
    this._build(Math.max(1, cap));
  }
  _build(cap) {
    if (this.mesh) { this.parent.remove(this.mesh); this.mesh.dispose(); }
    const { cast, receive, flash, name, renderOrder } = this.opts;
    this.cap = cap;
    if (flash) {
      this.flash = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
      this.flash.setUsage(THREE.DynamicDrawUsage);
      this.geometry.setAttribute('iFlash', this.flash);
    }
    const m = new THREE.InstancedMesh(this.geometry, this.material, cap);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
    m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    m.count = 0; m.visible = false; m.frustumCulled = false;
    m.castShadow = cast; m.receiveShadow = receive; m.name = name; m.renderOrder = renderOrder;
    m.raycast = () => {};   // refilled every frame (stale bounds): never a pick target
    this.mesh = m;
    this.parent.add(m);
  }
  begin() { this.n = 0; this.wantCap = 0; }
  push(matrix, flash = 0, tint = null) {
    if (this.n >= this.cap) { this.wantCap = this.n + 1; return; }
    const i = this.n++;
    this.mesh.setMatrixAt(i, matrix);
    if (this.flash) this.flash.array[i] = flash;
    if (tint) this.mesh.instanceColor.setXYZ(i, tint.r, tint.g, tint.b);
    else this.mesh.instanceColor.setXYZ(i, 1, 1, 1);
  }
  end() {
    if (this.wantCap) { this._build(Math.max(this.cap * 2, this.wantCap + 4)); return; } // refilled next frame
    const m = this.mesh;
    if (this.n || m.count) {
      m.count = this.n;
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor.needsUpdate = true;
      if (this.flash) this.flash.needsUpdate = true;
    }
    m.visible = this.n > 0;
  }
  dispose() { this.parent.remove(this.mesh); this.mesh.dispose(); }
}

// Soft radial contact-shadow texture (tinted blue-green, never black).
export function shadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(22,52,58,0.95)');
  grd.addColorStop(0.5, 'rgba(22,52,58,0.55)');
  grd.addColorStop(1, 'rgba(22,52,58,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
