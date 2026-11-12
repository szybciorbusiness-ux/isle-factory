// Camp HUD (GAMEPLAY.md "ui", UI-STYLE.md "sticker" language). The world is the UI, so this stays small:
//  - top-left: the camp level badge, a round orange sticker with the flame inside a thick progress ring (the
//    current hearth pad's payment), and a cream tag "Camp 2" ("Light the fire" while the hearth is cold).
//    Tap it for a little card of what the next level unlocks.
//  - above the robot: the carried-stack sticker "7 / 10" with the top item's icon breaking out of its left
//    edge; numbers roll, the icon bumps, "+N" floats up; at capacity it turns into a red "Full" bubble that
//    wobbles. Projected from the world every frame and clamped to the viewport.
//  - a level-up ribbon (orange sticker, folded tails, star burst, outlined title, unlock stickers popping in
//    one by one), toasts for camp news (camp-toasts.js), a desktop walk hint that fades after the first steps.
//  - phones: --hud-bottom = safe-bottom + 12 px (the bottom of the screen stays free for the joystick).
// Every transform / opacity is written from update(dt) (pausing and __game.step freeze it): ease-out
// cubic-bezier(.23, 1, .32, 1) for enters / exits, springs for bumps and sticker pops, damped values for rings.
import * as THREE from 'three';
import { h, setText, setClass, easeOut, reduceMotion } from './dom.js';
import { glyph, ROLE_HAT } from './camp-glyphs.js';
import { STATIONS, UPGRADES, WORKERS, MAX_LEVEL, PADS } from '../sim/camp-data.js';

const ISLAND_NAMES = { west: 'Forest', north: 'Meadow', east: 'Copper isle', south: 'Deer glade' };
const NTH = ['', '', 'Second', 'Third', 'Fourth', 'Fifth'];

// level-up ribbon timeline (s)
const B_IN = 0.42, B_HOLD = 3.1, B_OUT = 0.26, B_CHIP0 = 0.34, B_CHIP_STAGGER = 0.11;
// level badge: the ring fills, the number flips, the ring empties for the next level (s)
const L_FILL = 0.36, L_FLIP = 0.34, L_RESET = 0.5;
// stack sticker anchor when the player can't tell us where its stack ends (world units above the feet)
const STACK_BASE_Y = 1.15, STACK_STEP_Y = 0.045;
const ROLL = 0.17;          // s, one odometer roll
const FLOAT_LIFE = 0.95;    // s, a "+N" floater
const FLOAT_MERGE = 0.35;   // s, gains this close together grow one floater
const TIP_LIFE = 4;         // s, the "next level" card closes itself

// Friendly name + glyph for a pad id ('build:hut', 'bridge:west', 'upgrade:pack1', 'hire:hunter#2').
export function unlockLabel(padId) {
  const [kind, arg = ''] = String(padId).split(':');
  const [what, nth] = arg.split('#');
  if (kind === 'build') return { text: STATIONS[what]?.name || what, icon: what === 'hut' ? 'hut' : 'build' };
  if (kind === 'bridge') return { text: `${ISLAND_NAMES[what] || what} bridge`, icon: 'bridge' };
  if (kind === 'upgrade') return { text: UPGRADES[what]?.name || what, icon: UPGRADES[what]?.capacity ? 'pack' : 'axe' };
  if (kind === 'hire') {
    const name = WORKERS[what]?.name || what;
    return { text: nth ? `${NTH[Number(nth)] || 'Another'} ${name.toLowerCase()}` : name, icon: 'worker', args: [ROLE_HAT[what]] };
  }
  return null;
}
// Pads a hearth level opens (static data, for the "next level" card).
export const unlocksForLevel = level => PADS.filter(p => !p.id.startsWith('hearth:') && p.requires?.level === level).map(p => p.id);

// Outlined numerals / words (UI-STYLE "numbers are the hero"): a stroked layer under a plain fill layer.
const ol = (text, cls = '') => h('span', { class: `ol ${cls}`, 'data-t': String(text) }, String(text));
function setOl(el, text) {
  const s = String(text);
  if (el.__t === s) return;
  el.__t = s; el.textContent = s; el.dataset.t = s;
}
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeIn = t => t * t * t;
const tf = (el, v) => { if (el.__tf !== v) { el.__tf = v; el.style.transform = v; } };
const op = (el, v) => { const s = typeof v === 'number' ? v.toFixed(3) : v; if (el.__op !== s) { el.__op = s; el.style.opacity = s; } };

export function createCampHud(hud) {
  const { ctx, layer, icons, mobile } = hud;
  const { camp, events, views } = ctx;
  const { Spring, Wobble, damp } = ctx.anim;
  const reduced = () => reduceMotion();
  let clock = 0;

  // =====================================================================================================
  // DOM
  // =====================================================================================================
  // ---- level badge + tag ----
  const ringFill = svgEl('circle', { class: 'lvl-fill', cx: 32, cy: 32, r: 26.5, pathLength: 100 });
  const ringSvg = svgEl('svg', { class: 'lvl-ring', viewBox: '0 0 64 64', 'aria-hidden': 'true' },
    svgEl('circle', { class: 'lvl-ring-ol', cx: 32, cy: 32, r: 26.5 }),
    svgEl('circle', { class: 'lvl-ring-well', cx: 32, cy: 32, r: 26.5 }),
    ringFill);
  const disc = h('span', { class: 'lvl-disc', html: glyph('flameLight') });
  const badge = h('span', { class: 'lvl-badge' }, ringSvg, disc);
  const numA = h('b', { class: 'lvl-num' }, '1');
  const numB = h('b', { class: 'lvl-num' }, '');
  const lvlMain = h('span', { class: 'lvl-main' }, h('span', { class: 'lvl-word' }, 'Camp'), h('span', { class: 'lvl-nums' }, numA, numB));
  const lvlCold = h('span', { class: 'lvl-cold' }, 'Light the fire');
  const lvlText = h('span', { class: 'lvl-text' }, lvlMain, lvlCold);
  const tag = h('span', { class: 'lvl-tag' }, lvlText);
  const lvlBtn = h('button', { class: 'lvl hit', type: 'button', tabindex: -1 }, badge, tag);
  const tipTitle = h('div', { class: 'lvl-tip-title' });
  const tipList = h('div', { class: 'lvl-tip-list' });
  const tip = h('div', { class: 'lvl-tip', 'aria-hidden': 'true' }, tipTitle, tipList);
  const cluster = h('div', { class: 'camp-tl' }, lvlBtn, tip);
  layer.append(cluster);

  // ---- stack sticker (world-anchored above the robot) ----
  const stkImg = h('span', { class: 'cs-icon', html: glyph('stack') });
  const nA = h('b', { class: 'cs-n' }, '0'), nB = h('b', { class: 'cs-n' }, '');
  const capEl = h('span', { class: 'cs-cap' }, String(camp.capacity));
  const countEl = h('span', { class: 'cs-count' }, h('span', { class: 'cs-roll' }, nA, nB), h('span', { class: 'cs-sep' }, '/'), capEl);
  const fullEl = ol('Full', 'cs-full');
  const bub = h('div', { class: 'cs-bub' }, h('span', { class: 'cs-pulse' }), h('span', { class: 'cs-body' }), stkImg, h('span', { class: 'cs-vals' }, countEl, fullEl), h('span', { class: 'cs-tail' }));
  const stackAnchor = h('div', { class: 'cs', role: 'status' }, bub);
  stackAnchor.style.visibility = 'hidden';
  layer.append(stackAnchor);

  // ---- level-up ribbon ----
  const tails = h('span', { class: 'rb-tails', html: ribbonTailsSvg() });
  const bTitle = ol('Camp level 2', 'rb-title');
  const bSheen = h('span', { class: 'rb-sheen' });
  const bFace = h('div', { class: 'rb-face' }, h('span', { class: 'rb-flame', html: glyph('flameLight') }), bTitle, bSheen);
  const burst = h('span', { class: 'rb-burst', html: burstSvg() });
  const bRibbon = h('div', { class: 'rb-ribbon' }, tails, bFace);
  const bChips = h('div', { class: 'rb-chips' });
  const banner = h('div', { class: 'rb', 'aria-live': 'polite' }, burst, bRibbon, bChips);
  banner.style.visibility = 'hidden';
  layer.append(banner);

  // ---- desktop walk hint ----
  let hint = null;
  if (!mobile) {
    const keys = ks => h('span', { class: 'ch-keys' }, ks.map(k => h('kbd', { class: 'ch-key' }, k)));
    hint = h('div', { class: 'camp-hint' },
      keys(['W', 'A', 'S', 'D']), h('span', { class: 'ch-or' }, 'or arrow keys'), h('span', null, 'to walk'),
      h('i', { class: 'ch-dot' }), h('span', { class: 'ch-soft' }, 'your robot gathers on its own'));
    hint.style.opacity = '0';
    layer.append(hint);
  }

  // ---- --hud-bottom (DESIGN.md 3b): the camp leaves the bottom free, so it's the safe area + 12 px ----
  const probe = h('div', { class: 'camp-probe', 'aria-hidden': 'true' });
  layer.append(probe);
  let hudBottom = -1;
  function measure() {
    const b = Math.max(0, Math.round(probe.offsetHeight));
    if (b !== hudBottom) { hudBottom = b; document.documentElement.style.setProperty('--hud-bottom', `${b}px`); }
  }
  measure();

  // =====================================================================================================
  // level badge
  // =====================================================================================================
  const badgeS = new Spring(1, { stiffness: 360, damping: 16 });
  let ring = 0, ringAlpha = 1, glow = 0, cold = camp.level <= 0 ? 1 : 0;
  let shownLevel = camp.level;
  let lvlFx = null;         // { t, from, to, flipped, reset }
  let lastAria = '';
  let textW = { main: 0, cold: 0 };

  const hearthPad = () => camp.pads.find(p => p.id.startsWith('hearth:')) || null;
  function padFrac(pad) {
    let tot = 0, paid = 0;
    for (const [k, n] of Object.entries(pad.cost)) { tot += n; paid += Math.min(n, pad.paid?.[k] || 0); }
    return { tot, paid, p: tot ? paid / tot : 0 };
  }
  events.on('pad:paid', ({ pad } = {}) => {
    if (pad?.id?.startsWith('hearth:') && !reduced()) badgeS.velocity = Math.min(badgeS.velocity + 0.9, 2.2);
  });
  events.on('pad:complete', ({ pad } = {}) => {
    if (!pad?.id?.startsWith('hearth:')) return;
    lvlFx = { t: 0, from: shownLevel, to: Number(pad.id.split(':')[1]) || shownLevel + 1, flipped: false, reset: false };
    closeTip();
  });

  const measureText = () => { textW = { main: lvlMain.offsetWidth, cold: lvlCold.offsetWidth }; };
  function showLayer(el, on) { el.__tf = el.__op = undefined; el.style.transform = ''; el.style.opacity = on ? '' : '0'; el.style.visibility = on ? '' : 'hidden'; }
  function setLevelNow(level) {
    shownLevel = level;
    setText(numA, String(Math.max(1, level)));
    numA.__tf = numA.__op = numB.__tf = numB.__op = undefined;
    numA.style.transform = ''; numA.style.opacity = '';
    numB.style.opacity = '0'; numB.style.transform = '';
    showLayer(lvlMain, level > 0);
    showLayer(lvlCold, level <= 0);
    cold = level <= 0 ? 1 : 0;
    measureText();
    lvlText.style.width = `${level > 0 ? textW.main : textW.cold}px`;
    setClass(lvlBtn, 'is-max', level >= MAX_LEVEL);
    setClass(lvlBtn, 'is-cold', level <= 0);
  }
  setLevelNow(camp.level);
  document.fonts?.ready?.then(() => { if (!lvlFx) setLevelNow(shownLevel); }, () => {});

  function updateLevel(dt) {
    const pad = hearthPad();
    const frac = pad ? padFrac(pad) : null;
    let target = frac ? frac.p : (camp.level >= MAX_LEVEL ? 1 : 0);
    if (lvlFx) {
      const f = lvlFx;
      f.t += dt;
      const lighting = f.from <= 0; // cold -> lit: the whole label changes and the flame warms up
      if (f.t < L_FILL + L_FLIP) target = 1;
      glow = damp(glow, f.t < L_FILL + L_FLIP + 0.2 ? 1 : 0, 10, dt);
      if (f.t >= L_FILL && !f.flipped) {
        f.flipped = true;
        if (lighting) { setText(numA, String(f.to)); lvlMain.style.visibility = ''; measureText(); }
        else setText(numB, String(f.to));
        if (!reduced()) badgeS.velocity += 4.4;
      }
      if (f.flipped) {
        const k = easeOut(clamp01((f.t - L_FILL) / L_FLIP));
        const [outEl, inEl] = lighting ? [lvlCold, lvlMain] : [numA, numB];
        op(outEl, 1 - k); op(inEl, k);
        if (!reduced()) { tf(outEl, `translateY(${(-k * 100).toFixed(1)}%)`); tf(inEl, `translateY(${((1 - k) * 100).toFixed(1)}%)`); }
        if (lighting) {
          cold = 1 - k;
          const kw = easeOut(clamp01((f.t - L_FILL) / (L_FLIP + 0.1)));
          lvlText.style.width = `${(textW.cold + (textW.main - textW.cold) * kw).toFixed(1)}px`;
        }
      }
      const r0 = L_FILL + L_FLIP;
      if (f.t >= r0) {
        const k = clamp01((f.t - r0) / L_RESET);
        if (k < 0.4) ringAlpha = 1 - easeOut(k / 0.4);
        else {
          if (!f.reset) { f.reset = true; ring = 0; setLevelNow(f.to); }
          ringAlpha = easeOut((k - 0.4) / 0.6);
        }
        if (k >= 1) { lvlFx = null; ringAlpha = 1; }
      }
    } else {
      glow = damp(glow, 0, 10, dt);
      if (camp.level !== shownLevel) setLevelNow(camp.level); // changed behind the bus (tests)
    }
    // the ring glides toward the paid fraction, a touch behind the paying stream
    ring = damp(ring, target, lvlFx ? 14 : 7, dt);
    if (Math.abs(ring - target) < 0.0005) ring = target;
    const off = (100 * (1 - ring)).toFixed(2);
    if (ringFill.__off !== off) { ringFill.__off = off; ringFill.style.strokeDashoffset = off; }
    op(ringFill, ring < 0.004 ? 0 : ringAlpha);
    const s = badgeS.update(dt);
    tf(badge, Math.abs(s - 1) > 0.001 ? `scale(${s.toFixed(4)})` : '');
    badge.style.setProperty('--glow', glow.toFixed(3));
    badge.style.setProperty('--cold', cold.toFixed(3));
    const aria = camp.level <= 0 ? `The hearth is cold${frac ? `, ${Math.round(frac.p * 100)}% lit` : ''}`
      : camp.level >= MAX_LEVEL ? `Camp level ${camp.level}, complete`
        : frac ? `Camp level ${camp.level}, ${Math.round(frac.p * 100)}% to level ${camp.level + 1}` : `Camp level ${camp.level}`;
    if (aria !== lastAria) { lastAria = aria; lvlBtn.setAttribute('aria-label', aria); }
  }

  // ---- "what's next" card (tap the badge) ----
  const tipS = { open: false, t: 0, k: 0 };
  const tipScale = new Spring(0.9, { stiffness: 420, damping: 24 });
  function fillTip() {
    tipTitle.textContent = ''; tipList.textContent = '';
    const lvl = camp.level;
    if (lvl >= MAX_LEVEL) { tipTitle.append('Your camp is complete'); return; }
    const ids = unlocksForLevel(lvl + 1);
    if (lvl <= 0) tipTitle.append('Light the fire to unlock');
    else tipTitle.append('Camp ', h('b', null, String(lvl + 1)), ' unlocks');
    for (const id of ids) {
      const l = unlockLabel(id);
      if (l) tipList.append(h('span', { class: 'tip-chip' }, h('span', { class: 'tip-chip-icon', html: glyph(l.icon, ...(l.args || [])) }), l.text));
    }
    if (!ids.length) tipList.append(h('span', { class: 'tip-none' }, 'A bigger camp'));
  }
  function openTip() { fillTip(); tipS.open = true; tipS.t = 0; tipScale.value = 0.9; tipScale.velocity = 0; tipScale.target = 1; tip.setAttribute('aria-hidden', 'false'); }
  function closeTip() { if (!tipS.open) return; tipS.open = false; tip.setAttribute('aria-hidden', 'true'); }
  lvlBtn.addEventListener('click', e => { e.stopPropagation(); if (tipS.open) closeTip(); else openTip(); if (!reduced()) badgeS.velocity -= 2; });
  addEventListener('pointerdown', e => { if (tipS.open && !cluster.contains(e.target)) closeTip(); }, true);
  function updateTip(dt) {
    if (tipS.open) { tipS.t += dt; if (tipS.t > TIP_LIFE) closeTip(); }
    tipS.k = clamp01(tipS.k + (tipS.open ? dt / 0.2 : -dt / 0.15));
    const k = easeOut(tipS.k);
    const s = reduced() ? 1 : tipS.open ? tipScale.update(dt) : 0.94 + 0.06 * k;
    op(tip, k);
    tf(tip, `translateY(${((1 - k) * -6).toFixed(2)}px) scale(${s.toFixed(4)})`);
    tip.style.visibility = tipS.k <= 0 ? 'hidden' : 'visible';
  }

  // =====================================================================================================
  // stack sticker above the robot
  // =====================================================================================================
  const carry = camp.CARRY_ITEMS || ['wood', 'stone', 'meat', 'cookedMeat', 'plank', 'copperOre', 'copperBar'];
  const iconS = new Spring(1, { stiffness: 360, damping: 14 });
  const popS = new Spring(0.7, { stiffness: 420, damping: 22 }); // sticker appear / gain bumps
  const wob = new Wobble({ freq: 3.2, decay: 2.6 });              // the gentle "Full" wobble
  const shake = new Wobble({ freq: 8, decay: 8 });                // a refusal shake on camp:stackFull
  let shownN = -1, shownCap = -1, topItem;
  let pulseT = 0;
  let fullK = 0, fullHold = 0, capFlash = 0, lastFullPing = -9, fullSince = 0, wasFull = false;
  let vis = 0, visT = 0, outT = -1;   // vis: 0 hidden / 1 shown; outT >= 0 while leaving
  let roll = null;                    // { k, dir }
  let anchorY = null, sx = -1, sy = -1, lift = 0;
  let ghEl = null;
  let bw = 120, bh = 46;
  let lastAriaN = -1, lastAriaCap = -1;
  const floats = [];                  // { el, txt, t, n }
  const v3 = new THREE.Vector3();

  const roBub = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { bw = bub.offsetWidth || bw; bh = bub.offsetHeight || bh; }) : null;
  roBub?.observe(bub);

  events.on('camp:stackFull', () => {
    if (clock - lastFullPing < 0.7) return; // the sim can fire this every swing
    lastFullPing = clock;
    fullHold = 1.6;                          // show "Full" even while the last items are still flying in
    if (!reduced()) { shake.hit(3.5); popS.velocity += 1.6; }
  });
  events.on('capacity:changed', () => { capFlash = 1; if (!reduced()) popS.velocity += 2.6; });

  const shownTotal = () => { let n = 0; for (const it of carry) n += hud.shown[it] || 0; return n; };
  function setTopIcon(item) {
    if (item === topItem) return;
    topItem = item;
    stkImg.textContent = '';
    if (item) stkImg.append(icons.img(item, 'cs-img'));
    else stkImg.innerHTML = glyph('stack');
  }
  function floater(delta) {
    const last = floats[floats.length - 1];
    if (last && last.t < FLOAT_MERGE) { last.n += delta; setOl(last.txt, `+${last.n}`); last.t = Math.min(last.t, 0.08); return; }
    const txt = ol(`+${delta}`, 'cs-plus');
    const el = h('span', { class: 'cs-float', 'aria-hidden': 'true' }, txt);
    el.style.opacity = '0';
    stackAnchor.append(el);
    floats.push({ el, txt, t: 0, n: delta });
  }

  // The guide's first-time hint bubble (view/guide/hints.js) also sits above the robot: while it shows, the
  // stack sticker glides up and waits above it instead of overlapping.
  function guideHintRect() {
    const gl = views.guide?.el;
    if (!gl) return null;
    if (!ghEl || !ghEl.isConnected) ghEl = gl.querySelector('.gh');
    if (!ghEl || ghEl.style.visibility !== 'visible' || !(Number(ghEl.style.opacity) > 0.05)) return null;
    // .gh is a 0x0 anchor; its first child is the visible card + tail
    const r = (ghEl.firstElementChild || ghEl).getBoundingClientRect();
    return r.height > 0 ? r : null;
  }

  function anchorWorld(n) {
    const pl = views.player;
    if (pl?.getStackTop) { const p = pl.getStackTop(v3); if (p) return v3; }
    const p = pl?.getPosition?.(v3) || v3.set(ctx.sim.player.x, 0, ctx.sim.player.z);
    v3.y = (p.y || 0) + STACK_BASE_Y + Math.min(n, 30) * STACK_STEP_Y;
    return v3;
  }

  function updateStack(dt) {
    const n = shownTotal();
    const cap = camp.capacity;
    if (n !== shownN) {
      const prev = shownN;
      shownN = n;
      if (prev >= 0 && vis > 0 && !reduced()) {
        roll = { k: roll ? Math.min(roll.k, 0.35) : 0, dir: n > prev ? 1 : -1 };
        setText(nA, String(prev)); setText(nB, String(n));
      } else { setText(nA, String(n)); roll = null; tf(nA, ''); op(nA, 1); op(nB, 0); }
      if (prev >= 0 && n > prev && !reduced()) { iconS.velocity += 3.2; popS.velocity += 0.9; floater(n - prev); }
      if (n > 0) setTopIcon(camp.stack[camp.stack.length - 1]);
    }
    if (cap !== shownCap) { shownCap = cap; setText(capEl, String(cap)); }
    // odometer roll
    if (roll) {
      roll.k = Math.min(1, roll.k + dt / ROLL);
      const k = easeOut(roll.k);
      tf(nA, `translateY(${(-roll.dir * k * 100).toFixed(1)}%)`); op(nA, 1 - k);
      tf(nB, `translateY(${(roll.dir * (1 - k) * 100).toFixed(1)}%)`); op(nB, k);
      if (roll.k >= 1) { roll = null; setText(nA, String(shownN)); tf(nA, ''); op(nA, 1); op(nB, 0); }
    }

    // full: the sticker turns red and reads "Full", with a soft wobble now and then
    const full = n >= cap || (fullHold > 0 && camp.free() <= 0);
    fullHold = Math.max(0, fullHold - dt);
    if (full && !wasFull && !reduced()) { wob.hit(1); popS.velocity += 2.2; }
    wasFull = full;
    fullK = damp(fullK, full ? 1 : 0, 12, dt);
    fullSince = full ? fullSince + dt : 0;
    if (full && fullSince > 2.4 && !reduced()) { fullSince = 0; wob.hit(0.8); }
    // a soft red pulse ring breathes out of the outline every 1.3 s while full
    pulseT = full ? pulseT + dt : 0;
    bub.style.setProperty('--pk', (full && !reduced() ? easeOut((pulseT % 1.3) / 1.3) : 0).toFixed(3));
    bub.style.setProperty('--full', fullK.toFixed(3));
    const kf = easeOut(fullK);
    op(countEl, 1 - kf);
    op(fullEl, kf);
    tf(countEl, `scale(${(1 - 0.2 * kf).toFixed(4)})`);
    tf(fullEl, `scale(${(0.8 + 0.2 * kf).toFixed(4)})`);
    setClass(bub, 'is-full', full);
    capFlash = Math.max(0, capFlash - dt / 1.1);
    bub.style.setProperty('--flash', capFlash.toFixed(3));

    // shown while carrying; leaves with a tiny grow then a shrink (DESIGN: nothing pops)
    if (n > 0) {
      if (vis <= 0 || outT >= 0) { popS.value = outT >= 0 ? Math.max(0.75, popS.value) : 0.7; popS.velocity = 0; if (vis <= 0) visT = 0; outT = -1; }
      vis = 1; visT += dt;
    } else if (vis > 0) {
      if (outT < 0) outT = 0;
      outT += dt;
      if (outT > 0.3) { vis = 0; outT = -1; }
    }
    stackAnchor.style.visibility = vis > 0 ? 'visible' : 'hidden';
    if (vis <= 0) return;

    // project the anchor; vertical changes (the stack growing) are smoothed, horizontal follows the robot
    const w = anchorWorld(Math.max(n, 0));
    ctx.camera.updateMatrixWorld();
    w.project(ctx.camera);
    const W = innerWidth, H = innerHeight;
    let x = (w.x * 0.5 + 0.5) * W, y = (-w.y * 0.5 + 0.5) * H;
    anchorY = anchorY == null ? y : anchorY + (y - anchorY) * (1 - Math.exp(-14 * dt));
    y = anchorY;
    const gh = guideHintRect();
    const want = gh && Math.abs((gh.left + gh.right) / 2 - x) < (gh.width + bw) / 2 && gh.bottom > y - bh - 14 ? Math.max(0, y - (gh.top - 6)) : 0;
    lift = damp(lift, want, 12, dt);
    y -= lift;
    const pad = 10, top = (mobile ? 64 : 8) + bh + pad;
    x = Math.min(W - bw / 2 - pad, Math.max(bw / 2 + pad, x));
    y = Math.min(H - pad, Math.max(top, y));
    if (Math.abs(x - sx) > 0.05 || Math.abs(y - sy) > 0.05) { sx = x; sy = y; tf(stackAnchor, `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`); }

    // sticker motion: spring scale, the Full wobble (a gentle rock), the refusal shake
    popS.target = 1;
    let s = reduced() ? 1 : popS.update(dt);
    let a = 1;
    if (outT >= 0) {
      const k = outT / 0.3;
      s = reduced() ? 1 : k < 0.3 ? 1 + 0.08 * easeOut(k / 0.3) : 1.08 * (1 - easeIn((k - 0.3) / 0.7) * 0.4);
      a = 1 - easeIn(clamp01((k - 0.3) / 0.7));
    } else if (visT < 0.18) a = easeOut(visT / 0.18);
    wob.update(dt); shake.update(dt);
    const rot = reduced() ? 0 : wob.value * 5;
    const sh = reduced() ? 0 : shake.value;
    tf(bub, `translateX(${sh.toFixed(2)}px) rotate(${rot.toFixed(2)}deg) scale(${s.toFixed(4)})`);
    op(bub, a);
    const is = iconS.update(dt);
    tf(stkImg, Math.abs(is - 1) > 0.001 ? `scale(${is.toFixed(4)}) rotate(${((is - 1) * -30).toFixed(2)}deg)` : '');

    // "+N" floaters rise from the counter with a little arc and fade in the last third
    for (let i = floats.length - 1; i >= 0; i--) {
      const f = floats[i];
      f.t += dt;
      const k = f.t / FLOAT_LIFE;
      if (k >= 1 || fullK > 0.6) { f.el.remove(); floats.splice(i, 1); continue; }
      const ky = easeOut(k);
      const fx = bw / 2 - 12 + 12 * Math.sin(k * Math.PI * 0.6);
      const fy = -bh - 10 - 34 * ky;
      const fs = k < 0.15 ? 0.8 + 0.2 * easeOut(k / 0.15) : 1;
      tf(f.el, `translate3d(${fx.toFixed(2)}px, ${fy.toFixed(2)}px, 0) scale(${fs.toFixed(3)})`);
      op(f.el, k < 0.12 ? k / 0.12 : k > 0.66 ? 1 - (k - 0.66) / 0.34 : 1);
    }
    if (n !== lastAriaN || cap !== lastAriaCap) {
      lastAriaN = n; lastAriaCap = cap;
      stackAnchor.setAttribute('aria-label', n >= cap ? `Carrying ${n} of ${cap}, full` : `Carrying ${n} of ${cap}`);
    }
  }

  // =====================================================================================================
  // level-up ribbon
  // =====================================================================================================
  let bState = null; // { t, level, unlocks, collecting, complete, chips: [{ el, s }] }
  events.on('hearth:level', ({ level } = {}) => {
    const L = level ?? camp.level;
    bState = { t: 0, level: L, unlocks: [], collecting: true, complete: L >= MAX_LEVEL, chips: [] };
    hud.campToasts?.block?.(true);
  });
  events.on('pad:shown', ({ pad } = {}) => {
    if (bState?.collecting && pad && !pad.id.startsWith('hearth:')) bState.unlocks.push(pad.id);
  });

  function fillBanner(st) {
    setOl(bTitle, st.level <= 1 ? 'The fire is lit' : `Camp level ${st.level}`); // level 1 = the cold hearth was lit
    setClass(banner, 'is-max', st.complete);
    bChips.textContent = '';
    const chip = (iconHtml, text, cls = '') => {
      const el = h('span', { class: `rb-chip ${cls}` }, iconHtml ? h('span', { class: 'rb-chip-icon', html: iconHtml }) : null, text);
      el.style.opacity = '0';
      bChips.append(el);
      st.chips.push({ el, s: new Spring(0.6, { stiffness: 440, damping: 21 }) });
    };
    if (st.complete) { chip(glyph('star'), 'Your camp is complete', 'rb-chip-gold'); return; }
    const labels = st.unlocks.map(unlockLabel).filter(Boolean);
    const max = 3; // UI-STYLE: 1-3 unlocked things
    const shownL = labels.slice(0, max);
    for (const l of shownL) chip(glyph(l.icon, ...(l.args || [])), l.text);
    if (labels.length > shownL.length) chip(null, `+${labels.length - shownL.length}`, 'rb-more');
  }

  function updateBanner(dt) {
    const st = bState;
    if (!st) return;
    if (st.collecting) { st.collecting = false; fillBanner(st); banner.style.visibility = 'visible'; op(banner, 0); return; }
    st.t += dt;
    const t = st.t;
    if (t >= B_HOLD + B_OUT) {
      bState = null;
      banner.style.visibility = 'hidden';
      hud.campToasts?.block?.(false);
      if (st.complete) hud.campToasts?.show?.({ text: 'Camp complete! ', strong: 'The isle runs itself', kind: 'celebrate', icon: 'star' });
      return;
    }
    const red = reduced();
    const kIn = easeOut(clamp01(t / B_IN));
    const kOut = t > B_HOLD ? easeOut(clamp01((t - B_HOLD) / B_OUT)) : 0;
    op(banner, clamp01(t / 0.16) * (1 - kOut));
    const y = red ? 0 : (1 - kIn) * -24 + kOut * -14;
    const s = red ? 1 : (0.9 + 0.1 * kIn) * (1 - 0.04 * kOut);
    tf(banner, `translate3d(-50%, ${y.toFixed(2)}px, 0) scale(${s.toFixed(4)})`);
    // tails unfold sideways from behind the face
    const kTail = easeOut(clamp01((t - 0.05) / 0.38));
    tails.style.setProperty('--tail', (red ? 1 : 0.3 + 0.7 * kTail).toFixed(4));
    // the title lands with a bump
    const kp = clamp01((t - 0.18) / 0.34);
    const bump = red || kp <= 0 || kp >= 1 ? 1 : 1 + 0.16 * Math.sin(Math.PI * kp) * (1 - kp * 0.4);
    tf(bTitle, `scale(${bump.toFixed(4)})`);
    // star burst: grows behind, turns slowly, fades with the ribbon
    const kb = easeOut(clamp01((t - 0.08) / 0.5));
    op(burst, kb * (1 - kOut) * 0.75);
    tf(burst, `translate(-50%, -50%) rotate(${(red ? 0 : t * 14).toFixed(2)}deg) scale(${(red ? 1 : 0.6 + 0.4 * kb).toFixed(4)})`);
    // one sheen across the face
    const ks = clamp01((t - 0.45) / 0.75);
    op(bSheen, ks > 0 && ks < 1 && !red ? 1 : 0);
    tf(bSheen, `translateX(${(-130 + 360 * easeOut(ks)).toFixed(1)}%) skewX(-18deg)`);
    // unlock stickers pop in one by one; they leave together a beat before the ribbon
    const kChipOut = t > B_HOLD - 0.08 ? easeOut(clamp01((t - B_HOLD + 0.08) / B_OUT)) : 0;
    st.chips.forEach((c, i) => {
      const t0 = B_CHIP0 + i * B_CHIP_STAGGER;
      if (t < t0) { op(c.el, 0); return; }
      c.s.target = 1;
      const cs = red ? 1 : c.s.update(dt);
      op(c.el, clamp01((t - t0) / 0.12) * (1 - kChipOut));
      tf(c.el, `translateY(${(kChipOut * -6).toFixed(2)}px) scale(${(cs * (1 - 0.06 * kChipOut)).toFixed(4)})`);
    });
  }

  // =====================================================================================================
  // toasts for camp news
  // =====================================================================================================
  const toast = o => hud.campToasts?.show?.(o);
  events.on('upgrade', ({ id, upgrade } = {}) => {
    const u = upgrade || UPGRADES[id] || {};
    if (u.capacity) toast({ text: `${u.name || 'Bigger pack'}: `, strong: `carry ${u.capacity}`, kind: 'good', icon: 'pack' });
    else if (u.gatherSpeed) toast({ text: `${u.name || 'New tools'}: `, strong: 'gather faster', kind: 'good', icon: 'axe' });
    else toast({ text: u.name || 'Upgrade done', kind: 'good', icon: 'build' });
  });
  events.on('worker:hired', ({ worker } = {}) => {
    const role = worker?.role || 'lumberjack';
    const name = (WORKERS[role]?.name || role).toLowerCase();
    let same = 0;
    for (const w of camp.workers.values()) if (w.role === role) same++;
    toast({ text: same > 1 ? `Another ${name} joined` : `A ${name} joined`, kind: 'good', icon: 'worker', iconArgs: [ROLE_HAT[role]] });
  });
  events.on('bridge:built', ({ bridge } = {}) => {
    toast({ text: 'New island: ', strong: ISLAND_NAMES[bridge?.id] || 'over the water', kind: 'good', icon: 'island' });
  });
  let lastHungry = -99;
  events.on('worker:hungry', () => {
    if (clock - lastHungry < 45) return;
    lastHungry = clock;
    toast({ text: 'Workers are hungry: ', strong: 'cook some meat', kind: 'warn', icon: 'bowl' });
  });

  // =====================================================================================================
  // desktop hint
  // =====================================================================================================
  const hintS = hint ? { t: 0, start: null, movedAt: -1, gone: false } : null;
  function updateHint(dt) {
    if (!hintS || hintS.gone) return;
    hintS.t += dt;
    const p = views.player?.getPosition?.() || { x: ctx.sim.player.x, z: ctx.sim.player.z };
    if (!hintS.start && hintS.t > 0.05) hintS.start = { x: p.x, z: p.z };
    if (hintS.start && hintS.movedAt < 0 && (Math.hypot(p.x - hintS.start.x, p.z - hintS.start.z) > 0.35 || (views.player?.moving && !views.player?.pathing))) hintS.movedAt = hintS.t;
    const kIn = easeOut(clamp01((hintS.t - 0.7) / 0.32));
    const kOut = hintS.movedAt >= 0 ? easeOut(clamp01((hintS.t - hintS.movedAt - 0.9) / 0.4)) : 0;
    op(hint, kIn * (1 - kOut));
    tf(hint, reduced() ? 'translateX(-50%)' : `translate3d(-50%, ${((1 - kIn) * 10 + kOut * 8).toFixed(2)}px, 0) scale(${(0.92 + 0.08 * kIn).toFixed(4)})`);
    if (kOut >= 1) { hintS.gone = true; hint.remove(); }
  }

  return {
    update(dt) {
      clock += dt;
      updateLevel(dt);
      updateTip(dt);
      updateStack(dt);
      updateBanner(dt);
      updateHint(dt);
    },
    resize() { measure(); sx = sy = -1; },
    hudBottom: () => hudBottom,
    // test hooks
    showBanner(level = camp.level, unlocks = []) {
      bState = { t: 0, level, unlocks: [...unlocks], collecting: true, complete: level >= MAX_LEVEL, chips: [] };
      hud.campToasts?.block?.(true);
    },
    openTip, closeTip,
    get bannerT() { return bState ? bState.t : -1; },
    get stackScreen() { return { x: sx, y: sy, visible: vis > 0 }; },
    el: cluster,
  };
}

function svgEl(tag, attrs, ...kids) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
  for (const c of kids) el.append(c);
  return el;
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
