// Hover tooltip. Over the world it follows the cursor and describes ctx.ui.hover (or the placement check
// while a building is in hand). Over UI elements with data-tip it sits above that element instead.
// The world tip stays out of the way while the critter is busy: hidden while it swings or walks and while
// belts are being painted, and it only comes back once things have been calm for REST s.
import { h, setText, setClass } from './dom.js';
import { clamp } from '../util/anim.js';

const REST = 0.25;      // s of calm (no swing / walk / drag) before the world tip shows again
const UI_DWELL = 0.35;  // s over a UI element before its first tip

export function createTooltip(hud) {
  const { ctx, layer } = hud;
  const { config, ui, sim, views } = ctx;
  const { RESOURCES, DEPOSITS, BUILDINGS, RECIPES, ITEMS } = config;

  const main = h('span', { class: 'tip-main' });
  const sub = h('span', { class: 'tip-sub' });
  const box = h('div', { class: 'tip' }, main, sub);
  const wrap = h('div', { class: 'tip-wrap', 'aria-hidden': 'true' }, box);
  layer.append(wrap);

  let uiTarget = null;   // element with data-tip under the pointer
  let mx = -1, my = -1;
  addEventListener('pointermove', e => {
    mx = e.clientX; my = e.clientY;
    const t = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
    uiTarget = t && layer.contains(t) ? t : null;
  }, true);
  document.documentElement.addEventListener('pointerleave', () => { mx = my = -1; uiTarget = null; });

  const lower = s => s.charAt(0).toLowerCase() + s.slice(1);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function depositName(hv) {
    let d = hv.deposit;
    if (d == null || d === 0) d = ctx.map?.depositAt?.(hv.x, hv.z);
    if (!d) return null;
    if (typeof d === 'number') return DEPOSITS[d]?.name || null;
    if (typeof d === 'string') return Object.values(DEPOSITS).find(x => x.id === d || x.item === d)?.name || ITEMS[d]?.name || null;
    return d.name || null;
  }

  // -> { main, sub, warn } | null
  function worldText() {
    const hv = ui.hover;
    if (ui.selected) {
      if (!hv) return null;
      const kind = ITEMS[ui.selected]?.building || ui.selected;
      const name = BUILDINGS[kind]?.name || kind;
      if (sim.inventory.get(ui.selected) <= 0) return { main: `No ${lower(name)}s left`, sub: 'craft more with C', warn: true };
      // the same kind already sits here: that's the one just placed (or the line being extended), not an error
      const here = sim.at?.(hv.x, hv.z);
      if (here && here.kind === kind) return null;
      const check = sim.canPlace?.(kind, hv.x, hv.z, ui.buildDir ?? 0);
      if (check && !check.ok) {
        // a tree / rock in the way says so (the sim's generic reason doesn't name it)
        if (here?.resource) return { main: `${RESOURCES[here.kind]?.name || 'Something'} in the way`, sub: here.kind === 'tree' ? 'chop it first' : 'clear it first', warn: true };
        return { main: check.reason || 'Can\'t place here', sub: '', warn: true };
      }
      if (hv.inReach === false) return { main: 'Too far', sub: 'walk closer to build', warn: true };
      return { main: `Place ${lower(name)}`, sub: BUILDINGS[kind]?.rotatable ? 'R to rotate' : '', warn: false };
    }
    if (!hv) return null;
    const e = hv.entityId != null ? sim.entities.get(hv.entityId) : null;
    // Clicking walks the critter over before it acts, so distance is never a dead end: no "too far" here.
    if (e?.resource) {
      const name = RESOURCES[e.kind]?.name || e.kind;
      const verb = e.kind === 'tree' ? 'chop' : e.kind === 'rock' ? 'break' : 'clear';
      return { main: name, sub: `click to ${verb}`, warn: false };
    }
    if (e) {
      const name = BUILDINGS[e.kind]?.name || e.kind;
      let s = '';
      if (e.kind === 'chest') s = e.total ? plural(e.total, 'item') : 'empty';
      else if (e.kind === 'workshop') s = e.recipe ? `making ${lower(RECIPES[e.recipe]?.name || e.recipe)}` : 'click to pick a recipe';
      else if (e.kind === 'drill') s = e.held ? 'output blocked' : `mining ${lower(ITEMS[e.output]?.name || e.output || '')}`;
      else if (e.kind === 'belt') s = e.items?.length ? plural(e.items.length, 'item') : 'empty';
      return { main: name, sub: s, warn: e.kind === 'drill' && !!e.held };
    }
    const dep = depositName(hv);
    if (dep) return { main: dep, sub: 'click to mine', warn: false };
    return null;
  }

  let visible = false, mode = '', key = '', w = 0, hgt = 0;
  let uiDwell = 0, uiWarm = 0; // UI tips: short first-show delay, then instant while moving between them
  let calm = REST;             // s since the critter last swung / walked or a belt drag ended
  function show(on) {
    if (on === visible) return;
    visible = on;
    setClass(wrap, 'is-on', on);
  }

  return {
    update(dt) {
      uiWarm = Math.max(0, uiWarm - dt);
      const p = views.player;
      const busy = !!(p?.busy || p?.moving || views.interact?.dragging);
      calm = busy ? 0 : calm + dt;
      if (mx < 0) { show(false); return; }
      let content = null, x, y, place;
      if (uiTarget && uiTarget.isConnected && !uiTarget.closest('[aria-hidden="true"]')) {
        uiDwell += dt;
        if (uiDwell < UI_DWELL && uiWarm <= 0) { show(false); return; }
        uiWarm = 0.4;
        content = { main: uiTarget.dataset.tip, sub: '', warn: false };
        const r = uiTarget.getBoundingClientRect();
        // hotbar slots: sit above the whole bottom column so the tip never covers the resource strip
        const col = uiTarget.closest('.dock') && uiTarget.closest('.bottom');
        x = r.left + r.width / 2; y = (col ? col.getBoundingClientRect().top : r.top) - 8; place = 'above';
      } else {
        uiDwell = 0;
        if (!ui.pointerOverUi && calm >= REST) { content = worldText(); x = mx + 16; y = my + 20; place = 'cursor'; }
      }
      if (!content || !content.main) { show(false); return; }
      const k = `${content.main}|${content.sub || ''}|${content.warn ? 1 : 0}`;
      if (k !== key) {
        key = k;
        setText(main, content.main);
        setText(sub, content.sub || '');
        setClass(sub, 'is-hidden', !content.sub);
        setClass(box, 'is-warn', !!content.warn);
        w = box.offsetWidth; hgt = box.offsetHeight; // measure only when the text changed (unscaled px)
      }
      if (mode !== place) { mode = place; wrap.dataset.place = place; }
      const s = hud.scale || 1;
      const sw = w * s, sh = hgt * s;
      if (place === 'above') { x -= sw / 2; y -= sh; }
      else {
        if (x + sw > innerWidth - 8) x = mx - 12 - sw;
        if (y + sh > innerHeight - 8) y = my - 12 - sh;
      }
      x = clamp(x, 8, innerWidth - sw - 8);
      y = clamp(y, 8, innerHeight - sh - 8);
      wrap.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)${s !== 1 ? ` scale(${s})` : ''}`;
      show(true);
    },
  };
}
