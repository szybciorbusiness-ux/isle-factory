// Dense grass: short instanced blade clumps over every grass tile, bent by the shared wind field
// (world/wind.js), parted around the player, buildings and resources, and shrunk away under buildings.
//
// Blades are built from per-instance attributes (InstancedBufferGeometry on plain Meshes, one per map
// chunk so frustum culling works), so the wind displacement is part of `transformed` and the shadow
// lookup, fog and lighting all see the bent blade. Blades are lit like the ground (up normal) and coloured
// by the same tile checker as the grass cap (TONE_GLSL), darker at the root and warmer at the tip, so
// the field reads as a soft painted fur that brightens where a gust bends it.
//
// density (ctx.quality.grassDensity, 0.5 on phones) keeps every other clump slot in a staggered pattern
// (still evenly spread) and widens the clumps a little, so the field reads the same with half the blades.
// cover(x, z, amount) marks extra tiles as covered (camp stations, which aren't sim entities): blades there
// shrink away and the ones around lean aside, exactly like under a factory building.
import * as THREE from 'three';
import { WIND, WIND_GLSL } from './wind.js';
import { ring, insidePoly } from './outline.js';

// ---- tuning ----
const GRID_X = 5, GRID_Z = 4;      // stratified clump slots per tile
const BLADES = 4;                  // blades per clump (3 triangles each)
const BLADE_H = [0.085, 0.085];    // blade height: min + random range
const BLADE_W = [0.02, 0.012];     // blade half-width at the root: min + random range
const CHUNK = 8;                   // tiles per chunk side (one draw call per chunk)
const EDGE_MARGIN = 0.035;         // keep roots this far inside the grass cap outline
const PART_BUILD = 0.95;           // lean away from building tiles
const PART_RES = 0.55;             // lean away from trees/rocks/stumps (weight of the G channel)
const PLAYER_R = [0.14, 0.72];     // player push radius (full .. none)
const PLAYER_PUSH = 1.35;
const OCC_LAMBDA = 7;              // how fast occupancy (and so the blades) reacts

// Tile checker + painted teeth, shared by the grass cap and the blades (so blades match the ground).
// Expects uniforms uTint (low-frequency tint, 1 texel/tile), uTintSize, uChecker.
export const TONE_GLSL = /* glsl */`
uniform sampler2D uTint;
uniform vec2 uTintSize;
uniform float uChecker;
float toneHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// tile index at a world point, with the lower tile's blade-shaped teeth poking up into the tile above
vec2 toneTile(vec2 w) {
  vec2 g = w + 0.5;
  float kb = floor(g.y + 0.5);
  float tf = g.x * 8.0 + toneHash(vec2(kb, 3.7)) * 7.0;
  float cell = floor(tf), lx = fract(tf);
  float tipAt = 0.25 + 0.5 * toneHash(vec2(cell, kb + 11.0));
  float prof = lx < tipAt ? lx / tipAt : (1.0 - lx) / (1.0 - tipAt);
  float teeth = (0.05 + 0.2 * toneHash(vec2(cell, kb))) * prof * prof;
  float side = (toneHash(vec2(floor(g.x + 0.5), floor(g.y * 7.0))) - 0.5) * 0.05;
  return floor(vec2(g.x + side, g.y + teeth));
}
vec3 grassTone(vec2 w) {
  vec2 tile = toneTile(w);
  float par = mod(tile.x + tile.y, 2.0) * 2.0 - 1.0;
  float chk = par * uChecker + (toneHash(tile + 0.37) - 0.5) * uChecker * 0.35;
  // light tiles go warmer/yellower, dark tiles a little cooler
  vec3 c = chk > 0.0 ? vec3(1.0 + chk * 1.2, 1.0 + chk * 1.0, 1.0 + chk * 0.55)
                     : vec3(1.0 + chk * 1.1, 1.0 + chk * 0.95, 1.0 + chk * 0.85);
  float tn = texture2D(uTint, (w + 0.5) / uTintSize).r;
  return c * mix(vec3(0.95, 0.97, 0.99), vec3(1.04, 1.03, 0.97), tn);
}
`;

export function createGrassField({ map, sim, loops, shared, baseColor, capInset, rng, density = 1 }) {
  density = Math.max(0.25, Math.min(1, Number(density) || 1));
  const sparse = density < 0.75;               // keep a staggered half of the clump slots
  const widen = sparse ? Math.sqrt(1 / 0.5) * 0.9 : 1; // fuller clumps where there are fewer of them
  const group = new THREE.Group();
  group.name = 'grassField';

  // ---------- occupancy (R: building cover, G: resource presence), 1 texel per tile ----------
  const occData = new Uint8Array(map.w * map.h * 4);
  const occCur = new Float32Array(map.w * map.h * 2);
  const occWant = new Float32Array(map.w * map.h * 2);
  const extraCover = new Float32Array(map.w * map.h);   // tiles covered by things that aren't sim entities
  const occTex = new THREE.DataTexture(occData, map.w, map.h, THREE.RGBAFormat);
  occTex.magFilter = THREE.LinearFilter;
  occTex.minFilter = THREE.LinearFilter;
  occTex.wrapS = occTex.wrapT = THREE.ClampToEdgeWrapping;
  occTex.needsUpdate = true;

  // ---------- one clump: BLADES curved blades, root at the origin ----------
  const clumpGeo = (() => {
    const pos = [], nrm = [], bl = [], idx = [];
    for (let b = 0; b < BLADES; b++) {
      const ang = (b / BLADES) * Math.PI * 2 + rng() * 1.2;
      const rr = (0.012 + rng() * 0.055) * widen;
      const bx = Math.cos(ang) * rr, bz = Math.sin(ang) * rr;
      const yaw = rng() * Math.PI * 2;               // which way the blade leans at rest
      const tilt = 0.12 + rng() * 0.3;
      const h = BLADE_H[0] + rng() * BLADE_H[1];
      const w = (BLADE_W[0] + rng() * BLADE_W[1]) * (sparse ? 1.15 : 1);
      const lx = Math.cos(yaw), lz = Math.sin(yaw);  // lean direction
      const px = -lz, pz = lx;                       // across the blade
      const ph = rng() * 6.2831;
      const v0 = pos.length / 3;
      const at = (k, side, wk) => {
        const y = h * k;
        const off = Math.sin(tilt) * h * k * k;      // curved lean
        pos.push(bx + lx * off + px * w * wk * side, y * Math.cos(tilt * k), bz + lz * off + pz * w * wk * side);
        nrm.push(0, 1, 0);
        bl.push(k, ph);
      };
      at(0, -1, 1); at(0, 1, 1); at(0.55, -1, 0.72); at(0.55, 1, 0.72); at(1, 0, 0);
      idx.push(v0, v0 + 1, v0 + 3, v0, v0 + 3, v0 + 2, v0 + 2, v0 + 3, v0 + 4);
    }
    return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), bl: new Float32Array(bl), idx };
  })();

  // ---------- material ----------
  const uniforms = {
    ...shared,                     // uWindTime, uTint, uTintSize, uChecker, uPlayer
    uOcc: { value: occTex },
    uOccSize: { value: new THREE.Vector2(map.w, map.h) },
    uBladeBase: { value: baseColor.clone() },
  };
  const material = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec2 aBlade;
attribute vec4 aRoot;
attribute float aSeed;
uniform sampler2D uOcc;
uniform vec2 uOccSize;
uniform vec3 uPlayer;
uniform vec3 uBladeBase;
varying vec3 vBladeCol;
${WIND_GLSL}
${TONE_GLSL}
float occAt(vec2 p) { vec4 o = texture2D(uOcc, (p + 0.5) / uOccSize); return o.r * ${PART_BUILD.toFixed(3)} + o.g * ${PART_RES.toFixed(3)}; }`)
      .replace('#include <begin_vertex>', `vec3 transformed = vec3(position);
{
  float cs = cos(aRoot.z), sn = sin(aRoot.z);
  transformed.xz = vec2(cs * transformed.x - sn * transformed.z, sn * transformed.x + cs * transformed.z) * aRoot.w;
  transformed.y *= aRoot.w;
  vec2 root = aRoot.xy;
  float hk = aBlade.x;
  // under a building: shrink away
  float cover = texture2D(uOcc, (floor(root + 0.5) + 0.5) / uOccSize).r;
  float grow = 1.0 - cover;
  // part around buildings / resources (lean down the occupancy gradient)
  vec2 lean = -vec2(occAt(root + vec2(0.28, 0.0)) - occAt(root - vec2(0.28, 0.0)),
                    occAt(root + vec2(0.0, 0.28)) - occAt(root - vec2(0.0, 0.28)));
  // part around the player
  vec2 away = root - uPlayer.xz;
  float dp = length(away);
  float pk = 1.0 - smoothstep(${PLAYER_R[0].toFixed(3)}, ${PLAYER_R[1].toFixed(3)}, dp);
  lean += away / max(dp, 1e-3) * pk * ${PLAYER_PUSH.toFixed(3)};
  // wind
  float gust;
  float wl = windLean(root, aSeed * 6.2831 + aBlade.y * 0.35, gust);
  lean += WIND_DIR * wl * (1.0 - pk * 0.6);
  float L = length(lean);
  transformed.xz += lean * transformed.y * hk;
  transformed.y *= (1.0 - 0.32 * min(L * L, 1.0)) * (1.0 - pk * 0.3);
  transformed *= grow;
  transformed.xz += root;
  // colour: the ground's own tone (so the field reads as soft painted fur, not noise), a little
  // deeper at the root and warmer at the tip; gust crests bend the blades over and light them up
  vec3 col = uBladeBase * grassTone(root);
  col *= mix(vec3(0.9, 0.91, 0.93), vec3(1.07, 1.06, 0.95), hk);
  float sheen = windSheen(root);
  col *= 1.0 + sheen * (0.45 + 0.55 * hk) * ${(WIND.streak * 1.25).toFixed(3)} * vec3(1.0, 0.86, 0.3);
  col *= 0.965 + 0.07 * fract(aSeed * 7.13);
  vBladeCol = col;
}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBladeCol;')
      .replace('#include <color_fragment>', 'diffuseColor.rgb *= vBladeCol;')
      // lit like the ground they grow from: never flip the up normal on back faces
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);');
  };
  material.customProgramCacheKey = () => 'isle-blades-v2';

  // ---------- scatter roots, chunk by chunk ----------
  const isLand = (x, z) => map.isLand(x, z);
  // exact test against the rounded cap outline (even-odd over every loop's ring), only near shores
  const rings = loops.map(l => {
    const r = ring(l, capInset + EDGE_MARGIN, 3);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < r.count; i++) {
      x0 = Math.min(x0, r.pts[i * 2]); x1 = Math.max(x1, r.pts[i * 2]);
      z0 = Math.min(z0, r.pts[i * 2 + 1]); z1 = Math.max(z1, r.pts[i * 2 + 1]);
    }
    return { pts: r.pts, x0, x1, z0, z1 };
  });
  const inCap = (px, pz) => {
    let n = 0;
    for (const r of rings) if (px >= r.x0 && px <= r.x1 && pz >= r.z0 && pz <= r.z1 && insidePoly(r.pts, px, pz)) n++;
    return (n & 1) === 1;
  };
  const nearShore = (x, z) => {
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!isLand(x + dx, z + dz)) return true;
    return false;
  };
  const inside = (x, z, lx, lz) => !nearShore(x, z) || inCap(x + lx, z + lz);

  const chunks = [];
  let total = 0;
  for (let cz = 0; cz < map.h; cz += CHUNK) for (let cx = 0; cx < map.w; cx += CHUNK) {
    const roots = [];
    for (let z = cz; z < Math.min(map.h, cz + CHUNK); z++) for (let x = cx; x < Math.min(map.w, cx + CHUNK); x++) {
      if (!isLand(x, z)) continue;
      for (let gz = 0; gz < GRID_Z; gz++) for (let gx = 0; gx < GRID_X; gx++) {
        if (sparse && ((gx + gz + x * GRID_X + z * GRID_Z) & 1)) continue;   // staggered half (global checker)
        for (let tries = 0; tries < 3; tries++) {
          const lx = -0.5 + (gx + rng()) / GRID_X, lz = -0.5 + (gz + rng()) / GRID_Z;
          if (!inside(x, z, lx, lz)) continue;
          roots.push(x + lx, z + lz, rng() * Math.PI * 2, (0.8 + rng() * 0.45) * (sparse ? 1.08 : 1), rng());
          break;
        }
      }
    }
    const n = roots.length / 5;
    if (!n) continue;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(clumpGeo.pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(clumpGeo.nrm, 3));
    geo.setAttribute('aBlade', new THREE.BufferAttribute(clumpGeo.bl, 2));
    geo.setIndex(clumpGeo.idx);
    const aRoot = new Float32Array(n * 4), aSeed = new Float32Array(n);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const r = roots.slice(i * 5, i * 5 + 5);
      aRoot.set(r.slice(0, 4), i * 4);
      aSeed[i] = r[4];
      minX = Math.min(minX, r[0]); maxX = Math.max(maxX, r[0]); minZ = Math.min(minZ, r[1]); maxZ = Math.max(maxZ, r[1]);
    }
    geo.setAttribute('aRoot', new THREE.InstancedBufferAttribute(aRoot, 4));
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(aSeed, 1));
    geo.instanceCount = n;
    geo.boundingBox = new THREE.Box3(new THREE.Vector3(minX - 0.3, -0.05, minZ - 0.3), new THREE.Vector3(maxX + 0.3, 0.25, maxZ + 0.3));
    geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere());
    const mesh = new THREE.Mesh(geo, material);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.name = 'grassBlades';
    group.add(mesh);
    chunks.push(mesh);
    total += n;
  }

  // ---------- occupancy upkeep ----------
  const fillWant = () => {
    occWant.fill(0);
    for (let i = 0; i < extraCover.length; i++) if (extraCover[i] > 0) occWant[i * 2] = extraCover[i];
    const ents = sim?.entities;
    if (!ents?.values) return;
    for (const e of ents.values()) {
      if (!map.inBounds(e.x, e.z)) continue;
      const k = map.idx(e.x, e.z) * 2;
      if (e.resource) occWant[k + 1] = Math.max(occWant[k + 1], e.kind === 'stump' ? 0.6 : 1);
      else occWant[k] = Math.max(occWant[k], 1);
    }
  };
  const writeTex = () => {
    let dirty = false;
    for (let i = 0, n = map.w * map.h; i < n; i++) {
      const r = Math.round(occCur[i * 2] * 255), g = Math.round(occCur[i * 2 + 1] * 255);
      if (occData[i * 4] !== r || occData[i * 4 + 1] !== g) { occData[i * 4] = r; occData[i * 4 + 1] = g; dirty = true; }
    }
    if (dirty) occTex.needsUpdate = true;
  };
  // whatever already stands (scenarios) starts settled
  fillWant(); occCur.set(occWant); writeTex();

  return {
    group, material, chunks, occupancy: occTex, count: total, trianglesPerClump: BLADES * 3, density,
    // mark a tile as covered (0..1) by something that isn't a sim entity; blades shrink / part smoothly
    cover(x, z, amount = 1) { if (map.inBounds(x, z)) extraCover[map.idx(x, z)] = Math.max(0, Math.min(1, amount)); },
    update(dt) {
      fillWant();
      const k = 1 - Math.exp(-OCC_LAMBDA * dt);
      let moving = false;
      for (let i = 0; i < occCur.length; i++) {
        const d = occWant[i] - occCur[i];
        if (d === 0) continue;
        occCur[i] = Math.abs(d) < 0.003 ? occWant[i] : occCur[i] + d * k;
        moving = true;
      }
      if (moving) writeTex();
    },
  };
}
