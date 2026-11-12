// Worker view controller: one invisible Object3D rig per camp worker, animated from camp state + events.
// Walk cycle tied to distance (planted-ish feet, waddle, arm counter-swing), tool swings synced to camp:swing
// (lumberjack: an overhead chop; hunter: a flat side-swipe bonk), the tool shouldered while walking, a carried
// stack on the back rack that items fly onto and off of (deliveries toss into the station's intake), blinks and
// eyelid expressions, a hungry thought bubble, a happy munch, and a hop out of the hut door when hired.
import * as THREE from 'three';
import { ease, clamp, lerp, damp, dampAngle, angleDelta, arc, Spring } from '../../util/anim.js';
import { WORKERS, STATIONS, CAMP } from '../../sim/camp-data.js';
import { WLAYOUT } from './worker-models.js';
import { rng, hashStr, Blink, lidMatrix } from './kit.js';

const TAU = Math.PI * 2;
const frac = v => v - Math.floor(v);
const smooth01 = t => { t = clamp(t); return t * t * (3 - 2 * t); };

// ---- tuning ----
const STRIDE = 0.6;          // world tiles per full walk cycle (two steps)
const DUTY = 0.56;           // fraction of a cycle each foot is planted
const REACH = 0.075;         // foot travel half-range (model units)
const LIFT = 0.05;           // foot lift
const BOB = 0.02, ROLL = 0.075, ARM_SWING = 0.6, LEAN_SPEED = 0.05, LEAN_CARRY = 0.05;
const ARM_REST = 0.18, TOOL_REST = 0.3;
const WIND = 2.75, STRIKE = 1.2, RECOVER = 0.3, PRE = 0.3, TWIST = 0.42;
const TOOL_GRIP = 0.5;       // tool angle relative to the arm (head leans forward of the arm line)
const ITEM_SCALE = 0.56;     // carried items, world scale
const BUBBLE_UP = 0.3;       // above the head top (world)
const DROP_FLIGHT = 0.2;     // rack -> station intake toss (the camp view lands its intake wobble ~0.18 s after station:drop)

// Hunter's side-swipe poses. Index names: right arm abduction (RX), horizontal sweep (RY), pitch (RZ); club grip
// angle (TZ); torso twist (TWS), lean, roll; lunge; left arm pitch (AL) and abduction (ALX); head nod.
const RX = 0, RY = 1, RZ = 2, TZ = 3, TWS = 4, P_LEAN = 5, P_ROLL = 6, P_LUNGE = 7, AL = 8, ALX = 9, NOD = 10, NPOSE = 11;
const SWIPE = {
  //                   RX     RY     RZ          TZ          TWS    LEAN   ROLL   LUNGE  AL     ALX   NOD
  rest:   new Float32Array([-0.12, 0,     TOOL_REST, TOOL_GRIP, 0,     0,     0,     0,     ARM_REST, 0, 0]),
  wind:   new Float32Array([-0.3,  -1.55, 1.3,       0.75,      -0.36, 0.05,  0.06,  -0.02, 1.0,  0.1,  0.06]),
  cock:   new Float32Array([-0.36, -1.95, 1.32,      0.9,       -0.47, 0.08,  0.09,  -0.03, 1.15, 0.12, 0.08]),
  hit:    new Float32Array([-0.2,  0.12,  1.4,       0.35,      0.3,   -0.14, -0.11, 0.2,   -0.3, 0.45, -0.12]),
  follow: new Float32Array([-0.16, 0.9,   1.18,      0.25,      0.45,  -0.1,  -0.13, 0.14,  -0.45, 0.55, -0.08]),
};
const SWIPE_FOLLOW = 0.09, SWIPE_RECOVER = 0.3;
const mixPose = (out, a, b, k) => { for (let i = 0; i < NPOSE; i++) out[i] = a[i] + (b[i] - a[i]) * k; return out; };
const dampPose = (p, t, rate, dt) => { const k = 1 - Math.exp(-rate * dt); for (let i = 0; i < NPOSE; i++) p[i] += (t[i] - p[i]) * k; return p; };
const _pose = new Float32Array(NPOSE);
const _lm = new THREE.Matrix4();

// Shoulder carry while walking: the tool arm comes up, the shaft rests on the shoulder, the head rides behind
// it (the axe flips so its blade points up). rz/tz are the arm pitch and the tool's grip angle, twist spins the
// tool about its own shaft.
const CARRY = {
  axe:  { rx: -0.1, ry: 0.04, rz: 2.05, tz: 2.45, twist: Math.PI },
  club: { rx: -0.1, ry: 0.04, rz: 2.05, tz: 2.4, twist: 0 },
};

export class WorkerView {
  // sys: { root, ctx, sizeK, fx(), camera, camp, playerPos(), groundAt(), itemHeight(), stationPoint(id, out) }
  constructor(sys, w, { hired = false } = {}) {
    this.sys = sys; this.w = w; this.id = w.id; this.role = w.role;
    this.def = WORKERS[w.role] || WORKERS.lumberjack;
    this.rnd = rng(hashStr(w.id) + 3);
    const L = WLAYOUT;
    this.k = L.scale * sys.sizeK;
    const O = () => new THREE.Object3D();
    this.root = O(); this.root.name = `worker:${w.id}`;
    this.tilt = O(); this.hop = O(); this.squashN = O();
    this.root.add(this.tilt); this.tilt.add(this.hop); this.hop.add(this.squashN);
    this.body = O(); this.squashN.add(this.body);
    this.head = O(); this.head.position.set(...L.headPivot); this.squashN.add(this.head);
    this.arms = [-1, 1].map(s => { const a = O(); a.position.set(L.shoulder[0], L.shoulder[1], s * L.shoulder[2]); this.squashN.add(a); return a; });
    this.feet = [-1, 1].map(s => { const f = O(); f.position.set(L.foot[0], L.foot[1], s * L.foot[2]); this.root.add(f); return f; });
    this.tool = O(); this.tool.position.set(0, -L.armLen, 0); this.tool.rotation.z = TOOL_GRIP; this.arms[1].add(this.tool);
    this.tool.rotation.order = 'ZYX';   // twist about the shaft first (y), then the grip angle (z)
    this.snack = O(); this.snack.position.set(0.01, -L.armLen - 0.01, 0.0); this.arms[0].add(this.snack);
    this.pack = O(); this.pack.position.set(...L.pack); this.squashN.add(this.pack);
    this.slots = [];
    this.bubble = O(); sys.root.add(this.bubble);
    sys.root.add(this.root);
    this.root.scale.setScalar(this.k);

    const R = w.role;
    this.toolKey = this.def.target === 'tree' ? 'axe' : 'club';
    this.parts = [[`${R}.body`, this.body], [`${R}.head`, this.head], [`${R}.arm`, this.arms[0]], [`${R}.arm`, this.arms[1]],
      ['foot', this.feet[0]], ['foot', this.feet[1]], [this.toolKey, this.tool]];

    // ---- motion state ----
    this.x = w.x; this.z = w.z; this.h = Number.isFinite(w.heading) ? w.heading : Math.PI / 2;
    this.y = sys.groundAt(w.x, w.z);
    this.spd = 0; this.moveW = 0; this.phase = 0; this.turn = 0; this.vF = 0; this.accF = 0;
    this.squash = new Spring(1, { stiffness: 340, damping: 13 });
    this.lean = new Spring(0, { stiffness: 220, damping: 15 });
    this.roll = new Spring(0, { stiffness: 220, damping: 15 });
    this.headPitch = new Spring(0, { stiffness: 180, damping: 13 });
    this.headYaw = new Spring(0, { stiffness: 140, damping: 14 });
    this.armL = new Spring(ARM_REST, { stiffness: 260, damping: 17 });
    this.armR = TOOL_REST;
    this.rx = -0.12; this.ry = 0; this.toolZ = TOOL_GRIP; this.armLX = 0;
    this.pose = SWIPE.rest.slice();   // hunter side-swipe pose (see SWIPE)
    this.carryW = 0;                  // 0 tool in hand .. 1 tool on the shoulder (walking)
    this.blink = new Blink(this.rnd, { every: [2.2, 5] }); this.lidC = 0;
    this.lidTint = new THREE.Color(L.lid || '#ffffff');
    this.packTilt = new Spring(0, { stiffness: 160, damping: 8 });
    this.packRoll = new Spring(0, { stiffness: 160, damping: 8 });
    this.hopY = 0; this.hopV = 0;
    this.flash = 0;
    this.time = this.rnd() * 10;
    this.lookT = 2 + this.rnd() * 3; this.lookYaw = 0;
    // swings
    this.sw = null; this.nextSwing = Infinity; this.lunge = 0; this.lungeDir = { x: 1, z: 0 }; this.swLean = 0;
    this.lastTarget = null;
    // carried stack: shown items (bottom -> top), items in flight toward it
    this.stack = []; this.incoming = 0; this.incomingAge = 0;
    // bubble: 'hidden' | 'in' | 'shown' | 'out'
    this.bub = { state: 'hidden', t: 0, s: 0 };
    // munch: null | { t, wait }
    this.munch = null; this.snackS = 0;
    this.cheer = 0;
    // hired hop
    this.spawn = null;
    if (hired) this.startHire();
  }

  // ---------- events ----------
  startHire() {
    const camp = this.sys.camp;
    const hut = camp?.stations?.get?.('hut');
    const def = hut?.def || STATIONS.hut;
    const fp = def.footprint, door = def.door || [this.w.x, this.w.z];
    const cx = fp[0] + (fp[2] - 1) / 2, cz = fp[1] + (fp[3] - 1) / 2;
    let dx = door[0] - cx, dz = door[1] - cz; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    this.spawn = { t: 0, ox: -dx * 0.6, oz: -dz * 0.6, landed: false, cheered: false };
    this.h = Math.atan2(dz, dx);
    this.sys.fx()?.puff?.({ x: door[0] - dx * 0.35, y: this.y + 0.15, z: door[1] - dz * 0.35 }, { count: 6, color: '#f6eedb', size: 0.12, spread: 0.2, up: 0.4 });
  }
  onState(state) {
    if (state === 'work') this.nextSwing = (this.def.workTime * 0.5) / this.speedMul();
    else if (!this.sw) this.nextSwing = Infinity;
  }
  speedMul() { return this.w.hungry ? 0.5 : 1; }
  swing(e) {
    this.sw = { t: 0, H: Math.max(0.06, Number(e.hitIn) || CAMP.hitDelay), a0: this.armR, tw0: this.twist || 0, hit: false, p0: this.pose.slice() };
    this.nextSwing = this.def.workTime / this.speedMul();
    if (e.target) {
      this.lastTarget = { x: e.target.x, z: e.target.z };
      let dx = e.target.x - this.x, dz = e.target.z - this.z; const l = Math.hypot(dx, dz) || 1;
      this.lungeDir = { x: dx / l, z: dz / l };
    }
  }
  onCarry(item, n) {
    const fx = this.sys.fx();
    const src = this.lastTarget || { x: this.x, z: this.z };
    for (let i = 0; i < n; i++) {
      if (fx?.flyItem) {
        this.incoming++;
        const from = new THREE.Vector3(src.x + (this.rnd() - 0.5) * 0.2, this.y + 0.25, src.z + (this.rnd() - 0.5) * 0.2);
        fx.flyItem(item, from, () => this.stackTop(new THREE.Vector3()), {
          delay: 0.05 + i * 0.09, height: 0.35,
          onArrive: () => { this.incoming = Math.max(0, this.incoming - 1); this.pushItem(item); },
        });
      } else this.pushItem(item);
    }
  }
  pushItem(item) {
    if (this.stack.length >= Math.max(this.w.carry?.n || 0, 0)) return; // the sim says we hold fewer (already delivered)
    const s = new Spring(0.55, { stiffness: 300, damping: 12, target: 1 });
    this.stack.push({ item, pop: s, jx: (this.rnd() - 0.5) * 0.02, jy: (this.rnd() - 0.5) * 0.35, jr: (this.rnd() - 0.5) * 0.12 });
    this.packTilt.velocity -= 1.2; this.squash.velocity -= 0.8;
  }
  onDrop(station, item) {
    const top = this.stack.pop();
    this.squash.velocity -= 1.6;
    this.armL.velocity += 6;
    const fx = this.sys.fx();
    if (!fx?.flyItem) return;
    const from = top ? this.slotWorld(this.stack.length, new THREE.Vector3()) : this.stackTop(new THREE.Vector3());
    // toss it into the station's intake (rack / basket / hopper, views.campview.intakePoint): a quick throw that
    // lands as the camp view wobbles the intake
    const to = this.sys.stationPoint(station?.id, new THREE.Vector3());
    if (!to) return;
    to.x += (this.rnd() - 0.5) * 0.08; to.z += (this.rnd() - 0.5) * 0.08;
    const d = Math.hypot(to.x - from.x, to.z - from.z);
    fx.flyItem(item || top?.item, from, to, { mode: 'throw', dur: DROP_FLIGHT, height: 0.22 + Math.min(d, 3) * 0.06, scale: 0.62 / this.sys.fxScale(), jitter: 0.02 });
  }
  onHungry() { this.squash.velocity -= 1.5; this.headPitch.velocity -= 1.6; }
  onAte() {
    const fx = this.sys.fx();
    const cook = this.sys.camp?.stations?.get?.('cookfire');
    const pile = cook?.pile?.tile;
    this.munch = { t: 0, wait: true, bites: 0 };
    if (fx?.flyItem && pile) {
      fx.flyItem('cookedMeat', new THREE.Vector3(pile[0], this.y + 0.15, pile[1]), () => this.handWorld(new THREE.Vector3()), {
        height: 0.3, popHeight: 0.2, onArrive: () => { if (this.munch) { this.munch.wait = false; this.munch.t = 0; } },
      });
    } else this.munch.wait = false;
    this.armL.target = 1.6;
  }

  // ---------- helpers (world positions) ----------
  stackTop(out) { return this.slotWorld(this.stack.length, out); }
  slotWorld(i, out) {
    const ih = this.sys.itemHeight() * 0.8 * ITEM_SCALE / this.k;
    this.root.updateMatrixWorld(true);
    return out.set(0, i * ih + ih * 0.5, 0).applyMatrix4(this.pack.matrixWorld);
  }
  handWorld(out) {
    this.root.updateMatrixWorld(true);
    return out.set(0.02, -0.01, 0).applyMatrix4(this.snack.matrixWorld);
  }
  mouthWorld(out) {
    this.root.updateMatrixWorld(true);
    return out.set(0.15, 0.08, 0).applyMatrix4(this.head.matrixWorld);
  }

  // ---------- per-frame ----------
  update(dt) {
    const w = this.w, sys = this.sys;
    this.time += dt;

    // ---- follow the sim ----
    if (Math.hypot(w.x - this.x, w.z - this.z) > 2.5) { this.x = w.x; this.z = w.z; this.spd = 0; this.accF = 0; } // teleported: cut
    const kf = 1 - Math.exp(-14 * dt);
    const nx = this.x + (w.x - this.x) * kf, nz = this.z + (w.z - this.z) * kf;
    const dx = nx - this.x, dz = nz - this.z, d = Math.hypot(dx, dz);
    this.x = nx; this.z = nz;
    const vInst = dt > 0 ? Math.min(6, d / dt) : 0;
    const prevSpd = this.spd;
    this.spd = damp(this.spd, vInst, 12, dt);
    this.accF = damp(this.accF, dt > 0 ? (this.spd - prevSpd) / dt : 0, 10, dt);
    const moving = this.spd > 0.15;
    this.moveW = damp(this.moveW, moving ? 1 : 0, moving ? 10 : 7, dt);
    this.y = damp(this.y, sys.groundAt(this.x, this.z), 12, dt);
    const prevH = this.h;
    const wantH = d > 2e-4 ? Math.atan2(dz, dx) : (Number.isFinite(w.heading) ? w.heading : this.h);
    if (!this.spawn || this.spawn.t > 0.45) this.h = dampAngle(this.h, wantH, moving ? 11 : 8, dt);
    this.turn = damp(this.turn, dt > 0 ? angleDelta(prevH, this.h) / dt : 0, 8, dt);

    // ---- walk cycle ----
    this.phase += d / STRIDE;
    const m = this.moveW;
    for (let i = 0; i < 2; i++) {
      const ph = frac(this.phase + (i === 0 ? 0 : 0.5));
      let fxo, ly, toe;
      if (ph < DUTY) { const u = ph / DUTY; fxo = REACH * (1 - 2 * u); ly = 0; toe = -0.35 * smooth01((u - 0.7) / 0.3); }
      else { const u = (ph - DUTY) / (1 - DUTY); fxo = -REACH + 2 * REACH * ease.sineInOut(u); ly = Math.sin(Math.PI * u) * LIFT; toe = lerp(-0.35, 0.25, smooth01(u * 1.6)); }
      const f = this.feet[i];
      f.position.x = fxo * m; f.position.y = ly * m; f.rotation.z = toe * m;
    }
    const c = Math.cos(TAU * this.phase), s2 = Math.sin(TAU * this.phase);
    let bob = (0.5 - 0.5 * Math.cos(2 * TAU * this.phase)) * BOB * m;
    const carryN = this.stack.length;
    const hungry = !!w.hungry;

    // ---- swing (tool arm) ----
    let armR = TOOL_REST - c * 0.28 * m, armLT = ARM_REST + c * ARM_SWING * m, leanSw = 0, lunge = 0, headNod = 0, twist = 0;
    let rollSw = 0, armLX = 0;
    if (this.nextSwing !== Infinity) this.nextSwing -= dt;
    if (this.toolKey === 'club') {
      // hunter: a flat side-swipe bonk. Cock the club out to the right with the torso turned away, whip it across
      // the front at the hit, follow through to the left, then let it hang again. (The lumberjack chops overhead.)
      const P = this.pose;
      if (this.sw) {
        const S = this.sw; S.t += dt;
        const t = S.t, H = S.H, tw = Math.max(0.05, H * 0.5);
        if (t < tw) mixPose(P, S.p0, SWIPE.cock, ease.quadOut(t / tw));
        else if (t < H) mixPose(P, SWIPE.cock, SWIPE.hit, ease.cubicIn((t - tw) / (H - tw)));
        else {
          if (!S.hit) { S.hit = true; this.squash.velocity -= 2.4; this.headPitch.velocity -= 3; this.blink.close(0.16); }
          const u = t - H;
          if (u < SWIPE_FOLLOW) mixPose(P, SWIPE.hit, SWIPE.follow, ease.quadOut(u / SWIPE_FOLLOW));
          else {
            const v = clamp((u - SWIPE_FOLLOW) / SWIPE_RECOVER);
            mixPose(P, SWIPE.follow, this.swipeWait(_pose), ease.cubicInOut(v));
            if (v >= 1) this.sw = null;
          }
        }
      } else {
        // between swings: drift toward the wind-up (pre-swing) or the hanging rest with the walk's arm swing
        const T = this.swipeWait(_pose);
        T[RZ] -= c * 0.28 * m; T[AL] += c * ARM_SWING * m;
        dampPose(P, T, w.state === 'work' && this.nextSwing < PRE ? 18 : 14, dt);
      }
      armR = P[RZ]; armLT = P[AL]; armLX = P[ALX]; leanSw = P[P_LEAN]; rollSw = P[P_ROLL]; lunge = P[P_LUNGE]; headNod = P[NOD]; twist = P[TWS];
      this.rx = P[RX]; this.ry = P[RY]; this.toolZ = P[TZ];
    } else if (this.sw) {
      const S = this.sw; S.t += dt;
      const t = S.t, H = S.H, tw = Math.max(0.05, H * 0.5);
      if (t < tw) { const k = ease.quadOut(t / tw); armR = lerp(S.a0, WIND, k); leanSw = 0.16 * k; lunge = -0.02 * k; twist = lerp(S.tw0, -TWIST, k); }
      else if (t < H) { const k = ease.cubicIn((t - tw) / (H - tw)); armR = lerp(WIND, STRIKE, k); leanSw = lerp(0.16, -0.24, k); lunge = lerp(-0.02, 0.13, k); headNod = -0.15 * k; twist = lerp(-TWIST, TWIST * 0.7, k); }
      else {
        if (!S.hit) { S.hit = true; this.squash.velocity -= 2.6; this.headPitch.velocity -= 4; }
        const u = clamp((t - H) / RECOVER);
        const over = Math.sin(Math.PI * Math.min(1, u * 2.2)) * 0.22 * (1 - u);
        armR = lerp(STRIKE - over, this.preWind(TOOL_REST), ease.cubicInOut(u));
        leanSw = lerp(-0.24, 0, ease.cubicInOut(u)); lunge = lerp(0.13, 0, ease.cubicInOut(u)); headNod = -0.15 * (1 - u);
        twist = lerp(TWIST * 0.7 + over * 0.4, this.preTwist(), ease.cubicInOut(u));
        if (u >= 1) this.sw = null;
      }
      armLT = lerp(armLT, armR * 0.78, 0.9);
    } else if (w.state === 'work' && this.nextSwing < PRE) {
      armR = damp(this.armR, this.preWind(TOOL_REST), 18, dt);
      const k = smooth01(1 - this.nextSwing / PRE);
      leanSw = 0.12 * k; armLT = lerp(armLT, armR * 0.78, k); twist = this.preTwist();
    } else {
      armR = damp(this.armR, armR, 14, dt);
    }
    this.armR = armR;
    this.lunge = lunge;
    this.twist = twist;
    if (this.toolKey !== 'club') { this.rx = -0.12; this.ry = 0; this.toolZ = TOOL_GRIP; }
    this.armLX = damp(this.armLX, armLX, 16, dt);

    // ---- state poses ----
    // the head keeps its eyes on the target while the torso twists through a swing
    let headPitchT = headNod + (hungry ? -0.22 : 0), headYawT = clamp(-this.turn * 0.12, -0.5, 0.5) - twist * 0.75;
    let leanT = -(this.spd * LEAN_SPEED) - (carryN ? LEAN_CARRY * Math.min(1, carryN / 3) * m : 0) - (hungry ? 0.05 : 0) + leanSw;
    leanT += clamp(-this.accF * 0.012, -0.12, 0.12);
    if (w.state === 'eat' && !this.munch) {
      // waiting by the pile: excited little bounces, arms up
      bob += Math.abs(Math.sin(this.time * 9)) * 0.035;
      armLT = lerp(armLT, 1.1, 0.8);
      if (!this.sw) { this.armR = damp(this.armR, 1.0, 10, dt); if (this.toolKey === 'club') this.pose[RZ] = this.armR; }
      headPitchT += 0.12;
    } else if (w.state === 'drop') {
      armLT = lerp(armLT, 0.95, 0.85);
    } else if ((w.state === 'idle' || w.state === 'seek') && !moving) {
      this.lookT -= dt;
      if (this.lookT <= 0) { this.lookT = 1.2 + this.rnd() * 2.5; this.lookYaw = this.rnd() < 0.35 ? 0 : (this.rnd() - 0.5) * 1.6; }
      headYawT += this.lookYaw;
      const pl = sys.playerPos();
      if (pl && Math.hypot(pl.x - this.x, pl.z - this.z) < 2.2) headYawT = clamp(-angleDelta(this.h, Math.atan2(pl.z - this.z, pl.x - this.x)), -1, 1);
    }

    // ---- munch ----
    let snackTarget = 0;
    if (this.munch) {
      const M = this.munch;
      if (M.wait && (M.waitT = (M.waitT || 0) + dt) > 1.2) { M.wait = false; M.t = 0; } // the flight never landed
      if (!M.wait) {
        M.t += dt;
        const t = M.t;
        armLT = t < 1.05 ? lerp(armLT, 2.35, smooth01(t / 0.15)) : lerp(2.35, armLT, smooth01((t - 1.05) / 0.2));
        const bites = [0.28, 0.52, 0.76];
        while (M.bites < 3 && t >= bites[M.bites]) {
          M.bites++;
          this.headPitch.velocity -= 6; this.squash.velocity -= 1.4;
          const mp = this.mouthWorld(new THREE.Vector3());
          sys.fx()?.chips?.(mp, '#c3713d', { count: 3, size: 0.028, speed: 0.9, up: 1.6 });
        }
        snackTarget = t < 0.12 ? lerp(0.6, 1, ease.backOut(t / 0.12)) : [1, 0.74, 0.48, 0][M.bites];
        if (t >= 0.92 && !M.cheered) {
          M.cheered = true; this.hopV = 2.1; this.cheer = 1;
          const hp = this.mouthWorld(new THREE.Vector3());
          sys.fx()?.sparkle?.({ x: hp.x, y: hp.y + 0.2, z: hp.z }, { count: 4, color: '#ffc2d1', spread: 0.25, size: 0.075 });
        }
        if (t > 1.5) this.munch = null;
      } else snackTarget = 0;
    }
    this.snackS = damp(this.snackS, snackTarget, snackTarget > this.snackS ? 30 : 22, dt);
    this.cheer = damp(this.cheer, 0, 3.5, dt);
    if (this.cheer > 0.02) { armLT = lerp(armLT, 2.9, this.cheer); this.armR = lerp(this.armR, 2.6, this.cheer * 0.6); }

    // ---- tool on the shoulder while walking (not mid-swing, not while celebrating or waiting for food) ----
    const carryWant = moving && !this.sw && w.state !== 'work' && w.state !== 'eat' && !this.spawn && this.cheer < 0.1 ? 1 : 0;
    this.carryW = damp(this.carryW, carryWant, carryWant > this.carryW ? 7 : 12, dt);

    // ---- eyes: blinks, plus tired when hungry, happy shut while munching or cheering, wide while waiting ----
    let lidWant = hungry ? 0.38 : 0;
    if (this.munch && !this.munch.wait) lidWant = moving ? 0.7 : 0.88;
    if (this.cheer > 0.3) lidWant = Math.max(lidWant, 0.85);
    if (w.state === 'eat' && !this.munch) lidWant = 0;
    this.lidC = this.blink.update(dt, lidWant);

    // ---- hire hop ----
    let offX = 0, offZ = 0, lifeY = 0, lifeS = 1;
    if (this.spawn) {
      const S = this.spawn; S.t += dt;
      const T = 0.45, k = clamp(S.t / T);
      offX = S.ox * (1 - ease.quadOut(k)); offZ = S.oz * (1 - ease.quadOut(k));
      lifeY = arc(k) * 0.42;
      lifeS = lerp(0.6, 1, ease.backOut(clamp(S.t / 0.32), 2.2));
      if (S.t >= T && !S.landed) { S.landed = true; this.squash.velocity -= 4.5; sys.fx()?.ring?.({ x: this.x, y: this.y + 0.02, z: this.z }, { radius: 0.4, count: 9, size: 0.08, color: '#f3ead2' }); }
      if (S.t >= 0.66 && !S.cheered) {
        S.cheered = true; this.hopV = 2.0; this.cheer = 1;
        sys.fx()?.sparkle?.({ x: this.x, y: this.y + 0.75, z: this.z }, { count: 6, spread: 0.3 });
      }
      if (S.t > 1.3) this.spawn = null;
    }

    // ---- springs ----
    this.squash.target = 1 + Math.sin(this.time * (hungry ? 1.6 : 2.4)) * 0.014 * (1 - m);
    this.squash.update(dt);
    this.lean.target = clamp(leanT, -0.45, 0.3); this.lean.update(dt);
    this.roll.target = -s2 * ROLL * m + clamp(-this.turn * this.spd * 0.03, -0.2, 0.2) + rollSw; this.roll.update(dt);
    this.headPitch.target = headPitchT - bob * 2; this.headPitch.update(dt);
    this.headYaw.target = headYawT; this.headYaw.update(dt);
    this.armL.target = armLT; this.armL.update(dt);
    this.packTilt.target = clamp(this.accF * 0.02, -0.15, 0.15) + this.lean.value * 0.4; this.packTilt.update(dt);
    this.packRoll.target = clamp(this.turn * this.spd * 0.03, -0.18, 0.18) - this.roll.value * 0.5; this.packRoll.update(dt);
    if (this.hopV !== 0 || this.hopY > 0) {
      this.hopV -= 14 * dt; this.hopY += this.hopV * dt;
      if (this.hopY <= 0) { this.hopY = 0; if (this.hopV < -0.5) this.squash.velocity -= Math.min(4, -this.hopV * 1.5); this.hopV = 0; }
    }
    this.flash = this.flash > 0.002 ? this.flash * Math.exp(-11 * dt) : 0;

    // ---- compose ----
    const r = this.root;
    r.position.set(this.x + offX + this.lungeDir.x * this.lunge, this.y, this.z + offZ + this.lungeDir.z * this.lunge);
    r.rotation.set(0, -this.h, 0);
    r.scale.setScalar(this.k * lifeS);
    this.tilt.rotation.set(this.roll.value, this.twist || 0, this.lean.value);
    this.hop.position.y = bob + (this.hopY + lifeY) / this.k;
    const sq = clamp(this.squash.value, 0.5, 1.5);
    this.squashN.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq));
    this.head.rotation.set(0, this.headYaw.value, this.headPitch.value);
    this.arms[0].rotation.set(0.1 + this.armLX + (this.munch && !this.munch.wait ? 0.25 : 0), 0, this.armL.value);
    // tool arm: the work / swing pose, blended toward the shoulder carry (with a little bounce per step)
    const cw = smooth01(this.carryW), C = CARRY[this.toolKey];
    const cb = Math.sin(TAU * this.phase * 2) * 0.06 * m;
    this.arms[1].rotation.set(lerp(this.rx, C.rx, cw), lerp(this.ry, C.ry, cw), lerp(this.armR, C.rz + cb, cw));
    this.tool.rotation.set(0, C.twist * cw, lerp(this.toolZ, C.tz, cw));
    this.pack.rotation.set(this.packRoll.value, 0, this.packTilt.value);
    this.snack.scale.setScalar(Math.max(1e-4, this.snackS));

    // stack slots (pop springs)
    const ih = sys.itemHeight() * 0.8 * ITEM_SCALE / this.k;
    const isc = ITEM_SCALE / this.k;
    // keep in step with the sim: never show more than it holds; fill in anything we missed
    // a flight that never lands (fx recycled it) must not leave the stack short
    this.incomingAge = this.incoming > 0 ? this.incomingAge + dt : 0;
    if (this.incomingAge > 2.5) { this.incoming = 0; this.incomingAge = 0; }
    const simN = w.carry?.n || 0;
    while (this.stack.length > simN) this.stack.pop();
    if (this.stack.length + this.incoming < simN && w.carry?.item) this.pushItem(w.carry.item);
    while (this.slots.length < this.stack.length) { const o = new THREE.Object3D(); this.pack.add(o); this.slots.push(o); }
    for (let i = 0; i < this.slots.length; i++) {
      const o = this.slots[i], it = this.stack[i];
      o.visible = !!it;
      if (!it) continue;
      const p = it.pop.update(dt);
      const sway = this.packTilt.value * (i + 1) * 0.18;
      o.position.set(it.jx - Math.sin(sway) * ih * i * 0.5, i * ih, 0);
      o.rotation.set(it.jr, Math.PI / 2 + it.jy, sway);
      o.scale.setScalar(isc * p);
    }

    // bubble
    this.updateBubble(dt, hungry);
    r.updateMatrixWorld(true);
  }
  // hunter: the pose to hold between swipes: hanging rest, drifting into the wind-up before the next swing
  swipeWait(out) {
    const k = this.w.state === 'work' && this.nextSwing < PRE ? smooth01(1 - this.nextSwing / PRE) : 0;
    return mixPose(out, SWIPE.rest, SWIPE.wind, k);
  }
  preTwist() {
    if (this.w.state !== 'work' || this.nextSwing >= PRE) return 0;
    return -TWIST * 0.75 * smooth01(1 - this.nextSwing / PRE);
  }
  preWind(rest) {
    if (this.w.state !== 'work' || this.nextSwing >= PRE) return rest;
    return lerp(rest, WIND * 0.72, smooth01(1 - this.nextSwing / PRE));
  }

  updateBubble(dt, hungry) {
    const B = this.bub;
    B.t += dt;
    if (hungry && (B.state === 'hidden' || B.state === 'out')) { B.state = 'in'; B.t = 0; }
    if (!hungry && (B.state === 'in' || B.state === 'shown')) { B.state = 'out'; B.t = 0; }
    let s = 0;
    if (B.state === 'in') { s = lerp(0.6, 1, ease.backOut(clamp(B.t / 0.32), 2.4)); if (B.t >= 0.32) B.state = 'shown'; }
    else if (B.state === 'shown') s = 1 + Math.sin(this.time * 3.1) * 0.03;
    else if (B.state === 'out') {
      s = B.t < 0.08 ? 1 + 0.1 * ease.quadOut(B.t / 0.08) : 1.1 * (1 - ease.cubicIn(clamp((B.t - 0.08) / 0.16)));
      if (B.t > 0.24) { B.state = 'hidden'; s = 0; }
    }
    B.s = s;
    const o = this.bubble;
    o.visible = s > 0.001;
    if (!o.visible) return;
    const cam = this.sys.camera;
    const top = WLAYOUT.headTopY * this.k;
    o.position.set(this.x, this.y + top + BUBBLE_UP * this.k + Math.sin(this.time * 2.2) * 0.025 + (this.hopY > 0 ? this.hopY : 0), this.z);
    o.quaternion.copy(cam.quaternion);
    o.rotateZ(Math.sin(this.time * 1.7) * 0.06);
    // shift right on screen so the trailing dots point at the head
    o.translateX(0.16 * this.k);
    o.scale.setScalar(s * this.k * 1.05);
    o.updateMatrixWorld(true);
  }

  write(pools, itemPool) {
    if (!this.root.visible) return;
    for (const [key, node] of this.parts) pools[key]?.push(node.matrixWorld, this.flash, null);
    if (this.snackS > 0.01) pools.snack?.push(this.snack.matrixWorld, 0, null);
    if (this.bubble.visible) pools.bubble?.push(this.bubble.matrixWorld, 0, null);
    if (this.lidC > 0.04 && pools.lid) for (const side of [-1, 1]) pools.lid.push(lidMatrix(_lm, this.head.matrixWorld, WLAYOUT.eye, side, this.lidC), this.flash, this.lidTint);
    for (let i = 0; i < this.stack.length; i++) itemPool(this.stack[i].item)?.push(this.slots[i].matrixWorld);
  }
  shadow(out) {
    const lift = this.hopY + (this.spawn ? arc(clamp(this.spawn.t / 0.45)) * 0.42 : 0);
    const s = clamp(1 - lift * 1.4, 0.45, 1) * this.k;
    out.x = this.root.position.x; out.z = this.root.position.z; out.y = this.y; out.h = this.h;
    out.sx = WLAYOUT.shadow[0] * s; out.sz = WLAYOUT.shadow[1] * s;
    return out;
  }
  dispose() { this.sys.root.remove(this.root); this.sys.root.remove(this.bubble); }
}
