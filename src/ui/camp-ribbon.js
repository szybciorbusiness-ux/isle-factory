// Level-up ribbon (UI-STYLE "ribbons", FIRST-20 "the camp grows"): an orange sticker with folded tails and a star
// burst, the title in outlined letters, and the things the level opened as small stickers that pop in one by one.
//
// It must never hide the moment it celebrates (the hearth growing, the new pads popping in around it), so:
//  - it is pinned right under the camp badge (phones: safe top + ~72 px; desktop: level with the badge, centred),
//  - after ~1.2 s the ribbon shrinks and slides up beside the badge (phones) / into the top edge (desktop), and the
//    unlock stickers slide up into the space it left, where they stay readable for a few seconds,
//  - unlocks that don't fit (5 on a phone) show as icon-only stickers, never a bare "+2".
// Levels 4 and 5 are bigger: a larger ribbon held longer, gold rims, star stickers, a bigger burst and sticker
// confetti (two waves at level 5, which is gold all over).
// Every transform / opacity is written from update(dt); positions are measured once per ribbon (and on resize).
import { h, setClass, easeOut, easeInOut, reduceMotion, ol, setOl, tf, op, clamp01, rng } from './dom.js';
import { glyph } from './camp-glyphs.js';
import { unlockLabel } from './camp-labels.js';
import { MAX_LEVEL } from '../sim/camp-data.js';

// per tier: ribbon scale while it is big, when it folds up (s), when it leaves (s), confetti per wave, waves, burst size
const TIERS = {
  std: { scale: 1, fold: 1.2, end: 4.2, confetti: 0, waves: 0, burst: 1, bump: 0.16 },
  big: { scale: 1.14, fold: 1.9, end: 5.2, confetti: 36, waves: 1, burst: 1.32, bump: 0.24 },
  max: { scale: 1.18, fold: 2.3, end: 5.6, confetti: 36, waves: 2, burst: 1.45, bump: 0.26 },
};
const B_IN = 0.42, B_OUT = 0.3, FOLD_T = 0.52;     // enter, exit, the shrink-and-slide-up (s)
const CHIP0 = 0.36, CHIP_STAGGER = 0.12;           // unlock stickers pop in one by one (s)
const NAMED_MOBILE = 4, NAMED_DESK = 5;            // more than this: name one less, the rest are icon stickers
const MAX_ROWS_MOBILE = 2, MAX_ROWS_DESK = 1;      // ...and fewer names while the stickers would need more rows
const DOCK_S_MOBILE = 0.6, DOCK_S_DESK = 0.74;     // ribbon scale once folded up
const CHIPS_FOLDED_MOBILE = 0.9;                   // unlock stickers once folded up (phones)
const CONF_COLORS = ['#ff9a2e', '#8fd14f', '#62c8ff', '#ff6b5e', '#ffd25e', '#fff7e6'];
const GRAVITY = 980;                               // confetti, px/s^2

const tierOf = level => (level >= MAX_LEVEL ? 'max' : level >= 4 ? 'big' : 'std');

export function createRibbon(hud, { cluster }) {
  const { ctx, layer, mobile } = hud;
  const { camp, events } = ctx;
  const { Spring } = ctx.anim;

  // ---- DOM ----
  const tails = h('span', { class: 'rb-tails', html: ribbonTailsSvg() });
  const title = ol('Camp level 2', 'rb-title');
  const sheen = h('span', { class: 'rb-sheen' });
  const face = h('div', { class: 'rb-face' }, h('span', { class: 'rb-flame', html: glyph('flameLight') }), title, sheen);
  const starL = h('span', { class: 'rb-star rb-star-l', html: glyph('star') });
  const starR = h('span', { class: 'rb-star rb-star-r', html: glyph('star') });
  const ribbon = h('div', { class: 'rb-ribbon' }, tails, face, starL, starR);
  const chipsEl = h('div', { class: 'rb-chips' });
  const burst = h('span', { class: 'rb-burst', html: burstSvg() });
  const conf = h('div', { class: 'rb-conf', 'aria-hidden': 'true' });
  const root = h('div', { class: 'rb', 'aria-live': 'polite' }, burst, ribbon, chipsEl);
  root.style.visibility = 'hidden';
  layer.append(root, conf);

  let st = null; // { t, level, tier, T, unlocks, collecting, chips: [{ el, s }], stars: [Spring, Spring], L: layout }
  const pieces = []; // confetti { el, x, y, vx, vy, r, vr, flip, vf, t, life }
  const starS = [new Spring(0, { stiffness: 380, damping: 15 }), new Spring(0, { stiffness: 380, damping: 15 })];

  events.on('hearth:level', ({ level } = {}) => show(level ?? camp.level));
  events.on('pad:shown', ({ pad } = {}) => {
    if (st?.collecting && pad && !pad.id.startsWith('hearth:')) st.unlocks.push(pad.id);
  });

  function show(level, unlocks = []) {
    const tier = tierOf(level);
    st = { t: 0, level, tier, T: TIERS[tier], unlocks: [...unlocks], collecting: true, chips: [], L: null, spawned: 0, seed: 97 + level * 31 };
    hud.campToasts?.block?.(true);
  }

  // ---- content ----
  function fill() {
    setOl(title, st.level <= 1 ? 'The fire is lit' : `Camp level ${st.level}`); // level 1 = the cold hearth was lit
    setClass(root, 'is-max', st.tier === 'max');
    setClass(root, 'is-big', st.tier === 'big');
    chipsEl.textContent = '';
    st.chips = [];
    const chip = (iconHtml, text, cls = '') => {
      const el = h('span', { class: `rb-chip ${cls}` }, iconHtml ? h('span', { class: 'rb-chip-icon', html: iconHtml }) : null, text);
      el.style.opacity = '0';
      chipsEl.append(el);
      st.chips.push({ el, s: new Spring(0.6, { stiffness: 440, damping: 21 }) });
      return el;
    };
    if (st.tier === 'max') { chip(glyph('star'), 'Your camp is complete', 'rb-chip-gold'); return; }
    const labels = st.unlocks.map(unlockLabel).filter(Boolean);
    // nothing new to build this time: the level still opens the clouds wider (world/sky), so say that
    if (!labels.length) { chip(glyph('island'), 'The clouds open up'); return; }
    // name what fits in MAX_ROWS rows; anything beyond shows as an icon-only sticker (the bridge, the hunter's
    // hat...), never a bare "+2"
    const build = named => {
      chipsEl.textContent = '';
      st.chips = [];
      labels.forEach((l, i) => {
        if (i < named) { chip(glyph(l.icon, ...(l.args || [])), l.text); return; }
        const el = chip(glyph(l.icon, ...(l.args || [])), null, 'rb-chip-i');
        el.setAttribute('aria-label', l.text); el.title = l.text;
      });
    };
    let named = Math.min(labels.length, mobile ? NAMED_MOBILE : NAMED_DESK);
    if (named < labels.length) named--; // one icon sticker alone looks odd next to a full row of names
    build(named);
    const rows = () => new Set([...chipsEl.children].map(el => el.offsetTop)).size;
    while (named > 1 && rows() > (mobile ? MAX_ROWS_MOBILE : MAX_ROWS_DESK)) build(--named);
  }

  // ---- layout: where the ribbon and the stickers sit while big (A) and once folded up (B), in screen px ----
  function layout() {
    const W = innerWidth, S = hud.scale || 1, T = st.T;
    const cb = cluster.getBoundingClientRect();
    const rw = ribbon.offsetWidth, rh = ribbon.offsetHeight, cw = chipsEl.offsetWidth, ch = chipsEl.offsetHeight;
    const sA = S * T.scale;
    const L = { rw, rh, cw, ch, sA, cS: S };
    if (mobile) {
      L.xA = W / 2; L.yA = cb.bottom + 2;                     // right under the badge (safe top + ~72 px)
      // folded: beside the badge, centred on it, in the room to its right (tails included)
      const tailRoom = 36;
      const x0 = cb.right + 8, x1 = W - 8;
      L.sB = Math.min(DOCK_S_MOBILE * S, (x1 - x0) / (rw + tailRoom * 2));
      L.xB = (x0 + x1) / 2;
      L.yB = cb.top + cb.height / 2 - (rh * L.sB) / 2;
      L.cyB = cb.bottom + 4;                                  // the stickers move up into the ribbon's old place
      L.cSB = S * CHIPS_FOLDED_MOBILE;                        // ...a touch smaller, so the top of the camp shows
    } else {
      L.xA = W / 2; L.yA = Math.max(cb.top, 8) + 2;          // level with the badge, centred
      L.sB = DOCK_S_DESK * S;
      L.xB = W / 2; L.yB = Math.max(4, cb.top - 4);
      L.cSB = S;
      L.cyB = L.yB + rh * L.sB + 8 * S;
    }
    L.cyA = L.yA + rh * sA + (mobile ? 10 : 12) * S;
    return L;
  }

  // ---- confetti (levels 4 and 5): sticker bits thrown up from behind the ribbon, falling with a flutter ----
  function spawnConfetti(n, cx, cy, seed) {
    const r = rng(seed);
    const k = mobile ? 0.75 : 1;
    for (let i = 0; i < Math.round(n * k); i++) {
      const el = h('span', { class: `rb-bit${r() < 0.3 ? ' is-round' : ''}` });
      el.style.background = CONF_COLORS[Math.floor(r() * CONF_COLORS.length)];
      conf.append(el);
      const a = -Math.PI / 2 + (r() - 0.5) * 2.3;
      const sp = (380 + r() * 520) * (mobile ? 0.8 : 1);
      pieces.push({
        el, x: cx + (r() - 0.5) * 120, y: cy + (r() - 0.5) * 20, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        r: r() * 360, vr: (r() - 0.5) * 720, flip: r() * 6, vf: 7 + r() * 9, t: 0, life: 1.5 + r() * 0.8, s: 0.8 + r() * 0.5,
      });
    }
  }
  function updateConfetti(dt) {
    for (let i = pieces.length - 1; i >= 0; i--) {
      const p = pieces[i];
      p.t += dt;
      if (p.t >= p.life) { p.el.remove(); pieces.splice(i, 1); continue; }
      p.vy += GRAVITY * dt; p.vx *= Math.exp(-1.6 * dt); p.vy = Math.min(p.vy, 260 + 60 * Math.sin(p.flip));
      p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.vr * dt; p.flip += p.vf * dt;
      tf(p.el, `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0) rotate(${p.r.toFixed(1)}deg) scale(${(p.s * Math.cos(p.flip)).toFixed(3)}, ${p.s.toFixed(3)})`);
      op(p.el, p.t < 0.06 ? p.t / 0.06 : clamp01((p.life - p.t) / 0.4));
    }
  }

  function update(dt) {
    updateConfetti(dt);
    if (!st) return;
    if (st.collecting) {
      st.collecting = false;
      fill();
      root.style.visibility = 'visible'; op(root, 0);
      st.L = layout();
      return;
    }
    st.t += dt;
    // the badge's tag has settled on its new width by now ("Light the fire" -> "Camp 1"): measure where to fold to
    if (st.t >= st.T.fold && !st.relaid) { st.relaid = true; st.L = layout(); }
    const t = st.t, T = st.T, L = st.L, red = reduceMotion();
    if (t >= T.end) {
      st = null;
      root.style.visibility = 'hidden';
      hud.campToasts?.block?.(false);
      return;
    }
    const kIn = easeOut(clamp01(t / B_IN));
    const kOut = t > T.end - B_OUT ? easeOut(clamp01((t - (T.end - B_OUT)) / B_OUT)) : 0;
    const kF = easeInOut(clamp01((t - T.fold) / FOLD_T));      // big -> folded up
    op(root, clamp01(t / 0.16) * (1 - kOut));

    // ribbon: drops in under the badge with a small spring, then shrinks and slides up
    const lerp = (a, b) => a + (b - a) * kF;
    const s0 = red ? L.sA : L.sA * (0.9 + 0.1 * kIn);
    const rs = lerp(s0, L.sB) * (1 - 0.04 * kOut);
    const rx = lerp(L.xA, L.xB) - (L.rw * rs) / 2;
    const ry = lerp(L.yA + (red ? 0 : (1 - kIn) * -18), L.yB) - kOut * 10;
    tf(ribbon, `translate3d(${rx.toFixed(2)}px, ${ry.toFixed(2)}px, 0) scale(${rs.toFixed(4)})`);
    // stickers: under the ribbon, then up into the ribbon's old place (phones) / under the folded ribbon
    const cs = lerp(L.cS, L.cSB);
    const cx = (L.xA) - (L.cw * cs) / 2;
    const cy = lerp(L.cyA, L.cyB) - kOut * 8;
    tf(chipsEl, `translate3d(${cx.toFixed(2)}px, ${cy.toFixed(2)}px, 0) scale(${cs.toFixed(4)})`);

    // tails unfold sideways from behind the face
    const kTail = easeOut(clamp01((t - 0.05) / 0.38));
    tails.style.setProperty('--tail', (red ? 1 : 0.3 + 0.7 * kTail).toFixed(4));
    // the title lands with a bump (bigger at levels 4 and 5)
    const kp = clamp01((t - 0.18) / 0.34);
    const bump = red || kp <= 0 || kp >= 1 ? 1 : 1 + T.bump * Math.sin(Math.PI * kp) * (1 - kp * 0.4);
    tf(title, `scale(${bump.toFixed(4)})`);
    // star burst behind the ribbon while it is big; it fades as the ribbon folds up
    const kb = easeOut(clamp01((t - 0.08) / 0.5));
    const bx = L.xA, by = L.yA + (L.rh * L.sA) / 2;
    op(burst, kb * (1 - kF) * (1 - kOut) * (st.tier === 'std' ? 0.75 : 0.95));
    tf(burst, `translate3d(${bx.toFixed(1)}px, ${by.toFixed(1)}px, 0) translate(-50%, -50%) rotate(${(red ? 0 : t * 14).toFixed(2)}deg) scale(${((red ? 1 : 0.6 + 0.4 * kb) * T.burst * (1 - 0.3 * kF)).toFixed(4)})`);
    // a sheen across the face (two at levels 4 and 5)
    const sweep = (t0, d) => clamp01((t - t0) / d);
    let ks = sweep(0.45, 0.75);
    if (st.tier !== 'std' && ks >= 1) ks = sweep(1.25, 0.75);
    op(sheen, ks > 0 && ks < 1 && !red ? 1 : 0);
    tf(sheen, `translateX(${(-130 + 360 * easeOut(ks)).toFixed(1)}%) skewX(-18deg)`);
    // star stickers on the face's top corners (levels 4 and 5)
    const stars = st.tier !== 'std';
    [starL, starR].forEach((el, i) => {
      if (!stars) { op(el, 0); return; }
      const t0 = 0.3 + i * 0.1;
      if (t < t0) { op(el, 0); return; }
      starS[i].target = 1;
      const s = red ? 1 : starS[i].update(dt);
      op(el, clamp01((t - t0) / 0.1));
      tf(el, `rotate(${((i ? 14 : -14) + (red ? 0 : Math.sin(t * 2.4 + i) * 6)).toFixed(2)}deg) scale(${s.toFixed(4)})`);
    });
    // confetti waves from behind the ribbon
    if (!red && st.spawned < T.waves && t >= 0.12 + st.spawned * 0.6) {
      spawnConfetti(T.confetti, bx, by, st.seed + st.spawned * 7);
      st.spawned++;
    }
    // unlock stickers pop in one by one and leave together with the ribbon
    st.chips.forEach((c, i) => {
      const t0 = CHIP0 + i * CHIP_STAGGER;
      if (t < t0) { op(c.el, 0); return; }
      c.s.target = 1;
      const s = red ? 1 : c.s.update(dt);
      op(c.el, clamp01((t - t0) / 0.12));
      tf(c.el, `scale(${s.toFixed(4)})`);
    });
  }

  return {
    update,
    show,
    resize() { if (st && !st.collecting) st.L = layout(); },
    get active() { return !!st; },
    get t() { return st ? st.t : -1; },
    get end() { return st ? st.T.end : 0; },
    get level() { return st ? st.level : 0; },
    rects() {
      if (!st || st.collecting) return [];
      const out = [];
      for (const el of [ribbon, chipsEl]) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) out.push(r); }
      return out;
    },
  };
}

// Folded ribbon ends: a notched strip with an outline, and a darker fold where it tucks under the face.
// Drawn once; the CSS hangs one off each side of the face and unfolds them with --tail.
function ribbonTailsSvg() {
  const ink = '#5b3a21';
  const tail = flip => `<svg class="rb-tail ${flip ? 'rb-tail-r' : 'rb-tail-l'}" viewBox="0 0 64 56" aria-hidden="true">`
    + `<g${flip ? ' transform="translate(64 0) scale(-1 1)"' : ''}>`
    + `<path d="M62 10H6.5c-1.6 0-2.4 1.9-1.3 3L18 27 5.2 41c-1.1 1.1-.3 3 1.3 3H62z" class="t-body" stroke="${ink}" stroke-width="3" stroke-linejoin="round"/>`
    + '<path class="t-hi" d="M60 13.5H11" fill="none" stroke-width="2" stroke-linecap="round" opacity=".85"/>'
    + `<path class="t-fold" d="M46 44l16 9.5V44z" stroke="${ink}" stroke-width="3" stroke-linejoin="round"/>`
    + '</g></svg>';
  return tail(false) + tail(true);
}

// A soft star burst for behind the ribbon: 14 cream rays fading out radially.
function burstSvg() {
  let rays = '';
  const n = 14;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = a0 + ((Math.PI * 2) / n) * 0.5;
    const p = (a, r) => `${(100 + Math.cos(a) * r).toFixed(1)} ${(100 + Math.sin(a) * r).toFixed(1)}`;
    rays += `<path d="M100 100L${p(a0, 100)}L${p(a1, 100)}Z"/>`;
  }
  return '<svg viewBox="0 0 200 200" aria-hidden="true"><defs>'
    + '<radialGradient id="rbFade" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#fff6d8" stop-opacity=".95"/>'
    + '<stop offset=".55" stop-color="#ffe7a6" stop-opacity=".5"/><stop offset="1" stop-color="#ffe7a6" stop-opacity="0"/></radialGradient>'
    + `</defs><g fill="url(#rbFade)">${rays}</g><circle cx="100" cy="100" r="46" fill="url(#rbFade)" opacity=".7"/></svg>`;
}
