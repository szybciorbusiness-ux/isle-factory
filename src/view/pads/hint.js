// "Locked future is hinted, not hidden" (FIRST-20.md): for every bridge that isn't built yet and whose pad isn't
// showing, a very faint dashed plank outline lies on the water where the bridge will go, so the player reads
// "there will be a bridge here". One instanced draw call (a quad per bridge, max 8), signed-distance shader:
// a dashed rounded outline of the deck plus dotted plank seams, breathing slowly. Driven from update(dt).
//
// Per instance: pos = [centre x, centre z, yaw (0 = along x), alpha], size = [half length, half width, plank
// pitch, dash phase].
import * as THREE from 'three';

const vert = /* glsl */`
  attribute vec4 iPos;
  attribute vec4 iSize;
  uniform float uY;
  varying vec2 vP;
  varying vec4 vSize;
  varying float vA;
  void main() {
    vec2 h = iSize.xy + 0.08;
    vP = position.xz * 2.0 * h;               // local: x along the bridge, y across
    vSize = iSize; vA = iPos.w;
    float c = cos(iPos.z), s = sin(iPos.z);
    vec2 w = vec2(vP.x * c - vP.y * s, vP.x * s + vP.y * c);
    gl_Position = projectionMatrix * viewMatrix * vec4(iPos.x + w.x, uY, iPos.y + w.y, 1.0);
  }
`;
const frag = /* glsl */`
  uniform vec3 uCol;
  uniform float uTime;
  varying vec2 vP;
  varying vec4 vSize;
  varying float vA;
  float sdRound(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  }
  void main() {
    vec2 b = vSize.xy;
    float d = sdRound(vP, b, 0.1);
    float aa = max(length(vec2(dFdx(d), dFdy(d))), 1e-4) * 1.2;
    // outline dashes run along both long sides and both ends
    float along = abs(vP.x) > b.x - 0.1 ? vP.y : vP.x;
    float dash = step(0.5, fract(along / 0.2 - vSize.w));
    float rim = (1.0 - smoothstep(0.022 - aa, 0.022 + aa, abs(d + 0.03))) * dash;
    // dotted plank seams across the deck
    float u = (vP.x + b.x) / vSize.z;
    float seam = 1.0 - smoothstep(0.016 - aa, 0.016 + aa, abs(fract(u) - 0.5) * vSize.z);
    float dots = step(0.5, fract(vP.y / 0.13));
    float inner = step(d, -0.09) * step(0.6, u) * step(u, b.x * 2.0 / vSize.z - 0.6);
    float a = max(rim, seam * dots * inner * 0.7);
    float breathe = 0.82 + 0.18 * sin(uTime * 1.6);
    a *= vA * breathe;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uCol * a, a);
    #include <colorspace_fragment>
  }
`;

export function createBridgeHints({ waterY = -0.32, cap = 8 } = {}) {
  const quad = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute('position', quad.getAttribute('position'));
  const pos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const size = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iPos', pos);
  geo.setAttribute('iSize', size);
  geo.instanceCount = 0;
  const material = new THREE.ShaderMaterial({
    vertexShader: vert, fragmentShader: frag,
    uniforms: { uCol: { value: new THREE.Color('#ffffff') }, uTime: { value: 0 }, uY: { value: waterY + 0.03 } },
    transparent: true, premultipliedAlpha: true, depthWrite: false, fog: false,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  mesh.name = 'padBridgeHints';
  let n = 0;
  return {
    mesh,
    begin() { n = 0; },
    push(cx, cz, yaw, alpha, halfLen, halfW, pitch, phase) {
      if (n >= cap || !(alpha > 0.003)) return;
      pos.array.set([cx, cz, yaw, alpha], n * 4);
      size.array.set([halfLen, halfW, pitch, phase], n * 4);
      n++;
    },
    commit(time) {
      geo.instanceCount = n;
      mesh.visible = n > 0;
      material.uniforms.uTime.value = time;
      if (n) { pos.needsUpdate = true; size.needsUpdate = true; }
    },
  };
}
