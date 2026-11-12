// Crafting panel (C / Tab / craft button): recipe cards for config.HAND_RECIPES and the live hand-craft queue.
// Desktop: docked top-right so the centre of the screen stays clear. Mobile: a bottom sheet that slides up
// behind the hotbar (tap to craft 1, hold a card for 5, pull the grip down to close).
import { h, setText, setClass, setVar, pop, shake, svg } from './dom.js';
import { makeSheet } from './sheet.js';

const HOLD = 0.45; // s: holding a recipe card on touch crafts 5

export function createCraft(hud) {
  const { ctx, icons, layer, mobile } = hud;
  const { config, ui, events, sim } = ctx;
  const { RECIPES, HAND_RECIPES } = config;

  const close = h('button', { class: 'x', type: 'button', tabindex: -1, 'aria-label': 'Close crafting', html: svg.close, onclick: () => hud.setPanel(null) });
  const grid = h('div', { class: 'recipes' });
  const queueList = h('div', { class: 'queue', 'aria-live': 'polite' });
  const queueEmpty = h('span', { class: 'queue-empty' }, 'Nothing crafting');
  const panel = h('section', { class: 'panel craft hit', role: 'dialog', 'aria-label': 'Crafting', 'aria-hidden': 'true' },
    h('header', { class: 'panel-head' }, h('h2', null, 'Crafting'), mobile ? null : h('span', { class: 'keycap keycap-sm' }, 'C'), close),
    grid,
    h('div', { class: 'queue-wrap' },
      h('div', { class: 'queue-head' }, h('span', null, 'Queue'), h('span', { class: 'muted' }, mobile ? 'Tap a job to cancel' : 'Click a job to cancel')),
      h('div', { class: 'queue-row' }, queueList, queueEmpty)),
    h('footer', { class: 'panel-foot' }, mobile ? 'Tap to craft 1 · hold for 5' : 'Click to craft 1 · Shift-click for 5'),
  );
  layer.append(panel);
  const sheet = mobile ? makeSheet(panel, () => hud.setPanel(null)) : null;

  // touch: press and hold a card for 5 (timed on the game dt; the click that ends the hold is swallowed)
  let hold = null; // { rid, t }
  let swallow = null;

  // ---------- recipe cards ----------
  const cards = HAND_RECIPES.map((rid, i) => {
    const r = RECIPES[rid];
    const [outId, outN] = Object.entries(r.outputs)[0];
    const iconWrap = h('span', { class: 'recipe-icon' }, icons.img(outId), outN > 1 ? h('span', { class: 'recipe-yield' }, `×${outN}`) : null);
    const ings = Object.entries(r.inputs).map(([item, n]) => {
      const el = h('span', { class: 'ing', 'data-tip': `${n} ${hud.itemName(item).toLowerCase()}` }, icons.img(item), h('b', null, String(n)));
      return { item, n, el };
    });
    const el = h('button', {
      class: 'recipe', type: 'button', tabindex: -1, style: { '--i': i },
      'aria-label': `Craft ${r.name}`,
      onclick: e => {
        if (swallow === rid) { swallow = null; return; }
        craft(rid, e.shiftKey ? 5 : 1);
      },
      onpointerdown: e => { if (mobile && e.isPrimary) { hold = { rid, t: 0 }; swallow = null; } },
      onpointerup: () => { hold = null; },
      onpointercancel: () => { hold = null; },
      onpointerleave: () => { hold = null; },
    },
      h('span', { class: 'recipe-top' }, iconWrap,
        h('span', { class: 'recipe-meta' }, h('span', { class: 'recipe-name' }, r.name), h('span', { class: 'recipe-time' }, `${r.time} s`))),
      h('span', { class: 'ings' }, ings.map(x => x.el)),
    );
    grid.append(el);
    return { rid, el, iconWrap, ings, ok: null };
  });
  const cardOf = rid => cards.find(c => c.rid === rid);

  function craft(rid, n) {
    const c = cardOf(rid);
    const got = sim.craft(rid, n);
    if (got > 0) {
      pop(c.iconWrap, 1.16, 240);
    } else {
      shake(c.el);
      c.ings.forEach(x => { if (sim.inventory.get(x.item) < x.n) pop(x.el, 1.14, 220); });
    }
  }

  function paintCards() {
    for (const c of cards) {
      let ok = true;
      for (const x of c.ings) {
        const miss = sim.inventory.get(x.item) < x.n;
        setClass(x.el, 'is-missing', miss);
        if (miss) ok = false;
      }
      if (c.ok !== ok) { c.ok = ok; setClass(c.el, 'is-blocked', !ok); }
    }
  }

  // ---------- queue ----------
  // Jobs are one unit each; consecutive jobs of the same recipe share a tile (stable id through completions).
  const jobGroup = new WeakMap();
  let gid = 0;
  const tiles = new Map(); // group id -> { el, count, bar }
  function groups() {
    const q = sim.craftQueue, out = [];
    for (let i = 0; i < q.length; i++) {
      const job = q[i];
      let g = jobGroup.get(job);
      if (g == null) {
        const pj = q[i - 1];
        g = pj && pj.recipe === job.recipe ? jobGroup.get(pj) : ++gid;
        jobGroup.set(job, g);
      }
      const last = out[out.length - 1];
      if (last && last.id === g) { last.count++; last.end = i; }
      else out.push({ id: g, recipe: job.recipe, count: 1, start: i, end: i });
    }
    return out;
  }
  function cancelGroup(id, many) {
    const g = groups().find(x => x.id === id);
    if (!g) return;
    const n = many ? Math.min(5, g.count) : 1;
    for (let k = 0; k < n; k++) sim.cancelCraft(g.end - k);
  }
  function tileFor(g) {
    const r = RECIPES[g.recipe];
    const outId = Object.keys(r.outputs)[0];
    const count = h('span', { class: 'qcount' });
    const bar = h('span', { class: 'qbar' }, h('i'));
    const el = h('button', {
      class: 'qtile', type: 'button', tabindex: -1, 'aria-label': `Cancel ${r.name}`, 'data-tip': `${r.name} · click to cancel`,
      onclick: e => cancelGroup(g.id, e.shiftKey),
    }, icons.img(outId), count, bar, h('span', { class: 'qx', html: svg.close }));
    return { el, count, bar, n: 0 };
  }
  let lastSig = '';
  function paintQueue() {
    const gs = groups();
    const sig = gs.map(g => `${g.id}:${g.count}`).join(',');
    if (sig !== lastSig) {
      lastSig = sig;
      const live = new Set(gs.map(g => g.id));
      for (const [id, t] of tiles) {
        if (live.has(id)) continue;
        tiles.delete(id);
        t.el.classList.add('is-leaving');
        t.el.style.pointerEvents = 'none';
        setVar(t.bar, '--p', '1');
        const rm = () => t.el.remove();
        if (t.el.animate) t.el.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.9)' }], { duration: 160, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'forwards' }).onfinish = rm;
        else rm();
      }
      for (const g of gs) {
        let t = tiles.get(g.id);
        if (!t) {
          t = tileFor(g);
          tiles.set(g.id, t);
          queueList.append(t.el);
          t.el.animate?.([{ opacity: 0, transform: 'scale(.9)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 200, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
        }
        if (t.n !== g.count) {
          const grew = g.count > t.n && t.n > 0;
          t.n = g.count;
          setText(t.count, g.count > 1 ? `×${g.count}` : '');
          if (grew) pop(t.count, 1.25, 220);
        }
      }
      setClass(queueEmpty, 'is-hidden', gs.length > 0);
    }
    // live progress: only the head job runs
    const head = sim.craftQueue[0];
    for (const [id, t] of tiles) {
      const p = head && gs[0]?.id === id ? Math.min(1, head.t / head.time) : 0;
      setVar(t.bar, '--p', p.toFixed(3));
    }
  }

  // ---------- open / close ----------
  let open = false;
  // The controls card shares the right edge: tuck it away while open if the two would touch.
  function tuckHints() {
    // the panel is scaled by hud.scale from its top-right corner
    const clash = open && panel.offsetTop + panel.offsetHeight * (hud.scale || 1) + 12 > (hud.hints?.top?.() ?? Infinity);
    hud.hints?.tuck?.('craft', clash);
  }
  function sync() {
    const want = ui.panel?.type === 'craft';
    if (want === open) return;
    open = want;
    setClass(panel, 'is-open', open);
    panel.setAttribute('aria-hidden', String(!open));
    if (open) { paintCards(); paintQueue(); } else { sheet?.reset(); hold = null; }
    tuckHints();
  }
  events.on('ui:panel', sync);
  events.on('craft:queued', ({ recipe }) => { const c = cardOf(recipe); if (c && open) pop(c.iconWrap, 1.12, 200); });
  sync();

  let flash = null, flashT = 0;
  return {
    update(dt) {
      sync();
      if (flash && (flashT -= dt) <= 0) { setClass(flash.el, 'is-flash', false); flash = null; }
      if (!open) return;
      if (hold && (hold.t += dt) >= HOLD) { swallow = hold.rid; craft(hold.rid, 5); hold = null; }
      paintCards();
      paintQueue();
    },
    // Outline the recipe that makes `itemId` for a moment (e.g. after picking an empty hotbar slot).
    highlight(itemId) {
      const c = cards.find(k => Object.keys(RECIPES[k.rid].outputs)[0] === itemId);
      if (!c || !open) return;
      if (flash) setClass(flash.el, 'is-flash', false);
      flash = c; flashT = mobile ? 1.4 : 0.6; // the sheet is still sliding up on a phone
      setClass(c.el, 'is-flash', true);
    },
    resize: tuckHints,
    get open() { return open; },
  };
}
