// Lighting: mint/warm-green hemisphere fill + a warm sun from the upper-left-back, so soft shadows fall
// toward the lower-right. Shadows are tinted by the fill light and never reach black.
//
// The shadow camera is fitted to what the view camera actually sees: the ground footprint of the view
// frustum (and the same footprint lifted to tree-crown height) is projected into light space and the
// orthographic frustum hugs it, so the texels go where they're seen. A tall portrait view gets a tall
// shadow frustum instead of a huge square, which keeps a 1024 map (ctx.quality.shadowMapSize on phones)
// as crisp as 2048 used to be. Extents change in whole-unit steps with hysteresis and the centre is snapped
// to whole shadow texels, so edges never shimmer while walking.
//
// Camp mode: at camp level 0 (a cold hearth) the light is cooler and a little dimmer; when the hearth is lit
// it warms up together with the warm wave (world/mood.js, ticked from update() here: this module updates first).
import * as THREE from 'three';
import { getMood } from './world/mood.js';

const SUN_DIR = new THREE.Vector3(-0.5, 1.0, -0.36).normalize(); // from the scene toward the sun
const SUN_DIST = 30;
const SHADOW_HALF = 13;         // fallback half extent (no camera yet)
const FOOT_MARGIN = 0.9;        // light-space margin around the view footprint (units)
const FOOT_FAR = 17;            // ignore ground further than this from the target (it's under cloud / blurred)
const FOOT_FAR_TOP_MOBILE = 11.5; // phones: toward the top of the screen only (see create)
const CROWN_Y = 1.6;            // receivers up to this height still get their shadow when at the frame edge

// warm (lit hearth) and cold (level 0) light rigs
const RIG = {
  warm: { sun: '#fff0d2', sunI: 1.8, sky: '#e2fbf1', ground: '#9db466', hemiI: 1.8, shadow: 0.72 },
  cold: { sun: '#dde8ff', sunI: 1.52, sky: '#d4e7f2', ground: '#8aa58c', hemiI: 1.64, shadow: 0.62 },
};

export function create(ctx) {
  const { scene, renderer, sim, map, camera } = ctx;
  const mapSize = Math.max(256, Math.min(4096, Number(ctx.quality?.shadowMapSize) || 2048));
  // phones: toward the top of the screen the shadow frustum only reaches as far as the crisp part of the
  // tilt-shift (further up is under the cloud frame / blurred), which keeps the 1024 map sharper and lets far
  // casters drop out. The sides stay crisp in a sideways phone, so they keep the full reach.
  const MOBILE = ctx.quality?.tier === 'mobile';
  const footFar = FOOT_FAR, footFarTop = MOBILE ? FOOT_FAR_TOP_MOBILE : FOOT_FAR;

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // No filmic curve: the palette is authored as final colours. post.js adds a hue-preserving highlight
  // roll-off instead (Neutral/ACES crush the darkest channel and turn the grass neon).
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1.0;

  const mood = getMood(ctx);
  const C = k => ({ sun: new THREE.Color(RIG[k].sun), sky: new THREE.Color(RIG[k].sky), ground: new THREE.Color(RIG[k].ground) });
  const warmC = C('warm'), coldC = C('cold');

  const hemi = new THREE.HemisphereLight(RIG.warm.sky, RIG.warm.ground, RIG.warm.hemiI);
  hemi.position.set(0, 1, 0);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(RIG.warm.sun, RIG.warm.sunI);
  sun.castShadow = true;
  sun.shadow.mapSize.set(mapSize, mapSize);
  const sc = sun.shadow.camera;
  sc.left = -SHADOW_HALF; sc.right = SHADOW_HALF; sc.top = SHADOW_HALF; sc.bottom = -SHADOW_HALF;
  sc.near = 1; sc.far = SUN_DIST * 2;
  sc.updateProjectionMatrix();
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.025;
  // PCF radius is in texels: keep the penumbra about the same width in world units when the map is smaller
  sun.shadow.radius = 4 * Math.min(1.5, Math.max(0.6, Math.sqrt(mapSize / 2048)));
  sun.shadow.intensity = RIG.warm.shadow;
  scene.add(sun, sun.target);

  // Light-space basis identical to the one the shadow camera builds with lookAt (up = +y).
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), SUN_DIR).normalize();
  const upL = new THREE.Vector3().crossVectors(SUN_DIR, right).normalize();
  const focus = new THREE.Vector3();
  const ext = { hw: SHADOW_HALF, hh: SHADOW_HALF };

  // ---- view footprint in light space ----
  const camPos = new THREE.Vector3(), ray = new THREE.Vector3();
  const box = { r0: 0, r1: 0, u0: 0, u1: 0, ok: false };
  const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 1], [0, -1]];
  function footprint(tx, tz) {
    camera.updateMatrixWorld();
    camera.getWorldPosition(camPos);
    box.r0 = box.u0 = Infinity; box.r1 = box.u1 = -Infinity; box.ok = false;
    for (const y of [0, CROWN_Y]) {
      for (const [nx, ny] of CORNERS) {
        ray.set(nx, ny, 0.5).unproject(camera).sub(camPos);
        const far = ny > 0 ? footFarTop : footFar;
        let px, pz;
        if (ray.y < -1e-4 && camPos.y > y) {
          const t = (y - camPos.y) / ray.y;
          px = camPos.x + ray.x * t; pz = camPos.z + ray.z * t;
        } else { // looking at/above the horizon: clamp to the far limit along the ray's heading
          const l = Math.hypot(ray.x, ray.z) || 1;
          px = tx + (ray.x / l) * far; pz = tz + (ray.z / l) * far;
        }
        const dx = px - tx, dz = pz - tz, d = Math.hypot(dx, dz);
        if (d > far) { px = tx + dx * far / d; pz = tz + dz * far / d; }
        const r = px * right.x + y * right.y + pz * right.z;
        const u = px * upL.x + y * upL.y + pz * upL.z;
        box.r0 = Math.min(box.r0, r); box.r1 = Math.max(box.r1, r);
        box.u0 = Math.min(box.u0, u); box.u1 = Math.max(box.u1, u);
        box.ok = true;
      }
    }
    return box.ok;
  }

  const place = () => {
    const tgt = ctx.views.camera?.target || (sim?.player ? { x: sim.player.x, z: sim.player.z } : map.start);
    const tx = Number.isFinite(tgt.x) ? tgt.x : map.start.x, tz = Number.isFinite(tgt.z) ? tgt.z : map.start.z;
    let cr, cu;
    if (footprint(tx, tz)) {
      // whole-unit extents with hysteresis: grow at once, shrink only when clearly too big
      const wantW = Math.ceil((box.r1 - box.r0) / 2 + FOOT_MARGIN), wantH = Math.ceil((box.u1 - box.u0) / 2 + FOOT_MARGIN);
      let changed = false;
      if (wantW > ext.hw || wantW < ext.hw - 1) { ext.hw = wantW; changed = true; }
      if (wantH > ext.hh || wantH < ext.hh - 1) { ext.hh = wantH; changed = true; }
      if (changed) {
        sc.left = -ext.hw; sc.right = ext.hw; sc.top = ext.hh; sc.bottom = -ext.hh;
        sc.updateProjectionMatrix();
      }
      cr = (box.r0 + box.r1) / 2; cu = (box.u0 + box.u1) / 2;
    } else {
      cr = tx * right.x + tz * right.z; cu = tx * upL.x + tz * upL.z;
    }
    // snap the centre to whole texels in the light's view plane
    const texR = (ext.hw * 2) / mapSize, texU = (ext.hh * 2) / mapSize;
    cr = Math.round(cr / texR) * texR;
    cu = Math.round(cu / texU) * texU;
    // the world point with light-space coords (cr, cu) that lies on the ground plane
    const s = -(upL.y * cu) / SUN_DIR.y;
    focus.copy(right).multiplyScalar(cr).addScaledVector(upL, cu).addScaledVector(SUN_DIR, s);
    sun.target.position.copy(focus);
    sun.position.copy(focus).addScaledVector(SUN_DIR, SUN_DIST);
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();
  };

  // ---- warmth (camp level 0 is cold) ----
  let lastWarm = -1;
  const applyWarmth = w => {
    if (Math.abs(w - lastWarm) < 1e-4) return;
    lastWarm = w;
    const L = (a, b) => a + (b - a) * w;
    sun.color.copy(coldC.sun).lerp(warmC.sun, w);
    sun.intensity = L(RIG.cold.sunI, RIG.warm.sunI);
    hemi.color.copy(coldC.sky).lerp(warmC.sky, w);
    hemi.groundColor.copy(coldC.ground).lerp(warmC.ground, w);
    hemi.intensity = L(RIG.cold.hemiI, RIG.warm.hemiI);
    sun.shadow.intensity = L(RIG.cold.shadow, RIG.warm.shadow);
  };
  applyWarmth(mood.warmth);
  place();

  return {
    sun, hemi, mood,
    sunDirection: SUN_DIR.clone(),
    get shadowExtent() { return { halfWidth: ext.hw, halfHeight: ext.hh, mapSize }; },
    // how far (world units from the camera target) the shadow frustum reaches at most
    shadowReach: footFar,
    update(dt) {
      mood.update(dt);
      applyWarmth(mood.warmth);
      place();
    },
  };
}
