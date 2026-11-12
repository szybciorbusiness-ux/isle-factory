// Mobile bottom sheets (crafting, chest, workshop). CSS owns the slide (ui.css "bottom sheets": 450 ms on the
// iOS drawer curve). This adds the grip and drag-to-dismiss: pull the grip / header down past a quarter of the
// sheet, or flick faster than 0.11 px/ms (Emil / Vaul numbers), and it closes; pulled up it rubber-bands.
// Release always hands the transform back to CSS, so the settle or the exit continues from the finger.
import { h } from './dom.js';

const FLICK = 0.11;     // px/ms, swipe distance / time
const MIN_FLICK = 14;   // px: a tap on the header never counts as a flick
const SHARE = 0.25;     // fraction of the sheet height that dismisses on a slow drag

export function makeSheet(sheet, onDismiss) {
  const grip = h('span', { class: 'sheet-grip', 'aria-hidden': 'true' });
  sheet.classList.add('sheet');
  sheet.prepend(grip);

  let id = null, y0 = 0, t0 = 0, dy = 0, target = null;
  const down = e => {
    if (id != null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (e.target instanceof Element && e.target.closest('button')) return; // the x stays a button
    if (!sheet.classList.contains('is-open')) return;
    id = e.pointerId; y0 = e.clientY; t0 = e.timeStamp; dy = 0;
    target = e.currentTarget;
    try { target.setPointerCapture(id); } catch { /* synthetic events */ }
  };
  const move = e => {
    if (e.pointerId !== id) return;
    const raw = e.clientY - y0;
    if (!sheet.classList.contains('is-dragging')) {
      if (Math.abs(raw) < 4) return; // a tap stays a tap
      sheet.classList.add('is-dragging');
    }
    // down follows the finger 1:1; up resists (the sheet is already as tall as it gets)
    dy = raw >= 0 ? raw : -6 * Math.log1p(-raw / 6);
    sheet.style.transform = `translate3d(0, ${dy.toFixed(1)}px, 0)`;
  };
  const up = e => {
    if (e.pointerId !== id) return;
    id = null;
    try { target?.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    const dragging = sheet.classList.contains('is-dragging');
    const speed = dy / Math.max(1, e.timeStamp - t0);
    const dismiss = dragging && e.type === 'pointerup' && (dy > sheet.offsetHeight * SHARE || (dy > MIN_FLICK && speed > FLICK));
    // same frame: transition back on + inline transform cleared, so CSS animates from where the finger let go
    sheet.classList.remove('is-dragging');
    sheet.style.transform = '';
    dy = 0;
    if (dismiss) onDismiss();
  };

  const zones = [grip, ...sheet.querySelectorAll(':scope > .panel-head')];
  for (const z of zones) {
    z.classList.add('sheet-drag');
    z.addEventListener('pointerdown', down);
    z.addEventListener('pointermove', move);
    z.addEventListener('pointerup', up);
    z.addEventListener('pointercancel', up);
  }
  return {
    // cancel a drag in flight (panel closed by something else)
    reset() { if (id != null) { id = null; sheet.classList.remove('is-dragging'); sheet.style.transform = ''; } },
  };
}
