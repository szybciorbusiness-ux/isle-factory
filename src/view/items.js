// Item meshes: one merged vertex-coloured geometry per item id (origin at the bottom centre, ~0.2 tall) and a
// single shared Lambert material, so belts, piles, flights, stacks and workers can draw every item of a type with
// one InstancedMesh. Camp items: wood, plank, stone, copperOre, meat + cookedMeat (drumsticks), copperBar (ingot).
import * as THREE from 'three';
import { Parts, rbox, jitter, rng } from './buildings/geom.js';
import { miniModel } from './buildings/models.js';

const ITEM_HEIGHT = 0.2;
// Items are drawn by the hundred (full piles hold 40 each, stacks, belts, flights) and are small on screen, so they
// stay light: bodies are 1-segment rounded boxes, painted details (grill marks, grain, stamps) plain boxes.
const body = (w, h, d, r) => rbox(w, h, d, r, 1);
const mark = (w, h, d) => new THREE.BoxGeometry(w, h, d);

// ---------- camp food + bars ----------
// Cartoon drumstick lying along x: a plump faceted bulb of meat (fat end toward -x) tapering into a cream bone
// with two round knuckles, the bone tipped up a touch so the silhouette reads at icon size. Raw = pink with a
// fat collar and marbling; cooked = golden brown with grill marks and a glossy top.
export const DRUMSTICK = { meatAxisY: 0.07, bulbX: -0.062 };   // centre of the meaty bulge (spit / hand anchors)
function drumstick(p, raw) {
  const col = raw
    ? { meat: '#ea887c', top: '#f6aea2', low: '#cc6a62', mark: '#f9cfc4', collar: '#fde7d4' }
    : { meat: '#c8783c', top: '#e7a964', low: '#9a582c', mark: '#8c4f2a', collar: '#d99050' };
  const L = 0.2, R = 0.078, x0 = -0.15, ay = DRUMSTICK.meatAxisY;
  // bulb: a lathe along +y, laid along +x (fat end at x0)
  const prof = [[0, 0], [0.04, 0.006], [0.064, 0.026], [0.076, 0.056], [R, 0.088], [0.072, 0.122], [0.057, 0.152], [0.04, 0.18], [0.028, L]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  const bulb = jitter(new THREE.LatheGeometry(prof, 9), 0.006, raw ? 4 : 6);
  bulb.rotateZ(-Math.PI / 2);
  p.add(bulb, col.meat, {
    p: [x0, ay, 0], s: [1, 0.9, 1.04], flat: true, jitter: 0.05, seed: raw ? 5 : 8,
    faceColor: (cx, cy, cz, nx, ny) => (ny > 0.62 ? col.top : ny < -0.35 ? col.low : null),
  });
  if (raw) {
    // fat collar where the meat meets the bone + two streaks of marbling on top
    p.add(new THREE.TorusGeometry(0.03, 0.012, 5, 10), col.collar, { p: [x0 + L - 0.012, ay, 0], r: [0, Math.PI / 2, 0], flat: true, ao: false });
    p.add(mark(0.06, 0.006, 0.013), col.mark, { p: [x0 + 0.08, ay + 0.066, -0.016], r: [0, 0.45, 0.04], ao: false });
    p.add(mark(0.04, 0.006, 0.011), col.mark, { p: [x0 + 0.125, ay + 0.058, 0.02], r: [0, -0.3, 0.1], ao: false });
  } else {
    // crispy collar, grill marks pressed into the top, a glossy highlight
    p.add(new THREE.TorusGeometry(0.029, 0.011, 5, 10), col.collar, { p: [x0 + L - 0.012, ay, 0], r: [0, Math.PI / 2, 0], flat: true, ao: false });
    for (const [x, y] of [[0.055, 0.061], [0.095, 0.066], [0.135, 0.057]]) p.add(mark(0.011, 0.006, 0.07), col.mark, { p: [x0 + x, ay + y, 0.004], r: [0, 0.42, 0], ao: false });
    p.add(mark(0.045, 0.005, 0.016), '#f7cf93', { p: [x0 + 0.075, ay + 0.064, -0.034], r: [0, 0.42, 0], ao: false });
  }
  // bone: shaft tipped up a little, two knuckles at the end
  const tip = 0.16;
  const bx = x0 + L - 0.01, len = 0.085;
  const ex = bx + Math.cos(tip) * len, ey = ay + Math.sin(tip) * len;
  p.add(new THREE.CylinderGeometry(0.019, 0.023, len, 7), '#fff1d6', { p: [(bx + ex) / 2, (ay + ey) / 2, 0], r: [0, 0, -Math.PI / 2 + tip], flat: true });
  for (const z of [-0.021, 0.021]) {
    p.add(new THREE.SphereGeometry(0.027, 7, 5), '#fff1d6', { p: [ex + 0.006, ey + 0.004, z], flat: true, faceColor: (cx, cy, cz, nx, ny) => (ny < -0.3 ? '#ead7b4' : null) });
  }
}
// Classic ingot: a square frustum stretched long, light top, warm bevelled sides, a raised plate stamped on top.
function ingot(p) {
  const g = new THREE.CylinderGeometry(0.1, 0.132, 0.085, 4, 1);
  g.rotateY(Math.PI / 4);
  p.add(g, '#e8894a', {
    p: [0, 0.0425, 0], s: [1.42, 1, 0.8], flat: true,
    faceColor: (cx, cy, cz, nx, ny, nz) => (ny > 0.9 ? '#f6aa6c' : ny < -0.9 ? '#c26a3a' : Math.abs(nx) > Math.abs(nz) ? '#cf7440' : null),
  });
  p.add(mark(0.15, 0.01, 0.07), '#fbc995', { p: [0, 0.088, 0], ao: false });
  p.add(mark(0.11, 0.004, 0.012), '#e08a52', { p: [0, 0.094, -0.012], ao: false });
  p.add(mark(0.07, 0.004, 0.012), '#e08a52', { p: [-0.02, 0.094, 0.014], ao: false });
}

function buildGeometry(id, config) {
  const P = config.PALETTE;
  const p = new Parts({ ao: { y0: 0, y1: 0.16, min: 0.8 } });
  switch (id) {
    case 'wood': {
      // short log lying along x: faceted bark, light end caps with a darker ring and pith
      const r = 0.085, L = 0.27;
      p.add(new THREE.CylinderGeometry(r, r * 1.04, L, 9, 1), config.ITEMS.wood.color, {
        r: [0, 0, Math.PI / 2], p: [0, r, 0], flat: true, jitter: 0.07, seed: 3,
        faceColor: (cx, cy, cz, nx) => (Math.abs(nx) > 0.9 ? P.stumpTop : null),
      });
      for (const s of [-1, 1]) {
        p.add(new THREE.RingGeometry(0.034, 0.05, 12), '#c99a62', { p: [s * (L / 2 + 0.002), r, 0], r: [0, s * Math.PI / 2, 0], ao: false });
        p.add(new THREE.CircleGeometry(0.013, 8), '#b88552', { p: [s * (L / 2 + 0.003), r, 0], r: [0, s * Math.PI / 2, 0], ao: false });
      }
      // a little branch stub
      p.add(new THREE.CylinderGeometry(0.022, 0.03, 0.05, 6), P.trunk, { p: [0.03, r * 2 - 0.005, 0.02], r: [0.5, 0, -0.3], flat: true });
      p.add(new THREE.CircleGeometry(0.02, 6), P.stumpTop, { p: [0.019, r * 2 + 0.017, 0.032], r: [-Math.PI / 2 + 0.5, 0, -0.3], ao: false });
      break;
    }
    case 'stone': {
      const g = jitter(new THREE.IcosahedronGeometry(0.1, 0), 0.04, 5);
      p.add(g, '#ddd0ad', { s: [1.15, 0.85, 1.0], p: [0, 0.085, 0], flat: true, jitter: 0.07, seed: 11, faceColor: (cx, cy, cz, nx, ny) => (ny < -0.2 ? '#c4b48f' : null) });
      p.add(jitter(new THREE.IcosahedronGeometry(0.045, 0), 0.02, 8), '#e9dcba', { p: [0.075, 0.03, 0.06], flat: true, jitter: 0.06 });
      break;
    }
    case 'copperOre': {
      const g = jitter(new THREE.DodecahedronGeometry(0.095, 0), 0.04, 4);
      const r = rng(21);
      p.add(g, '#de8a4e', {
        s: [1.1, 0.95, 1.0], p: [0, 0.09, 0], flat: true, jitter: 0.06, seed: 9,
        faceColor: () => { const k = r(); return k < 0.2 ? '#93573a' : k > 0.85 ? '#f7b47a' : null; },
      });
      // dark specks
      for (const [x, y, z] of [[0.07, 0.12, 0.05], [-0.05, 0.15, 0.06], [0.02, 0.1, -0.09], [-0.08, 0.08, -0.03]]) {
        p.add(new THREE.TetrahedronGeometry(0.022, 0), '#6a3c2a', { p: [x, y, z], flat: true, ao: false });
      }
      break;
    }
    case 'plank': {
      // two light boards, slightly crossed, with a grain line
      p.add(body(0.3, 0.05, 0.12, 0.016), config.ITEMS.plank.color, { p: [0, 0.025, 0], r: [0, 0.12, 0] });
      p.add(body(0.3, 0.05, 0.12, 0.016), '#e8bd86', { p: [0.01, 0.075, 0.005], r: [0, -0.1, 0] });
      for (const [z, y, ry] of [[-0.025, 0.1005, -0.1], [0.03, 0.1005, -0.1]]) p.add(mark(0.22, 0.004, 0.008), '#c99560', { p: [0.01, y, z + 0.005], r: [0, ry, 0], ao: false });
      break;
    }
    case 'meat': { p.ao = { y0: 0, y1: 0.12, min: 0.82 }; drumstick(p, true); break; }
    case 'cookedMeat': { p.ao = { y0: 0, y1: 0.12, min: 0.82 }; drumstick(p, false); break; }
    case 'copperBar': { p.ao = { y0: 0, y1: 0.08, min: 0.85 }; ingot(p); break; }
    case 'copperPlate': {
      p.add(body(0.21, 0.05, 0.21, 0.016), P.copperDark, { p: [0, 0.025, 0] });
      p.add(body(0.2, 0.045, 0.2, 0.014), config.ITEMS.copperPlate.color, { p: [0, 0.042, 0] });
      p.add(mark(0.14, 0.02, 0.14), '#ffbf8a', { p: [0, 0.065, 0], ao: false });
      break;
    }
    default: {
      const mini = miniModel(id);
      if (mini) return mini;
      p.add(rbox(0.18, 0.18, 0.18, 0.04), config.ITEMS[id]?.color || '#ffffff', { p: [0, 0.09, 0] });
    }
  }
  return p.merge();
}

export function create(ctx) {
  const { config } = ctx;
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const geos = new Map();
  const getGeometry = id => {
    if (!geos.has(id)) {
      let g;
      try { g = buildGeometry(id, config); } catch (e) { console.error('[items] geometry', id, e); g = null; }
      if (!g) { const p = new Parts(); p.add(rbox(0.18, 0.18, 0.18, 0.04), config.ITEMS[id]?.color || '#ffffff', { p: [0, 0.09, 0] }); g = p.merge(); }
      // the contract: origin at the bottom centre (jittered rocks can end a hair above or below y = 0)
      g.computeBoundingBox();
      const y0 = g.boundingBox.min.y;
      if (Math.abs(y0) > 0.003) { g.translate(0, -y0, 0); g.computeBoundingBox(); g.computeBoundingSphere(); }
      geos.set(id, g);
    }
    return geos.get(id);
  };
  for (const id of Object.keys(config.ITEMS)) getGeometry(id);

  return {
    itemHeight: ITEM_HEIGHT,
    ids: Object.keys(config.ITEMS),
    getGeometry,
    getMaterial: () => material,
    // A fresh Mesh (shares geometry + material: do not dispose them).
    createItemMesh(id) {
      const m = new THREE.Mesh(getGeometry(id), material);
      m.castShadow = true; m.receiveShadow = true;
      m.name = `item:${id}`;
      return m;
    },
    // A fresh InstancedMesh for `capacity` copies of an item (count starts at 0).
    getInstanced(id, capacity = 256) {
      const m = new THREE.InstancedMesh(getGeometry(id), material, capacity);
      m.count = 0; m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
      m.name = `items:${id}`;
      return m;
    },
  };
}
