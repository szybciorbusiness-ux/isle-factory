// First-time hints: at most five in the whole game, each shown once, for ~3 s or until the thing is done,
// in a sticker bubble that hugs Dug on the side AWAY from the goal (guide/place.js): it never covers the pad,
// plate or target it talks about, the arrow, the stack counter or the HUD. The tail skews to point at Dug from
// whichever edge faces him. Projected every frame and smoothed, so the robot's bob never jitters it; a change of
// side (above <-> below) is a quick shrink-and-pop instead of a slide across Dug.
// Shown ids persist in localStorage (try/catch: private mode, blocked storage); ?fresh=1 clears them.
// The guide calls want(id, ctx) when a hint's moment arrives and done(id) when the player did it.
import { Spring, clamp, damp, ease } from '../../util/anim.js';
import { TAIL_SVG } from './css.js';
import { createIconSlot } from './icons.js';
import { chooseSpot, spotFor, TAIL } from './place.js';

const KEY = 'isle-factory.guide.hints.v1';
export const HINTS = {
  trees:   { text: 'Walk into trees', icon: 'wood' },
  pad:     { text: 'Stand on the pad to build', icon: 'pad' },
  drop:    { text: 'Drop wood here', icon: 'wood' },
  hunt:    { text: 'Bump into animals to hunt', icon: 'meat' },
  workers: { text: 'Workers need cooked meat', icon: 'cookedMeat' },
};
const MAX_T = 3.2;      // s on screen at most
const MIN_T = 1.4;      // s on screen at least (even if done at once), so it can be read
const DONE_HOLD = 0.35; // s after "done" before it leaves
const RECHOOSE = 0.15;  // s between spot choices
const SWAP_T = 0.26;    // s for a change of side (shrink, jump, pop back)

function loadSeen(reset) {
  try {
    if (reset) localStorage.removeItem(KEY);
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return new Set(Array.isArray(v) ? v : []);
  } catch { return new Set(); }
}
function saveSeen(seen) { try { localStorage.setItem(KEY, JSON.stringify([...seen])); } catch { /* storage blocked */ } }

export function createHints(layer, views, { reset = false, reduced = () => false, items = {} } = {}) {
  const seen = loadSeen(reset);
  const iconWrap = document.createElement('div'); iconWrap.className = 'gh-icon';
  const text = document.createElement('span'); text.className = 'gh-text';
  const card = document.createElement('div'); card.className = 'gh-card';
  card.append(iconWrap, text);
  const el = document.createElement('div'); el.className = 'gh'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
  el.append(card);
  el.insertAdjacentHTML('beforeend', TAIL_SVG);
  const tail = el.lastElementChild;
  layer.append(el);
  const setIcon = createIconSlot(views, items);

  const vis = new Spring(0, { stiffness: 340, damping: 18 });
  const pop = new Spring(0, { stiffness: 420, damping: 14 });
  const st = {
    cur: null, t: 0, doneAt: -1, queue: [], out: false, force: false,
    x: 0, y: 0, placed: false, lastCss: '', lastTail: '', lastOrigin: '', w: 0, h: 0,
    spot: null, chooseT: 0, swap: -1, swapTo: null,
  };
  // the card's own box; measured once per hint
  function measure() { st.w = card.offsetWidth; st.h = card.offsetHeight; st.icon = !card.classList.contains('no-icon'); }

  function start(id, opts = {}) {
    const def = HINTS[id];
    const label = opts.text || def.text;
    const icon = opts.icon !== undefined ? opts.icon : def.icon;
    text.textContent = label;
    card.classList.toggle('no-icon', !icon);
    setIcon(iconWrap, icon);
    st.cur = id; st.t = 0; st.doneAt = -1; st.out = false; st.force = false;
    st.spot = null; st.placed = false; st.chooseT = 0; st.swap = -1; st.swapTo = null;
    seen.add(id); saveSeen(seen);
    vis.set(0); vis.target = 1; pop.set(0); pop.velocity = 0;
    measure();
  }

  // Where the card goes this frame. place: { dug, goalDir, obstacles, bounds } (screen px) or null to hold.
  function locate(dt, place) {
    if (!place?.dug) return;
    const card = { w: st.w, h: st.h, icon: st.icon };
    st.chooseT -= dt;
    if (!st.spot || st.chooseT <= 0) {
      st.chooseT = RECHOOSE;
      const best = chooseSpot({ ...place, card, current: st.spot?.id });
      st.lastChoice = best ? { all: best.all, obstacles: place.obstacles.map(o => [o.w, Math.round(o.r.left), Math.round(o.r.top), Math.round(o.r.right), Math.round(o.r.bottom)]), dug: place.dug, goalDir: place.goalDir } : null;
      if (best && (!st.spot || best.id !== st.spot.id)) {
        // a change of side once it's showing: shrink away, jump, pop back (never slide across Dug)
        if (st.spot && st.placed && best.side !== st.spot.side && vis.value > 0.5 && !reduced()) { if (st.swap < 0) { st.swap = 0; st.swapTo = best; } }
        else st.spot = best;
        if (!st.spot) st.spot = best;
      }
    }
    if (st.swap >= 0) {
      st.swap += dt;
      if (st.swap >= SWAP_T * 0.5 && st.swapTo) { st.spot = st.swapTo; st.swapTo = null; st.placed = false; }
      if (st.swap >= SWAP_T) st.swap = -1;
    }
    // follow Dug 1:1 with the chosen spot (smoothed)
    const s = spotFor(st.spot.side, st.spot.sideK, place.dug, card, place.bounds);
    st.spot = { ...s, score: st.spot.score };
    if (!st.placed) { st.x = s.left; st.y = s.top; st.placed = true; }
    st.x = damp(st.x, s.left, 20, dt);
    st.y = damp(st.y, s.top, 16, dt);
  }

  return {
    el,
    seen: id => seen.has(id),
    get current() { return st.cur; },
    get count() { return seen.size; },
    // the card's screen box while it shows (for tests and neighbours), else null
    get rect() { return st.cur && st.placed ? { left: st.x, top: st.y, right: st.x + st.w, bottom: st.y + st.h, side: st.spot?.side } : null; },
    // ask for a hint; ignored if it was ever shown. Queued (max 2) while another is up.
    want(id, opts) {
      if (!HINTS[id] || seen.has(id) || st.cur === id || st.queue.some(q => q.id === id)) return false;
      if (st.cur) { if (st.queue.length < 2) st.queue.push({ id, opts }); return true; }
      start(id, opts);
      return true;
    },
    // the moment passed (the goal moved on): leave now, without waiting for the minimum read time
    // (barely seen and not done: it may come back at its next moment)
    dismiss(id) {
      if (st.cur === id && !st.force) {
        st.force = true;
        if (st.t < 0.8 && st.doneAt < 0) { seen.delete(id); saveSeen(seen); }
      }
      st.queue = st.queue.filter(q => q.id !== id);
    },
    // the player did it. { now: true } leaves at once (the hint would only be in the way now)
    done(id, { now = false } = {}) {
      if (st.cur === id) { if (st.doneAt < 0) st.doneAt = st.t; if (now) st.force = true; }
      st.queue = st.queue.filter(q => q.id !== id);
      if (!seen.has(id)) { seen.add(id); saveSeen(seen); } // done before it ever showed: no need for it
    },
    update(dt, place, { suppress = false } = {}) {
      if (!st.cur) {
        if (st.queue.length && !suppress) { const q = st.queue.shift(); if (!seen.has(q.id)) start(q.id, q.opts); }
        if (!st.cur) return;
      }
      st.t += dt;
      const leaving = st.t > MAX_T || st.force || (st.doneAt >= 0 && st.t > Math.max(MIN_T, st.doneAt + DONE_HOLD)) || suppress;
      if (leaving && !st.out) { st.out = true; vis.target = 0; pop.velocity += 2.2; }   // anticipation: a tiny grow
      vis.update(dt); pop.update(dt);
      const v = vis.value;
      if (st.out && v < 0.02) {
        st.cur = null; el.style.visibility = 'hidden'; el.style.opacity = '0'; st.placed = false; st.spot = null;
        return;
      }
      if (!st.w) measure();
      locate(dt, place);
      if (!st.spot) { el.style.visibility = 'hidden'; return; }
      const sp = st.spot;
      const red = reduced();
      // side swap: 0..1..0 dip
      const sk = st.swap >= 0 ? Math.sin(Math.PI * clamp(st.swap / SWAP_T)) : 0;
      const s = red ? 1 : (st.out ? 0.75 + 0.25 * v : 0.82 + 0.18 * v) * (1 + 0.06 * pop.value) * (1 - 0.35 * sk);
      // enter / leave toward Dug: it grows out of him and drifts a few px away from his side
      const dIn = red ? 0 : (1 - clamp(v)) * 10;
      const ex = sp.edge === 'right' ? dIn : 0, ey = sp.edge === 'top' ? -dIn : sp.edge === 'bottom' ? dIn : 0;
      const bob = red ? 0 : Math.sin(st.t * 2.4) * 1.6;
      const css = `translate3d(${(st.x + ex).toFixed(1)}px, ${(st.y + ey + bob).toFixed(1)}px, 0) scale(${s.toFixed(3)})`;
      // scale about the tail tip (it grows out of Dug)
      const shift = Math.tan(sp.ang) * TAIL;
      const ox = sp.edge === 'right' ? st.w - 4.5 + TAIL + 3 : sp.tx + shift;
      const oy = sp.edge === 'right' ? sp.tx + shift : sp.edge === 'top' ? -TAIL : st.h + TAIL;
      const origin = `${ox.toFixed(0)}px ${oy.toFixed(0)}px`;
      if (origin !== st.lastOrigin) { el.style.transformOrigin = origin; st.lastOrigin = origin; }
      if (css !== st.lastCss) { el.style.transform = css; st.lastCss = css; }
      // the tail: its base on the edge facing Dug, skewed so the tip points at him
      // (skewX moves the tip sideways by tan(a) * its depth; the other edges turn the bottom tail around)
      const tcss = sp.edge === 'top'
        ? `translate3d(${(sp.tx - 12).toFixed(1)}px, 3.5px, 0) rotate(180deg) skewX(${(-sp.ang).toFixed(3)}rad)`
        : sp.edge === 'right'
          ? `translate3d(${(st.w - 16.5).toFixed(1)}px, ${sp.tx.toFixed(1)}px, 0) rotate(-90deg) skewX(${(-sp.ang).toFixed(3)}rad)`
          : `translate3d(${(sp.tx - 12).toFixed(1)}px, ${(st.h - 3.5).toFixed(1)}px, 0) skewX(${sp.ang.toFixed(3)}rad)`;
      if (tcss !== st.lastTail) { tail.style.transform = tcss; st.lastTail = tcss; }
      el.style.opacity = (ease.quadOut(clamp(v * 1.4)) * (1 - 0.8 * sk)).toFixed(3);
      if (el.style.visibility !== 'visible') el.style.visibility = 'visible';
    },
    reset() { seen.clear(); saveSeen(seen); },
    get debug() { return st.lastChoice || null; },
  };
}
