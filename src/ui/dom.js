// Tiny DOM + motion helpers shared by the HUD parts. No framework: elements are built once and patched.

export const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';

let reduced = false;
try {
  const mq = matchMedia('(prefers-reduced-motion: reduce)');
  reduced = mq.matches;
  mq.addEventListener?.('change', e => { reduced = e.matches; });
} catch { /* no matchMedia */ }
export const reduceMotion = () => reduced;

// h('div', { class: 'a', onclick: fn, style: {...}, 'aria-label': 'x' }, child, 'text', [more])
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const c of kids) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
}

// Only touch the DOM when the value really changed (cheap per-frame patching).
export function setText(el, text) {
  const s = String(text);
  if (el.__text !== s) { el.__text = s; el.textContent = s; }
}
export function setClass(el, name, on) {
  const key = `__c_${name}`;
  if (el[key] !== on) { el[key] = on; el.classList.toggle(name, on); }
}
export function setVar(el, name, value) {
  const key = `__v_${name}`;
  if (el[key] !== value) { el[key] = value; el.style.setProperty(name, value); }
}

// Brief scale pop (count changes, arrivals). Restartable: a running pop is replaced.
export function pop(el, amount = 1.22, ms = 240) {
  if (!el?.animate) return;
  el.__pop?.cancel();
  if (reduced) {
    el.__pop = el.animate([{ opacity: 0.55 }, { opacity: 1 }], { duration: 160, easing: EASE_OUT });
    return;
  }
  el.__pop = el.animate([
    { transform: 'scale(1)', easing: EASE_OUT },
    { transform: `scale(${amount})`, offset: 0.32, easing: EASE_OUT },
    { transform: 'scale(1)' },
  ], { duration: ms });
}

// Small horizontal "no" shake for refused actions.
export function shake(el) {
  if (!el?.animate || reduced) return;
  el.__shake?.cancel();
  el.__shake = el.animate([
    { translate: '0 0' }, { translate: '-4px 0' }, { translate: '4px 0' }, { translate: '-3px 0' }, { translate: '2px 0' }, { translate: '0 0' },
  ], { duration: 300, easing: 'ease-out' });
}

export const fmt = n => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n));

// Inline SVG glyphs (stroke uses currentColor).
export const svg = {
  close: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  chevron: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 8l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  arrow: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10h11M11 6l4 4-4 4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  hammer: '<svg viewBox="0 0 40 40" aria-hidden="true">'
    + '<ellipse cx="20" cy="34" rx="11" ry="2.6" fill="#b48a52" opacity=".22"/>'
    + '<path d="M10.5 31.5L23 19" stroke="#9b6334" stroke-width="7.4" stroke-linecap="round"/>'
    + '<path d="M10.5 31.5L23 19" stroke="#d89a58" stroke-width="4" stroke-linecap="round"/>'
    + '<g transform="rotate(45 25 15)">'
    + '<rect x="14" y="9.5" width="22" height="11" rx="3.6" fill="#e48b4f" stroke="#b9643a" stroke-width="1.8"/>'
    + '<rect x="16.5" y="11.6" width="10" height="3.2" rx="1.6" fill="#ffd9a8" opacity=".9"/>'
    + '<rect x="33" y="9.5" width="3" height="11" rx="1.4" fill="#b9643a" opacity=".5"/>'
    + '</g></svg>',
};

// CSS cubic-bezier as a JS easing (for HUD motion driven from update(dt), so pausing / __game.step stay exact).
export function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = t => ((ax * t + bx) * t + cx) * t;
  const sy = t => ((ay * t + by) * t + cy) * t;
  const dx = t => (3 * ax * t + 2 * bx) * t + cx;
  return x => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x, d = dx(t);
      if (Math.abs(e) < 1e-6) return sy(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0, hi = 1; t = x; // bisection fallback
    for (let i = 0; i < 24; i++) { const v = sx(t); if (Math.abs(v - x) < 1e-6) break; if (v < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    return sy(t);
  };
}
// The HUD's two curves (Emil): ease-out for enters / exits / state changes, ease-in-out for things moving on screen.
export const easeOut = bezier(0.23, 1, 0.32, 1);
export const easeInOut = bezier(0.77, 0, 0.175, 1);

// ---- per-frame patch helpers for the camp HUD (camp-hud.js, camp-ribbon.js, camp-complete.js) ----
// Outlined numerals / words (UI-STYLE "numbers are the hero"): a stroked layer under a plain fill layer (.ol).
export const ol = (text, cls = '') => h('span', { class: `ol ${cls}`, 'data-t': String(text) }, String(text));
export function setOl(el, text) {
  const s = String(text);
  if (el.__t === s) return;
  el.__t = s; el.textContent = s; el.dataset.t = s;
}
export const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
export const easeIn = t => t * t * t;
// transform / opacity writers that skip unchanged values
export const tf = (el, v) => { if (el.__tf !== v) { el.__tf = v; el.style.transform = v; } };
export const op = (el, v) => { const s = typeof v === 'number' ? v.toFixed(3) : v; if (el.__op !== s) { el.__op = s; el.style.opacity = s; } };
// A tiny seeded random (confetti etc.): the same celebration looks the same in every capture.
export function rng(seed = 1) {
  let s = (seed >>> 0) || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
