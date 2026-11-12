// HUD: DOM overlay inside ctx.uiRoot. Composes the parts below and owns keys 1-4, C, Tab, Escape and H / ?
// (controls card). Contract: DESIGN.md "ui". All timers run on the dt passed to update(dt, t); CSS only
// handles the short 150-250 ms state transitions (enter / exit / hover / press) and the sheet slides.
//
// Mobile / portrait (DESIGN.md 3b, ctx.mobile): resources sit in a slim row under the status bar, the hotbar
// spans the bottom above the home indicator and publishes --hud-bottom for the touch controls, crafting and
// chest / workshop panels are bottom sheets over a light scrim (tap it, the x, or pull the grip down to
// close). No hover tooltip and no keyboard controls card there.
//
// Camp mode (ctx.camp, GAMEPLAY.md): the world is the UI. No hotbar, resource strip, crafting, chest /
// workshop panels or controls card: camp-hud.js draws the hearth-level pill, the carried-stack pill, the
// level-up ribbon and the walk hint, camp-toasts.js the news. No keys are taken (Space etc. stay the game's).
import { h } from './dom.js';
import { createIcons } from './icons.js';
import { createHotbar } from './hotbar.js';
import { createCraft } from './craft.js';
import { createEntityPanel } from './entity-panel.js';
import { createToasts } from './toasts.js';
import { createTooltip } from './tooltip.js';
import { createHints } from './hints.js';
import { createCampHud } from './camp-hud.js';
import { createCampToasts } from './camp-toasts.js';

// s without news before the counts land anyway: short while fx has never reported an arrival (stub or
// broken), long once it has (flights can wait for a tree to finish falling).
const ARRIVAL_TIMEOUT_UNKNOWN = 1.0;
const ARRIVAL_TIMEOUT = 3.0;

// Small viewports: the whole HUD scales down (each group anchored to its corner) and the controls stay folded.
const COMPACT_H = 760, COMPACT_W = 1200;
const TINY_H = 600, TINY_W = 900;
const viewScale = (w, h) => (h < TINY_H || w < TINY_W ? 0.75 : h < COMPACT_H || w < COMPACT_W ? 0.85 : 1);

export function create(ctx) {
  const { uiRoot, events, ui, sim, config } = ctx;
  const mobile = !!ctx.mobile || document.body.classList.contains('mobile');
  const camp = ctx.camp || null;

  const layer = h('div', { class: `hud${mobile ? ' is-mobile' : ''}${camp ? ' is-camp' : ''}`, 'data-hud': '' });
  uiRoot.append(layer);
  const icons = createIcons(ctx);
  // the items the camp shows (stack pill, pads' cost bubbles): render them up front, one renderer, then release
  const iconIds = camp ? (camp.CARRY_ITEMS || Object.keys(config.ITEMS).filter(id => !config.ITEMS[id].building)) : Object.keys(config.ITEMS);
  if (camp) for (const id of iconIds) { try { icons.get(id); } catch (e) { console.error('[ui] icon', id, e); } }
  // iOS only runs :active (the .97 press) when a touch listener exists up the tree
  if (mobile) layer.addEventListener('touchstart', () => {}, { passive: true });

  // ---------- displayed inventory ----------
  // Items picked up from the world fly to the player first (fx). Their count lands when the flight does,
  // so numbers never jump ahead of the motion. Everything else (crafting, placing) updates at once.
  const shown = { ...sim.inventory.counts };
  const pending = new Map(); // item -> { n, t }  (gained in the sim, still flying to the player)
  const countListeners = [];
  let looping = false;       // false until the first frame: scenario warm-up gains have no flights
  let seenArrival = false;   // fx has reported at least one landing
  let fxSilent = false;      // fx never reported one in time: stop waiting for it
  const emitCount = (item, delta, arrived) => {
    shown[item] = Math.max(0, sim.inventory.get(item) - (pending.get(item)?.n || 0));
    // before the first frame (scenario set-up) counts just settle: no pops, no floaters
    for (const fn of countListeners) fn(item, shown[item], delta, arrived, !looping);
  };
  // Land `n` pending items (all when n is undefined).
  const release = (item, n) => {
    const p = pending.get(item);
    if (!p) { for (const fn of countListeners) fn(item, shown[item], 0, true); return; }
    const k = n == null ? p.n : Math.min(p.n, Math.max(0, n));
    p.n -= k; p.t = 0;
    if (p.n <= 0) pending.delete(item);
    emitCount(item, k, true);
  };

  const hud = {
    ctx, layer, icons,
    shown,
    scale: 1,        // HUD scale (CSS var --ui-s); floating parts multiply their measured sizes by it
    compact: false,  // viewport below COMPACT_W x COMPACT_H
    mobile,          // portrait / touch layout: bottom sheets, no tooltip, no controls card
    onCount(fn) { countListeners.push(fn); },
    itemName: id => config.ITEMS[id]?.name || id,
    // Shared UI state writers: always announce on the bus (DESIGN.md "Shared UI state").
    setSelected(id) {
      if (ui.selected === id) return;
      ui.selected = id;
      events.emit('ui:select', { selected: id });
    },
    setPanel(panel) {
      ui.panel = panel;
      events.emit('ui:panel', { panel });
      recheckPointer();
    },
    toggleCraft() {
      hud.setPanel(ui.panel?.type === 'craft' ? null : { type: 'craft' });
    },
    toast: (text, kind = 'info') => events.emit('toast', { text, kind }),
    // Bottom edge the floating panels must stay above (top of the hotbar column), in CSS px.
    bottomLimit: () => innerHeight - 16,
  };

  function applyScale(w = innerWidth, ht = innerHeight) {
    const s = mobile ? 1 : viewScale(w, ht); // phones are sized for touch already
    hud.scale = s;
    hud.compact = s < 1;
    layer.style.setProperty('--ui-s', String(s));
    layer.classList.toggle('is-compact', hud.compact);
  }
  applyScale();

  events.on('inventory:changed', ({ item, delta, source }) => {
    if (delta > 0 && source && looping && !fxSilent) {
      const p = pending.get(item) || { n: 0, t: 0 };
      p.n += delta; p.t = 0;
      pending.set(item, p);
      return;
    }
    emitCount(item, delta, false);
  });
  events.on('fx:itemArrived', ({ item, count } = {}) => {
    seenArrival = true; fxSilent = false;
    if (item) release(item, Number.isFinite(count) ? count : undefined);
  });

  // ---------- parts ----------
  const parts = [];
  const add = (name, make) => {
    try { const p = make(hud); parts.push(p); hud[name] = p; return p; }
    catch (e) { console.error(`[ui] ${name} failed: ${e?.stack || e}`); return null; }
  };
  // Mobile sheets dim the world a touch; tapping the dim closes the sheet (that tap never reaches the world).
  if (mobile && !camp) {
    const scrim = h('div', { class: 'scrim', 'aria-hidden': 'true', onclick: () => { if (ui.panel) hud.setPanel(null); } });
    layer.append(scrim);
    hud.syncScrim = () => {
      const on = !!ui.panel;
      if (scrim.__on === on) return;
      scrim.__on = on;
      scrim.classList.toggle('is-on', on);
      scrim.classList.toggle('hit', on);
    };
    events.on('ui:panel', hud.syncScrim);
  }

  if (camp) {
    add('campToasts', createCampToasts);
    add('camp', createCampHud);
    hud.toast = (text, kind = 'info') => hud.campToasts?.show?.({ text, kind });
    hud.bottomLimit = () => innerHeight - (hud.camp?.hudBottom?.() || 16);
  } else {
    add('hotbar', createHotbar);
    add('craft', createCraft);
    add('entityPanel', createEntityPanel);
    if (!mobile) add('hints', createHints);     // keyboard controls card: desktop only
    add('toasts', createToasts);
    if (!mobile) add('tooltip', createTooltip); // no hover on touch
    hud.bottomLimit = () => hud.hotbar?.top?.() ?? innerHeight - 16;
  }

  // ---------- pointer over UI ----------
  let px = -1, py = -1;
  const overUi = t => t instanceof Element && layer.contains(t) && !!t.closest('.hit');
  const onPointer = e => {
    px = e.clientX; py = e.clientY;
    ui.pointerOverUi = overUi(e.target);
  };
  function recheckPointer() {
    if (px < 0) return;
    // after a panel closes under a still pointer, re-test what is really under it next frame
    requestAnimationFrame(() => { ui.pointerOverUi = overUi(document.elementFromPoint(px, py)); });
  }
  addEventListener('pointermove', onPointer, true);
  addEventListener('pointerover', onPointer, true);
  addEventListener('pointerdown', onPointer, true);
  document.documentElement.addEventListener('pointerleave', () => { ui.pointerOverUi = false; px = py = -1; });
  // Buttons never take focus (Space / Enter belong to the game), and right-click never opens a menu on UI.
  layer.addEventListener('mousedown', e => { if (e.target.closest?.('button')) e.preventDefault(); });
  layer.addEventListener('focusin', e => { if (e.target instanceof HTMLElement && e.target.closest('button')) e.target.blur(); });
  layer.addEventListener('contextmenu', e => e.preventDefault());
  hud.pointer = () => ({ x: px, y: py });

  // ---------- keys ----------
  const typing = t => t instanceof Element && (t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
  if (!camp) addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
    const code = e.code;
    const digit = /^(Digit|Numpad)([1-9])$/.exec(code);
    if (digit) {
      const i = Number(digit[2]) - 1;
      if (i < config.BUILDING_ITEMS.length) { e.preventDefault(); hud.hotbar?.toggle(config.BUILDING_ITEMS[i], 'key'); }
      return;
    }
    if (code === 'KeyC' || code === 'Tab') {
      e.preventDefault();
      if (!e.repeat) hud.toggleCraft();
      return;
    }
    if (code === 'KeyH' || e.key === '?') {
      e.preventDefault();
      if (!e.repeat) hud.hints?.toggle?.();
      return;
    }
    if (code === 'Escape') {
      if (ui.panel) hud.setPanel(null);
      else if (ui.selected) hud.setSelected(null);
      else return;
      e.preventDefault();
    }
  });

  // ---------- frame ----------
  let iconCheck = 1.2; // re-render icons once the other modules have settled (models may build lazily)
  const itemIds = Object.keys(config.ITEMS);
  function update(dt, t) {
    looping = true;
    for (const [item, p] of pending) {
      p.t += dt;
      if (p.t > (seenArrival ? ARRIVAL_TIMEOUT : ARRIVAL_TIMEOUT_UNKNOWN)) {
        if (!seenArrival) fxSilent = true;
        release(item);
      }
    }
    // Counts changed behind the event bus (scenarios, tests): resync quietly, no pops or floaters.
    for (const item of itemIds) {
      const want = Math.max(0, sim.inventory.get(item) - (pending.get(item)?.n || 0));
      if (shown[item] !== want) { shown[item] = want; for (const fn of countListeners) fn(item, want, 0, false, true); }
    }
    if (iconCheck > 0 && (iconCheck -= dt) <= 0) {
      try { icons.refresh(layer, iconIds); } catch (e) { console.error('[ui] icon refresh', e); }
      icons.release();
    }
    icons.tick(dt); // a late icon request (e.g. a new pad) renders, then the renderer goes again
    for (const p of parts) p.update?.(dt, t);
    hud.syncScrim?.(); // ui.panel may change without an announcement
  }

  return {
    update,
    resize(w, h) { applyScale(w, h); for (const p of parts) p.resize?.(w, h); },
    refreshIcons: () => icons.refresh(layer, iconIds),
    // PNG data URL (128 px, transparent) for any item id; stable per id until a 'ui:icons' { changed } event
    iconUrl: id => icons.get(id),
    // px from the viewport bottom to the top of the bottom HUD stack (also the CSS var --hud-bottom)
    hudBottom: () => (camp ? hud.camp?.hudBottom?.() : hud.hotbar?.hudBottom?.()) ?? 0,
    get sheetOpen() { return mobile && !!ui.panel; },
    mobile,
    camp: hud.camp || null,
    toast: (text, kind) => hud.toast(text, kind),
    setPanel: hud.setPanel,
    setSelected: hud.setSelected,
    el: layer,
  };
}
