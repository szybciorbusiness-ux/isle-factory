// The hearth level-up moment: a soft shockwave ring rolling out over the ground and a radial burst of warm
// light rays behind the hearth, both signed-distance shaders on single quads (2 draw calls, only while live).
// Driven by play(x, z, y) + update(dt); nothing reads wall-clock time.
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

  let t = -1, x0 = 0, z0 = 0, y0 = 0.8;
  const RING_T = 1.1, RAYS_T = 0.9, R_MAX = 5.2;

  return {
    play(x, z, y = 0.8) { t = 0; x0 = x; z0 = z; y0 = y; },
    get active() { return t >= 0; },
    update(dt) {
      if (t < 0) return;
      t += dt;
      // shockwave: rolls out fast then slows, thinning and fading
      const kr = clamp(t / RING_T);
      const r = 0.3 + (R_MAX - 0.3) * ease.expoOut(kr);
      ringMat.uniforms.uR.value = r;
      ringMat.uniforms.uW.value = 0.42 * (1 - kr * 0.55);
      ringMat.uniforms.uA.value = (t < 0.06 ? t / 0.06 : 1) * (1 - ease.quadIn(kr)) * 0.62;
      const size = (r + 1.6) * 2;
      ring.scale.set(size, size, 1);
      ringMat.uniforms.uHalf.value = size / 2;
      ring.position.set(x0, 0.03, z0);
      ring.visible = kr < 1;
      // rays: bloom out behind the hearth, spin a touch, fade
      const kb = clamp(t / RAYS_T);
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
