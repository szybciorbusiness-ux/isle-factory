// Diorama camera: narrow-FOV perspective at a high pitch. Follows the player's smoothed position with a
// critically damped spring (no overshoot, no jitter at any frame rate) plus a small look-ahead in the walking
// direction that eases in and out; the lead slightly exceeds the follow lag, so walking never feels like the
// camera is dragging behind. Smooth wheel / pinch zoom, a dt-driven shake, and portrait framing (about 6.75
// tiles across a phone's width, so the robot and stations read). Honours ctx.debug.cam = [x, z, dist?] as a fixed
// camera for tests.
//
// Camp mode: the camera pulls back a touch with every camp level, and on hearth:level it breathes out (a quick
// ease-out to a little farther, then a slow settle at the new level's distance) over the warm wave's 1.2 s,
// timed from views.lighting.mood.wave when the world runs one.
import * as THREE from 'three';

const FOV = 30;
const PITCH = THREE.MathUtils.degToRad(58);
// Landscape: 20 matches the reference's tile size (~100 px per tile at 1920x1080; sky.js / lighting.js mirror it).
const DEFAULT_DIST = 20;
const PORTRAIT_TILES = 6.75;  // tiles across the width on portrait screens
const LEVEL_PULL = 0.032;     // camp: extra distance per camp level (x1.16 at level 5)
const BEAT_T = 1.2;           // hearth:level beat length (s), the world's warm-wave time
const BEAT_AMP = 0.055;       // how far the beat breathes out (fraction of the distance)
const BEAT_PEAK = 0.26;       // fraction of the beat spent easing out (the rest settles)
const ZOOM_MIN = 0.68, ZOOM_MAX = 1.7; // wheel / pinch range, relative to the default distance
const OMEGA = 12;             // follow spring rate (1/s), critically damped: steady lag = 2 v / OMEGA (0.17 s of travel)
const LEAD_T = 0.26;          // look-ahead: seconds of player velocity (> 2 / OMEGA, so the lag is covered)
const LEAD_MAX = 1.15;        // tiles
const LEAD_IN = 3.2, LEAD_OUT = 2.2; // how fast the look-ahead builds up / relaxes (per second)
const ZOOM_SMOOTH = 0.14;

// Exact critically damped spring (x'' = w^2 (g - x) - 2 w x') whose goal moves linearly from g0 to g1 during
// the frame. Closed form, so the result is the same at any frame rate and a steadily moving goal is followed
// with a perfectly constant lag: no jitter even when dt varies every frame.
function critFollow(x0, v0, g0, g1, w, dt) {
  const vg = (g1 - g0) / dt;
  const yp = (-2 * vg) / w;                   // steady-state offset behind a goal moving at vg
  const A = x0 - g0 - yp, B = v0 - vg + w * A;
  const e = Math.exp(-w * dt);
  const y = yp + (A + B * dt) * e;
  const vy = (B - w * (A + B * dt)) * e;
  return [g1 + y, vg + vy];
}
// Critically damped spring toward a moving target (Game Programming Gems 4 "SmoothDamp"), used for zoom.
function smoothDamp(cur, target, st, key, smoothTime, dt) {
  const omega = 2 / smoothTime, x = omega * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target;
  const temp = (st[key] + omega * change) * dt;
  st[key] = (st[key] - omega * temp) * e;
  return target + (change + temp) * e;
}

export function create(ctx) {
  const { camera, sim, debug, anim, views, events } = ctx;
  const { damp, clamp, ease, lerp } = anim;
  const camp = ctx.camp || null;

  camera.fov = FOV;
  camera.near = 0.5;
  camera.far = 300;
  camera.updateProjectionMatrix();

  const fixed = Array.isArray(debug.cam) && debug.cam.length >= 2 && debug.cam.every(Number.isFinite) ? debug.cam : null;
  const target = { x: sim.player.x, z: sim.player.z };   // current look-at point on the ground (mutated in place)
  const vel = { x: 0, z: 0, d: 0 };
  const ahead = { x: 0, z: 0 };
  let zoomMul = 1, wantZoom = 1;
  let baseDist = DEFAULT_DIST;
  let distance = fixed?.[2] || DEFAULT_DIST;
  const pp = new THREE.Vector3(), last = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3();
  let haveLast = false;
  const goal = { x: 0, z: 0 };
  let haveGoal = false;
  let shakeAmp = 0, shakeT = 0;

  const playerPos = out => views.player?.getPosition?.(out) || out.set(sim.player.x, 0, sim.player.z);

  // Distance that frames the default view for this aspect: landscape keeps the reference scale, portrait keeps
  // about PORTRAIT_TILES tiles across the width (the visible width at the target is 2 d tan(fov/2) aspect).
  function frameDistance(aspect) {
    if (!(aspect > 0)) return DEFAULT_DIST;
    const tanH = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const d = PORTRAIT_TILES / (2 * tanH * aspect);
    return aspect >= 1 ? DEFAULT_DIST : Math.max(DEFAULT_DIST, d);
  }
  baseDist = frameDistance(camera.aspect);
  // camp level pull-back + the level-up beat
  const levelMulOf = lv => 1 + LEVEL_PULL * clamp(Number(lv) || 0, 0, 6);
  let levelMul = camp ? levelMulOf(camp.level) : 1;
  const beat = { t: -1, from: levelMul, to: levelMul, bump: 0 };
  const beatProgress = () => {
    const w = views.lighting?.mood?.wave;
    if (w?.active && Number.isFinite(w.t) && w.t <= beat.t + 0.1) return clamp(w.t / BEAT_T);
    return clamp(beat.t / BEAT_T);
  };
  function updateLevel(dt) {
    if (!camp) return;
    if (beat.t >= 0) {
      beat.t += dt;
      const k = beatProgress();
      levelMul = lerp(beat.from, beat.to, ease.sineInOut(k));
      beat.bump = k < BEAT_PEAK ? ease.quadOut(k / BEAT_PEAK) : 1 - ease.sineInOut((k - BEAT_PEAK) / (1 - BEAT_PEAK));
      if (k >= 1) { beat.t = -1; beat.bump = 0; levelMul = beat.to; }
    } else {
      // the level changed without the event (restored state, tests): ease there
      levelMul = damp(levelMul, levelMulOf(camp.level), 3, dt);
    }
  }
  const offLevel = camp && events?.on ? events.on('hearth:level', ({ level } = {}) => {
    beat.from = levelMul;
    beat.to = levelMulOf(Number.isFinite(level) ? level : camp.level);
    beat.t = 0;
  }) : null;

  const wantDist = () => (fixed?.[2] ? fixed[2] : baseDist * zoomMul * levelMul * (1 + BEAT_AMP * beat.bump));
  distance = wantDist();

  function place(sx = 0, sy = 0) {
    const cy = Math.sin(PITCH) * distance, cz = Math.cos(PITCH) * distance;
    camera.position.set(target.x, cy, target.z + cz);
    camera.lookAt(target.x, 0, target.z);
    if (sx || sy) {
      // translate in the screen plane so the shake never tilts the horizon
      camera.updateMatrix();
      right.setFromMatrixColumn(camera.matrix, 0);
      up.setFromMatrixColumn(camera.matrix, 1);
      camera.position.addScaledVector(right, sx).addScaledVector(up, sy);
    }
    camera.updateMatrixWorld();
  }

  function snap() {
    if (fixed) { target.x = fixed[0]; target.z = fixed[1]; }
    else { playerPos(pp); target.x = pp.x; target.z = pp.z; last.copy(pp); haveLast = true; }
    ahead.x = ahead.z = 0;
    vel.x = vel.z = vel.d = 0;
    haveGoal = false;
    zoomMul = wantZoom;
    distance = wantDist();
    place();
  }
  snap();

  function update(dt) {
    if (!(dt > 0)) return;
    zoomMul = smoothDamp(zoomMul, wantZoom, vel, 'd', ZOOM_SMOOTH, dt);
    updateLevel(dt);
    distance = wantDist();

    if (fixed) {
      target.x = fixed[0]; target.z = fixed[1];
    } else {
      playerPos(pp);
      if (!haveLast || (pp.x - last.x) ** 2 + (pp.z - last.z) ** 2 > 9) { snap(); } // teleport: cut, don't swoop
      last.copy(pp);
      // look-ahead from the player's own smoothed velocity (never from noisy position differences)
      const v = views.player?.velocity;
      let lx = (Number.isFinite(v?.x) ? v.x : 0) * LEAD_T, lz = (Number.isFinite(v?.z) ? v.z : 0) * LEAD_T;
      const l = Math.hypot(lx, lz);
      if (l > LEAD_MAX) { lx *= LEAD_MAX / l; lz *= LEAD_MAX / l; }
      const growing = lx * ahead.x + lz * ahead.z >= ahead.x * ahead.x + ahead.z * ahead.z - 1e-6 && l > 1e-3;
      const k = growing ? LEAD_IN : LEAD_OUT;
      ahead.x = damp(ahead.x, lx, k, dt);
      ahead.z = damp(ahead.z, lz, k, dt);
      const gx = pp.x + ahead.x, gz = pp.z + ahead.z;
      if (!haveGoal) { goal.x = gx; goal.z = gz; haveGoal = true; }
      [target.x, vel.x] = critFollow(target.x, vel.x, goal.x, gx, OMEGA, dt);
      [target.z, vel.z] = critFollow(target.z, vel.z, goal.z, gz, OMEGA, dt);
      goal.x = gx; goal.z = gz;
    }

    // shake: two detuned sines per axis under an exponential envelope
    let sx = 0, sy = 0;
    if (shakeAmp > 1e-4) {
      shakeT += dt;
      shakeAmp *= Math.exp(-7.5 * dt);
      sx = shakeAmp * (0.62 * Math.sin(shakeT * 47.0) + 0.38 * Math.sin(shakeT * 83.0 + 1.3));
      sy = shakeAmp * (0.62 * Math.sin(shakeT * 53.0 + 0.7) + 0.38 * Math.sin(shakeT * 91.0 + 2.1));
    } else shakeAmp = 0;
    place(sx, sy);
  }

  function resize(w, h) {
    baseDist = frameDistance(w / h);
    if (!fixed) { distance = wantDist(); place(); }
  }

  return {
    target,
    get distance() { return distance; },
    get baseDistance() { return baseDist; },
    get pitch() { return PITCH; },
    get fov() { return FOV; },
    get lookAhead() { return { x: ahead.x, z: ahead.z }; },
    // camp: distance multiplier from the camp level, and the level-up beat (0..1, 0 = at rest)
    get levelMul() { return levelMul; },
    get beat() { return beat.bump; },
    get portraitTiles() { return PORTRAIT_TILES; },
    // amount ~ world units of peak offset: 0.03 a tool hit, 0.08 a tree falling, 0.15 something big
    shake(amount = 0.05) {
      shakeAmp = clamp(Math.max(shakeAmp, amount) + amount * 0.25, 0, 0.4);
      shakeT = 0;
    },
    // deltaY from a wheel event (pixels); positive zooms out
    zoom(deltaY) {
      wantZoom = clamp(wantZoom * Math.exp(clamp(deltaY, -200, 200) * 0.0011), ZOOM_MIN, ZOOM_MAX);
    },
    // multiply the zoom (pinch: factor = startDistance / currentDistance between fingers, > 1 zooms out)
    zoomBy(factor) {
      if (Number.isFinite(factor) && factor > 0) wantZoom = clamp(wantZoom * factor, ZOOM_MIN, ZOOM_MAX);
    },
    get zoomLevel() { return wantZoom; },
    setZoomLevel(z) { if (Number.isFinite(z)) wantZoom = clamp(z, ZOOM_MIN, ZOOM_MAX); },
    setDistance(d) { if (Number.isFinite(d) && d > 0) wantZoom = clamp(d / baseDist, ZOOM_MIN, ZOOM_MAX); },
    snap,
    update,
    resize,
    dispose() { offLevel?.(); },
  };
}
