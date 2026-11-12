// Post: scene -> multisampled HDR target, two-level blur pyramid (half + quarter res, separable Gaussian;
// a quarter + eighth on phones via ctx.quality.postScale), then one composite pass to the screen: tilt-shift
// (crisp centre band, blur growing toward top/bottom), a clean, vivid grade (saturation + vibrance, a touch
// of contrast, only a whisper of lift so blacks stay soft but colours don't go milky), soft vignette,
// hue-preserving highlight roll-off, sRGB output and dithering. Returns {} if anything is unsupported so
// main.js renders directly.
//
// Focus pull (update(dt), which runs after the camera and the guide): the crisp band stretches to hold the
// guide's target and arrow, the station tops and signs and the pad plates in view, so nothing the player
// must read sits in the blur; the frame's outer edge still goes soft (see FOCUS).
//
// Camp mode: while the hearth is cold (camp level 0) the frame is graded cooler, a little dimmer and less
// saturated (vivid oranges, the guide arrow and Dug's helmet, mostly keep theirs). When it's lit, a warm wave
// spreads out from the hearth (world/mood.js drives its progress): inside the front the colours are warm,
// outside still cold, and a band of warm light rides the front.
// The wave is placed in the world by intersecting each pixel's view ray with the ground plane.
//
// Before rendering it gives the world modules a last look at the final camera: props.prepareRender (view /
// shadow culling of instanced props), terrain.prepareRender (phones: windowed grass and clutter) and
// sky.beginHalfRes (phones: half-res clouds). Phones render the scene into an R11F_G11F_B10F buffer
// (?postfmt=hf forces RGBA16F).
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { getMood } from './world/mood.js';

// Tilt-shift band, in screen space. Landscape and tall portrait (phones) have their own tuning and are
// blended by aspect: a portrait screen shows ~2x more world vertically, so its crisp band is taller in
// screen terms (the middle 60% stays sharp) and the blur ramps in over a shorter stretch at the edges.
// Landscape shows only ~13 tiles top to bottom (the home isle is 11), so its band is wide too: the soft
// edge sits on the clouds and far water, not on the camp's north row.
const TILT = {
  focus: 0.47,      // screen-space y (0 bottom .. 1 top) of the crisp band centre
  band: 0.26,       // half height of the fully crisp band
  softTop: 0.25,    // distance over which blur ramps in above the band
  softBottom: 0.21,
  maxTop: 0.9,      // 0..1, 1 = quarter-res blur
  maxBottom: 0.38,
};
const TILT_TALL = { focus: 0.5, band: 0.3, softTop: 0.16, softBottom: 0.18, maxTop: 0.92, maxBottom: 0.42 };
// Focus pull: the band above is only the resting shape. Every frame it also stretches (never shrinks) to hold
// what the player must read: the guide's target and its bouncing arrow (all the way to the screen edge), and,
// up to a cap that keeps a sliver of soft edge, every station top and signboard (FIRST-20 rule 3: the
// input -> output sign) and every pad plate in view. The band edges glide there (fast to open, slow to close),
// and the soft ramp beyond a stretched edge gets shorter, so the top of the frame still melts into the clouds.
const FOCUS = {
  margin: 0.035,    // screen-y headroom past the topmost / bottommost point held
  capTop: 0.935,    // how far up stations and pads may push the band (the guide target: 1)
  capBottom: 0.07,
  minSoft: 0.075,   // shortest blur ramp beyond a stretched edge
  arrowH: 1.35,     // world height of the bouncing arrow above its tip (size + hop)
  open: 7,          // 1/s, band edge easing toward a wider band
  close: 2.2,       // 1/s, back toward the resting band
  every: 1 / 15,    // s between re-measuring (the easing runs every frame)
};
// Grade. Portrait (phones) is blended in by aspect like the tilt band: a phone shows more far-away ground
// through more aerial haze, so it gets a little more colour and less lift to stay as vivid as the reference.
const GRADE = {
  saturation: 1.0,
  vibrance: 0.1,    // extra saturation for muted colours (fades out as saturation rises)
  contrast: 1.0,    // around a light mid-grey pivot (in the gamma-2 domain)
  warm: [1.02, 1.0, 0.975],
  lift: 0.026,
  liftColor: [0.6, 0.86, 0.8],
  vignette: 0.09,
  vignetteColor: '#eafffc',
  shoulder: 0.93,   // highlights above this roll off smoothly (hue preserving)
};
const GRADE_TALL = { saturation: 1.05, vibrance: 0.14, contrast: 1.03, lift: 0.016, vignette: 0.07 };
// the cold camp (level 0)
const COLD = {
  saturation: 0.78,
  tint: [0.94, 0.978, 1.045],
  dim: 0.95,
  front: 1.7,       // world units over which the wave's edge blends cold -> warm
  rim: [0.2, 0.12, 0.03], // warm light riding the wave front
  rimWidth: 1.15,
  // vivid warm hues (gamma-2 red minus blue from keepFrom to keepTo) keep this much of their own colour
  keepFrom: 0.4, keepTo: 0.6, keep: 0.65,
};

export function create(ctx) {
  try {
    return createPost(ctx);
  } catch (e) {
    // no render() -> main.js renders the scene directly
    return { error: String(e?.message || e) };
  }
}

// Can we render (with MSAA) into R11F_G11F_B10F? Asks for the per-format sample counts, then builds a tiny
// multisampled framebuffer to make sure the driver really accepts it.
function packedFloatSupport(gl, ext, wantSamples) {
  try {
    if (!ext.has('EXT_color_buffer_float')) return { ok: false };
    const list = gl.getInternalformatParameter(gl.RENDERBUFFER, gl.R11F_G11F_B10F, gl.SAMPLES);
    const counts = list ? Array.from(list) : [];
    const samples = wantSamples > 0 ? counts.filter(s => s <= wantSamples).sort((a, b) => b - a)[0] || 0 : 0;
    if (wantSamples > 0 && !samples) return { ok: false };
    const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING), prevRb = gl.getParameter(gl.RENDERBUFFER_BINDING);
    const fb = gl.createFramebuffer(), rb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    if (samples) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.R11F_G11F_B10F, 4, 4);
    else gl.renderbufferStorage(gl.RENDERBUFFER, gl.R11F_G11F_B10F, 4, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
    gl.bindRenderbuffer(gl.RENDERBUFFER, prevRb);
    gl.deleteFramebuffer(fb); gl.deleteRenderbuffer(rb);
    return { ok, samples };
  } catch {
    return { ok: false };
  }
}

function createPost(ctx) {
  const { renderer, scene, camera } = ctx;
  const gl = renderer.getContext();
  const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  if (!isWebGL2) return {};
  const ext = renderer.extensions;
  const halfOk = ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
  let type = halfOk ? THREE.HalfFloatType : THREE.UnsignedByteType;
  let format = THREE.RGBAFormat;
  let samples = Math.min(4, renderer.capabilities.maxSamples || 0);
  const postScale = Math.max(0.25, Math.min(1, Number(ctx.quality?.postScale) || 1));
  const mood = getMood(ctx);
  // Phones: the scene buffer is packed float R11F_G11F_B10F (4 bytes a pixel) instead of RGBA16F (8): still
  // HDR (~5% of the frame is above 1.0, sand / clouds / highlights, and the composite rolls it off), half the
  // memory traffic for the 4x MSAA samples and every pass that reads it. Needs EXT_color_buffer_float and MSAA
  // support for the format; otherwise (or with ?postfmt=hf) it stays RGBA16F.
  const MOBILE = ctx.quality?.tier === 'mobile';
  const fmtParam = ctx.params?.get?.('postfmt');
  if ((MOBILE && fmtParam !== 'hf') || fmtParam === 'rg11') {
    const p = packedFloatSupport(gl, ext, samples);
    if (p.ok) { type = THREE.UnsignedInt101111Type; format = THREE.RGBFormat; samples = p.samples; }
  }

  const mkRT = (ms, depth) => new THREE.WebGLRenderTarget(1, 1, {
    type, format, samples: ms ? samples : 0, depthBuffer: depth, stencilBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
  });
  const rtScene = mkRT(true, true);
  const rtH = [mkRT(false, false), mkRT(false, false)];
  const rtQ = [mkRT(false, false), mkRT(false, false)];

  const quadVS = /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

  // 9-tap Gaussian via linear sampling (5 fetches)
  const blurMat = new THREE.ShaderMaterial({
    name: 'IsleBlur',
    uniforms: { tSrc: { value: null }, uStep: { value: new THREE.Vector2() } },
    vertexShader: quadVS,
    fragmentShader: /* glsl */`
      uniform sampler2D tSrc;
      uniform vec2 uStep;
      varying vec2 vUv;
      void main() {
        vec3 c = texture2D(tSrc, vUv).rgb * 0.2270270270;
        vec2 o1 = uStep * 1.3846153846, o2 = uStep * 3.2307692308;
        c += texture2D(tSrc, vUv + o1).rgb * 0.3162162162;
        c += texture2D(tSrc, vUv - o1).rgb * 0.3162162162;
        c += texture2D(tSrc, vUv + o2).rgb * 0.0702702703;
        c += texture2D(tSrc, vUv - o2).rgb * 0.0702702703;
        gl_FragColor = vec4(c, 1.0);
      }`,
    depthTest: false, depthWrite: false, toneMapped: false,
  });

  const vig = new THREE.Color(GRADE.vignetteColor);
  const compMat = new THREE.ShaderMaterial({
    name: 'IsleComposite',
    uniforms: {
      tSharp: { value: rtScene.texture }, tB1: { value: rtH[1].texture }, tB2: { value: rtQ[1].texture },
      uAspect: { value: 1 },
      // crisp band bottom, top (screen y), blur ramp length below, above
      uBand: { value: new THREE.Vector4(TILT.focus - TILT.band, TILT.focus + TILT.band, TILT.softBottom, TILT.softTop) },
      uTiltMax: { value: new THREE.Vector2(TILT.maxTop, TILT.maxBottom) },
      uSat: { value: GRADE.saturation },
      uVibrance: { value: GRADE.vibrance },
      uContrast: { value: GRADE.contrast },
      uWarm: { value: new THREE.Vector3(...GRADE.warm) },
      uLift: { value: GRADE.lift },
      uLiftCol: { value: new THREE.Vector3(...GRADE.liftColor) },
      uVig: { value: GRADE.vignette },
      uVigCol: { value: new THREE.Vector3(vig.r, vig.g, vig.b) },
      uShoulder: { value: GRADE.shoulder },
      // cold camp + warm wave
      uCold: { value: 0 },
      uWave: { value: new THREE.Vector4(0, 0, -100, 0) },   // hearth x, z, front radius, rim strength
      uInvVP: { value: new THREE.Matrix4() },
    },
    vertexShader: quadVS,
    fragmentShader: /* glsl */`
      #include <common>
      uniform sampler2D tSharp, tB1, tB2;
      uniform float uAspect, uSat, uVibrance, uContrast, uLift, uVig, uShoulder, uCold;
      uniform vec4 uBand, uWave;
      uniform vec2 uTiltMax;
      uniform vec3 uWarm, uLiftCol, uVigCol;
      uniform mat4 uInvVP;
      varying vec2 vUv;
      const vec3 LUMA = vec3(0.299, 0.587, 0.114);

      // where this pixel's view ray meets the ground plane (y = 0)
      vec2 groundXZ(vec2 uv) {
        vec2 ndc = uv * 2.0 - 1.0;
        vec4 a = uInvVP * vec4(ndc, -1.0, 1.0); a /= a.w;
        vec4 b = uInvVP * vec4(ndc, 1.0, 1.0); b /= b.w;
        vec3 d = b.xyz - a.xyz;
        float t = d.y < -1e-5 ? -a.y / d.y : 1e5;
        return a.xz + d.xz * t;
      }

      void main() {
        vec3 sharp = texture2D(tSharp, vUv).rgb;
        vec3 b1 = texture2D(tB1, vUv).rgb;
        vec3 b2 = texture2D(tB2, vUv).rgb;
        float above = vUv.y - uBand.y, below = uBand.x - vUv.y;
        float k = above > 0.0 ? smoothstep(0.0, uBand.w, above) * uTiltMax.x
                : below > 0.0 ? smoothstep(0.0, uBand.z, below) * uTiltMax.y : 0.0;
        // a little extra softness toward the far left/right corners (only toward the band's edges)
        float sx = abs(vUv.x - 0.5) * 2.0;
        k = clamp(k + smoothstep(0.75, 1.0, sx) * smoothstep(-0.08, 0.15, max(above, below)) * 0.12, 0.0, 1.0);
        vec3 col = k < 0.5 ? mix(sharp, b1, k * 2.0) : mix(b1, b2, k * 2.0 - 1.0);

        // grade in a gamma-2 domain so it reads perceptually even
        vec3 g = sqrt(max(col, 0.0));
        float l = dot(g, LUMA);
        // saturation + vibrance (muted colours gain more than already-rich ones)
        float chroma = max(g.r, max(g.g, g.b)) - min(g.r, min(g.g, g.b));
        g = mix(vec3(l), g, uSat + uVibrance * (1.0 - smoothstep(0.04, 0.4, chroma)));
        g = (g - 0.66) * uContrast + 0.66;
        // warm the mid tones, leave the near-whites (clouds, foam) clean
        g *= mix(uWarm, vec3(1.0), smoothstep(0.82, 1.0, l));
        g = g + uLift * uLiftCol * (1.0 - g);

        // cold camp: cooler, dimmer, less saturated, except inside the warm wave spreading from the hearth
        if (uCold > 0.001) {
          float d = length(groundXZ(vUv) - uWave.xy);
          float lc = dot(g, LUMA);
          // near-whites (clouds, foam) only take half of it, so the cold sky stays clean instead of grey; vivid
          // oranges (the guide arrow, Dug's helmet) keep most of their punch: the one warm thing in a grey world
          float vivid = smoothstep(${COLD.keepFrom.toFixed(2)}, ${COLD.keepTo.toFixed(2)}, g.r - g.b) * ${COLD.keep.toFixed(2)};
          float cold = uCold * smoothstep(uWave.z - ${COLD.front.toFixed(2)}, uWave.z + 0.2, d) * (1.0 - 0.5 * smoothstep(0.8, 0.96, lc)) * (1.0 - vivid);
          vec3 cg = mix(vec3(lc), g, ${COLD.saturation.toFixed(3)}) * vec3(${COLD.tint.map(v => v.toFixed(3)).join(', ')}) * ${COLD.dim.toFixed(3)};
          g = mix(g, cg, cold);
          float rim = exp(-pow((d - uWave.z) / ${COLD.rimWidth.toFixed(2)}, 2.0)) * uWave.w;
          g += vec3(${COLD.rim.map(v => v.toFixed(3)).join(', ')}) * rim * (1.0 - g);
        }

        // soft mint vignette (lightens toward the cloud colour instead of darkening)
        vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
        float r = length(q) / length(vec2(uAspect, 1.0) * 0.5);
        float v = smoothstep(0.55, 1.05, r) * uVig;
        g = mix(g, sqrt(uVigCol), v);
        col = g * g;
        // hue-preserving highlight shoulder
        float mx = max(col.r, max(col.g, col.b));
        if (mx > uShoulder) {
          float room = 1.0 - uShoulder;
          float nm = uShoulder + room * (1.0 - exp(-(mx - uShoulder) / room));
          col *= nm / mx;
        }

        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        // static dither against banding in the soft gradients
        float dn = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
        gl_FragColor.rgb += (dn - 0.5) / 255.0;
      }`,
    depthTest: false, depthWrite: false,
  });

  const quad = new FullScreenQuad(blurMat);
  let W = 1, H = 1;

  // ---- focus pull: the crisp band (screen y) and where it wants to be ----
  const band = {
    baseLo: TILT.focus - TILT.band, baseHi: TILT.focus + TILT.band, softLo: TILT.softBottom, softHi: TILT.softTop,
    lo: TILT.focus - TILT.band, hi: TILT.focus + TILT.band, wantLo: 0, wantHi: 1,
    primed: false, measureT: 0, held: 0, by: '',
  };
  function pushBand() {
    // beyond a stretched edge the ramp gets shorter, so the frame's edge still goes soft
    const softHi = THREE.MathUtils.clamp(1.02 - band.hi, FOCUS.minSoft, band.softHi);
    const softLo = THREE.MathUtils.clamp(band.lo + 0.02, FOCUS.minSoft, band.softLo);
    compMat.uniforms.uBand.value.set(band.lo, band.hi, softLo, softHi);
  }
  const ndc = new THREE.Vector3(), probe = new THREE.Vector3();
  // screen y (0 bottom .. 1 top) of a world point, or NaN when it is behind the camera
  const screenY = (x, y, z) => {
    ndc.set(x, y, z).project(camera);
    return ndc.z < 1 ? ndc.y * 0.5 + 0.5 : NaN;
  };
  // is this ground anchor in the frame (with a little slack)?
  const inFrame = (x, z) => {
    ndc.set(x, 0, z).project(camera);
    return ndc.z < 1 && Math.abs(ndc.x) < 1.06 && Math.abs(ndc.y) < 1.06;
  };
  let want = { hi: 0, lo: 1, n: 0, by: '' };
  const hold = (x, y, z, capHi, capLo, tag) => {
    const sy = screenY(x, y, z);
    if (!Number.isFinite(sy)) return;
    const hi = Math.min(capHi, sy + FOCUS.margin), lo = Math.max(capLo, sy - FOCUS.margin);
    if (hi > want.hi) { want.hi = hi; want.by = tag; }
    if (lo < want.lo) want.lo = lo;
    want.n++;
  };
  function measureFocus() {
    want.hi = band.baseHi; want.lo = band.baseLo; want.n = 0; want.by = '';
    camera.updateMatrixWorld();
    const views = ctx.views || {}, camp = ctx.camp;
    // 1) the guide's target, its arrow tip and the arrow's top: may hold the band to the frame's very edge
    const guide = views.guide;
    const t = guide && guide.enabled !== false && !guide.retired ? guide.target : null;
    if (t && Number.isFinite(t.x) && Number.isFinite(t.z) && inFrame(t.x, t.z)) {
      hold(t.x, 0, t.z, 1, 0, 'target');
      const a = guide.aim;
      if (a && Number.isFinite(a.x) && Number.isFinite(a.y)) {
        hold(a.x, a.y, a.z, 1, 0, 'arrow');
        hold(a.x, a.y + FOCUS.arrowH, a.z, 1, 0, 'arrow');
      }
    }
    if (!camp) return;
    // 2) station tops and their input -> output signs
    const cv = views.campview;
    if (cv?.stationTop && camp.stations) {
      const station = id => {
        const top = cv.stationTop(id, probe);
        if (!top || !inFrame(top.x, top.z)) return;
        hold(top.x, top.y + 0.15, top.z, FOCUS.capTop, FOCUS.capBottom, id);
        const s = cv.signPoint?.(id, probe);
        if (s && Number.isFinite(s.y)) hold(s.x, s.y + 0.42, s.z - 0.22, FOCUS.capTop, FOCUS.capBottom, `${id} sign`);
      };
      if (!camp.stations.has?.('hearth')) station('hearth');
      for (const id of camp.stations.keys()) station(id);
    }
    // 3) pad plates (their far edge and the tag row on the near side)
    const pv = views.pads;
    if (pv?.plateRect && Array.isArray(camp.pads)) {
      for (const pad of camp.pads) {
        const r = pv.plateRect(pad.id);
        if (!r || !inFrame(r.x, r.z)) continue;
        hold(r.x, 0.05, r.z - r.hz, FOCUS.capTop, FOCUS.capBottom, pad.id);
        hold(r.x, 0.05, r.z + r.hz + 0.42, FOCUS.capTop, FOCUS.capBottom, pad.id);
      }
    }
  }
  function updateFocus(dt) {
    band.measureT -= dt;
    if (band.measureT <= 0 || !band.primed) {
      band.measureT = FOCUS.every;
      want.hi = band.baseHi; want.lo = band.baseLo;
      try { measureFocus(); } catch (e) { want.hi = band.baseHi; want.lo = band.baseLo; }
      band.wantHi = Math.max(band.baseHi, want.hi);
      band.wantLo = Math.min(band.baseLo, want.lo);
      band.held = want.n; band.by = want.by;
    }
    if (!band.primed || !(dt > 0)) {
      if (!band.primed) { band.hi = band.wantHi; band.lo = band.wantLo; band.primed = true; }
    } else {
      const ease = (cur, to, widen) => cur + (to - cur) * (1 - Math.exp(-(widen ? FOCUS.open : FOCUS.close) * dt));
      band.hi = ease(band.hi, band.wantHi, band.wantHi > band.hi);
      band.lo = ease(band.lo, band.wantLo, band.wantLo < band.lo);
    }
    pushBand();
  }

  const resize = (w, h) => {
    const pr = renderer.getPixelRatio();
    W = Math.max(1, Math.round(w * pr));
    H = Math.max(1, Math.round(h * pr));
    rtScene.setSize(W, H);
    const hw = Math.max(1, Math.round(W / 2 * postScale)), hh = Math.max(1, Math.round(H / 2 * postScale));
    const qw = Math.max(1, Math.round(W / 4 * postScale)), qh = Math.max(1, Math.round(H / 4 * postScale));
    rtH.forEach(rt => rt.setSize(hw, hh));
    rtQ.forEach(rt => rt.setSize(qw, qh));
    const aspect = w / Math.max(1, h);
    const u = compMat.uniforms;
    u.uAspect.value = aspect;
    // blend the tilt-shift + grade tuning between tall portrait (aspect <= 0.6) and landscape (>= 1.2)
    const k = THREE.MathUtils.smoothstep(aspect, 0.6, 1.2);
    const m = key => TILT_TALL[key] + (TILT[key] - TILT_TALL[key]) * k;
    band.baseLo = m('focus') - m('band');
    band.baseHi = m('focus') + m('band');
    band.softLo = m('softBottom');
    band.softHi = m('softTop');
    band.measureT = 0;
    if (!band.primed) { band.lo = band.wantLo = band.baseLo; band.hi = band.wantHi = band.baseHi; }
    pushBand();
    u.uTiltMax.value.set(m('maxTop'), m('maxBottom'));
    const gm = key => (GRADE_TALL[key] ?? GRADE[key]) + (GRADE[key] - (GRADE_TALL[key] ?? GRADE[key])) * k;
    u.uSat.value = gm('saturation');
    u.uVibrance.value = gm('vibrance');
    u.uContrast.value = gm('contrast');
    u.uLift.value = gm('lift');
    u.uVig.value = gm('vignette');
  };
  const size = new THREE.Vector2();
  renderer.getSize(size);
  resize(size.x || innerWidth, size.y || innerHeight);

  const blur = (src, dst, dx, dy) => {
    blurMat.uniforms.tSrc.value = src.texture;
    blurMat.uniforms.uStep.value.set(dx / dst.width, dy / dst.height);
    renderer.setRenderTarget(dst);
    quad.render(renderer);
  };

  // ---- the warm wave: how far its front must travel to sweep the whole frame ----
  const ndcRay = new THREE.Vector3(), camPos = new THREE.Vector3();
  const frameReach = (hx, hz) => {
    camera.getWorldPosition(camPos);
    let reach = 8;
    for (const [nx, ny] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      ndcRay.set(nx, ny, 0.5).unproject(camera).sub(camPos);
      const t = ndcRay.y < -1e-4 ? -camPos.y / ndcRay.y : 60 / Math.max(1e-3, Math.hypot(ndcRay.x, ndcRay.z));
      reach = Math.max(reach, Math.hypot(camPos.x + ndcRay.x * t - hx, camPos.z + ndcRay.z * t - hz));
    }
    return Math.min(60, reach + COLD.front + 1);
  };
  let reach = 0;
  const syncMood = () => {
    const u = compMat.uniforms;
    u.uCold.value = mood.cold;
    if (mood.cold <= 0.001) { reach = 0; return; }
    camera.updateMatrixWorld();
    u.uInvVP.value.multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);
    const w = mood.wave;
    if (w.active) {
      if (w.t <= 1e-6 || !reach) reach = frameReach(w.x, w.z);
      const rim = (1 - w.p) * Math.min(1, w.p * 10);
      u.uWave.value.set(w.x, w.z, reach * w.p, rim);
    } else {
      reach = 0;
      u.uWave.value.set(0, 0, -100, 0);
    }
  };

  return {
    rtScene,
    tilt: TILT, tiltTall: TILT_TALL, grade: GRADE, gradeTall: GRADE_TALL, cold: COLD,
    postScale,
    // the scene buffer: 'RGBA16F' | 'R11F_G11F_B10F' | 'RGBA8', and its MSAA sample count
    get sceneFormat() { return { format: type === THREE.UnsignedInt101111Type ? 'R11F_G11F_B10F' : type === THREE.HalfFloatType ? 'RGBA16F' : 'RGBA8', samples }; },
    // runs last in main.js's update order, so the camera and the guide are already where this frame has them
    update(dt) { updateFocus(Math.max(0, Math.min(0.1, Number(dt) || 0))); },
    // tests: the crisp band now (screen y, 0 bottom .. 1 top), its resting shape and what holds it open
    focusState() {
      const b = compMat.uniforms.uBand.value, f = n => +n.toFixed(3);
      return { lo: f(b.x), hi: f(b.y), softBelow: f(b.z), softAbove: f(b.w), baseLo: f(band.baseLo), baseHi: f(band.baseHi), wantLo: f(band.wantLo), wantHi: f(band.wantHi), held: band.held, by: band.by };
    },
    render() {
      // view culling of instanced props against the camera as it is now (it moved after props.update)
      ctx.views.props?.prepareRender?.();
      ctx.views.terrain?.prepareRender?.();   // phones: windowed grass / tufts / flowers
      const prevTarget = renderer.getRenderTarget();
      // phones: the clouds are shaded at half res first, then upsampled inside the scene pass
      const halfClouds = ctx.views.sky?.beginHalfRes?.(renderer) === true;
      renderer.setRenderTarget(rtScene);
      renderer.render(scene, camera);
      if (halfClouds) ctx.views.sky.endHalfRes();

      quad.material = blurMat;
      blur(rtScene, rtH[0], 1, 0);
      blur(rtH[0], rtH[1], 0, 1);
      blur(rtH[1], rtQ[0], 1.2, 0);
      blur(rtQ[0], rtQ[1], 0, 1.2);

      syncMood();
      quad.material = compMat;
      renderer.setRenderTarget(prevTarget);
      quad.render(renderer);
    },
    resize,
    dispose() {
      [rtScene, ...rtH, ...rtQ].forEach(rt => rt.dispose());
      blurMat.dispose(); compMat.dispose(); quad.dispose();
    },
  };
}
