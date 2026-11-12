// The printed layer of the pads: item icons, outlined numerals, name tags, cost pips and the lifted countdown
// sticker. It is drawn on a 2D canvas laid over the WebGL canvas (inside #app, under the HUD), so:
//   - the tilt-shift blur and the cold grade (post.js) never soften it,
//   - trees, Dug, workers and station ghosts never hide it (UI-STYLE: world labels are always crisp),
//   - it renders at the screen's own pixel ratio (up to 2x), not the 3D pixel budget.
// The plates themselves stay in the world (plate.js); only the ink is lifted out.
//
// pads.js fills the op list in update(dt) in world terms; the canvas is drawn from a render hook (an invisible
// object's onBeforeRender), i.e. with the camera exactly as the 3D frame sees it, after every module's update
// has moved it. So the ink never trails the world by a frame while the camera follows.
//
// Ops:
//   block  a group of atlas quads laid out in plate-local tiles (+x east, +z south; z already stretched by `zs`
//          so the print reads upright from the high camera). k = 0: printed on the ground at (gx, gy, gz).
//          k = 1: a billboarded sticker whose tail tip sits on the world point (lx, ly, lz). In between it glides.
//   tag    an atlas name-tag pill, axis-aligned, sized in CSS px, centred on a world anchor + px offset
//   pip    a small cream sticker pill: an icon breaking out of its left edge + a small brown count (or a tick)
import * as THREE from 'three';
import { INK, CREAM, CREAM_LIP } from './atlas.js';

const FONT = "'Fredoka', 'Nunito', ui-rounded, system-ui, sans-serif";
const GREEN = '#5e9e2c';

// veil(): { object, keep } - a 3D pointer drawn under this layer (the guide's arrow). Wherever it shows, the ink
// of every pad but those in `keep` (the one it points at, the one being paid) turns see-through, so the pointer
// is never lost under a label.
export function createInk({ scene, camera, renderer, atlas, maxDpr = 2, frameScale = () => 1, veil = null }) {
  const gl = renderer?.domElement;
  const host = gl?.parentElement;
  const canvas = document.createElement('canvas');
  let g = null;
  try { g = canvas.getContext('2d'); } catch { g = null; }
  if (!host || !g) return null;
  canvas.className = 'pad-ink';
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', pointerEvents: 'none', display: 'block' });
  gl.after(canvas);
  const src = atlas.canvas;

  // ---------------- op pools (no allocation per frame) ----------------
  const ops = [];
  let n = 0;
  const quadPool = [];
  let nq = 0;
  function next(type) {
    let o = ops[n];
    if (!o) { o = { quads: [] }; ops[n] = o; }
    n++;
    o.type = type; o.quads.length = 0;
    return o;
  }
  function quad() { let q = quadPool[nq]; if (!q) { q = {}; quadPool[nq] = q; } nq++; return q; }

  // text widths for the pips' counts (CSS px at 1 px font size), cached per string
  const textW = new Map();
  function measure(text) {
    let w = textW.get(text);
    if (w == null) { g.save(); g.font = `700 100px ${FONT}`; w = g.measureText(text).width / 100; g.restore(); if (fontsReady()) textW.set(text, w); }
    return w;
  }
  const fontsReady = () => { try { return document.fonts?.check?.(`700 12px Fredoka`) !== false; } catch { return true; } };

  // ---------------- render hook ----------------
  const hookGeo = new THREE.BufferGeometry();
  hookGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, -50, 0, 0, -50, 0, 0, -50, 0], 3));
  const hookMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false, transparent: true });
  const hook = new THREE.Mesh(hookGeo, hookMat);
  hook.frustumCulled = false; hook.castShadow = false; hook.receiveShadow = false;
  hook.renderOrder = 9999;
  hook.name = 'padInkHook';
  hook.onBeforeRender = (_r, _s, cam) => { if (cam === camera) { try { draw(); } catch (e) { console.error('[pads] ink', e); } } };
  scene.add(hook);

  // ---------------- projection ----------------
  const vp = new THREE.Matrix4();
  let W = 1, H = 1, dpr = 1, cssW = 1, cssH = 1;
  const P = { x: 0, y: 0, w: 1 };
  function proj(x, y, z, out = P) {
    const e = vp.elements;
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    const iw = 1 / (Math.abs(w) < 1e-6 ? 1e-6 : w);
    out.x = ((e[0] * x + e[4] * y + e[8] * z + e[12]) * iw * 0.5 + 0.5) * W;
    out.y = (0.5 - (e[1] * x + e[5] * y + e[9] * z + e[13]) * iw * 0.5) * H;
    out.w = w;
    return out;
  }
  function fit() {
    cssW = innerWidth; cssH = innerHeight;
    dpr = Math.max(1, Math.min(maxDpr, (devicePixelRatio || 1) * (frameScale() || 1)));
    const w = Math.max(1, Math.round(cssW * dpr)), h = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    W = w; H = h;
  }

  // ---- layers: anything drawn at partial alpha is drawn opaque into a scratch canvas first, then composited
  // once, so an outline never shows through its own fill (a fading sticker / pip / number stays clean) ----
  let ox0 = 0, oy0 = 0;                 // device-px origin of the current target (0, 0 on the main canvas)
  const setT = (a, b, c, d, e, f) => g.setTransform(a, b, c, d, e - ox0, f - oy0);
  const scratch = [];
  let depth = 0;
  function layer(l, t, r, b, a, fn) {
    if (!(a > 0.003)) return;
    if (a >= 0.995) { fn(); return; }
    l = Math.floor(l) - 2; t = Math.floor(t) - 2; r = Math.ceil(r) + 2; b = Math.ceil(b) + 2;
    const w = r - l, h = b - t;
    if (!(w > 0 && h > 0) || w > W * 2 || h > H * 2) { g.globalAlpha = a; fn(); return; }
    let c = scratch[depth];
    if (!c) { const cv = document.createElement('canvas'); c = { cv, g: cv.getContext('2d') }; scratch[depth] = c; }
    if (c.cv.width < w || c.cv.height < h) {
      c.cv.width = Math.max(c.cv.width, Math.ceil(w * 1.25)); c.cv.height = Math.max(c.cv.height, Math.ceil(h * 1.25));
    }
    const sg = c.g, prev = g, px = ox0, py = oy0;
    sg.setTransform(1, 0, 0, 1, 0, 0);
    sg.clearRect(0, 0, w, h);
    sg.imageSmoothingEnabled = true; sg.imageSmoothingQuality = 'high';
    sg.globalAlpha = 1;
    g = sg; ox0 = l; oy0 = t; depth++;
    try { fn(); } finally { depth--; g = prev; ox0 = px; oy0 = py; }
    setT(1, 0, 0, 1, 0, 0);
    g.globalAlpha = a;
    g.drawImage(c.cv, 0, 0, w, h, l, t, w, h);
    g.globalAlpha = 1;
  }

  // ---------------- drawing helpers (device px, absolute; setT() maps them onto the current layer) ----------------
  // atlas uv quad [u0, vTop, u1, vBot] -> source rect in atlas px (call setT(1, 0, 0, 1, 0, 0) first)
  function blit(q, x, y, w, h) {
    const aw = src.width, ah = src.height;
    const sx = q[0] * aw, sy = (1 - q[1]) * ah, sw = (q[2] - q[0]) * aw, sh = (q[1] - q[3]) * ah;
    if (sw <= 0 || sh <= 0 || !(w > 0.5) || !(h > 0.5)) return;
    g.drawImage(src, sx, sy, sw, sh, x, y, w, h);
  }
  // The sticker body (UI-STYLE), opaque (wrap it in layer() to fade it): cream face, darker lip under it, 1.5 px
  // white inner highlight at the top, a warm-brown outline around the union (body + optional tail), a soft drop
  // shadow under the lip.
  function pill(x0, y0, x1, y1, { ol, lip, tail = null, shadow = true, fill = CREAM, lipFill = CREAM_LIP, ink = INK }) {
    const w = x1 - x0, h = y1 - y0 + lip, r = Math.min(h / 2, w / 2);
    if (!(w > 1) || !(h > 1)) return;
    const tailPath = () => {
      if (!tail) return;
      const { x, y, hw } = tail;
      const by = y1 + lip - Math.max(1, lip * 0.5);
      g.moveTo(x - hw, by); g.quadraticCurveTo(x - hw * 0.25, by + (y - by) * 0.45, x, y); g.quadraticCurveTo(x + hw * 0.25, by + (y - by) * 0.45, x + hw, by); g.closePath();
    };
    setT(1, 0, 0, 1, 0, 0);
    if (shadow) {
      g.save();
      g.shadowColor = 'rgba(60, 40, 20, 0.34)'; g.shadowBlur = 7 * dpr; g.shadowOffsetY = 4 * dpr;
      g.fillStyle = ink;
      g.beginPath(); g.roundRect(x0, y0, w, h, r); tailPath(); g.fill();
      g.restore();
    }
    // outline: stroke the union twice as wide, the fills then cover its inner half
    g.lineJoin = 'round';
    g.strokeStyle = ink; g.lineWidth = ol * 2;
    g.beginPath(); g.roundRect(x0, y0, w, h, r); tailPath(); g.stroke();
    g.fillStyle = lipFill;
    g.beginPath(); g.roundRect(x0, y0, w, h, r); tailPath(); g.fill();
    g.fillStyle = fill;
    g.beginPath(); g.roundRect(x0, y0, w, h - lip, Math.min(r, (h - lip) / 2)); g.fill();
    // inner top highlight
    g.save();
    g.beginPath(); g.roundRect(x0, y0, w, h - lip, Math.min(r, (h - lip) / 2)); g.clip();
    g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillRect(x0, y0, w, Math.max(1, 1.5 * dpr));
    g.restore();
  }
  function tick(cx, cy, s, color = GREEN) {
    setT(1, 0, 0, 1, 0, 0);
    g.lineCap = 'round'; g.lineJoin = 'round';
    g.strokeStyle = INK; g.lineWidth = s * 0.42;
    const path = () => { g.beginPath(); g.moveTo(cx - s * 0.42, cy + s * 0.02); g.lineTo(cx - s * 0.1, cy + s * 0.32); g.lineTo(cx + s * 0.46, cy - s * 0.34); };
    path(); g.stroke();
    g.strokeStyle = color; g.lineWidth = s * 0.22;
    path(); g.stroke();
  }

  // ---------------- per-op drawing ----------------
  const A = { x: 0, y: 0, w: 1 }, B = { x: 0, y: 0, w: 1 }, C = { x: 0, y: 0, w: 1 };
  const margin = () => 160 * dpr;
  const offscreen = (x, y) => x < -margin() || y < -margin() || x > W + margin() || y > H + margin();

  // block frame: origin O and the screen vectors of one local tile along x (ex) and z (ez)
  const F = { ox: 0, oy: 0, exx: 0, exy: 0, ezx: 0, ezy: 0, ax: null, ay: null };
  function frame(o) {
    F.ax = null; F.ay = null;
    // ground print
    proj(o.gx, o.gy, o.gz, A);
    proj(o.gx + 1, o.gy, o.gz, B);
    proj(o.gx, o.gy, o.gz + 1, C);
    let ox = A.x, oy = A.y, exx = B.x - A.x, exy = B.y - A.y, ezx = C.x - A.x, ezy = C.y - A.y;
    const k = o.k;
    if (k > 0.0005 && o.box) {
      // billboard at the lift anchor: upright, one tile = the anchor's projected tile width (x the lift scale)
      proj(o.lx, o.ly, o.lz, A);
      proj(o.lx + 1, o.ly, o.lz, B);
      const s = Math.hypot(B.x - A.x, B.y - A.y) * o.ls;
      const bx = s, bzy = s / Math.max(0.5, o.zs);
      // sticker box (local tiles) -> its bottom edge sits `tail` px over the anchor, centred on it
      const S = o.box;
      const lox = A.x - ((S.l + S.r) / 2) * bx;
      const loy = A.y - (o.tailPx + o.lipPx + o.padPx) * dpr - S.b * bzy;
      const kv = Math.min(1, Math.max(0, k));     // positions follow the spring (overshoot reads as a pop up)
      ox += (lox - ox) * k; oy += (loy - oy) * k;
      exx += (bx - exx) * kv; exy += (0 - exy) * kv;
      ezx += (0 - ezx) * kv; ezy += (bzy - ezy) * kv;
      F.ax = A.x; F.ay = A.y;
    }
    F.ox = ox; F.oy = oy; F.exx = exx; F.exy = exy; F.ezx = ezx; F.ezy = ezy;
    return F;
  }
  const at = (f, x, z) => [f.ox + x * f.exx + z * f.ezx, f.oy + x * f.exy + z * f.ezy];
  function drawBlock(o) {
    const f = frame(o);
    if (offscreen(f.ox, f.oy)) return;
    // a lifted sticker is the countdown the player is watching: never see-through
    const lifted = o.k > 0.5;
    const S = o.box, p = o.padPx * dpr;
    let sx0 = 0, sy0 = 0, sx1 = 0, sy1 = 0;
    if (S) {
      [sx0, sy0] = at(f, S.l, S.t); [sx1, sy1] = at(f, S.r, S.b);
      sx0 -= p; sy0 -= p; sx1 += p; sy1 += p;
      if (!lifted) under(o, sx0, sy0, sx1, sy1);
    }
    const a = o.a * (lifted ? 1 : veilA(o));
    // bounds of everything in the block (quads + sticker, its tail and shadow)
    let l = sx0, t = sy0, r = sx1, b = sy1 + (o.lipPx + o.tailPx + 12) * dpr;
    for (const q of o.quads) {
      const [cx, cy] = at(f, q.x, q.z);
      const hx = (Math.abs(f.exx * q.w) + Math.abs(f.ezx * q.d)) / 2, hy = (Math.abs(f.exy * q.w) + Math.abs(f.ezy * q.d)) / 2;
      l = Math.min(l, cx - hx); r = Math.max(r, cx + hx); t = Math.min(t, cy - hy); b = Math.max(b, cy + hy);
    }
    layer(l - 12 * dpr, t - 12 * dpr, r + 12 * dpr, b, a, () => {
      // the sticker behind a lifted block
      const sa = o.stickerA;
      if (sa > 0.01 && S) {
        const lip = o.lipPx * dpr;
        const tx = (sx0 + sx1) / 2;
        const ty = f.ay != null ? Math.max(sy1 + lip + 3 * dpr, Math.min(f.ay, sy1 + lip + o.tailPx * dpr)) : sy1 + lip + o.tailPx * dpr;
        layer(sx0 - 14 * dpr, sy0 - 10 * dpr, sx1 + 14 * dpr, ty + 14 * dpr, sa, () =>
          pill(sx0, sy0, sx1, sy1, { ol: 3 * dpr, lip, tail: { x: tx, y: ty, hw: Math.min(9 * dpr, (sx1 - sx0) * 0.16) } }));
      }
      for (const q of o.quads) {
        if (!(q.a > 0.003)) continue;
        g.globalAlpha = Math.min(1, q.a);
        const [cx, cy] = at(f, q.x, q.z);
        setT(f.exx * q.w, f.exy * q.w, f.ezx * q.d, f.ezy * q.d, cx, cy);
        const aw = src.width, ah = src.height, u = q.uv;
        const sw = (u[2] - u[0]) * aw, sh = (u[1] - u[3]) * ah;
        if (sw > 0 && sh > 0) g.drawImage(src, u[0] * aw, (1 - u[1]) * ah, sw, sh, -0.5, -0.5, 1, 1);
      }
      g.globalAlpha = 1;
      setT(1, 0, 0, 1, 0, 0);
    });
  }
  function drawTag(o) {
    proj(o.wx, o.wy, o.wz, A);
    if (A.w <= 0) return;
    const x = A.x + o.dx * dpr, y = A.y + o.dy * dpr;
    if (offscreen(x, y)) return;
    const s = o.s * dpr;
    under(o, x - (o.w * s) / 2, y - (o.h * s) / 2, x + (o.w * s) / 2, y + (o.h * s) / 2);
    setT(1, 0, 0, 1, 0, 0);
    g.globalAlpha = Math.min(1, o.a * veilA(o));
    blit(o.uv, x - (o.w * s) / 2, y - (o.h * s) / 2, o.w * s, o.h * s);
    g.globalAlpha = 1;
  }
  function drawPip(o) {
    proj(o.wx, o.wy, o.wz, A);
    if (A.w <= 0) return;
    const s = o.s * dpr;
    const cx = A.x + o.dx * dpr, cy = A.y + o.dy * dpr;
    if (offscreen(cx, cy)) return;
    // extent [X0, X0 + w]: the icon's outer 30% hangs past the pill's left edge (UI-STYLE: icons break out)
    const h = o.h * s, lip = Math.max(1, 3 * s), face = h - lip;
    const w = o.w * s, ic = o.icon * s;
    const X0 = cx - w / 2, x0 = X0 + ic * 0.3, y0 = cy - h / 2;
    const done = o.done;
    under(o, X0, y0, X0 + w, y0 + h);
    const iw = ic * (1 + o.bump * 0.25);
    layer(X0 - iw * 0.2, cy - Math.max(h, iw) / 2 - 6 * s, X0 + w + 4 * s, cy + Math.max(h, iw) / 2 + 6 * s, o.a * veilA(o), () => {
      pill(x0, y0, X0 + w, y0 + face, { ol: 2.5 * s, lip, shadow: false, fill: done ? '#e9f7d6' : CREAM, lipFill: done ? '#b9dc8e' : CREAM_LIP });
      setT(1, 0, 0, 1, 0, 0);
      blit(o.iconUv, X0 + ic / 2 - iw / 2, y0 + face / 2 - iw / 2 - s, iw, iw);
      // count (brown on cream) or a tick
      const tx = (X0 + ic * 0.92 + X0 + w) / 2;
      if (done) tick(tx, y0 + face / 2, face * 0.62);
      else {
        const ps = 1 + o.pop * 0.35;
        g.save();
        setT(ps, 0, 0, ps, tx, y0 + face / 2 + s * 0.5);
        g.font = `700 ${o.fontPx * s}px ${FONT}`;
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillStyle = INK;
        g.fillText(o.text, 0, 0);
        g.restore();
      }
      setT(1, 0, 0, 1, 0, 0);
    });
  }

  // ---------------- the see-through window under the guide's arrow ----------------
  const vbox = new THREE.Box3(), vc = new THREE.Vector3();
  let vr = null, keep = null;
  const veilK = new Map(), veilHit = new Set();
  let lastDt = 1 / 60;
  function measureVeil() {
    vr = null; keep = null;
    let v = null;
    try { v = veil?.() || null; } catch { v = null; }
    const obj = v?.object;
    if (!obj) return;
    keep = v.keep ?? null;
    for (let p = obj; p; p = p.parent) if (!p.visible) return;
    vbox.setFromObject(obj);
    if (vbox.isEmpty()) return;
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (let i = 0; i < 8; i++) {
      vc.set(i & 1 ? vbox.max.x : vbox.min.x, i & 2 ? vbox.max.y : vbox.min.y, i & 4 ? vbox.max.z : vbox.min.z);
      proj(vc.x, vc.y, vc.z, A);
      if (A.w <= 0) return;
      l = Math.min(l, A.x); r = Math.max(r, A.x); t = Math.min(t, A.y); b = Math.max(b, A.y);
    }
    // the box of a slim upright arrow is generous; trim it a little toward its middle
    const gx = (r - l) * 0.12;
    vr = { l: l + gx, r: r - gx, t: t + (b - t) * 0.04, b };
  }
  function under(o, l, t, r, b) {
    if (!vr || o.id == null || (keep && keep.includes(o.id))) return;
    if (r > vr.l && l < vr.r && b > vr.t && t < vr.b) veilHit.add(o.id);
  }
  const veilA = o => (o.id == null ? 1 : veilK.get(o.id) ?? 1);
  function settleVeil() {
    const k = 1 - Math.exp(-14 * lastDt);
    for (const id of veilHit) if (!veilK.has(id)) veilK.set(id, 1);
    for (const [id, a] of veilK) {
      const want = veilHit.has(id) ? 0.26 : 1;
      const nv = a + (want - a) * k;
      if (want === 1 && nv > 0.995) veilK.delete(id); else veilK.set(id, nv);
    }
    veilHit.clear();
  }

  let drewLast = false;
  let serial = 0, drawnSerial = -1;
  const camSnap = new Float32Array(16);
  function draw() {
    camera.updateMatrixWorld();
    vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    // the same ops seen by the same camera (a second render in one frame): nothing to do
    let same = drawnSerial === serial;
    for (let i = 0; i < 16; i++) { if (camSnap[i] !== vp.elements[i]) { same = false; camSnap[i] = vp.elements[i]; } }
    if (same && W === Math.round(innerWidth * dpr)) return;
    drawnSerial = serial;
    fit();
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (drewLast) g.clearRect(0, 0, W, H);
    drewLast = n > 0;
    if (!n) return;
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    measureVeil();
    // ground ink first (in push order), lifted stickers on top of everything
    for (let i = 0; i < n; i++) {
      const o = ops[i];
      if (o.type === 'block') { if (o.k <= 0.02) drawBlock(o); }
      else if (o.type === 'tag') drawTag(o);
      else if (o.type === 'pip') drawPip(o);
    }
    for (let i = 0; i < n; i++) { const o = ops[i]; if (o.type === 'block' && o.k > 0.02) drawBlock(o); }
    g.globalAlpha = 1;
    g.setTransform(1, 0, 0, 1, 0, 0);
    settleVeil();
  }

  return {
    canvas,
    begin(dt = 1 / 60) { n = 0; nq = 0; lastDt = Math.min(0.1, Math.max(0, dt)); },
    // a liftable group of atlas quads (see header). Returns the op; add quads with quadTo().
    block(o) {
      const b = next('block');
      b.id = o.id ?? null;
      b.gx = o.gx; b.gy = o.gy ?? 0; b.gz = o.gz;
      b.k = o.k || 0; b.lx = o.lx ?? o.gx; b.ly = o.ly ?? 0; b.lz = o.lz ?? o.gz;
      b.ls = o.ls ?? 1; b.zs = o.zs ?? 1; b.a = o.a ?? 1;
      b.box = o.box || null; b.stickerA = o.stickerA || 0;
      b.padPx = o.padPx ?? 6; b.lipPx = o.lipPx ?? 4; b.tailPx = o.tailPx ?? 10;
      return b;
    },
    quadTo(b, x, z, w, d, uv, a = 1) {
      if (!uv || !(a > 0.003) || !(w > 0) || !(d > 0)) return;
      const q = quad();
      q.x = x; q.z = z; q.w = w; q.d = d; q.uv = uv; q.a = a;
      b.quads.push(q);
    },
    tag(wx, wy, wz, uv, w, h, { dx = 0, dy = 0, s = 1, a = 1, id = null } = {}) {
      if (!(a > 0.003) || !uv) return;
      const o = next('tag');
      o.id = id;
      o.wx = wx; o.wy = wy; o.wz = wz; o.uv = uv; o.w = w; o.h = h; o.dx = dx; o.dy = dy; o.s = s; o.a = a;
    },
    // h: pill height incl. lip (CSS px); returns nothing. Width comes from pipWidth().
    pip(wx, wy, wz, { iconUv, text, done, w, h, icon, fontPx, dx = 0, dy = 0, s = 1, a = 1, pop = 0, bump = 0, id = null }) {
      if (!(a > 0.003)) return;
      const o = next('pip');
      o.id = id;
      o.wx = wx; o.wy = wy; o.wz = wz; o.iconUv = iconUv; o.text = text; o.done = !!done; o.w = w; o.h = h;
      o.icon = icon; o.fontPx = fontPx; o.dx = dx; o.dy = dy; o.s = s; o.a = a; o.pop = pop; o.bump = bump;
    },
    // the CSS-px width of a pip for this count
    pipWidth(text, { h, icon, fontPx, done }) {
      const tw = done ? h * 0.75 : measure(text) * fontPx;
      return Math.ceil(icon * 0.92 + tw + h * 0.5);
    },
    commit() { serial++; },
    get dpr() { return dpr; },
    get count() { return n; },
    dispose() { hook.removeFromParent(); hookGeo.dispose(); hookMat.dispose(); canvas.remove(); },
  };
}
