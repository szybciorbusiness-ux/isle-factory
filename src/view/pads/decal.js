// Ground decals for every build pad in ONE instanced draw call: a dashed rounded rectangle whose capsule dashes
// march around the outline, a faint wash inside, and a paid fill that rises from the near edge (+z, toward the
// camera) to the far edge with a soft wavy liquid line. Everything is a signed-distance shader on a flat quad;
// the dash parameter is the exact arc length around the rounded rectangle, so dashes stay evenly spaced on the
// corners and an integer number of them closes the loop seamlessly.
//
// Per-instance data (set through setInstance):
//   rect  = [halfX, halfZ, cornerRadius, inset]   inset shrinks the outline toward the centre ("snap inward")
//   state = [progress 0..1, alpha 0..1, glow 0..1, dashPhase]
//   extra = [flash 0..1, fill alpha boost, dash width scale, 0]
// The instance matrix places / scales / bobs the quad; the shader works in its own local tile units, so a
// matrix scale reads as the whole pad scaling (scale-in, pulse) without changing the dash layout.
import * as THREE from 'three';

export const MARGIN = 0.32; // quad extends this far past the outline (room for the halo + scale)

const vert = /* glsl */`
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
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

const frag = /* glsl */`
  uniform float uTime;
  uniform vec3 uDash;
  uniform vec3 uShade;
  uniform vec3 uWash;
  uniform vec3 uFill;
  uniform vec3 uLine;
  uniform vec3 uActive;
  varying vec2 vP;
  varying vec4 vRect;
  varying vec4 vState;
  varying vec4 vExtra;

  float sdRound(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  }
  // Arc length around a rounded rectangle (corner centres at +-c, radius r), continuous all the way round.
  float perim(vec2 p, vec2 c, float r) {
    vec2 a = abs(p);
    vec2 q = a - c;
    float qa = 1.5707963 * r;
    float Lq = c.y + qa + c.x;
    float s;
    if (q.x > 0.0 && q.y > 0.0) s = c.y + atan(q.y, q.x) * r;
    else if (q.x >= q.y) s = min(a.y, c.y);
    else s = c.y + qa + (c.x - min(a.x, c.x));
    if (p.x >= 0.0 && p.y >= 0.0) return s;
    if (p.x < 0.0 && p.y >= 0.0) return 2.0 * Lq - s;
    if (p.x < 0.0) return 2.0 * Lq + s;
    return 4.0 * Lq - s;
  }
  // premultiplied "over"
  void over(inout vec4 dst, vec3 c, float a) { dst.rgb = c * a + dst.rgb * (1.0 - a); dst.a = a + dst.a * (1.0 - a); }

  void main() {
    float progress = vState.x, alpha = vState.y, glow = vState.z, phase = vState.w;
    float flash = vExtra.x;
    vec2 b = max(vRect.xy - vRect.w, vec2(0.04));
    float r = min(vRect.z, min(b.x, b.y));
    float d = sdRound(vP, b, r);
    vec2 px = fwidth(vP);
    float aa = max(length(px) * 0.75, 1e-4);

    // ---- dashes (capsules along the outline) ----
    float W = 0.042 * vExtra.z;
    vec2 c = b - r;
    float L = 4.0 * (c.x + c.y) + 6.2831853 * r;
    float n = max(4.0, floor(L / 0.31 + 0.5));
    float seg = L / n;
    float s = perim(vP, c, r);
    float f = fract(s / seg - phase);
    float along = abs(f - 0.5) * seg;
    float halfLen = seg * 0.29;
    float dd = length(vec2(max(along - max(halfLen - W, 0.0), 0.0), d)) - W;
    float dash = 1.0 - smoothstep(-aa, aa, dd);
    // soft shade under each dash, nudged toward the camera so the dash reads raised off the grass
    float ds = length(vec2(max(along - max(halfLen - W, 0.0), 0.0), d - 0.022)) - W;
    float shade = (1.0 - smoothstep(-0.01, 0.05, ds)) * 0.32;

    // ---- inside: a faint wash + the paid fill rising from the near edge ----
    float inner = d + W * 1.6;
    float inside = 1.0 - smoothstep(-aa, aa, inner);
    float live = step(0.002, progress) * step(progress, 0.998);
    float edge = b.y - progress * 2.0 * b.y;
    edge += live * (sin(vP.x * 8.0 + uTime * 4.5) * 0.022 + sin(vP.x * 13.0 - uTime * 3.1) * 0.012);
    float fillM = smoothstep(-aa, aa, vP.y - edge) * inside;
    float lineM = (1.0 - smoothstep(0.0, 0.035 + aa, abs(vP.y - edge))) * inside * live;
    // a gentle sheen that sweeps across the fill
    float sheen = smoothstep(0.35, 0.0, abs(fract((vP.x + vP.y) * 0.35 - uTime * 0.35) - 0.5)) * 0.10;

    vec4 col = vec4(0.0);
    over(col, uWash, inside * (0.085 + glow * 0.13));
    over(col, uFill, fillM * (0.30 + glow * 0.12 + vExtra.y + sheen));
    over(col, uLine, lineM * 0.85);
    // soft contact shadow under a floating emblem (extra.w = strength, scaled by its hover height)
    float sh = exp(-dot(vP, vP) / 0.075) * vExtra.w;
    over(col, uShade, sh * 0.26);
    // inner glow hugging the outline while the player stands on it
    float rim = (1.0 - smoothstep(0.0, 0.16, -inner)) * inside;
    over(col, uActive, rim * glow * 0.3);
    over(col, uShade, shade * (1.0 - dash));
    // dashes warm up to a soft gold while the player stands on the pad
    over(col, mix(uDash, uActive, glow * 0.75), dash);
    over(col, uLine, inside * flash * 0.6);

    col *= alpha;
    if (col.a < 0.002) discard;
    gl_FragColor = vec4(col.rgb / max(col.a, 1e-4), col.a);
    #include <colorspace_fragment>
  }
`;

export function createDecals({ cap = 24 } = {}) {
  const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const rect = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const state = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const extra = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iRect', rect);
  geo.setAttribute('iState', state);
  geo.setAttribute('iExtra', extra);
  const material = new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: {
      uTime: { value: 0 },
      uDash: { value: new THREE.Color('#fffcf0') },
      uShade: { value: new THREE.Color('#2f5a1c') },
      uWash: { value: new THREE.Color('#fffbea') },
      uFill: { value: new THREE.Color('#fff3c4') },
      uLine: { value: new THREE.Color('#ffffff') },
      uActive: { value: new THREE.Color('#ffe07a') },
    },
    transparent: true,
    depthWrite: false,
    fog: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new THREE.InstancedMesh(geo, material, cap);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  mesh.name = 'padDecals';
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
  return {
    mesh,
    cap,
    // i: slot; pos {x,y,z}; scale number; size [halfX, halfZ]; plus rect/state/extra arrays
    setInstance(i, x, y, z, scale, r4, s4, e4) {
      const qx = 2 * (r4[0] + MARGIN), qz = 2 * (r4[1] + MARGIN);
      m.compose(p.set(x, y, z), q.identity(), s.set(qx * scale, 1, qz * scale));
      mesh.setMatrixAt(i, m);
      rect.array.set(r4, i * 4);
      state.array.set(s4, i * 4);
      extra.array.set(e4, i * 4);
    },
    commit(count, time) {
      mesh.count = count;
      mesh.visible = count > 0;
      material.uniforms.uTime.value = time;
      mesh.instanceMatrix.needsUpdate = true;
      rect.needsUpdate = true; state.needsUpdate = true; extra.needsUpdate = true;
    },
  };
}
