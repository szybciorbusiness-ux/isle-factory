// Creatures: the camp's animals (deer, boar, rabbit) and workers (lumberjack, hunter), drawn from camp state
// (ctx.camp, GAMEPLAY.md) with smooth, springy animation. Inactive outside camp mode.
//
// Rendering: every creature is an invisible Object3D rig (src/view/creatures/animals.js, workers.js); each
// frame the rigs' part matrices are written into shared meshes. Default: two THREE.BatchedMesh batches
// (src/view/creatures/kit.js PartBatch) hold every part geometry of every species and role, one that casts
// shadows (bodies, heads, legs, tools) and one that doesn't (ears, tails, feet, eyelids, bubble, snack), so the
// whole cast of animals and workers is 2 draw calls + 1 in the shadow pass, plus the contact-shadow quads and
// the carried items. Without WEBGL_multi_draw (or with ?creaturesInstanced) it falls back to one InstancedMesh
// per part type (PartPool). A per-instance white hit flash rides along either way.
//
// Events: animal:spawned (hop in from a dust puff), animal:hit (flash, squash, bonk star, knockback hop, eyes
// squeezed), animal:killed (squash + fx.poof; the fx module flies the drumsticks), animal:removed, camp:swing
// (target flinches; worker swings: lumberjack chops overhead, hunter side-swipes), worker:hired (hop out of the
// hut door), worker:state, worker:carry (items fly onto the rack), worker:hungry / worker:ate (thought bubble,
// munch), station:drop by a worker (items toss into views.campview.intakePoint).
//
// API: views.creatures = { animalObject(id), workerObject(id), animalCenter(id, out?), workerStackTop(id, out?),
//   update, stats() -> { animals, workers, drawCalls, shadowCalls, batched, meshes } }
import * as THREE from 'three';
import { creatureMaterial, PartPool, PartBatch, canBatch, shadowTexture } from './creatures/kit.js';
import { buildAnimalGeometries, lidGeometry } from './creatures/animal-models.js';
import { buildWorkerGeometries } from './creatures/worker-models.js';
import { AnimalView } from './creatures/animals.js';
import { WorkerView } from './creatures/workers.js';
import { STATIONS, PADS } from '../sim/camp-data.js';

const SIZE_MOBILE = 1.22;   // portrait phones sit farther out: creatures a touch bigger there

export function create(ctx) {
  const camp = ctx.camp;
  if (!camp) return {};
  const { scene, events, views, camera, config } = ctx;
  const mobile = !!ctx.mobile || ctx.quality?.tier === 'mobile';
  const q = { seg: mobile ? 8 : 10 };

  const root = new THREE.Group();
  root.name = 'creatures';
  scene.add(root);
  const mat = creatureMaterial();

  // ---------- part geometries: [key, geometry, capacity hint, casts shadow] ----------
  const ag = buildAnimalGeometries(q);
  const wg = buildWorkerGeometries(q);
  const parts = [];
  const CAST = new Set(['body', 'head', ...(mobile ? [] : ['leg'])]);
  for (const [kind, ps] of Object.entries(ag)) {
    for (const [part, geo] of Object.entries(ps)) {
      const per = part === 'leg' ? 4 : part === 'ear' || part === 'foot' ? 2 : 1;
      parts.push([`${kind}.${part}`, geo, 8 * per, CAST.has(part)]);
    }
  }
  for (const [key, geo] of Object.entries(wg)) {
    const part = key.split('.').pop();
    const per = part === 'arm' || key === 'foot' ? 2 : 1;
    const cast = part === 'body' || part === 'head' || (!mobile && (key === 'axe' || key === 'club'));
    parts.push([key, geo, 4 * per, cast]);
  }
  parts.push(['lid', lidGeometry(), 16, false]);   // blinks: one shared lid ball, tinted per species / role

  const params = ctx.params || new URLSearchParams(location.search);
  const batched = !params.has?.('creaturesInstanced') && canBatch(ctx.renderer);
  const pools = {};     // key -> { push(matrix, flash, tint) }
  let drawers;          // things with begin() / end() around the per-frame writes
  if (batched) {
    const castBatch = new PartBatch(root, mat, parts.filter(p => p[3]), { cast: true, name: 'creatures:batch' });
    const flatBatch = new PartBatch(root, mat, parts.filter(p => !p[3]), { cast: false, name: 'creatures:batch-flat' });
    for (const [key, , , cast] of parts) pools[key] = (cast ? castBatch : flatBatch).slot(key);
    drawers = [castBatch, flatBatch];
  } else {
    // every casting pool is one more call in the shadow pass here: only bodies cast (heads, legs and tools rely
    // on the contact shadow), which keeps a full camp under 40 calls even without multi-draw
    for (const [key, geo, cap, cast] of parts) pools[key] = new PartPool(root, geo, mat, cap * 2, { cast: cast && key.endsWith('.body'), name: `creatures:${key}` });
    pools.bubble.mesh.receiveShadow = false;
    drawers = Object.values(pools);
  }
  const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, opacity: 0.3, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const shadowPool = new PartPool(root, new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), shadowMat, 32, { flash: false, receive: false, name: 'creatures:shadows', renderOrder: 1 });

  // carried items: the items module's instanced meshes (its own material), created on demand
  const itemPools = new Map();
  const fallbackGeo = new THREE.BoxGeometry(0.16, 0.16, 0.16).translate(0, 0.08, 0);
  function itemPool(id) {
    if (!id) return null;
    let p = itemPools.get(id);
    if (p) return p;
    let mesh = null;
    const make = cap => {
      try { mesh = views.items?.getInstanced?.(id, cap) || null; } catch { mesh = null; }
      if (!mesh) {
        mesh = new THREE.InstancedMesh(fallbackGeo, new THREE.MeshLambertMaterial({ color: config.ITEMS?.[id]?.color || '#ffffff' }), cap);
        mesh.frustumCulled = false; mesh.castShadow = true;
      }
      mesh.count = 0; mesh.visible = false; mesh.name = `creatures:carry:${id}`;
      mesh.raycast = () => {};
      root.add(mesh);
      return mesh;
    };
    p = {
      cap: 16, n: 0, mesh: make(16), grow: 0,
      begin() { this.n = 0; this.grow = 0; },
      push(m) { if (this.n >= this.cap) { this.grow = 1; return; } this.mesh.setMatrixAt(this.n++, m); },
      end() {
        if (this.grow) { root.remove(this.mesh); this.cap *= 2; this.mesh = make(this.cap); return; }
        if (this.n || this.mesh.count) { this.mesh.count = this.n; this.mesh.instanceMatrix.needsUpdate = true; }
        this.mesh.visible = this.n > 0;
      },
    };
    itemPools.set(id, p);
    return p;
  }

  // Camp works animals keep off (the sim's rule: every station's footprint, zone, line and pile, and every pad)
  const campTiles = new Set();
  const tileKey = (x, z) => x * 4096 + z;
  const addRect = r => { if (r) for (let i = 0; i < r[2]; i++) for (let j = 0; j < r[3]; j++) campTiles.add(tileKey(r[0] + i, r[1] + j)); };
  for (const def of Object.values(STATIONS)) {
    addRect(def.footprint); addRect(def.zone);
    for (const [x, z] of def.line || []) campTiles.add(tileKey(x, z));
    if (def.pile) campTiles.add(tileKey(def.pile[0], def.pile[1]));
  }
  for (const pd of PADS) addRect(pd.zone);

  // ---------- shared context for the controllers ----------
  const sys = {
    root, ctx, camp, camera, sizeK: mobile ? SIZE_MOBILE : 1,
    fx: () => views.fx,
    fxScale: () => (mobile ? 1.2 : 1),   // fx draws flights at this scale (FXK in fx.js)
    campTile: (x, z) => campTiles.has(tileKey(x, z)),
    playerPos() {
      let p = null;
      try { p = views.player?.getPosition?.() || null; } catch { p = null; }
      return p && Number.isFinite(p.x) ? p : (ctx.sim?.player ? { x: ctx.sim.player.x, z: ctx.sim.player.z } : null);
    },
    groundAt(x, z) {
      let y;
      try { y = views.terrain?.groundHeight?.(x, z); } catch { y = undefined; }
      if (!Number.isFinite(y)) return 0;
      return y < -0.1 ? 0 : y;
    },
    itemHeight: () => (Number.isFinite(views.items?.itemHeight) ? views.items.itemHeight : 0.2),
    // where an item a worker delivers into a station lands: the camp view's intake (rack / basket / hopper)
    stationPoint(id, out) {
      try {
        const cv = views.campview;
        const p = cv?.intakePoint?.(id, out) || cv?.inputPoint?.(id, out);
        if (p && Number.isFinite(p.x)) return out.set(p.x, Number.isFinite(p.y) ? p.y : 0.5, p.z);
      } catch { /* fall through */ }
      const s = camp.stations?.get?.(id);
      const fp = s?.def?.footprint;
      if (!fp) return null;
      return out.set(fp[0] + (fp[2] - 1) / 2, 0.55, fp[1] + (fp[3] - 1) / 2);
    },
  };

  const animals = new Map();
  const workers = new Map();
  let live = false; // spawns emitted before the first frame (camp setup) appear in place, no hop
  const addAnimal = (a, spawn) => { if (!a || a.dead || animals.has(a.id)) return animals.get(a?.id); const v = new AnimalView(sys, a, { spawn }); animals.set(a.id, v); return v; };
  const addWorker = (w, hired) => { if (!w || workers.has(w.id)) return workers.get(w?.id); const v = new WorkerView(sys, w, { hired }); workers.set(w.id, v); return v; };
  for (const a of camp.animals.values()) addAnimal(a, false);
  for (const w of camp.workers.values()) addWorker(w, false);

  const attackerPos = by => {
    if (by === 'player' || by == null) return sys.playerPos();
    const w = camp.workers?.get?.(by);
    return w ? { x: w.x, z: w.z } : null;
  };

  const offs = [];
  const on = (type, fn) => { const off = events.on(type, e => { try { fn(e || {}); } catch (err) { console.error(`[creatures] ${type}`, err); } }); if (typeof off === 'function') offs.push(off); };
  on('animal:spawned', ({ animal }) => addAnimal(animal, live));
  on('animal:hit', ({ animal, by }) => {
    const v = animals.get(animal?.id) || addAnimal(animal, false);
    v?.hit(attackerPos(by), animal.hp <= 0);
  });
  on('animal:killed', ({ animal, by }) => {
    const v = animals.get(animal?.id);
    v?.kill(attackerPos(by));
  });
  on('animal:removed', ({ animal }) => {
    const v = animals.get(animal?.id);
    if (!v) return;
    if (v.life === 'dying') { v.removeWhenGone = true; return; }
    v.dispose(); animals.delete(animal.id);
  });
  on('camp:swing', e => {
    if (e.target?.type === 'animal') animals.get(e.target.id)?.threatened();
    if (e.by && e.by !== 'player') workers.get(e.by)?.swing(e);
  });
  on('worker:hired', ({ worker }) => addWorker(worker, true));
  on('worker:state', ({ worker }) => workers.get(worker?.id)?.onState(worker.state));
  on('worker:carry', ({ worker, item, n }) => workers.get(worker?.id)?.onCarry(item, Math.max(0, n | 0)));
  on('worker:hungry', ({ worker }) => workers.get(worker?.id)?.onHungry());
  on('worker:ate', ({ worker }) => workers.get(worker?.id)?.onAte());
  on('station:drop', ({ station, item, by }) => { if (by && workers.has(by)) workers.get(by).onDrop(station, item); });

  // ---------- frame ----------
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
  const sh = {};
  function pushShadow(o) {
    if (!o) return;
    _q.setFromAxisAngle(_up, -o.h);
    _m.compose(_p.set(o.x, o.y + 0.014, o.z), _q, _s.set(o.sx, 1, o.sz));
    shadowPool.push(_m);
  }

  function update(dt) {
    live = true;
    // keep in sync with the sim even if an event was missed
    for (const a of camp.animals.values()) if (!a.dead && !animals.has(a.id)) addAnimal(a, false);
    for (const [id, v] of animals) {
      if ((v.life === 'gone' && (v.removeWhenGone || !camp.animals.has(id))) || (!camp.animals.has(id) && v.life !== 'dying')) { v.dispose(); animals.delete(id); }
    }
    for (const w of camp.workers.values()) if (!workers.has(w.id)) addWorker(w, false);
    for (const [id, v] of workers) if (!camp.workers.has(id)) { v.dispose(); workers.delete(id); }

    for (const v of animals.values()) v.update(dt);
    for (const v of workers.values()) v.update(dt);

    for (const d of drawers) d.begin();
    shadowPool.begin();
    for (const p of itemPools.values()) p.begin();
    for (const v of animals.values()) { v.write(pools); pushShadow(v.shadow(sh)); }
    for (const v of workers.values()) { v.write(pools, itemPool); pushShadow(v.shadow(sh)); }
    for (const d of drawers) d.end();
    shadowPool.end();
    for (const p of itemPools.values()) p.end();
  }

  const meshes = () => [...drawers.map(d => d.mesh), shadowPool.mesh, ...[...itemPools.values()].map(p => p.mesh)];
  return {
    animalObject: id => animals.get(id)?.root || null,
    workerObject: id => workers.get(id)?.root || null,
    animalCenter: (id, out = new THREE.Vector3()) => animals.get(id)?.centerWorld(out) || null,
    workerStackTop: (id, out = new THREE.Vector3()) => workers.get(id)?.stackTop(out) || null,
    stats() {
      const vis = meshes().filter(m => m.visible && (m.isBatchedMesh || m.count > 0));
      return { animals: animals.size, workers: workers.size, drawCalls: vis.length, shadowCalls: vis.filter(m => m.castShadow).length, batched, meshes: meshes().length };
    },
    _animals: animals, _workers: workers,
    update,
    dispose() { offs.forEach(f => f()); scene.remove(root); },
  };
}
