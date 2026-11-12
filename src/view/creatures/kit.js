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
// Every pooled geometry carries a per-instance `iFlash` (0..1): the diffuse blends to white and a little
// emissive is added, so a hit reads as a bright white pop without changing any materials.
export function creatureMaterial() {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = sh => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float iFlash;\nvarying float vFlash;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFlash = iFlash;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vFlash;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), vFlash * 0.85);\ntotalEmissiveRadiance += vec3(0.95, 0.97, 0.92) * vFlash * 0.75;');
  };
  m.customProgramCacheKey = () => 'creature-flash-v1';
  return m;
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
