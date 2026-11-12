// Player: a little robot engineer with free, smooth 8-direction movement.
//
// Movement (src/view/player/motion.js): key STATE (WASD / arrows by e.code, cleared on blur and when the tab is
// hidden) plus the analog stick in ctx.input.move. Velocity eases toward the wanted velocity (90% in 0.1 s, at
// rest in 0.08 s), heading follows the velocity, a circle collides with non-walkable tiles (slides along walls,
// corner forgiveness toward gaps, sub-stepped). Runs every frame at render dt: no grid, no fixed step.
//
// Animation: a bouncy little trot whose cadence is tied to distance travelled (planted feet, no sliding), lean
// into acceleration, bank into turns, a settle on stopping, a spring antenna bulb, a lagging power-pack that puffs
// now and then, an expressive visor face (blinks, looks into turns, squints when striking, looks around when idle).
// Everything is driven by the dt passed to update(dt) — see DESIGN.md "Motion principles".
import * as THREE from 'three';
import { buildRobot, FOOT_Z } from './player/model.js';
import { createMotion, RADIUS } from './player/motion.js';
import { smoothPath } from './player/path.js';

const MOVE_KEYS = {
  KeyW: [0, -1], ArrowUp: [0, -1], KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0],
};

// ---- tuning ----
const SCALE = 1.3;               // model units -> world (~0.9 tiles tall, like the reference character)
const SCALE_MOBILE = 1.5;        // a touch bigger on phones, where the camera sits farther out
const STRIDE = [0.5, 1.0];        // world distance per full gait cycle (two steps), slow .. full speed
const DUTY = [0.55, 0.3];         // fraction of a cycle each foot is planted: walk (overlap) .. trot (flight)
const LIFT = 0.075;              // foot lift (model units)
const BOB = 0.05;                // body bounce per step (model units)
const STEP_SQUASH = 0.05;        // squash at each foot contact
const ROLL = 0.085;              // waddle roll toward the planted foot
const ARM_SWING = 0.55;          // arm counter-swing (rad)
const ARM_REST = 0.12;           // arms hang a touch forward
const LEAN_SPEED = 0.1;          // forward lean at full speed
const LEAN_ACC = 0.011;          // lean per tile/s^2 of forward acceleration
const BANK_ACC = 0.012;          // bank per tile/s^2 of sideways (turning) acceleration
const WIND = 0.13, STRIKE = 0.07, FOLLOW = 0.2;
const SWING_T = WIND + STRIKE + FOLLOW;
const SWING_CHAIN = 0.06;        // a new swing may take over during the last bit of follow-through
const ARM_WIND = 2.75, ARM_STRIKE = 0.8, ARM_OVER = 0.55, ARM_CARRY = 0.85; // carry: hand low and forward ...
const WRIST_CARRY = 2.55;        // ... with the wrist turned so the tool stands upright by the shoulder
const TOOL_LINGER = 0.32;        // the tool stays out this long after a swing (covers the gap between chained hits)
const TOOL_GRIP = Math.PI - 0.55; // tool angle relative to the arm: handle out past the mitt, head forward
const CELEB_CROUCH = 0.1, CELEB_AIR = 0.5, BOUNCE_T = 0.26;

const TAU = Math.PI * 2;
const frac = v => v - Math.floor(v);
const smooth = t => t * t * (3 - 2 * t);
const isTyping = e => {
  const t = e.target;
  return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
};
const dirHeading = d => (d * Math.PI) / 2; // atan2(dz, dx) of DIRS[d]
const cardinalOf = h => ((Math.round(h / (Math.PI / 2)) % 4) + 4) % 4;

export function create(ctx) {
  const { scene, sim, config, anim, events, views } = ctx;
  const { Spring, ease, clamp, lerp, arc, damp, angleDelta } = anim;
  const { PLAYER, PALETTE } = config;
  const SPEED = PLAYER.moveSpeed || 4.2;
  const scale = ctx.mobile ? SCALE_MOBILE : SCALE;

  const rig = buildRobot(PALETTE);
  rig.root.scale.setScalar(scale);
  scene.add(rig.root);

  const walk = (x, z) => sim.isWalkable(x, z);
  const motion = createMotion({ isWalkable: walk, moveSpeed: SPEED, x: sim.player.x, z: sim.player.z, heading: dirHeading(sim.player.dir) });
  const s = motion.state;
  let lastSent = { x: sim.player.x, z: sim.player.z, dir: sim.player.dir };

  // ---------- input: key state, not key repeat ----------
  const held = new Set();
  const onKeyDown = e => {
    if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!MOVE_KEYS[e.code]) return;
    e.preventDefault();
    held.add(e.code);
  };
  const onKeyUp = e => { if (MOVE_KEYS[e.code]) held.delete(e.code); };
  const clearKeys = () => held.clear();
  const onVis = () => { if (document.hidden) clearKeys(); };
  addEventListener('keydown', onKeyDown);
  addEventListener('keyup', onKeyUp);
  addEventListener('blur', clearKeys);
  document.addEventListener('visibilitychange', onVis);

  const inp = { x: 0, z: 0 };
  function readInput() {
    let kx = 0, kz = 0;
    for (const code of held) { const v = MOVE_KEYS[code]; kx += v[0]; kz += v[1]; }
    kx = Math.sign(kx); kz = Math.sign(kz);
    const kl = Math.hypot(kx, kz);
    if (kl) { kx /= kl; kz /= kl; }
    const m = ctx.input?.move;
    const ax = Number.isFinite(m?.x) ? m.x : 0, az = Number.isFinite(m?.z) ? m.z : 0;
    let x = kx + ax, z = kz + az;
    const l = Math.hypot(x, z);
    if (l > 1) { x /= l; z /= l; }
    inp.x = x; inp.z = z;
    return l > 0.04;
  }

  // ---------- state ----------
  let steering = false;
  let groundY = 0;
  let phase = 0, gait = 0, prevHeading = s.heading;
  const accel = { x: 0, z: 0 };
  let prevVx = 0, prevVz = 0, prevSpd = 0, wasMoving = false;
  const squash = new Spring(1, { stiffness: 340, damping: 13 });
  const lean = new Spring(0, { stiffness: 240, damping: 15 });
  const bank = new Spring(0, { stiffness: 220, damping: 15 });
  const ant = { z1: new Spring(0, { stiffness: 150, damping: 6.5 }), x1: new Spring(0, { stiffness: 150, damping: 6.5 }),
    z2: new Spring(0, { stiffness: 190, damping: 7 }), x2: new Spring(0, { stiffness: 190, damping: 7 }) };
  const packTilt = new Spring(0, { stiffness: 170, damping: 9 });
  const packRoll = new Spring(0, { stiffness: 170, damping: 9 });
  const packBob = new Spring(0, { stiffness: 260, damping: 11 });
  const packPulse = new Spring(1, { stiffness: 300, damping: 12 });
  const toolShow = new Spring(0, { stiffness: 380, damping: 20 });
  const wrist = new Spring(0, { stiffness: 520, damping: 30 });
  const armSpring = { L: new Spring(ARM_REST, { stiffness: 260, damping: 18 }), R: new Spring(ARM_REST, { stiffness: 260, damping: 18 }) };
  const face = { lookX: 0, lookY: 0, open: 1, squint: 0, wide: 0, happy: 0 };
  let lookTX = 0, lookTY = 0, wideT = 0, happyT = 0, lookTimer = 2.5;
  let blinkWait = 1.8, blinkT = -1;
  let action = null;                 // { t, target, onImpact, impacted, a0, side, heading }
  const resid = { lean: 0, lunge: 0, stretch: 0 };
  let swingSide = 1, toolKind = 'axe', toolIdle = 99;
  let faceHeading = null, faceTimer = 0;
  let celebT = -1, bounceT = -1;
  let idleT = 0, glance = 0, glanceTarget = 0, glanceT = 0, nextGlance = 5;
  let puffT = 0.4, clock = 0, gulpGlow = 0;
  let rngState = 7654321;
  const rnd = () => ((rngState = (rngState * 1103515245 + 12345) >>> 0) / 4294967296);

  // ---------- movement ----------
  function teleport(x, z, dir) {
    motion.teleport(x, z, dirHeading(dir));
    action = null; faceHeading = null; faceTimer = 0; motion.face(null);
    prevVx = prevVz = 0; accel.x = accel.z = 0;
    groundY = views.terrain?.groundHeight?.(x, z) ?? 0;
    if (!(groundY > -0.1)) groundY = 0;
    feetReset = true;
  }
  // Someone else moved the player (a scenario, a test): cut there instead of walking.
  function syncExternal() {
    const p = sim.player;
    if (p.x !== lastSent.x || p.z !== lastSent.z) {
      const wx = Number.isFinite(p.wx) ? p.wx : p.x, wz = Number.isFinite(p.wz) ? p.wz : p.z;
      teleport(wx, wz, p.dir);
      lastSent = { x: p.x, z: p.z, dir: p.dir };
    } else if (p.dir !== lastSent.dir) {
      lastSent.dir = p.dir;
      if (!action && s.speed < 0.2) { faceHeading = dirHeading(p.dir); faceTimer = 0.5; }
    }
  }
  function report() {
    const dir = cardinalOf(s.heading);
    if (sim.setPlayerPos) sim.setPlayerPos(s.x, s.z, dir);
    else if (Math.round(s.x) !== sim.player.x || Math.round(s.z) !== sim.player.z || dir !== sim.player.dir) sim.setPlayer(Math.round(s.x), Math.round(s.z), dir);
    lastSent = { x: sim.player.x, z: sim.player.z, dir: sim.player.dir };
  }

  // ---------- actions ----------
  function cancelSwing() {
    if (!action) return;
    const p = swingPose(action);
    resid.lean += p.lean; resid.lunge += p.lunge; resid.stretch += p.stretch;
    action = null;
    toolIdle = 0;
  }
  function swingPose(a) {
    const t = a.t;
    if (t < WIND) {
      const k = ease.quadOut(t / WIND);
      return { arm: lerp(a.a0, ARM_WIND, k), lean: -0.16 * k, lunge: -0.02 * k, stretch: 0.05 * k, squint: 0.6 * k };
    }
    if (t < WIND + STRIKE) {
      const k = ease.cubicIn((t - WIND) / STRIKE);
      return { arm: lerp(ARM_WIND, ARM_STRIKE, k), lean: lerp(-0.16, 0.26, k), lunge: lerp(-0.02, 0.065, k), stretch: lerp(0.05, -0.035, k), squint: lerp(0.6, 1, k) };
    }
    const k = clamp((t - WIND - STRIKE) / FOLLOW);
    const over = Math.sin(Math.min(1, k / 0.35) * Math.PI);
    const back = ease.cubicInOut(clamp((k - 0.3) / 0.7));
    return {
      arm: lerp(ARM_STRIKE - (ARM_STRIKE - ARM_OVER) * over, ARM_CARRY, back),
      lean: 0.26 * (1 - ease.cubicOut(k)), lunge: 0.065 * (1 - ease.cubicOut(k)), stretch: -0.035 * (1 - k), squint: 1 - ease.quadOut(k),
    };
  }
  function startSwing(target, onImpact, tool) {
    const dx = target.x - s.x, dz = target.z - s.z;
    const h = dx * dx + dz * dz > 0.0025 ? Math.atan2(dz, dx) : s.heading;
    toolKind = tool === 'pickaxe' ? 'pickaxe' : 'axe';
    // hold the tool in whichever mitt faces the camera (+z), so the swing is never hidden behind the body
    if (toolShow.value < 0.1) {
      swingSide = Math.cos(h) < -0.2 ? -1 : 1;
      (swingSide > 0 ? rig.handR : rig.handL).add(rig.tool);
    }
    if (action) cancelSwing(); // chaining: the old follow-through blends into the new wind-up
    const arm = swingSide > 0 ? armSpring.R : armSpring.L;
    action = { t: 0, target: { x: target.x, z: target.z }, onImpact, impacted: false, a0: arm.value, heading: h };
    faceHeading = h; faceTimer = WIND + STRIKE + 0.06;
    toolIdle = 0;
  }

  // ---------- per-frame ----------
  const pose = { lean: 0, lunge: 0, stretch: 0, hopExtra: 0, spin: 0, squint: 0, arm: null };
  function advanceActions(dt) {
    pose.lean = pose.lunge = pose.stretch = pose.hopExtra = pose.spin = pose.squint = 0;
    pose.arm = null;
    if (action) {
      action.t += dt;
      if (!action.impacted && action.t >= WIND + STRIKE) {
        action.impacted = true;
        squash.velocity = Math.max(-4, squash.velocity - 2.4);
        lean.kick(1.3);
        ant.z1.kick(-5); ant.z2.kick(-3);
        packTilt.kick(1.4);
        const cb = action.onImpact;
        try { cb?.(); } catch (e) { console.error('[player] swing impact', e); }
      }
      if (action) {
        const p = swingPose(action);
        pose.arm = p.arm; pose.lean += p.lean; pose.lunge += p.lunge; pose.stretch += p.stretch; pose.squint = p.squint;
        if (action.t >= SWING_T) { action = null; toolIdle = 0; }
      }
    } else toolIdle += dt;
    for (const k in resid) { resid[k] = damp(resid[k], 0, 14, dt); pose[k] += resid[k]; }

    if (celebT >= 0) {
      celebT += dt;
      if (celebT < CELEB_CROUCH) pose.stretch -= 0.12 * ease.sineOut(celebT / CELEB_CROUCH);
      else if (celebT < CELEB_CROUCH + CELEB_AIR) {
        const u = (celebT - CELEB_CROUCH) / CELEB_AIR;
        pose.hopExtra += 0.34 * arc(u);
        pose.spin += TAU * ease.cubicInOut(u);
        pose.stretch += 0.12 * Math.sin(Math.PI * Math.min(1, u * 1.4));
      } else {
        celebT = -1;
        squash.velocity = Math.max(-5, squash.velocity - 3.4);
        ant.z1.kick(4); packBob.kick(-0.6);
      }
    }
    if (bounceT >= 0) {
      bounceT += dt;
      if (bounceT < BOUNCE_T) pose.hopExtra += 0.07 * arc(bounceT / BOUNCE_T);
      else { bounceT = -1; squash.velocity = Math.max(-4, squash.velocity - 1.6); ant.z1.kick(2.5); }
    }
  }

  const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
  function placeLeg(leg, hip, foot) {
    hip.getWorldPosition(v1);
    rig.root.worldToLocal(v1);
    v2.set(foot.position.x, foot.position.y + 0.03, foot.position.z);
    v1.sub(v2);
    const len = Math.max(0.01, v1.length());
    leg.position.copy(v2);
    leg.quaternion.setFromUnitVectors(UP, v1.divideScalar(len));
    leg.scale.set(1, len + 0.01, 1);
  }

  // ---------- feet ----------
  const REST_X = 0.012, SETTLE_LIFT = 0.05;
  const mkFoot = (obj, side, off) => ({ obj, side, off, x: 0, z: 0, y: 0, pitch: 0, mode: 'plant', fx: 0, fz: 0, fy: 0, t0: 0, st: 0, dur: 0.12, lift: 1 });
  const feet = [mkFoot(rig.footL, -1, 0), mkFoot(rig.footR, 1, 0.5)];
  const rest = { x: 0, z: 0 };
  let feetReset = true;
  function restSpot(f, theta) {
    const c = Math.cos(theta), sn = Math.sin(theta), bx = rig.root.position.x, bz = rig.root.position.z;
    const a = REST_X * scale, o = f.side * FOOT_Z * scale;
    rest.x = bx + c * a - sn * o; rest.z = bz + sn * a + c * o;
    return rest;
  }
  function updateFeet(dt, moving, D, beta) {
    const theta = s.heading + glance;
    if (!feetReset) for (const f of feet) { const r = restSpot(f, theta); if (Math.hypot(f.x - r.x, f.z - r.z) > 0.7) feetReset = true; }
    if (feetReset || pose.hopExtra > 0.004) {
      // a teleport, or airborne (celebrate / bounce): the feet simply come along under the body
      for (const f of feet) { const r = restSpot(f, theta + pose.spin); f.x = r.x; f.z = r.z; f.y = 0; f.pitch = damp(f.pitch, 0, 20, dt); f.mode = 'plant'; }
      feetReset = false;
      return;
    }
    if (moving) {
      const sp = Math.max(1e-6, s.speed), mx = s.vx / sp, mz = s.vz / sp;
      for (const f of feet) {
        const psi = frac(phase + f.off);
        if (psi >= beta) {
          const t = (psi - beta) / (1 - beta);
          if (f.mode !== 'gait') { f.mode = 'gait'; f.fx = f.x; f.fz = f.z; f.fy = f.y; f.t0 = Math.min(t, 0.9); }
          // land half a stance ahead of where the hip will be when this swing ends
          const reach = (1 - t) * (1 - beta) * D + (beta * D * 0.5) * gait;
          const r = restSpot(f, theta);
          const u = clamp((t - f.t0) / (1 - f.t0)), e = smooth(u);
          f.x = lerp(f.fx, r.x + mx * reach, e); f.z = lerp(f.fz, r.z + mz * reach, e);
          f.y = f.fy * (1 - e) + LIFT * scale * Math.pow(Math.sin(Math.PI * u), 1.2) * clamp(gait * 1.4);
          f.pitch = 0.35 * Math.sin(TAU * u) * gait;
        } else {
          if (f.mode !== 'plant') { f.mode = 'plant'; f.pitch = 0; }
          f.y = damp(f.y, 0, 40, dt);
        }
      }
      return;
    }
    // standing: finish any swing as a quick step to the rest spot, then step whichever foot is out of place
    for (const f of feet) if (f.mode === 'gait') { f.mode = 'settle'; f.fx = f.x; f.fz = f.z; f.fy = f.y; f.st = 0; f.dur = 0.11; f.lift = 0.6; }
    let swinging = false;
    for (const f of feet) {
      if (f.mode !== 'settle') { f.y = damp(f.y, 0, 40, dt); continue; }
      f.st += dt;
      const u = clamp(f.st / f.dur), e = smooth(u);
      const r = restSpot(f, theta);
      f.x = lerp(f.fx, r.x, e); f.z = lerp(f.fz, r.z, e);
      f.y = f.fy * (1 - e) + SETTLE_LIFT * scale * Math.sin(Math.PI * u) * f.lift;
      f.pitch = 0.25 * Math.sin(TAU * u) * f.lift;
      if (u >= 1) { f.mode = 'plant'; f.y = 0; f.pitch = 0; } else swinging = true;
    }
    if (!swinging) {
      let best = null, bd = 0.04 * scale;
      for (const f of feet) { const r = restSpot(f, theta); const d = Math.hypot(f.x - r.x, f.z - r.z); if (d > bd) { bd = d; best = f; } }
      if (best) Object.assign(best, { mode: 'settle', fx: best.x, fz: best.z, fy: best.y, st: 0, dur: clamp(0.09 + bd * 0.3, 0.1, 0.16), lift: clamp(bd / (0.12 * scale), 0.35, 1) });
    }
  }

  function animate(dt) {
    const spd = s.speed / SPEED;
    const movingNow = s.moved / dt > 0.12;
    // acceleration in world space from the (smooth) velocity, lightly filtered
    const ax = (s.vx - prevVx) / dt, az = (s.vz - prevVz) / dt;
    prevVx = s.vx; prevVz = s.vz;
    accel.x = damp(accel.x, ax, 30, dt); accel.z = damp(accel.z, az, 30, dt);
    const h = s.heading, ch = Math.cos(h), sh = Math.sin(h);
    const fwdAcc = accel.x * ch + accel.z * sh, latAcc = -accel.x * sh + accel.z * ch;
    const dh = angleDelta(prevHeading, h);
    prevHeading = h;

    // --- gait: phase advances with distance walked, so the planted foot never slides ---
    const k = clamp(spd);
    const D = lerp(STRIDE[0], STRIDE[1], k), beta = lerp(DUTY[0], DUTY[1], k);
    phase = frac(phase + s.moved / D);
    const gTarget = movingNow ? clamp(spd * 3) : 0;
    gait = damp(gait, gTarget, gTarget > gait ? 16 : 10, dt);
    const g = gait, gb = g * (0.35 + 0.65 * k);
    const cStep = Math.cos(TAU * 2 * (phase - beta / 2));      // +1 at each foot's mid-stance
    const cCycle = Math.cos(TAU * (phase - beta / 2));         // +1 left planted, -1 right planted

    // stopping: a little settle
    if (wasMoving && !movingNow && prevSpd > 0.35) { squash.velocity = Math.max(-3, squash.velocity - 1.3); ant.z1.kick(-2.2); packBob.kick(-0.3); }
    if (!wasMoving && movingNow && views.fx?.puff) puffT = Math.min(puffT, 0.05);
    wasMoving = movingNow; prevSpd = spd;

    // --- springs ---
    lean.target = LEAN_SPEED * k + clamp(fwdAcc * LEAN_ACC, -0.2, 0.18) + (s.blocked ? 0.1 : 0);
    lean.update(dt);
    bank.target = clamp(latAcc * BANK_ACC, -0.24, 0.24);
    bank.update(dt);
    squash.update(dt);
    ant.z1.target = clamp(fwdAcc * 0.014 - lean.velocity * 0.06, -0.6, 0.6) + 0.05 * gb * cStep;
    ant.x1.target = clamp(-latAcc * 0.014 + bank.velocity * 0.05, -0.6, 0.6) - 0.06 * g * cCycle;
    ant.z1.update(dt); ant.x1.update(dt);
    ant.z2.target = ant.z1.value * 0.8; ant.x2.target = ant.x1.value * 0.8;
    ant.z2.update(dt); ant.x2.update(dt);
    packTilt.target = clamp(-fwdAcc * 0.003, -0.16, 0.16) - 0.04 * k;
    packRoll.target = clamp(latAcc * 0.003, -0.14, 0.14);
    packTilt.update(dt); packRoll.update(dt); packBob.update(dt); packPulse.update(dt);
    if (g > 0.3 && Math.abs(cStep) > 0.995) packBob.velocity -= 0.12 * gb; // nudged at each foot contact

    // --- idle life ---
    const idleNow = !movingNow && !action && celebT < 0 && !s.path && s.speed < 0.05;
    idleT = idleNow ? idleT + dt : 0;
    if (!idleNow) { glanceTarget = 0; glanceT = 0; }
    else if (glanceT <= 0 && idleT > nextGlance) {
      const d = angleDelta(h, Math.PI / 2); // toward +z = the camera
      glanceTarget = Math.abs(d) < 0.3 ? (rnd() < 0.5 ? -0.5 : 0.5) : clamp(d, -0.7, 0.7);
      glanceT = 1.3 + rnd() * 0.8;
      blinkT = 0;
    }
    if (glanceT > 0) { glanceT -= dt; if (glanceT <= 0) { glanceTarget = 0; idleT = 0; nextGlance = 4 + rnd() * 4; } }
    glance = damp(glance, glanceTarget, 6, dt);

    // --- face ---
    lookTimer -= dt;
    if (idleNow && idleT > 1.8 && lookTimer <= 0) {
      const r = rnd();
      lookTX = r < 0.35 ? 0 : (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd() * 0.4);
      lookTY = (rnd() - 0.4) * 0.6;
      wideT = Math.abs(lookTX) > 0.4 && rnd() < 0.6 ? 0.9 : 0;
      lookTimer = 1.1 + rnd() * 1.8;
      if (rnd() < 0.4) ant.x1.kick(lookTX * 2);
    } else if (!idleNow) {
      lookTX = clamp(-(dh / dt) * 0.11, -0.85, 0.85);
      lookTY = 0;
      wideT = 0;
      lookTimer = 1.2;
    }
    face.lookX = damp(face.lookX, lookTX, 12, dt);
    face.lookY = damp(face.lookY, lookTY, 10, dt);
    face.wide = damp(face.wide, wideT, 10, dt);
    happyT = Math.max(0, happyT - dt);
    face.happy = damp(face.happy, happyT > 0 ? 1 : 0, 18, dt);
    face.squint = damp(face.squint, pose.squint, 30, dt);
    blinkWait -= dt;
    if (blinkWait <= 0 && blinkT < 0) blinkT = 0;
    face.open = 1;
    if (blinkT >= 0) {
      blinkT += dt;
      face.open = 1 - arc(clamp(blinkT / 0.14));
      if (blinkT >= 0.14) { blinkT = -1; blinkWait = rnd() < 0.2 ? 0.18 : 2 + rnd() * 3.2; }
    }
    rig.face.draw(face);

    // --- body ---
    const bob = BOB * gb * (0.5 - 0.5 * cStep);
    const breathe = 0.013 * Math.sin((clock * TAU) / 2.4) * (1 - g);
    const sq = clamp(squash.value - STEP_SQUASH * gb * cStep + breathe + pose.stretch, 0.74, 1.3);
    const side = 1 / Math.sqrt(sq);
    const roll = -ROLL * g * cCycle;
    groundY = damp(groundY, Math.max(-0.1, views.terrain?.groundHeight?.(s.x, s.z) ?? 0), 18, dt);
    const off = pose.lunge;
    rig.root.position.set(s.x + ch * off, groundY, s.z + sh * off);
    rig.root.rotation.y = -(h + pose.spin + glance);
    rig.tilt.rotation.set(roll + bank.value, 0, -(lean.value + pose.lean));
    rig.hop.position.y = bob + pose.hopExtra / scale;
    rig.squash.scale.set(side, sq, side);

    // --- antenna + pack ---
    rig.antenna.rotation.set(ant.x1.value, 0, ant.z1.value);
    rig.antJoint.rotation.set(ant.x2.value - ant.x1.value * 0.3, 0, ant.z2.value - ant.z1.value * 0.3);
    rig.pack.rotation.set(packRoll.value, 0, packTilt.value);
    rig.pack.position.y = PACK_Y + packBob.value * 0.1;
    rig.pack.scale.setScalar(packPulse.value);
    gulpGlow = Math.max(0, gulpGlow - dt * 2.5);
    rig.gaugeMat.color.setRGB(0.49 + 0.5 * gulpGlow, 0.96 + 0.04 * gulpGlow, 0.83 + 0.17 * gulpGlow);

    // --- arms: counter-swing, inertia, the swing itself ---
    const swingArm = Math.cos(TAU * phase) * ARM_SWING * g;
    const lag = clamp(-fwdAcc * 0.005, -0.3, 0.3);
    armSpring.R.target = ARM_REST + swingArm + lag; armSpring.L.target = ARM_REST - swingArm + lag;
    // while the tool is still out after a swing, that arm holds it up in a ready carry pose (never dragging it)
    const carry = clamp(toolShow.value) * (action ? 0 : 1);
    if (carry > 0) { const sa = swingSide > 0 ? armSpring.R : armSpring.L; sa.target = lerp(sa.target, ARM_CARRY, carry); }
    if (pose.arm != null) {
      (swingSide > 0 ? armSpring.R : armSpring.L).set(pose.arm);
      (swingSide > 0 ? armSpring.L : armSpring.R).target = 0.5 + lag;
    }
    armSpring.R.update(dt); armSpring.L.update(dt);
    rig.armR.rotation.set(0.36, 0, armSpring.R.value);
    rig.armL.rotation.set(-0.36, 0, armSpring.L.value);

    // --- tool: pops out of the mitt for a swing, tucks away after a moment ---
    toolShow.target = action || toolIdle < TOOL_LINGER ? 1 : 0;
    toolShow.update(dt);
    const ts = Math.max(0, toolShow.value);
    for (const kind of ['axe', 'pickaxe']) {
      const t = rig.tools[kind];
      const on = kind === toolKind && ts > 0.02;
      t.visible = on;
      if (on) t.scale.setScalar(Math.min(1.15, ts));
    }
    // after the last swing the wrist turns the tool upright (never dragged on the ground); reset once tucked away
    wrist.target = action ? 0 : WRIST_CARRY;
    wrist.update(dt);
    if (toolShow.value < 0.02 && !action) wrist.set(0);
    rig.tool.rotation.set(0, 0, TOOL_GRIP + wrist.value);

    // --- feet: world-planted; swings ease from lift-off to the predicted landing spot (zero speed at both
    // ends, so nothing ever skids), timed by the distance phase while walking; settle steps when idle ---
    updateFeet(dt, movingNow, D, beta);
    const rootTheta = h + pose.spin + glance;
    const cr = Math.cos(rootTheta), sr = Math.sin(rootTheta);
    for (const f of feet) {
      const dx = f.x - rig.root.position.x, dz = f.z - rig.root.position.z;
      f.obj.position.set((dx * cr + dz * sr) / scale, (f.y + pose.hopExtra) / scale, (-dx * sr + dz * cr) / scale);
      f.obj.rotation.set(0, -f.side * 0.12, f.pitch);
    }
    // shadow shrinks while airborne
    const air = rig.hop.position.y * scale;
    const shs = 1 - Math.min(0.45, air * 1.4);
    rig.shadow.scale.set(shs, 1, shs);
    rig.shadow.material.opacity = 0.32 * (1 - Math.min(0.5, air * 2));

    rig.root.updateMatrixWorld(true);
    placeLeg(rig.legL, rig.hipL, rig.footL);
    placeLeg(rig.legR, rig.hipR, rig.footR);
    // glow sprites (kept in root space so the squash never distorts them)
    rig.visorAnchor.getWorldPosition(v1); rig.root.worldToLocal(rig.visorGlow.position.copy(v1));
    // the visor glow only shows while the screen faces the camera (+z), so it never smudges the grass behind
    const toCam = clamp(Math.sin(h + glance) * 1.4 + 0.1);
    rig.visorGlow.material.opacity = (0.2 + 0.03 * Math.sin(clock * 3.1) + 0.1 * face.happy) * toCam;
    rig.visorGlow.visible = toCam > 0.01;
    rig.bulb.getWorldPosition(v1); rig.root.worldToLocal(rig.bulbGlow.position.copy(v1));
    const flash = celebT >= 0 ? 0.3 : 0;
    rig.bulbGlow.material.opacity = 0.62 + 0.12 * Math.sin(clock * 2.3) + flash;
    rig.bulbMat.color.setRGB(1, 0.86 + 0.06 * Math.sin(clock * 2.3) + flash * 0.3, 0.48 + flash);

    // --- exhaust: a little puff now and then while moving ---
    if (movingNow && views.fx?.puff) {
      puffT -= dt * (0.5 + 0.5 * k);
      if (puffT <= 0) {
        rig.pipeTip.getWorldPosition(v1);
        views.fx.puff(v1, { count: 1, size: 0.055 + 0.02 * rnd(), spread: 0.03, up: 0.55, color: '#f2f6f4' });
        puffT = 0.9 + rnd() * 0.8;
      }
    }
  }
  const PACK_Y = rig.pack.position.y;

  function update(dt) {
    if (!(dt > 0)) return;
    clock += dt;
    syncExternal();
    const nowSteering = readInput();
    if (nowSteering && !steering) {
      if (s.path) motion.cancelPath();
      if (action && !action.impacted) cancelSwing();
      faceTimer = 0;
    }
    steering = nowSteering;
    motion.setInput(inp.x, inp.z);
    if (faceTimer > 0) { faceTimer -= dt; motion.face(faceHeading); } else motion.face(null);
    motion.step(dt);
    report();
    advanceActions(dt);
    animate(dt);
  }

  events.on('craft:done', () => api.bounce());

  const api = {
    object: rig.root,
    supportsAnalog: true,
    // Smoothed feet position on the ground (no bob / lunge offsets): the camera follows this.
    getPosition(out = new THREE.Vector3()) { return out.set(s.x, groundY, s.z); },
    // World position of the power-pack (end point for item pickup flights).
    getPackPosition(out = new THREE.Vector3()) { rig.root.updateWorldMatrix(true, true); return rig.packMesh.getWorldPosition(out).add(PACK_CENTER); },
    get facing() { return cardinalOf(s.heading); },
    get heading() { return s.heading; },
    get velocity() { return { x: s.vx, z: s.vz }; },
    get speed() { return s.speed; },
    get tile() { return { x: Math.round(s.x), z: Math.round(s.z) }; },
    get moving() { return s.speed > 0.15 || !!s.path; },
    get pathing() { return !!s.path; },
    get steering() { return steering; },
    get busy() { return !!action && action.t < SWING_T - SWING_CHAIN; },
    radius: RADIUS,

    // Turn to targetPos, wind up, strike (onImpact at contact), follow through. opts.tool: 'axe' | 'pickaxe'.
    swing(targetPos, onImpact, opts = {}) {
      if (api.busy) return false;
      const target = { x: targetPos?.x ?? s.x + Math.cos(s.heading), z: targetPos?.z ?? s.z + Math.sin(s.heading) };
      startSwing(target, onImpact, opts.tool);
      return true;
    },
    gulp() {
      squash.velocity = Math.max(-4, squash.velocity - 1.6);
      packPulse.velocity = Math.min(3, packPulse.velocity + 1.6);
      packBob.kick(-0.25);
      gulpGlow = 1;
      if (!action) happyT = Math.max(happyT, 0.35);
    },
    celebrate() { celebT = 0; happyT = 1.1; },
    bounce() { if (bounceT < 0 || bounceT > BOUNCE_T * 0.6) bounceT = 0; happyT = Math.max(happyT, 0.5); },
    faceTile(x, z) {
      const dx = x - s.x, dz = z - s.z;
      if (dx * dx + dz * dz < 1e-4) return;
      faceHeading = Math.atan2(dz, dx); faceTimer = 0.45;
    },
    // Walk through a list of tiles ([x, z] or {x, z}, usually from a BFS) with free movement: the path is
    // string-pulled so legs run straight, and corners are rounded by the follower. onArrive fires at the end.
    // opts: { stopWhen(x, z) -> bool (arrive early, e.g. once in reach), onFail() (blocked or cancelled) }.
    // Steering with keys / the stick cancels the walk (onFail, never onArrive).
    walkPath(list, onArrive, opts = {}) {
      const tiles = (list || []).map(n => (Array.isArray(n) ? { x: n[0], z: n[1] } : { x: n.x, z: n.z }));
      const pts = smoothPath(walk, s.x, s.z, tiles, RADIUS + 0.03) || [];
      motion.follow(pts, { onArrive: onArrive || null, onFail: opts.onFail || null, stopWhen: opts.stopWhen || null });
      return true;
    },
    cancelPath() { if (s.path) motion.cancelPath(); },
    update,
    dispose() {
      removeEventListener('keydown', onKeyDown);
      removeEventListener('keyup', onKeyUp);
      removeEventListener('blur', clearKeys);
      document.removeEventListener('visibilitychange', onVis);
    },
    // test hooks
    _motion: motion,
    _rig: rig,
  };
  const PACK_CENTER = new THREE.Vector3(0, -0.11, 0);
  return api;
}
