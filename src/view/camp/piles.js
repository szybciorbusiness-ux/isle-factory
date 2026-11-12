// Pickup pile layouts: neat stacks that grow and shrink with the count (max CAMP.pileCap = 40).
// slot(item, i) -> { x, y, z, ry, s } in pile-local space (tile centre, ground y = 0).
// Layers alternate a full grid and a nested, offset grid (or a 90-degree turn for long items), so a pile reads
// as a tidy lumber stack / pyramid / ingot stack instead of a heap.

const LAYOUTS = {
  // two boards end-to-end x three across, alternate layers turned 90 degrees (a lumber stack)
  plank: { cols: 2, rows: 3, sx: 0.31, sz: 0.135, h: 0.098, turn: true, s: 1 },
  // 3 x 3 then a nested 2 x 2: a stepped pyramid that keeps climbing
  stone: { cols: 3, rows: 3, sx: 0.215, sz: 0.215, h: 0.125, nest: true, s: 0.92, jitter: 0.35 },
  copperOre: { cols: 3, rows: 3, sx: 0.215, sz: 0.215, h: 0.13, nest: true, s: 0.92, jitter: 0.35 },
  wood: { cols: 1, rows: 3, sx: 0.3, sz: 0.17, h: 0.15, nestRow: true, s: 1.05 },
  // drumsticks: 2 x 3, turned per layer, a little irregular
  cookedMeat: { cols: 2, rows: 3, sx: 0.29, sz: 0.17, h: 0.1, turn: true, s: 0.95, jitter: 0.25, flip: true },
  meat: { cols: 2, rows: 3, sx: 0.29, sz: 0.17, h: 0.1, turn: true, s: 0.95, jitter: 0.25, flip: true },
  // ingots: 2 x 3, turned per layer (the classic gold-bar stack)
  copperBar: { cols: 2, rows: 3, sx: 0.29, sz: 0.135, h: 0.074, turn: true, s: 1 },
};
const DEFAULT = { cols: 3, rows: 3, sx: 0.22, sz: 0.22, h: 0.18, nest: true, s: 0.9 };

const hash = (i, k) => { const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return x - Math.floor(x); };

export function pileLayout(item) { return LAYOUTS[item] || DEFAULT; }

export function pileSlot(item, i, out = {}) {
  const L = pileLayout(item);
  const full = L.cols * L.rows;
  const nested = L.nest ? (L.cols - 1) * (L.rows - 1) : full;
  let layer = 0, idx = i, isNested = false;
  // walk the alternating layers
  for (;;) {
    const cap = L.nest && layer % 2 === 1 ? nested : full;
    if (idx < cap) { isNested = L.nest && layer % 2 === 1; break; }
    idx -= cap; layer++;
    if (layer > 60) break;
  }
  const cols = isNested ? L.cols - 1 : L.cols, rows = isNested ? L.rows - 1 : L.rows;
  const c = idx % cols, r = Math.floor(idx / cols);
  let x = (c - (cols - 1) / 2) * L.sx, z = (r - (rows - 1) / 2) * L.sz, ry = 0;
  // turned layer: long items lie along z, so the long spacing goes to z and the short one to x
  if (L.turn && layer % 2 === 1) { x = (r - (rows - 1) / 2) * L.sz; z = (c - (cols - 1) / 2) * L.sx; ry = Math.PI / 2; }
  const j = L.jitter || 0;
  if (j) { x += (hash(i, 1) - 0.5) * 0.04 * j * 4; z += (hash(i, 2) - 0.5) * 0.04 * j * 4; ry += (hash(i, 3) - 0.5) * j * 1.2; }
  if (L.flip && hash(i, 4) > 0.5) ry += Math.PI;
  out.x = x; out.z = z; out.y = layer * L.h; out.ry = ry; out.s = L.s; out.layer = layer;
  return out;
}

// Height of the top of a pile of n items (for pileTop / hop targets).
export function pileHeight(item, n) {
  if (n <= 0) return 0.05;
  const L = pileLayout(item);
  const s = pileSlot(item, n - 1);
  return s.y + L.h;
}
