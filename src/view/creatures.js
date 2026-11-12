// Creatures: the camp's animals (deer, boar, rabbit) and workers (lumberjack, hunter), drawn from camp state
// (ctx.camp, GAMEPLAY.md) with smooth, springy animation. Inactive outside camp mode.
//
// Rendering: every creature is an invisible Object3D rig (src/view/creatures/animals.js, workers.js); each
// frame the rigs' part matrices are written into one InstancedMesh per part type (src/view/creatures/kit.js
// PartPool), so all animals of a species share ~5 draw calls and the whole module stays well under 40.
// A per-instance `iFlash` attribute gives the white hit flash. Contact shadows are one instanced quad.
//
// Events: animal:spawned (hop in from a dust puff), animal:hit (flash, squash, knockback hop),
// animal:killed (squash + POOF, the fx module flies the drumsticks), animal:removed, camp:swing (target flinches;
// worker swings), worker:hired (hop out of the hut door), worker:state, worker:carry (items fly onto the rack),
// worker:hungry / worker:ate (thought bubble, munch), station:drop by a worker (items fly into the station).
//
// API: views.creatures = { animalObject(id), workerObject(id), animalCenter(id, out?), workerStackTop(id, out?),
//   update, stats() }
import * as THREE from 'three';
import { creatureMaterial, PartPool, shadowTexture } from './creatures/kit.js';
import { buildAnimalGeometries } from './creatures/animal-models.js';
import { buildWorkerGeometries } from './creatures/worker-models.js';
import { AnimalView } from './creatures/animals.js';
import { WorkerView } from './creatures/workers.js';

const SIZE_MOBILE = 1.22;   // portrait phones sit farther out: creatures a touch bigger there

export function create(ctx) {
  const camp = ctx.camp;
  if (!camp) return {};
  const { scene, events, views, camera, map, config } = ctx;
  const mobile = !!ctx.mobile || ctx.quality?.tier === 'mobile';
  const q = { seg: mobile ? 8 : 10 };

  const root = new THREE.Group();
  root.name = 'creatures';
  scene.add(root);
  const mat = creatureMaterial();

  // ---------- pools ----------
  const ag = buildAnimalGeometries(q);
  const wg = buildWorkerGeometries(q);
  const pools = {};
  const CAST = new Set(['body', 'head', ...(mobile ? [] : ['leg'])]);
  for (const [kind, parts] of Object.entries(ag)) {
    for (const [part, geo] of Object.entries(parts)) {
      const per = part === 'leg' ? 4 : part === 'ear' || part === 'foot' ? 2 : 1;
      pools[`${kind}.${part}`] = new PartPool(root, geo, mat, 16 * per, { cast: CAST.has(part), name: `creatures:${kind}.${part}` });
    }
  }
  for (const [key, geo] of Object.entries(wg)) {
    const part = key.split('.').pop();
    const per = part === 'arm' || key === 'foot' ? 2 : 1;
    const cast = part === 'body' || part === 'head' || (!mobile && (key === 'axe' || key === 'club'));
    pools[key] = new PartPool(root, geo, mat, 6 * per, { cast, name: `creatures:${key}` });
  }
  pools.bubble.mesh.castShadow = false; pools.bubble.mesh.receiveShadow = false;
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

  // ---------- shared context for the controllers ----------
  const tmp = new THREE.Vector3();
  const sys = {
    root, ctx, camp, camera, sizeK: mobile ? SIZE_MOBILE : 1,
    fx: () => views.fx,
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
    // where an item delivered into a station flies to
    stationPoint(id, out) {
      try { const p = views.campview?.inputPoint?.(id) || views.campview?.dropPoint?.(id); if (p && Number.isFinite(p.x)) return out.set(p.x, p.y ?? 0.5, p.z); } catch { /* fall through */ }
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

    for (const p of Object.values(pools)) p.begin();
    shadowPool.begin();
    for (const p of itemPools.values()) p.begin();
    for (const v of animals.values()) { v.write(pools); pushShadow(v.shadow(sh)); }
    for (const v of workers.values()) { v.write(pools, itemPool); pushShadow(v.shadow(sh)); }
    for (const p of Object.values(pools)) p.end();
    shadowPool.end();
    for (const p of itemPools.values()) p.end();
  }

  return {
    animalObject: id => animals.get(id)?.root || null,
    workerObject: id => workers.get(id)?.root || null,
    animalCenter: (id, out = new THREE.Vector3()) => animals.get(id)?.centerWorld(out) || null,
    workerStackTop: (id, out = new THREE.Vector3()) => workers.get(id)?.stackTop(out) || null,
    stats() {
      const all = [...Object.values(pools), shadowPool, ...itemPools.values()];
      return { animals: animals.size, workers: workers.size, drawCalls: all.filter(p => p.mesh.visible && p.mesh.count > 0).length, meshes: all.length };
    },
    _animals: animals, _workers: workers,
    update,
    dispose() { offs.forEach(f => f()); scene.remove(root); },
  };
}
