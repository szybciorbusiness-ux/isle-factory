// First-time hints: at most five in the whole game, each shown once, for ~3 s or until the thing is done,
// in a sticker bubble above the robot (projected every frame, smoothed so the robot's bob never jitters it).
// Shown ids persist in localStorage (try/catch: private mode, blocked storage); ?fresh=1 clears them.
// The guide calls want(id, ctx) when a hint's moment arrives and done(id) when the player did it.
import { Spring, clamp, damp, ease } from '../../util/anim.js';
import { TAIL_SVG } from './css.js';
import { createIconSlot } from './icons.js';

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
  layer.append(el);
  const setIcon = createIconSlot(views, items);

  const vis = new Spring(0, { stiffness: 340, damping: 18 });
  const pop = new Spring(0, { stiffness: 420, damping: 14 });
  const st = { cur: null, t: 0, doneAt: -1, queue: [], x: 0, y: 0, placed: false, out: false, lastCss: '', w: 0, h: 0 };
  // the bubble's own box (its bottom-centre = the tail tip sits on the anchor); measured once per hint
  function measure() { st.w = el.offsetWidth; st.h = el.offsetHeight; }

  function start(id, opts = {}) {
    const def = HINTS[id];
    const label = opts.text || def.text;
    const icon = opts.icon !== undefined ? opts.icon : def.icon;
    text.textContent = label;
    card.classList.toggle('no-icon', !icon);
    setIcon(iconWrap, icon);
    st.cur = id; st.t = 0; st.doneAt = -1; st.out = false; st.force = false;
    seen.add(id); saveSeen(seen);
    vis.set(0); vis.target = 1; pop.set(0); pop.velocity = 0;
    measure();
  }

  return {
    el,
    seen: id => seen.has(id),
    get current() { return st.cur; },
    get count() { return seen.size; },
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
    done(id) {
      if (st.cur === id && st.doneAt < 0) st.doneAt = st.t;
      st.queue = st.queue.filter(q => q.id !== id);
      if (!seen.has(id)) { seen.add(id); saveSeen(seen); } // done before it ever showed: no need for it
    },
    // anchor: screen {x, y} of the point above the robot (or null to hold)
    update(dt, anchor, { suppress = false } = {}) {
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
        st.cur = null; el.style.visibility = 'hidden'; el.style.opacity = '0'; st.placed = false;
        return;
      }
      if (anchor) {
        // keep the whole bubble on screen (the robot near a side edge): the tail still points at the robot
        const half = st.w / 2 + 8, W = innerWidth;
        const ax = W > half * 2 ? Math.min(W - half, Math.max(half, anchor.x)) : anchor.x;
        if (!st.placed) { st.x = ax; st.y = anchor.y; st.placed = true; }
        st.x = damp(st.x, ax, 22, dt);
        st.y = damp(st.y, anchor.y, 16, dt);
      }
      const red = reduced();
      const s = red ? 1 : (st.out ? 0.75 + 0.25 * v : 0.82 + 0.18 * v) * (1 + 0.06 * pop.value);
      const rise = red ? 0 : (1 - clamp(v)) * 10;
      const bob = red ? 0 : Math.sin(st.t * 2.4) * 1.6;
      const css = `translate3d(${(st.x - st.w / 2).toFixed(1)}px, ${(st.y + rise + bob - st.h).toFixed(1)}px, 0) scale(${s.toFixed(3)})`;
      if (css !== st.lastCss) { el.style.transform = css; st.lastCss = css; }
      el.style.opacity = ease.quadOut(clamp(v * 1.4)).toFixed(3);
      if (el.style.visibility !== 'visible') el.style.visibility = 'visible';
    },
    reset() { seen.clear(); saveSeen(seen); },
  };
}
