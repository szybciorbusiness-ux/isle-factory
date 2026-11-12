// Post: scene -> multisampled HDR target, two-level blur pyramid (half + quarter res, separable Gaussian;
// a quarter + eighth on phones via ctx.quality.postScale), then one composite pass to the screen: tilt-shift
// (crisp centre band, blur growing toward top/bottom), a clean, vivid grade (saturation + vibrance, a touch
// of contrast, only a whisper of lift so blacks stay soft but colours don't go milky), soft vignette,
// hue-preserving highlight roll-off, sRGB output and dithering. Returns {} if anything is unsupported so
// main.js renders directly.
//
// Camp mode: while the hearth is cold (camp level 0) the frame is graded cooler, a little dimmer and less
// saturated. When it's lit, a warm wave spreads out from the hearth (world/mood.js drives its progress):
// inside the front the colours are warm, outside still cold, and a band of warm light rides the front.
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
const TILT = {
  focus: 0.47,      // screen-space y (0 bottom .. 1 top) of the crisp band centre
  band: 0.17,       // half height of the fully crisp band
  softTop: 0.3,     // distance over which blur ramps in above the band
  softBottom: 0.36,
  maxTop: 1.0,      // 0..1, 1 = quarter-res blur
  maxBottom: 0.45,
};
const TILT_TALL = { focus: 0.5, band: 0.3, softTop: 0.16, softBottom: 0.18, maxTop: 0.92, maxBottom: 0.42 };
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
      uTilt: { value: new THREE.Vector4(TILT.focus, TILT.band, TILT.softTop, TILT.softBottom) },
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
      uniform vec4 uTilt, uWave;
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
        float dy = vUv.y - uTilt.x;
        float k = dy > 0.0
          ? smoothstep(uTilt.y, uTilt.y + uTilt.z, dy) * uTiltMax.x
          : smoothstep(uTilt.y, uTilt.y + uTilt.w, -dy) * uTiltMax.y;
        // a little extra softness toward the far left/right corners
        float sx = abs(vUv.x - 0.5) * 2.0;
        k = clamp(k + smoothstep(0.75, 1.0, sx) * smoothstep(0.05, 0.3, abs(dy)) * 0.12, 0.0, 1.0);
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
          // near-whites (clouds, foam) only take half of it, so the cold sky stays clean instead of grey
          float cold = uCold * smoothstep(uWave.z - ${COLD.front.toFixed(2)}, uWave.z + 0.2, d) * (1.0 - 0.5 * smoothstep(0.8, 0.96, lc));
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
    u.uTilt.value.set(m('focus'), m('band'), m('softTop'), m('softBottom'));
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
