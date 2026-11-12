// Off-screen edge chip: when the goal is off-screen, a sticker chip rides the screen edge on the line from
// the robot to the target, with the goal's item icon and an orange pointer orbiting it toward the target.
// It nudges toward the target, springs in / out, keeps clear of the notch / home indicator (--safe-top /
// --safe-bottom, via a probe) and of the top-left HUD cluster.
import { Spring, clamp, damp, dampAngle } from '../../util/anim.js';
import { POINTER_SVG } from './css.js';
import { createIconSlot } from './icons.js';

export function createEdge(layer, views, { mobile, items = {}, reduced = () => false }) {
  const face = document.createElement('div'); face.className = 'ge-face';
  const iconWrap = document.createElement('div'); iconWrap.style.display = 'contents';
  face.append(iconWrap);
  const ptr = document.createElement('div'); ptr.className = 'ge-ptr'; ptr.innerHTML = POINTER_SVG;
  const inner = document.createElement('div'); inner.className = 'ge-in';
  inner.append(ptr, face);
  const el = document.createElement('div'); el.className = 'ge'; el.setAttribute('aria-hidden', 'true');
  el.append(inner);
  layer.append(el);
  const setIcon = createIconSlot(views, items);

  const R = mobile ? 24 : 27;           // face radius (px)
  const REACH = R + (mobile ? 24 : 26);  // face + pointer: keep this much inside the edge
  const vis = new Spring(0, { stiffness: 300, damping: 19 });
  const st = { x: 0, y: 0, ang: 0, placed: false, want: false, t: 0, item: null, lastCss: '' };

  // safe: { top, bottom, left, right } px insets; avoid: [DOMRect] to keep clear of
  function update(dt, { want, from, to, item, safe, avoid, W, H }) {
    st.t += dt;
    st.want = !!want;
    vis.target = st.want ? 1 : 0;
    vis.update(dt);
    if (item !== st.item) { st.item = item; setIcon(iconWrap, item); }
    const v = vis.value;
    if (v < 0.003 && !st.want) {
      if (el.style.visibility !== 'hidden') { el.style.visibility = 'hidden'; el.style.opacity = '0'; }
      st.placed = false;
      return;
    }
    if (st.want && from && to) {
      // ray from the robot (clamped on screen) to the target, cut by the inset rectangle
      const l = safe.left + REACH, r = W - safe.right - REACH, t = safe.top + REACH, b = H - safe.bottom - REACH;
      const ox = clamp(from.x, l, r), oy = clamp(from.y, t, b);
      let dx = to.x - ox, dy = to.y - oy;
      if (to.behind) { dx = -dx; dy = -dy; }
      const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
      let k = Infinity;
      if (dx > 1e-4) k = Math.min(k, (r - ox) / dx); else if (dx < -1e-4) k = Math.min(k, (l - ox) / dx);
      if (dy > 1e-4) k = Math.min(k, (b - oy) / dy); else if (dy < -1e-4) k = Math.min(k, (t - oy) / dy);
      if (!Number.isFinite(k)) k = 0;
      let x = ox + dx * k, y = oy + dy * k;
      // keep clear of HUD rects (slide along the edge we're on)
      for (const a of avoid || []) {
        const pad = 10;
        if (x + R > a.left - pad && x - R < a.right + pad && y + R > a.top - pad && y - R < a.bottom + pad) {
          const onTop = Math.abs(y - t) < 2, onLeft = Math.abs(x - l) < 2, onRight = Math.abs(x - r) < 2;
          if (onTop) x = Math.min(r, a.right + pad + REACH);
          else y = Math.min(b, a.bottom + pad + REACH);
        }
      }
      const ang = Math.atan2(to.behind ? -(to.y - y) : to.y - y, to.behind ? -(to.x - x) : to.x - x);
      if (!st.placed) { st.x = x; st.y = y; st.ang = ang; st.placed = true; }
      st.x = damp(st.x, x, 12, dt); st.y = damp(st.y, y, 12, dt);
      st.ang = dampAngle(st.ang, ang, 12, dt);
    }
    // nudge toward the target, a soft breathing scale
    const nudge = reduced() ? 0 : 4 * Math.max(0, Math.sin(st.t * Math.PI * 2 * 1.15));
    const nx = Math.cos(st.ang) * nudge, ny = Math.sin(st.ang) * nudge;
    const s = reduced() ? 1 : 0.6 + 0.4 * v;
    const css = `translate3d(${(st.x + nx).toFixed(1)}px, ${(st.y + ny).toFixed(1)}px, 0) scale(${s.toFixed(3)})`;
    if (css !== st.lastCss) { el.style.transform = css; st.lastCss = css; }
    el.style.opacity = clamp(v * 1.6).toFixed(3);
    if (el.style.visibility !== 'visible') el.style.visibility = 'visible';
    ptr.style.transform = `rotate(${st.ang.toFixed(4)}rad)`;
  }

  return {
    el, update,
    refreshIcon() { if (st.item) setIcon(iconWrap, st.item); },
    get visible() { return vis.value > 0.5; },
    get position() { return { x: st.x, y: st.y, angle: st.ang }; },
  };
}
