// Instanced item pools: one InstancedMesh per item id holds every camp item of that type (line riders,
// pile stacks, station input buffers, zone icons, hops in flight). Rebuilt every frame: begin(), push(), end().
// Geometry comes from views.items when it has a real model; meat / cookedMeat / copperBar fall back to our own
// meshes while items.js still draws them as plain boxes.
import * as THREE from 'three';
import { fallbackItemGeometry, Parts, rbox } from './geo.js';

const OWN_FALLBACKS = new Set(['meat', 'cookedMeat', 'copperBar']);

// items.js's generic fallback is an 0.18 cube; anything else is a real model.
function isPlaceholder(geo) {
  if (!geo) return true;
  if (!geo.boundingBox) geo.computeBoundingBox();
  const s = new THREE.Vector3();
  geo.boundingBox.getSize(s);
  return Math.abs(s.x - 0.18) < 0.004 && Math.abs(s.y - 0.18) < 0.004 && Math.abs(s.z - 0.18) < 0.004;
}

export function createItemPools(ctx, parent, { castShadow = true } = {}) {
  const { config } = ctx;
  const items = () => ctx.views.items;
  let ownMat = null;
  const pools = new Map();
  const geoCache = new Map();

  function geometryFor(id) {
    if (geoCache.has(id)) return geoCache.get(id);
    let g = null;
    try { g = items()?.getGeometry?.(id) || null; } catch { g = null; }
    if ((!g || isPlaceholder(g)) && OWN_FALLBACKS.has(id)) g = fallbackItemGeometry(id) || g;
    if (!g) { const p = new Parts(); p.add(rbox(0.18, 0.18, 0.18, 0.04), config.ITEMS[id]?.color || '#ffffff', { p: [0, 0.09, 0] }); g = p.merge(); }
    geoCache.set(id, g);
    return g;
  }
  function material() {
    const m = items()?.getMaterial?.();
    if (m) return m;
    return (ownMat ||= new THREE.MeshLambertMaterial({ vertexColors: true }));
  }
  function make(id, cap) {
    const mesh = new THREE.InstancedMesh(geometryFor(id), material(), cap);
    mesh.count = 0;
    mesh.castShadow = castShadow; mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.name = `camp-items:${id}`;
    mesh.visible = false;
    parent.add(mesh);
    return { mesh, n: 0, cap };
  }
  function pool(id) {
    let p = pools.get(id);
    if (!p) { p = make(id, 64); pools.set(id, p); }
    if (p.n >= p.cap) { // grow (rare): replace the mesh with a bigger one, copying what is already written
      const bigger = make(id, p.cap * 2);
      for (let i = 0; i < p.n; i++) { p.mesh.getMatrixAt(i, _m); bigger.mesh.setMatrixAt(i, _m); }
      bigger.n = p.n;
      p.mesh.removeFromParent(); p.mesh.dispose();
      pools.set(id, bigger);
      p = bigger;
    }
    return p;
  }
  const _m = new THREE.Matrix4();

  return {
    geometryFor,
    has: id => !!config.ITEMS[id],
    begin() { for (const p of pools.values()) p.n = 0; },
    push(id, matrix) { const p = pool(id); p.mesh.setMatrixAt(p.n++, matrix); },
    end() {
      for (const p of pools.values()) {
        p.mesh.count = p.n;
        p.mesh.visible = p.n > 0;
        if (p.n) p.mesh.instanceMatrix.needsUpdate = true;
      }
    },
    get drawn() { let n = 0; for (const p of pools.values()) n += p.n; return n; },
    get meshes() { return [...pools.values()].map(p => p.mesh); },
  };
}
