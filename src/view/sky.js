// Sky: background, gentle aerial fog and the CLOUD FRAME.
//
// Clouds are three large horizontal layers that share one drifting 2D density field:
//   veil  (low)  - a soft, bright haze that the world fades into before the clouds proper
//   body  (mid)  - the main cloud mass, shaded from the density gradient (puffy, lit from the sun side,
//                  mint in the creases)
//   tops  (high) - billows on the thickest parts, slightly offset, so the mass reads as volume (parallax)
// A world-space elliptical hole around the camera target keeps the working area clear. The hole is
// centred on the camera ray through the target (at mid cloud height) and sized from the camera frustum's
// footprint at that height, so it frames the view at any pitch, zoom and aspect: in landscape the clouds
// close in from the sides and the top; in a tall portrait view (phones) the sides stay open and the
// clouds frame the top, with only a light fringe at the bottom where the HUD sits. Its rim wanders in big
// noise lobes, and the inner part is guaranteed clear.
//
// Camp mode: the hole grows with the camp level (world/mood.js eases a continuous level with a slight
// overshoot on hearth:level). Each level caps the hole's radius in world units (level 0: a small circle
// around the cold camp) and scales the view framing (level 5: wide open over every island). Islands whose
// bridge isn't built yet sit under a thin, drifting veil of cloud that clears from the bridge's landing once
// it is built (bridge:built). Factory mode: no caps, no veils (as before).
//
// Phones (ctx.quality.tier 'mobile'): the three layers are shaded in ONE merged pass (each layer sampled where
// the fragment's camera ray crosses its height, composited bottom to top exactly like three blended passes),
// and post.js has that pass shade a half-res buffer (beginHalfRes / endHalfRes) that a cheap composite plane
// upsamples inside the scene pass. Everywhere: the always-clear inner hole exits before any noise fetch.
// ?clouds=layers | full forces the desktop layers / the full-res merged pass for A/B checks.
import * as THREE from 'three';
import { getNoiseTexture } from './world/noise-tex.js';
import { getMood } from './world/mood.js';

// Hole radii as a share of the view's half-extent at mid cloud height: [sides, top (far), bottom (near)].
// Clouds start at ~0.8 of the radius (plus rim noise), so 1.0 means they begin 20% in from that edge.
const HOLE_WIDE = [1.0, 1.0, 1.3];     // landscape (16:9 and wider)
const HOLE_TALL = [1.42, 0.9, 1.16];    // portrait (aspect <= 0.6): open sides, light fringe over the HUD
// Per camp level 0..5: the most the hole may open (world units at cloud height, all three radii) and a
// scale on the view framing above. Interpolated over the eased, continuous level (and extrapolated a little
// past either end for the overshoot).
const LEVEL_CAP = [5.4, 6.8, 9.5, 13, 17, 34];
const LEVEL_MUL = [0.9, 0.95, 1.0, 1.04, 1.08, 1.12];
// From level 2 the whole home island stays clear wherever the camera is (the camp is never under cloud);
// level 1 pulls the clouds back from it a little.
const HOME_CLEAR = [0, 0.55, 1, 1, 1, 1];
const LOCK_RES = 2;                // locked-island mask texels per tile
const LOCK_MARGIN = 4;             // tiles of mask beyond the map
const LOCK_FEATHER = [0.15, 1.5];  // the veil fades out from this far outside the island's land (tiles)
const NOISE_SCALE = 0.042;         // density field frequency (texture repeats every ~24 units)
const LAYERS = [
  // height, kind (0 veil, 1 body, 2 tops)
  { h: 2.4, kind: 0 },
  { h: 3.3, kind: 1 },
  { h: 4.3, kind: 2 },
];
const H_MID = 3.3;

export function create(ctx) {
  const { scene, config, camera, sim, map } = ctx;
  const P = config.PALETTE;
  // phones: the three cloud layers are drawn in one merged pass (see mergedShader)
  const MOBILE = ctx.quality?.tier === 'mobile' && ctx.params?.get?.('clouds') !== 'layers'; // ?clouds=layers: A/B test

  scene.background = new THREE.Color(P.sky);
  scene.fog = new THREE.Fog(new THREE.Color(P.sky).lerp(new THREE.Color(P.cloud), 0.3), 26, 95);

  const noiseTex = getNoiseTexture();
  const mood = getMood(ctx);
  const lock = buildLockMask(map, mood.locks);
  const sun3 = new THREE.Vector3(-0.5, 1.0, -0.36).normalize(); // same direction as lighting.js
  const shared = {
    // thin cloud over islands that aren't reachable yet (camp mode); RGBA = up to four islands
    uLockMask: { value: lock.texture },
    uLockRect: { value: new THREE.Vector4(lock.x0, lock.z0, 1 / lock.wWorld, 1 / lock.hWorld) },
    uLockAmt: { value: new THREE.Vector4() },
    uLockFront: { value: new THREE.Vector4(-1, -1, -1, -1) },
    uLandA: { value: new THREE.Vector4() },
    uLandB: { value: new THREE.Vector4() },
    uHome: { value: new THREE.Vector4(map.start.x, map.start.z, 6, 5) },   // centre xz, half extents
    uHomeAmt: { value: 0 },
    uNoise: { value: noiseTex },
    uDrift: { value: new THREE.Vector2(0.137, 0.611) },
    uCenter: { value: new THREE.Vector2(map.start.x, map.start.z) },
    uRadii: { value: new THREE.Vector3(8.2, 6.2, 5.8) },   // x, z toward the top (far), z toward the bottom (near)
    uSun: { value: sun3 },
    // sampled from the reference clouds: near-white with a faint cyan, mint only in the soft creases
    uWhite: { value: new THREE.Color('#efffff') },
    uMint: { value: new THREE.Color('#d2fbf7') },
    uCrease: { value: new THREE.Color('#a6e7dc') },
  };

  const vertexShader = /* glsl */`
    varying vec3 vW;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vW = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`;
  const cloudCommon = /* glsl */`
    #include <common>
    uniform sampler2D uNoise;
    uniform vec2 uDrift, uCenter;
    uniform vec3 uRadii;
    uniform vec3 uSun, uWhite, uMint, uCrease;
    uniform sampler2D uLockMask;
    uniform vec4 uLockRect, uLockAmt, uLockFront, uLandA, uLandB, uHome;
    uniform float uHomeAmt;
    varying vec3 vW;

    // the ground point the camera sees through this cloud point
    vec2 groundPt() {
      vec3 C = cameraPosition;
      return C.xz + (vW.xz - C.xz) * (C.y / max(C.y - vW.y, 0.1));
    }
    // camp: keep the home island clear (a soft rounded rectangle, its edge wobbling with the billows)
    float homeClear(vec2 g, float n) {
      if (uHomeAmt < 0.001) return 0.0;
      vec2 q = abs(g - uHome.xy) / uHome.zw;
      float e = pow(pow(q.x, 4.0) + pow(q.y, 4.0), 0.25) + (n - 0.5) * 0.3;
      return uHomeAmt * (1.0 - smoothstep(0.93, 1.12, e));
    }

    // Thin veil over locked islands. The mask is looked up where the camera ray through this cloud point
    // meets the ground, so every layer's veil sits right over the island on screen. A clearing front grows
    // from the bridge landing once the bridge is built.
    float lockVeil(vec2 g) {
      if (dot(uLockAmt, vec4(1.0)) < 0.001) return 0.0;
      vec4 m = texture2D(uLockMask, (g - uLockRect.xy) * uLockRect.zw);
      vec4 d = vec4(length(g - uLandA.xy), length(g - uLandA.zw), length(g - uLandB.xy), length(g - uLandB.zw));
      vec4 keep = mix(vec4(1.0), smoothstep(uLockFront - 2.2, uLockFront + 0.4, d), step(0.0, uLockFront));
      vec4 k = m * uLockAmt * keep;
      return max(max(k.x, k.y), max(k.z, k.w));
    }

    // Billow noise at a world point. fine = 1 adds the small billows (soft lobed edges); fine = 0 is the
    // coarse field the shading normal comes from. off = the layer's noise offset. (No out-parameters: some
    // GLSL compilers are picky.)
    float cloudNoise(vec2 p, float fine, vec2 off) {
      vec2 q = p * ${NOISE_SCALE.toFixed(4)} + uDrift + off;
      return texture2D(uNoise, q).r * 0.62
           + texture2D(uNoise, q * 2.17 + vec2(0.31, 0.17) + uDrift * 0.7).g * 0.3
           + (texture2D(uNoise, q * 3.6 + vec2(0.71, 0.43) - uDrift * 1.3).b - 0.5) * 0.09 * fine + 0.04;
    }
    // Cloud density: the billow noise n inside the frame, nothing in the hole around the camera target.
    float cloudDensity(vec2 p, float n, vec2 off) {
      vec2 q = p * ${NOISE_SCALE.toFixed(4)} + uDrift + off;
      float nL = texture2D(uNoise, q * 0.5 + vec2(0.13, 0.71) + uDrift * 0.4).a;
      vec2 dc = p - uCenter;
      float e0 = length(dc / vec2(uRadii.x, dc.y < 0.0 ? uRadii.y : uRadii.z));
      // the rim wanders in and out in big lobes
      float e = e0 + (nL - 0.5) * 0.6 + (n - 0.5) * 0.3;
      float den = mix(-0.6, n * 1.45 - 0.05, smoothstep(0.82, 1.16, e)) + smoothstep(1.12, 1.8, e) * 0.35;
      // hard guarantee: the inner part of the hole is always clear
      return mix(-0.6, den, smoothstep(0.56, 0.7, e0));
    }

    // One cloud layer at world point p (kind 0 veil, 1 body, 2 tops; gp = the ground point on this camera
    // ray, lk = lockVeil(gp)). Returns premultiplied (rgb, cover), or w = -1 where the layer is empty.
    vec4 cloudLayer(vec2 p, float kind, vec2 off, vec2 gp, float lk) {
      // the inner part of the hole is always clear (cloudDensity's guarantee), so most of the screen leaves
      // here without a single noise fetch, unless a locked island's veil shows through it
      {
        vec2 dc = p - uCenter;
        float e0 = length(dc / vec2(uRadii.x, dc.y < 0.0 ? uRadii.y : uRadii.z));
        if (e0 < 0.56 && lk <= 0.001) return vec4(0.0, 0.0, 0.0, -1.0);
      }
      float n = cloudNoise(p, 1.0, off);
      float den = cloudDensity(p, n, off);
      den = mix(den, -0.6, homeClear(gp, n));
      // locked island: a thin drifting veil, thicker in the billows and see-through between them
      float lockA = 0.0;
      if (lk > 0.001) {
        lockA = kind < 0.5 ? lk * 0.24
              : kind < 1.5 ? lk * smoothstep(0.4, 0.86, n) * 0.5
              : lk * smoothstep(0.66, 0.94, n) * 0.36;
      }
      float a;
      vec3 c;
      if (kind < 0.5) {
        // veil: a soft, bright haze just ahead of the cloud body
        a = max(smoothstep(0.1, 0.48, den) * 0.34, lockA);
        c = uMint;
      } else {
        float body = step(kind, 1.5);     // 1 body, 0 tops
        float lo = mix(0.58, 0.26, body);
        // a fairly quick ramp: billowy lobes that turn opaque soon, rather than a wide grey see-through band
        a = max(smoothstep(lo, lo + 0.33, den), lockA);
        if (a <= 0.003) return vec4(0.0, 0.0, 0.0, -1.0);
        // normal from the billows alone (not the frame's ramp, which would draw contour lines along the
        // rim) -> soft puffy shading, lit from the sun side
        float eps = 1.4;
        float n0 = cloudNoise(p, 0.0, off);
        float dx = cloudNoise(p + vec2(eps, 0.0), 0.0, off) - n0;
        float dz = cloudNoise(p + vec2(0.0, eps), 0.0, off) - n0;
        vec3 N = normalize(vec3(-dx * 6.0, eps, -dz * 6.0));
        float lit = smoothstep(0.05, 0.92, dot(N, uSun));
        c = mix(uCrease, uWhite, lit);
        // thick cores and the high billows are whiter, creases in the body a touch mint
        c = mix(c, uWhite, smoothstep(0.1, 0.7, den - lo) * 0.4);
        c = mix(c, uMint, 0.1 * body * (1.0 - lit));
        // thin edges lean mint-cyan: over dark ground they read as sunlit mist rather than grey smoke
        c = mix(uMint, c, smoothstep(0.1, 0.7, a));
      }
      if (a <= 0.003) return vec4(0.0, 0.0, 0.0, -1.0);
      // premultiplied, and thin cloud covers a little less than it adds: a veil over dark trees reads as
      // bright sunlit haze instead of grey smoke
      float cover = a * mix(0.55, 1.0, smoothstep(0.35, 0.9, a));
      return vec4(c * a + uWhite * a * (1.0 - a) * 0.6, cover);
    }
`;
  // one layer per mesh (desktop)
  const fragmentShader = cloudCommon + /* glsl */`
    uniform float uKind;       // 0 veil, 1 body, 2 tops
    uniform vec2 uOffset;      // per-layer noise offset (tops boil a little differently)
    void main() {
      vec2 gp = groundPt();
      vec4 r = cloudLayer(vW.xz, uKind, uOffset, gp, lockVeil(gp));
      if (r.w < 0.0) discard;
      gl_FragColor = r;
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;
  // phones: all three layers in ONE pass on a plane at the top layer's height. Each layer is sampled where
  // this fragment's camera ray crosses its height (the same points the three planes would shade) and the
  // three are composited bottom to top, exactly as the blending of three passes would. One draw, one blend,
  // the ground point and lock veil looked up once.
  const LAYER_GLSL = LAYERS.map((L, i) => `
      {
        vec2 p = C.xz + (vW.xz - C.xz) * ((C.y - ${L.h.toFixed(2)}) / max(C.y - vW.y, 0.1));
        vec4 r = cloudLayer(p, ${L.kind.toFixed(1)}, vec2(${L.kind === 2 ? '0.013, -0.009' : '0.0, 0.0'}), gp, lk);
        if (r.w >= 0.0) { col = r.rgb + col * (1.0 - r.w); trans *= 1.0 - r.w; }
      }`).join('');
  const mergedShader = cloudCommon + /* glsl */`
    void main() {
      vec3 C = cameraPosition;
      vec2 gp = groundPt();
      float lk = lockVeil(gp);
      vec3 col = vec3(0.0);
      float trans = 1.0;
      ${LAYER_GLSL}
      if (trans >= 1.0) discard;
      gl_FragColor = vec4(col, 1.0 - trans);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;

  const geo = new THREE.PlaneGeometry(320, 320, 1, 1);
  geo.rotateX(-Math.PI / 2);
  // Phones, step 2: post.js asks beginHalfRes() each frame to shade the merged clouds into a HALF-RES buffer
  // (a private scene, no depth test: the plane sits above everything), and for the main pass the procedural
  // mesh is swapped for a cheap full-screen composite that upsamples that buffer (bilinear, premultiplied).
  // The clouds are soft everywhere, so this reads the same at a quarter of the shading cost. Without post
  // (fallback rendering), the full-res merged mesh simply draws itself.
  let half = null;
  const mergedMat = MOBILE ? new THREE.ShaderMaterial({
    name: 'IsleCloudsMerged',
    uniforms: { ...shared },
    vertexShader, fragmentShader: mergedShader,
    transparent: true, premultipliedAlpha: true, depthWrite: false, depthTest: true, fog: false,
  }) : null;
  const mergedMesh = () => {
    const mesh = new THREE.Mesh(geo, mergedMat);
    mesh.position.set(map.w / 2, LAYERS[LAYERS.length - 1].h, map.h / 2);
    mesh.renderOrder = 50;
    mesh.frustumCulled = false;
    mesh.name = 'cloudLayers';
    return mesh;
  };
  const merged = () => {
    const mesh = mergedMesh();
    scene.add(mesh);
    if (ctx.params?.get?.('clouds') !== 'full') half = createHalfRes(mesh);
    return [mesh];
  };
  function createHalfRes(mainMesh) {
    const ext = ctx.renderer.extensions;
    const hf = ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
    const rt = new THREE.WebGLRenderTarget(1, 1, {
      type: hf ? THREE.HalfFloatType : THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    });
    const own = new THREE.Scene();
    const gen = mergedMesh();
    gen.material = mergedMat.clone();
    gen.material.uniforms = mergedMat.uniforms;   // same uniform objects (hole, drift, locks)
    gen.material.depthTest = false;
    own.add(gen);
    const comp = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      name: 'IsleCloudsComposite',
      uniforms: { tClouds: { value: rt.texture }, uInvSize: { value: new THREE.Vector2(1, 1) } },
      vertexShader: /* glsl */`void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform sampler2D tClouds;
        uniform vec2 uInvSize;
        void main() {
          vec4 c = texture2D(tClouds, gl_FragCoord.xy * uInvSize);
          if (c.a < 0.002) discard;
          gl_FragColor = c;
        }`,
      transparent: true, premultipliedAlpha: true, depthWrite: false, depthTest: true, fog: false,
    }));
    comp.position.copy(mainMesh.position);
    comp.renderOrder = 50;
    comp.frustumCulled = false;
    comp.visible = false;
    comp.name = 'cloudComposite';
    scene.add(comp);
    const size = new THREE.Vector2(), clear = new THREE.Color();
    let active = false;
    return {
      rt, gen, comp,
      begin(renderer) {
        if (!mainMesh.visible) return false;   // hidden from outside (a test / profiler): leave it alone
        renderer.getDrawingBufferSize(size);
        const w = Math.max(1, Math.floor(size.x / 2)), h = Math.max(1, Math.floor(size.y / 2));
        if (rt.width !== w || rt.height !== h) rt.setSize(w, h);
        comp.material.uniforms.uInvSize.value.set(1 / size.x, 1 / size.y);
        const prevRT = renderer.getRenderTarget(), prevA = renderer.getClearAlpha();
        renderer.getClearColor(clear);
        renderer.setClearColor(0x000000, 0);
        renderer.setRenderTarget(rt);
        renderer.render(own, camera);
        renderer.setRenderTarget(prevRT);
        renderer.setClearColor(clear, prevA);
        mainMesh.visible = false; comp.visible = true; active = true;
        return true;
      },
      end() {
        if (!active) return;
        active = false;
        mainMesh.visible = true; comp.visible = false;
      },
    };
  }
  const layers = MOBILE ? merged() : LAYERS.map((L, i) => {
    const mat = new THREE.ShaderMaterial({
      name: `IsleCloud${i}`,
      uniforms: {
        ...shared,
        uKind: { value: L.kind },
        uOffset: { value: new THREE.Vector2(L.kind === 2 ? 0.013 : 0, L.kind === 2 ? -0.009 : 0) },
      },
      vertexShader, fragmentShader,
      transparent: true, premultipliedAlpha: true, depthWrite: false, depthTest: true, fog: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(map.w / 2, L.h, map.h / 2);
    mesh.renderOrder = 50 + i;
    mesh.frustumCulled = false;
    mesh.name = `cloudLayer${i}`;
    scene.add(mesh);
    return mesh;
  });

  // Keep the hole on the camera ray through the target. Also run right before the bottom layer renders
  // (after every module's update), so it never lags the camera by a frame.
  const camPos = new THREE.Vector3(), ray = new THREE.Vector3(), fogV = new THREE.Vector3();
  // where the ray through NDC (nx, ny) meets the plane y = H_MID (null if it doesn't, e.g. very low camera)
  const hit = (nx, ny) => {
    ray.set(nx, ny, 0.5).unproject(camera).sub(camPos);
    if (ray.y > -1e-4) return null;
    const t = (H_MID - camPos.y) / ray.y;
    return t > 0 ? [camPos.x + ray.x * t, camPos.z + ray.z * t] : null;
  };
  const placeHole = () => {
    const tgt = ctx.views.camera?.target || (sim?.player ? { x: sim.player.x, z: sim.player.z } : map.start);
    camera.updateMatrixWorld();
    camera.getWorldPosition(camPos);
    const tx = Number.isFinite(tgt.x) ? tgt.x : map.start.x, tz = Number.isFinite(tgt.z) ? tgt.z : map.start.z;
    const k = camPos.y > H_MID + 0.5 ? H_MID / camPos.y : 0;
    const cx = tx + (camPos.x - tx) * k, cz = tz + (camPos.z - tz) * k;
    shared.uCenter.value.set(cx, cz);
    // the view's half-extents at cloud height, then the aspect-dependent framing
    const r = hit(1, 0), top = hit(0, 1), bot = hit(0, -1);
    if (!r || !top || !bot) { shared.uRadii.value.set(12, 9, 9); return; }
    const hx = Math.max(1, Math.hypot(r[0] - cx, r[1] - cz));
    const ht = Math.max(1, cz - top[1]), hb = Math.max(1, bot[1] - cz);
    const p = THREE.MathUtils.smoothstep(camera.aspect || 1.6, 0.6, 1.2);   // 1 landscape .. 0 portrait
    const f = i => HOLE_TALL[i] + (HOLE_WIDE[i] - HOLE_TALL[i]) * p;
    // camp level: scale the framing and cap the radius in world units (factory mode: fully open)
    const lv = mood.campMode ? mood.open : LEVEL_CAP.length - 1;
    const mul = levelCurve(LEVEL_MUL, lv), cap = levelCurve(LEVEL_CAP, lv);
    const R = v => Math.min(v * mul, cap);
    shared.uRadii.value.set(R(hx * f(0)), R(ht * f(1)), R(hb * f(2)));
    shared.uHomeAmt.value = mood.campMode && home ? Math.max(0, Math.min(1, levelCurve(HOME_CLEAR, lv))) : 0;
  };
  layers[0].onBeforeRender = placeHole;
  if (half) half.gen.onBeforeRender = placeHole;

  // the home island's bounds (camp maps)
  const home = (() => {
    if (!map.islandAt) return null;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let z = 0; z < map.h; z++) for (let x = 0; x < map.w; x++) {
      if (!map.isLand(x, z) || map.islandAt(x, z) !== 'home') continue;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    if (!Number.isFinite(x0)) return null;
    shared.uHome.value.set((x0 + x1) / 2, (z0 + z1) / 2, (x1 - x0) / 2 + 0.55, (z1 - z0) / 2 + 0.55);
    return { x0, x1, z0, z1 };
  })();

  const syncLocks = () => {
    const L = mood.locks;
    const amt = shared.uLockAmt.value, fr = shared.uLockFront.value;
    const get = (i, k, d) => (L[i] ? L[i][k] : d);
    amt.set(get(0, 'amount', 0), get(1, 'amount', 0), get(2, 'amount', 0), get(3, 'amount', 0));
    fr.set(get(0, 'front', -1), get(1, 'front', -1), get(2, 'front', -1), get(3, 'front', -1));
  };
  mood.locks.forEach((L, i) => {
    const v = i < 2 ? shared.uLandA.value : shared.uLandB.value, o = (i % 2) * 2;
    v.setComponent(o, L.landing.x); v.setComponent(o + 1, L.landing.z);
  });
  syncLocks();

  let time = 0;
  return {
    layers,
    mood,
    // the current hole radii (world units at cloud height): sides, top (far), bottom (near)
    get holeRadii() { return shared.uRadii.value.toArray(); },
    // Phones: post.js calls beginHalfRes(renderer) right before the main scene render (true = the clouds were
    // shaded at half res and the composite mesh stands in for them) and endHalfRes() right after.
    beginHalfRes: renderer => (half ? half.begin(renderer) : false),
    endHalfRes: () => half?.end(),
    // 'layers' (desktop: three passes) | 'merged' (phones without post) | 'half' (phones: half-res + composite)
    get cloudMode() { return !MOBILE ? 'layers' : half ? 'half' : 'merged'; },
    update(dt) {
      time += dt;
      shared.uDrift.value.set(0.137 + time * 0.0042, 0.611 + time * 0.0017);
      syncLocks();
      placeHole();
      // aerial haze scales with the camera distance, so zooming out (or the taller phone framing)
      // doesn't wash the whole working area out
      const tgt = ctx.views.camera?.target;
      const d = tgt && Number.isFinite(tgt.x) ? camPos.distanceTo(fogV.set(tgt.x, 0, tgt.z)) : 20;
      scene.fog.near = d * 1.3;
      scene.fog.far = d * 4.75;
    },
  };
}

// Piecewise-linear lookup of a per-level table at a continuous level, extrapolated past either end (so the
// hole's overshoot carries through when it eases past the target level).
function levelCurve(table, lv) {
  const n = table.length - 1;
  const i = Math.max(0, Math.min(n - 1, Math.floor(lv)));
  return table[i] + (table[i + 1] - table[i]) * (lv - i);
}

// RGBA mask (up to four locked islands, one per channel): 1 on the island's land, feathering out over the
// water around it. LOCK_RES texels per tile over the map plus a margin.
function buildLockMask(map, locks) {
  const x0 = -0.5 - LOCK_MARGIN, z0 = -0.5 - LOCK_MARGIN;
  const tw = (map.w + LOCK_MARGIN * 2) * LOCK_RES, th = (map.h + LOCK_MARGIN * 2) * LOCK_RES;
  const data = new Uint8Array(tw * th * 4);
  const [f0, f1] = LOCK_FEATHER;
  const sstep = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
  locks.forEach((L, ch) => {
    const tiles = [];
    for (let z = 0; z < map.h; z++) for (let x = 0; x < map.w; x++) if (map.isLand(x, z) && map.islandAt(x, z) === L.island) tiles.push(x, z);
    if (!tiles.length) return;
    for (let j = 0; j < th; j++) {
      const wz = z0 + (j + 0.5) / LOCK_RES;
      for (let i = 0; i < tw; i++) {
        const wx = x0 + (i + 0.5) / LOCK_RES;
        // distance from the nearest land tile's square (0 inside it)
        let best = Infinity;
        for (let k = 0; k < tiles.length; k += 2) {
          const dx = Math.max(0, Math.abs(wx - tiles[k]) - 0.5), dz = Math.max(0, Math.abs(wz - tiles[k + 1]) - 0.5);
          const d = dx * dx + dz * dz;
          if (d < best) { best = d; if (d === 0) break; }
        }
        const v = 1 - sstep(f0, f1, Math.sqrt(best));
        // never veil the home island (the gaps between isles are only 2-3 tiles)
        const tx = Math.round(wx), tz = Math.round(wz);
        const home = map.isLand(tx, tz) && map.islandAt(tx, tz) === 'home';
        data[(j * tw + i) * 4 + ch] = home ? 0 : Math.round(v * 255);
      }
    }
  });
  const texture = new THREE.DataTexture(data, tw, th, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { texture, x0, z0, wWorld: tw / LOCK_RES, hWorld: th / LOCK_RES };
}
