// The hearth level-up moment: a soft shockwave ring rolling out over the ground and a radial burst of warm
// light rays behind the hearth, both signed-distance shaders on single quads (2 draw calls, only while live).
// When the world's warm wave runs (views.lighting.mood.wave, the hearth's first ignition) the ring rides its
// front: radius = how far the post's warm edge must travel to reach the frame corners x the wave's eased
// progress, so the light and the ring arrive together. Later level-ups have no wave and use the same curve on
// their own clock. Driven by play(...) + update(dt); nothing reads wall-clock time.
import * as THREE from 'three';
import { ease, clamp } from '../../util/anim.js';

const ringFrag = /* glsl */`
  uniform float uHalf;   // half size of the quad (world units)
  uniform float uR;      // ring radius (world units)
  uniform float uW;      // ring half width
  uniform float uA;      // alpha
  uniform vec3 uCol;
  uniform vec3 uCol2;
  varying vec2 vP;
  void main() {
    float d = length(vP) * uHalf;
    float x = (d - uR) / uW;
    // soft leading edge, longer trailing glow inside the ring
    float band = x > 0.0 ? exp(-x * x * 4.0) : exp(-x * x * 1.1);
    float inner = smoothstep(uR, 0.0, d) * 0.07;
    float a = (band + inner) * uA;
    if (a < 0.003) discard;
    vec3 c = mix(uCol2, uCol, clamp(band, 0.0, 1.0));
    gl_FragColor = vec4(c, a);
    #include <colorspace_fragment>
  }
`;
const raysFrag = /* glsl */`
  uniform float uK;      // 0..1 progress
  uniform float uA;
  uniform float uSpin;
  uniform vec3 uCol;
  uniform vec3 uCore;
  varying vec2 vP;
  void main() {
    float d = length(vP);
    float ang = atan(vP.y, vP.x) + uSpin;
    float rays = pow(0.5 + 0.5 * cos(ang * 12.0), 6.0) * 0.85 + pow(0.5 + 0.5 * cos(ang * 7.0 + 1.3), 10.0) * 0.5;
    float reach = mix(0.25, 1.0, uK);
    float fall = smoothstep(reach, reach * 0.35, d);
    float core = exp(-d * d * 26.0);
    float a = (rays * fall * smoothstep(0.04, 0.16, d) + core) * uA;
    if (a < 0.003) discard;
    gl_FragColor = vec4(mix(uCol, uCore, core), a);
    #include <colorspace_fragment>
  }
`;
const vert = /* glsl */`
  varying vec2 vP;
  void main() { vP = position.xy * 2.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

const WAVE_T = 1.2;     // matches world/mood.js WAVE_TIME when no wave is running
const R_MAX = 5.6;      // own-clock radius (later level-ups)
const FRONT = 1.7;      // post.js COLD.front: the warm edge's blend width

export function createBurst(ctx) {
  const { scene, camera } = ctx;
  const quad = new THREE.PlaneGeometry(1, 1);
  const ringMat = new THREE.ShaderMaterial({
    vertexShader: vert, fragmentShader: ringFrag, transparent: true, depthWrite: false, fog: false,
    uniforms: { uHalf: { value: 1 }, uR: { value: 0 }, uW: { value: 0.3 }, uA: { value: 0 }, uCol: { value: new THREE.Color('#fffbe6') }, uCol2: { value: new THREE.Color('#ffe7a3') } },
  });
  const ring = new THREE.Mesh(quad, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.renderOrder = 5; ring.visible = false; ring.frustumCulled = false; ring.name = 'hearthShockwave';
  const raysMat = new THREE.ShaderMaterial({
    vertexShader: vert, fragmentShader: raysFrag, transparent: true, depthWrite: false, depthTest: false, fog: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uK: { value: 0 }, uA: { value: 0 }, uSpin: { value: 0 }, uCol: { value: new THREE.Color('#ffcf6a') }, uCore: { value: new THREE.Color('#fff8e0') } },
  });
  const rays = new THREE.Mesh(quad, raysMat);
  rays.renderOrder = 6; rays.visible = false; rays.frustumCulled = false; rays.name = 'hearthBurst';
  scene.add(ring, rays);

  // how far the post's warm edge travels to sweep the frame (same construction as post.js frameReach)
  const ndc = new THREE.Vector3(), camPos = new THREE.Vector3();
  function frameReach(hx, hz) {
    camera.updateMatrixWorld();
    camera.getWorldPosition(camPos);
    let reach = 8;
    for (const [nx, ny] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      ndc.set(nx, ny, 0.5).unproject(camera).sub(camPos);
      const t = ndc.y < -1e-4 ? -camPos.y / ndc.y : 60 / Math.max(1e-3, Math.hypot(ndc.x, ndc.z));
      reach = Math.max(reach, Math.hypot(camPos.x + ndc.x * t - hx, camPos.z + ndc.z * t - hz));
    }
    return Math.min(60, reach + FRONT + 1);
  }

  let t = -1, x0 = 0, z0 = 0, y0 = 0.8, sync = null, reach = 0, synced = false;

  return {
    // sync: () => the world's mood.wave ({active, t, p}) or null; used while it's active
    play(x, z, y = 0.8, syncFn = null) { t = 0; x0 = x; z0 = z; y0 = y; sync = syncFn; reach = 0; synced = false; },
    get active() { return t >= 0; },
    get synced() { return synced; },
    update(dt) {
      if (t < 0) return;
      t += dt;
      let w = null;
      try { w = sync?.() || null; } catch { w = null; }
      let r, kr, width;
      if (w && (w.active || synced) && t < WAVE_T + 0.6) {
        // ride the warm wave's front (its edge blends over FRONT; sit the bright band just inside it)
        if (!synced) { synced = true; reach = frameReach(w.x ?? x0, w.z ?? z0); x0 = w.x ?? x0; z0 = w.z ?? z0; }
        kr = w.active ? clamp(w.t / WAVE_T) : 1;
        const p = w.active ? w.p : 1;
        r = 0.3 + Math.max(0, reach * p - FRONT * 0.35);
        width = 0.5 * (1 - kr * 0.45);
      } else {
        kr = clamp(t / WAVE_T);
        r = 0.3 + (R_MAX - 0.3) * ease.quadOut(kr);
        width = 0.42 * (1 - kr * 0.55);
      }
      ringMat.uniforms.uR.value = r;
      ringMat.uniforms.uW.value = width;
      ringMat.uniforms.uA.value = (t < 0.06 ? t / 0.06 : 1) * (1 - ease.quadIn(kr)) * 0.62;
      const size = (r + 1.6) * 2;
      ring.scale.set(size, size, 1);
      ringMat.uniforms.uHalf.value = size / 2;
      ring.position.set(x0, 0.03, z0);
      ring.visible = kr < 1;
      // rays: bloom out behind the hearth, spin a touch, fade
      const kb = clamp(t / 0.9);
      raysMat.uniforms.uK.value = ease.cubicOut(kb);
      raysMat.uniforms.uA.value = (kb < 0.12 ? ease.quadOut(kb / 0.12) : 1 - ease.cubicIn((kb - 0.12) / 0.88)) * 0.72;
      raysMat.uniforms.uSpin.value = kb * 0.5;
      const s = 2.2 + 2.6 * ease.backOut(kb, 1.4);
      rays.scale.set(s, s, 1);
      rays.position.set(x0, y0, z0);
      rays.quaternion.copy(camera.quaternion);
      rays.visible = kb < 1;
      if (kr >= 1 && kb >= 1) { t = -1; ring.visible = false; rays.visible = false; }
    },
  };
}
