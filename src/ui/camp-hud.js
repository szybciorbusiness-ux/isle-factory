// Camp HUD (GAMEPLAY.md "ui", UI-STYLE.md "sticker" language). The world is the UI, so this stays small:
//  - top-left: the camp level badge, a round orange sticker with the flame inside a thick progress ring (the
//    current hearth pad's payment), and a cream tag "Camp 2" ("Light the fire" while the hearth is cold,
//    "Camp complete" once the last level is reached and its card was seen). Tap it for what the next level unlocks.
//  - beside Dug's head: the carried-stack sticker, just the count ("7") with the top item's icon breaking out of
//    its outer edge; "/20" slides in as the pack nears full; at capacity it turns into a red "Full" bubble that
//    wobbles (the old face scales out, then the new one springs in). It docks on the side away from the guide's
//    goal, hides while Dug stands on a pad (the pad's number is the hero there) and fades to ~35% while it would
//    cover a pad plate or its label, a station's intake / drop zone or a worker.
//  - the level-up ribbon (camp-ribbon.js), the "camp complete" card (camp-complete.js), toasts for camp news
//    (camp-toasts.js), a desktop walk hint that fades after the first steps.
//  - phones: --hud-bottom = safe-bottom + 12 px (the bottom of the screen stays free for the joystick).
// Every transform / opacity is written from update(dt) (pausing and __game.step freeze it): ease-out
// cubic-bezier(.23, 1, .32, 1) for enters / exits, springs for bumps and sticker pops, damped values for rings.
import * as THREE from 'three';
import { h, setText, setClass, setVar, easeOut, reduceMotion, ol, setOl, clamp01, easeIn, tf, op } from './dom.js';
import { glyph, ROLE_HAT } from './camp-glyphs.js';
import { UPGRADES, WORKERS, MAX_LEVEL } from '../sim/camp-data.js';
import { ISLAND_NAMES, unlockLabel, unlocksForLevel } from './camp-labels.js';
import { createRibbon } from './camp-ribbon.js';
import { createCompleteCard } from './camp-complete.js';

export { unlockLabel, unlocksForLevel };

// level badge: the ring fills, the number flips, the ring empties for the next level (s)
const L_FILL = 0.36, L_FLIP = 0.34, L_RESET = 0.5;
// level ring extras (UI-STYLE "progress bars"): segment ticks and a shine that sweeps along the fill
const RING_SEGS_MAX = 10;   // costs up to this many items get one tick per item, bigger ones get 10 segments
const SHINE_EVERY = 2.6, SHINE_T = 0.8, SHINE_LEN = 14; // s between sweeps, s per sweep, sweep length (% of ring)
// stack sticker: where Dug's head is (world units above the feet) and how far out its tail tip sits
const HEAD_Y = 0.74;        // the helmet's middle
const HEAD_CLEAR = 0.5;     // tail tip from the head's centre line (world units): clear of the helmet and shovels
const STACK_CLEAR = 0.32;   // ...and clear of the carried stack (it rides on Dug's back, so it swings sideways)
const TAIL = 9;             // px from the tail tip to the sticker's edge
const SIDE_HOLD = 0.35;     // s the goal must stay on the sticker's side before it hops over
const SIDE_OUT = 0.1;       // s, the sticker scales out before it reappears on the other side
const FACE_OUT = 0.12;      // s, the old face ("7" / "Full") scales out before the new one springs in
const FADED = 0.35;         // opacity while it would cover a pad, an intake or a worker
const FADED_FULL = 0.55;    // ...a red "Full" stays a little stronger (it is the one warning the stack gives)
const COVER_MIN = 0.14;     // ...meaning: at least this share of the sticker sits on one
const AVOID_EVERY = 0.1;    // s between overlap checks
const PLATE_TAG = 0.1;      // world units of margin round a pad's plate (pads.plateRect already holds its name tag)
const CAP_SHOW = 2.2;       // s "/cap" stays after the pack grew
const ROLL = 0.17;          // s, one odometer roll
const FLOAT_LIFE = 0.95;    // s, a "+N" floater
const FLOAT_MERGE = 0.35;   // s, gains this close together grow one floater
const TIP_LIFE = 4;         // s, the "next level" card closes itself
const nearFull = cap => cap - Math.max(2, Math.round(cap * 0.2)); // "/cap" shows from here (8/10, 16/20, 24/30)

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
  const ringFill = svgEl('circle', { class: 'lvl-fill', fill: 'none', cx: 32, cy: 32, r: 26.5, pathLength: 100 });
  const ringFillHi = svgEl('circle', { class: 'lvl-fill-hi', fill: 'none', cx: 32, cy: 32, r: 27.9, pathLength: 100 });
  const ringTicks = svgEl('circle', { class: 'lvl-ticks', fill: 'none', cx: 32, cy: 32, r: 26.5, pathLength: 100 });
  const ringShine = svgEl('circle', { class: 'lvl-shine', fill: 'none', cx: 32, cy: 32, r: 26.5, pathLength: 100 });
  const ringSvg = svgEl('svg', { class: 'lvl-ring', viewBox: '0 0 64 64', 'aria-hidden': 'true' },
    svgEl('circle', { class: 'lvl-ring-ol', fill: 'none', cx: 32, cy: 32, r: 26.5 }),
    svgEl('circle', { class: 'lvl-ring-well', fill: 'none', cx: 32, cy: 32, r: 26.5 }),
    ringFill, ringFillHi, ringShine, ringTicks);
  const disc = h('span', { class: 'lvl-disc', html: glyph('flameLight') });
  const badge = h('span', { class: 'lvl-badge' }, ringSvg, disc);
  const numA = h('b', { class: 'lvl-num' }, '1');
  const numB = h('b', { class: 'lvl-num' }, '');
  const lvlMain = h('span', { class: 'lvl-main' }, h('span', { class: 'lvl-word' }, 'Camp'), h('span', { class: 'lvl-nums' }, numA, numB));
  const lvlCold = h('span', { class: 'lvl-cold' }, 'Light the fire');
  const lvlDone = h('span', { class: 'lvl-done' }, h('span', { class: 'lvl-done-star', html: glyph('star') }), 'Camp complete');
  const lvlText = h('span', { class: 'lvl-text' }, lvlMain, lvlCold, lvlDone);
  const tag = h('span', { class: 'lvl-tag' }, lvlText);
  const lvlBtn = h('button', { class: 'lvl hit', type: 'button', tabindex: -1 }, badge, tag);
  const tipTitle = h('div', { class: 'lvl-tip-title' });
  const tipList = h('div', { class: 'lvl-tip-list' });
  const tip = h('div', { class: 'lvl-tip', 'aria-hidden': 'true' }, tipTitle, tipList);
  const cluster = h('div', { class: 'camp-tl' }, lvlBtn, tip);
  layer.append(cluster);

  // ---- stack sticker (world-anchored beside Dug's head) ----
  const stkImg = h('span', { class: 'cs-icon', html: glyph('stack') });
  const nA = h('b', { class: 'cs-n' }, '0'), nB = h('b', { class: 'cs-n' }, '');
  const rollEl = h('span', { class: 'cs-roll' }, nA, nB);
  const capEl = h('span', { class: 'cs-cap' }, String(camp.capacity));
  const capIn = h('span', { class: 'cs-cap-in' }, h('span', { class: 'cs-sep' }, '/'), capEl);
  const capWrap = h('span', { class: 'cs-capw' }, capIn);
  const countEl = h('span', { class: 'cs-count' }, rollEl, capWrap);
  const fullEl = ol('Full', 'cs-full');
  const vals = h('span', { class: 'cs-vals' }, countEl, fullEl);
  // the tail sits on the edge facing Dug: the right edge while docked left of him, the left edge docked right
  const tailEl = h('span', { class: 'cs-tail' });
  const bub = h('div', { class: 'cs-bub' }, h('span', { class: 'cs-pulse' }), h('span', { class: 'cs-body' }), tailEl, stkImg, vals);
  const stackAnchor = h('div', { class: 'cs', role: 'status' }, bub);
  stackAnchor.style.visibility = 'hidden';
  layer.append(stackAnchor);

  // ---- desktop walk hint ----
  let hint = null;
  if (!mobile) {
    const keys = ks => h('span', { class: 'ch-keys' }, ks.map(k => h('kbd', { class: 'ch-key' }, k)));
    hint = h('div', { class: 'camp-hint' },
      keys(['W', 'A', 'S', 'D']), h('span', { class: 'ch-or' }, 'or arrow keys'), h('span', null, 'to walk'),
      h('i', { class: 'ch-dot' }), h('span', { class: 'ch-soft' }, 'Dug gathers on his own'));
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
  let doneFx = null;        // { t, w0, w1 }: "Camp 5" -> "Camp complete"
  let done = camp.level >= MAX_LEVEL; // a saved, finished camp opens in its complete state
  let lastAria = '';
  let textW = { main: 0, cold: 0, done: 0 };
  let ringSegs = -1, shineT = -1, shineWait = 1.2;

  const hearthPad = () => camp.pads.find(p => p.id.startsWith('hearth:')) || null;
  function padFrac(pad) {
    let tot = 0, paid = 0;
    for (const [k, n] of Object.entries(pad.cost)) { tot += n; paid += Math.min(n, pad.paid?.[k] || 0); }
    return { tot, paid, p: tot ? paid / tot : 0 };
  }
  events.on('pad:paid', ({ pad } = {}) => {
    if (pad?.id) lastPaid = { id: pad.id, t: clock };
    if (!pad?.id?.startsWith('hearth:') || reduced()) return;
    badgeS.velocity = Math.min(badgeS.velocity + 0.9, 2.2);
    if (shineT < 0 || shineT > SHINE_T * 0.7) shineWait = Math.min(shineWait, 0.18); // a sweep follows the payment
  });
  events.on('pad:complete', ({ pad } = {}) => {
    if (!pad?.id?.startsWith('hearth:')) return;
    lvlFx = { t: 0, from: shownLevel, to: Number(pad.id.split(':')[1]) || shownLevel + 1, flipped: false, reset: false };
    closeTip();
  });

  const measureText = () => { textW = { main: lvlMain.offsetWidth, cold: lvlCold.offsetWidth, done: lvlDone.offsetWidth }; };
  function showLayer(el, on) { el.__tf = el.__op = undefined; el.style.transform = ''; el.style.opacity = on ? '' : '0'; el.style.visibility = on ? '' : 'hidden'; }
  const modeOf = level => (level <= 0 ? 'cold' : level >= MAX_LEVEL && done ? 'done' : 'main');
  function setLevelNow(level) {
    shownLevel = level;
    setText(numA, String(Math.max(1, level)));
    numA.__tf = numA.__op = numB.__tf = numB.__op = undefined;
    numA.style.transform = ''; numA.style.opacity = '';
    numB.style.opacity = '0'; numB.style.transform = '';
    const mode = modeOf(level);
    showLayer(lvlMain, mode === 'main');
    showLayer(lvlCold, mode === 'cold');
    showLayer(lvlDone, mode === 'done');
    cold = level <= 0 ? 1 : 0;
    measureText();
    lvlText.__w = `${textW[mode]}px`;
    lvlText.style.width = lvlText.__w;
    setClass(lvlBtn, 'is-max', level >= MAX_LEVEL);
    setClass(lvlBtn, 'is-cold', level <= 0);
    setClass(lvlBtn, 'is-done', mode === 'done');
  }
  setLevelNow(camp.level);
  // the tag wears "Camp complete" (the card flew into the badge): slide the words like the level number flips
  function markDone() {
    if (done) return;
    done = true;
    measureText();
    doneFx = { t: 0, w0: textW.main, w1: textW.done };
    lvlDone.style.visibility = ''; op(lvlDone, 0);
    setClass(lvlBtn, 'is-done', true);
    if (!reduced()) badgeS.velocity += 5;
    glow = 1;
  }

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
        const w0 = lighting ? textW.cold : textW.main;
        if (lighting) { setText(numA, String(f.to)); lvlMain.style.visibility = ''; }
        else setText(numB, String(f.to));
        measureText(); // digits are proportional: the tag eases to the new number's width (both sit in the grid)
        f.w0 = w0; f.w1 = textW.main;
        if (!reduced()) badgeS.velocity += 4.4;
      }
      if (f.flipped) {
        const k = easeOut(clamp01((f.t - L_FILL) / L_FLIP));
        const [outEl, inEl] = lighting ? [lvlCold, lvlMain] : [numA, numB];
        op(outEl, 1 - k); op(inEl, k);
        if (!reduced()) { tf(outEl, `translateY(${(-k * 100).toFixed(1)}%)`); tf(inEl, `translateY(${((1 - k) * 100).toFixed(1)}%)`); }
        if (lighting) cold = 1 - k;
        const kw = easeOut(clamp01((f.t - L_FILL) / (L_FLIP + 0.1)));
        const wpx = `${(f.w0 + (f.w1 - f.w0) * kw).toFixed(1)}px`;
        if (lvlText.__w !== wpx) { lvlText.__w = wpx; lvlText.style.width = wpx; }
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
    } else if (doneFx) {
      const f = doneFx;
      f.t += dt;
      const k = easeOut(clamp01(f.t / (L_FLIP + 0.08)));
      op(lvlMain, 1 - k); op(lvlDone, k);
      if (!reduced()) { tf(lvlMain, `translateY(${(-k * 100).toFixed(1)}%)`); tf(lvlDone, `translateY(${((1 - k) * 100).toFixed(1)}%)`); }
      const wpx = `${(f.w0 + (f.w1 - f.w0) * k).toFixed(1)}px`;
      if (lvlText.__w !== wpx) { lvlText.__w = wpx; lvlText.style.width = wpx; }
      glow = damp(glow, 0, 4, dt);
      if (k >= 1) { doneFx = null; setLevelNow(camp.level); }
    } else {
      glow = damp(glow, 0, 10, dt);
      if (camp.level !== shownLevel) { if (camp.level >= MAX_LEVEL && camp.complete && !card.shown && !ribbon.active) done = true; setLevelNow(camp.level); } // changed behind the bus (tests, restore)
    }
    // the ring glides toward the paid fraction, a touch behind the paying stream
    ring = damp(ring, target, lvlFx ? 14 : 7, dt);
    if (Math.abs(ring - target) < 0.0005) ring = target;
    const off = (100 * (1 - ring)).toFixed(2);
    if (ringFill.__off !== off) { ringFill.__off = off; ringFill.style.strokeDashoffset = off; ringFillHi.style.strokeDashoffset = off; }
    const fillA = ring < 0.004 ? 0 : ringAlpha;
    op(ringFill, fillA); op(ringFillHi, fillA * 0.9);
    // segment ticks: one per item for small costs (the logs that light the fire), else tenths
    const segs = frac && camp.level < MAX_LEVEL ? (frac.tot <= RING_SEGS_MAX ? frac.tot : 10) : 0;
    if (segs !== ringSegs) {
      ringSegs = segs;
      if (segs > 1) {
        const tw = 1.25, gap = 100 / segs - tw;
        ringTicks.style.strokeDasharray = `${tw} ${gap.toFixed(3)}`;
        ringTicks.style.strokeDashoffset = (tw / 2).toFixed(3);
      }
    }
    op(ringTicks, segs > 1 ? (lvlFx ? ringAlpha : 1) : 0);
    // the shine: a bright band runs from the start of the fill to its end every few seconds (and right after
    // a payment lands); it never leaves the filled part
    shineWait -= dt;
    if (shineT < 0 && shineWait <= 0 && ring > 0.04 && !reduced()) { shineT = 0; shineWait = SHINE_EVERY; }
    if (shineT >= 0) {
      shineT += dt;
      const k = shineT / SHINE_T;
      const end = ring * 100;
      const head = easeOut(Math.min(1, k)) * (end + SHINE_LEN);
      const a = Math.max(0, head - SHINE_LEN), b = Math.min(end, head);
      if (k >= 1 || b - a < 0.2) { if (k >= 1) shineT = -1; op(ringShine, 0); }
      else {
        ringShine.style.strokeDasharray = `${(b - a).toFixed(2)} 200`;
        ringShine.style.strokeDashoffset = (-a).toFixed(2);
        op(ringShine, ringAlpha * Math.min(1, (1 - k) * 3));
      }
    }
    const s = badgeS.update(dt);
    tf(badge, Math.abs(s - 1) > 0.001 ? `scale(${s.toFixed(4)})` : '');
    setVar(badge, '--glow', glow.toFixed(3));
    setVar(badge, '--cold', cold.toFixed(3));
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
  lvlBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (!reduced()) badgeS.velocity -= 2;
    if (done && !doneFx && camp.level >= MAX_LEVEL) { closeTip(); if (!card.shown) card.open(); return; } // the finished camp: its card again
    if (tipS.open) closeTip(); else openTip();
  });
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
  // stack sticker beside Dug's head
  // =====================================================================================================
  const carry = camp.CARRY_ITEMS || ['wood', 'stone', 'meat', 'cookedMeat', 'plank', 'copperOre', 'copperBar'];
  const iconS = new Spring(1, { stiffness: 360, damping: 14 });
  const popS = new Spring(0.7, { stiffness: 420, damping: 22 }); // sticker appear / gain bumps / side hops
  const faceS = new Spring(1, { stiffness: 520, damping: 19 });  // the new face springing in after a swap
  const wob = new Wobble({ freq: 3.2, decay: 2.6 });              // the gentle "Full" wobble
  const shake = new Wobble({ freq: 8, decay: 8 });                // a refusal shake on camp:stackFull
  let shownN = -1, shownCap = -1, topItem;
  let pulseT = 0;
  let fullK = 0, fullHold = 0, capFlash = 0, lastFullPing = -9, fullSince = 0;
  let vis = 0, visT = 0, outT = -1;   // vis: 0 hidden / 1 shown; outT >= 0 while leaving
  let roll = null;                    // { k, dir }
  // what the sticker says: 'count' or 'full'. A change is sequential: the old face scales out (faceOut 0 -> 1),
  // then the new one springs in (faceS) while the body turns red / cream.
  let face = 'count', faceOut = 0, faceIn = 1;
  let capK = 0, capShowT = 0;         // "/cap" shown 0..1 (near full, or just after the pack grew)
  const wd = { num: 16, cap: 30, full: 48, chrome: 40, h: 34, over: 10 }; // measured sizes (px, unscaled)
  let valsW = -1;
  // placement: docked left (-1) or right (+1) of Dug's head, away from the guide's goal
  let side = -1, sideWant = -1, sideHold = 0, sideOut = -1; // sideOut >= 0 while hopping to the other side
  let stackDx = null;                 // the carried stack's screen offset from the head (px, smoothed)
  let pushY = 0;                      // pushed down below the guide's hint card (px)
  let avoidK = 1, avoidHit = false, avoidT = 0;
  const avoidRects = [], cover = [0, 0]; // share of the box covered docked left / right
  let padK = 0, onPadT = 0, lastPaid = { id: null, t: -9 };
  let sx = -1, sy = -1, sS = 1, boxR = null, badgeBottom = -1;
  let lastAriaN = -1, lastAriaCap = -1;
  const floats = [];                  // { el, txt, t, n }
  const v3 = new THREE.Vector3(), vHead = new THREE.Vector3(), vSide = new THREE.Vector3(), vPack = new THREE.Vector3(), vTmp = new THREE.Vector3();

  function measureSticker() {
    wd.num = rollEl.offsetWidth || wd.num;
    wd.cap = capIn.offsetWidth || wd.cap;
    wd.full = fullEl.offsetWidth || wd.full;
    const cs = getComputedStyle(bub);
    wd.chrome = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    wd.h = bub.offsetHeight || wd.h;
    wd.over = Math.max(0, -stkImg.offsetLeft) || wd.over; // the icon breaks out of the outer edge by this much
  }
  measureSticker();
  document.fonts?.ready?.then(() => { measureSticker(); if (!lvlFx && !doneFx) setLevelNow(shownLevel); }, () => {});

  events.on('camp:stackFull', () => {
    if (clock - lastFullPing < 0.7) return; // the sim can fire this every swing
    lastFullPing = clock;
    fullHold = 1.6;                          // show "Full" even while the last items are still flying in
    if (!reduced()) { shake.hit(3.5); popS.velocity += 1.6; }
  });
  events.on('capacity:changed', () => { capFlash = 1; capShowT = CAP_SHOW; if (!reduced()) popS.velocity += 2.6; });

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

  // The guide's first-time hint bubble (view/guide/hints.js, .guide-layer .gh) sits above Dug: the sticker keeps
  // below it. Its rect, or null when it is hidden or already fading out.
  let ghEl = null, ghOp = 0;
  let ghRect = null; // this frame's hint card rect (readGuideHint, once per frame)
  function readGuideHint() {
    const gl = views.guide?.el;
    if (!gl) return null;
    if (!ghEl || !ghEl.isConnected) ghEl = gl.querySelector('.gh');
    const o = ghEl && ghEl.style.visibility === 'visible' ? Number(ghEl.style.opacity) || 0 : 0;
    const leaving = o < ghOp - 0.001 && o < 0.9; // fading out: the sticker heads home already, in step with it
    ghOp = o;
    if (o <= 0.05 || leaving) return null;
    // .gh is a 0x0 anchor; its first child is the visible card + tail
    const r = (ghEl.firstElementChild || ghEl).getBoundingClientRect();
    return r.height > 0 ? r : null;
  }

  // Screen points for this frame: Dug's head (from the smoothed feet, so no walk bob), the carried stack's base
  // (the pack) and the px per world unit there.
  const scr = { hx: 0, hy: 0, px: 0, ppu: 40 };
  const toScr = (v, W, H) => { v.project(ctx.camera); return [(v.x * 0.5 + 0.5) * W, (-v.y * 0.5 + 0.5) * H]; };
  function projectHead(W, H) {
    const pl = views.player;
    const feet = pl?.getPosition?.(vHead) || vHead.set(ctx.sim.player.x, 0, ctx.sim.player.z);
    const fx = feet.x, fz = feet.z, fy = feet.y || 0;
    vHead.set(fx, fy + HEAD_Y, fz);
    vSide.set(fx + 1, fy + HEAD_Y, fz);
    if (!pl?.getPackPosition?.(vPack)) vPack.set(fx, fy + HEAD_Y, fz);
    vPack.y = fy + HEAD_Y;
    [scr.hx, scr.hy] = toScr(vHead, W, H);
    const [sxp] = toScr(vSide, W, H);
    [scr.px] = toScr(vPack, W, H);
    scr.ppu = Math.max(8, Math.abs(sxp - scr.hx));
    scr.fx = fx; scr.fz = fz;
    return scr;
  }
  function goalScreenX(W, H) {
    const g = camp.goal || views.guide?.goal;
    if (!g || !Number.isFinite(g.x) || !Number.isFinite(g.z)) return null;
    return toScr(vTmp.set(g.x, 0, g.z), W, H)[0];
  }

  // Things the sticker must not hide (screen rects, refreshed every AVOID_EVERY s): pad plates with their name
  // tags, station intakes and drop zones, workers. The zone / pad Dug stands in is left out (he's using it).
  function pushBox(W, H, x0, z0, x1, z1, y0, y1) {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (let i = 0; i < 8; i++) {
      const [x, y] = toScr(vTmp.set(i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0), W, H);
      if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > b) b = y;
    }
    if (r > 0 && b > 0 && l < W && t < H) avoidRects.push({ l, t, r, b });
  }
  function collectAvoid(W, H) {
    avoidRects.length = 0;
    const px = scr.fx, pz = scr.fz;
    const inR = (zone, m = 0) => camp.inRect?.(zone, px, pz, m);
    for (const pad of camp.pads) {
      if (inR(pad.zone)) continue;
      const r = views.pads?.plateRect?.(pad.id);
      if (r) pushBox(W, H, r.x - r.hx, r.z - r.hz - PLATE_TAG, r.x + r.hx, r.z + r.hz + PLATE_TAG, 0, 0.05);
      else { const [x, z, w, d] = pad.zone; pushBox(W, H, x - 0.5, z - 0.5 - PLATE_TAG, x + w - 0.5, z + d - 0.5 + PLATE_TAG, 0, 0.05); }
    }
    for (const s of camp.stations.values()) {
      const zone = s.def?.zone;
      if (zone && !inR(zone)) { const [x, z, w, d] = zone; pushBox(W, H, x - 0.5, z - 0.5, x + w - 0.5, z + d - 0.5, 0, 0.05); }
      if (zone || s.def?.accepts) {
        const p = views.campview?.intakePoint?.(s.id, v3);
        if (p && Number.isFinite(p.x)) pushBox(W, H, p.x - 0.4, p.z - 0.4, p.x + 0.4, p.z + 0.4, Math.max(0, p.y - 0.25), p.y + 0.45);
      }
    }
    for (const w of camp.workers.values()) {
      let top = 1.25;
      const st = views.creatures?.workerStackTop?.(w.id, v3);
      if (st && Number.isFinite(st.y)) top = Math.max(top, st.y + 0.15);
      pushBox(W, H, w.x - 0.36, w.z - 0.3, w.x + 0.36, w.z + 0.3, 0, top);
    }
  }
  // share of the sticker's box that covers something (overlaps are summed, so two things count twice)
  function covered(a, list) {
    if (!a) return 0;
    const area = Math.max(1, (a.r - a.l) * (a.b - a.t));
    let s = 0;
    for (const r of list) s += Math.max(0, Math.min(a.r, r.r) - Math.max(a.l, r.l)) * Math.max(0, Math.min(a.b, r.b) - Math.max(a.t, r.t));
    return s / area;
  }

  function updateStack(dt) {
    const n = shownTotal();
    const cap = camp.capacity;
    const red = reduced();
    let measureNow = false;
    if (n !== shownN) {
      const prev = shownN;
      shownN = n;
      if (prev >= 0 && vis > 0 && !red) {
        roll = { k: roll ? Math.min(roll.k, 0.35) : 0, dir: n > prev ? 1 : -1 };
        setText(nA, String(prev)); setText(nB, String(n));
      } else { setText(nA, String(n)); setText(nB, ''); roll = null; tf(nA, ''); op(nA, 1); op(nB, 0); }
      if (prev >= 0 && n > prev && !red) { iconS.velocity += 3.2; popS.velocity += 0.9; floater(n - prev); }
      if (n > 0) setTopIcon(camp.stack[camp.stack.length - 1]);
      measureNow = true;
    }
    if (cap !== shownCap) { shownCap = cap; setText(capEl, String(cap)); measureNow = true; }
    // odometer roll
    if (roll) {
      roll.k = Math.min(1, roll.k + dt / ROLL);
      const k = easeOut(roll.k);
      tf(nA, `translateY(${(-roll.dir * k * 100).toFixed(1)}%)`); op(nA, 1 - k);
      tf(nB, `translateY(${(roll.dir * (1 - k) * 100).toFixed(1)}%)`); op(nB, k);
      if (roll.k >= 1) { roll = null; setText(nA, String(shownN)); setText(nB, ''); tf(nA, ''); op(nA, 1); op(nB, 0); measureNow = true; }
    }
    if (measureNow) { wd.num = rollEl.offsetWidth || wd.num; wd.cap = capIn.offsetWidth || wd.cap; }

    // ---- full: the face swaps in sequence (old scales out, then the new springs in), the body turns red ----
    const full = n >= cap || (fullHold > 0 && camp.free() <= 0);
    fullHold = Math.max(0, fullHold - dt);
    const want = full ? 'full' : 'count';
    if (want !== face) {
      // the count lands first ("10/10" rolls in), then the old face scales out ("Full" leaves at once: the stack
      // is draining and its count keeps rolling)
      if (!roll || face === 'full') faceOut = red ? 1 : Math.min(1, faceOut + dt / FACE_OUT);
      if (faceOut >= 1) {
        face = want; faceOut = 0; faceIn = 0;
        faceS.value = red ? 1 : 0.55; faceS.velocity = 0; faceS.target = 1;
        setClass(bub, 'is-full', full);
        if (full && !red) { wob.hit(1); popS.velocity += 2.2; }
      }
    } else faceOut = Math.max(0, faceOut - dt / FACE_OUT);
    faceIn = Math.min(1, faceIn + dt / 0.09);
    fullK = damp(fullK, face === 'full' ? 1 : 0, 22, dt);
    fullSince = face === 'full' ? fullSince + dt : 0;
    if (face === 'full' && fullSince > 2.4 && !red) { fullSince = 0; wob.hit(0.8); }
    const fs = (red ? 1 : faceS.update(dt)) * (1 - 0.45 * easeIn(faceOut));
    const fa = faceIn * (1 - easeIn(faceOut));
    const [onEl, offEl] = face === 'full' ? [fullEl, countEl] : [countEl, fullEl];
    op(onEl, fa); op(offEl, 0);
    tf(onEl, `translate(-50%, -50%) scale(${fs.toFixed(4)})`);
    // a soft red pulse ring breathes out of the outline every 1.3 s while full
    pulseT = face === 'full' ? pulseT + dt : 0;
    setVar(bub, '--pk', (face === 'full' && !red ? easeOut((pulseT % 1.3) / 1.3) : 0).toFixed(3));
    setVar(bub, '--full', fullK.toFixed(3));
    capFlash = Math.max(0, capFlash - dt / 1.1);
    setVar(bub, '--flash', capFlash.toFixed(3));
    // "/cap" slides in as the pack nears full (and for a moment after it grew)
    capShowT = Math.max(0, capShowT - dt);
    capK = damp(capK, face === 'count' && (n >= nearFull(cap) || capShowT > 0) ? 1 : 0, 14, dt);
    if (capK < 0.002) capK = 0; else if (capK > 0.998) capK = 1;
    const cw = `${(wd.cap * capK).toFixed(2)}px`;
    if (capWrap.__w !== cw) { capWrap.__w = cw; capWrap.style.width = cw; }
    op(capWrap, capK);
    // the sticker's width eases to the face it shows
    const wantW = face === 'full' ? wd.full : wd.num + wd.cap * capK;
    valsW = valsW < 0 ? wantW : damp(valsW, wantW, 20, dt);
    const vw = `${valsW.toFixed(2)}px`;
    if (vals.__w !== vw) { vals.__w = vw; vals.style.width = vw; }

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
    if (vis <= 0) { boxR = null; return; }

    // ---- placement: beside the head, on the side away from the goal ----
    const W = innerWidth, H = innerHeight;
    ctx.camera.updateMatrixWorld();
    const P = projectHead(W, H);
    const S = hud.scale || 1;
    const bw = wd.chrome + valsW, bh = wd.h;
    stackDx = stackDx == null || visT <= dt ? P.px - P.hx : damp(stackDx, P.px - P.hx, 12, dt);
    const tipFor = sd => (sd < 0
      ? Math.min(P.hx - P.ppu * HEAD_CLEAR, P.hx + stackDx - P.ppu * STACK_CLEAR)
      : Math.max(P.hx + P.ppu * HEAD_CLEAR, P.hx + stackDx + P.ppu * STACK_CLEAR));
    const room = sd => (sd < 0 ? tipFor(-1) - S * (bw + TAIL) : W - tipFor(1) - S * (bw + TAIL)) - 8;
    // the box the sticker covers docked on side sd, its icon's overhang on the outer edge included
    const boxFor = sd => {
      const tx = tipFor(sd), l = sd < 0 ? tx - S * (bw + TAIL) : tx + S * TAIL, ov = S * wd.over;
      return { l: l - (sd < 0 ? ov : 0), r: l + S * bw + (sd > 0 ? ov : 0), t: P.hy - (S * bh) / 2 - ov * 0.5, b: P.hy + (S * bh) / 2 };
    };
    if ((avoidT -= dt) <= 0) {
      avoidT = AVOID_EVERY;
      collectAvoid(W, H);
      cover[0] = covered(boxFor(-1), avoidRects); cover[1] = covered(boxFor(1), avoidRects);
    }
    const gx = goalScreenX(W, H);
    let wantSide = sideWant;
    if (gx != null && Math.abs(gx - P.hx) > 24) wantSide = gx > P.hx ? -1 : 1;
    // the goal is straight up or down the screen: take the side that hides less
    else if (cover[wantSide > 0 ? 1 : 0] > COVER_MIN && cover[wantSide > 0 ? 0 : 1] < COVER_MIN * 0.5) wantSide = -wantSide;
    if (room(wantSide) < 0 && room(-wantSide) >= 0) wantSide = -wantSide; // no room there: the other side
    sideWant = wantSide;
    if (sideOut < 0) {
      sideHold = wantSide !== side ? sideHold + dt : 0;
      const forced = room(side) < 0 && room(-side) >= 0;
      if (sideHold > SIDE_HOLD || (forced && sideHold > 0)) { sideOut = 0; sideHold = 0; }
      if (visT <= dt) { side = wantSide; sideHold = 0; } // first frame shown: start on the right side
    }
    if (sideOut >= 0) {
      sideOut += dt;
      if (sideOut >= SIDE_OUT || red) {
        side = sideWant; sideOut = -1;
        popS.value = red ? 1 : 0.6; popS.velocity = 0;
      }
    }
    setClass(bub, 'is-r', side > 0);
    const tipX = tipFor(side), tipY = P.hy;
    // the sticker box relative to the tail tip, in its own (unscaled) px: beside it, vertically centred
    const bx = side < 0 ? -bw - TAIL : TAIL, by = -bh / 2;
    // keep clear of the guide's hint card (above or below Dug): slide up or down, whichever is shorter
    let wantPush = 0;
    if (ghRect) {
      const l = tipX + S * bx, r = l + S * bw, top = tipY + S * by, bot = top + S * bh;
      if (ghRect.left < r + 6 && ghRect.right > l - 6 && ghRect.bottom + 4 > top && ghRect.top - 4 < bot) {
        const down = ghRect.bottom + 4 - top, up = bot - (ghRect.top - 4);
        wantPush = (ghRect.top + ghRect.bottom) / 2 < (top + bot) / 2 ? down : -up;
        if (Math.abs(wantPush) > 0.6 * (S * bh + ghRect.height)) wantPush = 0; // can't step out of it: stay put
      }
    }
    pushY = damp(pushY, wantPush, 12, dt);
    // keep the whole sticker on screen (below the level badge on phones)
    if (badgeBottom < 0) badgeBottom = cluster.getBoundingClientRect().bottom;
    const pad = 10, top = mobile ? badgeBottom + 6 : 8;
    const x = Math.min(W - pad - S * (bx + bw), Math.max(pad - S * bx, tipX));
    const y = Math.min(H - pad - S * (by + bh), Math.max(top - S * by, tipY + pushY));
    if (Math.abs(x - sx) > 0.05 || Math.abs(y - sy) > 0.05 || S !== sS) {
      sx = x; sy = y; sS = S;
      tf(stackAnchor, `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)${S !== 1 ? ` scale(${S.toFixed(3)})` : ''}`);
    }
    boxR = { l: x + S * bx, t: y + S * by, r: x + S * (bx + bw), b: y + S * (by + bh) };

    // ---- hide on a pad (its number is the hero); fade over plates, intakes and workers ----
    const onPad = camp.pads.find(p => camp.inRect?.(p.zone, P.fx, P.fz, padK > 0.5 ? 0.06 : 0));
    const still = (views.player?.speed ?? 0) < 0.6;
    onPadT = onPad && (still || (lastPaid.id === onPad.id && clock - lastPaid.t < 0.5)) ? onPadT + dt : 0;
    // ...and whenever the pads view has lifted a pad's countdown into its sticker (Dug stands on that pad)
    const hideOnPad = !!views.pads?.lifted || (!!onPad && (onPadT > 0.1 || (lastPaid.id === onPad.id && clock - lastPaid.t < 0.5)));
    padK = damp(padK, hideOnPad ? 1 : 0, 16, dt);
    avoidHit = cover[side > 0 ? 1 : 0] > COVER_MIN && sideOut < 0;
    avoidK = damp(avoidK, avoidHit ? (face === 'full' ? FADED_FULL : FADED) : 1, 10, dt);

    // sticker motion: spring scale, the Full wobble (a gentle rock), the refusal shake, the side hop
    popS.target = 1;
    let s = red ? 1 : popS.update(dt);
    let a = 1;
    if (outT >= 0) {
      const k = outT / 0.3;
      s = red ? 1 : k < 0.3 ? 1 + 0.08 * easeOut(k / 0.3) : 1.08 * (1 - easeIn((k - 0.3) / 0.7) * 0.4);
      a = 1 - easeIn(clamp01((k - 0.3) / 0.7));
    } else if (visT < 0.18) a = easeOut(visT / 0.18);
    if (sideOut >= 0) { const k = easeIn(clamp01(sideOut / SIDE_OUT)); s *= 1 - 0.4 * k; a *= 1 - k; }
    s *= 1 - 0.18 * padK;
    a *= (1 - padK) * avoidK;
    wob.update(dt); shake.update(dt);
    const rot = red ? 0 : wob.value * 5;
    const shk = red ? 0 : shake.value;
    // scale / rock about the tail tip
    const origin = `${(-bx).toFixed(1)}px ${(-by).toFixed(1)}px`;
    if (bub.__org !== origin) { bub.__org = origin; bub.style.transformOrigin = origin; }
    tf(bub, `translate3d(${(bx + shk).toFixed(2)}px, ${by.toFixed(2)}px, 0) rotate(${rot.toFixed(2)}deg) scale(${s.toFixed(4)})`);
    op(bub, a);
    const is = iconS.update(dt);
    tf(stkImg, Math.abs(is - 1) > 0.001 ? `scale(${is.toFixed(4)}) rotate(${((is - 1) * (side > 0 ? 30 : -30)).toFixed(2)}deg)` : '');

    // "+N" floaters rise from the count with a little arc and fade in the last third
    for (let i = floats.length - 1; i >= 0; i--) {
      const f = floats[i];
      f.t += dt;
      const k = f.t / FLOAT_LIFE;
      // they bow out once "Full" shows, on a pad, or when they would rise into the guide's hint card
      const intoHint = ghRect && boxR && ghRect.left < boxR.r && ghRect.right > boxR.l && ghRect.bottom > boxR.t - 44 && ghRect.top < boxR.t ? 1 : 0;
      const fade = clamp01(1 - Math.max(fullK, padK, intoHint) * 1.8) * avoidK;
      if (k >= 1 || fade <= 0) { f.el.remove(); floats.splice(i, 1); continue; }
      const ky = easeOut(k);
      const fx = bx + bw * (side < 0 ? 0.62 : 0.38) + (side < 0 ? 10 : -10) * Math.sin(k * Math.PI * 0.6);
      const fy = by - 4 - 30 * ky;
      const fsc = k < 0.15 ? 0.8 + 0.2 * easeOut(k / 0.15) : 1;
      tf(f.el, `translate3d(${fx.toFixed(2)}px, ${fy.toFixed(2)}px, 0) scale(${fsc.toFixed(3)})`);
      op(f.el, (k < 0.12 ? k / 0.12 : k > 0.66 ? 1 - (k - 0.66) / 0.34 : 1) * fade);
    }
    if (n !== lastAriaN || cap !== lastAriaCap) {
      lastAriaN = n; lastAriaCap = cap;
      stackAnchor.setAttribute('aria-label', n >= cap ? `Carrying ${n} of ${cap}, full` : `Carrying ${n} of ${cap}`);
    }
  }

  // =====================================================================================================
  // level-up ribbon, the "camp complete" card
  // =====================================================================================================
  const ribbon = createRibbon(hud, { cluster });
  let cardPending = false;
  const card = createCompleteCard(hud, { badgeEl: badge, onClosed: markDone });
  events.on('camp:complete', () => { cardPending = true; });
  function updateComplete(dt) {
    // the card follows the level-5 ribbon (it waits for it to fold away), then shrinks into the badge
    if (cardPending && (!ribbon.active || ribbon.t > ribbon.end - 0.5)) { cardPending = false; card.open(); }
    card.update(dt);
  }

  // =====================================================================================================
  // toasts for camp news
  // =====================================================================================================
  const toast = o => hud.campToasts?.show?.(o);
  events.on('upgrade', ({ id, upgrade } = {}) => {
    const u = upgrade || UPGRADES[id] || {};
    if (u.capacity) toast({ text: `${u.name || 'Bigger pack'}: `, strong: 'carry ', num: u.capacity, kind: 'good', icon: 'pack' });
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
    toast({ text: 'Workers are hungry: ', strong: 'cook meat', kind: 'warn', icon: 'bowl' });
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
      ghRect = readGuideHint();
      updateStack(dt);
      ribbon.update(dt);
      updateComplete(dt);
      updateHint(dt);
    },
    resize() { measure(); measureSticker(); ribbon.resize(); sx = sy = -1; badgeBottom = -1; },
    hudBottom: () => hudBottom,
    // test hooks
    showBanner(level = camp.level, unlocks = []) { ribbon.show(level, unlocks); },
    showComplete() { card.open(); },
    closeComplete() { card.close(); },
    openTip, closeTip,
    get bannerT() { return ribbon.t; },
    get stackScreen() { return { x: sx, y: sy, visible: vis > 0, side, faded: +avoidK.toFixed(3), hidden: +padK.toFixed(3), face, box: boxR }; },
    get completeOpen() { return card.isOpen; },
    _avoid: () => ({ rects: avoidRects.map(r => [r.l, r.t, r.r, r.b].map(Math.round)), cover: [...cover] }),
    // Screen rects the HUD covers right now (the badge, its "next level" card, toasts, the ribbon, the
    // completion card), so floating things such as the guide's off-screen chip can keep clear.
    rects() {
      const out = [];
      const add = el => { if (!el || el.style.visibility === 'hidden') return; const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) out.push(r); };
      add(lvlBtn);
      if (tipS.k > 0) add(tip);
      for (const row of hud.campToasts?.rows?.() || []) add(row.firstElementChild);
      out.push(...ribbon.rects());
      const cr = card.rect(); if (cr) out.push(cr);
      return out;
    },
    el: cluster,
  };
}

function svgEl(tag, attrs, ...kids) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
  for (const c of kids) el.append(c);
  return el;
}
