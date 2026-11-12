// Island geometry: painted grass caps with a soft tile checker and wind light streaks, a dense field of
// short wind-blown grass blades (world/grass.js), cream sand lips with rounded corners and little shore
// stakes, sand cliffs dropping under the water, wind-swayed grass tufts overhanging every edge, tiny
// flowers and plank bridges. Built once from ctx.map. Everything that sways shares one wind field
// (world/wind.js) driven by a dt-advanced time uniform; tufts, blades and flowers under buildings
// shrink away smoothly.
//
// Camp mode: stations aren't sim entities, so their footprints (and the always-drawn hearth) are covered
// from camp state / station:built. Bridges are built at runtime (pads view draws them): when one starts,
// the rim tufts and shore stakes where its deck meets each shore tuck away. ctx.quality.grassDensity
// (0.5 on phones) thins blades, rim fringe, field tufts and flowers while keeping the same look.
import * as THREE from 'three';
import { STATIONS as CAMP_STATIONS } from '../sim/camp-data.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { traceLoops, groupIslands, ring } from './world/outline.js';
import { WIND, WIND_GLSL, gustAt, leanAt } from './world/wind.js';
import { createGrassField, TONE_GLSL } from './world/grass.js';

// ---- tuning ----
const CAP_INSET = 0.2;          // grass cap sits this far inside the tile outline (sand lip width)
const TEX_TILES = 2;            // grass texture repeats every 2 tiles
const CHECKER = 0.1;            // per-tile checker strength
const EDGE_TUFT_STEP = 0.075;   // spacing of fringe blades along the rim
const CLUSTER_LEN = 0.3;        // rim is split in segments; some carry a cluster of tall tufts
const STAKE_CHANCE = 0.3;       // share of straight-shore tile boundaries that get a little cream stake
const BRIDGE_Y = -0.02;
const EDGE_CHUNK = 16;          // rim tufts are split into culled meshes per EDGE_CHUNK x EDGE_CHUNK tiles

// Rim profile: [d (inward offset), y, normalOut, normalUp]. Strips connect consecutive rows.
const PROFILE = {
  skirt: [[CAP_INSET, 0.0, 0.45, 0.9], [CAP_INSET - 0.01, -0.028, 0.85, 0.5]],
  // the visible face toward the water stays bright sand (normals tipped up so the sky lights it):
  // from the high camera the whole rim reads as one wide cream band, like the reference
  sand: [
    [CAP_INSET - 0.01, -0.028, 0.1, 0.99],
    [0.07, -0.036, 0.14, 0.99],
    [0.0, -0.05, 0.4, 0.92],
    [-0.035, -0.1, 0.6, 0.8],
    [-0.052, -0.3, 0.66, 0.75],
    [-0.07, -0.6, 0.9, 0.42],
    [-0.1, -1.6, 0.97, 0.2],
  ],
};

export function create(ctx) {
  const { scene, map, config, noise, events, sim, renderer } = ctx;
  const P = config.PALETTE;
  const density = Math.max(0.25, Math.min(1, Number(ctx.quality?.grassDensity) || 1));
  // rim fringe spacing / size and the share of field tufts + flowers kept at this density
  const edgeStep = EDGE_TUFT_STEP * Math.pow(1 / density, 0.7);
  const fringeScale = Math.pow(1 / density, 0.3);
  const keepField = Math.min(1, 0.4 + density * 0.6), keepFlower = Math.min(1, 0.4 + density * 0.6);
  const col = c => new THREE.Color(c);
  const rng = noise.mulberry32((map.seed || 7) * 977 + 13);
  const group = new THREE.Group();
  group.name = 'terrain';
  scene.add(group);

  const loops = traceLoops(map);
  const islands = groupIslands(loops);

  // shared, dt-driven uniforms (wind time + player position) and the ground tone inputs
  const tintTex = makeTintTexture(map, noise);
  const shared = {
    uWindTime: { value: 0 },
    uSheen: { value: 1 },
    uPlayer: { value: new THREE.Vector3(1e4, 0, 1e4) },
    uTint: { value: tintTex },
    uTintSize: { value: new THREE.Vector2(map.w, map.h) },
    uChecker: { value: CHECKER },
  };

  // =====================================================================
  // Grass cap
  // =====================================================================
  const painted = paintGrassTexture(rng);
  const grassTex = painted.texture;
  grassTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy?.() || 1);

  const capPos = [], capUv = [], capIdx = [];
  for (const isl of islands) {
    const outerRing = ring(isl.outer, CAP_INSET);
    const holeRings = isl.holes.map(hl => ring(hl, CAP_INSET));
    const toV2 = r => { const a = []; for (let i = 0; i < r.count; i++) a.push(new THREE.Vector2(r.pts[i * 2], r.pts[i * 2 + 1])); return a; };
    const contour = toV2(outerRing);
    const holes = holeRings.map(toV2);
    const faces = THREE.ShapeUtils.triangulateShape(contour, holes);
    const base = capPos.length / 3;
    const all = contour.concat(...holes);
    for (const v of all) { capPos.push(v.x, 0, v.y); capUv.push(v.x / TEX_TILES, v.y / TEX_TILES); }
    for (const [a, b, c] of faces) {
      // keep faces pointing up (+y): cross of (b-a) x (c-a) must have positive y
      const A = all[a], B = all[b], C = all[c];
      const cy = (C.x - A.x) * (B.y - A.y) - (B.x - A.x) * (C.y - A.y);
      if (cy >= 0) capIdx.push(base + a, base + b, base + c); else capIdx.push(base + a, base + c, base + b);
    }
  }
  const capGeo = new THREE.BufferGeometry();
  capGeo.setAttribute('position', new THREE.Float32BufferAttribute(capPos, 3));
  capGeo.setAttribute('uv', new THREE.Float32BufferAttribute(capUv, 2));
  const capNrm = new Float32Array(capPos.length); for (let i = 1; i < capNrm.length; i += 3) capNrm[i] = 1;
  capGeo.setAttribute('normal', new THREE.BufferAttribute(capNrm, 3));
  capGeo.setIndex(capIdx);
  capGeo.computeBoundingSphere();

  const grassMat = new THREE.MeshLambertMaterial({ map: grassTex, color: 0xffffff });
  grassMat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, shared);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vGW;
${WIND_GLSL}
${TONE_GLSL}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
{
  diffuseColor.rgb *= grassTone(vGW.xz);
  // wind over a meadow: brighter, slightly yellower bands sweep across with the gusts
  float sheen = windSheen(vGW.xz);
  diffuseColor.rgb *= 1.0 + sheen * ${WIND.streak.toFixed(3)} * vec3(1.0, 0.86, 0.3);
}`);
  };
  grassMat.customProgramCacheKey = () => 'isle-grass-v3';
  const cap = new THREE.Mesh(capGeo, grassMat);
  cap.receiveShadow = true;
  cap.name = 'grassCap';
  group.add(cap);

  // =====================================================================
  // Rim: grass skirt + sand lip + bevel + cliff wall (one mesh, vertex colours)
  // =====================================================================
  const bladeBase = painted.average;   // linear colour of the painted ground, shared with blades/tufts
  const skirtCols = [bladeBase.clone().multiplyScalar(0.9), bladeBase.clone().multiplyScalar(0.72)];
  const sandTop = col('#fae68e'), sandLip = col('#f6de82');
  const sandCols = [
    sandTop, sandTop.clone().lerp(sandLip, 0.4), sandLip, col('#f4d67c'),
    col('#efd07a'), col(P.sandShade).lerp(col('#7fb08c'), 0.5), col('#56907c'),
  ];
  const rimPos = [], rimNrm = [], rimCol = [], rimIdx = [];
  const pushStrip = (loop, rowA, rowB, colA, colB) => {
    const ra = ring(loop, rowA[0]), rb = ring(loop, rowB[0]);
    const n = ra.count, base = rimPos.length / 3;
    for (const [r, row, c] of [[ra, rowA, colA], [rb, rowB, colB]]) {
      for (let i = 0; i < n; i++) {
        const nx = r.nrm[i * 2], nz = r.nrm[i * 2 + 1];
        rimPos.push(r.pts[i * 2], row[1], r.pts[i * 2 + 1]);
        const len = Math.hypot(row[2], row[3]);
        rimNrm.push((nx * row[2]) / len, row[3] / len, (nz * row[2]) / len);
        rimCol.push(c.r, c.g, c.b);
      }
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = base + i, b = base + j, c = base + n + j, d = base + n + i;
      // ring order has land on the right; outward-facing winding
      rimIdx.push(a, b, d, b, c, d);
    }
  };
  for (const loop of loops) {
    pushStrip(loop, PROFILE.skirt[0], PROFILE.skirt[1], skirtCols[0], skirtCols[1]);
    for (let k = 0; k < PROFILE.sand.length - 1; k++) pushStrip(loop, PROFILE.sand[k], PROFILE.sand[k + 1], sandCols[k], sandCols[k + 1]);
  }
  const rimGeo = new THREE.BufferGeometry();
  rimGeo.setAttribute('position', new THREE.Float32BufferAttribute(rimPos, 3));
  rimGeo.setAttribute('normal', new THREE.Float32BufferAttribute(rimNrm, 3));
  rimGeo.setAttribute('color', new THREE.Float32BufferAttribute(rimCol, 3));
  rimGeo.setIndex(rimIdx);
  rimGeo.computeBoundingSphere();
  const rimMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const rim = new THREE.Mesh(rimGeo, rimMat);
  rim.receiveShadow = true;
  rim.name = 'rim';
  group.add(rim);

  // =====================================================================
  // Dense grass blades over every grass tile
  // =====================================================================
  const grass = createGrassField({ map, sim, loops, shared, baseColor: bladeBase, capInset: CAP_INSET, rng, density });
  group.add(grass.group);

  // =====================================================================
  // Grass tufts + flowers (instanced, shared wind field)
  // =====================================================================
  const makeTuftMaterial = ({ tone }) => {
    const m = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    m.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, shared);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
attribute float aGrow;
uniform vec3 uPlayer;
varying vec3 vTuft;
${WIND_GLSL}
${tone ? TONE_GLSL : ''}`)
        .replace('#include <begin_vertex>', 'vec3 transformed = vec3(position) * aGrow;')
        .replace('#include <project_vertex>', `vec4 mvPosition = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
  vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
#else
  vec3 ip = vec3(0.0);
#endif
{
  float h = max(mvPosition.y - ip.y, 0.0);
  float hk = clamp(h / 0.24, 0.0, 1.25);
  float gust;
  vec2 lean = WIND_DIR * windLean(ip.xz, ip.x * 1.7 + ip.z * 2.3, gust);
  vec2 away = ip.xz - uPlayer.xz;
  float dp = length(away);
  float pk = 1.0 - smoothstep(0.15, 0.7, dp);
  lean = lean * (1.0 - pk * 0.6) + away / max(dp, 1e-3) * pk * 1.0;
  float L = length(lean);
  mvPosition.xz += lean * h * hk;
  mvPosition.y = ip.y + h * (1.0 - 0.3 * min(L * L, 1.0)) * (1.0 - pk * 0.25);
  vTuft = vec3(1.0) + gust * min(hk, 1.0) * vec3(0.5, 0.42, 0.06);
  ${tone ? 'vTuft *= grassTone(ip.xz);' : ''}
}
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTuft;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vTuft;')
        // blades are lit like the ground they grow from: never flip the (up) normal on back faces
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);');
    };
    m.customProgramCacheKey = () => `isle-tuft-v3-${tone ? 't' : 'f'}`;
    return m;
  };
  const tuftMat = makeTuftMaterial({ tone: true });
  const flowerMat = makeTuftMaterial({ tone: false });

  const grow = []; // per instanced mesh aGrow attributes
  const tileMembers = new Map(); // tile idx -> [{ g, i, base }]
  const addMember = (tx, tz, g, i, base) => {
    if (!map.inBounds(tx, tz)) return;
    const k = map.idx(tx, tz);
    if (!tileMembers.has(k)) tileMembers.set(k, []);
    tileMembers.get(k).push({ g, i, base });
  };
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3(), pv = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const tileOf = v => Math.round(v);

  // ---- edge tufts ----
  const edgeGeo = makeTuftGeometry(rng, bladeBase, { blades: 6, edge: true });
  const edgeList = [];
  loops.forEach((loop, li) => {
    const r = ring(loop, CAP_INSET + 0.012);
    const n = r.count;
    let carry = rng() * edgeStep, L = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = r.pts[i * 2], z0 = r.pts[i * 2 + 1], x1 = r.pts[j * 2], z1 = r.pts[j * 2 + 1];
      const segLen = Math.hypot(x1 - x0, z1 - z0);
      let s = carry;
      while (s < segLen) {
        const t = segLen > 0 ? s / segLen : 0;
        const px = x0 + (x1 - x0) * t, pz = z0 + (z1 - z0) * t;
        const nx = r.nrm[i * 2] + (r.nrm[j * 2] - r.nrm[i * 2]) * t, nz = r.nrm[i * 2 + 1] + (r.nrm[j * 2 + 1] - r.nrm[i * 2 + 1]) * t;
        const nl = Math.hypot(nx, nz) || 1;
        const ox = nx / nl, oz = nz / nl;
        const wx = tileOf(px + ox * 0.35), wz = tileOf(pz + oz * 0.35);
        // clusters: each CLUSTER_LEN segment of rim may carry a run of tall tufts, otherwise short fringe
        const seg = Math.floor((L + s) / CLUSTER_LEN), f = ((L + s) / CLUSTER_LEN) - seg;
        const hs = noise.hash2(seg, li, 71);
        const tall = hs < 0.62 && f > 0.15 && f < 0.15 + 0.35 + noise.hash2(seg, li, 72) * 0.35;
        if (!map.isBridge(wx, wz)) edgeList.push({ px, pz, ox, oz, tall, tx: tileOf(px - ox * 0.3), tz: tileOf(pz - oz * 0.3) });
        s += edgeStep * (0.75 + rng() * 0.5);
      }
      carry = s - segLen;
      L += segLen;
    }
  });
  // one culled InstancedMesh per map region (a phone sees about a third of the rims)
  const tmpC = new THREE.Color();
  const edgeChunks = new Map(); // region key -> list of edge indices
  edgeList.forEach((e, i) => {
    const yaw = Math.atan2(-e.oz, e.ox) + (rng() - 0.5) * 0.5;
    q.setFromAxisAngle(up, yaw);
    const s = e.tall ? 0.95 + rng() * 0.45 : (0.3 + rng() * 0.16) * fringeScale;
    sv.set(s, s * (0.85 + rng() * 0.35), s);
    pv.set(e.px, 0, e.pz);
    e.matrix = new THREE.Matrix4().compose(pv, q, sv);
    const v = 0.95 + rng() * 0.1;
    e.color = new THREE.Color().setRGB(v, v * (0.98 + rng() * 0.04), v * (0.92 + rng() * 0.1));
    const key = `${Math.floor(e.px / EDGE_CHUNK)},${Math.floor(e.pz / EDGE_CHUNK)}`;
    if (!edgeChunks.has(key)) edgeChunks.set(key, []);
    edgeChunks.get(key).push(i);
  });
  const edgeGroup = new THREE.Group();
  edgeGroup.name = 'edgeTufts';
  for (const list of edgeChunks.values()) {
    const geo = list === edgeChunks.values().next().value ? edgeGeo : edgeGeo.clone();
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(list.length).fill(1), 1);
    geo.setAttribute('aGrow', attr);
    const mesh = new THREE.InstancedMesh(geo, tuftMat, list.length);
    list.forEach((ei, li) => {
      const e = edgeList[ei];
      mesh.setMatrixAt(li, e.matrix);
      mesh.setColorAt(li, e.color);
      e.grow = attr; e.li = li;
      addMember(e.tx, e.tz, attr, li, 0.45);
    });
    mesh.computeBoundingSphere();
    mesh.boundingSphere.radius += 0.6;   // wind lean + the player pushing blades aside
    mesh.receiveShadow = true;
    mesh.name = 'edgeTufts';
    edgeGroup.add(mesh);
    grow.push(attr);
  }
  group.add(edgeGroup);
  const edgeMesh = edgeGroup;

  // ---- field tufts + flowers ----
  const exposed = (x, z, dx, dz) => !map.isLand(x + dx, z + dz);
  const fieldList = [], flowerList = [];
  for (let z = 0; z < map.h; z++) for (let x = 0; x < map.w; x++) {
    if (!map.isLand(x, z)) continue;
    const lim = (dx, dz) => (exposed(x, z, dx, dz) ? 0.24 : 0.48);
    const pick = () => {
      const lx = -lim(-1, 0) + rng() * (lim(-1, 0) + lim(1, 0));
      const lz = -lim(0, -1) + rng() * (lim(0, -1) + lim(0, 1));
      return [x + lx, z + lz];
    };
    const h1 = noise.hash2(x, z, 101), h2 = noise.hash2(x, z, 202);
    const nt = h1 < 0.35 ? 0 : h1 < 0.75 ? 1 : 2;
    for (let k = 0; k < nt; k++) { const p = pick(); if (noise.hash2(x * 3 + k, z, 505) < keepField) fieldList.push({ p, tx: x, tz: z }); }
    if (h2 < 0.2 * keepFlower) {
      const [cx, cz] = pick();
      const nf = 1 + Math.floor(noise.hash2(x, z, 303) * 3);
      const orange = noise.hash2(x, z, 404) < 0.55;
      for (let k = 0; k < nf; k++) {
        const fx = cx + (rng() - 0.5) * 0.22, fz = cz + (rng() - 0.5) * 0.22;
        if (Math.abs(fx - x) > 0.42 || Math.abs(fz - z) > 0.42) continue;
        flowerList.push({ p: [fx, fz], tx: x, tz: z, orange: k === 0 ? orange : rng() < 0.5 ? orange : !orange });
      }
    }
  }
  const fieldGeo = makeTuftGeometry(rng, bladeBase, { blades: 5, edge: false });
  const fieldGrow = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, fieldList.length)).fill(1), 1);
  fieldGeo.setAttribute('aGrow', fieldGrow);
  const fieldMesh = new THREE.InstancedMesh(fieldGeo, tuftMat, Math.max(1, fieldList.length));
  fieldList.forEach((f, i) => {
    q.setFromAxisAngle(up, (rng() - 0.5) * 1.2);
    const s = 0.8 + rng() * 0.5;
    sv.set(s, s, s);
    pv.set(f.p[0], 0, f.p[1]);
    m4.compose(pv, q, sv);
    fieldMesh.setMatrixAt(i, m4);
    const v = 0.95 + rng() * 0.1;
    fieldMesh.setColorAt(i, tmpC.setRGB(v, v, v * (0.94 + rng() * 0.08)));
    addMember(f.tx, f.tz, fieldGrow, i, 0);
  });
  fieldMesh.count = fieldList.length;
  fieldMesh.receiveShadow = true;
  fieldMesh.frustumCulled = false;
  fieldMesh.name = 'fieldTufts';
  group.add(fieldMesh);
  grow.push(fieldGrow);

  const flowerGeo = makeFlowerGeometry();
  const flowerGrow = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, flowerList.length)).fill(1), 1);
  flowerGeo.setAttribute('aGrow', flowerGrow);
  const flowerMesh = new THREE.InstancedMesh(flowerGeo, flowerMat, Math.max(1, flowerList.length));
  const cOrange = col(P.flowerOrange), cWhite = col(P.flowerWhite);
  flowerList.forEach((f, i) => {
    q.setFromAxisAngle(up, rng() * Math.PI * 2);
    const s = 0.8 + rng() * 0.45;
    sv.set(s, s, s);
    pv.set(f.p[0], 0.012, f.p[1]);
    m4.compose(pv, q, sv);
    flowerMesh.setMatrixAt(i, m4);
    flowerMesh.setColorAt(i, f.orange ? cOrange : cWhite);
    addMember(f.tx, f.tz, flowerGrow, i, 0);
  });
  flowerMesh.count = flowerList.length;
  flowerMesh.receiveShadow = true;
  flowerMesh.frustumCulled = false;
  flowerMesh.name = 'flowers';
  group.add(flowerMesh);
  grow.push(flowerGrow);

  // =====================================================================
  // Shore stakes: small cream pegs at tile boundaries along straight shores (like the reference)
  // =====================================================================
  const stakes = buildStakes(loops, map, noise, rng, col);
  if (stakes) group.add(stakes);

  // ---- hide tufts/flowers under buildings (smoothly) ----
  const animating = new Map(); // key -> { g, i, target }
  const setTile = (x, z, covered) => {
    const list = tileMembers.get(map.idx(x, z));
    if (!list) return;
    for (const m of list) animating.set(`${grow.indexOf(m.g)}:${m.i}`, { g: m.g, i: m.i, target: covered ? m.base : 1 });
  };
  const isBuilding = e => e && !e.resource;
  const offs = [];
  if (events?.on) {
    offs.push(events.on('build:placed', ({ entity }) => isBuilding(entity) && setTile(entity.x, entity.z, true)));
    offs.push(events.on('build:removed', ({ entity }) => isBuilding(entity) && setTile(entity.x, entity.z, false)));
  }
  // anything already standing (scenarios run after create, but be safe)
  for (const e of sim?.entities?.values?.() || []) if (isBuilding(e)) setTile(e.x, e.z, true);

  // ---- camp: station footprints (not sim entities) and bridge landings ----
  const coverRect = fp => {
    if (!Array.isArray(fp)) return;
    const [x0, z0, w, h] = fp;
    for (let z = z0; z < z0 + h; z++) for (let x = x0; x < x0 + w; x++) { setTile(x, z, true); grass.cover(x, z, 1); }
  };
  const tucked = new Set();
  const stakeAnims = [];
  // tuck away rim tufts and stakes where a bridge deck meets the shore
  const clearLanding = (id, tiles, orientation) => {
    if (!tiles?.length || tucked.has(id)) return;
    tucked.add(id);
    const [x0, z0] = tiles[0];
    let dx = orientation === 1 ? 1 : 0, dz = orientation === 1 ? 0 : 1;
    if (tiles.length > 1) { dx = Math.sign(tiles[1][0] - x0); dz = Math.sign(tiles[1][1] - z0); }
    const ax = dz ? 1 : 0, az = dx ? 1 : 0;              // across (bridgeFrame)
    const uMin = -0.6 - 0.2, uMax = tiles.length - 0.4 + 0.2;
    const inDeck = (px, pz, vMax) => {
      const ox = px - x0, oz = pz - z0;
      const u = ox * dx + oz * dz, v = ox * ax + oz * az;
      return u > uMin && u < uMax && Math.abs(v) < vMax;
    };
    edgeList.forEach(e => { if (inDeck(e.px, e.pz, 0.56)) animating.set(`${grow.indexOf(e.grow)}:${e.li}`, { g: e.grow, i: e.li, target: 0 }); });
    if (stakes?.userData.spots) stakes.userData.spots.forEach((sp, i) => {
      if (inDeck(sp.x, sp.z, 0.75) && !stakeAnims.some(a => a.i === i)) stakeAnims.push({ i, t: 0 });
    });
  };
  if (ctx.camp) {
    coverRect(CAMP_STATIONS.hearth?.footprint);     // the camp view always draws the hearth
    for (const st of ctx.camp.stations?.values?.() || []) coverRect(st.def?.footprint);
    if (events?.on) {
      offs.push(events.on('station:built', ({ station }) => coverRect(station?.def?.footprint || CAMP_STATIONS[station?.id]?.footprint)));
      offs.push(events.on('bridge:start', ({ bridge }) => {
        const d = map.bridges?.[bridge?.id] || bridge;
        clearLanding(bridge?.id, d?.tiles, d?.orientation);
      }));
    }
    for (const id of ctx.camp.bridges || []) { const d = map.bridges?.[id]; if (d) clearLanding(id, d.tiles, d.orientation); }
  }

  // =====================================================================
  // Bridges
  // =====================================================================
  const bridge = buildBridges(map, P, rng);
  if (bridge) group.add(bridge);

  // =====================================================================
  let windT = 0;
  const playerPos = new THREE.Vector3();
  return {
    group, cap, rim, tufts: edgeMesh, edgeTuftCount: edgeList.length, fieldTufts: fieldMesh, flowers: flowerMesh, bridges: bridge, stakes, loops,
    grass,
    // The shared wind field, so foliage elsewhere can sway in sync with the grass waves:
    //  - JS: gustAt(x, z) 0..1 gust strength now, lean(x, z) lean as a fraction of height along dir
    //  - GLSL: include glsl (declares uWindTime + uSheen; add both from uniforms) and call windGust(xz)
    //  - uniforms.uWindTime is advanced from dt in update(), so pausing freezes it
    wind: {
      params: WIND, dir: WIND.dir, glsl: WIND_GLSL,
      uniforms: { uWindTime: shared.uWindTime, uSheen: shared.uSheen },
      gustAt: (x, z) => gustAt(x, z, windT),
      lean: (x, z) => leanAt(x, z, windT),
      get time() { return windT; },
    },
    // Mark tiles as covered by something that isn't a sim entity (a floor plate, a pile, a camp station):
    // grass blades there shrink away and the ones around lean aside, tufts and flowers tuck in; all eased.
    // amount 0..1 (0.5 = flattened, 1 = gone); cover(x, z, w, h, 0) brings them back.
    cover(x0, z0, w = 1, h = 1, amount = 1) {
      for (let z = z0; z < z0 + h; z++) for (let x = x0; x < x0 + w; x++) { setTile(x, z, amount >= 0.5); grass.cover(x, z, amount); }
    },
    groundHeight(x, z) {
      const tx = Math.round(x), tz = Math.round(z);
      if (map.isLand(tx, tz)) return 0;
      if (map.isBridge(tx, tz)) return BRIDGE_Y;
      return config.WATER_Y;
    },
    update(dt) {
      windT += dt;
      shared.uWindTime.value = windT;
      const pp = ctx.views.player?.getPosition?.(playerPos);
      if (!(pp && Number.isFinite(pp.x)) && sim?.player) playerPos.set(sim.player.x, 0, sim.player.z);
      shared.uPlayer.value.copy(playerPos);
      grass.update(dt);
      if (stakeAnims.length) {
        // a tiny anticipation grow, then shrink away (ease in)
        const sp = stakes.userData.spots;
        for (let n = stakeAnims.length - 1; n >= 0; n--) {
          const a = stakeAnims[n];
          a.t += dt;
          const k = Math.min(1, a.t / 0.42);
          const f = k < 0.25 ? 1 + 0.12 * Math.sin((k / 0.25) * Math.PI / 2) : 1.12 * (1 - Math.pow((k - 0.25) / 0.75, 3));
          const s0 = sp[a.i];
          m4.compose(pv.set(s0.x, 0, s0.z), s0.q, sv.copy(s0.s).multiplyScalar(Math.max(0, f)));
          stakes.setMatrixAt(a.i, m4);
          if (k >= 1) { stakeAnims.splice(n, 1); stakes.setMatrixAt(a.i, m4.makeScale(0, 0, 0)); }
        }
        stakes.instanceMatrix.needsUpdate = true;
      }
      if (animating.size) {
        const touched = new Set();
        for (const [k, a] of animating) {
          const arr = a.g.array;
          const cur = arr[a.i];
          const lambda = a.target < cur ? 14 : 9;
          let v = cur + (a.target - cur) * (1 - Math.exp(-lambda * dt));
          if (Math.abs(v - a.target) < 0.004) { v = a.target; animating.delete(k); }
          arr[a.i] = v;
          touched.add(a.g);
        }
        for (const g of touched) g.needsUpdate = true;
      }
    },
    dispose() { offs.forEach(f => f?.()); },
  };
}

// ---------------------------------------------------------------------
// Painted grass texture: calm, broad blade strokes over a high-key yellow-green, seamless,
// covers TEX_TILES x TEX_TILES tiles. Returns the texture and its average colour (linear).
function paintGrassTexture(rng) {
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.fillStyle = '#8fbb52';
  g.fillRect(0, 0, S, S);
  const wrapDraw = (x, y, r, fn) => {
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
      if (x + ox < -r || x + ox > S + r || y + oy < -r || y + oy > S + r) continue;
      fn(x + ox, y + oy);
    }
  };
  // a few very soft blotches
  for (let i = 0; i < 14; i++) {
    const x = rng() * S, y = rng() * S, r = 70 + rng() * 110;
    const light = rng() < 0.5;
    wrapDraw(x, y, r, (px, py) => {
      const gr = g.createRadialGradient(px, py, 0, px, py, r);
      gr.addColorStop(0, light ? 'rgba(176,214,104,0.16)' : 'rgba(110,160,62,0.14)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.fillRect(px - r, py - r, r * 2, r * 2);
    });
  }
  // broad blade strokes (tips point up the screen = canvas up, flipY is off)
  const blade = (px, py, len, w, ang, color) => {
    const dx = Math.sin(ang), dy = -Math.cos(ang);
    const nx = -dy, ny = dx;
    const bend = (rng() - 0.5) * len * 0.3;
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(px - nx * w, py - ny * w);
    g.quadraticCurveTo(px + dx * len * 0.55 + nx * bend - nx * w * 0.5, py + dy * len * 0.55 + ny * bend - ny * w * 0.5, px + dx * len + nx * bend * 1.4, py + dy * len + ny * bend * 1.4);
    g.quadraticCurveTo(px + dx * len * 0.55 + nx * bend + nx * w * 0.5, py + dy * len * 0.55 + ny * bend + ny * w * 0.5, px + nx * w, py + ny * w);
    g.closePath();
    g.fill();
  };
  const strokes = [
    { n: 170, cols: ['rgba(114,160,66,0.24)', 'rgba(106,154,62,0.2)'], len: [60, 104], w: [9, 14] },
    { n: 190, cols: ['rgba(182,214,112,0.22)', 'rgba(170,206,102,0.2)'], len: [48, 86], w: [7, 12] },
    { n: 160, cols: ['rgba(132,178,76,0.18)', 'rgba(162,200,96,0.16)'], len: [26, 46], w: [4, 7] },
  ];
  for (const st of strokes) {
    for (let i = 0; i < st.n; i++) {
      const x = rng() * S, y = rng() * S;
      const len = st.len[0] + rng() * (st.len[1] - st.len[0]);
      const w = st.w[0] + rng() * (st.w[1] - st.w[0]);
      const ang = (rng() - 0.5) * 0.7;
      const c = st.cols[Math.floor(rng() * st.cols.length)];
      wrapDraw(x, y, len + 4, (px, py) => blade(px, py, len, w, ang, c));
    }
  }
  // average colour (sRGB bytes -> linear), so blades and tufts match the painted ground
  const d = g.getImageData(0, 0, S, S).data;
  let r = 0, gg = 0, b = 0;
  for (let i = 0; i < d.length; i += 16) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
  const n = d.length / 16;
  const average = new THREE.Color().setRGB(r / n / 255, gg / n / 255, b / n / 255, THREE.SRGBColorSpace);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.flipY = false;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return { texture: tex, average };
}

// Low-frequency tint over the map (1 texel per tile, linearly filtered).
function makeTintTexture(map, noise) {
  const data = new Uint8Array(map.w * map.h * 4);
  for (let z = 0; z < map.h; z++) for (let x = 0; x < map.w; x++) {
    const n = noise.fbm2(x * 0.16 + 3.1, z * 0.16 + 7.7, 3, 41);
    const v = Math.max(0, Math.min(1, (n - 0.5) * 1.8 + 0.5));
    const i = (z * map.w + x) * 4;
    data[i] = v * 255; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 255;
  }
  const t = new THREE.DataTexture(data, map.w, map.h, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

// A tuft of curved blades with its base at the origin. Edge tufts lean toward local +x.
// Colours derive from the painted ground's average so tufts grow out of it seamlessly.
function makeTuftGeometry(rng, groundAvg, { blades, edge }) {
  const pos = [], colr = [], nrm = [];
  const base = groundAvg.clone().multiplyScalar(0.84);
  const mid = groundAvg.clone().multiplyScalar(1.02);
  const tip = groundAvg.clone().multiply(new THREE.Color(1.3, 1.24, 1.0));
  for (let b = 0; b < blades; b++) {
    const bx = edge ? (rng() - 0.5) * 0.035 : (rng() - 0.5) * 0.07;
    const bz = edge ? (b / (blades - 1) - 0.5) * 0.11 + (rng() - 0.5) * 0.02 : (rng() - 0.5) * 0.07;
    const yaw = edge ? (rng() - 0.5) * 1.1 : (b / blades) * Math.PI * 2 + rng() * 0.8;
    const tilt = edge ? 0.38 + rng() * 0.45 : 0.18 + rng() * 0.3;
    const h = (edge ? 0.15 : 0.12) + rng() * (edge ? 0.1 : 0.08);
    const w = (edge ? 0.027 : 0.022) + rng() * 0.009;
    const dirAt = tl => [Math.cos(yaw) * Math.sin(tl), Math.cos(tl), -Math.sin(yaw) * Math.sin(tl)];
    const d1 = dirAt(tilt * 0.75), d2 = dirAt(Math.min(1.35, tilt * 1.35));
    const wx = Math.sin(yaw), wz = Math.cos(yaw); // horizontal, perpendicular to the lean
    const m = [bx + d1[0] * h * 0.55, d1[1] * h * 0.55, bz + d1[2] * h * 0.55];
    const t = [m[0] + d2[0] * h * 0.5, m[1] + d2[1] * h * 0.5, m[2] + d2[2] * h * 0.5];
    const L0 = [bx - wx * w, 0, bz - wz * w], R0 = [bx + wx * w, 0, bz + wz * w];
    const L1 = [m[0] - wx * w * 0.62, m[1], m[2] - wz * w * 0.62], R1 = [m[0] + wx * w * 0.62, m[1], m[2] + wz * w * 0.62];
    const tris = [[L0, R0, R1, base, base, mid], [L0, R1, L1, base, mid, mid], [L1, R1, t, mid, mid, tip]];
    for (const [a, bb, c, ca, cb, cc] of tris) {
      pos.push(...a, ...bb, ...c);
      colr.push(ca.r, ca.g, ca.b, cb.r, cb.g, cb.b, cc.r, cc.g, cc.b);
      nrm.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
  g.computeBoundingSphere();
  return g;
}

// Five-petal flower lying just above the grass. Petals are white (tinted per instance), centre warm yellow.
function makeFlowerGeometry() {
  const pos = [], colr = [], nrm = [];
  const centre = new THREE.Color('#ffd25a');
  const petal = new THREE.Color('#ffffff');
  const y = 0.02, R = 0.05, r = 0.017;
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const a0 = a - 0.42, a1 = a + 0.42;
    const tipP = [Math.cos(a) * R, y + 0.004, Math.sin(a) * R];
    const s0 = [Math.cos(a0) * R * 0.62, y + 0.002, Math.sin(a0) * R * 0.62];
    const s1 = [Math.cos(a1) * R * 0.62, y + 0.002, Math.sin(a1) * R * 0.62];
    const c0 = [0, y, 0];
    for (const [p, c] of [[c0, petal], [s1, petal], [tipP, petal], [c0, petal], [tipP, petal], [s0, petal]]) {
      pos.push(...p); colr.push(c.r, c.g, c.b); nrm.push(0, 1, 0);
    }
  }
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2, b = ((i + 1) / 5) * Math.PI * 2;
    for (const p of [[0, y + 0.006, 0], [Math.cos(b) * r, y + 0.005, Math.sin(b) * r], [Math.cos(a) * r, y + 0.005, Math.sin(a) * r]]) {
      pos.push(...p); colr.push(centre.r, centre.g, centre.b); nrm.push(0, 1, 0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------------
// Small faceted cream stakes standing on the sand lip at some tile boundaries of straight shores.
function buildStakes(loops, map, noise, rng, col) {
  const spots = [];
  loops.forEach((loop, li) => {
    const cs = loop.corners;
    for (let i = 0; i < cs.length; i++) {
      const a = cs[i], b = cs[(i + 1) % cs.length];
      // inner (concave) corners often get a peg too, standing in the corner of the sand
      if (!a.convex && noise.hash2(Math.round(a.x * 2), Math.round(a.z * 2), 616 + li) < 0.45) {
        const ox = a.bx - a.ax, oz = a.bz - a.az;   // diagonal pointing out over the water
        const l = Math.hypot(ox, oz) || 1;
        if (!map.isBridge(Math.round(a.x + ox / l * 0.5), Math.round(a.z + oz / l * 0.5))) {
          spots.push({ x: a.x + (ox / l) * 0.07, z: a.z + (oz / l) * 0.07, ox: ox / l, oz: oz / l });
        }
      }
      const dx = a.bx, dz = a.bz;                 // heading of the straight run a -> b
      const len = Math.round(Math.abs(b.x - a.x) + Math.abs(b.z - a.z));
      const ox = dz, oz = -dx;                    // outward (water side: land is on the right)
      for (let k = 1; k < len; k++) {
        const px = a.x + dx * k, pz = a.z + dz * k;
        if (noise.hash2(Math.round(px * 2), Math.round(pz * 2), 515 + li) > STAKE_CHANCE) continue;
        // skip if a bridge touches this stretch of shore
        const wx = px + ox * 0.5, wz = pz + oz * 0.5;
        const t1 = [Math.round(wx + dx * 0.5), Math.round(wz + dz * 0.5)], t2 = [Math.round(wx - dx * 0.5), Math.round(wz - dz * 0.5)];
        if (map.isBridge(...t1) || map.isBridge(...t2)) continue;
        spots.push({ x: px + ox * 0.005 + dx * (rng() - 0.5) * 0.08, z: pz + oz * 0.005 + dz * (rng() - 0.5) * 0.08, ox, oz });
      }
    }
  });
  if (!spots.length) return null;
  // a chunky 6-sided peg with a domed, slightly slanted top; base well below the lip
  const g = new THREE.CylinderGeometry(0.085, 0.1, 0.46, 6, 3);
  g.translate(0, -0.13, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y > 0.09) {          // top ring: dome it and slant it a little
      const r = Math.hypot(p.getX(i), p.getZ(i));
      p.setY(i, y - r * 0.55 + p.getX(i) * 0.25);
      p.setX(i, p.getX(i) * 0.78); p.setZ(i, p.getZ(i) * 0.78);
    } else if (y > -0.05) {  // shoulder: slightly fatter, so the top reads rounded
      p.setX(i, p.getX(i) * 1.04); p.setZ(i, p.getZ(i) * 1.04);
    }
  }
  g.deleteAttribute('uv');
  const geo = g.toNonIndexed();
  geo.computeVertexNormals();
  // cream like the rocks, with a little self-light so the side facing the camera (away from the sun)
  // stays light instead of turning grey-brown
  const mat = new THREE.MeshLambertMaterial({ color: col('#fbecc0'), emissive: col('#4a3c22'), flatShading: true });
  const mesh = new THREE.InstancedMesh(geo, mat, spots.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  spots.forEach((s, i) => {
    const sc = 0.85 + rng() * 0.4;
    e.set((rng() - 0.5) * 0.18, rng() * Math.PI * 2, (rng() - 0.5) * 0.18);
    q.setFromEuler(e);
    s.q = q.clone(); s.s = new THREE.Vector3(sc, sc * (0.8 + rng() * 0.45), sc);
    m4.compose(new THREE.Vector3(s.x, 0, s.z), q, s.s);
    mesh.setMatrixAt(i, m4);
    const v = 0.94 + rng() * 0.08;
    mesh.setColorAt(i, new THREE.Color(v, v * 0.99, v * 0.95));
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'shoreStakes';
  mesh.userData.spots = spots;
  return mesh;
}

// ---------------------------------------------------------------------
// Plank bridges with posts and a sagging rope rail. One merged mesh.
function buildBridges(map, P, rng) {
  const runs = [];
  const seen = new Uint8Array(map.w * map.h);
  for (let z = 0; z < map.h; z++) for (let x = 0; x < map.w; x++) {
    const o = map.bridge[map.idx(x, z)];
    if (!o || seen[map.idx(x, z)]) continue;
    const [dx, dz] = o === 1 ? [1, 0] : [0, 1];
    let len = 0;
    while (map.inBounds(x + dx * len, z + dz * len) && map.bridge[map.idx(x + dx * len, z + dz * len)] === o) {
      seen[map.idx(x + dx * len, z + dz * len)] = 1;
      len++;
    }
    runs.push({ x, z, len, o });
  }
  if (!runs.length) return null;

  const parts = [];
  const wood = new THREE.Color(P.wood), woodDark = new THREE.Color(P.woodDark), rope = new THREE.Color('#f1dfb4');
  const add = (geo, color, u, y, v, run, rotY = 0) => {
    geo.deleteAttribute('uv');
    const m = new THREE.Matrix4();
    // local u = along the walking direction, v = across
    const wx = run.o === 1 ? run.x + u : run.x + v;
    const wz = run.o === 1 ? run.z + v : run.z + u;
    const yaw = (run.o === 1 ? 0 : -Math.PI / 2) + rotY;
    m.compose(new THREE.Vector3(wx, y, wz), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(1, 1, 1));
    geo.applyMatrix4(m);
    const n = geo.attributes.position.count;
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { c[i * 3] = color.r; c[i * 3 + 1] = color.g; c[i * 3 + 2] = color.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    parts.push(geo);
  };
  const jitter = (c, amt) => c.clone().offsetHSL((rng() - 0.5) * 0.02, (rng() - 0.5) * 0.06, (rng() - 0.5) * amt);

  for (const run of runs) {
    const u0 = -0.5 - 0.1, u1 = run.len - 0.5 + 0.1;
    // stringers under the planks
    for (const v of [-0.3, 0.3]) add(new THREE.BoxGeometry(u1 - u0, 0.06, 0.07), woodDark, (u0 + u1) / 2, BRIDGE_Y - 0.085, v, run);
    // planks across
    const pitch = 0.205;
    const count = Math.floor((u1 - u0) / pitch);
    const start = (u0 + u1) / 2 - ((count - 1) * pitch) / 2;
    for (let i = 0; i < count; i++) {
      const len = 0.82 + (rng() - 0.5) * 0.08;
      const g = new THREE.BoxGeometry(0.17, 0.045, len);
      add(g, jitter(wood, 0.07), start + i * pitch + (rng() - 0.5) * 0.01, BRIDGE_Y - 0.0225 + (rng() - 0.5) * 0.006, (rng() - 0.5) * 0.03, run, (rng() - 0.5) * 0.05);
    }
    // posts + rope rail
    const postU = [0.5 - 0.5 - 0.38];
    for (let k = 1; k < run.len; k++) postU.push(k - 0.5);
    postU.push(run.len - 1 + 0.38);
    const postTop = 0.15;
    for (const v of [-0.47, 0.47]) {
      for (const u of postU) {
        add(new THREE.CylinderGeometry(0.048, 0.056, postTop + 0.8, 7), jitter(woodDark, 0.05), u, (postTop - 0.8) / 2, v, run);
        add(new THREE.CylinderGeometry(0.058, 0.058, 0.035, 7), jitter(wood, 0.04), u, postTop - 0.01, v, run);
      }
      for (let k = 0; k < postU.length - 1; k++) {
        const ua = postU[k], ub = postU[k + 1];
        const segs = 4;
        for (let s = 0; s < segs; s++) {
          const t0 = s / segs, t1 = (s + 1) / segs;
          const ya = postTop - 0.035 - Math.sin(t0 * Math.PI) * 0.045, yb = postTop - 0.035 - Math.sin(t1 * Math.PI) * 0.045;
          const xa = ua + (ub - ua) * t0, xb = ua + (ub - ua) * t1;
          const len = Math.hypot(xb - xa, yb - ya);
          const g = new THREE.CylinderGeometry(0.011, 0.011, len + 0.004, 5);
          g.rotateZ(Math.atan2(yb - ya, xb - xa) - Math.PI / 2);
          add(g, rope, (xa + xb) / 2, (ya + yb) / 2, v, run);
        }
      }
    }
  }
  const geo = mergeGeometries(parts, false);
  parts.forEach(p => p.dispose());
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = 'bridges';
  return mesh;
}
