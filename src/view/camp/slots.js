// Appear / disappear curves shared by the camp view (DESIGN.md: nothing pops).
// popScale(on, t): appearing grows from 0.6 with a backOut overshoot; disappearing anticipates (a tiny grow)
// then shrinks with easeIn. createSlots(n): per-slot on/off timers for small item buffers (input racks).
import { ease } from '../../util/anim.js';

export function popScale(on, t, inDur = 0.3, outDur = 0.18) {
  if (t < 0) return on ? 0 : 1;
  if (on) return t < inDur ? 0.6 + 0.4 * ease.backOut(t / inDur, 2.2) : 1;
  if (t >= outDur) return 0;
  const k = t / outDur;
  return k < 0.3 ? 1 + 0.08 * (k / 0.3) : 1.08 * (1 - ease.cubicIn((k - 0.3) / 0.7));
}

export function createSlots(n) {
  const on = new Array(n).fill(false), t = new Array(n).fill(10);
  return {
    set(count, dt) {
      for (let i = 0; i < n; i++) {
        t[i] += dt;
        const want = i < count;
        if (want !== on[i]) { on[i] = want; t[i] = 0; }
      }
    },
    // hide a slot at once (its item just left by another animation, e.g. a hop)
    kill(i) { if (i >= 0 && i < n) { on[i] = false; t[i] = 10; } },
    forEach(fn) { for (let i = 0; i < n; i++) { const s = popScale(on[i], t[i]); if (s > 0.01) fn(i, s); } },
  };
}
