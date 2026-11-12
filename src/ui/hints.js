// Controls card, bottom-right. Open on a fresh start so the keys are in view; it folds itself into a small
// "?" button on the first movement or after AUTO_FOLD s of play (game time), and on small viewports it starts
// folded. "?" (or the H / ? keys) opens it again; once the player toggles it themselves we never auto-fold.
import { h, setClass, svg } from './dom.js';

const AUTO_FOLD = 20; // s of play before the card folds away on its own
const ROWS = [
  [['W', 'A', 'S', 'D'], 'Move'],
  [['Click'], 'Chop, mine, use', 'walks there'],
  [['Space'], 'Chop nearest'],
  [['1', '–', '4'], 'Build'],
  [['R'], 'Rotate'],
  [['Right-click'], 'Remove', 'drag for many'],
  [['Q'], 'Pick'],
  [['C'], 'Craft'],
  [['Scroll'], 'Zoom'],
];
const Q_SIZE = 40; // px, the folded "?" button (unscaled; keep in sync with ui.css)

export function createHints(hud) {
  const { layer, ctx } = hud;
  const { sim, views } = ctx;

  const list = h('div', { class: 'controls-list' },
    ROWS.map(([keys, label, note], i) => [
      h('span', { class: 'controls-keys', style: { '--i': i } },
        keys.map(k => (k === '–' ? h('span', { class: 'controls-dash' }, '–') : h('kbd', { class: `keycap${k.length > 2 ? ' keycap-wide' : ''}` }, k)))),
      h('span', { class: 'controls-label', style: { '--i': i } }, label, note ? h('span', { class: 'controls-note' }, note) : null),
    ]));
  const fold = h('button', {
    class: 'x controls-fold', type: 'button', tabindex: -1, 'aria-label': 'Hide controls', html: svg.chevron,
    onclick: () => toggle(),
  });
  const card = h('section', { class: 'controls-card hit', role: 'region', 'aria-label': 'Controls' },
    h('header', { class: 'controls-head' }, h('h2', null, 'Controls'), fold), list);
  const q = h('button', {
    class: 'controls-q hit', type: 'button', tabindex: -1, 'aria-label': 'Show controls', 'data-tip': 'Controls · H',
    onclick: () => toggle(),
  }, h('span', { 'aria-hidden': 'true' }, '?'));
  const root = h('div', { class: 'controls' }, card, q);
  layer.append(root);

  let collapsed = false;
  let touched = false;   // the player opened / closed it themselves: auto-fold stays out of the way
  let age = 0;           // s of play while the card is open on its own
  let start = null;      // player tile on the first frame
  function set(c) {
    collapsed = c;
    setClass(root, 'is-collapsed', c);
    card.setAttribute('aria-hidden', String(c));
    q.setAttribute('aria-hidden', String(!c));
    q.setAttribute('aria-expanded', String(!c));
    hud.craft?.resize?.(); // the crafting panel re-checks whether it now touches the card
  }
  function toggle() { touched = true; set(!collapsed); }
  set(hud.compact);

  // Hide while something else needs the bottom-right corner (several panels can ask at once).
  const tuckers = new Set();
  function tuck(reason, on) {
    if (on) tuckers.add(reason); else tuckers.delete(reason);
    const t = tuckers.size > 0;
    setClass(root, 'is-tucked', t);
    root.setAttribute('aria-hidden', String(t));
  }

  // Card size from layout (no forced layout per frame); the visual rect applies the HUD scale.
  let size = { w: 280, h: 300 };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { size = { w: card.offsetWidth, h: card.offsetHeight }; }) : null;
  ro?.observe(card);
  const M = 16;
  function rect() {
    const s = hud.scale || 1;
    const w = (collapsed ? Q_SIZE : size.w) * s, ht = (collapsed ? Q_SIZE : size.h) * s;
    return { left: innerWidth - M - w, top: innerHeight - M - ht, right: innerWidth - M, bottom: innerHeight - M };
  }

  return {
    set,
    toggle,
    tuck,
    get collapsed() { return collapsed; },
    top: () => rect().top,
    rect,
    update(dt) {
      if (collapsed || touched) return;
      const p = sim.player;
      if (!start) { start = { x: p.x, z: p.z }; return; }
      age += dt;
      const moved = p.x !== start.x || p.z !== start.z || !!views.player?.moving;
      if (moved || age >= AUTO_FOLD) set(true);
    },
    // Small viewports keep the card folded (the player can still open it).
    resize() { if (hud.compact && !collapsed && !touched) set(true); },
  };
}
