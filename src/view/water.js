// Water: one big plane with a painterly shader. A shore-distance field is computed on the CPU from the
// rounded island outlines (exact Euclidean distance transform) and drives a deep -> mid -> shallow -> glow
// colour ramp, soft caustic lines in the shallows, a breathing foam/glow band hugging every shore and
// slow lapping ripples. Everything animates from the dt-driven time uniform.
//
// Bridges: the camp builds bridges at runtime (pads view draws the planks; map.bridge flips on). The shore
// field stays static, but the water under every bridge gets the deck's soft shadow (offset along the sun,
// growing out plank by plank as the bridge assembles) and little foam rings around the posts once they're
// up. Factory maps register their static bridges the same way at create.
import * as THREE from 'three';
import { traceLoops, ring } from './world/outline.js';
import { getNoiseTexture } from './world/noise-tex.js';

const RES = 8;            // shore-field texels per tile
const MARGIN = 12;        // tiles of field beyond the map on every side
const NEAR_MAX = 3;       // R channel: distance 0..3 tiles
const FAR_MAX = 14;       // G channel: distance 0..14 tiles
const WATERLINE_D = -0.06; // offset of the cliff wall where it meets the water (see terrain PROFILE)
const MAX_BRIDGES = 6;
const DECK_Y = -0.02;     // bridge deck height (pads/bridge.js, terrain BRIDGE_Y)
const SUN_DIR = [-0.5, 1.0, -0.36]; // lighting.js: from the scene toward the sun

export function create(ctx) {
  const { scene, map, config, events } = ctx;
  const P = config.PALETTE;

  const field = buildShoreField(map);
  const cover = buildCoverTexture(map);
  const noiseTex = getNoiseTexture();

  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uShore: { value: null }, uCover: { value: null }, uNoise: { value: null },
    uRect: { value: new THREE.Vector4() },
    uTime: { value: 0 },
    // ramp sampled from the reference frame (pre-grade): a narrow mint halo hugging the shore, green-teal
    // shallows that deepen quickly, a clean teal -> blue gradient into the deep
    uDeepFar: { value: new THREE.Color('#084660') },
    uDeep: { value: new THREE.Color('#0a5874') },
    uMid: { value: new THREE.Color('#167686') },
    uShallow: { value: new THREE.Color('#2a9483') },
    uNear: { value: new THREE.Color('#38a382') },
    uGlow: { value: new THREE.Color('#5dcc9e') },
    uLine: { value: new THREE.Color('#a4efc8') },
    uFoam: { value: new THREE.Color('#e2fbe9') },
    uCaustic: { value: new THREE.Color('#b4f4da') },
    uShadeOff: { value: new THREE.Vector2() },
  }]);
  uniforms.uShore.value = field.texture;
  uniforms.uCover.value = cover;
  uniforms.uNoise.value = noiseTex;
  uniforms.uRect.value.set(field.x0, field.z0, 1 / field.wWorld, 1 / field.hWorld);
  // bridges: A = (origin x, z, dir x, z), B = (tiles, deck extent 0..1, posts 0..1, -)
  uniforms.uBrA = { value: Array.from({ length: MAX_BRIDGES }, () => new THREE.Vector4()) };
  uniforms.uBrB = { value: Array.from({ length: MAX_BRIDGES }, () => new THREE.Vector4()) };
  {
    // the deck's shadow lands on the water this far along the sun's ground direction
    const h = DECK_Y - config.WATER_Y;
    uniforms.uShadeOff.value.set(-SUN_DIR[0] / SUN_DIR[1] * h, -SUN_DIR[2] / SUN_DIR[1] * h);
  }

  const material = new THREE.ShaderMaterial({
    name: 'IsleWater',
    uniforms,
    fog: true,
    vertexShader: /* glsl */`
      #include <common>
      #include <fog_pars_vertex>
      varying vec3 vW;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vW = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      #include <fog_pars_fragment>
      uniform sampler2D uShore;
      uniform sampler2D uCover;
      uniform sampler2D uNoise;
      uniform vec4 uRect;
      uniform float uTime;
      uniform vec3 uDeepFar, uDeep, uMid, uShallow, uNear, uGlow, uLine, uFoam, uCaustic;
      uniform vec2 uShadeOff;
      uniform vec4 uBrA[${MAX_BRIDGES}];
      uniform vec4 uBrB[${MAX_BRIDGES}];
      varying vec3 vW;

      // Bridges over this point: x = deck shadow 0..1, y = post foam ring 0..1.
      vec2 bridgeWater(vec2 p, float t) {
        vec2 r = vec2(0.0);
        for (int i = 0; i < ${MAX_BRIDGES}; i++) {
          vec4 A = uBrA[i], B = uBrB[i];
          if (B.y <= 0.001 && B.z <= 0.001) continue;
          vec2 dir = A.zw, across = vec2(abs(dir.y), abs(dir.x));
          // deck shadow: a soft box from the shore end out to how far the planks have got
          vec2 o = p - A.xy - uShadeOff;
          float u = dot(o, dir), v = dot(o, across);
          float uEnd = mix(-0.6, B.x - 0.4, B.y);
          float sd = max(max(-0.6 - u, u - uEnd), abs(v) - 0.44);
          // plus a soft contact shade hugging the deck on both sides, so it sits on the water
          vec2 o2 = p - A.xy;
          float u2 = dot(o2, dir), v2 = dot(o2, across);
          float sd2 = max(max(-0.6 - u2, u2 - uEnd), abs(v2) - 0.42);
          float sh = max(1.0 - smoothstep(-0.08, 0.24, sd), (1.0 - smoothstep(-0.05, 0.36, sd2)) * 0.6);
          r.x = max(r.x, sh * step(0.001, B.y));
          // posts stand at |v| = 0.47; u at -0.38, every tile seam, and len - 0.62
          float pin = clamp(floor(u2) + 0.5, 0.5, max(0.5, B.x - 1.5));
          float du = min(min(abs(u2 + 0.38), abs(u2 - (B.x - 0.62))), B.x > 1.5 ? abs(u2 - pin) : 9.0);
          float d = length(vec2(du, abs(abs(v2) - 0.47)));
          // a breathing ring of foam and a faint ripple pushing out from each post
          float ring = exp(-pow((d - 0.085 - 0.012 * sin(t * 2.3 + u2 * 3.0)) / 0.026, 2.0));
          float rip = exp(-pow((d - 0.13 - fract(t * 0.45 + u2 * 0.37) * 0.22) / 0.03, 2.0)) * (1.0 - fract(t * 0.45 + u2 * 0.37));
          r.y = max(r.y, (ring * 0.85 + rip * 0.3) * B.z);
        }
        return r;
      }

      vec2 hash22(vec2 p) {
        vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
        q += dot(q, q.yzx + 33.33);
        return fract((q.xx + q.yz) * q.zy);
      }
      // distance to the nearest voronoi cell border (approx.), cells drift on small loops
      float cellEdge(vec2 p, float t) {
        vec2 ip = floor(p), fp = fract(p);
        float d1 = 8.0, d2 = 8.0;
        for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
          vec2 g = vec2(float(i), float(j));
          vec2 h = hash22(ip + g);
          vec2 o = 0.5 + 0.36 * sin(t * (0.5 + h.yx * 0.6) + 6.2831 * h);
          vec2 r = g + o - fp;
          float d = dot(r, r);
          if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
        }
        return sqrt(d2) - sqrt(d1);
      }

      void main() {
        vec2 suv = (vW.xz - uRect.xy) * uRect.zw;
        vec4 sh = texture2D(uShore, suv);
        float dN = sh.r * ${NEAR_MAX.toFixed(1)};
        float dF = sh.g * ${FAR_MAX.toFixed(1)};
        float cov = texture2D(uCover, suv).r;
        float t = uTime;

        // slow painterly wobble so the bands are not perfectly parallel to the shore
        float n1 = texture2D(uNoise, vW.xz * 0.045 + vec2(t * 0.006, -t * 0.004)).r;
        float n2 = texture2D(uNoise, vW.xz * 0.11 + vec2(-t * 0.011, t * 0.008)).g;
        float wob = (n1 - 0.5) + (n2 - 0.5) * 0.5;
        float dW = max(0.0, dN + wob * 0.22 * smoothstep(0.0, 0.8, dN));

        // depth ramp: deep far -> deep -> mid -> shallow -> near -> glow. Depth is the smooth shore distance
        // (pulled shallower where a lot of land is around), with no blotchy noise in the open water.
        float depth = dF - cov * 0.9 + (n1 - 0.5) * 0.18;
        // (the reference reaches deep blue ~2.5 tiles out in open water; gaps between isles stay shallow)
        vec3 c = mix(uMid, uDeep, smoothstep(0.8, 2.7, depth));
        c = mix(c, uDeepFar, smoothstep(4.5, 10.0, depth));
        c = mix(c, uShallow, 1.0 - smoothstep(0.7, 1.8, dW));
        c = mix(c, uNear, 1.0 - smoothstep(0.2, 1.05, dW));
        // the mint glow halo hugging every island (~1.2 tiles), brightest right at the sand
        float breathe = 0.5 + 0.5 * sin(t * 0.85);
        float halo = exp(-dW / (0.4 + 0.05 * breathe)) * (1.0 - smoothstep(0.9, 1.5, dW));
        c = mix(c, uGlow, halo * 0.74);
        c = mix(c, uLine, (1.0 - smoothstep(0.03, 0.2 + 0.03 * breathe, dW)) * 0.75);

        // caustics in the shallows: a faint net of wobbly cell lines, strongest near the sand
        vec2 cp = vW.xz * 2.25 + vec2(n2 - 0.5, n1 - 0.5) * 1.1;
        float e = cellEdge(cp, t * 0.7);
        float lines = 1.0 - smoothstep(0.03, 0.15, e);
        float e2 = cellEdge(cp * 1.37 + 3.1, -t * 0.55);
        lines = max(lines * 0.85, (1.0 - smoothstep(0.03, 0.12, e2)) * 0.3);
        float cMask = (1.0 - smoothstep(0.35, 1.7, dW)) * smoothstep(0.05, 0.3, dN);
        c = mix(c, uCaustic, lines * cMask * 0.13);

        // bridges: the deck's soft shadow on the water, foam around the posts
        vec2 br = bridgeWater(vW.xz, t);
        c = mix(c, c * vec3(0.55, 0.7, 0.78), br.x * 0.75);
        c = mix(c, uFoam, br.y * 0.7);

        // foam hugging the shore, breathing, plus faint lapping ripples moving outward
        float fw = 0.12 + 0.04 * sin(t * 1.25 + wob * 7.0);
        float foam = 1.0 - smoothstep(fw * 0.25, fw, dN);
        float lapT = fract(t * 0.16 + n1 * 0.6);
        float lapPos = 0.05 + lapT * 0.5;
        float lap = exp(-pow((dW - lapPos) / 0.035, 2.0)) * (1.0 - lapT) * (1.0 - lapT);
        c = mix(c, uFoam, clamp(foam * 0.8 + lap * 0.22, 0.0, 1.0));

        // shimmer and broad tonal variation
        float sh1 = texture2D(uNoise, vW.xz * 0.37 + vec2(t * 0.03, t * 0.017)).b;
        float sh2 = texture2D(uNoise, vW.xz * 0.29 - vec2(t * 0.021, -t * 0.027)).b;
        float shimmer = (sh1 + sh2 - 1.0);
        c *= 1.0 + shimmer * 0.05 + (n1 - 0.5) * 0.03;
        float glint = smoothstep(0.38, 0.5, sh1 * sh2) * (1.0 - smoothstep(0.5, 3.0, dN));
        c += uFoam * glint * 0.05;

        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });

  const size = 420;
  const geo = new THREE.PlaneGeometry(size, size, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(map.w / 2 - 0.5, config.WATER_Y, map.h / 2 - 0.5);
  mesh.name = 'water';
  mesh.frustumCulled = false;
  scene.add(mesh);

  // ---- bridges (runtime in camp mode, static in factory maps) ----
  const bridges = new Map(); // id -> { slot, len, extent, want, posts, wantPosts }
  const addBridge = (id, tiles, orientation, { built = false } = {}) => {
    if (!tiles?.length || bridges.has(id) || bridges.size >= MAX_BRIDGES) return bridges.get(id);
    const [x0, z0] = tiles[0];
    let dx = orientation === 1 ? 1 : 0, dz = orientation === 1 ? 0 : 1;
    if (tiles.length > 1) { dx = Math.sign(tiles[1][0] - x0); dz = Math.sign(tiles[1][1] - z0); }
    const slot = bridges.size;
    const b = { slot, len: tiles.length, extent: built ? 1 : 0, want: built ? 1 : 0, posts: built ? 1 : 0, wantPosts: built ? 1 : 0 };
    bridges.set(id, b);
    uniforms.uBrA.value[slot].set(x0, z0, dx, dz);
    uniforms.uBrB.value[slot].set(b.len, b.extent, b.posts, 0);
    return b;
  };
  const camp = ctx.camp;
  if (camp && map.bridges) {
    for (const id of camp.bridges || []) { const d = map.bridges[id]; if (d) addBridge(id, d.tiles, d.orientation, { built: true }); }
  } else {
    // factory map: plank runs straight from map.bridge
    const seen = new Uint8Array(map.w * map.h);
    for (let z = 0; z < map.h; z++) for (let x = 0; x < map.w; x++) {
      const o = map.bridge?.[map.idx(x, z)];
      if (!o || seen[map.idx(x, z)]) continue;
      const [ddx, ddz] = o === 1 ? [1, 0] : [0, 1];
      const tiles = [];
      while (map.inBounds(x + ddx * tiles.length, z + ddz * tiles.length) && map.bridge[map.idx(x + ddx * tiles.length, z + ddz * tiles.length)] === o) {
        seen[map.idx(x + ddx * tiles.length, z + ddz * tiles.length)] = 1;
        tiles.push([x + ddx * tiles.length, z + ddz * tiles.length]);
      }
      addBridge(`run${x},${z}`, tiles, o, { built: true });
    }
  }
  const offs = [];
  if (camp && events?.on) {
    const def = br => br && (map.bridges?.[br.id] || br);
    offs.push(events.on('bridge:start', ({ bridge }) => { const d = def(bridge); addBridge(bridge.id, d?.tiles, d?.orientation); }));
    offs.push(events.on('bridge:plank', ({ bridge, index }) => {
      const d = def(bridge), b = addBridge(bridge.id, d?.tiles, d?.orientation);
      if (b) b.want = Math.max(b.want, (index + 1) / b.len);
    }));
    offs.push(events.on('bridge:built', ({ bridge }) => {
      const d = def(bridge), b = addBridge(bridge.id, d?.tiles, d?.orientation);
      if (b) { b.want = 1; b.wantPosts = 1; }
    }));
  }

  let time = 0;
  return {
    mesh, material, shore: field,
    bridges,
    // distance (tiles) from the shoreline at a world point, for other modules (e.g. splashes)
    shoreDistance(x, z) {
      const i = Math.floor((x - field.x0) * RES), j = Math.floor((z - field.z0) * RES);
      if (i < 0 || j < 0 || i >= field.tw || j >= field.th) return FAR_MAX;
      return field.dist[j * field.tw + i];
    },
    update(dt) {
      time += dt;
      uniforms.uTime.value = time;
      for (const b of bridges.values()) {
        if (b.extent === b.want && b.posts === b.wantPosts) continue;
        const k = 1 - Math.exp(-7 * dt), kp = 1 - Math.exp(-3.2 * dt);
        b.extent = Math.abs(b.want - b.extent) < 0.002 ? b.want : b.extent + (b.want - b.extent) * k;
        b.posts = Math.abs(b.wantPosts - b.posts) < 0.002 ? b.wantPosts : b.posts + (b.wantPosts - b.posts) * kp;
        uniforms.uBrB.value[b.slot].set(b.len, b.extent, b.posts, 0);
      }
    },
    dispose() { offs.forEach(f => f?.()); },
  };
}

// ---------------------------------------------------------------------
function buildShoreField(map) {
  const tw = (map.w + MARGIN * 2) * RES, th = (map.h + MARGIN * 2) * RES;
  const x0 = -0.5 - MARGIN, z0 = -0.5 - MARGIN;
  const mask = new Uint8Array(tw * th);

  // scanline-fill the rounded waterline polygons (even-odd over all loops handles holes)
  const edges = [];
  for (const loop of traceLoops(map)) {
    const r = ring(loop, WATERLINE_D);
    for (let i = 0; i < r.count; i++) {
      const j = (i + 1) % r.count;
      edges.push(r.pts[i * 2], r.pts[i * 2 + 1], r.pts[j * 2], r.pts[j * 2 + 1]);
    }
  }
  const xs = [];
  for (let j = 0; j < th; j++) {
    const zc = z0 + (j + 0.5) / RES;
    xs.length = 0;
    for (let e = 0; e < edges.length; e += 4) {
      const ax = edges[e], az = edges[e + 1], bx = edges[e + 2], bz = edges[e + 3];
      if ((az > zc) !== (bz > zc)) xs.push(ax + ((zc - az) * (bx - ax)) / (bz - az));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - x0) * RES - 0.5));
      const i1 = Math.min(tw - 1, Math.floor((xs[k + 1] - x0) * RES - 0.5));
      for (let i = i0; i <= i1; i++) mask[j * tw + i] = 1;
    }
  }

  // exact squared EDT (Felzenszwalb & Huttenlocher), columns then rows
  const INF = 1e20;
  const n = Math.max(tw, th);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const grid = new Float64Array(tw * th);
  for (let i = 0; i < tw * th; i++) grid[i] = mask[i] ? 0 : INF;
  const edt1 = len => {
    let k = 0;
    v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let qq = 1; qq < len; qq++) {
      let s = ((f[qq] + qq * qq) - (f[v[k]] + v[k] * v[k])) / (2 * qq - 2 * v[k]);
      while (s <= z[k]) { k--; s = ((f[qq] + qq * qq) - (f[v[k]] + v[k] * v[k])) / (2 * qq - 2 * v[k]); }
      k++; v[k] = qq; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let qq = 0; qq < len; qq++) {
      while (z[k + 1] < qq) k++;
      d[qq] = (qq - v[k]) * (qq - v[k]) + f[v[k]];
    }
  };
  for (let i = 0; i < tw; i++) {
    for (let j = 0; j < th; j++) f[j] = grid[j * tw + i];
    edt1(th);
    for (let j = 0; j < th; j++) grid[j * tw + i] = d[j];
  }
  for (let j = 0; j < th; j++) {
    for (let i = 0; i < tw; i++) f[i] = grid[j * tw + i];
    edt1(tw);
    for (let i = 0; i < tw; i++) grid[j * tw + i] = d[i];
  }

  const dist = new Float32Array(tw * th);
  const data = new Uint8Array(tw * th * 4);
  for (let i = 0; i < tw * th; i++) {
    const dt = Math.sqrt(grid[i]) / RES; // tiles
    dist[i] = dt;
    data[i * 4] = Math.min(255, Math.round((dt / NEAR_MAX) * 255));
    data[i * 4 + 1] = Math.min(255, Math.round((dt / FAR_MAX) * 255));
    data[i * 4 + 2] = mask[i] * 255;
    data[i * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, tw, th, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return { texture, dist, tw, th, x0, z0, wWorld: tw / RES, hWorld: th / RES };
}

// Local land coverage (Gaussian-ish blur of the land mask, ~2 tiles), 1 texel per tile over the field rect.
function buildCoverTexture(map) {
  const W = map.w + MARGIN * 2, H = map.h + MARGIN * 2;
  let a = new Float32Array(W * H), b = new Float32Array(W * H);
  for (let z = 0; z < map.h; z++) for (let x = 0; x < map.w; x++) if (map.isLand(x, z)) a[(z + MARGIN) * W + x + MARGIN] = 1;
  const R = 2;
  for (let pass = 0; pass < 3; pass++) {
    for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
      let s = 0, c = 0;
      for (let k = -R; k <= R; k++) { const xx = x + k; if (xx >= 0 && xx < W) { s += a[z * W + xx]; c++; } }
      b[z * W + x] = s / c;
    }
    for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
      let s = 0, c = 0;
      for (let k = -R; k <= R; k++) { const zz = z + k; if (zz >= 0 && zz < H) { s += b[zz * W + x]; c++; } }
      a[z * W + x] = s / c;
    }
  }
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { data[i * 4] = Math.round(Math.min(1, a[i] * 1.6) * 255); data[i * 4 + 3] = 255; }
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}
