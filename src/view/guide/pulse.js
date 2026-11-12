// The 'wait' marker: when the goal is to stand by a busy station's pile until its output is ready, the bouncing
// arrow would say "go, go, go". This says "here, it's coming": a calm ring with a warm-brown edge lying on
// the ground around the pile in the guide's orange, breathing slowly, with a soft echo ring drifting out of it
// every couple of seconds.
// Fades / scales in and out on springs; everything moves from update(dt). Three small draw calls.
import * as THREE from 'three';
import { Spring, clamp, ease, damp } from '../../util/anim.js';

const ORANGE = '#ff9a2e', CREAM = '#fff4dc', LINE = '#5b3a21';
const BREATH = 2.1;   // s per breath
const R = 0.68;       // ring radius (tiles): just outside the pile's heap

export function createPulse(ctx, { scale = 1 } = {}) {
  const { scene, views } = ctx;
  const flat = g => { g.rotateX(-Math.PI / 2); return g; };
  const ringGeo = flat(new THREE.RingGeometry(R - 0.085, R, 56));
  const lineGeo = flat(new THREE.RingGeometry(R - 0.115, R + 0.03, 56));
  const echoGeo = flat(new THREE.RingGeometry(R - 0.035, R, 56));
  const mk = (color, order) => new THREE.MeshBasicMaterial({
    color, transparent: true, depthWrite: false, opacity: 0, fog: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 - order,
  });
  const mLine = mk(LINE, 0), mRing = mk(ORANGE, 1), mEcho = mk(CREAM, 2);
  const root = new THREE.Group();
  root.name = 'guide-pulse';
  const line = new THREE.Mesh(lineGeo, mLine); line.renderOrder = 5;
  const ring = new THREE.Mesh(ringGeo, mRing); ring.renderOrder = 6;
  const echo = new THREE.Mesh(echoGeo, mEcho); echo.renderOrder = 4;
  root.add(line, ring, echo);
  root.visible = false;
  scene.add(root);

  const vis = new Spring(0, { stiffness: 160, damping: 16 });
  const st = { want: false, x: 0, z: 0, placed: false, t: 0, gy: 0, dim: 1 };

  function update(dt, reduced = false) {
    st.t += dt;
    vis.target = st.want ? 1 : 0;
    vis.update(dt);
    const v = vis.value;
    root.visible = v > 0.004 || st.want;
    if (!root.visible) return;
    const gy = views.terrain?.groundHeight?.(st.x, st.z);
    st.gy = damp(st.gy, Number.isFinite(gy) ? gy : 0, 10, dt);
    root.position.set(st.x, st.gy + 0.035, st.z);
    const ph = (st.t % BREATH) / BREATH;
    const breathe = reduced ? 0 : Math.sin(ph * Math.PI * 2);
    const s = (0.7 + 0.3 * clamp(v, 0, 1.2)) * scale * (1 + 0.04 * breathe);
    line.scale.set(s, 1, s); ring.scale.set(s, 1, s);
    const op = clamp(v * 1.6) * st.dim;
    mRing.opacity = op * (0.85 + 0.12 * breathe);
    mLine.opacity = op * 0.6;
    // echo: drifts out and fades once per breath
    const k = reduced ? 0 : ease.cubicOut(ph);
    const es = s * (1 + 0.55 * k);
    echo.scale.set(es, 1, es);
    mEcho.opacity = reduced ? 0 : op * 0.6 * (1 - ease.quadIn(ph));
  }

  return {
    root, update,
    place(x, z) { if (!st.placed || !st.want) { st.t = 0; } st.x = x; st.z = z; st.placed = true; },
    show(on) { st.want = !!on; },
    setDim(k) { st.dim = k; },
    get visible() { return vis.value > 0.5; },
    get value() { return vis.value; },
    dispose() {
      scene.remove(root);
      for (const g of [ringGeo, lineGeo, echoGeo]) g.dispose();
      for (const m of [mLine, mRing, mEcho]) m.dispose();
    },
  };
}
