// The guide arrow: a chunky low-poly arrow in warm orange (darker orange lip on the bevel and sides) with a
// cream rim and a thin brown outer line, like a die-cut sticker made solid. It hops over the target on a
// gravity arc, squashes on a spring at the bottom of each hop, glides between targets on damped springs and
// scales out / in when the goal changes. A soft blob shadow on the ground breathes with the hop.
// Everything moves from update(dt) (anim.js Springs); five small draw calls (rim, line, body x2, shine)
// plus the shadow.
import * as THREE from 'three';
import { Spring, clamp, ease, damp } from '../../util/anim.js';

// Colours are baked into vertex colours (unlit): the arrow keeps its exact palette under any light (the cold
// hearth's grey morning, dusk) and reads like a toy. Light comes from the upper left, in the arrow's frame.
const ORANGE = '#ff8616', ORANGE_HI = '#ffa22c', LIP = '#c95406', SIDE_HI = '#ffbd5a', CREAM = '#fff4dc', LINE = '#5b3a21', SHINE = '#fff1d6';

// Arrow outline (pointing down, tip at the origin, y up, counter-clockwise) and per-corner radii.
const PTS = [[0, 0], [0.45, 0.47], [0.17, 0.47], [0.17, 0.98], [-0.17, 0.98], [-0.17, 0.47], [-0.45, 0.47]];
const RADII = [0.07, 0.08, 0.05, 0.09, 0.09, 0.05, 0.08];
const DEPTH = 0.2, BEVEL_T = 0.055, BEVEL_S = 0.045;

// Miter offset of a CCW polygon (outward by d).
function offsetPoly(pts, d) {
  const n = pts.length;
  return pts.map((c, i) => {
    const p = pts[(i + n - 1) % n], q = pts[(i + 1) % n];
    let ax = c[0] - p[0], az = c[1] - p[1]; let l = Math.hypot(ax, az); ax /= l; az /= l;
    let bx = q[0] - c[0], bz = q[1] - c[1]; l = Math.hypot(bx, bz); bx /= l; bz /= l;
    const n1x = az, n1z = -ax, n2x = bz, n2z = -bx;
    const k = d / (1 + n1x * n2x + n1z * n2z);
    return [c[0] + (n1x + n2x) * k, c[1] + (n1z + n2z) * k];
  });
}
// Rounded polygon shape (quadratic corners).
function roundedShape(pts, radii) {
  const n = pts.length, s = new THREE.Shape();
  const cut = (a, b, r) => { const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz), t = Math.min(r, l * 0.45) / l; return [a[0] + dx * t, a[1] + dz * t]; };
  for (let i = 0; i < n; i++) {
    const p = pts[(i + n - 1) % n], c = pts[i], q = pts[(i + 1) % n];
    const a = cut(c, p, radii[i]), b = cut(c, q, radii[i]);
    if (i === 0) s.moveTo(a[0], a[1]); else s.lineTo(a[0], a[1]);
    s.quadraticCurveTo(c[0], c[1], b[0], b[1]);
  }
  s.closePath();
  return s;
}
function shell(grow, depth) {
  const g = new THREE.ExtrudeGeometry(roundedShape(offsetPoly(PTS, grow), RADII.map(r => r + grow)), {
    depth, bevelEnabled: false, curveSegments: 4,
  });
  g.translate(0, 0, -depth / 2);
  return g;
}

function shadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 31);
  grd.addColorStop(0, 'rgba(70,46,22,1)');
  grd.addColorStop(0.55, 'rgba(70,46,22,.55)');
  grd.addColorStop(1, 'rgba(70,46,22,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createArrow(ctx, { scale = 1 } = {}) {
  const { scene, camera, views } = ctx;

  // ---- geometry ----
  const body = new THREE.ExtrudeGeometry(roundedShape(PTS, RADII), {
    depth: DEPTH, bevelEnabled: true, bevelThickness: BEVEL_T, bevelSize: BEVEL_S, bevelSegments: 2, curveSegments: 4,
  });
  body.translate(0, 0, -DEPTH / 2);
  body.computeBoundingBox();
  const tipLift = -body.boundingBox.min.y; // the bevel pushes the tip below 0: lift so the tip sits at y = 0
  body.translate(0, tipLift, 0);
  const frontZ = DEPTH / 2 + BEVEL_T;
  bakeColors(body);
  const RIM = 0.055, LINE_W = 0.045;
  const rimGeo = shell(BEVEL_S + RIM, DEPTH + BEVEL_T * 2 + RIM * 2); rimGeo.translate(0, tipLift, 0);
  const lineGeo = shell(BEVEL_S + RIM + LINE_W, DEPTH + BEVEL_T * 2 + (RIM + LINE_W) * 2); lineGeo.translate(0, tipLift, 0);
  // shine: a tall capsule down the left of the shaft and a small dot on the head
  const shineA = new THREE.Shape(); shineA.absarc(0, 0, 0.034, 0, Math.PI * 2, false);
  const capsule = new THREE.Shape();
  { const x0 = -0.115, x1 = -0.06, y0 = 0.56, y1 = 0.87, r = 0.0275;
    capsule.moveTo(x0, y0 + r); capsule.lineTo(x0, y1 - r); capsule.quadraticCurveTo(x0, y1, x0 + r, y1);
    capsule.quadraticCurveTo(x1, y1, x1, y1 - r); capsule.lineTo(x1, y0 + r); capsule.quadraticCurveTo(x1, y0, x1 - r, y0);
    capsule.quadraticCurveTo(x0, y0, x0, y0 + r); }
  const shineGeo = new THREE.ShapeGeometry([capsule], 3);
  const dotGeo = new THREE.ShapeGeometry(shineA, 6); dotGeo.translate(-0.27, 0.4, 0);
  const shineAll = mergeFlat([shineGeo, dotGeo]);
  shineAll.translate(0, tipLift, frontZ + 0.003);

  // ---- materials (always transparent so they can fade; drawn after the world, in a fixed order) ----
  const mBody = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, fog: false });
  const mRim = new THREE.MeshBasicMaterial({ color: CREAM, side: THREE.BackSide, transparent: true, fog: false });
  const mLine = new THREE.MeshBasicMaterial({ color: LINE, side: THREE.BackSide, transparent: true, fog: false });
  const mShine = new THREE.MeshBasicMaterial({ color: SHINE, transparent: true, depthWrite: false, fog: false });
  const mats = [mBody, mRim, mLine, mShine];

  const root = new THREE.Group();
  root.name = 'guide-arrow';
  const sway = new THREE.Group();         // turns about the arrow's own up axis (shows its thickness, no screen roll)
  const pivot = new THREE.Group();        // squash & stretch around the tip
  root.add(sway); sway.add(pivot);
  const line = new THREE.Mesh(lineGeo, mLine); line.renderOrder = 90;
  const rim = new THREE.Mesh(rimGeo, mRim); rim.renderOrder = 91;
  const bodyMesh = new THREE.Mesh(body, mBody); bodyMesh.renderOrder = 92;
  const shine = new THREE.Mesh(shineAll, mShine); shine.renderOrder = 93;
  pivot.add(line, rim, bodyMesh, shine);
  for (const m of [line, rim, bodyMesh, shine]) { m.castShadow = false; m.receiveShadow = false; }
  root.visible = false;
  scene.add(root);

  const shadowGeo = new THREE.PlaneGeometry(1, 1); shadowGeo.rotateX(-Math.PI / 2);
  const mShadow = new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, opacity: 0, fog: false });
  const shadow = new THREE.Mesh(shadowGeo, mShadow);
  shadow.renderOrder = 3;
  shadow.visible = false;
  scene.add(shadow);

  // landing ripple: a cream ring that spreads on the ground under the target when the arrow lands somewhere new
  const ringGeo = new THREE.RingGeometry(0.4, 0.5, 40); ringGeo.rotateX(-Math.PI / 2);
  const mRing = new THREE.MeshBasicMaterial({ color: CREAM, transparent: true, depthWrite: false, opacity: 0, fog: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  const ring = new THREE.Mesh(ringGeo, mRing);
  ring.renderOrder = 4;
  ring.visible = false;
  scene.add(ring);
  const RING_T = 0.6;

  // ---- motion state ----
  const px = new Spring(0, { stiffness: 95, damping: 19 });
  const pz = new Spring(0, { stiffness: 95, damping: 19 });
  const py = new Spring(0, { stiffness: 120, damping: 20 });   // tip rest height
  const vis = new Spring(0, { stiffness: 230, damping: 17 });  // 0 hidden .. 1 shown (overshoots a little: backOut)
  const squash = new Spring(0, { stiffness: 330, damping: 13 });
  const st = {
    want: false, placed: false, x: 0, z: 0, y: 1.6,
    hop: 0, hopT: 0.86, hopH: 0.26, size: 1, sizeTarget: 1,
    drop: -1,              // >= 0 while dropping in from above (s)
    swap: null,            // { t, x, z, y } scale-out then scale-in at a new spot
    t: 0, groundY: 0, shadowOn: true,
    ringT: -1, ringNext: false,
  };

  function snap(x, z, y) { px.set(x); pz.set(z); py.set(y); }

  function update(dt) {
    st.t += dt;
    // goal swap: shrink away (with a tiny anticipation grow), jump, come back
    if (st.swap) {
      st.swap.t += dt;
      if (st.swap.t >= 0.16 && !st.swap.moved) {
        st.swap.moved = true;
        snap(st.swap.x, st.swap.z, st.swap.y);
        st.hop = 0.62; // re-enter from high on the arc: it falls onto its new spot
        st.ringNext = true;
      }
      if (st.swap.t > 0.2) st.swap = null;
    }
    const swapping = !!st.swap && !st.swap.moved;
    vis.target = st.want && !swapping ? 1 : 0;
    if (swapping) vis.stiffness = 520; else vis.stiffness = 230;
    vis.update(dt);
    if (!st.swap) { px.target = st.x; pz.target = st.z; py.target = st.y; }
    px.update(dt); pz.update(dt); py.update(dt);
    squash.update(dt);
    st.size = damp(st.size, st.sizeTarget, 8, dt);

    const v = vis.value;
    st.shownT = v > 0.8 && st.drop < 0 ? (st.shownT || 0) + dt : 0;
    const shown = v > 0.004 || vis.target > 0;
    root.visible = shown;
    shadow.visible = shown && st.shadowOn;
    updateRing(dt);
    if (!shown) return;

    // hop on a gravity arc; squash spring kicked at each contact
    let lift;
    if (st.drop >= 0) {
      st.drop += dt;
      const k = clamp(st.drop / 0.46);
      lift = 2.3 * (1 - ease.quadIn(k));
      if (k >= 1) { st.drop = -1; st.hop = 0; squash.velocity -= 4.3; st.ringT = 0; }
    } else {
      const prev = st.hop;
      st.hop = (st.hop + dt / st.hopT) % 1;
      if (st.hop < prev) {                          // contact
        squash.velocity -= st.ringNext ? 3.4 : 2.3;
        if (st.ringNext) { st.ringNext = false; st.ringT = 0; }
      }
      lift = st.hopH * 4 * st.hop * (1 - st.hop);
    }
    const hopN = clamp(lift / Math.max(0.01, st.hopH));
    const x = px.value, z = pz.value, y = py.value + lift;
    root.position.set(x, y, z);

    // squash & stretch (volume preserving) + a touch of stretch while it falls fast
    const fallStretch = st.drop >= 0 ? 0.14 * clamp(st.drop / 0.46) : 0;
    const sy = clamp(1 + squash.value + fallStretch, 0.62, 1.35);
    const sxz = 1 / Math.sqrt(sy);
    const s = (0.6 + 0.4 * v) * scale * st.size;
    pivot.scale.set(sxz * s, sy * s, sxz * s);

    // screen-aligned: it points straight down on screen anywhere in the frame (a world-vertical arrow would
    // lean with the perspective near the edges); the sway turns it about its own up axis to show its depth
    camera.getWorldQuaternion(root.quaternion);
    sway.rotation.y = 0.42 * Math.sin(st.t * 1.4);
    sway.rotation.z = 0.035 * Math.sin(st.t * 1.4 + 1.2);

    const op = clamp(v * 2.4);
    for (const m of mats) m.opacity = op;

    // blob shadow on the ground under the target
    const gy = views.terrain?.groundHeight?.(x + (st.sdx || 0), z + (st.sdz || 0));
    st.groundY = damp(st.groundY, Number.isFinite(gy) ? gy : 0, 12, dt);
    st.sdx = damp(st.sdx || 0, st.gdx || 0, 10, dt); st.sdz = damp(st.sdz || 0, st.gdz || 0, 10, dt);
    shadow.position.set(x + st.sdx, st.groundY + 0.025, z + st.sdz);
    const ss = (0.7 - 0.2 * hopN) * scale * st.size * (0.6 + 0.4 * v);
    shadow.scale.set(ss, 1, ss * 0.8);
    mShadow.opacity = 0.2 * (1 - 0.45 * hopN) * op;
  }

  function updateRing(dt) {
    if (st.ringT < 0) { ring.visible = false; return; }
    st.ringT += dt;
    const k = clamp(st.ringT / RING_T);
    if (k >= 1) { st.ringT = -1; ring.visible = false; return; }
    ring.visible = true;
    ring.position.set(px.value + (st.sdx || 0), st.groundY + 0.03, pz.value + (st.sdz || 0));
    const rs = (0.55 + 1.05 * ease.cubicOut(k)) * scale * st.size;
    ring.scale.set(rs, 1, rs * 0.86);
    mRing.opacity = 0.7 * (1 - ease.quadIn(k)) * clamp(vis.value * 2);
  }

  return {
    root, shadow, ring,
    // place(x, z, tipY): where the tip rests. glide = damped move (same goal); otherwise a swap / snap.
    // ground: [x, z] of the target under the arrow (for the blob shadow) when the tip is not right above it.
    place(x, z, y, { glide = true, ground = null } = {}) {
      st.x = x; st.z = z; st.y = y;
      st.gdx = ground ? ground[0] - x : 0; st.gdz = ground ? ground[1] - z : 0;
      if (!st.placed) { snap(x, z, y); st.placed = true; return; }
      if (!glide && vis.value > 0.05) st.swap = { t: 0, x, z, y, moved: false };
      else if (!glide) snap(x, z, y);
    },
    show(on) { st.want = !!on; },
    dropIn() { st.drop = 0; vis.set(0); vis.velocity = 4; st.want = true; },
    setHop(period, height) { st.hopT = period; st.hopH = height; },
    setSize(k) { st.sizeTarget = k; },
    setShadow(on) { st.shadowOn = on; },
    update,
    get visible() { return vis.value > 0.5; },
    get value() { return vis.value; },
    // s the arrow has been fully shown and settled (not dropping in)
    get shownFor() { return st.shownT || 0; },
    get position() { return root.position; },
    dispose() {
      scene.remove(root, shadow, ring);
      for (const g of [body, rimGeo, lineGeo, shineAll, shadowGeo, ringGeo]) g.dispose();
      for (const m of [...mats, mShadow, mRing]) { m.map?.dispose?.(); m.dispose(); }
    },
  };
}

// Baked toy shading: the front cap is orange with a lighter top, the bevel and sides go lighter where they face
// up-left and into the darker lip where they face down; the back stays lip-coloured.
function bakeColors(geo) {
  const pos = geo.attributes.position, nor = geo.attributes.normal;
  const col = new Float32Array(pos.count * 3);
  const face = new THREE.Color(ORANGE), faceHi = new THREE.Color(ORANGE_HI), lip = new THREE.Color(LIP), hi = new THREE.Color(SIDE_HI);
  const c = new THREE.Color(), side = new THREE.Color(), front = new THREE.Color();
  geo.computeBoundingBox();
  const box = geo.boundingBox;
  for (let i = 0; i < pos.count; i++) {
    const nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i);
    const yk = clamp((pos.getY(i) - box.min.y) / (box.max.y - box.min.y));
    front.copy(face).lerp(faceHi, yk * 0.8);
    const lit = clamp(ny * 0.8 - nx * 0.35 + 0.5);            // 0 = facing down-right .. 1 = up-left
    side.copy(lip).lerp(hi, ease.quadIn(lit));
    const k = clamp(nz);                                       // 1 = facing the camera
    c.copy(side).lerp(front, Math.pow(k, 1.6));
    if (nz < -0.5) c.copy(lip);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

// Merge flat (non-indexed or indexed) BufferGeometries that only carry position / normal / uv.
function mergeFlat(geos) {
  const parts = geos.map(g => (g.index ? g.toNonIndexed() : g));
  const n = parts.reduce((a, g) => a + g.attributes.position.count, 0);
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, o * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  for (const g of geos) g.dispose();
  return out;
}
