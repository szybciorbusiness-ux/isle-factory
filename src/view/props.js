// Resource props: trees, rocks, stumps + deposit nuggets. All instanced (one InstancedMesh per variant);
// animated props write their own instance matrix every frame while they move, then go back to rest.
// Reactions: resource:hit (wobble / jolt / shiver), resource:depleted (tree fall, rock crumble,
// stump pop), deposit:mined (nugget jiggle). Hover highlight via setHover(id). See DESIGN.md "props".
//
// Per-instance shader data lives in one vec3 attribute `aFx` = (leaf shiver, highlight glow, wind sway).
//
// Performance: every batch draws only the props whose bounds (prop + the shadow it throws) touch the view
// frustum (cull(), re-run by post.js right before rendering); phones put only props inside the sun's shadow
// frustum into the shadow map. Phone trees are ~370 tris with a ~100-tri shadow proxy (props/geo.js lod
// 'mobile', swapped in through the draw range in onBeforeShadow). views.props.drawStats reports the counts.
import * as THREE from 'three';
import { buildTree, buildRock, buildStump, buildNugget } from './props/geo.js';
import { Spring, Wobble, ease, clamp, lerp, arc } from '../util/anim.js';
import { hash2, mulberry32 } from '../util/noise.js';

const TREE_VARIANTS = 4, ROCK_VARIANTS = 4;

// Tree fall timeline (seconds) for a fall onto open ground. The crown first touches the ground ~0.43 s after the
// final blow (hit-stop 0.05 + antic + fall) and that is when the logs burst out and fly to the pack (flightDelay):
// "tree gives logs" reads at once. The felled log bounces, then swells and shrinks away (pop: landing -> vanish).
const FALL = { antic: 0.08, fall: 0.3, b1: 0.2, b2: 0.12, rest: 0.12, grow: 0.08, shrink: 0.28, lean: 0.075, land: 1.36, bounce1: 0.15, bounce2: 0.05, pop: 0.16, popWater: 0.32, popLean: 0.42, release: -0.03 };
FALL.tLand = FALL.antic + FALL.fall;
FALL.tVanish = FALL.tLand + FALL.b1 + FALL.b2 + FALL.rest;
const WATER_LAND = 1.64;   // a crown over water sinks past the ground angle until it rests on the surface
const LEAN_MIN = 0.5;      // a tree caught by a neighbour leans at least this much (~61 degrees above ground), shoving the neighbour's crown
const LEAN_MAX = FALL.land - 0.16;
// rough shapes of buildings a felled tree can lean on: [height, half width]
const BUILD_SHAPE = { drill: [1.0, 0.4], chest: [0.66, 0.38], workshop: [1.08, 0.44], belt: [0.12, 0.48] };
// Which way a felled tree falls (planFall): the cheapest of 8 directions. Away from whoever swung is free, toward
// them costs up to 2; across the screen is free, toward the camera costs `toward`, away from it `away` (from the
// high camera a tree falling south reads as its crown sliding down the screen with the trunk hidden under it, one
// falling north barely changes its outline; one falling east / west visibly lies down, trunk and all). So a blow
// from the north or south tips the tree sideways when that way is open. Diagonals only when the straight ways are
// blocked. A blocked way (the crown would rest on a neighbour) is taken only when every way is blocked: then the
// one that lets it fall furthest. `cover`: the felled log would lie on / right next to the swinger (Dug never gets
// a tree on his feet). `hidden`: per tree standing just in front of (south of) where the crown lands.
const FALL_PREF = { toward: 1.2, away: 1.3, diag: 0.6, water: 0.04, blocked: 10, cover: 1.5, hidden: 0.05 };
const STATION_H = 1.1;     // camp stations (sim.blockers tiles) as obstacles: height, tile half width
const STATION_R = 0.5;

// Hover highlight
const HOVER = { in: 0.16, out: 0.24, scale: 0.05, pulseHz: 1.15 };

// Gather juice (FIRST-20.md "Feel"): every hit freezes the target in its struck pose for a couple of frames
// (hit-stop), flashes it white and throws chips / leaves; the final blow freezes longer, bursts bigger and
// gives the camera one small shake (player hits only).
const HIT = { stop: 0.03, stopFinal: 0.05, white: 1, whiteDecay: 14, shake: 0.03 };

// Regrowth (camp): a sapling sprouts with a little leaf burst, holds a beat, then grows to full size with a
// springy overshoot (~1.2 s); the stump it replaces sinks and shrinks away under it. Rocks rise out of a dust puff.
const GROW = { delay: 0.12, sprout: 0.18, hold: 0.14, grow: 0.88, sap: 0.26, sapStretch: 1.32 };
GROW.total = GROW.sprout + GROW.hold + GROW.grow;
const SINK = { grow: 0.06, shrink: 0.34, depth: 0.1 };
const RISE = { lead: 0.05, dur: 0.5, from: 0.72, scale0: 0.7 };

// "Not now": brushing a rock while stone has no use yet gives a tiny wobble, never a hit.
const BRUSH = { dist: 0.9, release: 1.02, cooldown: 0.7, wobble: 0.03 };

const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _qy = new THREE.Quaternion();
const _qt = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _p = new THREE.Vector3(), _v = new THREE.Vector3(), _s = new THREE.Vector3(), _ax = new THREE.Vector3(), _ax2 = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const smooth = t => t * t * (3 - 2 * t);

export function create(ctx) {
  const { scene, sim, events, config, map, views } = ctx;
  const P = config.PALETTE;
  const DIRS = config.DIRS;
  const WATER_Y = config.WATER_Y ?? -0.32;
  // phone tier: lighter trees, shadows only from props near the camera target
  const MOBILE = ctx.quality?.tier === 'mobile' || (!ctx.quality?.tier && !!ctx.mobile);
  let live = false; // events before the first frame (scenario setup) apply instantly, without animation

  // ---------------- materials ----------------
  // Wind: the world's shared gust field (views.terrain.wind, src/view/world/wind.js) so trees lean in the
  // same rolling gust fronts that sweep the grass; the clock follows terrain's dt-advanced wind time.
  // Without it, a gentle gust field of our own.
  const tWind = views.terrain?.wind;
  const worldWind = typeof tWind?.glsl === 'string' && /float\s+windGust\s*\(/.test(tWind.glsl)
    && /uniform\s+float\s+uWindTime/.test(tWind.glsl) ? tWind.glsl : null;
  const wd = Array.isArray(tWind?.params?.dir) ? tWind.params.dir : [0.9, 0.44];
  const windU = {
    uWindTime: { value: 0 },
    uWindAmp: { value: 1 },
    uWindDir: { value: new THREE.Vector2(wd[0], wd[1]).normalize() },
  };
  const windHeader = worldWind || /* glsl */`
    uniform float uWindTime;
    float windGust(vec2 p) { return 0.25 + 0.25 * sin(uWindTime * 0.37 + p.x * 0.11 - p.y * 0.07) + 0.2 * sin(uWindTime * 0.9 - p.x * 0.3); }`;
  const swayGlsl = withGlow => /* glsl */`
    #include <begin_vertex>
    {
      float hgt = max(transformed.y - 0.32, 0.0);
      vec3 ip = vec3(0.0);
      mat3 im = mat3(1.0);
      #ifdef USE_INSTANCING
        ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        im = mat3(instanceMatrix);
      #endif
      float s2 = max(dot(im[0], im[0]), 1e-4);
      float ph = ip.x * 0.55 + ip.z * 0.35;
      float gust = clamp(windGust(ip.xz), 0.0, 1.0);
      // world wind direction (and its perpendicular) in this instance's local space
      vec3 wl = (vec3(uWindDir.x, 0.0, uWindDir.y) * im) / s2;
      vec3 wp = (vec3(-uWindDir.y, 0.0, uWindDir.x) * im) / s2;
      float k = hgt * hgt * 0.017 * uWindAmp * aFx.z;
      // a steady lean downwind that deepens as a gust front rolls through, plus a slow rocking
      float sway = 0.3 + 0.95 * gust + sin(uWindTime * 1.3 + ph) * (0.2 + 0.3 * gust) + sin(uWindTime * 2.1 + ph * 1.7) * 0.1;
      transformed += wl * (sway * k) + wp * (sin(uWindTime * 1.6 + ph * 1.3) * k * 0.25);
      // leaf flutter rippling through the crown, stronger in gusts
      float fl = hgt * 0.006 * uWindAmp * aFx.z * (0.35 + gust);
      transformed.x += sin(uWindTime * 5.3 + position.y * 7.0 + position.z * 5.0 + ph) * fl;
      transformed.z += cos(uWindTime * 4.4 + position.x * 6.0 + position.y * 3.0 + ph) * fl;
      // hit shiver
      float sh = aFx.x * hgt;
      transformed.x += sin(uWindTime * 37.0 + position.y * 9.0 + position.z * 7.0) * sh * 0.06;
      transformed.z += cos(uWindTime * 31.0 + position.x * 8.0 + position.y * 6.0) * sh * 0.06;
      transformed.y += sin(uWindTime * 43.0 + position.x * 11.0) * sh * 0.025;
      ${withGlow ? 'vGlow = aFx.y;' : ''}
    }`;
  // vGlow 0..1 = highlight (hover / soft flash); 1..2 = full highlight blending toward a warm white (hit flash)
  const flashU = { uFlashCol: { value: new THREE.Vector3(1.0, 0.985, 0.94) } };
  const glowFrag = shader => {
    Object.assign(shader.uniforms, flashU);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGlow;\nuniform vec3 uGlowMul;\nuniform vec3 uGlowAdd;\nuniform vec3 uFlashCol;')
      .replace('#include <opaque_fragment>', [
        'outgoingLight = mix(outgoingLight, outgoingLight * uGlowMul + uGlowAdd, min(vGlow, 1.0));',
        // hit flash: brighten (keeps hue + shading) and, only near the peak, blend toward warm white
        '{ float wf = clamp(vGlow - 1.0, 0.0, 1.0); float lum = dot(outgoingLight, vec3(0.3, 0.59, 0.11));',
        '  vec3 wcol = uFlashCol * clamp(0.62 + lum * 1.2, 0.0, 1.0);',
        '  outgoingLight = mix(outgoingLight * (1.0 + 0.6 * wf), wcol, wf * wf * 0.62); }',
        '#include <opaque_fragment>'].join('\n'));
  };
  // highlight = a sunny brighten that keeps saturation (mostly multiply, a little warm lime added)
  const leafGlow = { uGlowMul: { value: new THREE.Vector3(1.24, 1.3, 1.04) }, uGlowAdd: { value: new THREE.Vector3(0.03, 0.045, 0.0) } };
  const rockGlow = { uGlowMul: { value: new THREE.Vector3(1.1, 1.08, 1.0) }, uGlowAdd: { value: new THREE.Vector3(0.075, 0.065, 0.03) } };
  const injectLeaf = (withGlow, glowU) => shader => {
    Object.assign(shader.uniforms, windU, glowU || {});
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${windHeader}\nuniform float uWindAmp;\nuniform vec2 uWindDir;\nattribute vec3 aFx;${withGlow ? '\nvarying float vGlow;' : ''}`)
      .replace('#include <begin_vertex>', swayGlsl(withGlow));
    if (withGlow) glowFrag(shader);
  };
  // leaves: smooth (bent) normals from the geometry, so the crown reads as a few big soft planes
  const leafMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  leafMat.onBeforeCompile = injectLeaf(true, leafGlow);
  leafMat.customProgramCacheKey = () => `props-tree-v9-${worldWind ? 'w' : 'o'}`;
  const leafDepth = new THREE.MeshDepthMaterial();
  leafDepth.onBeforeCompile = injectLeaf(false);
  leafDepth.customProgramCacheKey = () => `props-tree-v9-depth-${worldWind ? 'w' : 'o'}`;
  // rocks + stumps: flat facets, highlight only
  const propMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  // + a warm bounce light proportional to the albedo, strongest on side faces: the green hemisphere ground
  // light turns cream rock olive otherwise (the reference's rock sides are warm ochre)
  const warmU = { uWarm: { value: new THREE.Vector3(0.21, 0.09, 0.0) } };
  propMat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, rockGlow, warmU);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aFx;\nvarying float vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aFx.y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uWarm;')
      .replace('#include <opaque_fragment>', [
        'float sideK = 1.0 - clamp(dot(normal, normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz)), 0.0, 1.0);',
        'outgoingLight += diffuseColor.rgb * uWarm * (0.35 + 0.65 * sideK);',
        '#include <opaque_fragment>'].join('\n'));
    glowFrag(shader);
  };
  propMat.customProgramCacheKey = () => 'props-solid-glow-v8';
  const nuggetMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

  let cullDirty = true;   // a prop was added / removed / started an animation that ignores culling

  // ---------------- instanced batches ----------------
  // Slots [0, n) hold live props. Every frame cull() reorders them (swaps only when the sets change) so the
  // ones on screen come first and, among those, the shadow casters first: the main pass draws `vis`
  // instances, the shadow pass `shad` (onBeforeShadow swaps the count, and for phone trees the geometry's
  // draw range to the cheap shadow proxy).
  class Batch {
    constructor(geo, mat, cap, { cast = true, receive = false, depth = null } = {}) {
      this.geo = geo;
      cap = Math.max(1, cap);
      const m = this.mesh = new THREE.InstancedMesh(geo, mat, cap);
      m.count = 0; m.frustumCulled = false; m.castShadow = cast; m.receiveShadow = receive;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      if (depth) m.customDepthMaterial = depth;
      this.fx = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      this.fx.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aFx', this.fx);
      this.recs = [];
      this.n = 0; this.vis = 0; this.shad = 0;
      this.dirty = false;
      const main = geo.userData.mainRange, shadow = geo.userData.shadowRange;
      const swapRange = main && shadow && (main[0] !== shadow[0] || main[1] !== shadow[1]);
      m.onBeforeShadow = () => { m.count = this.shad; if (swapRange) geo.drawRange.start = shadow[0], geo.drawRange.count = shadow[1]; };
      m.onAfterShadow = () => { m.count = this.vis; if (swapRange) geo.drawRange.start = main[0], geo.drawRange.count = main[1]; };
      scene.add(m);
    }
    add(rec, matrix) {
      if (this.n >= this.mesh.instanceMatrix.count) return false;
      rec.slot = this.n++;
      rec.batch = this;
      rec.cv = true; rec.cs = true; // drawn until the next cull says otherwise
      this.recs[rec.slot] = rec;
      this.mesh.setMatrixAt(rec.slot, matrix);
      this.mesh.setColorAt(rec.slot, rec.tint);
      this.setFx(rec);
      this.counts(this.n, this.n);
      cullDirty = true;
      return true;
    }
    remove(rec) {
      if (rec.batch !== this) return;
      const last = this.n - 1, i = rec.slot;
      if (i !== last) {
        const moved = this.recs[last];
        this.mesh.getMatrixAt(last, _m); this.mesh.setMatrixAt(i, _m);
        this.recs[i] = moved; moved.slot = i;
        this.mesh.setColorAt(i, moved.tint);
        this.setFx(moved);
      }
      this.recs.length = last;
      this.n = last;
      rec.batch = null; rec.slot = -1;
      this.counts(Math.min(this.vis, last), Math.min(this.shad, last));
      this.dirty = true;
      cullDirty = true;
    }
    // swap two slots (matrix, colour, fx, record)
    swap(i, j) {
      const A = this.mesh.instanceMatrix.array, C = this.mesh.instanceColor.array, F = this.fx.array;
      for (let k = 0; k < 16; k++) { const t = A[i * 16 + k]; A[i * 16 + k] = A[j * 16 + k]; A[j * 16 + k] = t; }
      for (let k = 0; k < 3; k++) {
        let t = C[i * 3 + k]; C[i * 3 + k] = C[j * 3 + k]; C[j * 3 + k] = t;
        t = F[i * 3 + k]; F[i * 3 + k] = F[j * 3 + k]; F[j * 3 + k] = t;
      }
      const ri = this.recs[i], rj = this.recs[j];
      this.recs[i] = rj; rj.slot = i;
      this.recs[j] = ri; ri.slot = j;
      this.dirty = true;
    }
    // partition by the flags cull() set on each record: [shadow casters | other visible | hidden]
    partition() {
      const R = this.recs, n = this.n;
      let v = 0;
      for (let i = 0; i < n; i++) if (R[i].cv) { if (i !== v) this.swap(i, v); v++; }
      let s = 0;
      for (let i = 0; i < v; i++) if (R[i].cs) { if (i !== s) this.swap(i, s); s++; }
      this.counts(v, s);
    }
    counts(v, s) {
      this.vis = v; this.shad = s;
      this.mesh.count = v;
      // only on a change, so tools that hide meshes for a measurement (debug/profile.js) aren't overridden
      const show = v > 0;
      if (show !== this.shown) { this.shown = show; this.mesh.visible = show; }
    }
    write(rec, matrix) { this.mesh.setMatrixAt(rec.slot, matrix); this.dirty = true; }
    setFx(rec) { this.fx.setXYZ(rec.slot, rec.shiver, rec.glow, rec.sway); this.dirty = true; }
    flush() {
      if (!this.dirty) return;
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.needsUpdate = true;
      this.fx.needsUpdate = true;
      this.dirty = false;
    }
  }

  const resources = [...sim.entities.values()].filter(e => e.resource);
  const nTrees = resources.filter(e => e.kind === 'tree').length;
  const count = (kind, v) => resources.filter(e => e.kind === kind && (e.variant % (kind === 'tree' ? TREE_VARIANTS : ROCK_VARIANTS)) === v).length;
  // phones: ~370-tri trees with a ~100-tri shadow proxy (props/geo.js lod 'mobile')
  const treeGeos = Array.from({ length: TREE_VARIANTS }, (_, v) => buildTree(v, 11, { lod: MOBILE ? 'mobile' : 'full' }));
  const rockGeos = Array.from({ length: ROCK_VARIANTS }, (_, v) => buildRock(v));
  const stumpGeo = buildStump();
  const treeBatches = treeGeos.map((g, v) => new Batch(g, leafMat, count('tree', v) + 2, { depth: leafDepth }));
  const rockBatches = rockGeos.map((g, v) => new Batch(g, propMat, count('rock', v) + 2, { receive: true }));
  const stumpBatch = new Batch(stumpGeo, propMat, nTrees + resources.filter(e => e.kind === 'stump').length + 4, { receive: true });
  const batchFor = e => (e.kind === 'tree' ? treeBatches[e.variant % TREE_VARIANTS] : e.kind === 'rock' ? rockBatches[e.variant % ROCK_VARIANTS] : stumpBatch);
  const allBatches = [...treeBatches, ...rockBatches, stumpBatch];
  const treeGeo = rec => treeGeos[rec.e.variant % TREE_VARIANTS].userData;

  // ---------------- records ----------------
  const recs = new Map();      // entity id -> rec (also keeps dying props until their animation ends)
  const active = new Set();    // recs animating this frame
  const falling = new Map();   // tile index -> falling tree rec (for flightDelay / flightOrigin)
  const fallLog = [];          // test/debug: the last felled trees' plans (views.props.fallLog)

  function makeRec(e) {
    const rng = mulberry32((e.x * 73856093) ^ (e.z * 19349663) ^ (e.kind.length * 83492791));
    const tint = new THREE.Color(1, 1, 1);
    if (e.kind === 'tree') { const k = 0.95 + rng() * 0.1; tint.setRGB(k * (0.97 + rng() * 0.06), k, k * (0.96 + rng() * 0.08)); }
    else tint.setScalar(0.97 + rng() * 0.05);
    // rocks only rotate in coarse steps so their lit faces stay on the sun side
    const rot = e.kind === 'rock' ? Math.round(e.rot / (Math.PI / 3)) * (Math.PI / 3) * 0.35 : e.rot;
    const rec = {
      id: e.id, e, kind: e.kind, x: e.x, z: e.z, rot, scale: e.scale || 1,
      tint, batch: null, slot: -1, handle: new THREE.Object3D(),
      wob: new Wobble({ freq: e.kind === 'tree' ? 2.6 : 5, decay: e.kind === 'tree' ? 4.2 : 7 }),
      sq: new Spring(1, { stiffness: 320, damping: 13 }),
      size: new Spring(1, { stiffness: 260, damping: 12 }),
      jolt: new Spring(0, { stiffness: 420, damping: 17 }),
      pop: new Spring(1, { stiffness: 250, damping: 13 }),
      hovScale: new Spring(1, { stiffness: 300, damping: 12 }),
      hovTarget: 0, hovLin: 0, hovT: 0,
      flash: 0, shiver: 0, glow: 0, sway: e.kind === 'tree' ? 1 : 0, dirX: 0, dirZ: 1,
      fall: null, vanish: null, appearDelay: 0, dead: false,
      white: 0, stop: 0,          // hit flash toward white (0..1), hit-stop seconds left
      grow: null, sink: null,     // regrowth: sapling / rock rise in, replaced stump sinking out
      byPlayer: false, brush: false, brushT: 0,
    };
    rec.handle.userData = { entityId: e.id, kind: e.kind };
    rec.handle.matrixAutoUpdate = false;
    // culling bounds (unscaled): one sphere around the prop AND the shadow it throws toward the lower right
    const ud = (e.kind === 'tree' ? treeGeos[e.variant % TREE_VARIANTS] : e.kind === 'rock' ? rockGeos[e.variant % ROCK_VARIANTS] : stumpGeo).userData;
    rec.bH = ud.height || 0.5;
    rec.bR = (e.kind === 'tree' ? ud.crownR : ud.radius || 0.32) + 0.25;
    return rec;
  }

  // o.tilt tips the top toward (rec.dirX, rec.dirZ) about the pivot; o.tilt2 adds a tip toward (o.d2x, o.d2z)
  // (a felled tree blending out of the last blow's wobble when it falls another way)
  function compose(rec, o = {}) {
    const tilt = o.tilt || 0, k = (o.sizeK ?? 1) * rec.scale;
    const sy = o.sy ?? 1, sxz = o.sxz ?? 1;
    _qy.setFromAxisAngle(UP, rec.rot);
    _ax.set(rec.dirZ, 0, -rec.dirX); // rotating +tilt about this axis tips the top toward (dirX, dirZ)
    _qt.setFromAxisAngle(_ax, tilt);
    if (o.tilt2) { _ax2.set(o.d2z, 0, -o.d2x); _qt.multiply(_q2.setFromAxisAngle(_ax2, o.tilt2)); }
    _q.copy(_qt).multiply(_qy);
    _p.set(o.pivotX || 0, 0, o.pivotZ || 0);
    _v.copy(_p).applyQuaternion(_qt);
    _s.set(k * sxz, k * sy, k * sxz);
    _m.compose(_v.set(rec.x + _p.x - _v.x + (o.offX || 0), (o.offY || 0) + _p.y - _v.y, rec.z + _p.z - _v.z + (o.offZ || 0)), _q, _s);
    if (o.shrink !== undefined && o.shrink !== 1) {
      // scale about a world point (fallen log centre)
      const [cx, cy, cz] = o.shrinkAt;
      _m2.makeTranslation(-cx, -cy, -cz); _m.premultiply(_m2);
      _m2.makeScale(o.shrink, o.shrink, o.shrink); _m.premultiply(_m2);
      _m2.makeTranslation(cx, cy, cz); _m.premultiply(_m2);
    }
    return _m;
  }
  function writeRec(rec, o) {
    const m = compose(rec, o);
    if (rec.batch) rec.batch.write(rec, m);
    rec.handle.matrix.copy(m);
    rec.handle.matrixWorld.copy(m);
    m.decompose(rec.handle.position, rec.handle.quaternion, rec.handle.scale);
  }

  function addResource(e, { appear = false, delay = 0, grow = false } = {}) {
    const rec = makeRec(e);
    recs.set(e.id, rec);
    const b = batchFor(e);
    if (grow && live) {
      // regrowth: starts invisible, sprouts / rises in stepGrow
      rec.grow = { t: -Math.max(0, delay), kind: e.kind, sprouted: false, landed: false, done: false };
      if (e.kind === 'tree') rec.sway = 0.25;
      b.add(rec, compose(rec, { sizeK: 0.0001 }));
      active.add(rec);
    } else if (appear && live) {
      rec.pop.set(0); rec.appearDelay = Math.max(delay, 1e-6);
      b.add(rec, compose(rec, { sizeK: 0.0001 }));
      active.add(rec);
    } else {
      b.add(rec, compose(rec));
      writeRec(rec);
    }
    if (hoverId === e.id) setHoverTarget(rec, 1);
    return rec;
  }
  function removeRec(rec) {
    rec.batch?.remove(rec);
    active.delete(rec);
    if (recs.get(rec.id) === rec) recs.delete(rec.id);
    for (const [k, r] of falling) if (r === rec) falling.delete(k);
  }

  // ---------------- hover highlight ----------------
  let hoverId = null, hoverExplicit = false;
  function setHoverTarget(rec, on) {
    if (!rec || rec.hovTarget === on) return;
    rec.hovTarget = on;
    if (on) { rec.hovT = 0; if (live) rec.hovScale.kick(0.4); }
    active.add(rec);
  }
  function applyHover(id) {
    id = id ?? null;
    if (id === hoverId) return;
    setHoverTarget(hoverId != null ? recs.get(hoverId) : null, 0);
    hoverId = id;
    const rec = id != null ? recs.get(id) : null;
    if (rec && !rec.dead) setHoverTarget(rec, 1);
  }

  for (const e of resources) addResource(e);

  // ---------------- deposits ----------------
  const nuggetGeos = { 1: buildNugget('copper'), 2: buildNugget('stone') };
  const depTiles = new Map(); // idx -> tile
  const depCounts = { 1: 0, 2: 0 };
  const depositList = [];
  for (let z = 0; z < map.h; z++) for (let x = 0; x < map.w; x++) {
    const d = map.depositAt(x, z);
    if (!d) continue;
    const rng = mulberry32(Math.floor(hash2(x, z, 991) * 1e9));
    // one ore clump per tile (a big nugget with mediums packed around it) + a few loose bits
    const pts = [];
    const cx = (rng() - 0.5) * 0.24, cz = (rng() - 0.5) * 0.24;
    const big = d === 1 ? 0.17 + rng() * 0.05 : 0.15 + rng() * 0.05;
    const fits = (px, pz, s) => Math.abs(px) < 0.43 - s * 0.5 && Math.abs(pz) < 0.43 - s * 0.5 && !pts.some(p => Math.hypot(p.ox - px, p.oz - pz) < (p.s + s) * 0.78);
    const push = (px, pz, s) => pts.push({ ox: px, oz: pz, s, rot: rng() * Math.PI * 2, tilt: (rng() - 0.5) * 0.5, bury: 0.22 + rng() * 0.2, slot: -1, phase: rng(), tint: 0.9 + rng() * 0.18 });
    push(cx, cz, big);
    const mids = 2 + Math.floor(rng() * 2);
    for (let i = 0, tries = 0; i < mids && tries < 40; tries++) {
      const s = 0.09 + rng() * 0.05, a = rng() * Math.PI * 2, r = (big + s) * (0.8 + rng() * 0.15);
      const px = cx + Math.cos(a) * r, pz = cz + Math.sin(a) * r;
      if (fits(px, pz, s)) { push(px, pz, s); i++; }
    }
    const loose = 1 + Math.floor(rng() * 2);
    for (let i = 0, tries = 0; i < loose && tries < 40; tries++) {
      const s = 0.05 + rng() * 0.03, px = (rng() - 0.5) * 0.78, pz = (rng() - 0.5) * 0.78;
      if (fits(px, pz, s)) { push(px, pz, s); i++; }
    }
    depCounts[d] += pts.length;
    depositList.push({ x, z, d, pts });
  }
  const nuggetBatches = {};
  const _c = new THREE.Color();
  for (const d of [1, 2]) {
    const m = new THREE.InstancedMesh(nuggetGeos[d], nuggetMat, Math.max(1, depCounts[d]));
    m.count = 0; m.frustumCulled = false; m.castShadow = false; m.receiveShadow = true;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, depCounts[d]) * 3).fill(1), 3);
    scene.add(m);
    nuggetBatches[d] = { mesh: m, dirty: false };
  }
  const _e = new THREE.Euler();
  function writeTile(tile) {
    const b = nuggetBatches[tile.d];
    const tau = tile.t, vis = Math.max(0, tile.vis.value);
    for (let i = 0; i < tile.pts.length; i++) {
      const p = tile.pts[i];
      let hop = 0, sy = 1;
      if (tile.jiggling) {
        const ti = tau - i * 0.035;
        if (ti > 0) {
          hop = ti < 0.26 ? arc(ti / 0.26) * (0.05 + p.phase * 0.04) : 0;
          sy = 1 + 0.3 * Math.exp(-7 * ti) * Math.sin(ti * Math.PI * 2 * 4.2);
        }
      }
      const s = p.s * vis;
      _e.set(p.tilt, p.rot, 0);
      _q.setFromEuler(_e);
      const sxz = 1 / Math.sqrt(Math.max(0.3, sy));
      _s.set(s * sxz, s * sy, s * sxz);
      _p.set(tile.x + p.ox, -p.s * p.bury + hop, tile.z + p.oz);
      _m.compose(_p, _q, s > 1e-4 ? _s : _s.setScalar(1e-4));
      b.mesh.setMatrixAt(p.slot, _m);
    }
    b.dirty = true;
  }
  for (const t of depositList) {
    const b = nuggetBatches[t.d];
    for (const p of t.pts) { p.slot = b.mesh.count++; b.mesh.setColorAt(p.slot, _c.setRGB(p.tint * 1.02, p.tint, p.tint * 0.97)); }
    const tile = { ...t, t: 0, jiggling: false, vis: new Spring(1, { stiffness: 240, damping: 15 }), active: false };
    depTiles.set(map.idx(t.x, t.z), tile);
    writeTile(tile);
  }
  const activeTiles = new Set();
  const tileAt = (x, z) => (map.inBounds(x, z) ? depTiles.get(map.idx(x, z)) : null);
  function setTileCovered(x, z, covered) {
    const tile = tileAt(x, z);
    if (!tile) return;
    tile.vis.target = covered ? 0 : 1;
    if (!live) { tile.vis.set(tile.vis.target); writeTile(tile); return; }
    if (!covered) tile.vis.value = Math.max(tile.vis.value, 0.55);
    activeTiles.add(tile);
  }
  for (const e of sim.entities.values()) if (!e.resource) setTileCovered(e.x, e.z, true);

  // ---------------- helpers ----------------
  const fx = () => views.fx;
  const dirOf = fromDir => DIRS[((fromDir ?? 1) % 4 + 4) % 4] || DIRS[1];
  const isGround = (x, z) => map.isGround(Math.round(x), Math.round(z));
  function topY(rec) {
    const g = rec.batch?.geo || batchFor(rec.e).geo;
    return (g.userData.height || 0.5) * rec.scale;
  }
  function crownPos(rec, out = new THREE.Vector3()) {
    return out.set(rec.x, treeGeo(rec).crownY * rec.scale, rec.z);
  }
  function hitPoint(id) {
    const rec = recs.get(id);
    if (rec && !rec.dead) {
      const y = rec.kind === 'tree' ? 0.32 * rec.scale : rec.kind === 'rock' ? topY(rec) * 0.5 : 0.14;
      return new THREE.Vector3(rec.x, y, rec.z);
    }
    const e = sim.entities.get(id);
    return e ? new THREE.Vector3(e.x, 0.3, e.z) : null;
  }
  // Dust on ground, a splash on water.
  function impactAt(x, z, { size = 0.15, count = 3, spread = 0.32, up = 0.35 } = {}) {
    if (isGround(x, z)) fx()?.puff?.(new THREE.Vector3(x, 0.05, z), { count, size, spread, up });
    else fx()?.splash?.(new THREE.Vector3(x, WATER_Y, z), { radius: 0.4 + spread * 0.5, count: count + 4, size: size * 0.75 });
  }

  // ---------------- felled tree: where does it stop? ----------------
  // Obstacle silhouette in the fall plane for the entity on a tile: horizontal half width and [y0, y1].
  function obstacleShape(e) {
    if (!e) return null;
    const rec = recs.get(e.id);
    if (e.kind === 'tree') {
      const g = treeGeos[e.variant % TREE_VARIANTS].userData, s = e.scale || 1;
      return { r: g.crownR * s * 0.8, y0: g.crownBase * s, y1: g.height * s, rec, tree: true };
    }
    if (e.kind === 'rock') {
      const g = rockGeos[e.variant % ROCK_VARIANTS].userData, s = e.scale || 1;
      return { r: (g.radius || 0.4) * s * 0.75, y0: 0, y1: g.height * s, rec };
    }
    if (e.kind === 'stump') return { r: 0.24, y0: 0, y1: 0.22, rec };
    const b = BUILD_SHAPE[e.kind] || [0.6, 0.4];
    return { r: b[1], y0: 0, y1: b[0], building: e.id };
  }
  // Everything a felled tree could come to rest on: the props / buildings on the 5x5 tiles around it and the
  // camp's station footprints (sim.blockers), each a vertical cylinder at its tile centre.
  function obstaclesAround(rec) {
    const out = [];
    for (let oz = -2; oz <= 2; oz++) for (let ox = -2; ox <= 2; ox++) {
      if (!ox && !oz) continue;
      const x = rec.x + ox, z = rec.z + oz;
      if (!map.inBounds(x, z)) continue;
      const e = sim.at?.(x, z);
      if (e && e.id !== rec.id) {
        const ob = obstacleShape(e);
        if (ob) { ob.cx = x; ob.cz = z; ob.id = e.id; out.push(ob); }
        continue;
      }
      if (sim.blockers?.has?.(map.idx(x, z))) out.push({ r: STATION_R, y0: 0, y1: STATION_H, station: true, cx: x, cz: z });
    }
    return out;
  }
  // First tilt angle at which the felled tree touches obstacle `ob`, which stands `ua` tiles ahead along the fall
  // axis and `wa` tiles to its side, or null. The obstacle is a vertical cylinder (radius ob.r, y0..y1); the
  // felled tree a chain of spheres along its axis (trunk, then the crown profile, squished a little).
  // The felled tree's spheres: distance along the axis and radius (trunk, then the crown profile squished a little,
  // foliage gives before it stops anything). One set per plan.
  function fallSamples(rec) {
    const g = treeGeo(rec), s = rec.scale, prof = g.profile;
    const H = g.height * s, ds = [], rs = [];
    for (let d = 0.15; d <= H; d += 0.1) {
      let r = 0.07 * s; // trunk
      if (d >= g.crownBase * s) { r = prof[0][1]; for (let i = 0; i < prof.length; i++) if (d >= prof[i][0] * s) r = prof[i][1]; r *= s * 0.7; }
      ds.push(d); rs.push(r);
    }
    return { ds, rs, H, pv: 0.1 * s, rMax: g.crownR * s * 0.7 };
  }
  // First tilt angle below `upTo` at which the felled tree touches obstacle `ob`, which stands `ua` tiles ahead
  // along the fall axis and `wa` tiles to its side, or null. The obstacle is a vertical cylinder (radius ob.r,
  // y0..y1). Coarse sweep, then refined to 0.01 rad.
  function contactTilt(S, ob, ua, wa, upTo = FALL.land) {
    const { ds, rs, H, pv, rMax } = S;
    if (wa - ob.r >= rMax || ua + ob.r + rMax <= 0 || ua - ob.r - rMax >= H + pv) return null;
    const touches = th => {
      const sn = Math.sin(th), cs = Math.cos(th);
      for (let i = 0; i < ds.length; i++) {
        const u = pv - pv * cs + ds[i] * sn, y = pv * sn + ds[i] * cs;
        const dh = Math.max(0, Math.hypot(u - ua, wa) - ob.r), dy = Math.max(ob.y0 - y, 0, y - ob.y1);
        if (dh * dh + dy * dy < rs[i] * rs[i]) return true;
      }
      return false;
    };
    const STEP = 0.04;
    for (let th = 0; th <= upTo + STEP; th += STEP) {
      if (!touches(th)) continue;
      for (let f = Math.max(0, th - STEP + 0.01); f < th; f += 0.01) if (touches(f)) return f < upTo ? f : null;
      return th < upTo ? th : null;
    }
    return null;
  }
  // Which way a felled tree falls and how far (see FALL_PREF). (hdx, hdz) = the blow's direction; (hx, hz) = where
  // the swinger stood (null: unknown, the blow's direction stands in). Returns the chosen direction, the mode
  // ('ground' | 'water' | 'lean') and the resting tilt. opts.onlyHit = the old rule (fall along the blow only).
  const S2 = Math.SQRT1_2;
  const FALL_DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1], [S2, S2], [-S2, S2], [-S2, -S2], [S2, -S2]];
  function planFall(rec, hdx, hdz, hx = null, hz = null, { onlyHit = false } = {}) {
    let ax = hdx, az = hdz;
    if (hx != null && hz != null) {
      const vx = rec.x - hx, vz = rec.z - hz, d = Math.hypot(vx, vz);
      if (d > 0.2) { ax = vx / d; az = vz / d; }
    }
    const obs = obstaclesAround(rec);
    const S = fallSamples(rec);
    const reach = S.H + 0.2;
    let best = null;
    for (const [dx, dz] of onlyHit ? [[hdx, hdz]] : FALL_DIRS) {
      // everything but the obstacles first: a way that can't beat the best even unblocked skips the contact sweeps
      let cost = (1 - (dx * ax + dz * az)) + (dz > 0 ? FALL_PREF.toward * dz : -FALL_PREF.away * dz) + (dx && dz ? FALL_PREF.diag : 0);
      if (hx != null && hz != null) {
        const rx = hx - rec.x, rz = hz - rec.z, u = rx * dx + rz * dz, w = Math.abs(rx * dz - rz * dx);
        if (u > -0.2 && u < reach) cost += FALL_PREF.cover * clamp((0.95 - w) / 0.2);
      }
      // tall trees one row nearer the camera than the landing crown hide it
      for (const k of [1, 2]) {
        const lx = Math.round(rec.x + dx * k), lz = Math.round(rec.z + dz * k) + 1;
        if (lx === rec.x && lz === rec.z) continue;
        if (sim.at?.(lx, lz)?.kind === 'tree') cost += FALL_PREF.hidden;
      }
      if (best && cost >= best.cost - 1e-6) continue;
      let block = null;
      for (const ob of obs) {
        const rx = ob.cx - rec.x, rz = ob.cz - rec.z;
        const th = contactTilt(S, ob, rx * dx + rz * dz, Math.abs(rx * dz - rz * dx), block ? block.th : LEAN_MAX);
        if (th !== null) block = { th, ob };
      }
      const water = !block && !isGround(rec.x + dx, rec.z + dz);
      if (water) cost += FALL_PREF.water;
      if (block) cost += FALL_PREF.blocked + (LEAN_MAX - block.th) * 2;
      if (!best || cost < best.cost - 1e-6) best = { dx, dz, block, water, cost };
    }
    const { dx, dz, block, water } = best;
    if (block) return { dx, dz, mode: 'lean', land: Math.max(LEAN_MIN, block.th), th0: block.th, ob: block.ob, obId: block.ob.id ?? null };
    return { dx, dz, mode: water ? 'water' : 'ground', land: water ? WATER_LAND : FALL.land };
  }

  // ---------------- reactions ----------------
  // Who swung at what: camp:swing lands `hitIn` s later as resource:hit. Only the player's blows shake the camera.
  // Where the swinger stood is kept too: a felled tree falls away from them (planFall).
  let clock = 0;
  const swingBy = new Map(); // entity id -> { by, t, hx, hz }
  const _hp = new THREE.Vector3();
  function playerXZ() {
    let p = null;
    try { p = views.player?.getPosition?.(_hp) || null; } catch { p = null; }
    if (p && Number.isFinite(p.x) && Number.isFinite(p.z)) return [p.x, p.z];
    return sim.player ? [sim.player.wx ?? sim.player.x, sim.player.wz ?? sim.player.z] : null;
  }
  function onSwing({ by, target }) {
    if (target?.type !== 'resource' || target.id == null) return;
    let at = null;
    if (by === 'player') at = playerXZ();
    else { const w = ctx.camp?.workers?.get?.(by); if (w && Number.isFinite(w.x)) at = [w.x, w.z]; }
    swingBy.set(target.id, { by, t: clock, hx: at?.[0] ?? null, hz: at?.[1] ?? null });
  }
  // -> { byPlayer, hx, hz } for the blow landing on `id` now
  function takeSwing(id) {
    const s = swingBy.get(id);
    swingBy.delete(id);
    if (s && clock - s.t < 1.5) return { byPlayer: s.by === 'player', hx: s.hx, hz: s.hz };
    if (s) return { byPlayer: false, hx: null, hz: null };
    if (ctx.camp) return { byPlayer: false, hx: null, hz: null };
    const at = playerXZ(); // the sandbox: every hit is the player's (Space / click)
    return { byPlayer: true, hx: at?.[0] ?? null, hz: at?.[1] ?? null };
  }
  // A regrowing prop that gets chopped / removed mid-growth keeps its current size (never pops to full).
  function bakeGrow(rec) {
    const g = rec.grow;
    if (!g) return;
    rec.scale *= Math.max(0.05, g.k ?? 0.05);
    rec.grow = null;
    rec.sway = rec.kind === 'tree' ? 1 : 0;
  }

  function onHit({ entity, fromDir, hp }) {
    const rec = recs.get(entity.id);
    if (!rec || rec.dead) return;
    const [dx, dz] = dirOf(fromDir);
    rec.dirX = dx; rec.dirZ = dz;
    const sw = takeSwing(entity.id);
    const byPlayer = sw.byPlayer;
    rec.hx = sw.hx; rec.hz = sw.hz;
    if (!live) return;
    const final = !(hp > 0);
    rec.byPlayer = byPlayer;
    // the struck pose: hit-stop holds it for a couple of frames (white), then the springs let go
    rec.stop = final ? HIT.stopFinal : HIT.stop;
    rec.white = HIT.white;
    const F = final ? 1.7 : 1;
    const f = fx();
    const hit = hitPoint(entity.id);
    const back = [-dx, -dz];
    if (rec.kind === 'tree') {
      rec.wob.hit(0.15); rec.wob.t = 0.035; // already knocked back on the impact frame
      rec.sq.value = Math.min(rec.sq.value, 0.94);
      rec.sq.kick(-1.7);
      rec.shiver = 1;
      rec.flash = 0.5;
      const cr = treeGeo(rec).crownR * rec.scale;
      f?.leaves?.(crownPos(rec).add(_v.set(-dx * cr * 0.85, 0.1, -dz * cr * 0.85 + 0.15)), { count: Math.round(6 * F), spread: 0.3 * (final ? 1.35 : 1) });
      if (final) f?.leaves?.(crownPos(rec).add(_v.set(dx * cr * 0.5, cr * 0.4, dz * cr * 0.5)), { count: 6, spread: 0.45, delay: 0.04 });
      const c = hit.clone().add(_v.set(-dx * 0.12, 0, -dz * 0.12));
      f?.chips?.(c, '#8a5733', { count: Math.round(3 * F), size: 0.045, dir: back, speed: 1.4 * (final ? 1.25 : 1) });
      f?.chips?.(c, P.stumpTop || '#f1d39a', { count: final ? 3 : 2, size: 0.032, dir: back, speed: 1.7, up: 2.8, life: 0.6 });
      f?.impact?.(c.add(_v.set(-dx * 0.06, 0.02, -dz * 0.06)), { size: final ? 1.25 : 0.85, dir: back, small: final ? 3 : 2 });
    } else if (rec.kind === 'rock') {
      rec.wob.hit(0.06); rec.wob.t = 0.012;
      rec.jolt.value = Math.max(rec.jolt.value, 0.03);
      rec.jolt.kick(1.7);
      rec.sq.value = Math.min(rec.sq.value, 0.93);
      rec.sq.kick(-2.1);
      rec.flash = 0.6;
      const lost = (entity.maxHp || 4) - Math.max(0, hp);
      rec.size.target = 1 - 0.075 * lost;
      const c = hit.clone().add(_v.set(-dx * 0.25, 0.05, -dz * 0.25));
      f?.chips?.(c, '#f6dfae', { count: Math.round(5 * F), size: 0.055, dir: back, speed: 1.6, life: 0.75 });
      f?.puff?.(hit, { count: final ? 3 : 2, size: 0.13, spread: 0.12, up: 0.4 });
      f?.impact?.(c.add(_v.set(-dx * 0.05, 0.04, -dz * 0.05)), { size: final ? 1.2 : 0.85, dir: back, color: '#fffbea' });
    } else {
      rec.sq.value = Math.min(rec.sq.value, 0.92);
      rec.sq.kick(-1.6);
      rec.jolt.kick(0.8);
      rec.flash = 0.55;
      const c = new THREE.Vector3(rec.x - dx * 0.16, 0.14, rec.z - dz * 0.16);
      f?.chips?.(c, P.trunk, { count: Math.round(3 * F), size: 0.04, dir: back, speed: 1.3, up: 2.4, life: 0.7 });
      f?.impact?.(c, { size: 0.8, dir: back, small: 1 });
    }
    if (final && byPlayer) views.camera?.shake?.(HIT.shake * (rec.kind === 'rock' ? 1.3 : rec.kind === 'tree' ? 1 : 0.8));
    active.add(rec);
  }

  // Regrowth (camp): a tree grows back on its stump's tile, a rock respawns where it broke.
  const regrowTiles = new Set(); // tiles whose stump just started sinking for a new tree (the sapling waits a beat)
  function onSpawned({ entity, grow }) {
    if (!entity?.resource || recs.has(entity.id)) return;
    const after = regrowTiles.delete(map.idx(entity.x, entity.z));
    if (grow !== false) addResource(entity, { grow: true, delay: after ? GROW.delay : 0 });
    else addResource(entity, { appear: true, delay: 0 });
  }
  function onRemoved({ entity, regrow }) {
    const rec = entity ? recs.get(entity.id) : null;
    if (!rec || rec.dead) return;
    cullDirty = true;
    bakeGrow(rec);
    rec.dead = true;
    rec.hovTarget = 0;
    recs.delete(entity.id);
    if (hoverId === entity.id) hoverId = null;
    if (!live) { removeRec(rec); return; }
    if (regrow) { rec.sink = { t: 0, chipped: false }; regrowTiles.add(map.idx(rec.x, rec.z)); }
    else rec.vanish = { t: 0, kind: rec.kind, burst: false };
    active.add(rec);
  }

  function onDepleted({ entity, fromDir, replacedBy }) {
    cullDirty = true;
    const rec = recs.get(entity.id);
    const [dx, dz] = dirOf(fromDir);
    if (!rec) { if (replacedBy) addResource(replacedBy); return; }
    bakeGrow(rec);
    // the fall blends out of the current wobble (about the blow's direction) instead of snapping upright
    rec.tilt0 = rec.wob.value;
    rec.dirX = dx; rec.dirZ = dz;
    rec.dead = true;
    rec.hovTarget = 0;
    recs.delete(entity.id); // the id is gone from the sim; the rec lives on in `active` until it finishes
    if (hoverId === entity.id) hoverId = null;
    if (!live) {
      removeRec(rec);
      if (replacedBy) addResource(replacedBy);
      return;
    }
    if (rec.kind === 'tree') {
      let plan;
      try { plan = planFall(rec, dx, dz, rec.hx, rec.hz); } catch (err) { console.error('[props] planFall', err); plan = { dx, dz, mode: 'ground', land: FALL.land }; }
      rec.dirX = plan.dx; rec.dirZ = plan.dz;
      const fallDur = plan.mode === 'lean' ? Math.max(0.2, FALL.fall * Math.sqrt(plan.land / FALL.land)) : FALL.fall * (plan.mode === 'water' ? 1.06 : 1);
      const tLand = FALL.antic + fallDur;
      const tVanish = tLand + (plan.mode === 'lean' ? FALL.popLean : plan.mode === 'water' ? FALL.popWater : FALL.pop);
      rec.fall = { t: 0, ...plan, hdx: dx, hdz: dz, fallDur, tLand, tVanish, tEnd: tVanish + FALL.grow + FALL.shrink, landed: false, bounced: false, vanished: false, tilt: 0 };
      falling.set(map.idx(rec.x, rec.z), rec);
      fallLog.push({ t: +clock.toFixed(2), x: rec.x, z: rec.z, hit: [dx, dz], dir: [+plan.dx.toFixed(3), +plan.dz.toFixed(3)], mode: plan.mode, land: +plan.land.toFixed(3), byPlayer: !!rec.byPlayer, from: rec.hx != null ? [+rec.hx.toFixed(2), +rec.hz.toFixed(2)] : null });
      if (fallLog.length > 64) fallLog.shift();
      rec.shiver = 0.6;
      if (replacedBy) addResource(replacedBy, { appear: true, delay: FALL.antic + 0.1 });
    } else {
      rec.vanish = { t: 0, kind: rec.kind, burst: false };
      if (replacedBy) addResource(replacedBy, { appear: true, delay: 0.15 });
    }
    active.add(rec);
  }

  function onDepositMined({ x, z, item }) {
    const tile = tileAt(x, z);
    if (!live) return;
    const pos = new THREE.Vector3(x, 0.08, z);
    const col = tile?.d === 2 || item === 'stone' ? P.stoneBlock : P.copper;
    fx()?.chips?.(pos, col, { count: 5, size: 0.05, speed: 1.6, up: 2.6 });
    fx()?.puff?.(pos, { count: 2, size: 0.12, spread: 0.2, up: 0.3 });
    if (!tile) return;
    tile.t = 0; tile.jiggling = true;
    activeTiles.add(tile);
  }

  const safe = fn => p => { try { fn(p || {}); } catch (err) { console.error('[props]', err); } };
  const offs = [
    events.on('resource:hit', onHit),
    events.on('resource:depleted', onDepleted),
    events.on('resource:spawned', safe(onSpawned)),
    events.on('resource:removed', safe(onRemoved)),
    events.on('camp:swing', safe(onSwing)),
    events.on('deposit:mined', onDepositMined),
    events.on('build:placed', ({ entity }) => setTileCovered(entity.x, entity.z, true)),
    events.on('build:removed', ({ entity }) => setTileCovered(entity.x, entity.z, false)),
  ];

  // ---------------- per-frame animation ----------------
  const fallLen = rec => (treeGeo(rec).crownY + 0.1) * rec.scale;
  // world point `d` along a felled tree's axis at tilt `th`
  function alongAxis(rec, d, th, out = new THREE.Vector3()) {
    const pv = 0.1 * rec.scale;
    const u = pv - pv * Math.cos(th) + d * Math.sin(th), y = pv * Math.sin(th) + d * Math.cos(th);
    return out.set(rec.x + rec.dirX * u, y, rec.z + rec.dirZ * u);
  }

  function stepFall(rec, dt) {
    const f = rec.fall;
    if (rec.stop > 0) { rec.stop -= dt; dt = 0; } // final-blow hit-stop: hold the struck pose
    f.t += dt;
    const t = f.t, s = rec.scale;
    const pivot = 0.1 * s;
    const L = f.land, tLand = f.tLand;
    let tilt, tilt2 = 0;
    // knocked pose of the last blow (about the blow's direction), blending into the anticipation lean (about the
    // fall's direction, which may differ when the blow's way is blocked)
    if (t < FALL.antic) {
      const k = ease.sineOut(t / FALL.antic);
      tilt = lerp(0, -FALL.lean, k);
      tilt2 = (rec.tilt0 || 0) * (1 - k);
    } else if (t < tLand) { const k = (t - FALL.antic) / f.fallDur; tilt = lerp(-FALL.lean, L, 0.3 * k + 0.7 * k * k); }
    else if (f.mode === 'lean') {
      // knocked back a little by the neighbour, then settles against it in smaller and smaller bounces
      const tau = t - tLand;
      tilt = L - 0.085 * Math.exp(-4.6 * tau) * Math.abs(Math.sin(Math.PI * 2.9 * tau));
    } else if (f.mode === 'water') {
      // a soft bounce on the surface, then a slow float bob
      const tau = t - tLand;
      tilt = L - 0.1 * Math.exp(-5 * tau) * Math.abs(Math.sin(Math.PI * 2.4 * tau)) + 0.022 * Math.sin(tau * Math.PI * 2 * 0.9) * Math.exp(-1.2 * tau);
    } else if (t < tLand + FALL.b1) tilt = L - FALL.bounce1 * arc((t - tLand) / FALL.b1);
    else if (t < tLand + FALL.b1 + FALL.b2) tilt = L - FALL.bounce2 * arc((t - tLand - FALL.b1) / FALL.b2);
    else tilt = L;
    f.tilt = tilt;
    const dx = rec.dirX, dz = rec.dirZ;
    const len = fallLen(rec);
    if (!f.landed && t >= tLand) {
      f.landed = true;
      rec.sq.kick(-1.2);
      rec.shiver = 1;
      if (f.mode === 'lean') {
        // caught by the neighbour: it takes the hit (wobble / shiver / boop), leaves shake loose
        rec.sq.kick(0.5);
        const o = f.ob?.rec;
        if (o && !o.dead) {
          o.dirX = dx; o.dirZ = dz;
          o.wob.hit(o.kind === 'tree' ? 0.06 + 0.12 * clamp((LEAN_MIN + 0.05 - (f.th0 ?? f.land)) / 0.3) : 0.025);
          if (o.kind === 'tree') o.shiver = Math.max(o.shiver, 0.9);
          o.sq.kick(-0.8);
          active.add(o);
        }
        if (f.ob?.building != null) views.buildings?.poke?.(f.ob.building, 0.8);
        const c = alongAxis(rec, len * 1.15, L);
        fx()?.leaves?.(c, { count: 9, spread: 0.45 });
        fx()?.puff?.(alongAxis(rec, len * 0.9, L), { count: 3, size: 0.13, spread: 0.25, up: 0.25 });
        if (rec.byPlayer) views.camera?.shake?.(0.04);
      } else if (f.mode === 'water') {
        for (const k of [0.75, 1.15, 1.5]) impactAt(rec.x + dx * len * k, rec.z + dz * len * k, { count: 3, size: 0.15, spread: 0.3 });
        fx()?.splash?.(new THREE.Vector3(rec.x + dx * len * 1.05, WATER_Y, rec.z + dz * len * 1.05), { radius: 0.85, count: 14, size: 0.12, drops: 8 });
        fx()?.leaves?.(new THREE.Vector3(rec.x + dx * len * 1.05, 0.25, rec.z + dz * len * 1.05), { count: 8, spread: 0.55 });
        if (rec.byPlayer) views.camera?.shake?.(0.05);
      } else {
        // dust bursts out from under the whole crown, a soft ring where it hits hardest, leaves fly
        for (const k of [0.5, 0.85, 1.2, 1.55]) impactAt(rec.x + dx * len * k, rec.z + dz * len * k);
        const mid = new THREE.Vector3(rec.x + dx * len * 1.05, 0.04, rec.z + dz * len * 1.05);
        if (isGround(mid.x, mid.z)) fx()?.ring?.(mid, { radius: 0.62, count: 11, size: 0.1 });
        fx()?.leaves?.(mid.clone().setY(0.4), { count: 10, spread: 0.55 });
        if (rec.byPlayer) views.camera?.shake?.(0.06);
      }
    }
    if (!f.bounced && f.mode === 'ground' && t >= tLand + FALL.b1) {
      f.bounced = true;
      impactAt(rec.x + dx * len * 1.1, rec.z + dz * len * 1.1, { count: 3, size: 0.14, spread: 0.3, up: 0.3 });
    }
    // where the log shrinks away: the middle of the crown in its resting pose
    const sc = alongAxis(rec, len * 0.95, L, _p);
    const shrinkAt = [sc.x, Math.max(sc.y, f.mode === 'water' ? WATER_Y + 0.1 : 0.2), sc.z];
    let shrink = 1;
    if (t >= f.tVanish) {
      const tv = t - f.tVanish;
      shrink = tv < FALL.grow ? 1 + 0.07 * ease.quadOut(tv / FALL.grow) : 1.07 * (1 - ease.cubicIn(clamp((tv - FALL.grow) / FALL.shrink)));
      if (!f.vanished && tv >= FALL.grow + FALL.shrink * 0.55) {
        f.vanished = true;
        const c = new THREE.Vector3(shrinkAt[0], shrinkAt[1], shrinkAt[2]);
        if (f.mode === 'water') fx()?.splash?.(c.clone().setY(WATER_Y), { radius: 0.55, count: 10, size: 0.1, drops: 4 });
        else fx()?.puff?.(c, { count: 4, size: 0.14, spread: 0.36, up: 0.45 });
        fx()?.leaves?.(c.clone().setY(Math.max(0.3, c.y)), { count: 5, spread: 0.4 });
      }
    }
    rec.sq.update(dt);
    const sy = rec.sq.value;
    writeRec(rec, {
      tilt, pivotX: dx * pivot, pivotZ: dz * pivot, sy, sxz: 1 / Math.sqrt(Math.max(0.4, sy)),
      shrink, shrinkAt, tilt2, d2x: f.hdx ?? dx, d2z: f.hdz ?? dz,
    });
    return t < f.tEnd;
  }

  function stepVanish(rec, dt) {
    const v = rec.vanish;
    if (rec.stop > 0) { rec.stop -= dt; dt = 0; } // final-blow hit-stop
    v.t += dt;
    const isRock = rec.kind === 'rock';
    const grow = isRock ? 0.06 : 0.09, shrink = isRock ? 0.13 : 0.16, peak = isRock ? 1.08 : 1.16;
    let k;
    if (v.t < grow) k = 1 + (peak - 1) * ease.quadOut(v.t / grow);
    else k = peak * (1 - ease.cubicIn(clamp((v.t - grow) / shrink)));
    if (!v.burst && v.t >= grow) {
      v.burst = true;
      const h = topY(rec);
      if (isRock) {
        const c = new THREE.Vector3(rec.x, h * 0.35, rec.z);
        // chunks hop outward from the rock's volume and shrink away; a soft puff where it stood
        fx()?.chips?.(c, '#f8e6bd', { count: 4, size: 0.12, speed: 1.15, up: 2.5, spread: 0.2, life: 0.7 });
        fx()?.chips?.(c, '#eccf98', { count: 4, size: 0.055, speed: 1.6, up: 2.9, spread: 0.12, life: 0.65 });
        fx()?.puff?.(c.setY(0.1), { count: 4, size: 0.17, spread: 0.26, up: 0.45 });
        fx()?.ring?.(new THREE.Vector3(rec.x, 0.04, rec.z), { radius: 0.55, count: 8, size: 0.08 });
      } else {
        const c = new THREE.Vector3(rec.x, 0.15, rec.z);
        fx()?.chips?.(c, P.trunk, { count: 6, size: 0.06, speed: 1.8, up: 2.6 });
        fx()?.chips?.(c, P.stumpTop, { count: 3, size: 0.05, speed: 1.6, up: 2.8 });
        fx()?.puff?.(c.setY(0.08), { count: 4, size: 0.16, spread: 0.2, up: 0.4 });
      }
    }
    rec.sq.update(dt);
    const sy = rec.sq.value;
    writeRec(rec, { sizeK: Math.max(1e-4, k * rec.size.value * rec.hovScale.value), sy, sxz: 1 / Math.sqrt(Math.max(0.4, sy)) });
    return v.t < grow + shrink;
  }

  // Highlight glow (hit flash + hover pulse) and leaf shiver -> the instance's aFx.
  // glow 0..1 = brighten (hover / soft flash); above 1 the instance blends toward white (the hit flash).
  function stepFx(rec, dt, frozen = false) {
    if (rec.flash > 0) rec.flash = Math.max(0, rec.flash - dt * 2.6);
    if (rec.white > 0 && !frozen) rec.white = Math.max(0, rec.white - dt * HIT.whiteDecay);
    rec.shiver = rec.shiver > 0.002 ? rec.shiver * Math.exp(-4.5 * dt) : 0;
    const target = rec.dead ? 0 : rec.hovTarget;
    // linear ramp eased with smoothstep: eases both in and out
    rec.hovLin = target > rec.hovLin ? Math.min(target, rec.hovLin + dt / HOVER.in) : Math.max(target, rec.hovLin - dt / HOVER.out);
    rec.hovT += dt;
    const h = smooth(rec.hovLin);
    const pulse = 0.78 + 0.22 * Math.cos(rec.hovT * Math.PI * 2 * HOVER.pulseHz); // starts bright, breathes
    rec.glow = Math.min(1, rec.flash + h * pulse * (rec.kind === 'tree' ? 0.85 : 0.75) + rec.white * 3) + rec.white;
    rec.hovScale.target = 1 + HOVER.scale * target;
    rec.hovScale.update(dt);
    if (rec.fall) rec.sway = Math.max(0, rec.sway - dt * 6); // a felled tree stops swaying in the wind
    if (frozen) { const s = rec.shiver; rec.shiver = 0; rec.batch?.setFx(rec); rec.shiver = s; } // hit-stop: leaves hold still too
    else rec.batch?.setFx(rec);
  }

  // ---------------- regrowth ----------------
  function sproutFx(rec) {
    const f = fx();
    const c = new THREE.Vector3(rec.x, 0.04, rec.z);
    // a soft ring of dust rolls out from under the sprout, a few leaves hop out of it
    f?.ring?.(c.clone().setY(0.03), { radius: 0.42, count: 7, size: 0.065, color: '#f1e6c8' });
    f?.leaves?.(c.clone().setY(0.22), { count: 6, spread: 0.12 });
    f?.sparkle?.(c.clone().setY(0.3), { count: 2, spread: 0.16, size: 0.06, color: '#eaffc8' });
  }
  function riseFx(rec) {
    const f = fx();
    const c = new THREE.Vector3(rec.x, 0.05, rec.z);
    f?.puff?.(c, { count: 5, size: 0.15, spread: 0.3, up: 0.35, color: '#f3ead2' });
    f?.ring?.(c.clone().setY(0.03), { radius: 0.5, count: 9, size: 0.08, color: '#f3ead2' });
    f?.chips?.(c.clone().setY(0.08), '#d9c08a', { count: 3, size: 0.035, speed: 1.0, up: 2.2, life: 0.55 });
  }
  // Pose of a regrowing prop this frame: g.k (size), g.sy (stretch), g.offY. Trees: sprout -> sapling holds a
  // beat -> grows to full with a springy overshoot, the crown filling out. Rocks: rise out of the ground.
  function growPose(rec, dt) {
    const g = rec.grow;
    g.t += dt;
    const t = g.t;
    g.offY = 0;
    if (t < 0) { g.k = 0; g.sy = 1; return; } // waiting for the stump to start sinking
    if (rec.kind === 'tree') {
      if (!g.sprouted) { g.sprouted = true; sproutFx(rec); }
      if (t < GROW.sprout) {
        const u = t / GROW.sprout;
        g.k = lerp(0.04, GROW.sap, ease.backOut(u, 2.4));
        g.sy = lerp(1.7, GROW.sapStretch, ease.quadOut(u));
      } else if (t < GROW.sprout + GROW.hold) {
        g.k = GROW.sap; g.sy = GROW.sapStretch;
        if (!g.wiggled) { g.wiggled = true; rec.wob.hit(0.07); rec.shiver = Math.max(rec.shiver, 0.5); }
      } else {
        const u = clamp((t - GROW.sprout - GROW.hold) / GROW.grow);
        g.k = lerp(GROW.sap, 1, ease.backOut(u, 1.7));
        g.sy = lerp(GROW.sapStretch, 1, ease.cubicOut(u));
        rec.sway = Math.max(rec.sway, lerp(0.25, 1, u));
        if (u >= 1) {
          g.done = true;
          rec.sq.kick(-1.3); rec.shiver = Math.max(rec.shiver, 0.7);
          fx()?.leaves?.(crownPos(rec).add(_v.set(0, 0.1, 0.1)), { count: 3, spread: 0.35 });
        }
      }
      return;
    }
    // rocks (and anything else): a dust puff, then it pushes up out of it
    if (!g.sprouted) { g.sprouted = true; riseFx(rec); }
    const u = clamp((t - RISE.lead) / RISE.dur);
    g.offY = -topY(rec) * RISE.from * (1 - ease.backOut(u, 1.9));
    g.k = lerp(RISE.scale0, 1, ease.cubicOut(u));
    g.sy = 1 + 0.16 * (1 - ease.quadOut(u));
    if (!g.landed && u >= 0.6) {
      g.landed = true;
      rec.sq.kick(-1.6); rec.wob.hit(0.035);
    }
    if (u >= 1) g.done = true;
  }
  // The stump a regrowing tree replaces: a tiny anticipation swell, then it sinks and shrinks away.
  function stepSink(rec, dt) {
    const s = rec.sink;
    s.t += dt;
    const k = s.t < SINK.grow ? 1 + 0.06 * ease.quadOut(s.t / SINK.grow) : 1.06 * (1 - ease.cubicIn(clamp((s.t - SINK.grow) / SINK.shrink)));
    if (!s.chipped && s.t >= SINK.grow) {
      s.chipped = true;
      fx()?.chips?.(new THREE.Vector3(rec.x, 0.12, rec.z), P.trunk, { count: 3, size: 0.035, speed: 0.9, up: 1.8, life: 0.5 });
    }
    rec.sq.update(dt);
    const sy = rec.sq.value;
    writeRec(rec, { sizeK: Math.max(1e-4, k), offY: -SINK.depth * ease.quadIn(clamp(s.t / (SINK.grow + SINK.shrink))), sy, sxz: 1 / Math.sqrt(Math.max(0.4, sy)) });
    return s.t < SINK.grow + SINK.shrink;
  }

  function stepRec(rec, dt) {
    // hit-stop: the struck pose holds (springs, wobble and growth paused) for a couple of frames
    const frozen = rec.stop > 0 && !rec.fall && !rec.vanish;
    if (frozen) rec.stop -= dt;
    stepFx(rec, dt, frozen || (rec.stop > 0));
    if (rec.fall) return stepFall(rec, dt);
    if (rec.vanish) return stepVanish(rec, dt);
    if (rec.sink) return stepSink(rec, dt);

    if (rec.appearDelay > 0) {
      rec.appearDelay -= dt;
      if (rec.appearDelay <= 0) { rec.pop.value = 0.62; rec.pop.target = 1; rec.pop.velocity = 2; }
      else { writeRec(rec, { sizeK: 1e-4 }); return true; }
    }
    const adt = frozen ? 0 : dt;
    let gk = 1, gsy = 1, gy = 0;
    if (rec.grow) {
      growPose(rec, adt);
      gk = rec.grow.k; gsy = rec.grow.sy; gy = rec.grow.offY;
      if (rec.grow.done) rec.grow = null;
    }
    rec.wob.update(adt);
    rec.sq.update(adt); rec.size.update(adt); rec.jolt.update(adt); rec.pop.update(adt);
    const sy = rec.sq.value * gsy;
    const j = rec.jolt.value;
    writeRec(rec, {
      tilt: rec.wob.value, sy, sxz: 1 / Math.sqrt(Math.max(0.4, sy)), offY: gy,
      sizeK: Math.max(1e-4, gk * rec.size.value * rec.pop.value * rec.hovScale.value), offX: rec.dirX * j, offZ: rec.dirZ * j,
    });
    const wobLeft = rec.wob.amp * Math.exp(-rec.wob.decay * rec.wob.t);
    return wobLeft > 0.0015 || !rec.sq.settled || !rec.size.settled || !rec.jolt.settled || !rec.pop.settled
      || !rec.hovScale.settled || rec.flash > 0 || rec.white > 0 || rec.stop > 0 || rec.shiver > 0 || rec.hovLin > 0 || rec.hovTarget > 0
      || !!rec.grow;
  }

  // "Not now": the player brushing a rock while stone has no use yet gets a tiny wobble (never a hit), once per
  // contact. Camp only; checks the 3x3 tiles around the player.
  const _pp = new THREE.Vector3();
  function updateBrush() {
    const camp = ctx.camp;
    if (!camp?.useful || !sim.at) return;
    let p = null;
    try { p = views.player?.getPosition?.(_pp) || null; } catch { p = null; }
    if (!p || !Number.isFinite(p.x)) return;
    let useful = null;
    const tx = Math.round(p.x), tz = Math.round(p.z);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const e = sim.at(tx + dx, tz + dz);
      if (!e || e.kind !== 'rock') continue;
      const rec = recs.get(e.id);
      if (!rec || rec.dead || rec.grow) continue;
      const ex = e.x - p.x, ez = e.z - p.z, d = Math.hypot(ex, ez);
      if (rec.brush) { if (d > BRUSH.release) rec.brush = false; continue; }
      if (d > BRUSH.dist || d < 1e-3) continue;
      rec.brush = true;
      if (useful === null) useful = !!camp.useful('stone');
      if (useful || clock - rec.brushT < BRUSH.cooldown) continue;
      rec.brushT = clock;
      rec.dirX = ex / d; rec.dirZ = ez / d;
      rec.wob.hit(BRUSH.wobble);
      rec.sq.kick(-0.45);
      active.add(rec);
    }
  }

  function stepTile(tile, dt) {
    tile.t += dt;
    tile.vis.update(dt);
    if (tile.jiggling && tile.t > 0.9) tile.jiggling = false;
    writeTile(tile);
    return tile.jiggling || !tile.vis.settled;
  }

  // ---------------- view culling ----------------
  // Every batch draws only the props whose bounds (prop + its shadow, see makeRec) touch the view frustum; on
  // phones only those within the shadow reach of the camera target also go into the shadow map. Animated
  // falls / vanishes / sinks always draw. Runs in update() and again right before rendering (post.js calls
  // prepareRender after the camera has moved this frame), so nothing at the frame edge lags a frame.
  const _frus = new THREE.Frustum(), _pv = new THREE.Matrix4(), _sph = new THREE.Sphere();
  const _lfrus = new THREE.Frustum(), _lpv = new THREE.Matrix4();
  let cullOn = true;
  const _pvPrev = new Float64Array(16), _lpvPrev = new Float64Array(16);
  function cull() {
    const cam = ctx.camera;
    if (!cam?.projectionMatrix) return;
    cam.updateMatrixWorld();
    _pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    // phones: the sun's shadow frustum as it will render this frame (lighting placed the sun in its update)
    const sun = MOBILE ? views.lighting?.sun : null;
    const lightTest = !!sun?.shadow?.camera;
    if (lightTest) {
      sun.shadow.updateMatrices(sun);
      const lc = sun.shadow.camera;
      _lpv.multiplyMatrices(lc.projectionMatrix, lc.matrixWorldInverse);
    }
    // nothing moved and no prop was added / removed / started falling: the partition still holds
    let same = !cullDirty;
    const e = _pv.elements, le = _lpv.elements;
    for (let i = 0; i < 16; i++) {
      if (e[i] !== _pvPrev[i]) { _pvPrev[i] = e[i]; same = false; }
      if (lightTest && le[i] !== _lpvPrev[i]) { _lpvPrev[i] = le[i]; same = false; }
    }
    cullDirty = false;
    if (same) return;
    _frus.setFromProjectionMatrix(_pv);
    if (lightTest) _lfrus.setFromProjectionMatrix(_lpv);
    for (const b of allBatches) {
      for (let i = 0; i < b.n; i++) {
        const rec = b.recs[i];
        if (!cullOn || rec.fall || rec.vanish || rec.sink) { rec.cv = rec.cs = true; continue; }
        const s = rec.scale, H = rec.bH * s;
        _sph.center.set(rec.x + 0.25 * H, 0.5 * H, rec.z + 0.18 * H);
        _sph.radius = 0.6 * H + rec.bR * s;
        rec.cv = _frus.intersectsSphere(_sph);
        if (rec.cv && lightTest) {
          // the prop itself (not its shadow) must be inside the shadow frustum to land in the map
          _sph.center.set(rec.x, 0.5 * H, rec.z);
          _sph.radius = 0.5 * H + rec.bR * s;
          rec.cs = _lfrus.intersectsSphere(_sph);
        } else rec.cs = rec.cv;
      }
      b.partition();
    }
  }
  let lastPrepared = -1;
  function prepareRender() {
    lastPrepared = clock;
    cull();
    for (const b of allBatches) b.flush();
  }

  // wind clock: follow the grass (terrain's dt-advanced wind time) when exposed, else our own dt clock
  let windT = 0;
  function windClock(dt) {
    windT += dt;
    const w = views.terrain?.wind;
    let tt = w?.uniforms?.uWindTime?.value;
    if (!Number.isFinite(tt)) tt = w?.time;
    windU.uWindTime.value = Number.isFinite(tt) ? tt : windT;
  }

  // ---------------- public ----------------
  return {
    meshFor: id => recs.get(id)?.handle || null,
    hitPoint,
    // Seconds fx should wait before flying drops from tile (x, z): a felled tree's logs burst out the moment its
    // crown first touches the ground (or the water, or the neighbour it leans on), hit-stop included.
    flightDelay(x, z) {
      const rec = map.inBounds(x, z) ? falling.get(map.idx(x, z)) : null;
      if (rec?.fall) return Math.max(0, Math.max(0, rec.stop || 0) + rec.fall.tLand + FALL.release - rec.fall.t);
      return 0.05;
    },
    // Where the n-th of `count` drops from tile (x, z) starts its flight (along a fallen log, or the tile).
    flightOrigin(x, z, i = 0, count = 1) {
      const rec = map.inBounds(x, z) ? falling.get(map.idx(x, z)) : null;
      if (rec?.fall) {
        const len = fallLen(rec);
        const k = count > 1 ? i / (count - 1) : 0.5;
        const d = lerp(0.25, 1.45, k) * len, L = rec.fall.land;
        const o = alongAxis(rec, d, L);
        // start just under the felled crown's top surface (not its middle), so the logs burst visibly out of it
        // the moment it lands instead of hiding inside the foliage for their whole hop
        const g = treeGeo(rec), s = rec.scale;
        let lift = 0.06 * s;
        if (d >= g.crownBase * s) { let r = g.profile[0][1]; for (const [py, pr] of g.profile) if (d >= py * s) r = pr; lift = r * s * 0.7; }
        o.y += lift * Math.sin(Math.min(L, Math.PI / 2));
        o.y = Math.max(o.y, rec.fall.mode === 'water' ? WATER_Y + 0.15 : 0.25);
        return o;
      }
      return null;
    },
    // Small hover nudge (squash + shiver), e.g. when a prop becomes the interaction target.
    poke(id, amount = 1) {
      const rec = recs.get(id);
      if (!rec || rec.dead || !live) return;
      rec.sq.kick(-0.6 * amount);
      if (rec.kind === 'tree') rec.shiver = Math.max(rec.shiver, 0.35 * amount);
      active.add(rec);
    },
    // Soft highlight on the hovered resource (brighten + pulse + a tiny springy grow). null clears it.
    setHover(id) { hoverExplicit = true; applyHover(id); },
    get hoverId() { return hoverId; },
    // test/debug snapshot of felled trees in progress (tilt in radians from upright)
    get falling() { return [...falling.values()].map(r => ({ x: r.x, z: r.z, mode: r.fall?.mode, land: r.fall?.land, tilt: r.fall?.tilt, t: r.fall?.t, dir: [r.dirX, r.dirZ], tLand: r.fall?.tLand })); },
    // test/debug: the last felled trees' plans { t, x, z, hit: [dx, dz], dir: [dx, dz], mode, land, byPlayer }
    get fallLog() { return fallLog.slice(); },
    // test/debug: the fall-direction weights (FALL_PREF), live and mutable for tuning
    _fallPref: FALL_PREF,
    // test/debug: how the tree with this id would fall if hit from fromDir by someone standing at (hx, hz)
    // (no side effects); opts.onlyHit = the old rule (along the blow only)
    planFallFor(id, fromDir, hx = null, hz = null, opts) {
      const rec = recs.get(id);
      if (!rec || rec.kind !== 'tree' || rec.dead) return null;
      const [dx, dz] = dirOf(fromDir);
      const p = planFall(rec, dx, dz, hx, hz, opts);
      return { dir: [+p.dx.toFixed(3), +p.dz.toFixed(3)], mode: p.mode, land: +p.land.toFixed(3), ob: p.ob ? [p.ob.cx, p.ob.cz] : null };
    },
    // test/debug: the live animation record of a prop
    _rec: id => recs.get(id) || null,
    // test/debug: props regrowing / sinking right now
    get regrowing() { return [...active].filter(r => r.grow || r.sink).map(r => ({ id: r.id, kind: r.kind, x: r.x, z: r.z, grow: r.grow ? +r.grow.t.toFixed(3) : null, k: r.grow?.k, sink: r.sink ? +r.sink.t.toFixed(3) : null })); },
    // Re-cull against the camera as it is right now (post.js calls this just before rendering).
    prepareRender,
    // perf read-out / test switch: instances drawn per pass, and turning view culling off (draws everything)
    get drawStats() {
      let n = 0, vis = 0, shad = 0, tris = 0, shadowTris = 0;
      for (const b of allBatches) {
        const per = b.geo.userData.mainRange ? b.geo.userData.mainRange[1] / 3 : b.geo.attributes.position.count / 3;
        const perS = b.geo.userData.shadowRange ? b.geo.userData.shadowRange[1] / 3 : per;
        n += b.n; vis += b.vis; shad += b.mesh.castShadow ? b.shad : 0;
        tris += b.vis * per; shadowTris += b.mesh.castShadow ? b.shad * perS : 0;
      }
      return { mobile: MOBILE, props: n, drawn: vis, shadowCasters: shad, tris: Math.round(tris), shadowTris: Math.round(shadowTris), treeTris: treeGeos.map(g => (g.userData.mainRange?.[1] ?? g.attributes.position.count) / 3), treeShadowTris: treeGeos.map(g => (g.userData.shadowRange?.[1] ?? 0) / 3) };
    },
    setCulling(on) { cullOn = !!on; cullDirty = true; prepareRender(); },
    update(dt, t) {
      live = true;
      clock += dt;
      windClock(dt);
      updateBrush();
      // until interact drives setHover itself, follow the shared hover state
      if (!hoverExplicit) applyHover(ctx.ui?.hover?.entityId ?? null);
      for (const rec of active) {
        let keep = false;
        try { keep = stepRec(rec, dt); } catch (err) { active.delete(rec); throw err; }
        if (!keep) {
          active.delete(rec);
          if (rec.dead) removeRec(rec);
          else { rec.shiver = 0; rec.glow = 0; rec.batch?.setFx(rec); }
        }
      }
      for (const tile of activeTiles) if (!stepTile(tile, dt)) activeTiles.delete(tile);
      // post.js culls right before rendering (camera final); this is the fallback when it doesn't
      if (clock - lastPrepared > 0.25) cull();
      for (const b of allBatches) b.flush();
      for (const d of [1, 2]) { const b = nuggetBatches[d]; if (b.dirty) { b.mesh.instanceMatrix.needsUpdate = true; b.dirty = false; } }
    },
    dispose() { offs.forEach(off => off()); },
  };
}
