// Toasts, top centre, from 'toast' events. Stacked (newest at the bottom), deduplicated, auto-dismissed on
// game time. Leaving toasts collapse their row height so the stack closes up smoothly.
import { h, setText, pop, shake } from './dom.js';

const LIFE = 2.2;   // s
const MAX = 3;

export function createToasts(hud) {
  const { ctx, layer } = hud;
  const stack = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
  layer.append(stack);
  const live = []; // { el, text, kind, t, n, badge }

  function dismiss(tst) {
    const i = live.indexOf(tst);
    if (i >= 0) live.splice(i, 1);
    tst.el.classList.add('is-leaving');
    tst.el.addEventListener('transitionend', e => { if (e.target === tst.el && e.propertyName === 'grid-template-rows') tst.el.remove(); });
    setTimeout(() => tst.el.remove(), 400); // safety net if transitions are disabled
  }

  function show({ text, kind = 'info' } = {}) {
    if (!text) return;
    const same = live.find(x => x.text === text);
    if (same) {
      same.t = 0; same.n++;
      setText(same.badge, `×${same.n}`);
      same.badge.classList.add('is-on');
      if (kind === 'warn') shake(same.pill); else pop(same.pill, 1.04, 200);
      return;
    }
    const badge = h('span', { class: 'toast-n' });
    const pill = h('div', { class: `toast toast-${kind === 'warn' ? 'warn' : 'info'}` }, h('span', { class: 'toast-dot' }), h('span', null, text), badge);
    const el = h('div', { class: 'toast-row is-entering' }, h('div', { class: 'toast-clip' }, pill));
    stack.append(el);
    el.offsetWidth; // commit the collapsed state, then open
    el.classList.remove('is-entering');
    const tst = { el, pill, text, kind, t: 0, n: 1, badge };
    live.push(tst);
    while (live.length > MAX) dismiss(live[0]);
  }

  ctx.events.on('toast', show);

  return {
    show,
    update(dt) {
      for (const tst of [...live]) {
        tst.t += dt;
        if (tst.t >= LIFE + (tst.kind === 'warn' ? 0.3 : 0)) dismiss(tst);
      }
    },
  };
}
