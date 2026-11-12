// Diorama camera: narrow-FOV perspective at a high pitch. Follows the player's smoothed position with a
// critically damped spring (no overshoot, no jitter at any frame rate). The look-ahead is a share (LEAD) of that
// spring's own lag, so the two are one signal and settle together: while walking the camera trails Dug by a hair
// (~0.2 tiles at full speed) and when he stops or turns it eases in to rest without ever passing him or drifting
// back. Smooth wheel / pinch zoom, a dt-driven shake, and portrait framing (about 6.75 tiles across a phone's
// width, so the character and stations read). Honours ctx.debug.cam = [x, z, dist?] as a fixed camera for tests.
//
// Framing (camp mode): the follow target leans toward the guide's current goal (camp.goal), up to ~1.5 tiles in
// portrait (less in landscape), so less of the phone is empty water and the next thing is on screen. The goal
// point is smoothed (a new goal glides in) but the lean is a pure function of the player's position, so a stop
// never leaves anything to drift. Portrait also leans up to ~1 tile sideways away from open water (also a pure
// function of the position). When a bridge goes up (bridge:start, as the planks fly in) the target eases
// 1.5–2.5 tiles toward the new isle's landing over 1.2 s, holds until a beat after bridge:built, then lets go
// (skipped, or released early, when the player walks the other way).
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
const OMEGA = 14;             // follow spring rate (1/s), critically damped: steady lag = 2 v / OMEGA (0.14 s of travel)
const OMEGA_NEAR = 30;        // a second, tighter spring: the look-ahead aims at it, not at the raw position, so a
                              // dead stop (walking into a tree) still eases out instead of stopping in one frame
const LEAD = 0.75;            // look-ahead = this share of the gap between the two springs (< 1: a stop closes monotonically)
const ZOOM_SMOOTH = 0.14;
// framing toward the guide's goal (camp.goal)
const GOAL_MAX_PORTRAIT = 1.5, GOAL_MAX_LANDSCAPE = 0.75; // tiles of lean at most (blended by aspect)
const GOAL_K = 0.38;          // lean per tile of distance to the goal (it fades out as the goal gets close)
const GOAL_SMOOTH = 0.3;      // s: how a goal point that moves a little (an animal) glides after it
const GOAL_GLIDE = 1.6;       // tiles: a goal further than this from the last one cross-fades in instead
const GOAL_FADE = 4.5;        // 1/s: critically damped cross-fade between goals (~0.9 s), and in / out
// portrait: lean away from open water toward land (x only: the phone is narrow, tall is fine)
const LAND_MAX = 1.3;         // tiles at most, with land on one side only
const LAND_R = 3.75;          // how far to each side we look (tiles): about the phone's half width
// bridge nudge toward the new isle's landing (starts as the planks fly in, holds until the bridge is built)
const NUDGE_MIN = 1.5, NUDGE_MAX = 2.5, NUDGE_K = 0.6; // amount = clamp(K * distance to the landing)
const NUDGE_IN = 1.2, NUDGE_HOLD = 0.6, NUDGE_OUT = 1.0, NUDGE_QUIT = 0.45; // s
const NUDGE_AWAY = 1.2;       // tiles/s of walking away from the landing that skips / releases the nudge
const LEAN_MAX_X_PORTRAIT = 1.5; // goal + land lean across a phone's width at most (Dug stays well inside)
const FRAME_MAX = 2.6;        // cap on all framing together, the bridge nudge included (tiles)

// Exact critically damped spring (x'' = w^2 (g - x) - 2 w x') whose goal moves linearly from g0 to g1 during
// the frame. Closed form, so the result is the same at any frame rate and a steadily moving goal is followed
// with a perfectly constant lag: no jitter even when dt varies every frame. From a steady lag, a goal that
// stops is approached from behind without overshoot.
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
  const map = ctx.map || null;

  camera.fov = FOV;
  camera.near = 0.5;
  camera.far = 300;
  camera.updateProjectionMatrix();

  const fixed = Array.isArray(debug.cam) && debug.cam.length >= 2 && debug.cam.every(Number.isFinite) ? debug.cam : null;
  const target = { x: sim.player.x, z: sim.player.z };   // current look-at point on the ground (mutated in place)
  const vel = { x: 0, z: 0, d: 0 };
  const follow = { x: target.x, z: target.z };            // the spring's position (target = follow + LEAD * lag)
  const near = { x: target.x, z: target.z, vx: 0, vz: 0 }; // the tight spring
  let zoomMul = 1, wantZoom = 1;
  let baseDist = DEFAULT_DIST;
  let distance = fixed?.[2] || DEFAULT_DIST;
  const pp = new THREE.Vector3(), last = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3();
  let haveLast = false;
  const goal = { x: 0, z: 0 };    // last frame's spring goal (player + framing)
  let haveGoal = false;
  let shakeAmp = 0, shakeT = 0;
  // framing: the lean toward camp.goal and the bridge nudge
  const frame = { x: 0, z: 0 };
  const lean = { w: 0, max: GOAL_MAX_PORTRAIT };
  const nudgeOff = { x: 0, z: 0 };
  let nudge = null;               // { ux, uz, amt, t, quit: null | { from, t } }

  const playerPos = out => views.player?.getPosition?.(out) || out.set(sim.player.x, 0, sim.player.z);

  // Distance that frames the default view for this aspect: landscape keeps the reference scale, portrait keeps
  // about PORTRAIT_TILES tiles across the width (the visible width at the target is 2 d tan(fov/2) aspect).
  function frameDistance(aspect) {
    if (!(aspect > 0)) return DEFAULT_DIST;
    const tanH = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    const d = PORTRAIT_TILES / (2 * tanH * aspect);
    return aspect >= 1 ? DEFAULT_DIST : Math.max(DEFAULT_DIST, d);
  }
  const leanMaxFor = aspect => lerp(GOAL_MAX_PORTRAIT, GOAL_MAX_LANDSCAPE, clamp(((aspect || 1) - 0.6) / 0.6));
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
  const offs = [];
  if (camp && events?.on) {
    offs.push(events.on('hearth:level', ({ level } = {}) => {
      beat.from = levelMul;
      beat.to = levelMulOf(Number.isFinite(level) ? level : camp.level);
      beat.t = 0;
    }));
    const safe = fn => ev => { try { fn(ev || {}); } catch (e) { console.error('[camera] bridge nudge', e); } };
    offs.push(events.on('bridge:start', safe(({ bridge }) => startNudge(bridge))));
    offs.push(events.on('bridge:built', safe(({ bridge }) => {
      // already easing toward it: hold a beat past now; otherwise (no start seen) play it from here
      if (nudge && nudge.id === bridge?.id) nudge.builtT = nudge.t;
      else if (startNudge(bridge)) nudge.builtT = 0;
    })));
  }

  // ---------- framing ----------
  // The guide's goal as a ground point, or null (none yet, the boot intro, a goal without a place).
  function goalPoint() {
    if (!camp || views.player?.booting) return null;
    const g = camp.goal;
    return g && Number.isFinite(g.x) && Number.isFinite(g.z) ? g : null;
  }
  // Lean toward the goal: a blend of leans toward recent goal points. Each lean is a pure function of the player's
  // position (so a stop leaves nothing to settle); only the blend weights move with time, on critically damped
  // springs, so a new goal cross-fades in (the camera glides over, no snap and no sweep through the player).
  // A goal that only moves a little (a wandering animal) glides its point instead of starting a new entry.
  // Saturation is smooth (tanh), so walking toward a goal never kinks the camera's speed.
  const leans = [];               // { x, z, vx, vz, w, wv }
  function leanOne(e, px, pz, out) {
    const dx = e.x - px, dz = e.z - pz, d = Math.hypot(dx, dz);
    const m = d > 1e-4 ? (lean.max * Math.tanh((GOAL_K * d) / lean.max) * e.w) / d : 0;
    out.x += dx * m; out.z += dz * m;
  }
  function leanFrom(px, pz, out) {
    out.x = out.z = 0;
    for (const e of leans) leanOne(e, px, pz, out);
    return out;
  }
  function updateLean(dt) {
    const g = goalPoint();
    let top = leans[leans.length - 1];
    if (g) {
      if (top && Math.hypot(g.x - top.x, g.z - top.z) < GOAL_GLIDE) {
        top.x = smoothDamp(top.x, g.x, top, 'vx', GOAL_SMOOTH, dt);
        top.z = smoothDamp(top.z, g.z, top, 'vz', GOAL_SMOOTH, dt);
      } else if (top && top.w < 0.02 && leans.length === 1) { top.x = g.x; top.z = g.z; top.vx = top.vz = 0; }
      else { top = { x: g.x, z: g.z, vx: 0, vz: 0, w: 0, wv: 0 }; leans.push(top); }
    }
    // weights: the newest entry (while there is a goal) springs to 1, every other to 0
    const k = GOAL_FADE, e = Math.exp(-k * dt);
    let sum = 0;
    for (const L of leans) {
      const want = g && L === top ? 1 : 0;
      const y = L.w - want, A = y, B = L.wv + k * y;           // exact critically damped step toward want
      L.w = want + (A + B * dt) * e; L.wv = (B - k * (A + B * dt)) * e;
      sum += L.w;
    }
    for (let i = leans.length - 1; i >= 0; i--) if (leans[i] !== top && Math.abs(leans[i].w) < 2e-3 && Math.abs(leans[i].wv) < 0.02) leans.splice(i, 1);
    if (leans.length > 6) leans.splice(0, leans.length - 6);
    lean.w = sum;
  }
  // The landing tile of a bridge: one step past its last plank, away from the camp.
  function landingOf(bridge) {
    const tiles = bridge?.tiles || map?.bridges?.[bridge?.id]?.tiles;
    if (!Array.isArray(tiles) || !tiles.length) return null;
    const a = tiles[0], b = tiles[tiles.length - 1];
    let dx = Math.sign(b[0] - a[0]), dz = Math.sign(b[1] - a[1]);
    if (!dx && !dz) {
      // a one-plank bridge: step toward whichever side is land that isn't the player's side
      const o = bridge?.orientation ?? map?.bridges?.[bridge?.id]?.orientation;
      const ax = o === 2 ? 0 : 1, az = o === 2 ? 1 : 0;
      playerPos(pp);
      const s = (b[0] - pp.x) * ax + (b[1] - pp.z) * az >= 0 ? 1 : -1;
      dx = ax * s; dz = az * s;
    }
    return { x: b[0] + dx, z: b[1] + dz };
  }
  function startNudge(bridge) {
    if (fixed) return false;
    const L = landingOf(bridge);
    if (!L) return false;
    playerPos(pp);
    const dx = L.x - pp.x, dz = L.z - pp.z, d = Math.hypot(dx, dz);
    if (d < 1) return false;                            // already there
    const ux = dx / d, uz = dz / d;
    const v = views.player?.velocity;
    const along = (Number(v?.x) || 0) * ux + (Number(v?.z) || 0) * uz;
    if (along < -NUDGE_AWAY) return false;              // walking the other way: leave the camera with the player
    nudge = { id: bridge?.id ?? null, ux, uz, amt: Math.min(d, clamp(NUDGE_K * d, NUDGE_MIN, NUDGE_MAX)), t: 0, quit: null, builtT: -1 };
    return true;
  }
  function updateNudge(dt) {
    nudgeOff.x = nudgeOff.z = 0;
    if (!nudge) return;
    const n = nudge;
    n.t += dt;
    let env;
    if (n.quit) {
      n.quit.t += dt;
      env = n.quit.from * (1 - ease.sineInOut(clamp(n.quit.t / NUDGE_QUIT)));
      if (n.quit.t >= NUDGE_QUIT) { nudge = null; return; }
    } else if (n.t < NUDGE_IN) env = ease.sineInOut(n.t / NUDGE_IN);
    else {
      // hold until NUDGE_HOLD past both the ease-in and the bridge being built (or 2.5 s, if it never reports)
      const holdEnd = Math.max(NUDGE_IN, n.builtT >= 0 ? n.builtT : Math.min(n.t, 2.5)) + NUDGE_HOLD;
      if (n.t < holdEnd) env = 1;
      else if (n.t < holdEnd + NUDGE_OUT) env = 1 - ease.sineInOut((n.t - holdEnd) / NUDGE_OUT);
      else { nudge = null; return; }
    }
    if (!n.quit) {
      // the player heads the other way: let go now (quickly, but still eased)
      const v = views.player?.velocity;
      const along = (Number(v?.x) || 0) * n.ux + (Number(v?.z) || 0) * n.uz;
      if (along < -NUDGE_AWAY) n.quit = { from: env, t: 0 };
    }
    nudgeOff.x = n.ux * n.amt * env; nudgeOff.z = n.uz * n.amt * env;
  }
  // Land coverage at a point, bilinear between tile centres (so the lean below is continuous in the position).
  const ground = (x, z) => (map?.isGround ? (map.isGround(x, z) ? 1 : 0) : map?.isLand?.(x, z) ? 1 : 0);
  function landAt(x, z) {
    const x0 = Math.floor(x), z0 = Math.floor(z), ux = x - x0, uz = z - z0;
    const fx = ux * ux * (3 - 2 * ux), fz = uz * uz * (3 - 2 * uz);   // smoothstep: no speed kinks at tile lines
    const a = ground(x0, z0), b = ground(x0 + 1, z0), c = ground(x0, z0 + 1), d = ground(x0 + 1, z0 + 1);
    return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
  }
  // Sideways lean toward land: (land fraction on the right - on the left), weighted toward the player.
  function landLeanX(px, pz) {
    if (!(landK > 0) || !map) return 0;
    let r = 0, rw = 0, l = 0, lw = 0;
    for (let s = 0.75; s <= LAND_R + 1e-6; s += 0.5) {
      const w = 1 - 0.35 * (s / LAND_R);
      for (let t = -2; t <= 2; t++) {
        const wt = w * (1 - Math.abs(t) * 0.18);
        r += wt * landAt(px + s, pz + t); rw += wt;
        l += wt * landAt(px - s, pz + t); lw += wt;
      }
    }
    return LAND_MAX * landK * (r / rw - l / lw);
  }
  let landK = 0, leanMaxX = FRAME_MAX;
  function setAspect(aspect) {
    lean.max = leanMaxFor(aspect);
    const portrait = clamp(((aspect || 1) - 1.0) / -0.4);   // 1 at aspect <= 0.6, 0 at >= 1
    landK = camp ? portrait : 0;
    leanMaxX = lerp(FRAME_MAX, LEAN_MAX_X_PORTRAIT, portrait);
  }
  const tmpLean = { x: 0, z: 0 };
  // a smooth limiter: ~identity well below m, approaches m (no kink, so the camera's speed never jumps)
  const softCap = (v, m) => v / Math.pow(1 + Math.pow(Math.abs(v) / m, 4), 0.25);
  function framingAt(px, pz) {
    leanFrom(px, pz, tmpLean);
    let land = landLeanX(px, pz);
    // the guide's lean wins over the land lean when they pull opposite ways (the goal may be across the water)
    if (land * tmpLean.x < 0) land *= 1 - 0.75 * clamp(Math.abs(tmpLean.x) / Math.max(0.1, lean.max));
    let fx = softCap(tmpLean.x + land, leanMaxX) + nudgeOff.x, fz = tmpLean.z + nudgeOff.z;
    const l = Math.hypot(fx, fz), k = l > 1e-6 ? softCap(l, FRAME_MAX) / l : 1;
    frame.x = fx * k; frame.z = fz * k;
    return frame;
  }
  setAspect(camera.aspect);

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
    else {
      playerPos(pp); last.copy(pp); haveLast = true;
      // framing jumps straight to its resting value (a cut, not a swoop)
      const g = goalPoint();
      leans.length = 0;
      if (g) leans.push({ x: g.x, z: g.z, vx: 0, vz: 0, w: 1, wv: 0 });
      lean.w = g ? 1 : 0;
      framingAt(pp.x, pp.z);
      target.x = follow.x = near.x = pp.x + frame.x; target.z = follow.z = near.z = pp.z + frame.z;
      near.vx = near.vz = 0;
    }
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
      updateLean(dt);
      updateNudge(dt);
      framingAt(pp.x, pp.z);
      const gx = pp.x + frame.x, gz = pp.z + frame.z;
      if (!haveGoal) { goal.x = gx; goal.z = gz; haveGoal = true; }
      [follow.x, vel.x] = critFollow(follow.x, vel.x, goal.x, gx, OMEGA, dt);
      [follow.z, vel.z] = critFollow(follow.z, vel.z, goal.z, gz, OMEGA, dt);
      [near.x, near.vx] = critFollow(near.x, near.vx, goal.x, gx, OMEGA_NEAR, dt);
      [near.z, near.vz] = critFollow(near.z, near.vz, goal.z, gz, OMEGA_NEAR, dt);
      goal.x = gx; goal.z = gz;
      // look-ahead: cover LEAD of the slow spring's lag behind the tight one. Both approach a stop from behind
      // without overshoot, so their blend does too, and it settles with them: no swing past, no drift back.
      target.x = follow.x + LEAD * (near.x - follow.x);
      target.z = follow.z + LEAD * (near.z - follow.z);
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
    setAspect(w / h);
    if (!fixed) { distance = wantDist(); place(); }
  }

  return {
    target,
    get distance() { return distance; },
    get baseDistance() { return baseDist; },
    get pitch() { return PITCH; },
    get fov() { return FOV; },
    // the look-ahead currently applied on top of the spring (tiles)
    get lookAhead() { return { x: target.x - follow.x, z: target.z - follow.z }; },
    // framing offset the follow aims at, on top of the player: lean toward the goal + bridge nudge (tiles)
    get framing() { return { x: frame.x, z: frame.z, lean: lean.w, land: landLeanX(last.x, last.z), nudge: nudge ? Math.hypot(nudgeOff.x, nudgeOff.z) : 0 }; },
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
    // test hook: play the bridge nudge for a bridge id ('west' | 'north' | 'east' | 'south') or object
    nudgeToBridge(b) { startNudge(typeof b === 'string' ? { id: b } : b); return !!nudge; },
    snap,
    update,
    resize,
    dispose() { offs.forEach(f => f?.()); },
  };
}
