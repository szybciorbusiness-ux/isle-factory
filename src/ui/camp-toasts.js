// Camp toasts (UI-STYLE.md): small sticker pills that slide down from the top centre (under the level badge
// on phones), the glyph breaking out of the pill's left edge, newest at the bottom, at most two, deduplicated
// (×2). Everything moves from update(dt) so __game.step / pausing stay exact: enter = slide down from above +
// spring scale from .9 with a small overshoot, exit = fade + lift + scale .94 (180 ms ease-out), and the rows
// glide into their new slots when one leaves. Also shows the generic 'toast' bus events in camp mode.
import { h, setText, easeOut, reduceMotion } from './dom.js';
import { glyph } from './camp-glyphs.js';

const LIFE = { info: 2.6, good: 2.8, warn: 2.8, celebrate: 4.4 };
const ENTER = 0.26, EXIT = 0.18;
const MAX = 2;
const GAP = 8;
const STAGGER = 0.24; // s between queued toasts landing

export function createCampToasts(hud) {
  const { ctx, layer } = hud;
  const anim = ctx.anim;
  const box = h('div', { class: 'ctoasts', role: 'status', 'aria-live': 'polite' });
  layer.append(box);
  const live = [];    // { el, badge, key, kind, t, life, n, y, ht, out, outT, s }
  const queue = [];   // waits while the level-up ribbon is up
  let blocked = false;
  let wait = 0;

  // o: { text, strong?, kind? 'info'|'good'|'warn'|'celebrate', icon? (glyph name), iconArgs?, img? (item id) }
  function make(o) {
    const kind = o.kind || 'info';
    const iconHtml = o.icon ? glyph(o.icon, ...(o.iconArgs || [])) : null;
    const icon = o.img
      ? h('span', { class: 'ct-icon ct-icon-img' }, hud.icons.img(o.img))
      : iconHtml ? h('span', { class: 'ct-icon', html: iconHtml }) : h('span', { class: 'ct-dot' });
    const badge = h('span', { class: 'ct-n' });
    const pill = h('div', { class: `ct ct-${kind}${o.img || iconHtml ? ' has-icon' : ''}` }, icon, h('span', { class: 'ct-text' }, o.text, o.strong ? h('b', null, o.strong) : null), badge);
    const el = h('div', { class: 'ct-row' }, pill);
    el.style.opacity = '0';
    box.append(el);
    const t = {
      el, badge, key: `${o.text}|${o.strong || ''}`, kind, t: 0, life: LIFE[kind] ?? LIFE.info, n: 1, y: null,
      ht: el.offsetHeight || 46, out: false, outT: 0, s: new anim.Spring(0.9, { stiffness: 420, damping: 24, target: 1 }),
    };
    live.push(t);
    const staying = live.filter(x => !x.out);
    if (staying.length > MAX) leave(staying[0]); // too many: the oldest makes room
    return t;
  }
  function leave(t) { if (!t.out) { t.out = true; t.outT = 0; } }

  function show(o = {}) {
    if (!o.text) return null;
    const key = `${o.text}|${o.strong || ''}`;
    const same = live.find(x => x.key === key && !x.out);
    if (same) {
      same.n++; same.t = Math.min(same.t, ENTER);
      if (!reduceMotion()) same.s.velocity += 1.4;
      setText(same.badge, `×${same.n}`);
      same.badge.classList.add('is-on');
      return same;
    }
    if ((blocked || queue.length) && o.kind !== 'warn') { queue.push(o); return null; }
    return make(o);
  }

  ctx.events.on('toast', ({ text, kind } = {}) => show({ text, kind: kind === 'warn' ? 'warn' : 'info' }));

  function update(dt) {
    if (!blocked && queue.length) {
      wait -= dt;
      if (wait <= 0) { make(queue.shift()); wait = STAGGER; }
    } else if (!queue.length) wait = 0;

    const reduced = reduceMotion();
    let y = 0;
    for (const t of [...live]) {
      t.t += dt;
      if (!t.out && t.t >= t.life) leave(t);
      if (t.out) t.outT += dt;
      if (t.out && t.outT >= EXIT) { t.el.remove(); live.splice(live.indexOf(t), 1); continue; }
      const kIn = easeOut(Math.min(1, t.t / ENTER));
      const kOut = t.out ? easeOut(Math.min(1, t.outT / EXIT)) : 0;
      // slot: rows below a leaving one close the gap while it fades
      t.y = t.y == null ? y : t.y + (y - t.y) * (1 - Math.exp(-16 * dt));
      y += (t.ht + GAP) * (1 - kOut);
      const slide = reduced ? 0 : (1 - kIn) * -26 + kOut * -8;
      const s = reduced ? 1 : t.s.update(dt) * (1 - 0.06 * kOut);
      t.el.style.opacity = (Math.min(1, t.t / 0.12) * (1 - kOut)).toFixed(3);
      t.el.style.transform = `translate3d(-50%, ${(t.y + slide).toFixed(2)}px, 0) scale(${s.toFixed(4)})`;
    }
  }

  return {
    show,
    update,
    // the level-up ribbon owns the top while it plays: toasts on screen bow out, new ones wait their turn
    block(on) {
      blocked = !!on;
      if (on) for (const t of live) if (t.kind !== 'warn') leave(t);
      else wait = Math.min(wait, 0.12);
    },
    get count() { return live.length; },
  };
}
