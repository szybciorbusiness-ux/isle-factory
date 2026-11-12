// Animation toolkit. EVERYTHING animated in the game is driven by dt passed from the main loop
// (never performance.now / Date), so __game.step(n) and pausing stay deterministic.

// ---------- Easing ----------
export const ease = {
  linear: t => t,
  quadIn: t => t * t,
  quadOut: t => 1 - (1 - t) * (1 - t),
  quadInOut: t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  cubicIn: t => t * t * t,
  cubicOut: t => 1 - Math.pow(1 - t, 3),
  cubicInOut: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  quartOut: t => 1 - Math.pow(1 - t, 4),
  quintOut: t => 1 - Math.pow(1 - t, 5),
  expoOut: t => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  sineInOut: t => -(Math.cos(Math.PI * t) - 1) / 2,
  sineOut: t => Math.sin((t * Math.PI) / 2),
  backOut: (t, s = 1.70158) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2),
  backIn: (t, s = 1.70158) => (s + 1) * t * t * t - s * t * t,
  elasticOut: t => (t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
  bounceOut: t => {
    const n = 7.5625, d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  },
};

export const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => clamp((v - a) / (b - a));
export const remap = (v, a, b, c, d) => lerp(c, d, invLerp(a, b, v));
// Shortest signed angle difference b - a in (-PI, PI].
export const angleDelta = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d <= -Math.PI) d += Math.PI * 2; return d; };
// Frame-rate independent exponential smoothing. lambda ~ 8-20 for snappy follow.
export const damp = (current, target, lambda, dt) => lerp(current, target, 1 - Math.exp(-lambda * dt));
export const dampAngle = (current, target, lambda, dt) => current + angleDelta(current, target) * (1 - Math.exp(-lambda * dt));
// Parabolic arc 0 -> 1 -> 0 for t in [0,1].
export const arc = t => 4 * t * (1 - t);

// ---------- Springs ----------
// Semi-implicit damped spring on a scalar. stiffness ~ 120-400, damping ~ 10-30.
// Underdamped (low damping) gives the soft overshoot "jelly" feel used for squash & stretch.
export class Spring {
  constructor(value = 0, { stiffness = 220, damping = 18, target = value } = {}) {
    this.value = value; this.target = target; this.velocity = 0; this.stiffness = stiffness; this.damping = damping;
  }
  update(dt) {
    // sub-step for stability at large dt
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const a = (this.target - this.value) * this.stiffness - this.velocity * this.damping;
      this.velocity += a * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }
  kick(v) { this.velocity += v; return this; }
  set(v) { this.value = v; this.target = v; this.velocity = 0; return this; }
  get settled() { return Math.abs(this.velocity) < 1e-3 && Math.abs(this.target - this.value) < 1e-3; }
}

// ---------- Tweens ----------
// tween({ duration, delay, ease, onUpdate(k, t), onComplete }) -> handle with .cancel()
// k is the eased progress 0..1. Managed by the global manager below, ticked from main.js.
const active = new Set();
export function tween({ duration = 0.3, delay = 0, ease: e = ease.cubicOut, onUpdate, onComplete } = {}) {
  const h = { t: -delay, duration, e, onUpdate, onComplete, done: false, cancel() { this.done = true; active.delete(this); } };
  active.add(h);
  if (delay <= 0 && onUpdate) onUpdate(e(0), 0);
  return h;
}
// Run fn after `seconds` of game time.
export function after(seconds, fn) { return tween({ duration: 0, delay: seconds, onComplete: fn }); }
export function update(dt) {
  for (const h of [...active]) {
    if (h.done) continue;
    h.t += dt;
    if (h.t < 0) continue;
    const raw = h.duration > 0 ? clamp(h.t / h.duration) : 1;
    h.onUpdate?.(h.e(raw), raw);
    if (raw >= 1) { h.done = true; active.delete(h); h.onComplete?.(); }
  }
}
export const activeTweens = () => active.size;

// ---------- Decaying shake ----------
// Damped oscillation: amplitude decays exponentially. sample(t) -> offset.
export class Wobble {
  constructor({ freq = 9, decay = 6 } = {}) { this.freq = freq; this.decay = decay; this.amp = 0; this.t = 0; }
  hit(amp) { this.amp = amp; this.t = 0; }
  update(dt) { this.t += dt; return this.value; }
  get value() { return this.amp * Math.exp(-this.decay * this.t) * Math.sin(this.t * this.freq * Math.PI * 2); }
}
