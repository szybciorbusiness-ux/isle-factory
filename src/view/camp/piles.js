// Pickup piles: heaps that grow (FIRST-20 "abundance"), max CAMP.pileCap = 40.
//
// Every item stacks into a pyramid / cone that grows like itself: the first items gather in a little mound in the
// middle of the pallet, each next one makes it both taller and wider (the heap is always the same shape, just
// bigger), and from about a dozen items on it spills past the pallet onto the grass, the edge items tipped
// outward where they slid off. Long items (planks, ingots, logs) lie in criss-crossed layers like a woodpile,
// round ones (drumsticks, stone, ore) tumble in nested hex layers. Everything gets small random turns and tilts
// so it reads as a heap, not a crate. Nothing is ever placed before the items holding it up.
//
// pileSlot(item, i, out) -> { x, y, z, rx, ry, rz, s, layer, spill } in pile-local space (tile centre, pallet top
// y = 0; spilled items sit lower, on the grass). pileHeight(item, n) -> top of the heap's highest item;
// pileCrest(item, n, out) -> { x, y, z } of that point. pileRadius(item, n) -> how far the heap reaches.

export const PALLET_HALF = 0.42;     // the pallet's half width (camp.js draws it 0.84 wide)
export const PALLET_TOP = 0.06;

// kind 'grid': cell [along, across] for an item lying along x; layers alternate 90 degrees (a criss-cross
//   woodpile) unless parallel (logs nest into the grooves of the layer below, offset half a cell).
// kind 'hex': spacing d, every layer nested into the hollows of the one below.
// h = layer step, top = item height (for the crest), s = scale in the heap, R = base radius when full (40).
const SPECS = {
  plank: { kind: 'grid', cell: [0.37, 0.2], h: 0.108, top: 0.105, s: 1.12, R: 0.6, yawJ: 0.22, tiltJ: 0.08 },
  copperBar: { kind: 'grid', cell: [0.31, 0.19], h: 0.096, top: 0.098, s: 1.1, R: 0.64, yawJ: 0.2, tiltJ: 0.06 },
  wood: { kind: 'grid', cell: [0.31, 0.19], h: 0.15, top: 0.17, s: 1.06, R: 0.58, yawJ: 0.12, tiltJ: 0.05, parallel: true },
  cookedMeat: { kind: 'hex', d: 0.25, h: 0.12, top: 0.14, s: 1.06, R: 0.54, tiltJ: 0.32 },
  meat: { kind: 'hex', d: 0.25, h: 0.12, top: 0.14, s: 1.06, R: 0.54, tiltJ: 0.32 },
  stone: { kind: 'hex', d: 0.24, h: 0.13, top: 0.15, s: 1.06, R: 0.52, tiltJ: 0.26 },
  copperOre: { kind: 'hex', d: 0.23, h: 0.13, top: 0.16, s: 1.06, R: 0.51, tiltJ: 0.26 },
};
const DEFAULT = { kind: 'hex', d: 0.21, h: 0.15, top: 0.18, s: 0.95, R: 0.68, tiltJ: 0.2 };
const TARGET = 44;                    // slots inside the full-size heap (a little over the cap)

const hash = (i, k) => { const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return x - Math.floor(x); };

// candidate positions for one layer, out to radius rMax
function layerCells(S, L, rMax) {
  const out = [];
  if (S.kind === 'grid') {
    const turn = !S.parallel && (L & 1);
    const [a, b] = S.cell;
    const cx = turn ? b : a, cz = turn ? a : b;
    // parallel logs nest into the grooves of the layer below (half a cell over)
    // (criss-cross layers stay centred, so the heap always peaks over the middle of the pallet)
    const ox = S.parallel && (L & 1) ? cx / 2 : 0;
    const oz = S.parallel && (L & 1) ? cz / 2 : 0;
    const nx = Math.ceil(rMax / cx) + 1, nz = Math.ceil(rMax / cz) + 1;
    for (let j = -nz; j <= nz; j++) for (let i = -nx; i <= nx; i++) {
      const x = i * cx + ox, z = j * cz + oz;
      // reach of the item's footprint (half the cell outward), on a rounded-square norm: a pyramid with soft corners
      const ex = Math.abs(x) + cx * 0.32, ez = Math.abs(z) + cz * 0.32;
      const rho = Math.pow(Math.pow(ex, S.p || 2.4) + Math.pow(ez, S.p || 2.4), 1 / (S.p || 2.4));
      if (rho <= rMax) out.push({ x, z, rho, ry: turn ? Math.PI / 2 : 0, sup: Math.max(cx, cz) * 0.62 });
    }
  } else {
    const d = S.d, dz = d * Math.sqrt(3) / 2;
    const ox = L & 1 ? d / 2 : 0, oz = L & 1 ? dz / 3 : 0;
    const n = Math.ceil(rMax / d) + 2;
    for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) {
      const x = (i + (j & 1 ? 0.5 : 0)) * d + ox, z = j * dz + oz;
      const rho = Math.hypot(x, z) + d * 0.4;
      if (rho <= rMax) out.push({ x, z, rho, ry: 0, sup: d * 0.95 });
    }
  }
  return out;
}

function build(item) {
  const S = SPECS[item] || DEFAULT;
  const LMAX = 12;
  const layers = [];
  for (let L = 0; L < LMAX; L++) layers.push(layerCells(S, L, S.R * 1.25));
  // the full heap is the cone rho / R + y / H <= 1; pick H so it holds TARGET items
  const count = H => { let n = 0; layers.forEach((cells, L) => { for (const c of cells) if (c.rho / S.R + (L * S.h) / H <= 1) n++; }); return n; };
  let lo = 0.05, hi = 4;
  for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (count(mid) < TARGET) lo = mid; else hi = mid; }
  const H = hi;
  const raw = [];
  layers.forEach((cells, L) => {
    for (const c of cells) {
      const shell = c.rho / S.R + (L * S.h) / H;
      if (shell <= 1.25) raw.push({ ...c, layer: L, y: L * S.h, shell });
    }
  });
  raw.forEach((p, i) => { p.shell += hash(i, 9) * 0.012; });
  // grow like itself, but never before the items holding it up
  const sorted = [...raw].sort((a, b) => a.shell - b.shell);
  const placed = new Set(), order = [];
  const place = p => {
    if (placed.has(p)) return;
    placed.add(p);
    if (p.layer > 0) for (const q of raw) if (q.layer === p.layer - 1 && Math.hypot(q.x - p.x, q.z - p.z) < p.sup) place(q);
    order.push(p);
  };
  sorted.forEach(place);

  // dress the slots: jitter, small turns and tilts, and items past the pallet's edge slide down onto the grass,
  // tipped outward (their inner end still resting on the pallet / the heap)
  const slots = order.map((p, i) => {
    const o = { x: p.x, y: p.y, z: p.z, rx: 0, ry: p.ry, rz: 0, s: S.s, layer: p.layer, spill: 0 };
    const j = S.kind === 'grid' ? 0.02 : 0.035;
    o.x += (hash(i, 1) - 0.5) * 2 * j; o.z += (hash(i, 2) - 0.5) * 2 * j;
    if (S.kind === 'grid') o.ry += (hash(i, 3) - 0.5) * 2 * S.yawJ * (p.layer ? 1 : 0.7);
    else { o.ry = hash(i, 3) * Math.PI * 2; o.s *= 0.94 + hash(i, 6) * 0.12; o.y -= p.layer ? 0.012 : 0; }
    const tl = p.layer ? S.tiltJ : S.tiltJ * 0.35;
    o.rx = (hash(i, 4) - 0.5) * 2 * tl; o.rz = (hash(i, 5) - 0.5) * 2 * tl;
    // spill: how far the item's centre reaches past the pallet edge (rounded-square norm, like the pallet)
    const ax = Math.abs(o.x), az = Math.abs(o.z);
    const edge = Math.max(ax, az);
    const over = Math.max(0, Math.min(1, (edge - PALLET_HALF + 0.08) / 0.2));
    if (over > 0) {
      const drop = PALLET_TOP * over * (p.layer === 0 ? 1 : 0.55);
      o.y -= drop;
      o.spill = over;
      // tip outward: rotate about the axis along the edge so the outer end goes down
      const tip = 0.32 * over * (p.layer === 0 ? 1 : 0.6);
      if (ax >= az) o.rz += -Math.sign(o.x) * tip; else o.rx += Math.sign(o.z) * tip;
    }
    return o;
  });
  // running crest (highest point) so pileTop / the Full tag can follow the heap as it grows
  const crest = [];
  const reach = [];
  let best = null, far = 0;
  for (const o of slots) {
    if (!best || o.y >= best.y - 1e-4) best = o;
    crest.push(best);
    far = Math.max(far, Math.hypot(o.x, o.z));
    reach.push(far);
  }
  return { S, slots, crest, reach, H };
}

const cache = new Map();
const get = item => { if (!cache.has(item)) cache.set(item, build(item)); return cache.get(item); };

export function pileLayout(item) { return get(item).S; }

export function pileSlot(item, i, out = {}) {
  const P = get(item);
  const n = P.slots.length;
  // past the designed heap (never with pileCap 40): keep stacking on the crest
  const o = P.slots[Math.min(i, n - 1)];
  const extra = i >= n ? (i - n + 1) * P.S.h : 0;
  out.x = o.x; out.y = o.y + extra; out.z = o.z; out.rx = o.rx; out.ry = o.ry; out.rz = o.rz; out.s = o.s; out.layer = o.layer; out.spill = o.spill;
  return out;
}

// Top of the heap (highest item's top) for a pile of n items.
export function pileHeight(item, n) {
  if (n <= 0) return 0.05;
  const P = get(item);
  const c = P.crest[Math.min(n, P.crest.length) - 1];
  return c.y + P.S.top * c.s + (n > P.slots.length ? (n - P.slots.length) * P.S.h : 0);
}

// Highest point of a heap of n items: { x, y, z } (y = top of that item).
export function pileCrest(item, n, out = {}) {
  const P = get(item);
  if (n <= 0) { out.x = 0; out.y = 0.05; out.z = 0; return out; }
  const c = P.crest[Math.min(n, P.crest.length) - 1];
  out.x = c.x; out.z = c.z; out.y = pileHeight(item, n);
  return out;
}

// How far from the tile centre the heap of n items reaches (item centres).
export function pileRadius(item, n) {
  if (n <= 0) return 0;
  const P = get(item);
  return P.reach[Math.min(n, P.reach.length) - 1];
}

export const pileSlotCount = item => get(item).slots.length;
export const _pileDebug = item => { const P = get(item); return { H: P.H, n: P.slots.length }; };
