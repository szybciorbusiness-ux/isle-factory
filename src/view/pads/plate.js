// Floor plates for every build pad in ONE instanced draw call (FIRST-20.md "Pads are floor plates"): a flat
// rounded slab on the ground in the sticker language (UI-STYLE.md) -
//   cream top face, a darker lip along the near (south) edge so it reads as a slab seen from the high camera,
//   a 3 px warm-brown outline (constant in screen pixels, like the HUD's stickers), a thin white top highlight,
//   a soft drop shadow, and the paid progress filling the plate with green from the near edge (wavy liquid line).
// Standing on it presses the slab down (the lip shrinks) and a warm halo hugs the outline.
// Everything is a signed-distance shader on one quad per plate; the content (icons / numbers / tag) is glyphs.js.
//
// Per instance:
//   pos   = [centre x, y, centre z, scale]
//   rect  = [halfX, halfZ, corner radius, lip]       (tile units, unscaled; lip already reflects the press)
//   state = [fill 0..1, alpha 0..1, on 0..1, flash 0..1]
//   extra = [emblem shadow strength, its offset z, completion green 0..1, 0]
import * as THREE from 'three';

export const MARGIN = 0.34; // the quad extends this far past the plate (shadow + halo)

const vert = /* glsl */`
  attribute vec4 iPos;
  attribute vec4 iRect;
  attribute vec4 iState;
  attribute vec4 iExtra;
  varying vec2 vP;
  varying vec4 vRect;
  varying vec4 vState;
  varying vec4 vExtra;
  void main() {
    vP = position.xz * 2.0 * (iRect.xy + ${MARGIN.toFixed(3)});
    vRect = iRect; vState = iState; vExtra = iExtra;
    vec3 p = vec3(iPos.x + vP.x * iPos.w, iPos.y, iPos.z + vP.y * iPos.w);
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;

const frag = /* glsl */`
  uniform float uTime;
  uniform float uOutline;   // outline width in render-target pixels (3 CSS px)
  uniform vec3 uInk;
  uniform vec3 uCream;
  uniform vec3 uLip;
  uniform vec3 uGreen;
  uniform vec3 uGreenLip;
  uniform vec3 uGreenHi;
  uniform vec3 uGlow;
  uniform vec3 uShadow;
  varying vec2 vP;
  varying vec4 vRect;
  varying vec4 vState;
  varying vec4 vExtra;

  float sdRound(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  }
  void over(inout vec4 dst, vec3 c, float a) { dst.rgb = c * a + dst.rgb * (1.0 - a); dst.a = a + dst.a * (1.0 - a); }

  void main() {
    vec2 b = vRect.xy;
    float r = min(vRect.z, min(b.x, b.y));
    float L = min(vRect.w, b.y);
    float fill = vState.x, alpha = vState.y, on = vState.z, flash = vState.w;
    // slab: the top face sits L further north than the bottom face; the silhouette is their union
    vec2 hb = vec2(b.x, b.y - L * 0.5);
    float dT = sdRound(vP - vec2(0.0, -L * 0.5), hb, r);
    float dB = sdRound(vP - vec2(0.0, L * 0.5), hb, r);
    float d = min(dT, dB);
    float px = max(length(vec2(dFdx(dB), dFdy(dB))), 1e-5);   // tiles per render pixel across the edge
    float aa = px;
    float ow = uOutline * px;
    float inside = 1.0 - smoothstep(-aa, aa, d);

    vec4 col = vec4(0.0);
    // soft drop shadow under the lip
    float dS = sdRound(vP - vec2(0.0, 0.07 + L * 0.5), hb + vec2(0.0, L * 0.5), r);
    over(col, uShadow, (1.0 - smoothstep(-0.06, 0.16, dS)) * 0.3 * (1.0 - inside));
    // warm halo while the player stands on it
    float pulse = 0.8 + 0.2 * sin(uTime * 7.0);
    float halo = exp(-max(d, 0.0) / 0.13) * (1.0 - inside) * on * 0.7 * pulse;
    over(col, uGlow, halo);
    // a crisp warm ring hugging the outline
    float ringW = uOutline * 0.9 * px;
    float ring = (1.0 - smoothstep(ringW, ringW + aa, d)) * smoothstep(-aa, 0.0, d) * on;
    over(col, uGlow, ring * 0.95);

    // fill: rises from the near (south) edge to the far edge with a soft wavy liquid line
    float live = step(0.002, fill) * step(fill, 0.998);
    float edgeY = b.y - fill * 2.0 * b.y;
    edgeY += live * (sin(vP.x * 7.0 + uTime * 4.2) * 0.028 + sin(vP.x * 12.5 - uTime * 2.9) * 0.014);
    float inFill = max(smoothstep(-aa, aa, vP.y - edgeY), vExtra.z);
    vec3 top = mix(uCream, uGreen, inFill);
    vec3 lip = mix(uLip, uGreenLip, inFill);
    float line = (1.0 - smoothstep(0.0, 0.03 + aa, abs(vP.y - edgeY))) * live;
    top = mix(top, uGreenHi, line * 0.9);
    // a gentle sheen drifting over the fill
    float sheen = smoothstep(0.32, 0.0, abs(fract((vP.x - vP.y) * 0.4 - uTime * 0.3) - 0.5)) * 0.12 * inFill;
    top += sheen;
    // standing on it: the face brightens a touch
    top = mix(top, vec3(1.0), on * 0.08);
    float topMask = 1.0 - smoothstep(-aa, aa, dT);
    vec3 body = mix(lip, top, topMask);
    // emblem contact shadow (floating hire / upgrade emblems)
    float es = exp(-(vP.x * vP.x * 5.0 + pow(vP.y - vExtra.y, 2.0) * 9.0)) * vExtra.x;
    body = mix(body, body * 0.78, es * topMask);
    body = mix(body, vec3(1.0), flash * 0.65);
    over(col, body, inside);
    // the sticker's inset white highlight just inside the far outline
    float hw = uOutline * 0.55 * px;
    float hi = (smoothstep(ow - aa, ow + aa * 0.5, -dT) - smoothstep(ow + hw - aa * 0.5, ow + hw + aa, -dT)) * smoothstep(0.1, -b.y * 0.5, vP.y);
    over(col, vec3(1.0), hi * 0.8 * inside);
    // 3 px warm-brown outline around the whole slab
    float ol = smoothstep(-ow - aa, -ow + aa, d) * inside;
    over(col, uInk, ol);

    col *= alpha;
    if (col.a < 0.003) discard;
    gl_FragColor = col;
    #include <colorspace_fragment>
  }
`;

export function createPlates({ cap = 24 } = {}) {
  const quad = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute('position', quad.getAttribute('position'));
  const attr = () => new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const pos = attr(), rect = attr(), state = attr(), extra = attr();
  geo.setAttribute('iPos', pos);
  geo.setAttribute('iRect', rect);
  geo.setAttribute('iState', state);
  geo.setAttribute('iExtra', extra);
  geo.instanceCount = 0;
  const C = h => new THREE.Color(h);
  const material = new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: {
      uTime: { value: 0 },
      uOutline: { value: 3 },
      uInk: { value: C('#5b3a21') },
      uCream: { value: C('#fff7e6') },
      uLip: { value: C('#e3c99a') },
      uGreen: { value: C('#8fd14f') },
      uGreenLip: { value: C('#5e9e2c') },
      uGreenHi: { value: C('#d4f59a') },
      uGlow: { value: C('#ffe07a') },
      uShadow: { value: C('#3b4a1c') },
    },
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    fog: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  mesh.name = 'padPlates';

  let n = 0;
  return {
    mesh, cap, material,
    begin() { n = 0; },
    // p4 = [x, y, z, scale], r4 / s4 / e4 as documented above
    push(p4, r4, s4, e4) {
      if (n >= cap) return;
      const i = n * 4;
      pos.array.set(p4, i); rect.array.set(r4, i); state.array.set(s4, i); extra.array.set(e4, i);
      n++;
    },
    commit(time, outlinePx) {
      geo.instanceCount = n;
      mesh.visible = n > 0;
      material.uniforms.uTime.value = time;
      if (outlinePx > 0) material.uniforms.uOutline.value = outlinePx;
      if (n) for (const a of [pos, rect, state, extra]) { a.addUpdateRange?.(0, n * 4); a.needsUpdate = true; }
    },
  };
}
