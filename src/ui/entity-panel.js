// Chest / workshop panel, shown when ui.panel = { type: 'chest' | 'workshop', id }.
// Desktop: floats beside the entity on screen (projected through ctx.camera every frame, clamped to the
// viewport) with a notch pointing at it; glides to the other side when it runs out of room.
// Mobile: a bottom sheet behind the hotbar (no projection, no notch), dismissed by the x, the scrim or the grip.
import { h, setText, setClass, setVar, pop, shake, svg, fmt, reduceMotion, EASE_OUT } from './dom.js';
import { clamp, damp, lerp } from '../util/anim.js';
import { makeSheet } from './sheet.js';

const GAP = 64;          // px between the entity centre and the panel edge
const MARGIN = 14;       // viewport margin
const FAR = 2.5;         // close once the player walks this much further away than when it opened (or useReach)

export function createEntityPanel(hud) {
  const { ctx, icons, layer, mobile } = hud;
  const { THREE, config, ui, events, sim } = ctx;
  const { RECIPES, MACHINE_RECIPES, BUILDINGS, PLAYER } = config;

  const body = h('div', { class: 'ent-body' });
  const title = h('h2');
  const meta = h('span', { class: 'ent-meta' });
  const close = h('button', { class: 'x', type: 'button', tabindex: -1, 'aria-label': 'Close', html: svg.close, onclick: () => hud.setPanel(null) });
  const notch = h('span', { class: 'notch', 'aria-hidden': 'true' });
  const card = h('section', { class: 'panel ent hit', role: 'dialog', 'aria-hidden': 'true' },
    notch, h('header', { class: 'panel-head' }, title, meta, close), body);
  const wrap = h('div', { class: 'ent-wrap' }, card);
  layer.append(wrap);
  const sheet = mobile ? makeSheet(card, () => hud.setPanel(null)) : null;

  let cur = null;        // { type, id, view, closeDist }
  let side = 0, sideInit = false; // 0 = panel right of the entity, 1 = left
  let tucking = false;   // we asked the controls card to step aside
  let pw = 260, ph = 200;
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { pw = card.offsetWidth; ph = card.offsetHeight; }) : null;
  ro?.observe(card);

  // ---------- chest ----------
  function chestView(e) {
    const grid = h('div', { class: 'slots' });
    const empty = h('div', { class: 'slots-empty' }, 'Empty. Belt items in, or drop some off.');
    const fill = h('i');
    const meter = h('span', { class: 'meter' }, fill);
    const take = h('button', { class: 'btn btn-accent', type: 'button', tabindex: -1, onclick: () => {
      const got = sim.takeChest(e.id);
      if (!got) shake(take); else pop(take, 1.06, 200);
    } }, 'Take all');
    body.replaceChildren(h('div', { class: 'cap-row' }, meter), grid, empty, h('div', { class: 'btn-row' }, take));
    const cells = new Map(); // item -> { el, count, n }
    let sig = null;
    return {
      update(ent) {
        const cap = BUILDINGS.chest.capacity;
        setText(meta, `${ent.total} / ${cap}`);
        setVar(fill, '--p', (ent.total / cap).toFixed(3));
        setClass(take, 'is-disabled', !ent.total);
        const s = JSON.stringify(ent.items);
        if (s === sig) return;
        sig = s;
        const order = Object.keys(config.ITEMS).filter(k => ent.items[k] > 0);
        for (const [k, c] of cells) if (!order.includes(k)) { c.el.remove(); cells.delete(k); }
        order.forEach((k, i) => {
          let c = cells.get(k);
          if (!c) {
            c = { count: h('b'), n: 0 };
            c.el = h('div', { class: 'cell', 'data-tip': hud.itemName(k) }, icons.img(k), c.count);
            cells.set(k, c);
            c.el.animate?.([{ opacity: 0, transform: 'scale(.9)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 200, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
          }
          if (grid.children[i] !== c.el) grid.insertBefore(c.el, grid.children[i] || null);
          const n = ent.items[k];
          if (c.n !== n) { const up = n > c.n && c.n > 0; c.n = n; setText(c.count, fmt(n)); if (up) pop(c.count, 1.25, 200); }
        });
        setClass(empty, 'is-hidden', order.length > 0);
        setClass(grid, 'is-hidden', order.length === 0);
      },
    };
  }

  // ---------- workshop ----------
  function workshopView(e) {
    const picks = MACHINE_RECIPES.map(rid => {
      const r = RECIPES[rid];
      const out = Object.keys(r.outputs)[0];
      const el = h('button', { class: 'pick', type: 'button', tabindex: -1, 'aria-label': `Make ${r.name}`,
        onclick: () => { if (sim.setRecipe(e.id, rid)) pop(el, 1.05, 180); } },
        icons.img(out), h('span', null, r.name));
      return { rid, el };
    });
    const inputs = h('div', { class: 'io-chips' });
    const outCount = h('b');
    const outIcon = h('span', { class: 'io-out-icon' });
    const outChip = h('div', { class: 'chip chip-out' }, outIcon, outCount);
    const fill = h('i');
    const bar = h('span', { class: 'bar' }, fill);
    const status = h('span', { class: 'status' });
    const feed = h('button', { class: 'btn', type: 'button', tabindex: -1, onclick: () => {
      const n = sim.feedWorkshop(e.id);
      if (!n) { shake(feed); hud.toast(e.recipe ? 'Nothing in your bag to feed it' : 'Pick a recipe first', 'warn'); } else pop(feed, 1.06, 200);
    } }, 'Feed from bag');
    const take = h('button', { class: 'btn btn-accent', type: 'button', tabindex: -1, onclick: () => {
      const got = sim.takeWorkshop(e.id);
      if (!got || !Object.values(got).some(Boolean)) shake(take); else pop(take, 1.06, 200);
    } }, 'Take output');
    const ioRow = h('div', { class: 'io' },
      h('div', { class: 'io-col' }, h('span', { class: 'io-label' }, 'In'), inputs),
      h('span', { class: 'io-arrow', html: svg.arrow }),
      h('div', { class: 'io-col io-col-out' }, h('span', { class: 'io-label' }, 'Out'), outChip));
    const work = h('div', { class: 'work' }, ioRow, h('div', { class: 'bar-row' }, bar, status));
    const hint = h('div', { class: 'pick-hint' }, 'Pick what this workshop makes');
    body.replaceChildren(h('div', { class: 'picks' }, picks.map(p => p.el)), hint, work, h('div', { class: 'btn-row' }, feed, take));

    let recipe, chips = [];
    return {
      update(ent) {
        if (recipe !== ent.recipe) {
          recipe = ent.recipe;
          picks.forEach(p => setClass(p.el, 'is-on', p.rid === recipe));
          setClass(hint, 'is-hidden', !!recipe);
          setClass(work, 'is-off', !recipe);
          const r = recipe && RECIPES[recipe];
          chips = r ? Object.entries(r.inputs).map(([item, need]) => {
            const n = h('b');
            const el = h('div', { class: 'chip', 'data-tip': `${hud.itemName(item)} · ${need} per batch` }, icons.img(item), n);
            return { item, need, el, n, have: -1 };
          }) : [];
          inputs.replaceChildren(...(chips.length ? chips.map(c => c.el) : [h('div', { class: 'chip chip-ghost' }, '–')]));
          const out = r ? Object.keys(r.outputs)[0] : null;
          outIcon.replaceChildren(out ? icons.img(out) : '');
          setClass(outChip, 'chip-ghost', !out);
        }
        const r = recipe && RECIPES[recipe];
        for (const c of chips) {
          const have = ent.input[c.item] || 0;
          if (have !== c.have) { const up = have > c.have && c.have >= 0; c.have = have; setText(c.n, String(have)); if (up) pop(c.el, 1.12, 200); }
          setClass(c.el, 'is-low', have < c.need && !ent.crafting);
        }
        const outN = Object.values(ent.output).reduce((a, b) => a + b, 0);
        if (outCount.__n !== outN) { const up = outN > (outCount.__n ?? outN); outCount.__n = outN; setText(outCount, String(outN)); if (up) pop(outChip, 1.12, 200); }
        setVar(fill, '--p', (ent.crafting ? ent.progress : 0).toFixed(3));
        setClass(bar, 'is-on', !!ent.crafting);
        let s = '';
        if (!r) s = 'Idle';
        else if (ent.crafting) s = 'Working';
        else if (outN >= BUILDINGS.workshop.outputBuffer) s = 'Output full';
        else {
          const miss = Object.entries(r.inputs).find(([k, n]) => (ent.input[k] || 0) < n);
          s = miss ? `Needs ${hud.itemName(miss[0]).toLowerCase()}` : 'Ready';
        }
        setText(status, s);
        setClass(status, 'is-warn', s.startsWith('Needs') || s === 'Output full');
        const canFeed = !!r && Object.entries(r.inputs).some(([k, n]) => Math.min(n * 2 - (ent.input[k] || 0), sim.inventory.get(k)) > 0);
        setClass(feed, 'is-disabled', !canFeed);
        setClass(take, 'is-disabled', outN <= 0);
      },
    };
  }

  // ---------- open / close ----------
  function openFor(panel) {
    const e = sim.entities.get(panel.id);
    if (!e || (e.kind !== 'chest' && e.kind !== 'workshop')) { hud.setPanel(null); return; }
    const switching = !!cur; // already open on another entity: soft crossfade instead of a cold swap
    if (switching && !reduceMotion()) {
      card.animate?.([{ opacity: 0.4, transform: 'scale(0.97)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 200, easing: EASE_OUT });
    }
    const openDist = Math.hypot(sim.player.x - e.x, sim.player.z - e.z);
    cur = { type: e.kind, id: e.id, view: e.kind === 'chest' ? chestView(e) : workshopView(e),
      closeDist: Math.max(openDist, PLAYER?.useReach ?? PLAYER?.reach ?? 3.5) + FAR };
    setText(title, e.kind === 'chest' ? 'Chest' : 'Workshop');
    setText(meta, '');
    card.dataset.kind = e.kind;
    cur.view.update(e);
    pw = card.offsetWidth; ph = card.offsetHeight;
    sideInit = false;
    place(0);
    setClass(card, 'is-open', true);
    card.setAttribute('aria-hidden', 'false');
  }
  function closeView() {
    if (!cur) return;
    cur = null;
    if (tucking) { tucking = false; hud.hints?.tuck?.('panel', false); }
    sheet?.reset();
    setClass(card, 'is-open', false);
    card.setAttribute('aria-hidden', 'true');
  }
  function sync() {
    const p = ui.panel;
    const want = p && (p.type === 'chest' || p.type === 'workshop') ? p : null;
    if (!want) { closeView(); return; }
    if (cur && cur.id === want.id) return;
    openFor(want);
  }
  events.on('ui:panel', sync);
  events.on('build:removed', ({ entity }) => { if (cur && entity?.id === cur.id) hud.setPanel(null); });

  // ---------- anchoring ----------
  const v = new THREE.Vector3();
  // pw / ph are layout px; the wrap is scaled by hud.scale from its top-left, so visual size = layout * s.
  function place(dt) {
    if (mobile) return; // a bottom sheet: CSS places it
    const e = cur && sim.entities.get(cur.id);
    if (!e) return;
    const W = innerWidth, H = innerHeight;
    const s = hud.scale || 1, vw = pw * s, vh = ph * s;
    ctx.camera.updateMatrixWorld(); // this frame's camera (it moved in camera.update), so the panel never trails it
    v.set(e.x, 0.5, e.z).project(ctx.camera);
    const sx = (v.x * 0.5 + 0.5) * W, sy = (-v.y * 0.5 + 0.5) * H;
    const want = sx + GAP * s + vw + MARGIN <= W ? 0 : 1;
    if (!sideInit) { side = want; sideInit = true; } else side = damp(side, want, 12, dt);
    let x = lerp(sx + GAP * s, sx - GAP * s - vw, side);
    const bottom = Math.min(H, hud.bottomLimit()) - 12;
    let y = sy - vh * 0.42;
    x = clamp(x, MARGIN, Math.max(MARGIN, W - vw - MARGIN));
    y = clamp(y, MARGIN, Math.max(MARGIN, bottom - vh));
    wrap.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)${s !== 1 ? ` scale(${s})` : ''}`;
    // the controls card steps aside while we touch it (24px of hysteresis so it doesn't flicker)
    const hr = hud.hints?.rect?.();
    if (hr) {
      const m = tucking ? 24 : 6;
      const hit = x < hr.right + m && x + vw > hr.left - m && y < hr.bottom + m && y + vh > hr.top - m;
      if (hit !== tucking) { tucking = hit; hud.hints.tuck('panel', hit); }
    }
    const flip = side > 0.5;
    setClass(card, 'is-flipped', flip);
    setVar(card, '--ny', `${clamp((sy - y) / s, 22, ph - 22).toFixed(1)}px`);
  }

  return {
    update(dt) {
      sync();
      if (!cur) return;
      const e = sim.entities.get(cur.id);
      if (!e) { hud.setPanel(null); return; }
      if (Math.hypot(sim.player.x - e.x, sim.player.z - e.z) > cur.closeDist) { hud.setPanel(null); return; }
      cur.view.update(e);
      place(dt);
    },
    resize() { if (cur) { pw = card.offsetWidth; ph = card.offsetHeight; } },
  };
}
