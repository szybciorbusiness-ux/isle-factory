// Bottom centre: resource strip (raw + intermediate items) above the hotbar (four buildings + craft button).
// Mobile: the strip moves to a slim row under the status bar and the hotbar spans the width above the home
// indicator. The column publishes --hud-bottom (px from the viewport bottom to its top) on <html> for the
// touch controls, kept current on resize / font load / layout changes.
import { h, setText, setClass, setVar, pop, shake, fmt, svg, reduceMotion } from './dom.js';

const MERGE_WINDOW = 0.35; // s: arrivals this close together grow one "+N" instead of stacking floaters

export function createHotbar(hud) {
  const { ctx, icons, layer, mobile } = hud;
  const { config, ui, events, sim } = ctx;

  const col = h('div', { class: 'bottom' });
  const strip = h('div', { class: `res${mobile ? ' res-top' : ''} hit`, role: 'list', 'aria-label': 'Resources' });
  const dock = h('div', { class: 'dock hit', role: 'toolbar', 'aria-label': 'Buildings' });
  if (mobile) { col.append(dock); layer.append(strip, col); }
  else { col.append(strip, dock); layer.append(col); }

  const cells = {}; // item -> { el, count, iconWrap, floater, floaterAge, n }

  // ---------- resource strip ----------
  // raw materials, a thin divider, then the crafted intermediates
  const crafted = id => Object.values(config.RECIPES).some(r => r.outputs?.[id]);
  config.RESOURCE_ITEMS.forEach((id, i) => {
    if (i > 0 && crafted(id) && !crafted(config.RESOURCE_ITEMS[i - 1])) strip.append(h('span', { class: 'res-sep', 'aria-hidden': 'true' }));
    const count = h('span', { class: 'res-count' });
    const iconWrap = h('span', { class: 'res-icon' }, icons.img(id));
    const el = h('div', { class: 'res-chip', role: 'listitem', 'data-tip': hud.itemName(id), style: { '--i': i } }, iconWrap, count);
    strip.append(el);
    cells[id] = { el, count, iconWrap, floater: null, floaterAge: 0, n: 0 };
  });

  // ---------- hotbar ----------
  config.BUILDING_ITEMS.forEach((id, i) => {
    const count = h('span', { class: 'slot-count' });
    const iconWrap = h('span', { class: 'slot-icon' }, icons.img(id));
    const el = h('button', {
      class: 'slot', type: 'button', tabindex: -1,
      'aria-label': `${hud.itemName(id)} (key ${i + 1})`, 'data-tip': hud.itemName(id),
      style: { '--i': i },
      onclick: () => toggle(id, 'click'),
    }, h('span', { class: 'slot-key' }, String(i + 1)), iconWrap, count);
    dock.append(el);
    cells[id] = { el, count, iconWrap, floater: null, floaterAge: 0, n: 0, slot: true };
  });

  // craft button: opens the crafting panel; shows a ring while hand crafting runs
  const craftBadge = h('span', { class: 'slot-count craft-badge' });
  const craftBtn = h('button', {
    class: 'slot slot-craft', type: 'button', tabindex: -1, 'aria-label': 'Crafting (C)', 'data-tip': 'Crafting',
    style: { '--i': config.BUILDING_ITEMS.length },
    onclick: () => hud.toggleCraft(),
  }, h('span', { class: 'slot-key' }, 'C'), h('span', { class: 'slot-ring' }), h('span', { class: 'slot-icon craft-glyph', html: svg.hammer }), craftBadge);
  dock.append(h('span', { class: 'dock-sep', 'aria-hidden': 'true' }), craftBtn);

  // ---------- counts ----------
  function paint(id, n, animate) {
    const c = cells[id];
    if (!c) return;
    const prev = c.n;
    c.n = n;
    setText(c.count, fmt(n));
    setClass(c.el, 'is-empty', n <= 0);
    if (animate && n !== prev) pop(c.count, n > prev ? 1.3 : 1.15);
  }
  for (const id of Object.keys(cells)) paint(id, hud.shown[id] || 0, false);

  function floater(id, delta) {
    const c = cells[id];
    if (!c || delta <= 0) return;
    if (c.floater && c.floaterAge < MERGE_WINDOW) {
      c.floater.__n += delta;
      setText(c.floater.firstChild, `+${c.floater.__n}`);
      c.floaterAge = 0;
      pop(c.floater, 1.15, 200);
      return;
    }
    const el = h('span', { class: 'floater', 'aria-hidden': 'true' }, h('b', null, `+${delta}`));
    el.__n = delta;
    c.el.append(el);
    c.floater = el; c.floaterAge = 0;
    const done = () => { el.remove(); if (c.floater === el) c.floater = null; };
    if (!el.animate) { setTimeout(done, 900); return; }
    // rises out of the hotbar; in the mobile top row it drops below the chip instead (room under the status bar)
    const dir = mobile && !c.slot ? 1 : -1;
    const rise = reduceMotion() ? 0 : 30 * dir;
    el.animate([
      { opacity: 0, transform: `translate(-50%, ${-4 * dir}px) scale(.9)`, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
      { opacity: 1, transform: `translate(-50%, ${8 * dir}px) scale(1)`, offset: 0.22, easing: 'cubic-bezier(0.33, 0, 0.67, 1)' },
      { opacity: 1, transform: `translate(-50%, ${rise * 0.75}px) scale(1)`, offset: 0.72, easing: 'ease-in' },
      { opacity: 0, transform: `translate(-50%, ${rise}px) scale(.96)` },
    ], { duration: 950, fill: 'forwards' }).onfinish = done;
  }

  hud.onCount((id, n, delta, arrived, quiet) => {
    paint(id, n, !quiet);
    if (quiet) return;
    if (delta > 0) floater(id, delta);
    if (arrived) pop(cells[id]?.iconWrap, 1.12, 220);
    // placed the last one of the building in hand: empty the hand
    if (delta < 0 && id === ui.selected && sim.inventory.get(id) <= 0) hud.setSelected(null);
  });

  // ---------- selection ----------
  function toggle(id, via) {
    const next = ui.selected === id ? null : id;
    if (next && sim.inventory.get(id) <= 0) {
      shake(cells[id].el);
      const name = hud.itemName(id).toLowerCase();
      if (mobile) {
        // no C key on a phone: open the crafting sheet on the recipe that makes it
        hud.toast(`No ${name}s yet. Craft some first`, 'warn');
        if (ui.panel?.type !== 'craft') hud.setPanel({ type: 'craft' });
        hud.craft?.highlight?.(id);
        return;
      }
      hud.toast(`No ${name}s yet. Craft some with C`, 'warn');
      if (via === 'key' || via === 'click') hud.craft?.highlight?.(id);
      return;
    }
    hud.setSelected(next);
    syncSelected();
  }
  let lastSel;
  function syncSelected() {
    if (lastSel === ui.selected) return;
    lastSel = ui.selected;
    for (const id of config.BUILDING_ITEMS) setClass(cells[id].el, 'is-selected', ui.selected === id);
  }
  events.on('ui:select', syncSelected);
  syncSelected();

  // ---------- frame ----------
  // Top of the bottom column, and --hud-bottom on <html> for the touch controls (DESIGN.md 3b).
  // Layout only (the column itself never animates), so measuring it is cheap and stable.
  let colTop = innerHeight - 140, hudBottom = -1;
  const root = document.documentElement;
  function measure() {
    colTop = col.getBoundingClientRect().top;
    const b = Math.max(0, Math.round(innerHeight - colTop));
    if (b !== hudBottom) { hudBottom = b; root.style.setProperty('--hud-bottom', `${b}px`); }
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
  ro?.observe(col);
  measure();
  document.fonts?.ready?.then(measure, () => {});

  let craftShown = -1;
  function update(dt) {
    for (const c of Object.values(cells)) if (c.floater) c.floaterAge += dt;
    syncSelected(); // in case someone changed ui.selected without announcing it
    // craft queue ring on the craft button
    const q = sim.craftQueue;
    const job = q[0];
    const p = job ? Math.min(1, job.t / job.time) : 0;
    setVar(craftBtn, '--p', p.toFixed(3));
    setClass(craftBtn, 'is-busy', !!job);
    setClass(craftBtn, 'is-open', ui.panel?.type === 'craft');
    if (craftShown !== q.length) {
      craftShown = q.length;
      setText(craftBadge, q.length ? fmt(q.length) : '');
    }
  }

  return {
    toggle,
    update,
    top: () => colTop,
    hudBottom: () => hudBottom,
    resize: measure,
    cell: id => cells[id]?.el,
  };
}
