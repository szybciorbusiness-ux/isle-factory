// Item meshes: one merged vertex-coloured geometry per item id (origin at the bottom centre, ~0.2 tall) and a
// single shared Lambert material, so belts can draw every item of a type with one InstancedMesh.
import * as THREE from 'three';
import { Parts, rbox, jitter, rng } from './buildings/geom.js';
import { miniModel } from './buildings/models.js';

const ITEM_HEIGHT = 0.2;

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
      p.add(rbox(0.3, 0.05, 0.12, 0.016), config.ITEMS.plank.color, { p: [0, 0.025, 0], r: [0, 0.12, 0] });
      p.add(rbox(0.3, 0.05, 0.12, 0.016), '#e8bd86', { p: [0.01, 0.075, 0.005], r: [0, -0.1, 0] });
      for (const [z, y, ry] of [[-0.025, 0.1005, -0.1], [0.03, 0.1005, -0.1]]) p.add(rbox(0.22, 0.004, 0.008, 0.002), '#c99560', { p: [0.01, y, z + 0.005], r: [0, ry, 0], ao: false });
      break;
    }
    case 'copperPlate': {
      p.add(rbox(0.21, 0.05, 0.21, 0.016), P.copperDark, { p: [0, 0.025, 0] });
      p.add(rbox(0.2, 0.045, 0.2, 0.014), config.ITEMS.copperPlate.color, { p: [0, 0.042, 0] });
      p.add(rbox(0.14, 0.02, 0.14, 0.008), '#ffbf8a', { p: [0, 0.065, 0], ao: false });
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
