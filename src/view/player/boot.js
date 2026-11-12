// Boot-up intro (camp mode, a fresh start at camp level 0): the robot starts powered down, slumped forward with
// a dark visor and a dead bulb. The visor flickers on, it looks around, straightens into a big stretch with the
// arms up, does a little hop, and control unlocks at BOOT_T. Pure function of time, so it is deterministic and
// frame-rate independent; player.js layers the result onto its normal pose.
import { ease, clamp, arc } from '../../util/anim.js';

export const BOOT_T = 2.2;     // control unlocks here
export const BOOT_END = 2.55;  // the happy face and the last settling finish here

const seg = (t, a, b) => clamp((t - a) / (b - a));

// Flicker pattern for the visor: [start, end] windows when the screen is lit before it stays on.
const FLICKS = [[0.42, 0.5], [0.58, 0.63], [0.7, 0.74]];
const ON_AT = 0.8;

const out = { power: 0, bulb: 0, slump: 1, stretch: 0, armsUp: 0, armsLimp: 1, droop: 1, hop: 0, happy: 0, lookX: 0, lookY: 0, open: 1, landKick: false, wide: 0 };

// Returns the boot pose at time t (s). `power` 0..1 visor + glows; `slump` 0..1 forward slump; `stretch`
// extra squash-y (+ taller); `armsUp` 0..1 arms over the head; `armsLimp` 0..1 hanging limp; `droop` antenna
// droop; `hop` metres in the air; face overrides (happy, lookX, lookY, open, wide).
export function bootPose(t) {
  const o = out;
  // --- power: dark, three flickers, then on (with a soft ramp so it reads as warming up) ---
  let p = 0;
  for (const [a, b] of FLICKS) if (t >= a && t < b) p = 0.75;
  if (t >= ON_AT) p = 0.55 + 0.45 * ease.cubicOut(seg(t, ON_AT, ON_AT + 0.25));
  o.power = p;
  o.bulb = t < 0.55 ? 0 : t < 0.62 ? 0.6 : t < 0.88 ? 0.15 : ease.cubicOut(seg(t, 0.88, 1.05));
  // --- body: slumped until the screen is on, then straightens into a stretch ---
  const up = ease.cubicInOut(seg(t, 0.95, 1.35));
  o.slump = 1 - up;
  o.armsLimp = 1 - ease.quadOut(seg(t, 0.9, 1.15));
  o.droop = 1 - ease.cubicOut(seg(t, 0.9, 1.2));
  // stretch: rises tall with the arms overhead (1.2 .. 1.6), then relaxes into a crouch for the hop
  const st = ease.sineInOut(seg(t, 1.15, 1.45)) * (1 - ease.sineInOut(seg(t, 1.55, 1.72)));
  o.armsUp = ease.cubicOut(seg(t, 1.12, 1.4)) * (1 - ease.cubicInOut(seg(t, 1.58, 1.82)));
  const crouch = Math.sin(Math.PI * seg(t, 1.66, 1.8));
  const air = seg(t, 1.8, 2.12);
  o.stretch = 0.13 * st - 0.13 * crouch + 0.1 * Math.sin(Math.PI * Math.min(1, air * 1.4)) * (air > 0 && air < 1 ? 1 : 0);
  o.hop = air > 0 && air < 1 ? 0.17 * arc(air) : 0;
  o.landKick = false;
  // --- face: eyes half-open when the screen comes on, a look left / right, then ^ ^ for the hop ---
  o.open = t < ON_AT ? 0.25 : 0.35 + 0.65 * ease.cubicOut(seg(t, ON_AT, ON_AT + 0.18));
  o.lookX = t < 0.85 ? 0 : t < 1.05 ? -0.7 * ease.cubicOut(seg(t, 0.85, 0.95)) : t < 1.2 ? -0.7 + 1.4 * ease.cubicInOut(seg(t, 1.05, 1.15)) : 0.7 * (1 - ease.cubicOut(seg(t, 1.2, 1.32)));
  o.lookY = t < 1.2 ? 0 : 0.35 * st;
  o.wide = t > 0.85 && t < 1.25 ? 0.9 : 0;
  o.happy = t >= 1.4 && t < BOOT_END ? 1 : 0;
  return o;
}
