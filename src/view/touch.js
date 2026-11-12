// Touch controls for the portrait / phone mode (DESIGN.md 3b). Lead-owned.
// FLOATING JOYSTICK: touch and hold anywhere on the world and the stick appears right under the thumb;
// drag to walk; let go and it fades away. If the thumb drags past the rim the base follows it, so a long
// swipe never loses the stick. Writes ctx.input.move (world xz, 0..1, dead-zoned); without analog support in
// the player it falls back to synthetic WASD keys.
// Camp mode (the robot works on its own) has no buttons at all. The old factory mode keeps an action button
// (holds Space) plus Rotate / Cancel while a building is selected, and quick taps go through to the world.
// Everything animates from dt in update(); nothing here reads performance.now for animation.
const STICK_R = 46;          // knob travel, px
const DEAD = 0.12;           // dead zone (fraction of travel)
const TAP_MOVE = 10;         // px: less than this and released quickly = a tap, not a drag
const TAP_TIME = 0.22;       // s

const ICONS = {
  axe: '<path d="M14 6c4-3 9-2 11 1l-6 6c-2-2-4-4-5-7z" fill="currentColor"/><path d="M15.5 11.5 5 22" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/>',
  pick: '<path d="M6 9c5-5 13-5 18 0" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" fill="none"/><path d="M15 7 8 24" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/>',
  hand: '<path d="M10 15V8.5a1.8 1.8 0 0 1 3.6 0V14m0-1.5V6.8a1.8 1.8 0 0 1 3.6 0V14m0-5.5a1.8 1.8 0 0 1 3.6 0V15m0-3a1.8 1.8 0 0 1 3.6 0v5c0 4.4-3.3 8-8 8s-6.2-2.3-8.4-5.6L5.5 17a1.9 1.9 0 0 1 3-2.3L10 16.5" stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  rotate: '<path d="M22 11a8 8 0 1 0 1.2 6.5" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M23.5 5v6.5H17" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  cancel: '<path d="M9 9l12 12M21 9 9 21" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/>',
};
const svg = name => `<svg viewBox="0 0 30 30" width="30" height="30" aria-hidden="true">${ICONS[name]}</svg>`;

const CSS = `
.touch { position: fixed; inset: 0; pointer-events: none; }
.touch * { box-sizing: border-box; }
.touch .t-hit { pointer-events: auto; touch-action: none; -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent; }
.touch .t-zone { position: absolute; inset: 0; }
.touch .t-base { position: absolute; left: 0; top: 0; width: ${STICK_R * 2 + 44}px; height: ${STICK_R * 2 + 44}px;
  margin: -${STICK_R + 22}px 0 0 -${STICK_R + 22}px; border-radius: 50%; pointer-events: none; opacity: 0;
  background: radial-gradient(circle, rgba(255, 250, 238, 0.10) 0%, rgba(255, 250, 238, 0.26) 62%, rgba(255, 250, 238, 0.42) 100%);
  border: 2.5px solid rgba(255, 250, 240, 0.9);
  box-shadow: 0 10px 26px -12px rgba(40, 60, 40, 0.55), inset 0 0 0 8px rgba(255, 255, 255, 0.10); will-change: transform, opacity; }
.touch .t-knob { position: absolute; left: 50%; top: 50%; width: 58px; height: 58px; margin: -29px 0 0 -29px; border-radius: 50%;
  background: radial-gradient(circle at 38% 32%, #ffffff 0%, #fff7e6 55%, #f4e6c8 100%); border: 2px solid #e9d7b4;
  box-shadow: 0 3px 0 #dcc49b, 0 12px 20px -8px rgba(80, 60, 20, 0.55); will-change: transform; }
.touch .t-dir { position: absolute; left: 50%; top: 50%; width: 0; height: 0; pointer-events: none; will-change: transform, opacity; }
.touch .t-dir::before { content: ''; position: absolute; left: ${STICK_R + 8}px; top: -7px; border: 7px solid transparent;
  border-left: 10px solid rgba(255, 250, 240, 0.95); filter: drop-shadow(0 1px 1px rgba(60, 50, 30, 0.35)); }
.touch .t-btn { position: absolute; display: grid; place-items: center; border-radius: 50%; border: 0; padding: 0; color: #fffaf0;
  will-change: transform, opacity; }
.touch .t-act { width: 84px; height: 84px; right: calc(18px + env(safe-area-inset-right, 0px));
  bottom: calc(var(--hud-bottom, calc(var(--safe-bottom, 0px) + 96px)) + 22px);
  background: #f08a24; border: 2px solid #cf6c14; box-shadow: 0 4px 0 #bf6214, 0 14px 22px -10px rgba(104, 70, 24, 0.6); }
.touch .t-act svg { width: 38px; height: 38px; }
.touch .t-act.is-idle { background: #e9d7b4; border-color: #dcc49b; box-shadow: 0 4px 0 #cdb38a, 0 14px 22px -10px rgba(104, 70, 24, 0.45); color: #a5937a; }
.touch .t-small { width: 54px; height: 54px; background: #fff7e6; border: 2px solid #e9d7b4; color: #3b3226;
  box-shadow: 0 3px 0 #dcc49b, 0 10px 16px -8px rgba(104, 70, 24, 0.5); right: calc(32px + env(safe-area-inset-right, 0px)); }
.touch .t-small svg { width: 24px; height: 24px; }
.touch .t-rot { bottom: calc(var(--hud-bottom, calc(var(--safe-bottom, 0px) + 96px)) + 122px); }
.touch .t-cancel { bottom: calc(var(--hud-bottom, calc(var(--safe-bottom, 0px) + 96px)) + 186px); color: #e2574c; }
/* first-run hint, sticker style: a cream ring with the brown outline, a knob, and a small hand pushing it */
.touch .t-hint { position: absolute; left: 50%; bottom: calc(var(--safe-bottom, 0px) + 110px); width: 96px; height: 96px; margin-left: -48px;
  border-radius: 50%; border: 3px solid #5b3a21; background: rgba(255, 247, 230, 0.42);
  box-shadow: 0 4px 0 rgba(91, 58, 33, 0.35), inset 0 0 0 4px rgba(255, 255, 255, 0.35); pointer-events: none; will-change: transform, opacity; }
.touch .t-hint::after { content: ''; position: absolute; left: 50%; top: 50%; width: 34px; height: 34px; margin: -17px; border-radius: 50%;
  background: radial-gradient(circle at 38% 32%, #fff 0%, #fff7e6 60%, #f1e1c2 100%); border: 3px solid #5b3a21; box-shadow: 0 3px 0 #dcc49b;
  transform: translate(var(--kx, 0px), var(--ky, 0px)); }
.touch .t-hint .t-hand { position: absolute; left: 50%; top: 50%; width: 34px; height: 34px; margin: -6px 0 0 -4px; z-index: 1; will-change: transform; }
.touch.is-hidden .t-btn { opacity: 0 !important; }
.touch.is-hidden .t-hit { pointer-events: none; }
`;

export function create(ctx) {
  if (!ctx.mobile) return { active: false };
  const { camera, input, ui, sim, views, config, anim } = ctx;
  const campMode = !!ctx.camp;

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);

  const root = document.createElement('div');
  root.className = 'touch';
  root.innerHTML = `
    <div class="t-zone t-hit"></div>
    <div class="t-hint"><svg class="t-hand" viewBox="0 0 32 32" aria-hidden="true"><path d="M12 17V7.5a2 2 0 0 1 4 0V15m0-2V5.5a2 2 0 0 1 4 0V15m0-6a2 2 0 0 1 4 0v6m0-3a2 2 0 0 1 4 0v7c0 5-3.6 9-9 9-4.2 0-6.6-2.3-9-6L5.7 19a2.2 2.2 0 0 1 3.5-2.6L12 19" fill="#fff7e6" stroke="#5b3a21" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
    <div class="t-base"><div class="t-dir"></div><div class="t-knob"></div></div>
    ${campMode ? '' : `
    <button class="t-btn t-small t-cancel t-hit" type="button" aria-label="Cancel">${svg('cancel')}</button>
    <button class="t-btn t-small t-rot t-hit" type="button" aria-label="Rotate">${svg('rotate')}</button>
    <button class="t-btn t-act t-hit" type="button" aria-label="Use">${svg('axe')}</button>`}`;
  // Below the HUD layer: HUD buttons and sheets sit on top and keep their own touches.
  ctx.uiRoot.prepend(root);

  const zone = root.querySelector('.t-zone');
  const base = root.querySelector('.t-base');
  const knob = root.querySelector('.t-knob');
  const dirEl = root.querySelector('.t-dir');
  const hint = root.querySelector('.t-hint');
  const hand = root.querySelector('.t-hand');
  // any real movement (keyboard, stick, mouse walk) also retires the hint
  addEventListener('keydown', e => { if (/^(Key[WASD]|Arrow)/.test(e.code)) used = true; });
  const act = root.querySelector('.t-act');
  const rot = root.querySelector('.t-rot');
  const cancel = root.querySelector('.t-cancel');
  [act, rot, cancel].forEach(b => b?.addEventListener('mousedown', e => e.preventDefault())); // never take focus

  // ---------- synthetic keys ----------
  const KEYS = { Space: ' ', KeyR: 'r', Escape: 'Escape', KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd' };
  const key = (type, code) => document.body.dispatchEvent(new KeyboardEvent(type, { code, key: KEYS[code], bubbles: true, cancelable: true }));
  const tapKey = code => { key('keydown', code); key('keyup', code); };
  const buzz = ms => { try { navigator.vibrate?.(ms); } catch { /* not supported */ } };

  // ---------- floating joystick ----------
  const origin = { x: 0, y: 0 };           // base centre, screen px
  const raw = { x: 0, y: 0 };              // knob offset target, px
  const knobX = new anim.Spring(0, { stiffness: 620, damping: 32 });
  const knobY = new anim.Spring(0, { stiffness: 620, damping: 32 });
  const baseScale = new anim.Spring(0.82, { stiffness: 420, damping: 24 });
  const baseAlpha = new anim.Spring(0, { stiffness: 300, damping: 30 });
  let stickId = null, downAt = 0, downPos = null, moved = 0, clock = 0, used = false;
  const heldKeys = new Set();

  const forwardTap = (x, y) => {
    // factory mode: a quick tap on the world still clicks it (chop / place / open)
    const target = ctx.canvas;
    const o = { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, pointerId: 99, pointerType: 'touch', isPrimary: true };
    target.dispatchEvent(new PointerEvent('pointerdown', { ...o, buttons: 1 }));
    target.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
    target.dispatchEvent(new MouseEvent('click', { ...o, buttons: 0 }));
  };

  zone.addEventListener('pointerdown', e => {
    if (stickId !== null) return;
    e.preventDefault(); e.stopPropagation();
    stickId = e.pointerId;
    zone.setPointerCapture(e.pointerId);
    origin.x = e.clientX; origin.y = e.clientY;
    raw.x = 0; raw.y = 0; knobX.set(0); knobY.set(0);
    baseScale.set(0.82); baseScale.target = 1; baseScale.kick(2.2);
    baseAlpha.target = 1;
    downAt = clock; downPos = { x: e.clientX, y: e.clientY }; moved = 0;
    used = true;
    ui.pointerOverUi = true;
    buzz(5);
  });
  zone.addEventListener('pointermove', e => {
    if (e.pointerId !== stickId) return;
    e.preventDefault();
    moved = Math.max(moved, Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y));
    let dx = e.clientX - origin.x, dy = e.clientY - origin.y;
    const d = Math.hypot(dx, dy);
    // past the rim the base slides after the thumb, so the stick is never lost
    const rim = STICK_R * 1.12;
    if (d > rim) { const k = (d - rim) / d; origin.x += dx * k; origin.y += dy * k; dx -= dx * k; dy -= dy * k; }
    const m = Math.hypot(dx, dy);
    if (m > STICK_R) { dx *= STICK_R / m; dy *= STICK_R / m; }
    raw.x = dx; raw.y = dy;
  });
  const endStick = e => {
    if (e.pointerId !== stickId) return;
    const tap = clock - downAt < TAP_TIME && moved < TAP_MOVE;
    stickId = null; raw.x = 0; raw.y = 0;
    baseAlpha.target = 0; baseScale.target = 0.86;
    ui.pointerOverUi = false;
    if (tap && !campMode && e.type === 'pointerup') forwardTap(e.clientX, e.clientY);
  };
  zone.addEventListener('pointerup', endStick);
  zone.addEventListener('pointercancel', endStick);
  zone.addEventListener('lostpointercapture', endStick);

  // screen (right, down) -> world xz, following the camera's yaw
  const fwd = new ctx.THREE.Vector3();
  function stickToWorld(sx, sy) {
    camera.getWorldDirection(fwd);
    let fx = fwd.x, fz = fwd.z; const fl = Math.hypot(fx, fz) || 1; fx /= fl; fz /= fl;
    const rx = -fz, rz = fx;
    return { x: rx * sx + fx * -sy, z: rz * sx + fz * -sy };
  }
  function setKeys(wanted) {
    for (const k of [...heldKeys]) if (!wanted.has(k)) { key('keyup', k); heldKeys.delete(k); }
    for (const k of wanted) if (!heldKeys.has(k)) { key('keydown', k); heldKeys.add(k); }
  }

  // ---------- factory-mode buttons ----------
  const press = (btn, onDown, onUp) => {
    if (!btn) return;
    const s = new anim.Spring(1, { stiffness: 600, damping: 26 });
    btn._s = s;
    let id = null;
    btn.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      if (id !== null) return;
      id = e.pointerId; btn.setPointerCapture(e.pointerId);
      s.target = 0.92; ui.pointerOverUi = true; buzz(8);
      onDown?.();
    });
    const up = e => {
      if (e.pointerId !== id) return;
      id = null; s.target = 1; s.kick(2.5); ui.pointerOverUi = false;
      onUp?.();
    };
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('lostpointercapture', up);
  };
  press(act, () => key('keydown', 'Space'), () => key('keyup', 'Space'));
  press(rot, () => tapKey('KeyR'));
  press(cancel, () => tapKey('Escape'));
  const smallVis = new anim.Spring(0, { stiffness: 340, damping: 26 });

  let iconName = 'axe', iconTimer = 0, idle = false;
  function pickIcon() {
    const p = sim.player;
    const reach = config.PLAYER.reach + 0.05;
    let best = null, bestD = Infinity;
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      const d = Math.hypot(dx, dz);
      if (d > reach) continue;
      const e = sim.at(p.x + dx, p.z + dz);
      const dep = !e && sim.map.depositAt(p.x + dx, p.z + dz);
      if ((e?.resource || dep) && d < bestD) { bestD = d; best = e ? e.kind : 'deposit'; }
    }
    if (best) return { name: best === 'tree' || best === 'stump' ? 'axe' : 'pick', idle: false };
    const [fx, fz] = config.DIRS[p.dir] || [0, 1];
    for (let i = 1; i <= Math.floor(config.PLAYER.useReach); i++) {
      const e = sim.at(p.x + fx * i, p.z + fz * i);
      if (e && (e.kind === 'chest' || e.kind === 'workshop')) return { name: 'hand', idle: false };
      if (e) break;
    }
    return { name: iconName, idle: true };
  }

  // first-run hint: a dashed ring with a dot that nudges, until the first touch
  const hintAlpha = new anim.Spring(0, { stiffness: 120, damping: 20 });

  return {
    active: true,
    root,
    get holding() { return stickId !== null; },
    update(dt) {
      clock += dt;
      // stick output
      const sx = raw.x / STICK_R, sy = raw.y / STICK_R;
      const m = Math.hypot(sx, sy);
      const k = m < DEAD ? 0 : Math.min(1, (m - DEAD) / (1 - DEAD)) / (m || 1);
      const w = stickToWorld(sx * k, sy * k);
      if (views.player?.supportsAnalog) {
        input.move.x = w.x; input.move.z = w.z; input.active = stickId !== null;
        if (heldKeys.size) setKeys(new Set());
      } else {
        input.move.x = 0; input.move.z = 0; input.active = false;
        const want = new Set();
        if (m >= DEAD) {
          if (sy < -0.38) want.add('KeyW'); if (sy > 0.38) want.add('KeyS');
          if (sx < -0.38) want.add('KeyA'); if (sx > 0.38) want.add('KeyD');
        }
        setKeys(want);
      }

      // stick visuals
      knobX.target = raw.x; knobY.target = raw.y;
      knobX.update(dt); knobY.update(dt); baseScale.update(dt); baseAlpha.update(dt);
      const a = Math.max(0, Math.min(1, baseAlpha.value));
      base.style.opacity = a.toFixed(3);
      base.style.transform = `translate3d(${origin.x.toFixed(1)}px, ${origin.y.toFixed(1)}px, 0) scale(${baseScale.value.toFixed(3)})`;
      knob.style.transform = `translate3d(${knobX.value.toFixed(1)}px, ${knobY.value.toFixed(1)}px, 0)`;
      const km = Math.hypot(knobX.value, knobY.value) / STICK_R;
      dirEl.style.opacity = Math.max(0, Math.min(1, (km - 0.25) * 2)).toFixed(3);
      dirEl.style.transform = `rotate(${Math.atan2(knobY.value, knobX.value).toFixed(3)}rad)`;

      if (!used && (views.player?.moving || Math.hypot(input.move.x, input.move.z) > 0.05)) used = true;
      hintAlpha.target = !used && clock > 1.2 && !views.player?.booting ? 1 : 0;
      hintAlpha.update(dt);
      hint.style.opacity = Math.max(0, Math.min(1, hintAlpha.value)).toFixed(3);
      hint.style.transform = `scale(${(0.9 + 0.1 * Math.min(1, Math.max(0, hintAlpha.value))).toFixed(3)})`;
      // the hand pushes the knob out and lets it spring back: "hold and drag"
      const kp = Math.max(0, Math.sin(clock * 2.2)) * 20;
      hint.style.setProperty("--kx", `${(kp * 0.8).toFixed(1)}px`);
      hint.style.setProperty("--ky", `${(-kp * 0.6).toFixed(1)}px`);
      hand.style.transform = `translate(${(kp * 0.8).toFixed(1)}px, ${(-kp * 0.6).toFixed(1)}px)`;

      // factory buttons
      if (!campMode) {
        const building = !!ui.selected;
        smallVis.target = building ? 1 : 0;
        smallVis.update(dt);
        for (const [i, b] of [[0, rot], [1, cancel]]) {
          const v = Math.max(0, Math.min(1, smallVis.value * 1.15 - i * 0.15));
          b._s.update(dt);
          b.style.opacity = v.toFixed(3);
          b.style.transform = `translate3d(0, ${((1 - v) * 14).toFixed(1)}px, 0) scale(${(b._s.value * (0.86 + 0.14 * v)).toFixed(3)})`;
          b.style.pointerEvents = v > 0.5 ? 'auto' : 'none';
        }
        act._s.update(dt);
        act.style.transform = `scale(${act._s.value.toFixed(3)})`;
        if ((iconTimer -= dt) <= 0) {
          iconTimer = 0.12;
          const pick = pickIcon();
          if (pick.name !== iconName) { iconName = pick.name; act.innerHTML = svg(iconName); act._s.kick(-3); }
          if (pick.idle !== idle) { idle = pick.idle; act.classList.toggle('is-idle', idle); }
        }
        root.classList.toggle('is-hidden', !!ui.panel);
      }
    },
  };
}
