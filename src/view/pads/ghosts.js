// Ghost previews of what a pad builds: one merged vertex-coloured geometry per pad (one draw call), drawn with
// a soft translucent "blueprint" material. Local frame: origin at the pad centre on the ground, +x east, +z south.
//   build:<station>  a chunky silhouette of the station (fallback only: pads.js uses the camp view's real model)
//   bridge:<id>      the plank path laid over the water where the bridge will go (ground ghost)
//   upgrade:<id>     a star emblem floating over the plate (float ghost, slow rock)
//   hire:<role>      a little villager in the role's colours and hat (float ghost, gentle bob)
//   hearth:1         a ghost flame sitting in the cold hearth pit (atHearth); later levels have no ghost (null)
// Returns { geometry, float, height, spin, atHearth? } or null (height = top of the ghost).
import * as THREE from 'three';
import { Parts, rbox, puck } from '../buildings/geom.js';

const CREAM = '#fffaf0', MINT = '#e4fff3', WOOD = '#ffe2bd', WOOD2 = '#f6cf9f', STONE = '#fff3dc';
const GOLD = '#ffd75e', GOLD2 = '#ffb43c', FLAME = '#ff9a3c', FLAME2 = '#ffd45a';

function starShape(ro, ri, n = 5) {
  const s = new THREE.Shape();
  for (let i = 0; i < n * 2; i++) {
    const a = Math.PI / 2 + (i / (n * 2)) * Math.PI * 2;
    const r = i % 2 ? ri : ro;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) s.moveTo(x, y); else s.lineTo(x, y);
  }
  s.closePath();
  return s;
}
function flameGeometry(h, w) {
  // teardrop lathe: round belly, pointed tip
  const pts = [];
  const n = 14;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const r = w * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.5)), 0.85) * (1 - t * 0.3);
    pts.push(new THREE.Vector2(Math.max(0.0001, r), t * h));
  }
  return new THREE.LatheGeometry(pts, 10);
}

function stationGhost(p, kind, w, d) {
  const W = w - 0.32, D = d - 0.32;
  switch (kind) {
    case 'sawmill': {
      // a little open shed at the back, a work bench with a log, the big round blade standing up in front
      p.add(rbox(W * 0.86, 0.5, D * 0.4, 0.05), WOOD, { p: [0, 0.3, -0.36] });
      const roof = new THREE.CylinderGeometry(0.42, 0.42, W * 0.96, 3, 1);
      p.add(roof, WOOD2, { p: [0, 0.68, -0.36], r: [0, 0, Math.PI / 2], s: [1, 0.7, 1.1], flat: true });
      p.add(rbox(W * 0.8, 0.22, 0.42, 0.05), WOOD2, { p: [0, 0.13, 0.18] });
      p.add(new THREE.CylinderGeometry(0.09, 0.09, W * 0.7, 9), WOOD, { p: [-0.05, 0.32, 0.18], r: [0, 0, Math.PI / 2], flat: true });
      p.add(puck(0.3, 0.035, 0.012, 22), CREAM, { p: [0.32, 0.34, 0.16], r: [Math.PI / 2, 0, 0] });
      break;
    }
    case 'cookfire': {
      p.add(new THREE.TorusGeometry(0.42, 0.1, 6, 14), STONE, { p: [0, 0.1, 0.05], r: [Math.PI / 2, 0, 0], flat: true });
      for (const a of [0.3, -0.5, 1.6]) p.add(rbox(0.6, 0.1, 0.1, 0.04), WOOD2, { p: [0, 0.13, 0.05], r: [0, a, 0.12] });
      for (const s of [-1, 1]) p.add(new THREE.CylinderGeometry(0.035, 0.04, 0.82, 6), WOOD, { p: [s * 0.52, 0.41, 0.05], r: [0, 0, s * 0.12], flat: true });
      p.add(new THREE.CylinderGeometry(0.025, 0.025, 1.1, 6), WOOD, { p: [0, 0.78, 0.05], r: [0, 0, Math.PI / 2], flat: true });
      p.add(new THREE.SphereGeometry(0.2, 10, 8), CREAM, { p: [0, 0.5, 0.05], s: [1, 0.85, 1] });
      break;
    }
    case 'hut': {
      p.add(rbox(W * 0.72, 0.5, D * 0.62, 0.05), WOOD, { p: [0, 0.32, -0.04] });
      const roof = new THREE.CylinderGeometry(0.62, 0.62, W * 0.84, 3, 1);
      p.add(roof, WOOD2, { p: [0, 0.78, -0.04], r: [0, 0, Math.PI / 2], s: [1, 1, 0.82], flat: true });
      p.add(rbox(0.26, 0.34, 0.06, 0.04), CREAM, { p: [0.15, 0.24, D * 0.31] });
      break;
    }
    case 'quarry': {
      p.add(rbox(W * 0.8, 0.2, D * 0.8, 0.05), STONE, { p: [0, 0.14, 0] });
      for (const [x, z, s] of [[-0.3, -0.25, 1], [0.2, -0.3, 0.8], [0.32, 0.18, 0.9]]) {
        p.add(new THREE.DodecahedronGeometry(0.18 * s, 0), CREAM, { p: [x, 0.32 * s, z], flat: true });
      }
      p.add(new THREE.CylinderGeometry(0.035, 0.035, 0.9, 6), WOOD, { p: [-0.42, 0.62, 0.3], flat: true });
      p.add(rbox(0.8, 0.06, 0.06, 0.02), WOOD, { p: [-0.1, 1.04, 0.3], r: [0, 0, -0.2] });
      break;
    }
    case 'copperDrill': {
      p.add(rbox(0.86, 0.3, 0.86, 0.06), STONE, { p: [0, 0.2, 0] });
      p.add(rbox(0.46, 0.72, 0.46, 0.06), WOOD, { p: [0, 0.68, 0] });
      p.add(new THREE.ConeGeometry(0.3, 0.34, 8), CREAM, { p: [0, 1.2, 0], flat: true });
      break;
    }
    case 'smelter': {
      p.add(rbox(0.96, 0.62, 0.86, 0.12), STONE, { p: [-0.05, 0.36, -0.05] });
      p.add(new THREE.CylinderGeometry(0.13, 0.15, 0.6, 10), CREAM, { p: [0.24, 0.92, -0.22] });
      p.add(rbox(0.36, 0.26, 0.06, 0.05), GOLD2, { p: [-0.05, 0.3, 0.39] });
      break;
    }
    default:
      p.add(rbox(W * 0.7, 0.5, D * 0.7, 0.08), CREAM, { p: [0, 0.3, 0] });
  }
}

export function bridgeLayout(tiles, orientation, rng = () => 0.5) {
  // shared by the ghost and the real bridge: planks + posts in the bridge's own frame
  const len = tiles.length;
  const u0 = -0.6, u1 = len - 0.5 + 0.1;
  const pitch = 0.205;
  const count = Math.floor((u1 - u0) / pitch);
  const start = (u0 + u1) / 2 - ((count - 1) * pitch) / 2;
  const planks = [];
  for (let i = 0; i < count; i++) {
    planks.push({
      u: start + i * pitch + (rng() - 0.5) * 0.01,
      dy: (rng() - 0.5) * 0.006,
      v: (rng() - 0.5) * 0.03,
      rot: (rng() - 0.5) * 0.05,
      len: 0.82 + (rng() - 0.5) * 0.08,
      tile: Math.max(0, Math.min(len - 1, Math.round(start + i * pitch))),
      tint: [(rng() - 0.5) * 0.02, (rng() - 0.5) * 0.06, (rng() - 0.5) * 0.07],
    });
  }
  const postU = [-0.38];
  for (let k = 1; k < len; k++) postU.push(k - 0.5);
  postU.push(len - 1 + 0.38);
  return { len, u0, u1, planks, postU };
}

// frame of a bridge: origin at tiles[0], u along `dir` (away from the shore), v across
export function bridgeFrame(tiles, orientation, shore) {
  const [x0, z0] = tiles[0];
  let dx, dz;
  if (tiles.length > 1) { dx = Math.sign(tiles[1][0] - x0); dz = Math.sign(tiles[1][1] - z0); }
  else if (shore) { dx = Math.sign(x0 - shore.x); dz = Math.sign(z0 - shore.z); }
  else { dx = orientation === 1 ? 1 : 0; dz = orientation === 1 ? 0 : 1; }
  if (!dx && !dz) { dx = orientation === 1 ? 1 : 0; dz = orientation === 1 ? 0 : 1; }
  const px = dz ? 1 : 0, pz = dx ? 1 : 0; // across (always +x or +z so v=+ is consistent)
  return {
    x0, z0, dx, dz, px, pz,
    yaw: Math.atan2(-dz, dx),
    toWorld(u, v, out) { out.x = x0 + dx * u + px * v; out.z = z0 + dz * u + pz * v; return out; },
  };
}

function bridgeGhost(p, bridge, center) {
  if (!bridge) return;
  const layout = bridgeLayout(bridge.tiles, bridge.orientation, () => 0.5);
  const fr = bridgeFrame(bridge.tiles, bridge.orientation, center);
  const w = { x: 0, z: 0 };
  layout.planks.forEach((pl, i) => {
    if (i % 2) return; // every other plank: a dotted path, light enough to read as "coming"
    fr.toWorld(pl.u, 0, w);
    p.add(rbox(0.15, 0.04, 0.8, 0.015), i % 4 ? WOOD : WOOD2, { p: [w.x - center.x, -0.04, w.z - center.z], r: [0, fr.yaw, 0], ao: false });
  });
  // two little posts at the far end so the target shore reads
  const end = layout.postU[layout.postU.length - 1];
  for (const v of [-0.47, 0.47]) {
    fr.toWorld(end, v, w);
    p.add(new THREE.CylinderGeometry(0.045, 0.05, 0.26, 7), WOOD2, { p: [w.x - center.x, 0.02, w.z - center.z], flat: true, ao: false });
  }
}

function villagerGhost(p, role) {
  // the worker you're hiring, in its own colours (the creatures view's villagers: overalls + role hat)
  const hunter = role === 'hunter';
  p.add(new THREE.CapsuleGeometry(0.14, 0.16, 4, 10), hunter ? '#9aa86a' : '#6fa3d8', { p: [0, 0.26, 0] });
  p.add(new THREE.SphereGeometry(0.13, 12, 10), '#ffd9b4', { p: [0, 0.54, 0] });
  if (hunter) {
    p.add(new THREE.ConeGeometry(0.16, 0.17, 10), '#b9773f', { p: [0, 0.69, 0], flat: true });
    p.add(puck(0.2, 0.02, 0.01, 12), '#b9773f', { p: [0, 0.62, 0] });
    p.add(rbox(0.04, 0.17, 0.02, 0.01), '#ff6b5e', { p: [0.09, 0.77, 0], r: [0, 0, -0.5] });
    // a little club
    p.add(new THREE.CylinderGeometry(0.02, 0.045, 0.32, 7), '#c98a52', { p: [0.19, 0.38, 0], r: [0, 0, 0.45], flat: true });
  } else {
    p.add(new THREE.SphereGeometry(0.138, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), '#e2513b', { p: [0, 0.6, 0] });
    p.add(new THREE.SphereGeometry(0.045, 8, 6), '#fff4e2', { p: [0, 0.75, 0] });
    // a little axe on the shoulder
    p.add(new THREE.CylinderGeometry(0.018, 0.018, 0.34, 6), '#c98a52', { p: [0.17, 0.4, 0], r: [0, 0, 0.5], flat: true });
    p.add(rbox(0.1, 0.07, 0.03, 0.01), '#dfe6ea', { p: [0.24, 0.54, 0], r: [0, 0, 0.5] });
  }
}

function starGhost(p) {
  const g = new THREE.ExtrudeGeometry(starShape(0.34, 0.16), { depth: 0.07, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.025, bevelSegments: 2, curveSegments: 4 });
  g.translate(0, 0, -0.035);
  p.add(g, GOLD, { p: [0, 0.62, 0], flat: true, ao: false, faceColor: (cx, cy, cz, nx, ny, nz) => (Math.abs(nz) > 0.9 ? null : GOLD2) });
  // a small up-chevron under the star: "upgrade"
  const ch = new THREE.Shape();
  ch.moveTo(-0.16, 0); ch.lineTo(0, 0.12); ch.lineTo(0.16, 0); ch.lineTo(0.16, -0.06); ch.lineTo(0, 0.06); ch.lineTo(-0.16, -0.06); ch.closePath();
  const cg = new THREE.ExtrudeGeometry(ch, { depth: 0.05, bevelEnabled: false });
  cg.translate(0, 0, -0.025);
  p.add(cg, CREAM, { p: [0, 0.22, 0], flat: true, ao: false });
}

function flameGhost(p) {
  // a classic three-tongue flame over two crossed logs
  for (const a of [0.5, -0.6]) p.add(rbox(0.5, 0.08, 0.09, 0.035), WOOD2, { p: [0, 0.05, 0], r: [0, a, 0] });
  p.add(flameGeometry(0.82, 0.22), FLAME, { p: [0, 0.06, 0] });
  for (const s of [-1, 1]) p.add(flameGeometry(0.48, 0.13), FLAME, { p: [s * 0.15, 0.06, 0.02], r: [0, 0, -s * 0.38] });
  p.add(flameGeometry(0.46, 0.12), FLAME2, { p: [0, 0.07, 0.1] });
}

export function buildGhost(pad, { map, stations }) {
  const [kind, argRaw] = pad.id.split(':');
  const arg = argRaw?.split('#')[0];
  const [, , w, d] = pad.zone;
  const center = { x: pad.zone[0] + (w - 1) / 2, z: pad.zone[1] + (d - 1) / 2 };
  const p = new Parts({ ao: { y0: 0, y1: 0.5, min: 0.86 } });
  let float = false, height = 0.6, spin = 0;
  if (kind === 'build') {
    const fp = stations?.[arg]?.footprint || pad.zone;
    stationGhost(p, arg, fp[2], fp[3]);
    height = { sawmill: 0.85, cookfire: 0.85, hut: 1.15, quarry: 1.1, copperDrill: 1.4, smelter: 1.25 }[arg] ?? 0.9;
  } else if (kind === 'bridge') {
    bridgeGhost(p, map?.bridges?.[arg], center);
    height = 0.35;
  } else if (kind === 'upgrade') {
    starGhost(p); float = true; height = 1.1; spin = 0.8;
  } else if (kind === 'hire') {
    villagerGhost(p, arg); float = true; height = 0.85;
  } else if (kind === 'hearth') {
    // the first level lights the cold hearth: a ghost flame flickers in the pit itself. Later levels already
    // burn there, so the plate alone carries them.
    if (Number(arg) > 1) return null;
    flameGhost(p); height = 0.85;
    return { geometry: p.merge(), float: false, height, spin, kind, arg, center, atHearth: true };
  } else {
    p.add(rbox(0.5, 0.5, 0.5, 0.08), CREAM, { p: [0, 0.25, 0] });
  }
  return { geometry: p.merge(), float, height, spin, kind, arg, center };
}

// The translucent blueprint material (one per ghost so each can fade on its own): soft top light, a bright
// fresnel rim so the silhouette reads over the grass, and a faint shimmer of lines drifting upward as if the
// thing were still materialising. Pair it with ghostDepth() on a child mesh so only the front surface shows.
const ghostVert = /* glsl */`
  varying vec3 vCol;
  varying vec3 vN;
  varying vec3 vV;
  varying float vY;
  void main() {
    vCol = color;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vN = normalize(mat3(modelMatrix) * normal);
    vV = cameraPosition - wp.xyz;
    vY = wp.y;
    // same op order as three's project_vertex, so the depth twin's values match exactly (no z-fighting)
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
  }
`;
const ghostFrag = /* glsl */`
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uTime;
  uniform vec3 uRim;
  uniform float uTint;
  varying vec3 vCol;
  varying vec3 vN;
  varying vec3 vV;
  varying float vY;
  void main() {
    vec3 n = normalize(vN);
    if (!gl_FrontFacing) n = -n;
    float ndv = abs(dot(n, normalize(vV)));
    float fres = pow(1.0 - ndv, 2.2);
    float lit = 0.66 + 0.46 * max(dot(n, normalize(vec3(-0.35, 1.0, 0.45))), 0.0);
    // a cool, airy tint keeps the blueprint apart from the warm grass and the real (solid) buildings
    vec3 c = mix(vCol, vec3(0.80, 0.94, 1.0), uTint) * lit;
    c = mix(c, uRim, clamp(fres * 0.7 * (0.4 + uTint * 1.9) + uGlow * 0.15, 0.0, 1.0));
    float scan = smoothstep(0.75, 1.0, sin(vY * 34.0 - uTime * 4.0)) * 0.08;
    float a = (0.5 + fres * 0.5 + scan + uGlow * 0.12) * uOpacity;
    gl_FragColor = vec4(c + scan * 0.5 + uGlow * 0.06, clamp(a, 0.0, 1.0));
    #include <colorspace_fragment>
  }
`;
export function ghostMaterial() {
  const m = new THREE.ShaderMaterial({
    vertexShader: ghostVert, fragmentShader: ghostFrag, vertexColors: true,
    transparent: true, depthWrite: false, fog: false,
    uniforms: { uOpacity: { value: 0 }, uGlow: { value: 0 }, uTime: { value: 0 }, uRim: { value: new THREE.Color('#ffffff') }, uTint: { value: 0.32 } },
  });
  return m;
}
// Depth-only twin (shared): renders just before the ghost so overlapping inner faces don't stack up.
let depthMat = null;
export function ghostDepth() {
  if (!depthMat) depthMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, transparent: true });
  return depthMat;
}
