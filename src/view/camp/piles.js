// Pickup piles: generous heaps that grow with the count (max CAMP.pileCap = 40), the ads' "abundance" feeling.
// Each item has a layered heap: tidy stepped stacks for planks and ingots (alternate layers turned 90 degrees),
// round tumbled mounds for drumsticks, stone and ore (hex-packed layers nested into the hollows below, random
// yaw and a little tilt). Slots are ordered like a growing cone: the first items gather in the middle, every
// next one widens and raises the heap, and nothing is ever placed before the items holding it up. So a pile of
// 10 is already a little mound, 25 a proper heap and 40 a big one that spills just past its pallet.
//
// pileSlot(item, i, out) -> { x, y, z, rx, ry, rz, s, layer } in pile-local space (tile centre, pallet top y = 0).
// pileHeight(item, n) -> top of the heap's highest item; pileCrest(item, n, out) -> { x, y, z } of that point.

const SPECS = {
  // lumber stack: 3 boards end to end x 5 across, every layer stepping in by half a board (brick bond)
  plank: {
    h: 0.104, top: 0.104, s: 1.08, grid: true,
    layers: [[3, 5, 0.345, 0.155], [3, 4, 0.345, 0.155], [3, 3, 0.345, 0.155], [2, 2, 0.345, 0.155], [2, 1, 0.345, 0.155], [1, 1, 0.345, 0.155]],
  },
  // ingots: the classic gold-bar pyramid, each layer nested into the one below
  copperBar: {
    h: 0.094, top: 0.096, s: 1.0, grid: true,
    layers: [[3, 5, 0.28, 0.165], [3, 4, 0.28, 0.165], [3, 3, 0.28, 0.165], [2, 2, 0.28, 0.165], [2, 1, 0.28, 0.165], [1, 1, 0.28, 0.165]],
  },
  // tumbled mounds
  cookedMeat: { h: 0.085, top: 0.14, s: 0.96, hex: 0.2, radii: [0.47, 0.39, 0.31, 0.22, 0.13, 0.04], tilt: 0.32, wobble: 0.035, k: 0.6 },
  meat: { h: 0.085, top: 0.14, s: 0.96, hex: 0.2, radii: [0.47, 0.39, 0.31, 0.22, 0.13, 0.04], tilt: 0.32, wobble: 0.035, k: 0.6 },
  stone: { h: 0.105, top: 0.15, s: 0.95, hex: 0.19, radii: [0.45, 0.37, 0.28, 0.19, 0.1, 0.02], tilt: 0.25, wobble: 0.03, k: 0.6 },
  copperOre: { h: 0.105, top: 0.16, s: 0.95, hex: 0.19, radii: [0.45, 0.37, 0.28, 0.19, 0.1, 0.02], tilt: 0.25, wobble: 0.03, k: 0.6 },
  wood: {
    h: 0.15, top: 0.17, s: 1.05, grid: true,
    layers: [[3, 4, 0.3, 0.18], [2, 3, 0.3, 0.18], [3, 2, 0.3, 0.18], [2, 2, 0.3, 0.18], [1, 2, 0.3, 0.18]],
  },
};
const DEFAULT = { h: 0.15, top: 0.18, s: 0.9, hex: 0.21, radii: [0.45, 0.34, 0.23, 0.12, 0.02], tilt: 0.2, wobble: 0.03 };

const hash = (i, k) => { const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return x - Math.floor(x); };

function hexLayer(r, d, odd) {
  const out = [];
  const dz = d * Math.sqrt(3) / 2;
  const ox = odd ? d / 2 : 0, oz = odd ? dz / 3 : 0;
  const n = Math.ceil(r / d) + 2;
  for (let j = -n; j <= n; j++) {
    for (let i = -n; i <= n; i++) {
      const x = (i + (j & 1 ? 0.5 : 0)) * d + ox, z = j * dz + oz;
      if (x * x + z * z <= r * r + 1e-6) out.push([x, z]);
    }
  }
  return out;
}

function build(item) {
  const S = SPECS[item] || DEFAULT;
  const raw = [];
  if (S.grid) {
    S.layers.forEach(([nx, nz, sx, sz, turn], L) => {
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
        raw.push({ x: (i - (nx - 1) / 2) * sx, z: (j - (nz - 1) / 2) * sz, layer: L, ry: turn ? Math.PI / 2 : 0, sup: Math.max(sx, sz) * 0.62 });
      }
    });
  } else {
    S.radii.forEach((r, L) => { for (const [x, z] of hexLayer(r, S.hex, L & 1)) raw.push({ x, z, layer: L, ry: 0, sup: S.hex * 0.95 }); });
  }
  const nL = (S.grid ? S.layers.length : S.radii.length);
  let RX = 0.01, RZ = 0.01;
  for (const p of raw) if (p.layer === 0) { RX = Math.max(RX, Math.abs(p.x)); RZ = Math.max(RZ, Math.abs(p.z)); }
  raw.forEach((p, i) => {
    p.y = p.layer * S.h;
    p.t = Math.hypot(p.x / (RX + 0.12), p.z / (RZ + 0.12)) + (S.k ?? 1.15) * (p.layer / nL) + hash(i, 9) * 0.02;
  });
  // cone order, but never before the items holding it up
  const sorted = [...raw].sort((a, b) => a.t - b.t);
  const placed = new Set(), order = [];
  const place = p => {
    if (placed.has(p)) return;
    placed.add(p);
    if (p.layer > 0) for (const q of raw) if (q.layer === p.layer - 1 && Math.hypot(q.x - p.x, q.z - p.z) < p.sup) place(q);
    order.push(p);
  };
  sorted.forEach(place);
  // dress: natural heaps tumble (random yaw, tilt, size), stacks stay neat with a hint of hand-placed
  const slots = order.map((p, i) => {
    const o = { x: p.x, y: p.y, z: p.z, rx: 0, ry: p.ry, rz: 0, s: S.s, layer: p.layer };
    if (S.grid) {
      o.x += (hash(i, 1) - 0.5) * 0.014; o.z += (hash(i, 2) - 0.5) * 0.014;
      o.ry += (hash(i, 3) - 0.5) * 0.07;
    } else {
      o.x += (hash(i, 1) - 0.5) * S.wobble * 2; o.z += (hash(i, 2) - 0.5) * S.wobble * 2;
      o.ry = hash(i, 3) * Math.PI * 2;
      const tl = p.layer ? S.tilt : S.tilt * 0.3;
      o.rx = (hash(i, 4) - 0.5) * 2 * tl; o.rz = (hash(i, 5) - 0.5) * 2 * tl;
      o.s *= 0.94 + hash(i, 6) * 0.12;
      o.y -= p.layer ? 0.012 : 0;   // settle into the hollows
    }
    return o;
  });
  // running crest (highest point) so pileTop / the Full tag can follow the heap as it grows
  const crest = [];
  let best = null;
  for (const o of slots) {
    if (!best || o.y >= best.y - 1e-4) best = o;
    crest.push(best);
  }
  return { S, slots, crest };
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
  out.x = o.x; out.y = o.y + extra; out.z = o.z; out.rx = o.rx; out.ry = o.ry; out.rz = o.rz; out.s = o.s; out.layer = o.layer;
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

export const pileSlotCount = item => get(item).slots.length;
