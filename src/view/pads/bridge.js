// Bridges assembling plank by plank. Same look as terrain.js buildBridges (stringers, planks across, posts with
// caps, a sagging rope rail), but every part is an instance that animates in:
//   stringers slide out over the water -> planks fly in from the shore pad one by one, spin into line and land
//   with a squash + a little hop -> posts rise out of the water with a splash -> rope rails string themselves
//   post to post and settle with a wobble.
// While assembling: 5 InstancedMeshes. Once settled everything is baked into ONE merged mesh (vertex colours,
// flat-shaded Lambert, exactly like the terrain's bridges) and the instanced parts are dropped.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ease, clamp, lerp, arc } from '../../util/anim.js';
import { bridgeLayout, bridgeFrame } from './ghosts.js';

const BRIDGE_Y = -0.02;
const POST_TOP = 0.15;
const ROPE_SEGS = 4;
const FLIGHT = 0.38;      // plank flight time (s)
const FIRST_LAND = 0.24;  // first plank lands this long after bridge:start

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _y = new THREE.Vector3(0, 1, 0), _d = new THREE.Vector3();

function rngOf(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
const hashId = id => [...String(id)].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);

export function createBridges(ctx, { quality }) {
  const { scene, config, views } = ctx;
  const P = config.PALETTE;
  const mobile = quality?.tier === 'mobile';
  const geos = {
    stringer: new THREE.BoxGeometry(1, 0.06, 0.07),
    plank: new THREE.BoxGeometry(0.17, 0.045, 1),
    post: new THREE.CylinderGeometry(0.048, 0.056, POST_TOP + 0.8, 7),
    cap: new THREE.CylinderGeometry(0.058, 0.058, 0.035, 7),
    rope: new THREE.CylinderGeometry(0.011, 0.011, 1, 5),
  };
  for (const g of Object.values(geos)) g.deleteAttribute('uv');
  const instMat = new THREE.MeshLambertMaterial({ flatShading: true });
  const finalMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const wood = new THREE.Color(P.wood), woodDark = new THREE.Color(P.woodDark), rope = new THREE.Color('#f1dfb4');

  const bridges = new Map(); // id -> state

  function build(bridge, { shore = null, instant = false } = {}) {
    if (bridges.has(bridge.id)) return bridges.get(bridge.id);
    const rng = rngOf(hashId(bridge.id) + 7);
    const layout = bridgeLayout(bridge.tiles, bridge.orientation, rng);
    const fr = bridgeFrame(bridge.tiles, bridge.orientation, shore);
    const jit = (c, amt) => c.clone().offsetHSL((rng() - 0.5) * 0.02, (rng() - 0.5) * 0.06, (rng() - 0.5) * amt);
    const w = { x: 0, z: 0 };
    const shoreAt = shore ? { x: shore.x, z: shore.z } : fr.toWorld(-1, 0, { x: 0, z: 0 });
    const N = layout.planks.length;
    const spacing = clamp(0.82 / Math.max(1, N - 1), 0.05, 0.11);

    // ---- parts with final transforms + animation timing ----
    const parts = { stringer: [], plank: [], post: [], cap: [], rope: [] };
    const L = layout.u1 - layout.u0 + 0.2;
    for (const v of [-0.3, 0.3]) parts.stringer.push({ v, color: woodDark.clone() });
    layout.planks.forEach((pl, i) => {
      fr.toWorld(pl.u, pl.v, w);
      const color = wood.clone().offsetHSL(pl.tint[0], pl.tint[1], pl.tint[2]);
      parts.plank.push({
        i, x: w.x, z: w.z, y: BRIDGE_Y - 0.0225 + pl.dy, yaw: fr.yaw + pl.rot, len: pl.len, color,
        land: FIRST_LAND + i * spacing,
        // flight start: the plank stack on the shore pad, a little scattered
        sx: shoreAt.x + (rng() - 0.5) * 0.25, sz: shoreAt.z + (rng() - 0.5) * 0.25, sy: 0.3 + rng() * 0.12,
        spinYaw: (rng() < 0.5 ? -1 : 1) * (0.9 + rng() * 0.7), roll: (rng() - 0.5) * 0.5, h: 0.5 + rng() * 0.14,
        landed: false,
      });
    });
    const lastLand = FIRST_LAND + (N - 1) * spacing;
    const postStart = lastLand + 0.12;
    layout.postU.forEach((u, j) => {
      for (const v of [-0.47, 0.47]) {
        fr.toWorld(u, v, w);
        const t0 = postStart + j * 0.075 + (v > 0 ? 0.03 : 0);
        parts.post.push({ x: w.x, z: w.z, t0, color: jit(woodDark, 0.05), splashed: false });
        parts.cap.push({ x: w.x, z: w.z, t0, color: jit(wood, 0.04) });
      }
    });
    const spans = [];
    for (const v of [-0.47, 0.47]) {
      for (let k = 0; k < layout.postU.length - 1; k++) {
        const t0 = postStart + (k + 1) * 0.075 + 0.32 + (v > 0 ? 0.04 : 0);
        spans.push({ v, ua: layout.postU[k], ub: layout.postU[k + 1], t0 });
      }
    }
    for (const sp of spans) for (let s = 0; s < ROPE_SEGS; s++) parts.rope.push({ span: sp, s, color: rope.clone() });
    const ropeEnd = Math.max(...spans.map(s => s.t0)) + ROPE_SEGS * 0.05 + 0.12;
    const settle = ropeEnd + 0.9;

    const st = { id: bridge.id, bridge, fr, layout, parts, spans, t: 0, settle, lastLand, L, meshes: null, final: null, done: false };

    // rope point on a span at t01 along it, with an extra springy sag right after it's strung
    st.ropePoint = (sp, t01, out, time) => {
      const age = time - (sp.t0 + ROPE_SEGS * 0.05);
      const wob = age > 0 ? 1 + 1.3 * Math.exp(-4.5 * age) * Math.cos(age * 15) : 1;
      const u = sp.ua + (sp.ub - sp.ua) * t01;
      const y = POST_TOP - 0.035 - Math.sin(t01 * Math.PI) * 0.045 * wob;
      const p = fr.toWorld(u, sp.v, { x: 0, z: 0 });
      return out.set(p.x, y, p.z);
    };

    if (instant) { bake(st); return st; }

    // ---- instanced meshes for the assembly ----
    const mk = (name, cap) => {
      const m = new THREE.InstancedMesh(geos[name], instMat, cap);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      m.castShadow = !mobile; m.receiveShadow = true; m.frustumCulled = false; m.count = 0;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.name = `bridge:${bridge.id}:${name}`;
      parts[name].forEach((pp, i) => m.setColorAt(i, pp.color));
      scene.add(m);
      return m;
    };
    st.meshes = { stringer: mk('stringer', 2), plank: mk('plank', N), post: mk('post', parts.post.length), cap: mk('cap', parts.cap.length), rope: mk('rope', parts.rope.length) };
    bridges.set(bridge.id, st);
    return st;
  }

  // ---- final transforms (used by both the animation's end state and the bake) ----
  function stringerMatrix(st, pp, k, out) {
    const { fr, layout } = st;
    const len = (layout.u1 - layout.u0 + 0.0) * k;
    const uc = layout.u0 + len / 2;
    const w = fr.toWorld(uc, pp.v, { x: 0, z: 0 });
    _e.set(0, fr.yaw, 0); _q.setFromEuler(_e);
    return out.compose(_p.set(w.x, BRIDGE_Y - 0.085 - (1 - k) * 0.05, w.z), _q, _s.set(Math.max(0.001, len), 1, 1));
  }
  function plankFinal(pp, out) {
    _e.set(0, pp.yaw, 0); _q.setFromEuler(_e);
    return out.compose(_p.set(pp.x, pp.y, pp.z), _q, _s.set(1, 1, pp.len));
  }
  function postMatrix(pp, k, out) {
    // rises out of the water: k 0 -> 1 (with overshoot)
    _q.identity();
    return out.compose(_p.set(pp.x, (POST_TOP - 0.8) / 2 - (1 - k) * 0.95, pp.z), _q, _s.set(1, 1, 1));
  }
  function capMatrix(pp, k, pop, out) {
    _q.identity();
    const sc = Math.max(0.001, pop);
    return out.compose(_p.set(pp.x, POST_TOP - 0.01 - (1 - k) * 0.95, pp.z), _q, _s.set(sc, sc, sc));
  }
  function ropeMatrix(st, pp, grow, time, out) {
    const sp = pp.span;
    const t0 = pp.s / ROPE_SEGS, t1 = (pp.s + 1) / ROPE_SEGS;
    st.ropePoint(sp, t0, _a, time);
    st.ropePoint(sp, t1, _b, time);
    _b.lerpVectors(_a, _b, grow);
    _d.subVectors(_b, _a);
    const len = _d.length();
    if (len < 1e-4) return out.makeScale(0.0001, 0.0001, 0.0001);
    _q.setFromUnitVectors(_y, _d.multiplyScalar(1 / len));
    return out.compose(_p.addVectors(_a, _b).multiplyScalar(0.5), _q, _s.set(1, len + 0.004 * grow, 1));
  }

  function bake(st) {
    const list = [];
    const push = (geo, mat, color) => {
      const g = geo.toNonIndexed();
      g.applyMatrix4(mat);
      const n = g.attributes.position.count, c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { c[i * 3] = color.r; c[i * 3 + 1] = color.g; c[i * 3 + 2] = color.b; }
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
      list.push(g);
    };
    const { parts } = st;
    parts.stringer.forEach(pp => push(geos.stringer, stringerMatrix(st, pp, 1, _m), pp.color));
    parts.plank.forEach(pp => push(geos.plank, plankFinal(pp, _m), pp.color));
    parts.post.forEach(pp => push(geos.post, postMatrix(pp, 1, _m), pp.color));
    parts.cap.forEach(pp => push(geos.cap, capMatrix(pp, 1, 1, _m), pp.color));
    parts.rope.forEach(pp => push(geos.rope, ropeMatrix(st, pp, 1, 1e9, _m), pp.color));
    const geo = mergeGeometries(list, false);
    list.forEach(g => g.dispose());
    const mesh = new THREE.Mesh(geo, finalMat);
    mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = `bridge:${st.id}`;
    scene.add(mesh);
    if (st.meshes) for (const m of Object.values(st.meshes)) { scene.remove(m); m.dispose(); }
    st.meshes = null;
    st.final = mesh;
    st.done = true;
    bridges.set(st.id, st);
  }

  function step(st, dt) {
    st.t += dt;
    const t = st.t, M = st.meshes, { parts } = st;
    const fx = views.fx;
    // stringers slide out ahead of the planks
    const ks = ease.cubicOut(clamp((t - 0.02) / (st.lastLand + 0.1)));
    parts.stringer.forEach((pp, i) => M.stringer.setMatrixAt(i, stringerMatrix(st, pp, Math.max(0.02, ks), _m)));
    M.stringer.count = t > 0.02 ? 2 : 0;
    // planks
    let pc = 0;
    for (const pp of parts.plank) {
      const t0 = pp.land - FLIGHT;
      if (t < t0) break; // ordered by landing time
      const k = clamp((t - t0) / FLIGHT);
      if (k < 1) {
        const kk = ease.sineInOut(k);
        const x = lerp(pp.sx, pp.x, kk), z = lerp(pp.sz, pp.z, kk);
        const y = lerp(pp.sy, pp.y, k) + arc(k) * pp.h * (1 - k * 0.25);
        const r = 1 - ease.cubicOut(k);
        _e.set(pp.roll * r * Math.sin(k * 5), pp.yaw + pp.spinYaw * r, pp.roll * r * 0.6);
        _q.setFromEuler(_e);
        const pop = k < 0.18 ? lerp(0.6, 1, ease.backOut(k / 0.18, 2)) : 1;
        _m.compose(_p.set(x, y, z), _q, _s.set(pop, pop, pp.len * pop));
      } else {
        if (!pp.landed) {
          pp.landed = true;
          if (pp.i % 3 === 1) fx?.puff?.({ x: pp.x, y: pp.y + 0.03, z: pp.z + 0.3 }, { count: 2, size: 0.055, spread: 0.12, up: 0.2, color: '#f6e6c4' });
          if (pp.i === 0 || pp.i % 5 === 4) fx?.splash?.({ x: pp.x, y: config.WATER_Y, z: pp.z + 0.4 }, { radius: 0.35, count: mobile ? 4 : 6, size: 0.06, drops: 1 });
        }
        // squash on impact, then one small hop
        const a = t - pp.land;
        const sq = Math.exp(-14 * a) * Math.cos(a * 32) * 0.4;
        const hop = a < 0.22 ? Math.sin((a / 0.22) * Math.PI) * 0.035 : 0;
        const sy = 1 - sq, sxz = 1 / Math.sqrt(Math.max(0.3, sy));
        _e.set(0, pp.yaw, 0); _q.setFromEuler(_e);
        _m.compose(_p.set(pp.x, pp.y + hop, pp.z), _q, _s.set(sxz, sy, pp.len * (1 + (sxz - 1) * 0.3)));
      }
      M.plank.setMatrixAt(pc++, _m);
    }
    M.plank.count = pc;
    // posts + caps
    let qc = 0;
    parts.post.forEach((pp, i) => {
      if (t < pp.t0) return;
      const a = t - pp.t0;
      const k = ease.backOut(clamp(a / 0.4), 1.9);
      if (!pp.splashed) { pp.splashed = true; fx?.splash?.({ x: pp.x, y: config.WATER_Y, z: pp.z }, { radius: 0.26, count: mobile ? 3 : 5, size: 0.055, drops: 1 }); }
      M.post.setMatrixAt(qc, postMatrix(pp, k, _m));
      const cp = parts.cap[i];
      const pop = a < 0.3 ? 0.4 : lerp(0.4, 1, ease.backOut(clamp((a - 0.3) / 0.22), 2.6));
      M.cap.setMatrixAt(qc, capMatrix(cp, k, pop, _m));
      M.post.setColorAt(qc, pp.color); M.cap.setColorAt(qc, cp.color);
      qc++;
    });
    M.post.count = qc; M.cap.count = qc;
    if (qc) { M.post.instanceColor.needsUpdate = true; M.cap.instanceColor.needsUpdate = true; }
    // ropes: each span strings itself segment by segment, then the sag wobbles to rest
    let rc = 0;
    for (const pp of parts.rope) {
      const s0 = pp.span.t0 + pp.s * 0.05;
      if (t < s0) continue;
      const grow = ease.quadOut(clamp((t - s0) / 0.12));
      M.rope.setMatrixAt(rc, ropeMatrix(st, pp, grow, t, _m));
      M.rope.setColorAt(rc, pp.color);
      rc++;
    }
    M.rope.count = rc;
    if (rc) M.rope.instanceColor.needsUpdate = true;
    for (const m of Object.values(M)) m.instanceMatrix.needsUpdate = true;
    if (t >= st.settle) bake(st);
  }

  return {
    start(bridge, opts) { return build(bridge, opts); },
    builtInstantly(bridge, opts) { if (!bridges.has(bridge.id)) build(bridge, { ...opts, instant: true }); },
    has: id => bridges.has(id),
    object: id => bridges.get(id)?.final || null,
    get assembling() { return [...bridges.values()].filter(b => !b.done).length; },
    update(dt) {
      for (const st of bridges.values()) if (!st.done && st.meshes) step(st, dt);
    },
  };
}
