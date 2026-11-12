// World-anchored cost bubbles: one DOM layer (.pad-labels) inside ctx.uiRoot, one cream bubble per pad with the
// pad's name, item icons with the remaining counts and a thin paid bar. Bubbles are projected from their world
// anchor at render time (after the camera has moved this frame) so they never lag the world; every animation
// (scale-in, bob, per-item pop, completion) is a dt-driven spring/tween set from update(), never CSS timing.
import * as THREE from 'three';

const CSS = `
.pad-labels { position: fixed; inset: 0; pointer-events: none !important; overflow: hidden; z-index: 0;
  font-family: 'Fredoka', 'Nunito', ui-rounded, system-ui, sans-serif; color: #3b3226;
  -webkit-font-smoothing: antialiased; user-select: none; -webkit-user-select: none; font-variant-numeric: tabular-nums; }
.pad-labels * { box-sizing: border-box; }
.pad-bubble { position: absolute; left: 0; top: 0; will-change: transform, opacity; transform-origin: 50% 100%;
  display: flex; flex-direction: column; align-items: center; }
.pad-card { position: relative; display: flex; flex-direction: column; align-items: center; gap: 3px;
  padding: 5px 10px 7px; border-radius: 14px; background: #fff8e8; border: 2px solid #ecd8b0;
  box-shadow: 0 0 0 1px rgba(110,78,30,.08), 0 3px 0 #d6b886, 0 12px 20px -12px rgba(84,58,18,.55); }
.pad-bubble.is-on .pad-card { background: #fffdf7; border-color: #f6c46e; }
.pad-name { font-size: 12px; font-weight: 500; line-height: 1; color: #6e5d46; white-space: nowrap; letter-spacing: .01em; }
.pad-costs { display: flex; align-items: center; gap: 8px; }
.pad-cost { display: flex; align-items: center; gap: 3px; }
.pad-cost img, .pad-cost canvas { width: 26px; height: 26px; display: block; }
.pad-cost b { display: inline-block; min-width: 1ch; font-size: 19px; font-weight: 600; line-height: 1; transform-origin: 50% 60%; }
.pad-cost.done b { color: #4d8a22; }
.pad-cost.done img, .pad-cost.done canvas { opacity: .55; }
.pad-bar { position: relative; width: 100%; min-width: 46px; height: 6px; border-radius: 99px; background: #f0dfbd; overflow: hidden;
  box-shadow: inset 0 1px 0 rgba(120,84,30,.14); }
.pad-bar > i { position: absolute; inset: 0; border-radius: inherit; background: linear-gradient(#a6dd6a, #7cc243);
  transform-origin: 0 50%; transform: scaleX(0); }
.pad-tail { width: 12px; height: 12px; margin-top: -8px; background: #fff8e8; border: 2px solid #ecd8b0; border-top: 0; border-left: 0;
  transform: rotate(45deg); border-radius: 0 0 4px 0; box-shadow: 3px 3px 0 -1px #d6b886; }
.pad-bubble.is-on .pad-tail { background: #fffdf7; border-color: #f6c46e; }
.pad-check { position: absolute; inset: -2px; display: grid; place-items: center; border-radius: 14px; background: #7cc243; color: #fff;
  font-size: 22px; font-weight: 700; opacity: 0; }
body.mobile .pad-card { padding: 3px 7px 5px; border-radius: 11px; gap: 2px; border-width: 1.5px;
  box-shadow: 0 0 0 1px rgba(110,78,30,.08), 0 2px 0 #d6b886, 0 8px 14px -9px rgba(84,58,18,.55); }
body.mobile .pad-name { font-size: 9.5px; }
body.mobile .pad-cost img, body.mobile .pad-cost canvas { width: 18px; height: 18px; }
body.mobile .pad-cost b { font-size: 14px; }
body.mobile .pad-costs { gap: 5px; }
body.mobile .pad-cost { gap: 2px; }
body.mobile .pad-bar { height: 4px; min-width: 30px; }
body.mobile .pad-tail { width: 10px; height: 10px; margin-top: -7px; }
`;

// Simple painted fallback icons (only used when the HUD can't hand us its rendered item icons).
function drawIcon(id, color) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.lineJoin = 'round'; g.lineCap = 'round';
  const stroke = (w = 4, col = 'rgba(59,50,38,.55)') => { g.lineWidth = w; g.strokeStyle = col; g.stroke(); };
  g.translate(32, 34);
  switch (id) {
    case 'wood':
      g.rotate(-0.35);
      g.beginPath(); g.roundRect(-24, -11, 44, 22, 10); g.fillStyle = '#9a6136'; g.fill(); stroke();
      g.beginPath(); g.ellipse(20, 0, 7, 11, 0, 0, Math.PI * 2); g.fillStyle = '#ecc993'; g.fill(); stroke(3);
      break;
    case 'plank':
      g.rotate(-0.25);
      for (const [dy, col] of [[6, '#d9a66c'], [-5, '#f0c48b']]) { g.beginPath(); g.roundRect(-26, dy - 6, 52, 12, 4); g.fillStyle = col; g.fill(); stroke(3); }
      break;
    case 'stone':
      g.beginPath(); g.moveTo(-22, 8); g.lineTo(-14, -14); g.lineTo(6, -18); g.lineTo(22, -4); g.lineTo(18, 14); g.lineTo(-10, 18); g.closePath();
      g.fillStyle = '#e3d6b3'; g.fill(); stroke();
      break;
    case 'meat': case 'cookedMeat':
      g.rotate(0.5);
      g.beginPath(); g.ellipse(-4, 0, 17, 13, 0, 0, Math.PI * 2); g.fillStyle = id === 'meat' ? '#e98a7c' : '#b86a3a'; g.fill(); stroke();
      g.beginPath(); g.roundRect(10, -3.5, 14, 7, 3); g.fillStyle = '#fff4e2'; g.fill(); stroke(3);
      g.beginPath(); g.arc(25, -4, 4.5, 0, Math.PI * 2); g.arc(25, 4, 4.5, 0, Math.PI * 2); g.fillStyle = '#fff4e2'; g.fill();
      break;
    case 'copperBar': case 'copperPlate':
      g.beginPath(); g.moveTo(-24, 10); g.lineTo(-16, -8); g.lineTo(18, -8); g.lineTo(24, 10); g.closePath(); g.fillStyle = '#e8894a'; g.fill(); stroke();
      g.beginPath(); g.moveTo(-14, -8); g.lineTo(16, -8); g.lineTo(12, -1); g.lineTo(-10, -1); g.closePath(); g.fillStyle = '#ffb37a'; g.fill();
      break;
    default:
      g.beginPath(); g.arc(0, 0, 18, 0, Math.PI * 2); g.fillStyle = color || '#ddd'; g.fill(); stroke();
  }
  return c;
}

export function createLabels(ctx) {
  const { uiRoot, camera, config, views } = ctx;
  const style = document.createElement('style');
  style.dataset.owner = 'pads';
  style.textContent = CSS;
  document.head.append(style);
  const layer = document.createElement('div');
  layer.className = 'pad-labels';
  layer.style.pointerEvents = 'none';
  layer.setAttribute('aria-hidden', 'true');
  uiRoot?.append(layer);

  const iconUrl = id => {
    try { return views.ui?.iconUrl?.(id) || views.ui?.icons?.get?.(id) || null; } catch { return null; }
  };
  const fallbackIcons = new Map();
  function makeIcon(id) {
    const url = iconUrl(id);
    if (url) { const im = document.createElement('img'); im.alt = ''; im.draggable = false; im.src = url; im.dataset.padIcon = id; return im; }
    if (!fallbackIcons.has(id)) fallbackIcons.set(id, drawIcon(id, config.ITEMS[id]?.color));
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    c.getContext('2d').drawImage(fallbackIcons.get(id), 0, 0);
    c.dataset.padIcon = id;
    return c;
  }

  const v = new THREE.Vector3();
  const bubbles = new Set();

  function create({ name, cost }) {
    const el = document.createElement('div');
    el.className = 'pad-bubble';
    const card = document.createElement('div');
    card.className = 'pad-card';
    const title = document.createElement('div');
    title.className = 'pad-name';
    title.textContent = name;
    const costs = document.createElement('div');
    costs.className = 'pad-costs';
    const entries = Object.keys(cost).map(id => {
      const wrap = document.createElement('span');
      wrap.className = 'pad-cost';
      const icon = makeIcon(id);
      const num = document.createElement('b');
      num.textContent = String(cost[id]);
      wrap.append(icon, num);
      costs.append(wrap);
      return { id, wrap, icon, num, shown: cost[id], done: false, pop: 0, popV: 0 };
    });
    const bar = document.createElement('div');
    bar.className = 'pad-bar';
    const fill = document.createElement('i');
    bar.append(fill);
    const check = document.createElement('div');
    check.className = 'pad-check';
    check.textContent = '✓';
    card.append(title, costs, bar, check);
    const tail = document.createElement('div');
    tail.className = 'pad-tail';
    el.append(card, tail);
    el.style.opacity = '0';
    layer.append(el);
    const b = {
      el, card, entries, fill, check, on: false,
      anchor: new THREE.Vector3(), scale: 0, opacity: 0, lift: 0, barK: -1, checkK: 0, visible: true,
      oy: 0, push: 0, dirty: true, w: 0, h: 0,
      setCount(id, n) {
        const e = entries.find(x => x.id === id);
        if (!e || e.shown === n) return;
        if (String(e.shown).length !== String(n).length || n <= 0) b.dirty = true;
        e.shown = n;
        e.num.textContent = n > 0 ? String(n) : '✓';
        const done = n <= 0;
        if (done !== e.done) { e.done = done; e.wrap.classList.toggle('done', done); }
      },
      kick(id, amount = 1) {
        const e = entries.find(x => x.id === id);
        if (e) e.popV = Math.min(e.popV + 9 * amount, 14);
      },
      setOn(on) { if (on !== b.on) { b.on = on; el.classList.toggle('is-on', on); } },
      remove() { el.remove(); bubbles.delete(b); },
    };
    bubbles.add(b);
    return b;
  }

  // Number pops: a stiff little spring per count (dt driven).
  function update(dt) {
    for (const b of bubbles) {
      const target = b.push || 0;
      b.oy += (target - b.oy) * (1 - Math.exp(-14 * dt));
      if (Math.abs(target - b.oy) < 0.2) b.oy = target;
      for (const e of b.entries) {
        if (Math.abs(e.pop) < 1e-3 && Math.abs(e.popV) < 1e-3) { if (e.pop !== 0) { e.pop = 0; e.num.style.transform = ''; } continue; }
        const steps = Math.max(1, Math.ceil(dt / (1 / 120))), h = dt / steps;
        for (let i = 0; i < steps; i++) { e.popV += (-e.pop * 420 - e.popV * 20) * h; e.pop += e.popV * h; }
        const s = 1 + Math.max(-0.2, Math.min(0.45, e.pop));
        e.num.style.transform = `scale(${s.toFixed(3)})`;
      }
    }
  }

  // Swap fallback icons for the HUD's rendered ones once they exist (cheap: once a second).
  let iconCheck = 0.5;
  function refreshIcons(dt) {
    if ((iconCheck -= dt) > 0) return;
    iconCheck = 1;
    for (const b of bubbles) for (const e of b.entries) {
      const url = iconUrl(e.id);
      if (!url) continue;
      if (e.icon.tagName === 'IMG') { if (e.icon.src !== url) e.icon.src = url; continue; }
      const im = document.createElement('img'); im.alt = ''; im.draggable = false; im.src = url; im.dataset.padIcon = e.id;
      e.icon.replaceWith(im); e.icon = im;
    }
  }

  // Project every bubble from its world anchor with the camera as it will render this frame.
  let W = innerWidth, H = innerHeight;
  function project() {
    W = innerWidth; H = innerHeight;
    const list = [];
    for (const b of bubbles) {
      v.copy(b.anchor).project(camera);
      const behind = v.z > 1;
      const x = (v.x * 0.5 + 0.5) * W, y = (-v.y * 0.5 + 0.5) * H - b.lift;
      b.sx = x; b.sy = y;
      const vis = !behind && b.opacity > 0.01 && b.scale > 0.01 && x > -200 && x < W + 200 && y > -200 && y < H + 300;
      if (vis !== b.visible) { b.visible = vis; b.el.style.display = vis ? '' : 'none'; }
      if (vis) list.push(b);
    }
    // keep neighbouring bubbles from stacking on top of each other: push the farther (higher) one up.
    // Only the targets are found here; the offsets ease toward them in update(dt).
    list.sort((a, b) => b.sy - a.sy);
    for (const b of list) {
      if (b.dirty || !b.w) { b.w = b.el.offsetWidth || 70; b.h = b.el.offsetHeight || 50; b.dirty = false; }
      b.push = 0;
    }
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = 0; j < i; j++) {
        const c = list[j];
        const ay = a.sy - a.push, cy = c.sy - c.push;
        const ovx = Math.min(a.sx + a.w / 2, c.sx + c.w / 2) - Math.max(a.sx - a.w / 2, c.sx - c.w / 2);
        const ovy = Math.min(ay, cy) - Math.max(ay - a.h * a.scale, cy - c.h * c.scale);
        if (ovx > 4 && ovy > 0) a.push += ovy + 2;
      }
    }
    for (const b of list) {
      // only touch the DOM when something changed (a still camera costs nothing)
      const tr = `translate3d(${b.sx.toFixed(1)}px, ${(b.sy - b.oy).toFixed(1)}px, 0) translate(-50%, -100%) scale(${b.scale.toFixed(3)})`;
      if (tr !== b.tr) { b.tr = tr; b.el.style.transform = tr; }
      const op = b.opacity.toFixed(3);
      if (op !== b.op) { b.op = op; b.el.style.opacity = op; }
    }
  }

  return {
    layer, create, project, bubbles,
    update(dt) { update(dt); refreshIcons(dt); },
    dispose() { layer.remove(); style.remove(); },
  };
}
