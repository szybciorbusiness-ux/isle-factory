// "Your camp is complete" card (camp:complete, after the level-5 ribbon): a warm sticker card that sums up the camp
// (time played, islands opened, workers, camp level) with one friendly line and a "Keep playing" button. It can be
// dismissed with the button, a tap / click anywhere else, Escape or Enter, or by walking off once it has been read.
// On the way out it shrinks into the camp badge, which then wears its "Camp complete" state (camp-hud.js).
// Every transform / opacity is written from update(dt); the stats' numerals count up as they pop in.
import { h, easeOut, easeInOut, reduceMotion, ol, setOl, tf, op, clamp01 } from './dom.js';
import { glyph, ROLE_HAT } from './camp-glyphs.js';

const ENTER = 0.32, LEAVE = 0.42, STAT0 = 0.28, STAT_STAGGER = 0.09, COUNT_T = 0.6;
const WALK_DISMISS = 2.6; // s before walking away closes it

export function createCompleteCard(hud, { badgeEl, onClosed }) {
  const { ctx, layer } = hud;
  const { camp, views } = ctx;
  const { Spring } = ctx.anim;

  const stat = (icon, cls) => {
    const num = ol('0', 'cc-num');
    const label = h('span', { class: 'cc-label' });
    const el = h('div', { class: `cc-stat ${cls}` }, h('span', { class: 'cc-stat-icon', html: icon }), h('span', { class: 'cc-stat-text' }, num, label));
    return { el, num, label, value: 0, s: new Spring(0.6, { stiffness: 420, damping: 20 }) };
  };
  const stats = [
    stat(glyph('clock'), 'cc-time'),
    stat(glyph('island'), 'cc-isles'),
    stat(glyph('worker', ROLE_HAT.lumberjack), 'cc-workers'),
    stat(glyph('flameLight'), 'cc-level'),
  ];
  const btn = h('button', { class: 'cc-btn hit', type: 'button', tabindex: -1 }, 'Keep playing');
  const medal = h('span', { class: 'cc-medal', html: glyph('star') });
  const card = h('div', { class: 'cc-card hit' },
    medal,
    h('div', { class: 'cc-title' }, 'Your camp is complete'),
    h('div', { class: 'cc-line' }, 'The isle hums along on its own now.'),
    h('div', { class: 'cc-stats' }, stats.map(s => s.el)),
    btn);
  const root = h('div', { class: 'cc', role: 'dialog', 'aria-label': 'Your camp is complete', 'aria-hidden': 'true' }, card);
  root.style.visibility = 'hidden';
  layer.append(root);

  const pop = new Spring(0.9, { stiffness: 380, damping: 20 });
  const medalS = new Spring(0.5, { stiffness: 360, damping: 13 });
  let state = null; // { t, out: -1 | s since leaving, to: {x, y} }

  function fillStats() {
    const mins = Math.max(1, Math.round((camp.time || 0) / 60));
    const isles = camp.bridges?.size ?? 0;
    const workers = camp.workers?.size ?? 0;
    const vals = [
      [mins >= 120 ? Math.round(mins / 60) : mins, mins >= 120 ? 'hours played' : mins === 1 ? 'minute played' : 'minutes played'],
      [isles, isles === 1 ? 'island opened' : 'islands opened'],
      [workers, workers === 1 ? 'worker hired' : 'workers hired'],
      [camp.level, 'camp levels'],
    ];
    vals.forEach(([v, label], i) => { stats[i].value = v; stats[i].label.textContent = label; setOl(stats[i].num, '0'); });
  }

  function open() {
    if (state) return;
    fillStats();
    state = { t: 0, out: -1 };
    pop.value = 0.9; pop.velocity = 0; pop.target = 1;
    medalS.value = 0.5; medalS.velocity = 0; medalS.target = 1;
    for (const s of stats) { s.s.value = 0.6; s.s.velocity = 0; op(s.el, 0); }
    root.style.visibility = 'visible'; op(root, 0);
    root.setAttribute('aria-hidden', 'false');
  }
  function close() {
    if (!state || state.out >= 0) return;
    state.out = 0;
    // fly into the badge
    const r = card.getBoundingClientRect(), b = badgeEl.getBoundingClientRect();
    state.to = { x: b.left + b.width / 2 - (r.left + r.width / 2), y: b.top + b.height / 2 - (r.top + r.height / 2) };
    root.setAttribute('aria-hidden', 'true');
  }

  btn.addEventListener('click', e => { e.stopPropagation(); close(); });
  addEventListener('pointerdown', e => { if (state && state.out < 0 && state.t > 0.4 && !card.contains(e.target)) close(); }, true);
  addEventListener('keydown', e => { if (state && state.out < 0 && state.t > 0.4 && (e.code === 'Escape' || e.code === 'Enter')) { e.preventDefault(); close(); } });

  function update(dt) {
    if (!state) return;
    const red = reduceMotion();
    state.t += dt;
    const t = state.t;
    if (state.out < 0 && t > WALK_DISMISS && views.player?.moving) close();
    let x = 0, y = 0, s, a;
    if (state.out >= 0) {
      state.out += dt;
      const k = clamp01(state.out / LEAVE);
      if (k >= 1) {
        state = null;
        root.style.visibility = 'hidden';
        onClosed?.();
        return;
      }
      const km = easeInOut(k);
      x = (state.to?.x || 0) * (red ? 0 : km); y = (state.to?.y || 0) * (red ? 0 : km);
      s = red ? 1 : 1 - 0.85 * km;
      a = 1 - clamp01((k - 0.45) / 0.55);
    } else {
      const kIn = easeOut(clamp01(t / ENTER));
      s = red ? 1 : pop.update(dt);
      y = red ? 0 : (1 - kIn) * 14;
      a = clamp01(t / 0.16);
    }
    op(root, a);
    tf(card, `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) scale(${s.toFixed(4)})`);
    const ms = red ? 1 : medalS.update(dt);
    tf(medal, `translateX(-50%) rotate(${(red ? 0 : Math.sin(t * 2.2) * 5).toFixed(2)}deg) scale(${ms.toFixed(4)})`);
    // stats pop in one by one; their numerals count up
    stats.forEach((st, i) => {
      const t0 = STAT0 + i * STAT_STAGGER;
      if (t < t0) { op(st.el, 0); return; }
      st.s.target = 1;
      const ss = red ? 1 : st.s.update(dt);
      op(st.el, clamp01((t - t0) / 0.12));
      tf(st.el, `scale(${ss.toFixed(4)})`);
      const kc = red ? 1 : easeOut(clamp01((t - t0) / COUNT_T));
      setOl(st.num, String(Math.round(st.value * kc)));
    });
  }

  return {
    update,
    open,
    close,
    get isOpen() { return !!state && state.out < 0; },
    get shown() { return !!state; },
    rect() { return state ? card.getBoundingClientRect() : null; },
  };
}
