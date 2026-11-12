// Free 8-direction movement for the player: a circle that walks over the tile grid with exponential
// velocity smoothing, collision against non-walkable tiles (slides along walls, rounds corners), corner
// forgiveness toward nearby gaps, smoothed path following through tile-centre waypoints, and heading
// that follows the velocity. Pure logic (no three.js) so tests can drive it from node.
//
// Positions are world units (tile (x, z) spans x-0.5..x+0.5). Heading uses atan2(dz, dx): 0 = east,
// PI/2 = south (toward the camera).

export const RADIUS = 0.28;        // collision circle
const ACC_K = 24;                  // velocity approach rate while there is input: ~90% in 0.1 s
const DEC_K = 38;                  // ... with no input: at rest in ~0.08 s
const HEAD_W = 56;                 // heading spring rate (critically damped): a 90-degree turn in ~0.11 s
const MAX_TURN = 30;               // rad/s cap, so even a full reversal arcs instead of pivoting
const HEAD_LEAD = 1.15;            // how much the input direction leads the heading ahead of the velocity
const FACE_W = 30;                 // ... toward an explicit facing (swings, faceTile)
const MAX_SUB = 0.06;              // longest move per collision sub-step (tiles): no tunnelling at any dt
const ASSIST = 0.42;               // corner forgiveness: how far to the side we look for a gap
const ASSIST_GAIN = 16;            // lateral nudge speed per tile of remaining offset
const EJECT_SPEED = 4;             // how fast we leave a tile that became blocked under us (tiles/s)
const PATH_LOOK = 0.42;            // carrot distance ahead along a path: rounds the corners
const ARRIVE = 0.5;                // start easing off this far before the end of a path

const TAU = Math.PI * 2;
const wrap = a => { a %= TAU; if (a > Math.PI) a -= TAU; if (a <= -Math.PI) a += TAU; return a; };

export function createMotion({ isWalkable, moveSpeed = 4.2, x = 0, z = 0, heading = Math.PI / 2 }) {
  const s = {
    x, z, vx: 0, vz: 0, heading, speed: 0,
    // inputs
    ix: 0, iz: 0,                 // desired direction from keyboard + analog stick; magnitude 0..1 scales the speed
    face: null,                   // explicit heading to turn to (radians), or null = follow the movement
    path: null,                   // { pts: [{x,z}], i, stopWhen, onArrive, onFail, stall, speed }
    // outputs for animation
    moved: 0,                     // distance actually travelled this update
    blocked: false,               // input pushes into a wall and we did not move much
    headingVel: 0,
    assist: 0,                    // |lateral nudge| this frame (debug)
  };
  let turnSign = 0;               // committed direction of a near-180 turn (toward the camera)
  let lastHeadTarget = heading;

  const solid = (tx, tz) => !isWalkable(tx, tz);

  // Penetration-resolve the circle at (px, pz) against solid tiles. Returns the corrected point and the
  // summed contact normal (outward), so callers can cancel the velocity going into walls.
  const res = { x: 0, z: 0, nx: 0, nz: 0, hit: false };
  function resolve(px, pz, maxPush = Infinity) {
    let nx = 0, nz = 0, hit = false;
    for (let iter = 0; iter < 4; iter++) {
      let any = false;
      const x0 = Math.round(px - RADIUS), x1 = Math.round(px + RADIUS);
      const z0 = Math.round(pz - RADIUS), z1 = Math.round(pz + RADIUS);
      for (let tz = z0; tz <= z1; tz++) for (let tx = x0; tx <= x1; tx++) {
        if (!solid(tx, tz)) continue;
        const cx = Math.min(Math.max(px, tx - 0.5), tx + 0.5);
        const cz = Math.min(Math.max(pz, tz - 0.5), tz + 0.5);
        let dx = px - cx, dz = pz - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= RADIUS * RADIUS - 1e-12) continue;
        let push, ux, uz;
        if (d2 > 1e-14) {
          const d = Math.sqrt(d2);
          ux = dx / d; uz = dz / d; push = RADIUS - d;
        } else {
          // centre inside the tile: leave along the shortest way out (toward a free neighbour if possible)
          const ex = [tx + 0.5 - px, px - (tx - 0.5)], ez = [tz + 0.5 - pz, pz - (tz - 0.5)];
          const opts = [
            [ex[0], 1, 0, tx + 1, tz], [ex[1], -1, 0, tx - 1, tz], [ez[0], 0, 1, tx, tz + 1], [ez[1], 0, -1, tx, tz - 1],
          ].sort((a, b) => (solid(a[3], a[4]) - solid(b[3], b[4])) || a[0] - b[0]);
          [push, ux, uz] = [opts[0][0] + RADIUS, opts[0][1], opts[0][2]];
        }
        push = Math.min(push, maxPush);
        px += ux * push; pz += uz * push;
        nx += ux; nz += uz; hit = any = true;
      }
      if (!any) break;
    }
    res.x = px; res.z = pz; res.nx = nx; res.nz = nz; res.hit = hit;
    return res;
  }

  function overlaps(px, pz) {
    const x0 = Math.round(px - RADIUS), x1 = Math.round(px + RADIUS);
    const z0 = Math.round(pz - RADIUS), z1 = Math.round(pz + RADIUS);
    for (let tz = z0; tz <= z1; tz++) for (let tx = x0; tx <= x1; tx++) {
      if (!solid(tx, tz)) continue;
      const cx = Math.min(Math.max(px, tx - 0.5), tx + 0.5), cz = Math.min(Math.max(pz, tz - 0.5), tz + 0.5);
      const dx = px - cx, dz = pz - cz;
      if (dx * dx + dz * dz < RADIUS * RADIUS - 1e-9) return true;
    }
    return false;
  }

  // Corner forgiveness: walking (nearly) straight into a wall with an opening a little to one side slides us
  // toward it instead of stopping dead. Returns the lateral offset to the nearest place we fit through (0 = none).
  function cornerAssist(dx, dz) {
    const ax = Math.abs(dx), az = Math.abs(dz);
    if (Math.max(ax, az) < 0.9) return 0;            // diagonal input already slides along walls by itself
    const fx = ax > az ? Math.sign(dx) : 0, fz = ax > az ? 0 : Math.sign(dz);
    const lx = fz !== 0 ? 1 : 0, lz = fx !== 0 ? 1 : 0; // lateral axis
    const PROBE = 0.05;
    if (!overlaps(s.x + fx * PROBE, s.z + fz * PROBE)) return 0;
    const bias = fx !== 0 ? dz : dx;                  // a slight sideways input picks that side first
    const first = bias >= 0 ? 1 : -1;
    for (let o = 0.02; o <= ASSIST + 1e-9; o += 0.02) {
      for (const sg of [first, -first]) {
        const qx = s.x + lx * sg * o, qz = s.z + lz * sg * o;
        if (overlaps(qx, qz) || overlaps(s.x + lx * sg * o * 0.5, s.z + lz * sg * o * 0.5)) continue;
        if (!overlaps(qx + fx * PROBE, qz + fz * PROBE)) return sg * (o + 0.03);
      }
    }
    return 0;
  }

  // Path following: carrot point PATH_LOOK ahead along the polyline (start -> waypoints).
  function pathDesire(out) {
    const p = s.path;
    const pts = p.pts;
    // advance past waypoints we have reached or passed (projection beyond the segment end)
    while (p.i < pts.length - 1) {
      const a = p.i === 0 ? p.start : pts[p.i - 1], b = pts[p.i];
      const sx = b.x - a.x, sz = b.z - a.z, L2 = sx * sx + sz * sz || 1;
      const t = ((s.x - a.x) * sx + (s.z - a.z) * sz) / L2;
      const db = Math.hypot(b.x - s.x, b.z - s.z);
      if (t >= 1 || db < PATH_LOOK * 0.75) p.i++;
      else break;
    }
    // carrot: walk PATH_LOOK along the polyline from our projection on the current segment
    const a = p.i === 0 ? p.start : pts[p.i - 1], b = pts[p.i];
    const sx = b.x - a.x, sz = b.z - a.z, L = Math.hypot(sx, sz) || 1;
    let t = Math.max(0, Math.min(1, ((s.x - a.x) * sx + (s.z - a.z) * sz) / (L * L)));
    let cx = a.x + sx * t, cz = a.z + sz * t, left = PATH_LOOK, seg = p.i;
    let remaining = Math.hypot(b.x - cx, b.z - cz);
    for (let j = p.i + 1; j < pts.length; j++) remaining += Math.hypot(pts[j].x - pts[j - 1].x, pts[j].z - pts[j - 1].z);
    while (left > 0) {
      const tx = pts[seg].x, tz = pts[seg].z, d = Math.hypot(tx - cx, tz - cz);
      if (d >= left) { cx += ((tx - cx) / d) * left; cz += ((tz - cz) / d) * left; left = 0; }
      else { cx = tx; cz = tz; left -= d; if (++seg >= pts.length) break; }
    }
    const dx = cx - s.x, dz = cz - s.z, dl = Math.hypot(dx, dz);
    const end = pts[pts.length - 1];
    const toEnd = Math.hypot(end.x - s.x, end.z - s.z);
    remaining = Math.max(Math.min(remaining, toEnd + 1.5), toEnd);
    out.remaining = remaining;
    if (dl < 1e-6) { out.x = 0; out.z = 0; out.k = 0; return out; }
    out.x = dx / dl; out.z = dz / dl;
    out.k = Math.min(1, remaining / ARRIVE);          // ease off on the final stretch
    return out;
  }

  const want = { x: 0, z: 0, k: 0, remaining: 0 };

  function step(dt) {
    s.moved = 0; s.assist = 0;
    if (!(dt > 0)) return s;

    // ---- desired velocity ----
    let dx = s.ix, dz = s.iz, k = Math.min(1, Math.hypot(s.ix, s.iz));
    let following = false;
    if (s.path && !(dx || dz)) {
      const p = s.path;
      if (p.stopWhen?.(s.x, s.z)) { finishPath(true); }
      else {
        pathDesire(want);
        if (want.remaining < 0.035 && Math.hypot(s.vx, s.vz) < 0.6) finishPath(true);
        else { dx = want.x; dz = want.z; k = Math.max(want.k, 0.06); following = true; }
      }
    }
    const len = Math.hypot(dx, dz);
    if (len > 1e-9) { dx /= len; dz /= len; }
    const has = len > 1e-9;
    let vdx = dx * moveSpeed * k, vdz = dz * moveSpeed * k;

    if (has) {
      const off = cornerAssist(dx, dz);
      if (off) {
        // move the lateral component toward the opening; the forward push stays (the wall holds it)
        const lat = Math.sign(off) * Math.min(moveSpeed, Math.abs(off) * ASSIST_GAIN);
        if (Math.abs(dx) > Math.abs(dz)) vdz = lat; else vdx = lat;
        s.assist = Math.abs(lat);
      }
    }

    // ---- integrate in sub-steps (exact exponential approach within each) ----
    const kk = has ? ACC_K : DEC_K;
    const vmax = Math.max(Math.hypot(s.vx, s.vz), Math.hypot(vdx, vdz));
    const n = Math.max(1, Math.ceil((vmax * dt) / MAX_SUB));
    const h = dt / n;
    const e = Math.exp(-kk * h), g = (1 - e) / kk;
    const x0 = s.x, z0 = s.z;
    let contact = false;
    for (let i = 0; i < n; i++) {
      const px = s.x + vdx * h + (s.vx - vdx) * g;
      const pz = s.z + vdz * h + (s.vz - vdz) * g;
      s.vx = vdx + (s.vx - vdx) * e;
      s.vz = vdz + (s.vz - vdz) * e;
      const r = resolve(px, pz);
      if (r.hit) {
        contact = true;
        const nl = Math.hypot(r.nx, r.nz);
        if (nl > 1e-9) {
          const nx = r.nx / nl, nz = r.nz / nl, vn = s.vx * nx + s.vz * nz;
          if (vn < 0) { s.vx -= vn * nx; s.vz -= vn * nz; }
        }
      }
      s.x = r.x; s.z = r.z;
    }
    // a tile that turned solid under us (something built there): ease out instead of popping
    if (solid(Math.round(s.x), Math.round(s.z))) {
      const r = resolve(s.x, s.z, EJECT_SPEED * dt);
      s.x = r.x; s.z = r.z;
    }
    s.moved = Math.hypot(s.x - x0, s.z - z0);
    s.speed = Math.hypot(s.vx, s.vz);
    s.blocked = has && contact && s.moved < moveSpeed * dt * 0.25;

    // path stall: walking into something that will not move out of the way
    if (following && s.path) {
      s.path.stall = s.moved < moveSpeed * dt * 0.15 ? s.path.stall + dt : 0;
      if (s.path.stall > 0.35) failPath();
    }

    // ---- heading follows the movement (or an explicit facing) ----
    let hx = s.vx / moveSpeed, hz = s.vz / moveSpeed;
    if (has) { const lead = HEAD_LEAD * Math.max(0.35, k); hx += dx * lead; hz += dz * lead; }
    if (s.face != null) {
      turnHeading(wrap(s.face - s.heading), FACE_W, dt);
      turnSign = 0;
    } else if (hx * hx + hz * hz > 0.0225) {
      const target = Math.atan2(hz, hx);
      let d = wrap(target - s.heading);
      if (Math.abs(d) > 2.7) {
        // a reversal: commit to turning through the side that faces the camera (+z), so we see the face
        if (!turnSign || Math.abs(wrap(target - lastHeadTarget)) > 0.5) {
          const viaA = s.heading + d / 2, alt = d - Math.sign(d) * TAU, viaB = s.heading + alt / 2;
          turnSign = Math.sin(viaA) >= Math.sin(viaB) ? Math.sign(d) : Math.sign(alt);
        }
        if (Math.sign(d) !== turnSign) d -= Math.sign(d) * TAU;
      } else turnSign = 0;
      lastHeadTarget = target;
      turnHeading(d, HEAD_W, dt);
    } else {
      // nothing to follow: let any turn in progress coast to a stop (no snap)
      turnHeading(0, HEAD_W, dt);
      turnSign = 0;
    }
    return s;
  }

  // Exact critically damped angular spring toward heading + d (d = remaining turn, already wrapped / committed):
  // starts and ends a turn with zero angular velocity, never overshoots, identical at any frame rate.
  function turnHeading(d, w, dt) {
    const A = -d, B = s.headingVel + w * A, e = Math.exp(-w * dt);
    const y = (A + B * dt) * e;
    let v = (B - w * (A + B * dt)) * e;
    let step = y - A;                                  // how far the heading moves this frame
    if (Math.abs(v) > MAX_TURN) v = Math.sign(v) * MAX_TURN;
    if (Math.abs(step) > MAX_TURN * dt) step = Math.sign(step) * MAX_TURN * dt;
    s.heading = wrap(s.heading + step);
    s.headingVel = v;
  }

  function finishPath(ok) {
    const p = s.path;
    s.path = null;
    if (!p) return;
    try { (ok ? p.onArrive : p.onFail)?.(); } catch (err) { console.error('[player] path callback', err); }
  }
  function failPath() { finishPath(false); }

  return {
    state: s,
    step,
    resolve,
    overlaps,
    // (ix, iz): desired direction; a magnitude below 1 walks slower (analog stick), above 1 is clamped
    setInput(ix, iz) { s.ix = ix; s.iz = iz; },
    // turn toward heading h (radians, atan2(dz, dx)) and hold it; null hands the heading back to the movement
    face(h) { s.face = Number.isFinite(h) ? h : null; },
    // pts: [{x, z}] world points (tile centres) to walk through. opts: { stopWhen(x, z), onArrive, onFail }
    follow(pts, opts = {}) {
      const old = s.path;
      s.path = null;
      if (old) try { old.onFail?.(); } catch (err) { console.error('[player] path callback', err); }
      const list = (pts || []).map(p => ({ x: p.x, z: p.z }));
      if (!list.length) { try { opts.onArrive?.(); } catch (err) { console.error(err); } return; }
      s.path = { pts: list, i: 0, start: { x: s.x, z: s.z }, stopWhen: opts.stopWhen, onArrive: opts.onArrive, onFail: opts.onFail, stall: 0 };
    },
    cancelPath() { failPath(); },
    teleport(x, z, heading) {
      s.x = x; s.z = z; s.vx = s.vz = 0; s.speed = 0;
      if (Number.isFinite(heading)) s.heading = heading;
      s.path = null;
    },
    turnTo(h) { s.heading = h; },
  };
}
