// Where the first-time hint card sits around Dug (FIRST-20 playtest: a hint must NEVER cover the pad, plate or
// target it talks about). Candidate spots hug Dug on every side: under his feet and over his head (each slid
// left / right as far as the tail can still reach him) and beside his head. Each is clamped into the safe
// screen area and scored:
//   - facing the goal costs (the card goes on the side of Dug away from the goal's screen position)
//   - covering the target, the arrow, Dug himself, the stack counter, another pad's plate or the HUD costs
//     (area-weighted), so does being pushed far from Dug by the screen edge
//   - the spot in use gets a bonus (hysteresis: the card doesn't hop sides on every tiny move)
// Pure screen-space maths, no DOM.

const TAIL = 10;     // px from the card edge to the tail tip
const GAP = 7;       // px between the tail tip and Dug
const END = 6;       // px the tail keeps from where the pill's round end starts
const ICON_END = 40; // ...and from the left end, where the item icon breaks out of the card

export function overlap(a, b) {
  if (!a || !b) return 0;
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

// Spots: below / above Dug with the card slid by k (-1 .. 1, of the most the tail allows), or beside his head.
export const SPOTS = [
  ['below', 0], ['below', -0.5], ['below', 0.5], ['below', -1], ['below', 1],
  ['above', 0], ['above', -0.5], ['above', 0.5], ['above', -1], ['above', 1],
  ['left', 0], ['right', 0], ['side', 0],
];
const spotId = (side, k) => `${side}${k ? (k > 0 ? '+' : '-') + Math.abs(k) : ''}`;

// dug: { cx, top, bottom, hw } screen px (top = head / stack top, bottom = feet); card: { w, h, icon }
// Returns the card box (left, top) and its tail: edge 'top' | 'bottom' (tx = x along it) or 'right' (the
// pill's right end, tx = y), and the skew angle that points the tip at Dug.
export function spotFor(side, k, dug, card, bounds) {
  const { w, h } = card;
  const R = h / 2;
  const tMin = card.icon ? Math.max(R + END, ICON_END) : R + END, tMax = w - R - END;
  const mid = (dug.top + dug.bottom) / 2;
  let left, top, edge, aimX = dug.cx, aimY;
  if (side === 'below' || side === 'above') {
    // the tail sits at tx along the edge, right over / under Dug: slide the card so tx spans tMin..tMax
    const tx = k < 0 ? (w / 2) + (tMax - w / 2) * -k : (w / 2) - (w / 2 - tMin) * k;
    left = dug.cx - tx;
    if (side === 'below') { top = dug.bottom + GAP + TAIL; edge = 'top'; aimY = dug.bottom; }
    else { top = dug.top - GAP - TAIL - h; edge = 'bottom'; aimY = dug.top; }
  } else if (side === 'side') {
    // level with him on his left, the tail coming out of the card's right end (the icon owns the left end)
    left = dug.cx - dug.hw - GAP - TAIL - w;
    top = mid - h / 2 - 2;
    edge = 'right'; aimX = dug.cx - dug.hw; aimY = mid;
  } else {
    // beside his head: the card's near end just clear of him, its bottom edge at head height; the tail drops
    // from the near end of the bottom edge toward his shoulder
    const s = side === 'left' ? -1 : 1;
    const near = dug.cx + s * (dug.hw + 3);
    left = s < 0 ? near - w : near;
    top = dug.top + 4 - h;
    edge = 'bottom'; aimX = dug.cx + s * dug.hw * 0.5; aimY = dug.top + (dug.bottom - dug.top) * 0.35;
  }
  // clamp into the safe area
  const l0 = left, t0 = top;
  left = Math.min(bounds.r - w, Math.max(bounds.l + (card.icon ? 12 : 0), left));   // the icon breaks out 12 px
  top = Math.min(bounds.b - h, Math.max(bounds.t, top));
  const pushed = Math.hypot(left - l0, top - t0);
  let tx, ang, reach, miss;
  if (edge === 'right') {
    tx = h / 2;
    const bx = left + w, by = top + tx;
    ang = Math.max(-0.6, Math.min(0.6, Math.atan2(aimY - by, Math.max(8, aimX - bx))));
    reach = aimX - bx;
    miss = Math.abs(aimY - by);
  } else {
    tx = Math.min(tMax, Math.max(tMin, aimX - left));
    const by = edge === 'top' ? top : top + h;
    // the tail skews toward the aim point (a comic tail), within reason
    const dy = Math.max(8, Math.abs(aimY - by));
    ang = Math.max(-0.7, Math.min(0.7, Math.atan2(aimX - (left + tx), dy)));
    reach = edge === 'top' ? by - aimY : aimY - by;   // px between the edge and the aim: about GAP + TAIL
    miss = Math.abs(aimX - (left + tx));             // how far sideways the tail base is from the aim
  }
  return { id: spotId(side, k), sideK: k, left, top, w, h, edge, tx, ang, pushed, reach, miss, side };
}

// obstacles: [{ r: {left, top, right, bottom}, w: weight }] ; goalDir: unit screen vector Dug -> goal (or null)
export function scoreSpot(s, { dug, goalDir, obstacles, current }) {
  const box = { left: s.left, top: s.top, right: s.left + s.w, bottom: s.top + s.h };
  const a = s.w * s.h;
  let score = 0;
  if (goalDir) {
    const cx = s.left + s.w / 2 - dug.cx, cy = s.top + s.h / 2 - (dug.top + dug.bottom) / 2;
    const l = Math.hypot(cx, cy) || 1;
    score += 1.1 * ((cx / l) * goalDir.x + (cy / l) * goalDir.y);
  }
  if (s.side === 'below') score -= 0.18;          // under Dug reads best and stays off the way ahead
  else if (s.side !== 'above') score += 0.1;
  score += 0.05 * Math.abs(s.sideK);               // centred over / under him reads best
  for (const o of obstacles) {
    const ov = overlap(box, o.r);
    // any touch costs a little (more the more it touches), cover costs a lot
    if (ov > 0) score += o.w * Math.min(1, ov / a) + o.w * 0.15 * Math.min(1, ov / 600);
  }
  score += s.pushed * 0.01;
  if (s.reach > GAP + TAIL + 22 || s.reach < (s.edge === 'right' ? 4 : -6)) score += 1.5 + Math.abs(s.reach) * 0.01;  // tail can't reach Dug
  if (s.miss > 26) score += (s.miss - 26) * 0.02;
  if (s.id === current) score -= 0.35;
  return score;
}

export function chooseSpot(ctx) {
  let best = null, bestScore = Infinity;
  const all = [];
  for (const [side, k] of SPOTS) {
    const s = spotFor(side, k, ctx.dug, ctx.card, ctx.bounds);
    const sc = scoreSpot(s, ctx);
    all.push([s.id, +sc.toFixed(2)]);
    if (sc < bestScore) { bestScore = sc; best = s; }
  }
  if (best) { best.score = bestScore; best.all = all; }
  return best;
}

export { TAIL };
