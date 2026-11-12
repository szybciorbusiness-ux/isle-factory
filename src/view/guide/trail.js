// Ground trail: soft cream dots from the robot to the goal along the camp's BFS path, flowing toward the
// target. One InstancedMesh (one draw call). The tile path is string-pulled (walkable line of sight) and
// Chaikin-smoothed into a soft curve; dots are measured from the END of the path so they stay put on the
// ground while the robot walks along it. A light pulse runs down the dots toward the target.
// The guide decides when the trail shows; this module only draws: setPath / setVisible / update(dt).
import * as THREE from 'three';
import { clamp, damp, ease } from '../../util/anim.js';

const MAX = 80;
const SPACING = 0.48;     // world units between dots
const FLOW = 1.05;        // dots slide toward the target (units / s)
const DOT = 0.28;         // dot size (world units)
const START_GAP = 0.5;    // keep the dots off the robot's feet

function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  // soft contact shadow, a little lower (toward the camera)
  const sh = g.createRadialGradient(32, 37, 4, 32, 37, 27);
  sh.addColorStop(0, 'rgba(66,52,20,.30)'); sh.addColorStop(1, 'rgba(66,52,20,0)');
  g.fillStyle = sh; g.fillRect(0, 0, 64, 64);
  // warm rim + cream face with a brighter top
  g.beginPath(); g.arc(32, 31, 18.5, 0, Math.PI * 2); g.fillStyle = '#eccf98'; g.fill();
  const f = g.createLinearGradient(0, 14, 0, 46);
  f.addColorStop(0, '#fffdf4'); f.addColorStop(1, '#fff1d2');
  g.beginPath(); g.arc(32, 30, 16, 0, Math.PI * 2); g.fillStyle = f; g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function createTrail(ctx) {
  const { scene, views, mobile } = ctx;
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  // a little above the ground (and pulled toward the camera in depth) so grass blades don't cut into the dots
  const mat = new THREE.MeshBasicMaterial({ map: dotTexture(), transparent: true, depthWrite: false, opacity: 0, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 });
  const mesh = new THREE.InstancedMesh(geo, mat, MAX);
  mesh.name = 'guide-trail';
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  mesh.castShadow = false; mesh.receiveShadow = false;
  scene.add(mesh);

  const size = DOT * (mobile ? 1.12 : 1);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3(), pv = new THREE.Vector3();
  const st = {
    pts: null, cum: null, len: 0,   // current smoothed polyline + cumulative lengths
    vis: 0, want: 0,                // drawn opacity / target
    reveal: 0,                      // draw-on front (world units from the start)
    phase: 0, t: 0,
  };

  // Path in, as [[x, z], ...] from the robot to the end point. Smoothing happens here.
  function setPath(points, { redraw = false } = {}) {
    if (!points || points.length < 2) { st.pts = null; st.len = 0; return; }
    const pts = chaikin(chaikin(points));
    const cum = new Float32Array(pts.length);
    for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    st.pts = pts; st.cum = cum; st.len = cum[pts.length - 1];
    if (redraw) st.reveal = 0;
  }
  // position at distance d from the start
  function at(d, out) {
    const { pts, cum } = st;
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
    const seg = cum[hi] - cum[lo] || 1, k = clamp((d - cum[lo]) / seg);
    out[0] = pts[lo][0] + (pts[hi][0] - pts[lo][0]) * k;
    out[1] = pts[lo][1] + (pts[hi][1] - pts[lo][1]) * k;
    return out;
  }

  const p2 = [0, 0];
  function update(dt) {
    st.t += dt;
    st.vis = damp(st.vis, st.want, st.want > st.vis ? 7 : 5, dt);
    st.phase = (st.phase + dt * FLOW) % SPACING;
    if (st.pts) st.reveal = Math.min(st.len + 1, st.reveal + dt * 14);
    if (!st.pts || st.vis < 0.01) { mesh.count = 0; mesh.visible = false; return; }
    mesh.visible = true;
    mat.opacity = clamp(st.vis);
    const L = st.len;
    let n = 0;
    // distances from the END: e_i = (i + 1) * SPACING - phase (they shrink over time -> flow to the target)
    for (let i = 0; n < MAX; i++) {
      const e = (i + 1) * SPACING - st.phase - SPACING * 0.5;
      if (e > L - START_GAP) break;
      if (e < 0.02) continue;
      const d = L - e;                      // distance from the start
      const born = clamp((L - START_GAP - e) / 0.55);        // grows in near the robot
      const land = clamp(e / 0.5);                            // shrinks into the target
      const drawn = clamp((st.reveal - d) / 0.6);             // draw-on from the robot outward
      const pulse = Math.pow(Math.max(0, Math.cos(2 * Math.PI * (e / 3.4 + st.t * 0.85))), 6);
      const k = ease.cubicOut(born) * ease.quadOut(land) * ease.backOut(drawn, 2.2);
      if (k <= 0.01) continue;
      at(d, p2);
      const gy = views.terrain?.groundHeight?.(p2[0], p2[1]);
      const s = size * k * (1 + 0.26 * pulse) * (0.75 + 0.25 * st.vis);
      pv.set(p2[0], (Number.isFinite(gy) ? gy : 0) + 0.15 + 0.02 * pulse, p2[1]);
      sv.set(s, 1, s);
      m4.compose(pv, q, sv);
      mesh.setMatrixAt(n++, m4);
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
  }

  return {
    mesh, setPath, update,
    setVisible(v) { st.want = clamp(v); },
    get opacity() { return st.vis; },
    get length() { return st.len; },
    get dots() { return mesh.count; },
    dispose() { scene.remove(mesh); geo.dispose(); mat.map?.dispose(); mat.dispose(); mesh.dispose?.(); },
  };
}

// Chaikin corner cutting (keeps the end points).
function chaikin(pts) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
  }
  out.push(pts[pts.length - 1]);
  // the first and last cut points hug the end points too closely: drop them
  out.splice(1, 1); out.splice(out.length - 2, 1);
  return out;
}
