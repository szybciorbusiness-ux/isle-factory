// Everything printed on the floor plates (icons, outlined numerals, name tags) as flat instanced quads lying on
// the ground, sampled from the pad atlas (atlas.js): ONE draw call for every plate's content. Quads are pushed in
// draw order each frame (backs of a number before its fronts), so a number change costs a few attribute writes
// and never a texture upload.
//
// Per-instance: rect = [centre x, centre z, width, depth] (world tiles), uv = [u0, vTop, u1, vBot],
// misc = [y, alpha, dim (0..1 greys + fades a finished cost), 0]. North (-z) is the top of the image.
import * as THREE from 'three';

const vert = /* glsl */`
  attribute vec4 iRect;
  attribute vec4 iUV;
  attribute vec4 iMisc;
  varying vec2 vUv;
  varying vec2 vMisc;
  void main() {
    vec2 q = position.xz + 0.5;                 // 0..1, z down = south
    vUv = vec2(mix(iUV.x, iUV.z, q.x), mix(iUV.y, iUV.w, q.y));
    vMisc = iMisc.yz;
    vec3 p = vec3(iRect.x + position.x * iRect.z, iMisc.x, iRect.y + position.z * iRect.w);
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;
const frag = /* glsl */`
  uniform sampler2D uMap;
  varying vec2 vUv;
  varying vec2 vMisc;
  void main() {
    vec4 t = texture2D(uMap, vUv);              // premultiplied
    float l = dot(t.rgb, vec3(0.3, 0.59, 0.11));
    t.rgb = mix(t.rgb, vec3(l) * 0.95 + t.a * 0.05, vMisc.y * 0.65);
    t *= vMisc.x * (1.0 - vMisc.y * 0.4);
    if (t.a < 0.004) discard;
    gl_FragColor = t;
    #include <colorspace_fragment>
  }
`;

export function createGlyphs({ texture, cap = 384 }) {
  const quad = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute('position', quad.getAttribute('position'));
  const rect = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const uv = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const misc = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iRect', rect);
  geo.setAttribute('iUV', uv);
  geo.setAttribute('iMisc', misc);
  geo.instanceCount = 0;
  const material = new THREE.ShaderMaterial({
    vertexShader: vert, fragmentShader: frag,
    uniforms: { uMap: { value: texture } },
    transparent: true, premultipliedAlpha: true, depthWrite: false, fog: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;       // after the plates (2) and the station ghosts (3-4): numbers stay crisp over a ghost
  mesh.name = 'padGlyphs';

  let n = 0;
  const R = rect.array, U = uv.array, M = misc.array;
  return {
    mesh,
    begin() { n = 0; },
    // cx, cz: quad centre; w, d: size (tiles); q: [u0, vTop, u1, vBot]
    push(cx, cz, w, d, q, y, alpha, dim = 0) {
      if (n >= cap || !(alpha > 0.003) || !q) return;
      const i = n * 4;
      R[i] = cx; R[i + 1] = cz; R[i + 2] = w; R[i + 3] = d;
      U[i] = q[0]; U[i + 1] = q[1]; U[i + 2] = q[2]; U[i + 3] = q[3];
      M[i] = y; M[i + 1] = alpha; M[i + 2] = dim; M[i + 3] = 0;
      n++;
    },
    commit() {
      geo.instanceCount = n;
      mesh.visible = n > 0;
      if (n) {
        rect.addUpdateRange?.(0, n * 4); uv.addUpdateRange?.(0, n * 4); misc.addUpdateRange?.(0, n * 4);
        rect.needsUpdate = true; uv.needsUpdate = true; misc.needsUpdate = true;
      }
    },
    get count() { return n; },
  };
}
