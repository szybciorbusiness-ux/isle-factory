// Animal view controller: one invisible Object3D rig per camp animal, animated from camp state with smoothing,
// gaits tied to distance travelled, idle behaviours and hit / kill / spawn reactions. The rig's matrices are
// written into the species' instanced part pools by creatures.js every frame.
import * as THREE from 'three';
import { ease, clamp, lerp, damp, dampAngle, angleDelta, arc, Spring } from '../../util/anim.js';
import { ANIMALS } from '../../sim/camp-data.js';
import { LAYOUT } from './animal-models.js';
import { rng, hashStr } from './kit.js';

const TAU = Math.PI * 2;
const frac = v => v - Math.floor(v);
const _v = new THREE.Vector3();
const KNOCK = 0.6;            // knockback spring -> world offset

// Gaits: stride = world tiles per full cycle, duty = fraction of the cycle a foot is planted,
// offsets for legs [LF, RF, LH, RH]. Rabbits hop instead (hopLen / hopH).
const GAIT = {
  deer: {
    walk: { stride: 0.44, duty: 0.62, lift: 0.055, offsets: [0.25, 0.75, 0.0, 0.5], bob: 0.012 },
    run: { stride: 1.0, duty: 0.34, lift: 0.08, offsets: [0.0, 0.1, 0.5, 0.6], bob: 0.06, pitch: 0.16 },
  },
  boar: {
    walk: { stride: 0.32, duty: 0.56, lift: 0.045, offsets: [0.0, 0.5, 0.5, 0.0], bob: 0.012 },
    run: { stride: 0.55, duty: 0.42, lift: 0.06, offsets: [0.0, 0.5, 0.5, 0.0], bob: 0.03, pitch: 0.05 },
  },
  rabbit: { walk: { hopLen: 0.5, hopH: 0.11 }, run: { hopLen: 0.95, hopH: 0.2 } },
};
// Idle behaviour weights per species: [kind, weight, minDur, maxDur]
const IDLE = {
  deer: [['graze', 5, 2.0, 4.2], ['look', 3, 1.0, 2.0], ['rest', 2, 0.8, 1.8]],
  boar: [['root', 5, 1.8, 3.6], ['look', 2, 0.8, 1.6], ['rest', 2, 0.8, 1.6]],
  rabbit: [['nibble', 4, 1.2, 2.6], ['perk', 3, 0.9, 1.8], ['look', 2, 0.6, 1.4], ['rest', 2, 0.6, 1.4]],
};

export class AnimalView {
  // sys: { root (Group), ctx, sizeK, fx(), playerPos(), groundAt(x,z) }
  constructor(sys, a, { spawn = false } = {}) {
    this.sys = sys; this.a = a; this.id = a.id; this.kind = a.kind;
    this.L = LAYOUT[a.kind]; this.G = GAIT[a.kind]; this.def = ANIMALS[a.kind];
    this.rnd = rng(hashStr(a.id) + 17);
    const L = this.L;
    this.k = L.scale * sys.sizeK;   // model -> world scale

    // ---- rig ----
    const O = () => new THREE.Object3D();
    this.root = O(); this.root.name = `animal:${a.id}`;
    this.tilt = O(); this.hop = O(); this.squashN = O();
    this.root.add(this.tilt); this.tilt.add(this.hop); this.hop.add(this.squashN);
    // tilt pivot (rabbits rock back onto their haunches)
    const px = L.tiltPivot || 0;
    this.tilt.position.x = px; this.hop.position.x = -px;
    this.root.scale.setScalar(this.k);
    this.body = O(); this.squashN.add(this.body);
    this.head = O(); this.head.position.set(...L.head); this.squashN.add(this.head);
    this.ears = [-1, 1].map(s => { const e = O(); e.position.set(L.ear[0], L.ear[1], s * L.ear[2]); this.head.add(e); return e; });
    this.tail = null;
    if (L.tail) { this.tail = O(); this.tail.position.set(...L.tail); this.squashN.add(this.tail); }
    this.legs = [];
    if (L.legX) {
      // [LF, RF, LH, RH]
      for (const [x, s] of [[L.legX[0], -1], [L.legX[0], 1], [L.legX[1], -1], [L.legX[1], 1]]) {
        const g = O(); g.position.set(x, L.hipY, s * L.legZ); this.squashN.add(g); this.legs.push(g);
      }
    }
    this.feet = [];
    if (L.feet) for (const s of [-1, 1]) { const f = O(); f.position.set(L.feet[0], L.feet[1], s * L.feet[2]); this.squashN.add(f); this.feet.push(f); }
    sys.root.add(this.root);

    const K = a.kind;
    this.parts = [[`${K}.body`, this.body], [`${K}.head`, this.head], ...this.ears.map(e => [`${K}.ear`, e])];
    if (this.tail) this.parts.push([`${K}.tail`, this.tail]);
    for (const l of this.legs) this.parts.push([`${K}.leg`, l]);
    for (const f of this.feet) this.parts.push([`${K}.foot`, f]);
    const tone = 0.95 + this.rnd() * 0.1;
    this.tint = new THREE.Color(tone, tone * (0.985 + this.rnd() * 0.03), tone);

    // ---- motion state ----
    this.x = a.x; this.z = a.z; this.h = a.heading || 0;
    this.y = sys.groundAt(a.x, a.z);
    this.spd = 0; this.moveW = 0; this.runW = 0; this.phase = this.rnd(); this.turn = 0;
    this.squash = new Spring(1, { stiffness: 330, damping: 13 });
    this.pitch = new Spring(0, { stiffness: 200, damping: 16 });
    this.roll = new Spring(0, { stiffness: 200, damping: 15 });
    this.headPitch = new Spring(0, { stiffness: 120, damping: 14 });
    this.headYaw = new Spring(0, { stiffness: 110, damping: 14 });
    this.earS = [0, 1].map(i => new Spring(0, { stiffness: 260 + i * 40, damping: 9 + i }));
    this.tailS = new Spring(0, { stiffness: 320, damping: 10 });
    this.knock = { x: new Spring(0, { stiffness: 140, damping: 15 }), z: new Spring(0, { stiffness: 140, damping: 15 }) };
    this.hopY = 0; this.hopV = 0;
    this.flash = 0; this.flashHold = 0;
    this.lifeScale = 1;
    this.beh = { kind: 'rest', t: 0, dur: 0.5 + this.rnd() * 1.5, yaw: 0 };
    this.idleT = 0;
    this.earTimer = 0.6 + this.rnd() * 2.5; this.tailTimer = 1 + this.rnd() * 3;
    this.alert = 0;
    this.hopPrevU = 0;
    this.time = this.rnd() * 10;

    // life: 'alive' | 'spawn' | 'dying' | 'gone'
    this.life = 'alive'; this.lifeT = 0; this.poofed = false;
    if (spawn) this.startSpawn();
  }

  // ---------- reactions ----------
  startSpawn() {
    this.life = 'spawn'; this.lifeT = 0;
    // hop in from a little behind the spot, out of a dust puff
    const back = 0.45;
    this.spawnFrom = { x: -Math.cos(this.h) * back, z: -Math.sin(this.h) * back };
    const fx = this.sys.fx();
    const gy = this.y;
    fx?.puff?.({ x: this.a.x + this.spawnFrom.x, y: gy + 0.05, z: this.a.z + this.spawnFrom.z }, { count: 6, color: '#f3ead2', size: (this.kind === 'rabbit' ? 0.06 : 0.085) * this.k, spread: 0.16, up: 0.45 });
    fx?.ring?.({ x: this.a.x + this.spawnFrom.x, y: gy + 0.02, z: this.a.z + this.spawnFrom.z }, { radius: 0.3 * this.k, count: 8, size: 0.06, color: '#f3ead2' });
  }
  // attacker: {x, z} or null
  hit(attacker, killed = false) {
    this.flash = 1; this.flashHold = 0.05;
    this.squash.velocity -= killed ? 7 : 5.5;
    let dx = Math.cos(this.h), dz = Math.sin(this.h);
    if (attacker) { dx = this.x - attacker.x; dz = this.z - attacker.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l; }
    this.knock.x.velocity += dx * 3.2; this.knock.z.velocity += dz * 3.2;
    if (this.hopY <= 0.001) this.hopV = killed ? 1.2 : 1.9;
    // tilt away from the blow, in body space
    const fwd = dx * Math.cos(this.h) + dz * Math.sin(this.h), side = -dx * Math.sin(this.h) + dz * Math.cos(this.h);
    this.pitch.velocity += fwd * -4; this.roll.velocity += side * 5;
    for (const e of this.earS) e.velocity += 9;
    this.alert = 1;
    if (!killed) {
      const hp = this.headWorld(_v);
      this.sys.fx()?.sparkle?.({ x: hp.x, y: hp.y + 0.08, z: hp.z }, { count: 3, spread: 0.18, size: 0.07 });
    }
  }
  kill(attacker) {
    if (this.life === 'dying' || this.life === 'gone') return;
    if (this.flash < 0.9) this.hit(attacker, true);
    this.life = 'dying'; this.lifeT = 0; this.poofed = false;
  }
  // the player / a worker is winding up at it: perk up and flinch
  threatened() {
    this.alert = 1;
    for (const e of this.earS) e.velocity -= 6;
    this.squash.velocity -= 1.2;
  }
  headWorld(out) {
    this.root.updateMatrixWorld(true);
    return out.set(0.08, 0.12, 0).applyMatrix4(this.head.matrixWorld);
  }
  centerWorld(out) {
    return out.set(this.x, this.y + (this.L.centerY + this.hopY) * this.k, this.z);
  }

  // ---------- per-frame ----------
  update(dt) {
    const a = this.a, L = this.L, sys = this.sys;
    this.time += dt;
    this.lifeT += dt;

    // ---- follow the sim (damped), measure what we actually travelled ----
    let tx = a.x, tz = a.z;
    if (this.life === 'dying') { tx = this.x; tz = this.z; }
    else if (Math.hypot(tx - this.x, tz - this.z) > 2.5) { this.x = tx; this.z = tz; this.spd = 0; } // teleported: cut
    const kf = 1 - Math.exp(-11 * dt);
    const nx = this.x + (tx - this.x) * kf, nz = this.z + (tz - this.z) * kf;
    const dx = nx - this.x, dz = nz - this.z, d = Math.hypot(dx, dz);
    this.x = nx; this.z = nz;
    const vInst = dt > 0 ? Math.min(8, d / dt) : 0;
    this.spd = damp(this.spd, vInst, 12, dt);
    const moving = this.spd > 0.12 && this.life !== 'dying';
    this.moveW = damp(this.moveW, moving ? 1 : 0, moving ? 9 : 6, dt);
    const runK = clamp((this.spd - this.def.speed * 1.15) / Math.max(0.1, this.def.fleeSpeed * 0.8 - this.def.speed * 1.15));
    this.runW = damp(this.runW, a.state === 'flee' ? Math.max(runK, 0.6) : runK, 6, dt);
    this.y = damp(this.y, sys.groundAt(this.x, this.z), 10, dt);

    // heading: movement direction while moving, the sim's heading otherwise
    const prevH = this.h;
    const wantH = d > 2e-4 && this.life !== 'dying' ? Math.atan2(dz, dx) : (Number.isFinite(a.heading) ? a.heading : this.h);
    this.h = dampAngle(this.h, wantH, moving ? 9 : 4, dt);
    const turnRate = dt > 0 ? angleDelta(prevH, this.h) / dt : 0;
    this.turn = damp(this.turn, turnRate, 8, dt);

    // ---- gait ----
    let bob = 0, gaitPitch = 0, gaitRoll = 0, headNod = 0;
    if (this.kind === 'rabbit') ({ bob, gaitPitch } = this.hopGait(d, dt, moving));
    else ({ bob, gaitPitch, gaitRoll, headNod } = this.legGait(d));

    // ---- behaviours (idle grazing, looking, alert) ----
    const idle = a.state === 'idle' && !moving && this.life === 'alive';
    this.idleT = idle ? this.idleT + dt : 0;
    const pl = sys.playerPos();
    const pd = pl ? Math.hypot(pl.x - this.x, pl.z - this.z) : 99;
    const alertTarget = pd < 2.3 && this.life !== 'dying' ? 1 : 0;
    this.alert = damp(this.alert, alertTarget, alertTarget ? 6 : 1.4, dt);
    let hp = 0, hy = 0, bodyPitchT = 0, earT = 0, bodyRise = 0;
    if (idle && this.idleT > 0.25) {
      const b = this.beh;
      b.t += dt;
      if (b.t > b.dur) this.pickBehaviour();
      const k = clamp(Math.min(b.t / 0.35, (b.dur - b.t) / 0.4 + 0.2));
      switch (b.kind) {
        case 'graze':
          hp = lerp(0, -1.45, k) + Math.sin(this.time * 8.5) * 0.06 * k;
          bodyPitchT = -0.12 * k; earT = 0.25 * k;
          break;
        case 'root':
          hp = lerp(0, -0.5, k) + Math.sin(this.time * 11) * 0.05 * k;
          hy = Math.sin(this.time * 6.3) * 0.22 * k; bodyPitchT = -0.06 * k;
          break;
        case 'nibble':
          hp = lerp(0, -0.42, k) + Math.abs(Math.sin(this.time * 13)) * 0.08 * k;
          bodyPitchT = -0.05 * k;
          break;
        case 'perk':
          bodyPitchT = 0.55 * k; hp = -0.35 * k; earT = -0.25 * k; bodyRise = 0.025 * k;
          break;
        case 'look':
          hy = b.yaw * k; hp = 0.12 * k;
          break;
        default: hp = 0;
      }
    } else if (!moving) { this.beh.t = this.beh.dur; } // restart behaviours fresh after moving
    // alert: look at the player, ears up, stop grazing
    if (this.alert > 0.01 && pl && this.life !== 'dying') {
      const rel = clamp(angleDelta(this.h, Math.atan2(pl.z - this.z, pl.x - this.x)), -1.1, 1.1);
      const w = this.alert * (moving ? 0.3 : 1);
      hy = lerp(hy, -rel, w); hp = lerp(hp, 0.15, w); earT = lerp(earT, -0.35, w); bodyPitchT = lerp(bodyPitchT, 0, w);
    }
    if (moving) {
      hp += headNod + (this.kind === 'deer' ? -0.22 : -0.1) * this.runW;
      earT += 0.5 * this.runW;
      hy += clamp(-this.turn * 0.12, -0.4, 0.4);
    }
    this.headPitch.target = hp; this.headYaw.target = hy;
    this.headPitch.update(dt); this.headYaw.update(dt);

    // ---- ears & tail ----
    this.earTimer -= dt;
    if (this.earTimer <= 0) {
      this.earTimer = 0.8 + this.rnd() * 3;
      const which = this.rnd() < 0.5 ? 0 : 1;
      this.earS[which].velocity += (this.rnd() < 0.5 ? -1 : 1) * 6.5;
      if (this.rnd() < 0.3) this.earS[1 - which].velocity += 4.5;
    }
    for (const e of this.earS) { e.target = earT; e.update(dt); }
    if (this.tail) {
      this.tailTimer -= dt;
      if (this.tailTimer <= 0) { this.tailTimer = 1.2 + this.rnd() * 3.5; this.tailS.velocity += 22; }
      this.tailS.target = (this.kind === 'deer' ? 0.25 : 0) * this.runW + (moving ? Math.sin(this.phase * TAU * 2) * 0.12 : 0);
      this.tailS.update(dt);
    }

    // ---- springs: squash, tilt, knockback, hop ----
    this.squash.target = 1 + Math.sin(this.time * 2.3) * 0.012 * (1 - this.moveW);
    this.squash.update(dt);
    this.pitch.target = bodyPitchT + gaitPitch; this.pitch.update(dt);
    this.roll.target = clamp(-this.turn * this.spd * 0.035, -0.25, 0.25) + gaitRoll; this.roll.update(dt);
    this.knock.x.update(dt); this.knock.z.update(dt);
    if (this.hopV !== 0 || this.hopY > 0) {
      this.hopV -= 16 * dt; this.hopY += this.hopV * dt;
      if (this.hopY <= 0) { this.hopY = 0; if (this.hopV < -0.6) this.squash.velocity -= Math.min(4, -this.hopV * 1.6); this.hopV = 0; }
    }
    this.flashHold -= dt;
    if (this.flashHold <= 0) this.flash = this.flash > 0.002 ? this.flash * Math.exp(-17 * dt) : 0;

    // ---- life: spawn hop, poof ----
    let lifeS = 1, offX = 0, offZ = 0, lifeY = 0;
    if (this.life === 'spawn') {
      const T = 0.46, t = this.lifeT;
      const k = clamp(t / T);
      lifeS = lerp(0.6, 1, ease.backOut(clamp(t / 0.3), 2.2));
      offX = this.spawnFrom.x * (1 - ease.quadOut(k)); offZ = this.spawnFrom.z * (1 - ease.quadOut(k));
      lifeY = arc(k) * 0.32 * this.k;
      if (t >= T) { this.life = 'alive'; this.squash.velocity -= 4.5; sys.fx()?.ring?.({ x: this.x, y: this.y + 0.02, z: this.z }, { radius: 0.3 * this.k, count: 7, size: 0.055, color: '#f3ead2' }); }
    } else if (this.life === 'dying') {
      const t = this.lifeT;
      this.flash = Math.max(this.flash, 1 - t * 4);
      if (!this.poofed && t >= 0.06) { this.poofed = true; this.poof(); }
      if (t < 0.09) lifeS = 1 + 0.14 * ease.quadOut(t / 0.09);
      else lifeS = 1.14 * (1 - ease.cubicIn(clamp((t - 0.09) / 0.2)));
      if (t > 0.3) { this.life = 'gone'; lifeS = 0; }
    } else if (this.life === 'gone') lifeS = 0;
    this.lifeScale = lifeS;

    // ---- compose the rig ----
    const r = this.root;
    r.visible = lifeS > 0.001;
    r.position.set(this.x + this.knock.x.value * KNOCK + offX, this.y, this.z + this.knock.z.value * KNOCK + offZ);
    r.rotation.set(0, -this.h, 0);
    r.scale.setScalar(this.k * Math.max(lifeS, 1e-4));
    this.tilt.rotation.set(this.roll.value, 0, this.pitch.value);
    this.hop.position.y = (bob + bodyRise) + (this.hopY + lifeY) / this.k;
    const s = clamp(this.squash.value, 0.45, 1.6);
    this.squashN.scale.set(1 / Math.sqrt(s), s, 1 / Math.sqrt(s));
    this.head.rotation.set(0, this.headYaw.value, this.headPitch.value);
    const er = L.earRest;
    this.ears.forEach((e, i) => {
      const side = i === 0 ? -1 : 1;
      e.rotation.set(side * er.x, 0, er.z + this.earS[i].value);
    });
    if (this.tail) this.tail.rotation.set(0, 0, L.tailRest + this.tailS.value);
    r.updateMatrixWorld(true);
  }

  legGait(d) {
    const G = this.G, L = this.L, w = this.runW, m = this.moveW;
    const stride = lerp(G.walk.stride, G.run.stride, w);
    this.phase += d / stride;
    const duty = lerp(G.walk.duty, G.run.duty, w);
    const reach = (duty * stride) / 2 / this.k;      // foot travel half-range in model units
    const lift = lerp(G.walk.lift, G.run.lift, w) / this.k;
    for (let i = 0; i < 4; i++) {
      const off = lerp(G.walk.offsets[i], G.run.offsets[i], w);
      const ph = frac(this.phase + off);
      let fxo, ly;
      if (ph < duty) { const u = ph / duty; fxo = reach * (1 - 2 * u); ly = 0; }
      else { const u = (ph - duty) / (1 - duty); fxo = -reach + 2 * reach * ease.sineInOut(u); ly = Math.sin(Math.PI * u) * lift; }
      const leg = this.legs[i];
      leg.rotation.set(0, 0, Math.atan2(fxo, L.legLen) * m);
      leg.scale.set(1, 1 - (ly / L.legLen) * 0.55 * m, 1);
    }
    const walkBob = (0.5 - 0.5 * Math.cos(this.phase * TAU * 2)) * G.walk.bob;
    const runBob = (0.5 - 0.5 * Math.cos(TAU * (this.phase - 0.2))) * G.run.bob;
    const bob = lerp(walkBob, runBob, w) * m / this.k;
    const gaitPitch = Math.sin(TAU * this.phase) * (G.run.pitch || 0) * w * m;
    const gaitRoll = (this.kind === 'boar' ? Math.sin(TAU * this.phase) * 0.07 : Math.sin(TAU * this.phase) * 0.025) * m;
    const headNod = Math.sin(this.phase * TAU * 2) * 0.05 * (1 - w) * m - Math.sin(TAU * this.phase) * 0.12 * w * m;
    return { bob, gaitPitch, gaitRoll, headNod };
  }

  hopGait(d, dt, moving) {
    const G = this.G, w = this.runW;
    const hopLen = lerp(G.walk.hopLen, G.run.hopLen, w);
    const H = lerp(G.walk.hopH, G.run.hopH, w) / this.k;
    this.phase += d / hopLen;
    // stopping mid-hop: finish the hop instead of hanging in the air
    if (!moving && frac(this.phase) > 1e-3) this.phase = Math.min(Math.ceil(this.phase), this.phase + dt * 2.6);
    const F = 0.72;
    const u = frac(this.phase);
    let bob = 0, gaitPitch = 0, footRot = 0;
    const active = this.moveW > 0.02 || u > 1e-3;
    if (active) {
      if (u < F) {
        const t = u / F;
        bob = arc(t) * H;
        gaitPitch = lerp(0.32, -0.3, ease.sineInOut(t));
        footRot = -Math.sin(Math.PI * t) * 0.9;
        // ears lag behind the vertical motion
        const vy = (1 - 2 * t);
        for (const e of this.earS) e.velocity += vy * 2.2 * dt * 60 * 0.12;
      } else {
        const g = (u - F) / (1 - F);
        gaitPitch = -0.3 * (1 - ease.quadOut(g));
      }
      if (this.hopPrevU < F && u >= F) { this.squash.velocity -= 3.2; for (const e of this.earS) e.velocity -= 7; }
    }
    this.hopPrevU = u;
    for (const f of this.feet) f.rotation.set(0, 0, footRot);
    return { bob, gaitPitch };
  }

  pickBehaviour() {
    const list = IDLE[this.kind];
    const total = list.reduce((s, b) => s + b[1], 0);
    let r = this.rnd() * total, pick = list[0];
    for (const b of list) { if ((r -= b[1]) <= 0) { pick = b; break; } }
    if (pick[0] === this.beh.kind && this.rnd() < 0.5) pick = list[(list.indexOf(pick) + 1) % list.length];
    this.beh = { kind: pick[0], t: 0, dur: lerp(pick[2], pick[3], this.rnd()), yaw: (this.rnd() < 0.5 ? -1 : 1) * lerp(0.45, 0.95, this.rnd()) };
  }

  poof() {
    const fx = this.sys.fx();
    if (!fx) return;
    const c = this.centerWorld(_v).clone();
    const k = this.k;
    const big = this.kind === 'rabbit' ? 0.7 : 1;   // a cloud about the animal's size
    fx.puff?.(c, { count: 9, size: 0.115 * big * k, spread: 0.22 * big * k, up: 0.7 });
    fx.puff?.({ x: c.x, y: c.y + 0.1 * big, z: c.z }, { count: 4, size: 0.085 * big * k, spread: 0.14 * big, up: 1.1, delay: 0.05 });
    fx.ring?.({ x: this.x, y: this.y + 0.02, z: this.z }, { radius: 0.48 * big * k, count: 9, size: 0.075 * big, color: '#ffffff' });
    fx.sparkle?.({ x: c.x, y: c.y + 0.12, z: c.z }, { count: 5, spread: 0.3 * big, size: 0.09 });
  }

  // write this rig into the instanced pools
  write(pools) {
    if (!this.root.visible) return;
    for (const [key, node] of this.parts) pools[key]?.push(node.matrixWorld, this.flash, this.tint);
  }
  shadow(out) {
    if (!this.root.visible) return null;
    const lift = this.hopY + (this.life === 'spawn' ? arc(clamp(this.lifeT / 0.46)) * 0.32 * this.k : 0);
    const s = this.lifeScale * clamp(1 - lift * 1.6, 0.45, 1) * this.k;
    out.x = this.x + this.knock.x.value * KNOCK; out.z = this.z + this.knock.z.value * KNOCK; out.y = this.y;
    out.h = this.h; out.sx = this.L.shadow[0] * s; out.sz = this.L.shadow[1] * s;
    return out;
  }
  dispose() { this.sys.root.remove(this.root); }
}
