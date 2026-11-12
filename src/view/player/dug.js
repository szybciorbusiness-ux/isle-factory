// Dug, the player character (CHARACTER.md): a stocky plum mole miner with an orange helmet and headlamp, cream
// overalls, a copper canister backpack with a hose up to the helmet, and two shovel-blade gloves that are his
// tools. Geometry only; player.js animates it. buildDug(P) returns the same rig fields as model.js's buildRobot,
// so player.js can swap one for the other.
//
// Rig (front = local +x, right = local +z, origin = on the ground under the body centre):
//   root ─ shadow, legL/legR (stretchy plum stubs, hip -> foot), footL/footR (planted by player.js), glow sprites
//        └ tilt (lean / bank, pivot on the ground) └ hop (bounce) └ squash (scale, pivot at the ground)
//            ├ hipL, hipR (markers the legs attach to)
//            └ upper (rotation.y = upper-body twist)
//                ├ body (plum pear, nose, buckles), overalls (cream cloth: trousers, bib, straps, muzzle),
//                │      face decal (eyes, brows, whiskers)
//                ├ helmet (dome, brim, ridges, hose socket) ─ lampMount ─ antenna (bracket, springy) ─ antJoint
//                │      (lamp head, springy) ─ bulb (lens centre; the glow sprite follows it)
//                ├ pack (pivot at the canister's top centre) ─ packMesh (canister + hose + valve), pipeTip (valve)
//                └ armL, armR (shoulder pivots; rotation.z swings forward) ─ arm tilt ─ hand ─ shovel glove, tool
//
// Mapping onto the robot's rig: the headlamp is the antenna bulb (the antenna springs drive a small, damped
// wobble of the lamp on its bracket), the visor glow is an extra lamp flare when he faces the camera, the screen,
// bezel, band and gauge are harmless stand-ins, and the axe / pickaxe / club are empty: the shovels do the work.
//
// Read from the 58° game camera: the head is tipped back (HEAD_TIP) with a short-brimmed helmet sitting back on
// the crown, the face bulges forward, and the eyes, brows, muzzle and nose are oversized, so his stern face shows
// in every walking direction instead of a hat. The overalls use their own cloth material (a full warm fill and a
// soft light floor) so they stay cream under the green bounce light.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createDugFace } from './dug-face.js';

// ---------- proportions (model units; player.js scales the root by ~1.3) ----------
export const FOOT_Z = 0.1;        // feet rest this far to each side
export const LEG_R = 0.036;
export const HIP = new THREE.Vector3(0.0, 0.096, 0.09); // right hip (z mirrored for the left)
export const SHOULDER_Y = 0.355;
export const ARM_LEN = 0.085;     // shoulder -> wrist (top of the shovel glove)
export const ARM_SPLAY = 0.1;     // the arms hang this far out (rad), after undoing player.js's inward arm tilt
export const ARM_FWD = 0.2;       // ... and this far forward of player.js's pose: the shovels rest in front of the thighs
const PLAYER_ARM_TILT = 0.36;     // player.js sets armR.rotation.x = +0.36, armL = -0.36 (cancelled, see the arms)
const BLADE_YAW = 0.65;           // shovel faces point this far (rad) outward from straight ahead
// The helmet in the untipped head frame (the head tip below turns it back with the head). It sits a little back
// and high on the crown with a short brim, so from the high game camera the stern face shows in front of it.
export const HELMET = { x: -0.04, y: 0.516, tilt: 0.08, rx: 0.158, ry: 0.16, rz: 0.168, brim: 0.182, frontTrim: 0.14 };
const HEAD_FWD = 0.04;            // the face bulges forward of the belly (eyes out in front of the brim edge)
// Head tip: everything above the shoulders turns back about a pivot in the "neck", so the face looks up toward
// the 58° game camera and the helmet leans back off the brows. Smooth weight by height: the belly, straps and
// shoulders stay put, the head turns rigidly.
export const HEAD_TIP = 0.27;     // rad (~15°)
const TIP_PIVOT = { x: -0.03, y: 0.37 };
const TIP_Y0 = 0.36, TIP_Y1 = 0.46;
export const PACK_PIVOT = new THREE.Vector3(-0.252, 0.424, 0);         // canister top centre (hose base)
export const PIPE_TIP = new THREE.Vector3(-0.014, 0.052, -0.07);      // valve on the canister top, in pack space
export const PACK_TOP = new THREE.Vector3(-0.012, 0.012, 0);          // lid top centre, in pack space (stack.js sets the column BACK behind it, clear of the hose)
export const HEIGHT = 0.72;       // lamp top above the ground

export const COLORS = {
  fur: '#5d2829', furLight: '#7b3a39', furDark: '#43191b', sole: '#3b1517',
  muzzle: '#f4dcb2', nose: '#f2705f',
  helmet: '#fb8b2e', helmetLip: '#c35f1c', lampHousing: '#8e5433', lampRim: '#5c3322', lens: '#ffd34d', lensCore: '#fff3c4',
  overalls: '#ffebc2', overallsShade: '#ebcf9c', buckle: '#f08a3a', buckleDark: '#bd5a1c',
  blade: '#cdb39d', bladeDark: '#ad9785', bladeWorn: '#f4e5c6', cuff: '#a2867a',
  copper: '#d2663b', copperBand: '#9c472a', copperLight: '#ea8c55',
};

// ---------- the pear (fur body + head) ----------
// Lathe profile [r, y]: wide low belly, sloping shoulders, the head flowing up into the helmet with no neck.
const PROFILE = [[0.0005, 0.05], [0.09, 0.053], [0.148, 0.072], [0.176, 0.105], [0.187, 0.155], [0.188, 0.21],
  [0.182, 0.265], [0.172, 0.32], [0.161, 0.375], [0.151, 0.43], [0.143, 0.48], [0.131, 0.53], [0.106, 0.575],
  [0.066, 0.606], [0.0005, 0.62]];
const profileCurve = new THREE.CatmullRomCurve3(PROFILE.map(([r, y]) => new THREE.Vector3(r, y, 0)), false, 'centripetal');
const TABLE = profileCurve.getPoints(300).map(p => [Math.max(0, p.x), p.y]).sort((a, b) => a[1] - b[1]);
export function bodyRadiusAt(y) {
  if (y <= TABLE[0][1]) return TABLE[0][0];
  for (let i = 1; i < TABLE.length; i++) {
    const [r1, y1] = TABLE[i];
    if (y <= y1) { const [r0, y0] = TABLE[i - 1]; return r0 + (r1 - r0) * ((y - y0) / Math.max(1e-6, y1 - y0)); }
  }
  return 0;
}
const smooth01 = (a, b, v) => { const t = THREE.MathUtils.clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
// forward lean of the face, easing back above the eyes so the crown stays centred inside the helmet
const headShift = y => HEAD_FWD * smooth01(0.33, 0.46, y) * (1 - 0.85 * smooth01(0.49, 0.56, y));
// Point on the body: a = angle from +x toward +z (deg), y above the ground, pushed out by off.
export function surface(aDeg, y, off = 0, out = new THREE.Vector3()) {
  const a = THREE.MathUtils.degToRad(aDeg), r = bodyRadiusAt(y) + off;
  return out.set(Math.cos(a) * r + headShift(y), y, Math.sin(a) * r);
}
export function surfaceNormal(aDeg, y, out = new THREE.Vector3()) {
  const a = THREE.MathUtils.degToRad(aDeg);
  const slope = (bodyRadiusAt(y + 0.005) - bodyRadiusAt(y - 0.005)) / 0.01;
  return out.set(Math.cos(a), -slope, Math.sin(a)).normalize();
}

// ---------- geometry helpers (as in model.js) ----------
const _c = new THREE.Color();
function paint(geo, color, shade = null) {
  for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal') geo.deleteAttribute(k);
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const pos = geo.attributes.position, n = pos.count;
  const arr = new Float32Array(n * 3);
  _c.set(color);
  for (let i = 0; i < n; i++) {
    const f = shade ? shade(pos.getX(i), pos.getY(i), pos.getZ(i)) : 1;
    arr[i * 3] = _c.r * f; arr[i * 3 + 1] = _c.g * f; arr[i * 3 + 2] = _c.b * f;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  geo.clearGroups();
  return geo;
}
function merge(parts) {
  const anyFlat = parts.some(g => !g.index);
  return mergeGeometries(anyFlat ? parts.map(g => (g.index ? g.toNonIndexed() : g)) : parts, false);
}
const M = new THREE.Matrix4();
const place = (geo, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1 } = {}) =>
  geo.applyMatrix4(M.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz)));
// Geometry built along +y, moved so its +y axis points along the body normal at (a, y), base on the surface.
function onSurface(geo, aDeg, y, off = 0) {
  const n = surfaceNormal(aDeg, y), p = surface(aDeg, y, off);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
  return geo.applyMatrix4(new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1)));
}
// Flip a geometry's winding if its first vertex normal points into the body (for hand-built patches).
function faceOutward(geo) {
  geo.computeVertexNormals();
  const p = geo.attributes.position, n = geo.attributes.normal;
  if (p.getX(0) * n.getX(0) + p.getZ(0) * n.getZ(0) < 0) {
    const idx = geo.index.array;
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    geo.index.needsUpdate = true;
    geo.computeVertexNormals();
  }
  return geo;
}
// Move every vertex forward by headShift(y) (the body lathe is round; the head leans out over the belly).
function shiftHead(geo) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setX(i, p.getX(i) + headShift(p.getY(i)));
  return geo;
}
// The head tip (see HEAD_TIP): the angle for a point at (untipped) height y, and the tip applied to a point,
// or to a whole geometry (positions and normals turn by the same angle about +z, the lateral axis).
export const tipAngle = y => HEAD_TIP * smooth01(TIP_Y0, TIP_Y1, y);
export function tipPoint(v) {
  const a = tipAngle(v.y), c = Math.cos(a), s = Math.sin(a);
  const dx = v.x - TIP_PIVOT.x, dy = v.y - TIP_PIVOT.y;
  v.x = TIP_PIVOT.x + dx * c - dy * s; v.y = TIP_PIVOT.y + dx * s + dy * c;
  return v;
}
function tipHead(geo) {
  const p = geo.attributes.position, n = geo.attributes.normal;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.set(p.getX(i), p.getY(i), p.getZ(i));
    const a = tipAngle(v.y);
    if (a <= 1e-6) continue;
    const c = Math.cos(a), s = Math.sin(a);
    tipPoint(v);
    p.setXYZ(i, v.x, v.y, v.z);
    if (n) { const nx = n.getX(i), ny = n.getY(i); n.setXY(i, nx * c - ny * s, nx * s + ny * c); }
  }
  p.needsUpdate = true;
  if (n) n.needsUpdate = true;
  return geo;
}

// A rounded-rectangle patch lying on the body (superellipse corners), centred at angle a0, height yc.
// UVs run left-to-right as seen by someone facing that spot, so a texture reads correctly.
function surfacePatch({ a0 = 0, yc, halfA, halfH, off, p = 4, nu = 16, nv = 6 }) {
  const pos = [], uv = [], idx = [];
  const v3 = new THREE.Vector3();
  for (let j = 0; j <= nv; j++) {
    const v = -1 + (2 * j) / nv;
    // (|v| eased in a touch so the top and bottom rows keep their width: rounded corners, not a diamond)
    const w = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(v) * 0.97, p)), 1 / p);
    for (let i = 0; i <= nu; i++) {
      const u = -1 + (2 * i) / nu;
      surface(a0 + u * w * halfA, yc + v * halfH, off, v3);
      pos.push(v3.x, v3.y, v3.z);
      uv.push(0.5 - 0.5 * u * w, 0.5 + 0.5 * v);
    }
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return faceOutward(g);
}
// A flat ribbon (overall strap) following a path of [angleDeg, y] points over the body surface.
function ribbon(path, width, off, segs = 18) {
  const curve = new THREE.CatmullRomCurve3(path.map(([a, y]) => new THREE.Vector3(a, y, 0)));
  const pos = [], idx = [];
  const P = new THREE.Vector3(), A = new THREE.Vector3(), B = new THREE.Vector3(), N = new THREE.Vector3(), T = new THREE.Vector3(), S = new THREE.Vector3();
  const at = (t, out) => { const c = curve.getPoint(THREE.MathUtils.clamp(t, 0, 1)); return surface(c.x, c.y, off, out); };
  for (let i = 0; i <= segs; i++) {
    const t = i / segs, c = curve.getPoint(t);
    at(t, P); at(t - 0.01, A); at(t + 0.01, B);
    surfaceNormal(c.x, c.y, N);
    T.subVectors(B, A).normalize();
    S.crossVectors(N, T).normalize().multiplyScalar(width / 2);
    pos.push(P.x + S.x, P.y + S.y, P.z + S.z, P.x - S.x, P.y - S.y, P.z - S.z);
  }
  for (let i = 0; i < segs; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return faceOutward(g);
}

function radialTexture(stops, size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const h = size / 2;
  const grd = g.createRadialGradient(h, h, 1, h, h, h - 1);
  for (const [o, col] of stops) grd.addColorStop(o, col);
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Toon Lambert (or a soft Phong for the helmet and copper) under the scene's own lights, plus two character
// touches: a warm rim (as the robot's ceramic has) so the dark plum separates from the grass, and a warm fill
// that half-neutralises the green hemisphere bounce, so cream overalls stay cream on the shaded sides.
// warm: how much of the (green) hemisphere fill is replaced by its warm-neutral luminance; lift: extra fill
// irradiance (a soft floor, so a pale cloth keeps its value on the shaded sides instead of going khaki).
const WARM_FILL = 0.6;
function toonMaterial({ phong = false, rim = '#ffe2c4', rimStrength = 0.24, rimPower = 2.6, shininess = 30, specular = '#3c3024',
  warm = WARM_FILL, warmTint = [1.07, 0.99, 0.9], lift = 0, ...extra } = {}) {
  const opts = { vertexColors: !extra.map, ...extra };
  const m = phong ? new THREE.MeshPhongMaterial({ ...opts, shininess, specular: new THREE.Color(specular) }) : new THREE.MeshLambertMaterial(opts);
  const uRim = { value: new THREE.Color(rim).multiplyScalar(rimStrength) };
  const f = v => Number(v).toFixed(3);
  m.onBeforeCompile = sh => {
    sh.uniforms.uRim = uRim;
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', 'uniform vec3 uRim;\nvoid main() {')
      .replace('#include <lights_fragment_end>', // (irradiance is still light only here: the albedo comes after)
        `{ float l = dot(irradiance, vec3(0.299, 0.587, 0.114));
           irradiance = mix(irradiance, l * vec3(${warmTint.map(f).join(', ')}), ${f(warm)}) + vec3(${f(lift)}); }
         #include <lights_fragment_end>`)
      .replace('#include <opaque_fragment>',
        `{ float fres = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), ${rimPower.toFixed(2)});
           outgoingLight += uRim * fres * (0.55 + 0.45 * normal.y); }
         #include <opaque_fragment>`);
  };
  m.customProgramCacheKey = () => `dug-toon-${phong ? 'p' : 'l'}-${rimPower}-${rimStrength}-${f(warm)}-${warmTint.map(f).join('/')}-${f(lift)}`;
  return m;
}

// A hinge whose rotation, as written by player.js, is applied scaled down (the antenna springs swing a long
// stalk; on a helmet lamp the same numbers would read as a broken bracket). No allocation per frame.
function softHinge(obj, k) {
  const e = new THREE.Euler();
  obj.rotation._onChange(() => {
    const r = obj.rotation;
    e.set(r.x * k, r.y * k, r.z * k, r.order);
    obj.quaternion.setFromEuler(e, false);
  });
}

// ---------- parts ----------
const furShade = (x, y) => 0.8 + 0.3 * smooth01(0.05, 0.6, y);
const creamShade = (x, y) => 0.88 + 0.14 * smooth01(0.05, 0.34, y);

function bodyGeometry() {
  const C = COLORS;
  const fur = paint(shiftHead(new THREE.LatheGeometry(profileCurve.getSpacedPoints(18).map(p => new THREE.Vector2(Math.max(5e-4, p.x), p.y)), 22)), C.fur, furShade);
  // overalls: trousers (a shell over the lower pear) + a bib on the chest + a back panel, straps with buckles
  const WAIST = 0.252;
  const trouserPts = [];
  for (let i = 0; i <= 6; i++) { const y = 0.05 + ((WAIST - 0.05) * i) / 6; trouserPts.push(new THREE.Vector2(bodyRadiusAt(y) + 0.006 * Math.min(1, i / 2) + 5e-4, y)); }
  const trousers = paint(new THREE.LatheGeometry(trouserPts, 22), C.overalls, creamShade);
  const waistSeam = paint(new THREE.LatheGeometry([0.246, 0.252, 0.258].map((y, i) => new THREE.Vector2(bodyRadiusAt(y) + (i === 1 ? 0.011 : 0.006), y)), 24), C.overallsShade);
  const bib = paint(surfacePatch({ yc: 0.29, halfA: 41, halfH: 0.046, off: 0.008, p: 6, nu: 12, nv: 4 }), C.overalls, creamShade);
  const bibSeam = paint(surfacePatch({ yc: 0.333, halfA: 39, halfH: 0.004, off: 0.0095, p: 8, nu: 10, nv: 1 }), C.overallsShade);
  const back = paint(surfacePatch({ a0: 180, yc: 0.28, halfA: 46, halfH: 0.034, off: 0.008, p: 6, nu: 10, nv: 3 }), C.overalls, creamShade);
  const pocket = paint(surfacePatch({ yc: 0.185, halfA: 22, halfH: 0.038, off: 0.011, p: 7, nu: 6, nv: 3 }), C.overallsShade);
  const pocketTop = paint(surfacePatch({ yc: 0.216, halfA: 21, halfH: 0.004, off: 0.0125, p: 8, nu: 6, nv: 1 }), '#c4a676');
  const sidePockets = [];
  for (const s of [-1, 1]) sidePockets.push(paint(surfacePatch({ a0: 62 * s, yc: 0.17, halfA: 12, halfH: 0.03, off: 0.009, p: 6, nu: 4, nv: 2 }), C.overallsShade));
  // trouser legs: short cream cuffs the plum legs come out of
  const cuffs = [];
  for (const s of [-1, 1]) {
    cuffs.push(paint(place(new THREE.CylinderGeometry(0.064, 0.068, 0.064, 12), { y: 0.094, z: s * 0.09 }), C.overalls, creamShade));
    cuffs.push(paint(place(new THREE.TorusGeometry(0.066, 0.008, 4, 12), { y: 0.064, z: s * 0.09, rx: Math.PI / 2 }), C.overallsShade));
  }
  // straps: from the bib's top corners up over the shoulders and down the back to the back panel
  const straps = [], buckles = [];
  for (const s of [-1, 1]) {
    const path = [[30, 0.318], [42, 0.37], [58, 0.418], [84, 0.443], [112, 0.425], [134, 0.375], [148, 0.32], [154, 0.29]].map(([a, y]) => [a * s, y]);
    straps.push(paint(ribbon(path, 0.044, 0.0115, 18), C.overalls, (x, y) => 0.93 + 0.1 * smooth01(0.3, 0.44, y)));
    // square orange buckle where the strap meets the bib (a frame with a darker centre)
    buckles.push(paint(onSurface(place(new THREE.BoxGeometry(0.058, 0.016, 0.054), { y: 0.008 }), 31 * s, 0.318, 0.006), C.buckle, (x, y) => 0.95 + (y - 0.3)));
    buckles.push(paint(onSurface(place(new THREE.BoxGeometry(0.03, 0.008, 0.027), { y: 0.016 }), 31 * s, 0.318, 0.006), C.buckleDark));
  }
  // snout: a long tapered cream muzzle pointing forward and a touch up (the head tip lifts it a little more),
  // ending in a big round coral nose. Chunky enough to read from the game camera in every walking direction.
  const SN = { y: 0.395, tilt: 0.02, len: 0.135, r: 1.22 };
  const snoutPts = [[0.0005, 0], [0.06, 0.0], [0.067, 0.026], [0.063, 0.058], [0.052, 0.09], [0.038, 0.116], [0.024, 0.133], [0.0005, 0.14]]
    .map(([r, t]) => new THREE.Vector2(r * SN.r, (t * SN.len) / 0.14));
  const baseX = bodyRadiusAt(SN.y) + headShift(SN.y) - 0.034;
  const snout = paint(place(new THREE.LatheGeometry(snoutPts, 14), { x: baseX, y: SN.y, rz: -(Math.PI / 2 - SN.tilt) }), C.muzzle, (x, y) => 0.9 + 1.3 * (y - SN.y + 0.03));
  const tip = new THREE.Vector3(Math.cos(SN.tilt) * SN.len, Math.sin(SN.tilt) * SN.len, 0).add(new THREE.Vector3(baseX, SN.y, 0));
  const nose = paint(place(new THREE.SphereGeometry(0.047, 12, 8), { x: tip.x - 0.006, y: tip.y + 0.004, sx: 0.88, sy: 0.92 }), C.nose, (x, y) => 0.92 + 2.6 * (y - tip.y + 0.02));
  // a soft highlight on the top of the nose (it faces the high camera)
  const noseHi = paint(place(new THREE.SphereGeometry(0.013, 6, 4), { x: tip.x + 0.006, y: tip.y + 0.04, z: -0.012, sx: 1, sy: 0.55 }), '#ffc0b0');
  return {
    fur: tipHead(merge([fur, ...buckles, nose, noseHi])),
    // (the muzzle is cream too: in the cloth material it stays cream instead of going grey in its own shade)
    cream: tipHead(merge([trousers, waistSeam, bib, bibSeam, back, pocket, pocketTop, ...sidePockets, ...cuffs, ...straps, snout])),
  };
}

// Shrink a helmet-frame geometry's radius toward the front (the brim is shorter over the face, so the stern
// eyes still show from the high game camera).
function trimFront(geo, amt) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i), r = Math.hypot(x, z) || 1;
    const k = 1 - amt * Math.pow(Math.max(0, x / r), 1.5);
    p.setX(i, x * k); p.setZ(i, z * k);
  }
  geo.computeVertexNormals();
  return geo;
}

// Helmet in its own frame: origin at the brim centre, +x forward (the group is tilted back by HELMET.tilt).
function helmetGeometry() {
  const C = COLORS, H = HELMET;
  const dome = paint(place(new THREE.SphereGeometry(1, 20, 7, 0, Math.PI * 2, 0, Math.PI / 2), { sx: H.rx, sy: H.ry, sz: H.rz }), C.helmet,
    (x, y) => 0.86 + 0.24 * (y / H.ry));
  // ridges: a centre crest front-to-back, and panel seams running from the brim up to the crown (hard-hat style)
  const ridges = [];
  const crest = new THREE.TorusGeometry(1, 0.055, 3, 14, Math.PI);
  ridges.push(paint(place(crest, { sx: H.rx * 1.004, sy: H.ry * 1.004, sz: H.rz * 1.004 }), C.helmet, (x, y) => 0.95 + 0.2 * (y / H.ry)));
  for (const yaw of [0.85, -0.85, Math.PI - 0.85, 0.85 - Math.PI]) {
    const t = new THREE.TorusGeometry(1, 0.04, 3, 7, Math.PI / 2 - 0.12); // a quarter meridian, brim -> crown
    t.rotateY(-yaw);
    ridges.push(paint(place(t, { sx: H.rx * 1.004, sy: H.ry * 1.004, sz: H.rz * 1.004 }), C.helmet, (x, y) => 0.92 + 0.2 * (y / H.ry)));
  }
  // brim: a flat ring with a rounded, slightly drooping lip, darker underneath
  const R = H.brim;
  const brimPts = [[0.12, 0.014], [R - 0.016, 0.004], [R - 0.002, -0.004], [R + 0.003, -0.013], [R - 0.004, -0.022], [R - 0.016, -0.024], [0.12, -0.01]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  const brim = paint(trimFront(place(new THREE.LatheGeometry(brimPts, 26), { sz: H.rz / H.rx }), H.frontTrim), C.helmet, (x, y) => (y < -0.009 ? 0.72 : 0.92 + 3 * y));
  const lip = paint(trimFront(place(new THREE.TorusGeometry(R, 0.0075, 3, 26), { y: -0.013, rx: Math.PI / 2, sy: H.rz / H.rx }), H.frontTrim), C.helmetLip);
  // hose socket on the back of the dome (the hose from the canister plugs in here)
  const sock = helmetSurface(Math.PI, SOCKET_ELEV);
  const socket = paint(placeAlong(new THREE.CylinderGeometry(0.025, 0.028, 0.03, 10), sock.p, sock.n, 0.01), C.copperBand);
  const socketRing = paint(placeAlong(new THREE.CylinderGeometry(0.03, 0.03, 0.01, 10), sock.p, sock.n, 0.022), C.copperLight);
  return merge([dome, ...ridges, brim, lip, socket, socketRing]);
}
// The hose socket on the back of the dome (elevation in the helmet frame: high enough that the tipped-back
// helmet still shows it above the brim, where the hose from the canister plugs in).
const SOCKET_ELEV = 0.72;
// Point + outward normal on the helmet dome: yaw around +y (0 = front), elevation 0..pi/2.
function helmetSurface(yaw, elev) {
  const H = HELMET;
  const d = new THREE.Vector3(Math.cos(elev) * Math.cos(yaw), Math.sin(elev), Math.cos(elev) * Math.sin(yaw));
  const p = new THREE.Vector3(d.x * H.rx, d.y * H.ry, d.z * H.rz);
  const n = new THREE.Vector3(d.x / H.rx, d.y / H.ry, d.z / H.rz).normalize();
  return { p, n };
}
// Geometry built along +y, placed with its +y along n, centred at p + n * off.
function placeAlong(geo, p, n, off = 0) {
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
  return geo.applyMatrix4(new THREE.Matrix4().compose(p.clone().addScaledVector(n, off), q, new THREE.Vector3(1, 1, 1)));
}

// Lamp head in helmet-aligned axes (+x forward): copper housing, dark rim, the lens is separate (glowing).
const LAMP_R = 0.05;
function lampGeometry() {
  const C = COLORS;
  return merge([
    paint(place(new THREE.CylinderGeometry(LAMP_R - 0.004, LAMP_R, 0.062, 14, 1, true), { x: -0.006, rz: -Math.PI / 2 }), C.lampHousing, (x, y) => 0.85 + 3 * y),
    paint(place(new THREE.CylinderGeometry(0.03, LAMP_R - 0.004, 0.016, 12), { x: -0.044, rz: -Math.PI / 2 }), C.lampRim),
    paint(place(new THREE.TorusGeometry(LAMP_R - 0.008, 0.011, 5, 16), { x: 0.025, ry: Math.PI / 2 }), C.lampRim, (x, y) => 0.9 + 2.5 * y),
  ]);
}

function packGeometry() {
  // copper canister (an oval drum) hanging from the pivot at its top centre, darker bands, a lighter lid rim,
  // the hose rising from the lid and arching over the helmet brim into the socket, and a little valve
  const C = COLORS, H = 0.212, R = 0.1, SD = 0.74; // height, radius (across), depth squash
  const pts = [[0.0005, 0.0], [R - 0.022, 0.0], [R - 0.006, 0.006], [R, 0.024], [R, H - 0.024], [R - 0.006, H - 0.006], [R - 0.022, H], [0.0005, H]]
    .map(([r, y]) => new THREE.Vector2(r, y - H));
  const drum = paint(place(new THREE.LatheGeometry(pts, 18), { sx: SD }), C.copper, (x, y) => 0.84 + 0.75 * (y + H));
  const bands = [];
  for (const y of [-0.036, -H + 0.036]) bands.push(paint(place(new THREE.CylinderGeometry(R + 0.005, R + 0.005, 0.018, 18, 1, true), { y, sx: SD }), C.copperBand));
  const lid = paint(place(new THREE.CylinderGeometry(R - 0.012, R - 0.004, 0.014, 18), { y: 0.004, sx: SD }), C.copperLight);
  // hose: canister top -> up behind the brim -> over it -> into the helmet socket
  const sock = hoseEndInPack();
  const hoseCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.004, -0.012, 0), new THREE.Vector3(0.003, 0.03, 0), new THREE.Vector3(0.004, sock.y - 0.03, 0),
    new THREE.Vector3(0.013, sock.y - 0.005, 0), new THREE.Vector3(sock.x - 0.012, sock.y, 0), sock.clone().add(new THREE.Vector3(0.008, 0.001, 0)),
  ], false, 'centripetal');
  const hose = paint(new THREE.TubeGeometry(hoseCurve, 14, 0.0185, 7, false), C.copperLight, (x, y) => 0.86 + 1.2 * y);
  const collar = paint(place(new THREE.CylinderGeometry(0.027, 0.029, 0.022, 10), { x: 0.006, y: 0.018 }), C.copperBand);
  const elbow = paint(place(new THREE.TorusGeometry(0.021, 0.0065, 4, 10), { x: 0.004, y: sock.y - 0.04, rx: Math.PI / 2 }), C.copperBand);
  // valve: a short pipe stub with a cap on the top left of the lid (exhaust puffs leave here)
  const t = PIPE_TIP;
  const valve = paint(place(new THREE.CylinderGeometry(0.011, 0.013, 0.045, 7), { x: t.x, y: t.y - 0.024, z: t.z }), C.copperBand);
  const valveCap = paint(place(new THREE.CylinderGeometry(0.018, 0.016, 0.012, 8), { x: t.x, y: t.y - 0.004, z: t.z }), C.copperLight);
  const wheel = paint(place(new THREE.TorusGeometry(0.016, 0.004, 3, 8), { x: t.x, y: t.y - 0.03, z: t.z, rx: Math.PI / 2 }), C.lampRim);
  return merge([drum, ...bands, lid, hose, collar, elbow, valve, valveCap, wheel]);
}
// The helmet socket's mouth, expressed in pack space (pack pivot = PACK_PIVOT, unrotated).
function hoseEndInPack() {
  const s = helmetSurface(Math.PI, SOCKET_ELEV);
  return helmetToBody(s.p.clone().addScaledVector(s.n, 0.03)).sub(PACK_PIVOT);
}
// The helmet group's placement in the body frame: tilted on the head, then turned back with the (fully tipped) head.
const HELMET_POS = tipPoint(new THREE.Vector3(HELMET.x, HELMET.y, 0));
const HELMET_ROT = HELMET.tilt + tipAngle(HELMET.y);
function helmetToBody(p) { return p.applyAxisAngle(new THREE.Vector3(0, 0, 1), HELMET_ROT).add(HELMET_POS); }

function armGeometry() {
  // one chunky plum sausage from the shoulder down into the glove's cuff (runs along -y from the pivot)
  return paint(place(new THREE.SphereGeometry(1, 10, 7), { y: -0.036, sx: 0.064, sy: 0.092, sz: 0.062 }), COLORS.fur, (x, y) => 0.86 + (y + 0.11) * 1.4);
}

// Shovel blade outline: flat shoulders, straight sides, then curving in to a point (y down from 0 to -BH).
const BW = 0.222, BH = 0.215;
function bladeHalfW(s) {
  if (s < 0.36) return BW / 2;
  const u = (s - 0.36) / 0.64;
  return (BW / 2) * (1 - Math.pow(u, 1.75));
}
function bladeShape() {
  const sh = new THREE.Shape();
  const n = 8, hw = BW / 2;
  sh.moveTo(-hw + 0.018, -0.004);
  sh.lineTo(-0.03, 0.004); sh.lineTo(0.03, 0.004); sh.lineTo(hw - 0.018, -0.004);
  sh.quadraticCurveTo(hw, -0.006, hw, -0.026);
  for (let i = 1; i <= n; i++) { const s = 0.14 + (0.86 * i) / n; sh.lineTo(bladeHalfW(s), -s * BH); }
  for (let i = n - 1; i >= 1; i--) { const s = 0.14 + (0.86 * i) / n; sh.lineTo(-bladeHalfW(s), -s * BH); }
  sh.lineTo(-hw, -0.026);
  sh.quadraticCurveTo(-hw, -0.006, -hw + 0.018, -0.004);
  return sh;
}
// The worn, lighter tip: the lower part of the blade below a zig-zag line.
function wornShape() {
  const sh = new THREE.Shape();
  const sCut = 0.62, n = 6;
  sh.moveTo(bladeHalfW(sCut) - 0.002, -sCut * BH);
  for (let i = 1; i <= n; i++) { const s = sCut + ((1 - sCut) * i) / n; sh.lineTo(Math.max(0, bladeHalfW(s) - 0.002), -s * BH); }
  for (let i = n - 1; i >= 0; i--) { const s = sCut + ((1 - sCut) * i) / n; sh.lineTo(-Math.max(0, bladeHalfW(s) - 0.002), -s * BH); }
  // zig-zag back across (peaks reach up, like worn flames)
  const zz = [[-0.07, 0.5], [-0.048, 0.63], [-0.024, 0.47], [0.002, 0.63], [0.028, 0.46], [0.052, 0.62], [0.074, 0.52]];
  for (const [x, s] of zz) sh.lineTo(x, -s * BH);
  sh.closePath();
  return sh;
}
function gloveGeometry() {
  // hand frame: -y runs down the arm; the blade lies in the xy plane (its faces point along +-z)
  const C = COLORS, T = 0.016, BT = 0.006, TOP = -0.04;
  const blade = new THREE.ExtrudeGeometry(bladeShape(), { depth: T, bevelEnabled: true, bevelThickness: BT, bevelSize: BT, bevelSegments: 1, curveSegments: 2 });
  blade.translate(0, TOP, -T / 2);
  const parts = [paint(blade, C.blade, (x, y) => 0.86 + 0.6 * (y - TOP + 0.2))];
  const face = T / 2 + BT + 0.0012;
  for (const s of [-1, 1]) {
    const w = new THREE.ShapeGeometry(wornShape());
    if (s < 0) w.rotateY(Math.PI);
    parts.push(paint(place(w, { y: TOP, z: s * face }), C.bladeWorn, (x, y) => 0.95 + 0.4 * (y - TOP + 0.2)));
  }
  // centre ridge on both faces, the neck (shaft socket) and a darker cuff around the wrist
  for (const s of [-1, 1]) parts.push(paint(place(new THREE.BoxGeometry(0.012, 0.1, 0.004), { y: TOP - 0.06, z: s * (face - 0.0005) }), C.bladeDark));
  parts.push(paint(place(new THREE.BoxGeometry(0.054, 0.05, 0.034), { y: -0.026 }), C.blade, (x, y) => 0.9 + 2 * (y + 0.05)));
  parts.push(paint(place(new THREE.CylinderGeometry(0.054, 0.05, 0.034, 10), { y: 0.002 }), C.cuff, (x, y) => 0.9 + 3 * y));
  return merge(parts);
}

function footGeometry() {
  // stubby plum foot: a dome with three toe bumps and a darker sole. Origin on the ground under the ankle.
  const C = COLORS;
  const dome = paint(place(new THREE.SphereGeometry(0.07, 11, 5, 0, Math.PI * 2, 0, Math.PI / 2), { x: 0.022, y: 0.008, sx: 1.22, sy: 0.84, sz: 0.92 }), C.fur,
    (x, y) => 0.82 + y * 4);
  const sole = paint(place(new THREE.CircleGeometry(0.07, 11), { x: 0.022, y: 0.008, rx: Math.PI / 2, sx: 1.22, sy: 0.92 }), C.sole);
  const toes = [];
  for (const z of [-0.032, 0, 0.032]) toes.push(paint(place(new THREE.SphereGeometry(0.023, 6, 4), { x: 0.1, y: 0.015, z, sx: 1.1, sy: 0.8 }), C.furLight, (x, y) => 0.85 + y * 6));
  return merge([dome, sole, ...toes]);
}
function legGeometry() {
  // unit-length tube along +y (player.js scales it to the hip-foot distance every frame)
  return paint(new THREE.CylinderGeometry(LEG_R, LEG_R * 1.1, 1, 9, 1, true).translate(0, 0.5, 0), COLORS.furDark);
}

// ---------- the rig ----------
// P (the game palette) is accepted for parity with buildRobot(P); Dug's colours are his own (COLORS).
export function buildDug(P) { // eslint-disable-line no-unused-vars
  const fur = toonMaterial();
  const gloss = toonMaterial({ phong: true, rimStrength: 0.14, shininess: 34, specular: '#4a3626' });
  const mesh = (geo, m = fur, cast = true) => { const o = new THREE.Mesh(geo, m); o.castShadow = cast; return o; };

  const root = new THREE.Group();
  root.name = 'player';
  const tilt = new THREE.Group(), hop = new THREE.Group(), squash = new THREE.Group(), upper = new THREE.Group();
  root.add(tilt); tilt.add(hop); hop.add(squash); squash.add(upper);

  // soft contact shadow (the sun shadow does the rest)
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.8).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: radialTexture([[0, 'rgba(22,52,58,0.95)'], [0.55, 'rgba(22,52,58,0.5)'], [1, 'rgba(22,52,58,0)']]), transparent: true, opacity: 0.32, depthWrite: false }));
  shadow.position.y = 0.012;
  shadow.renderOrder = 1;
  root.add(shadow);

  // body: fur + snout, and the overalls in their own cream cloth (a full warm fill and a soft floor, so they
  // read cream like the sheet instead of khaki under the green bounce light)
  const bodyGeo = bodyGeometry();
  const body = mesh(bodyGeo.fur);
  body.receiveShadow = true;
  upper.add(body);
  const cloth = toonMaterial({ warm: 1, warmTint: [1.0, 1.0, 1.02], lift: 1.3, rimStrength: 0.2 });
  const overalls = mesh(bodyGeo.cream, cloth);
  overalls.receiveShadow = true;
  upper.add(overalls);

  // face decal: eyes, brows, whiskers on the front of the head (tipped back with the head)
  const FACE = { yc: 0.468, halfA: 74, halfH: 0.082 };
  const R0 = bodyRadiusAt(FACE.yc);
  const face = createDugFace({ arcW: 2 * THREE.MathUtils.degToRad(FACE.halfA) * R0, arcH: 2 * FACE.halfH });
  const decalMat = toonMaterial({ rimStrength: 0, map: face.texture, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const faceDecal = mesh(tipHead(surfacePatch({ yc: FACE.yc, halfA: FACE.halfA, halfH: FACE.halfH, off: 0.0015, p: 10, nu: 20, nv: 6 })), decalMat, false);
  faceDecal.receiveShadow = true;
  faceDecal.renderOrder = 2;
  upper.add(faceDecal);

  // helmet (tilted back with the head) with the headlamp on a springy bracket at the front
  const helmetGroup = new THREE.Group();
  helmetGroup.position.copy(HELMET_POS);
  helmetGroup.rotation.z = HELMET_ROT;
  const helmet = mesh(helmetGeometry(), gloss);
  helmet.receiveShadow = true;
  helmetGroup.add(helmet);
  upper.add(helmetGroup);

  // the lamp sits on the upper front of the dome: its back half sunk into the shell, the lens out front
  const mountAt = helmetSurface(0, 0.74);
  const lampMount = new THREE.Group();
  lampMount.position.copy(mountAt.p);
  lampMount.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), mountAt.n);
  helmetGroup.add(lampMount);
  const antenna = new THREE.Group();   // the bracket (antenna springs, damped)
  softHinge(antenna, 0.3);
  antenna.add(mesh(paint(place(new THREE.CylinderGeometry(0.024, 0.03, 0.02, 8), { y: 0.002 }), COLORS.lampRim), gloss));
  lampMount.add(antenna);
  const antJoint = new THREE.Group();  // the lamp head (second spring, damped)
  antJoint.position.y = 0.012;
  softHinge(antJoint, 0.3);
  antenna.add(antJoint);
  const lampHead = new THREE.Group();  // back to helmet-aligned axes (+x forward), nudged forward
  lampHead.quaternion.copy(lampMount.quaternion).invert();
  lampHead.position.set(0.012, 0, 0).applyQuaternion(lampHead.quaternion);
  antJoint.add(lampHead);
  const lampMesh = mesh(lampGeometry(), gloss);
  lampHead.add(lampMesh);
  const lensMat = new THREE.MeshBasicMaterial({ color: COLORS.lens });
  const lens = mesh(place(new THREE.SphereGeometry(LAMP_R - 0.012, 14, 6), { x: 0.025, sx: 0.32 }), lensMat, false);
  const bulbMat = new THREE.MeshBasicMaterial({ color: COLORS.lensCore }); // player.js flickers this one
  const lensCore = mesh(place(new THREE.SphereGeometry(0.017, 8, 5), { x: 0.034, y: 0.007, z: -0.005, sx: 0.4 }), bulbMat, false);
  lampHead.add(lens, lensCore);
  const bulb = new THREE.Group();
  bulb.position.set(0.042, 0, 0);
  lampHead.add(bulb);
  const bulbGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radialTexture([[0, 'rgba(255,240,190,1)'], [0.25, 'rgba(255,214,110,0.5)'], [1, 'rgba(255,190,90,0)']]),
    transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  bulbGlow.renderOrder = 46;
  bulbGlow.scale.setScalar(0.19);
  root.add(bulbGlow); // positioned at the bulb in root space by player.js

  // "visor" glow: an extra lamp flare player.js shows only while he faces the camera
  const visorGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radialTexture([[0, 'rgba(255,236,170,0.9)'], [0.35, 'rgba(255,210,110,0.3)'], [1, 'rgba(255,190,90,0)']]),
    transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  visorGlow.renderOrder = 45;
  visorGlow.scale.setScalar(0.3);
  const visorAnchor = new THREE.Object3D();
  visorAnchor.position.copy(mountAt.p).addScaledVector(mountAt.n, 0.032).add(new THREE.Vector3(0.07, 0, 0));
  helmetGroup.add(visorAnchor);
  root.add(visorGlow);

  // stand-ins for the robot's visor parts (player.js may touch them; they never show)
  const screenMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.01, 0.01), screenMat);
  screen.visible = false;
  upper.add(screen);
  const bezel = lampMesh;  // the lamp housing is Dug's "visor bezel"
  const band = helmet;     // and the helmet brim his "hazard band"

  // hips (leg attachment markers)
  const hipL = new THREE.Object3D(), hipR = new THREE.Object3D();
  hipL.position.set(HIP.x, HIP.y, -HIP.z); hipR.position.copy(HIP);
  squash.add(hipL, hipR);

  // canister backpack
  const pack = new THREE.Group();
  pack.position.copy(PACK_PIVOT);
  const packMesh = mesh(packGeometry(), gloss);
  const gaugeMat = new THREE.MeshBasicMaterial({ color: '#7ef5d4' });
  const gaugeBars = new THREE.Mesh(new THREE.BoxGeometry(0.001, 0.001, 0.001), gaugeMat);
  gaugeBars.visible = false; // the robot's battery gauge: Dug has none (player.js still tints the material)
  const pipeTip = new THREE.Object3D();
  pipeTip.position.copy(PIPE_TIP);
  const packTop = new THREE.Object3D(); // where a carried stack can sit
  packTop.position.copy(PACK_TOP);
  pack.add(packMesh, gaugeBars, pipeTip, packTop);
  upper.add(pack);

  // arms + shovel gloves. player.js writes arm.rotation = (+-0.36, 0, swing). With the default XYZ order that 0.36
  // tips the swing plane itself (hands in at rest, out overhead, so a raised shovel would point at the camera).
  // ZYX order makes it a fixed roll applied before the swing; the inner tilt cancels it exactly and adds a small
  // splay, so every swing is a clean vertical arc beside the body. The blades face forward-outward.
  const armGeo = armGeometry(), gloveGeo = gloveGeometry();
  const arms = [];
  for (const s of [-1, 1]) {
    const arm = new THREE.Group();
    arm.rotation.order = 'ZYX'; // player.js's rotation.set(x, 0, z) keeps this order
    arm.position.set(0.006, SHOULDER_Y, s * (bodyRadiusAt(SHOULDER_Y) + 0.012));
    const armTilt = new THREE.Group();
    armTilt.rotation.set(-s * (PLAYER_ARM_TILT + ARM_SPLAY), 0, ARM_FWD);
    arm.add(armTilt);
    armTilt.add(mesh(armGeo));
    const hand = new THREE.Group();
    hand.position.y = -ARM_LEN;
    hand.rotation.y = s * (Math.PI / 2 - BLADE_YAW);
    const glove = mesh(gloveGeo);
    glove.receiveShadow = true;
    hand.add(glove);
    armTilt.add(hand);
    upper.add(arm);
    arms.push({ arm, hand });
  }
  const [{ arm: armL, hand: handL }, { arm: armR, hand: handR }] = arms;

  // tools: the shovels ARE the tools, so these stay empty (player.js shows / scales / rotates them freely)
  const tool = new THREE.Group();
  const axe = new THREE.Group(), pickaxe = new THREE.Group(), club = new THREE.Group();
  axe.visible = pickaxe.visible = club.visible = false;
  tool.add(axe, pickaxe, club);
  handR.add(tool);

  // legs + feet live directly under the root: player.js plants the feet and stretches the legs to the hips
  const legGeo = legGeometry(), footGeo = footGeometry();
  const legL = mesh(legGeo), legR = mesh(legGeo);
  const footL = mesh(footGeo), footR = mesh(footGeo);
  footL.position.set(0, 0, -FOOT_Z); footR.position.set(0, 0, FOOT_Z);
  root.add(legL, legR, footL, footR);

  return {
    root, tilt, hop, squash, upper, shadow, body, band, bezel, screen, screenMat, face, visorGlow, visorAnchor,
    hipL, hipR, legL, legR, footL, footR, antenna, antJoint, bulb, bulbMat, bulbGlow,
    pack, packMesh, gaugeBars, gaugeMat, pipeTip, armL, armR, handL, handR, tool, tools: { axe, pickaxe, club },
    // Dug extras
    helmet: helmetGroup, lamp: lampHead, faceDecal, packTop, overalls, clothMat: cloth,
  };
}

// Everything player.js (or a future version of it) may import from model.js, under Dug's numbers.
export const DUG = { FOOT_Z, LEG_R, HIP, SHOULDER_Y, ARM_LEN, PACK_PIVOT, PIPE_TIP, PACK_TOP, HELMET, HEIGHT, COLORS };
