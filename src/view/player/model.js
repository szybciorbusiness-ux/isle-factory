// The player: a little robot engineer, geometry only (player.js animates it). An original low-poly toon robot:
// a cream-white ceramic egg on stubby legs, one big glowing mint visor with expressive pupils, copper ear
// bolts and trim, a thin yellow hazard stripe, a light-bulb antenna on a spring, small arms with slate mitts,
// and a copper power-pack on its back with a tiny exhaust pipe.
//
// Rig (front = local +x, right = local +z, origin = on the ground under the body centre):
//   root ─ shadow, legL/legR (stretchy tubes, hip -> foot), footL/footR (planted by player.js), glow sprites
//        └ tilt (rotation.z = -lean forward, rotation.x = bank / waddle roll; pivot on the ground)
//            └ hop (position.y)
//                └ squash (scale, pivot at the ground)
//                    ├ hipL, hipR (markers the legs attach to)
//                    └ upper (rotation.y = upper-body twist: swings while walking turn the egg, not the legs)
//                        ├ body (egg, hazard band, copper trim, ear bolts), visor (bezel + screen)
//                        ├ antenna (pivot on top) ─ joint ─ bulb
//                        ├ pack (pivot at the upper back) ─ pipeTip; PACK_TOP = where the carried stack sits
//                        └ armL, armR (shoulder pivots; rotation.z swings forward) ─ hand ─ tool ─ axe, pickaxe, club
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { createFace } from './face.js';

export const BODY_LIFT = 0.115;  // egg bottom above the ground (the legs show under it)
export const BODY_H = 0.5;       // egg height
export const BODY_R = 0.235;     // egg max-ish radius
const EGG_K = 0.1;               // egg asymmetry: wider low, narrower top

export const VISOR = { y: 0.315, halfA: 52, halfH: 0.083 };  // centre height above the egg bottom, half angle (deg), half height
export const SHOULDER_Y = BODY_LIFT + 0.235;
export const ARM_LEN = 0.1;      // shoulder -> centre of the mitt
export const HIP = new THREE.Vector3(0.005, BODY_LIFT + 0.035, 0.092); // right hip (z mirrored for the left)
export const FOOT_Z = 0.098;     // feet rest this far to each side
export const LEG_R = 0.028;
export const PACK_PIVOT = new THREE.Vector3(-0.19, BODY_LIFT + 0.35, 0);
// exhaust up the pack's left side (clear of the carried stack, which sits on the lid)
export const PIPE_TIP = new THREE.Vector3(-0.07, 0.115, -0.148); // in pack space
// top centre of the pack lid in pack space: the base of the carried stack (camp mode)
export const PACK_TOP = new THREE.Vector3(-0.07, 0.036, 0);
export const ANTENNA_Y = BODY_LIFT + BODY_H - 0.008;
export const ANT_SEG = 0.075;

export const COLORS = {
  ceramic: '#f7f0e1', ceramicShade: '#e6d9c2', copper: '#e8853e', copperDark: '#bd6230', copperLight: '#f6a25e',
  hazard: '#f8c93a', hazardDark: '#4c5160', slate: '#55606f', slateDark: '#3f4957', slateLight: '#7c8797',
  bezel: '#2d4954', bulb: '#ffe07a', gauge: '#7ef5d4',
};

// Radius of the egg at height y above its bottom.
export function bodyRadiusAt(y) {
  const c = THREE.MathUtils.clamp(1 - (2 * y) / BODY_H, -1, 1);
  return BODY_R * Math.sqrt(1 - c * c) * (1 + EGG_K * c);
}
// Point on the egg surface: a = angle from +x toward +z (deg), y above the egg bottom, pushed out by off.
export function surface(aDeg, y, off = 0, out = new THREE.Vector3()) {
  const a = THREE.MathUtils.degToRad(aDeg), r = bodyRadiusAt(y) + off;
  return out.set(Math.cos(a) * r, y + BODY_LIFT, Math.sin(a) * r);
}
export function surfaceNormal(aDeg, y, out = new THREE.Vector3()) {
  const a = THREE.MathUtils.degToRad(aDeg);
  const slope = (bodyRadiusAt(Math.min(BODY_H, y + 0.005)) - bodyRadiusAt(Math.max(0, y - 0.005))) / 0.01;
  return out.set(Math.cos(a), -slope, Math.sin(a)).normalize();
}

// ---------- geometry helpers ----------
const _c = new THREE.Color();
function paint(geo, color, shade = null) {
  for (const k of Object.keys(geo.attributes)) if (k !== 'position' && k !== 'normal') geo.deleteAttribute(k);
  const pos = geo.attributes.position, n = pos.count;
  const arr = new Float32Array(n * 3);
  _c.set(color);
  for (let i = 0; i < n; i++) {
    const f = shade ? shade(pos.getX(i), pos.getY(i), pos.getZ(i)) : 1;
    arr[i * 3] = _c.r * f; arr[i * 3 + 1] = _c.g * f; arr[i * 3 + 2] = _c.b * f;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}
function merge(parts) {
  const anyFlat = parts.some(g => !g.index);
  return mergeGeometries(anyFlat ? parts.map(g => (g.index ? g.toNonIndexed() : g)) : parts, false);
}
const M = new THREE.Matrix4();
const place = (geo, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1 } = {}) =>
  geo.applyMatrix4(M.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz)));
// Geometry built along +y, moved so its +y axis points along the surface normal at (a, y), base at the surface.
function onSurface(geo, aDeg, y, off = 0) {
  const n = surfaceNormal(aDeg, y), p = surface(aDeg, y, off);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
  return geo.applyMatrix4(new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1)));
}

function eggGeometry() {
  const pts = [];
  const rings = 24;
  for (let i = 0; i <= rings; i++) {
    const t = (i / rings) * Math.PI;
    const y = (BODY_H * (1 - Math.cos(t))) / 2;
    pts.push(new THREE.Vector2(Math.max(1e-4, bodyRadiusAt(y)), y + BODY_LIFT));
  }
  return new THREE.LatheGeometry(pts, 40);
}
// The top of the egg from height y0 up, pushed out by off (a copper skull cap).
function capGeometry(y0, off) {
  const pts = [];
  const n = 8;
  for (let i = 0; i <= n; i++) {
    const y = y0 + ((BODY_H - y0) * i) / n;
    pts.push(new THREE.Vector2(Math.max(1e-4, bodyRadiusAt(y) + off * (1 - i / n)), y + BODY_LIFT + (i === n ? off : 0)));
  }
  return new THREE.LatheGeometry(pts, 32);
}
// A band hugging the egg between heights y0 and y1 (above the egg bottom).
function bandGeometry(y0, y1, off, segs = 48) {
  const pts = [];
  const n = 3;
  for (let i = 0; i <= n; i++) {
    const y = y0 + ((y1 - y0) * i) / n;
    pts.push(new THREE.Vector2(bodyRadiusAt(y) + off, y + BODY_LIFT));
  }
  return new THREE.LatheGeometry(pts, segs);
}

// A rounded-rectangle patch lying on the egg surface (superellipse corners), centred at angle 0 (the front).
// UVs run left-to-right as seen by someone facing the robot, so a texture reads correctly.
function surfacePatch({ yc, halfA, halfH, off, p = 4, nu = 28, nv = 10 }) {
  const pos = [], uv = [], idx = [];
  const v3 = new THREE.Vector3();
  for (let j = 0; j <= nv; j++) {
    const v = -1 + (2 * j) / nv;
    const w = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(v), p)), 1 / p);
    for (let i = 0; i <= nu; i++) {
      const u = -1 + (2 * i) / nu;
      const a = u * w * halfA;
      surface(a, yc + v * halfH, off, v3);
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
  g.computeVertexNormals();
  return g;
}

function stripeTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 16;
  const g = c.getContext('2d');
  g.fillStyle = COLORS.hazard; g.fillRect(0, 0, 64, 16);
  g.fillStyle = COLORS.hazardDark;
  for (let x = -16; x < 80; x += 16) {
    g.beginPath(); g.moveTo(x, 16); g.lineTo(x + 7, 16); g.lineTo(x + 15, 0); g.lineTo(x + 8, 0); g.closePath(); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.repeat.set(9, 1);
  t.anisotropy = 4;
  return t;
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

// Soft glossy "ceramic": Phong with a gentle highlight and a warm rim so the cream body separates from the grass.
function ceramicMaterial({ rim = '#fff3d6', rimStrength = 0.22, rimPower = 2.4, shininess = 38, specular = '#4a4436', vertexColors = true, color } = {}) {
  const m = new THREE.MeshPhongMaterial({ vertexColors, shininess, specular: new THREE.Color(specular), ...(color ? { color } : {}) });
  const uRim = { value: new THREE.Color(rim).multiplyScalar(rimStrength) };
  m.onBeforeCompile = sh => {
    sh.uniforms.uRim = uRim;
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', 'uniform vec3 uRim;\nvoid main() {')
      .replace('#include <opaque_fragment>',
        `{ float fres = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), ${rimPower.toFixed(2)});
           outgoingLight += uRim * fres * (0.55 + 0.45 * normal.y); }
         #include <opaque_fragment>`);
  };
  m.customProgramCacheKey = () => `isle-ceramic-${rimPower}`;
  return m;
}

// ---------- parts ----------
function bodyGeometry() {
  const egg = paint(eggGeometry(), COLORS.ceramic, (x, y) => 0.86 + Math.min(1, (y - BODY_LIFT) / BODY_H) * 0.18);
  // copper trim ring around the bottom, where the legs come out
  const trimY = 0.05;
  const trim = paint(place(new THREE.TorusGeometry(bodyRadiusAt(trimY) + 0.004, 0.016, 8, 40), { y: trimY + BODY_LIFT, rx: Math.PI / 2 }), COLORS.copper,
    (x, y) => 0.85 + (y - BODY_LIFT - trimY + 0.016) * 6);
  // ear bolts: copper discs on both sides at visor height, with a cream cap and a slate nub
  const ears = [];
  for (const s of [-1, 1]) {
    const a = 90 * s, y = VISOR.y - 0.01;
    ears.push(paint(onSurface(new THREE.CylinderGeometry(0.056, 0.06, 0.04, 22).translate(0, 0.012, 0), a, y, -0.008), COLORS.copper, (x, yy) => 0.9 + 0.12 * Math.sign(yy - VISOR.y - BODY_LIFT)));
    ears.push(paint(onSurface(new THREE.CylinderGeometry(0.034, 0.036, 0.016, 18).translate(0, 0.036, 0), a, y, -0.008), COLORS.ceramic));
    ears.push(paint(onSurface(new THREE.CylinderGeometry(0.012, 0.014, 0.03, 8).translate(0, 0.05, 0), a, y, -0.008), COLORS.slate));
  }
  // copper crown ring on top, around the antenna (gives the top-down view an accent)
  const CAP = 0.032;
  const crown = paint(capGeometry(BODY_H - CAP, 0.004), COLORS.copper, (x, y) => 0.86 + (y - BODY_LIFT - BODY_H + CAP) * 4);
  const crownRim = paint(place(new THREE.TorusGeometry(bodyRadiusAt(BODY_H - CAP) + 0.004, 0.008, 6, 28), { y: BODY_H - CAP + BODY_LIFT, rx: Math.PI / 2 }), COLORS.copperDark);
  // a little copper chest plate under the visor
  const plate = paint(onSurface(new THREE.CylinderGeometry(0.026, 0.03, 0.012, 16).scale(1, 1, 1), 0, 0.165, -0.002), COLORS.copper);
  return merge([egg, trim, crown, crownRim, ...ears, plate]);
}

function packGeometry() {
  const cx = -0.062, cy = -0.1, W = 0.135, H = 0.225, D = 0.245;
  const box = paint(place(new RoundedBoxGeometry(W, H, D, 4, 0.06), { x: cx, y: cy }), COLORS.copper, (x, y) => 0.84 + (y + 0.22) * 0.55);
  // a slate battery cap with a cream hazard-yellow stripe across it (what the high camera mostly sees)
  const lid = paint(place(new RoundedBoxGeometry(W + 0.016, 0.04, D + 0.016, 3, 0.02), { x: cx - 0.003, y: cy + H / 2 - 0.004 }), COLORS.copperDark,
    (x, y) => 0.9 + (y - cy - H / 2) * 2);
  const lidStripe = paint(place(new RoundedBoxGeometry(W + 0.02, 0.012, 0.05, 2, 0.005), { x: cx - 0.003, y: cy + H / 2 + 0.016 }), COLORS.hazard);
  const base = paint(place(new RoundedBoxGeometry(W + 0.016, 0.03, D + 0.016, 2, 0.014), { x: cx, y: cy - H / 2 + 0.02 }), COLORS.copperDark);
  // side vents
  const vents = [];
  for (const s of [-1, 1]) for (const dy of [-0.02, 0.02]) {
    vents.push(paint(place(new RoundedBoxGeometry(0.075, 0.016, 0.014, 2, 0.006), { x: cx, y: cy + dy, z: s * (D / 2 + 0.002) }), COLORS.slateDark));
  }
  // battery gauge housing on the back face (the lit bars are a separate glowing mesh)
  const gauge = paint(place(new RoundedBoxGeometry(0.02, 0.15, 0.1, 2, 0.008), { x: cx - W / 2 - 0.004, y: cy + 0.005 }), COLORS.slateDark);
  // exhaust pipe up the left side (a bracket ties it to the box) with a copper collar and a flared slate tip
  const t = PIPE_TIP;
  const pipe = paint(place(new THREE.CylinderGeometry(0.017, 0.02, 0.2, 10), { x: t.x, y: t.y - 0.105, z: t.z }), COLORS.slate);
  const bracket = paint(place(new RoundedBoxGeometry(0.05, 0.026, 0.04, 2, 0.008), { x: t.x, y: t.y - 0.15, z: t.z + 0.022 }), COLORS.copperDark);
  const collar = paint(place(new THREE.CylinderGeometry(0.026, 0.026, 0.022, 12), { x: t.x, y: t.y - 0.065, z: t.z }), COLORS.copperLight);
  const tip = paint(place(new THREE.CylinderGeometry(0.027, 0.019, 0.03, 12), { x: t.x, y: t.y - 0.012, z: t.z }), COLORS.slateLight);
  return merge([box, lid, lidStripe, base, ...vents, gauge, pipe, bracket, collar, tip]);
}
function gaugeBarsGeometry() {
  const cx = -0.062 - 0.135 / 2 - 0.016, cy = -0.1;
  const parts = [];
  for (let i = 0; i < 3; i++) parts.push(place(new THREE.BoxGeometry(0.008, 0.03, 0.07), { x: cx, y: cy - 0.042 + i * 0.042 }));
  return merge(parts);
}

function armGeometry() {
  // copper shoulder ball, a short cream sleeve, a chunky slate mitt with a thumb (runs along -y from the pivot)
  return merge([
    paint(new THREE.SphereGeometry(0.036, 12, 10), COLORS.copper, (x, y) => 0.88 + y * 3),
    paint(new THREE.CapsuleGeometry(0.026, 0.045, 4, 10).translate(0, -0.045, 0), COLORS.ceramic),
  ]);
}
function mittGeometry() {
  return merge([
    paint(place(new THREE.SphereGeometry(0.05, 14, 10), { sx: 1.05, sy: 1.0, sz: 0.88 }), COLORS.slate, (x, y) => 0.9 + y * 2.2),
    paint(place(new THREE.SphereGeometry(0.021, 10, 8), { x: 0.03, y: 0.016, z: 0 }), COLORS.slate, (x, y) => 0.95 + y * 2),
    paint(place(new THREE.TorusGeometry(0.03, 0.009, 6, 14), { y: 0.034, rx: Math.PI / 2 }), COLORS.copper),
  ]);
}
function footGeometry() {
  // a round dome shoe: cream top, copper toe cap band, slate sole. Origin on the ground under the ankle.
  const dome = paint(place(new THREE.SphereGeometry(0.062, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), { x: 0.018, y: 0.012, sx: 1.35, sy: 0.95, sz: 1.0 }), COLORS.ceramic,
    (x, y) => 0.86 + y * 2.2);
  const sole = paint(place(new THREE.CylinderGeometry(0.064, 0.062, 0.016, 18), { x: 0.018, y: 0.008, sx: 1.35 }), COLORS.slate);
  const band = paint(place(new THREE.CylinderGeometry(0.0645, 0.0645, 0.012, 18), { x: 0.018, y: 0.021, sx: 1.35 }), COLORS.copper);
  return merge([dome, sole, band]);
}
function legGeometry() {
  // unit-length tube along +y (scaled to the hip-foot distance every frame), with a copper knee ring
  return merge([
    paint(new THREE.CylinderGeometry(LEG_R, LEG_R * 1.08, 1, 10, 1, true).translate(0, 0.5, 0), COLORS.slate),
  ]);
}
function axeGeometry(P) {
  return merge([
    paint(place(new THREE.CylinderGeometry(0.019, 0.023, 0.4, 6), { y: 0.14 }), P.wood),
    paint(place(new THREE.CylinderGeometry(0.026, 0.026, 0.07, 6), { y: 0.0 }), P.woodDark),
    paint(place(new THREE.BoxGeometry(0.12, 0.1, 0.034), { x: 0.06, y: 0.29 }), '#c9d4da'),
    paint(place(new THREE.BoxGeometry(0.03, 0.14, 0.03), { x: 0.126, y: 0.29 }), '#f1f6f7'),
    paint(place(new THREE.BoxGeometry(0.05, 0.072, 0.046), { x: -0.012, y: 0.29 }), COLORS.copper),
  ]);
}
function pickaxeGeometry(P) {
  return merge([
    paint(place(new THREE.CylinderGeometry(0.019, 0.023, 0.4, 6), { y: 0.14 }), P.wood),
    paint(place(new THREE.CylinderGeometry(0.026, 0.026, 0.07, 6), { y: 0.0 }), P.woodDark),
    paint(place(new THREE.ConeGeometry(0.03, 0.2, 6), { x: 0.1, y: 0.31, rz: -Math.PI / 2 - 0.3 }), '#c3cdd3'),
    paint(place(new THREE.ConeGeometry(0.026, 0.16, 6), { x: -0.085, y: 0.315, rz: Math.PI / 2 + 0.3 }), '#b3bec6'),
    paint(place(new THREE.BoxGeometry(0.065, 0.065, 0.055), { y: 0.315 }), COLORS.copper),
  ]);
}

function clubGeometry(P) {
  // a chunky wooden club: grip wrap, a fat faceted head with a copper band (it bonks, it never cuts)
  return merge([
    paint(place(new THREE.CylinderGeometry(0.019, 0.024, 0.3, 6), { y: 0.11 }), P.wood),
    paint(place(new THREE.CylinderGeometry(0.026, 0.026, 0.07, 6), { y: 0.0 }), P.woodDark),
    paint(place(new THREE.DodecahedronGeometry(0.075, 0), { y: 0.3, sx: 0.95, sy: 1.25, sz: 0.95 }), P.wood, (x, y) => 0.9 + (y - 0.3) * 1.6),
    paint(place(new THREE.CylinderGeometry(0.068, 0.068, 0.03, 8), { y: 0.26 }), COLORS.copper),
    paint(place(new THREE.DodecahedronGeometry(0.03, 0), { x: 0.045, y: 0.36, z: 0.02 }), P.woodDark),
  ]);
}

export function buildRobot(P) {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const ceramic = ceramicMaterial();
  const metal = ceramicMaterial({ rimStrength: 0.12, shininess: 55, specular: '#5a4a3a' });
  const toolMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const mesh = (geo, m = mat, cast = true) => { const o = new THREE.Mesh(geo, m); o.castShadow = cast; return o; };

  const root = new THREE.Group();
  root.name = 'player';
  const tilt = new THREE.Group(), hop = new THREE.Group(), squash = new THREE.Group(), upper = new THREE.Group();
  root.add(tilt); tilt.add(hop); hop.add(squash); squash.add(upper);

  // soft contact shadow (the sun shadow does the rest)
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(0.78, 0.78).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: radialTexture([[0, 'rgba(22,52,58,0.95)'], [0.55, 'rgba(22,52,58,0.5)'], [1, 'rgba(22,52,58,0)']]), transparent: true, opacity: 0.32, depthWrite: false }));
  shadow.position.y = 0.012;
  shadow.renderOrder = 1;
  root.add(shadow);

  // body
  const body = mesh(bodyGeometry(), ceramic);
  body.receiveShadow = true;
  const band = mesh(bandGeometry(0.135, 0.178, 0.005), new THREE.MeshLambertMaterial({ map: stripeTexture() }));
  upper.add(body, band);

  // visor: dark bezel + glowing screen (face canvas) + soft glow sprite
  const face = createFace();
  const bezel = mesh(paint(surfacePatch({ yc: VISOR.y, halfA: VISOR.halfA + 7, halfH: VISOR.halfH + 0.02, off: 0.005, p: 3.4 }), COLORS.bezel), metal, false);
  const screenMat = new THREE.MeshBasicMaterial({ map: face.texture });
  const screen = mesh(surfacePatch({ yc: VISOR.y, halfA: VISOR.halfA, halfH: VISOR.halfH, off: 0.011, p: 4.2 }), screenMat, false);
  upper.add(bezel, screen);
  const visorGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radialTexture([[0, 'rgba(190,255,236,0.9)'], [0.35, 'rgba(130,245,214,0.35)'], [1, 'rgba(110,240,210,0)']]),
    transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  visorGlow.renderOrder = 45;
  visorGlow.scale.setScalar(0.46);
  const visorAnchor = new THREE.Object3D();
  surface(0, VISOR.y, 0.03, visorAnchor.position);
  upper.add(visorAnchor);
  root.add(visorGlow); // positioned at visorAnchor in root space by player.js (keeps the sprite unsquashed)

  // hips (leg attachment markers)
  const hipL = new THREE.Object3D(), hipR = new THREE.Object3D();
  hipL.position.set(HIP.x, HIP.y, -HIP.z); hipR.position.copy(HIP);
  squash.add(hipL, hipR);

  // antenna: copper base, two slate segments on spring joints, a warm light bulb with a glow
  const antBase = mesh(paint(new THREE.CylinderGeometry(0.03, 0.04, 0.034, 14), COLORS.copper, (x, y) => 0.9 + y * 3), metal);
  antBase.position.y = ANTENNA_Y + 0.01;
  upper.add(antBase);
  const antenna = new THREE.Group();
  antenna.position.y = ANTENNA_Y + 0.025;
  const segGeo = paint(new THREE.CylinderGeometry(0.0095, 0.012, ANT_SEG, 8).translate(0, ANT_SEG / 2, 0), COLORS.slate);
  antenna.add(mesh(segGeo));
  const antJoint = new THREE.Group();
  antJoint.position.y = ANT_SEG;
  antJoint.add(mesh(paint(new THREE.SphereGeometry(0.016, 10, 8), COLORS.copper)));
  antJoint.add(mesh(paint(new THREE.CylinderGeometry(0.0085, 0.0095, ANT_SEG * 0.9, 8).translate(0, (ANT_SEG * 0.9) / 2, 0), COLORS.slate)));
  antenna.add(antJoint);
  const bulbMat = new THREE.MeshBasicMaterial({ color: COLORS.bulb });
  const bulb = new THREE.Group();
  bulb.position.y = ANT_SEG * 0.9 + 0.032;
  const bulbGlass = mesh(new THREE.SphereGeometry(0.044, 16, 12), bulbMat, true);
  const bulbCap = mesh(paint(new THREE.CylinderGeometry(0.02, 0.024, 0.02, 12).translate(0, -0.036, 0), COLORS.copperDark), metal);
  bulb.add(bulbGlass, bulbCap);
  antJoint.add(bulb);
  upper.add(antenna);
  const bulbGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radialTexture([[0, 'rgba(255,246,200,1)'], [0.3, 'rgba(255,224,130,0.5)'], [1, 'rgba(255,200,100,0)']]),
    transparent: true, opacity: 0.75, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  bulbGlow.renderOrder = 46;
  bulbGlow.scale.setScalar(0.24);
  root.add(bulbGlow);

  // power pack
  const pack = new THREE.Group();
  pack.position.copy(PACK_PIVOT);
  const packMesh = mesh(packGeometry(), metal);
  const gaugeMat = new THREE.MeshBasicMaterial({ color: COLORS.gauge });
  const gaugeBars = mesh(gaugeBarsGeometry(), gaugeMat, false);
  pack.add(packMesh, gaugeBars);
  const pipeTip = new THREE.Object3D();
  pipeTip.position.copy(PIPE_TIP);
  pack.add(pipeTip);
  upper.add(pack);

  // arms + mitts
  const armGeo = armGeometry(), mittGeo = mittGeometry();
  const arms = [];
  for (const s of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(0.0, SHOULDER_Y, s * (bodyRadiusAt(SHOULDER_Y - BODY_LIFT) + 0.018));
    arm.add(mesh(armGeo, ceramic));
    const hand = new THREE.Group();
    hand.position.y = -ARM_LEN;
    hand.add(mesh(mittGeo, metal));
    arm.add(hand);
    upper.add(arm);
    arms.push({ arm, hand });
  }
  const [{ arm: armL, hand: handL }, { arm: armR, hand: handR }] = arms;

  // tools live in the right mitt
  const tool = new THREE.Group();
  const axe = mesh(axeGeometry(P).scale(1.15, 1.15, 1.15), toolMat), pickaxe = mesh(pickaxeGeometry(P).scale(1.15, 1.15, 1.15), toolMat);
  const club = mesh(clubGeometry(P).scale(1.15, 1.15, 1.15), toolMat);
  axe.visible = pickaxe.visible = club.visible = false;
  tool.add(axe, pickaxe, club);
  handR.add(tool);

  // legs + feet live directly under the root: player.js plants the feet and stretches the legs to the hips
  const legGeo = legGeometry(), footGeo = footGeometry();
  const legL = mesh(legGeo, metal), legR = mesh(legGeo, metal);
  const footL = mesh(footGeo, ceramic), footR = mesh(footGeo, ceramic);
  footL.position.set(0, 0, -FOOT_Z); footR.position.set(0, 0, FOOT_Z);
  root.add(legL, legR, footL, footR);

  return {
    root, tilt, hop, squash, upper, shadow, body, band, bezel, screen, screenMat, face, visorGlow, visorAnchor,
    hipL, hipR, legL, legR, footL, footR, antenna, antJoint, bulb, bulbMat, bulbGlow,
    pack, packMesh, gaugeBars, gaugeMat, pipeTip, armL, armR, handL, handR, tool, tools: { axe, pickaxe, club },
  };
}
