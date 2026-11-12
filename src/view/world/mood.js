// World mood: how warm the camp is and how far the clouds have opened. One instance per game (cached on
// ctx), shared by lighting.js (cool -> warm light), sky.js (cloud hole + thin cloud over locked islands) and
// post.js (cold grade + the warm wave spreading from the hearth). lighting.update() ticks it first thing every
// frame (lighting is the first module in main.js's update order), so the others read this frame's values.
//
// Camp mode (ctx.camp):
//   level 0      the hearth is cold: cool, slightly dim, desaturated grade; clouds tight around a small circle.
//   hearth:level the hearth ignites -> a warm wave spreads from it over WAVE_TIME and the colours warm up;
//                the cloud hole eases to the new level's size over OPEN_TIME with a slight overshoot.
//   bridge:built the thin cloud over that island clears, spreading from the bridge's landing.
// Factory mode (no ctx.camp): always warm, clouds fully open, no locks.
// Everything advances from dt only (never wall-clock time), so __game.step and pausing stay deterministic.
import { ease, clamp } from '../../util/anim.js';

export const WAVE_TIME = 1.2;   // s for the warm wave to sweep the frame
export const OPEN_TIME = 1.5;   // s for the cloud hole to reach a new level's size (slight overshoot)
export const CLEAR_TIME = 1.7;  // s for an island's thin cloud to clear once its bridge is built
const OPEN_OVERSHOOT = 1.25;    // backOut tension (1.70158 = classic ~10%; 1.25 is ~6%)
const MAX_LOCKS = 4;

const cache = new WeakMap();

export function getMood(ctx) {
  let m = cache.get(ctx);
  if (!m) { m = createMood(ctx); cache.set(ctx, m); }
  return m;
}

function createMood(ctx) {
  const { camp, map, events } = ctx;
  const campMode = !!camp;
  const levelNow = () => (campMode ? Number(camp.level) || 0 : 5);

  const hearthAt = () => {
    const c = camp?.stationCenter?.('hearth');
    return c && Number.isFinite(c.x) ? { x: c.x, z: c.z } : { x: map.start.x, z: map.start.z };
  };

  const mood = {
    campMode,
    level: levelNow(),
    // 1 = the whole world is in the cold look, 0 = warm. While the wave runs, post shows cold only outside it.
    cold: campMode && levelNow() < 1 ? 1 : 0,
    // warmth for the light rig: 0 cold .. 1 warm (eases with the wave)
    warmth: campMode && levelNow() < 1 ? 0 : 1,
    wave: { active: false, t: 0, p: 0, x: 0, z: 0 },   // p: 0..1 eased progress of the front
    // cloud hole size as a continuous camp level (overshoots a little when it grows)
    open: levelNow(),
    openFrom: levelNow(), openTo: levelNow(), openT: OPEN_TIME,
    // islands under thin cloud until their bridge is built (camp maps only)
    locks: buildLocks(map, camp),
    // a moment flag other modules can read: seconds since the hearth last levelled (Infinity = never)
    sinceLevel: Infinity,
    update,
    // debugging / tests: replay the ignition or a level change without touching the sim
    replay(level = 1) { onLevel(level, true); },
  };

  function onLevel(level, force = false) {
    if (!campMode && !force) return;
    const prev = mood.level;
    mood.level = level;
    mood.sinceLevel = 0;
    if ((prev < 1 && level >= 1) || force) {
      const h = hearthAt();
      mood.wave = { active: true, t: 0, p: 0, x: h.x, z: h.z };
      mood.cold = 1;
    }
    mood.openFrom = mood.open;
    mood.openTo = level;
    mood.openT = 0;
  }

  function onBridge(bridgeId) {
    const L = mood.locks.find(l => l.bridgeId === bridgeId);
    if (!L || L.clearing || L.amount <= 0) return;
    L.clearing = true;
    L.t = 0;
  }

  const offs = [];
  if (campMode && events?.on) {
    offs.push(events.on('hearth:level', ({ level }) => onLevel(Number(level) || levelNow())));
    offs.push(events.on('bridge:built', ({ bridge }) => onBridge(bridge?.id)));
  }
  mood.dispose = () => offs.forEach(f => f?.());

  function update(dt) {
    if (!(dt >= 0)) return;
    // the sim may change level without our seeing the event (e.g. restored state): follow it anyway
    if (campMode && levelNow() !== mood.level) onLevel(levelNow());
    if (campMode) for (const L of mood.locks) if (L.amount > 0 && !L.clearing && camp.bridges?.has?.(L.bridgeId)) onBridge(L.bridgeId);
    mood.sinceLevel += dt;

    // warm wave
    const w = mood.wave;
    if (w.active) {
      w.t += dt;
      const k = clamp(w.t / WAVE_TIME);
      w.p = ease.quadOut(k);
      mood.warmth = ease.sineInOut(clamp(k * 1.15));
      if (k >= 1) { w.active = false; mood.cold = 0; mood.warmth = 1; }
    } else if (mood.level >= 1 || !campMode) {
      mood.cold = 0; mood.warmth = 1;
    }

    // cloud hole
    if (mood.openT < OPEN_TIME) {
      mood.openT = Math.min(OPEN_TIME, mood.openT + dt);
      const k = mood.openT / OPEN_TIME;
      mood.open = mood.openFrom + (mood.openTo - mood.openFrom) * ease.backOut(k, OPEN_OVERSHOOT);
    } else mood.open = mood.openTo;

    // island clearing
    for (const L of mood.locks) {
      if (!L.clearing) continue;
      L.t += dt;
      const k = clamp(L.t / CLEAR_TIME);
      L.front = L.reach * ease.quadOut(k);
      L.amount = 1 - ease.cubicIn(clamp((k - 0.55) / 0.45));
      if (k >= 1) { L.clearing = false; L.amount = 0; L.front = -1; }
    }
  }

  return mood;
}

// One lock per bridge that leads to a named island: { bridgeId, island, landing {x, z}, reach, amount, front }.
function buildLocks(map, camp) {
  if (!camp || !map?.bridges || !map.islandAt) return [];
  const locks = [];
  for (const [id, b] of Object.entries(map.bridges)) {
    const t = b.tiles || [];
    if (!t.length) continue;
    const last = t[t.length - 1], prev = t.length > 1 ? t[t.length - 2] : null;
    let dx = prev ? Math.sign(last[0] - prev[0]) : (b.orientation === 1 ? 1 : 0);
    let dz = prev ? Math.sign(last[1] - prev[1]) : (b.orientation === 1 ? 0 : 1);
    // the island at the far end (try both ends: the far one is not the home island)
    const ends = [[last[0] + dx, last[1] + dz, last, dx, dz], [t[0][0] - dx, t[0][1] - dz, t[0], -dx, -dz]];
    let pick = null;
    for (const [x, z, tile, ddx, ddz] of ends) {
      const isl = map.islandAt(x, z);
      if (isl && isl !== 'home') { pick = { isl, tile, ddx, ddz }; break; }
    }
    if (!pick) continue;
    // how far the island reaches from its landing (so the clearing front sweeps all of it)
    let reach = 4;
    const lx = pick.tile[0] + pick.ddx * 0.5, lz = pick.tile[1] + pick.ddz * 0.5;
    for (let z = 0; z < map.h; z++) for (let x = 0; x < map.w; x++) {
      if (map.isLand(x, z) && map.islandAt(x, z) === pick.isl) reach = Math.max(reach, Math.hypot(x - lx, z - lz) + 2.5);
    }
    const built = camp.bridges?.has?.(id);
    locks.push({ bridgeId: id, island: pick.isl, landing: { x: lx, z: lz }, reach, amount: built ? 0 : 1, front: -1, clearing: false, t: 0 });
    if (locks.length >= MAX_LOCKS) break;
  }
  return locks;
}
