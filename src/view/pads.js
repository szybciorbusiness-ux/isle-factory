// Build pads as FLOOR PLATES (FIRST-20.md "Pads are floor plates", UI-STYLE.md sticker language).
//
// Each pad is a flat rounded slab lying on the ground over its zone: cream top, darker lip on the near edge,
// 3 px brown outline, gently breathing. On the plate: the cost item icon(s) and ONE big outlined number per item
// (what's still owed), which ticks down with a pop as each paid item lands. The plate fills with green from the
// near edge as it's paid. A small sticker name tag ("Sawmill", "Camp level 2", "Bridge to Forest", "Lumberjack")
// sits on the plate's near edge. Over / beside the plate floats the ghost of what it builds: the real station
// model (views.campview.createModel) for stations, the plank path for bridges, emblems for upgrades and hires,
// a ghost flame in the cold hearth for the first fire.
//
//   pad:shown      -> the plate scales in (0.6 -> 1, backOut), its content pops in a beat later, then the ghost
//   (standing on)  -> the slab presses down (its lip shrinks), a warm halo hugs it
//   pad:paid       -> an item arcs from the top of the stack into the pad (instanced); when it lands the number
//                     ticks down with a pop and the icon bumps; the green fill rises
//   pad:complete   -> in-flight items hurry in, every number flips to a check, the plate flashes green and sinks
//                     away as the station rises (camp view brings the rise's own dust ring + sparkles)
//   bridge:*       -> pads/bridge.js (planks fly in, posts rise, ropes string themselves)
//   hearth:level   -> shockwave ring riding the world's warm wave (views.lighting.mood.wave), light rays, confetti
//   locked bridges -> a very faint dashed plank outline on the water where each future bridge goes
//
// Draw calls: plates 1 + printed content 1 (atlas glyphs) + bridge hints 1 + 1-2 per ghost + 1 per item type in
// flight + 1 per built bridge (5 while one assembles) + 2 during a level-up burst. No DOM.
// All motion runs from update(dt).
import * as THREE from 'three';
import { ease, clamp, lerp, damp, arc, Spring } from '../util/anim.js';
import { STATIONS, UPGRADES, WORKERS, PADS, ISLAND_NAMES as CAMP_ISLAND_NAMES } from '../sim/camp-data.js';
import { createAtlas } from './pads/atlas.js';
import { createPlates } from './pads/plate.js';
import { createGlyphs } from './pads/glyphs.js';
import { createBridgeHints } from './pads/hint.js';
import { buildGhost, ghostMaterial, ghostDepth, bridgeLayout, bridgeFrame } from './pads/ghosts.js';
import { createBridges } from './pads/bridge.js';
import { createBurst } from './pads/burst.js';

// ---- plate tuning (tile units) ----
const PLATE_Y = 0.03;
const INSET = 0.07;        // smallest plate: the zone minus this on each side
const GROW = 0.42;         // a plate may grow this far past its zone (to fit its content) where there's room
const CORNER = 0.2;
const LIP = 0.13;          // slab lip seen on the near edge (the HUD stickers' 4 px lip)
const LIP_PRESSED = 0.045;
const DIGIT_T = 0.4;       // digit ink height at content scale 1
const ICON_T = 0.62;       // icon quad size
const ICON_INK = 0.82;     // share of the icon quad the picture fills across (for spacing)
const COL_GAP = 0.16, ROW_GAP = 0.05;
const PAD_X = 0.13, PAD_N = 0.11, PAD_S = 0.25;  // plate padding around the content (south keeps room for the tag)
const MIN_CS = 0.6, MAX_CS = 1.18;
const TAG_PX = { mobile: 17, desktop: 23 };       // name tag pill height in CSS px (kept readable at any zoom)
// ---- timing ----
const APPEAR_T = 0.5;
const CONTENT_DELAY = 0.1, TAG_DELAY = 0.2, GHOST_DELAY = 0.12;
const OUT_T = 0.62;
// The camp view raises a built station with a 0.17 s anticipation then bursts it out with its own dust ring and
// sparkles; the plate presses down during the anticipation and our confetti fires on the burst.
const BURST_AT = 0.17;
const FLIGHT_MIN = 0.24, FLIGHT_MAX = 0.4;
const FLY_CAP = 48;        // instanced flights per item type

const _p = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3();

export function create(ctx) {
  const camp = ctx.camp;
  if (!camp) return {};
  const { scene, events, views, map, config, camera, renderer, sim } = ctx;
  const mobile = !!ctx.mobile || ctx.quality?.tier === 'mobile';
  const FXN = mobile ? 0.6 : 1;      // particle count multiplier
  let reduced = false;               // prefers-reduced-motion: no breathing, softer pops
  try { reduced = !!matchMedia?.('(prefers-reduced-motion: reduce)')?.matches; } catch { reduced = false; }
  const ITEM_K = mobile ? 1.15 : 1;  // flying item scale (portrait shows fewer, bigger tiles)

  const atlas = createAtlas({
    renderer, config,
    iconUrl: id => views.ui?.iconUrl?.(id) || views.ui?.icons?.get?.(id) || null,
  });
  const plates = createPlates({ cap: 24 });
  const glyphs = createGlyphs({ texture: atlas.texture, cap: 384 });
  const hints = createBridgeHints({ waterY: config.WATER_Y ?? -0.32 });
  scene.add(plates.mesh, glyphs.mesh, hints.mesh);
  const bridges = createBridges(ctx, { quality: ctx.quality });
  const burst = createBurst(ctx);

  const pads = new Map();   // id -> view
  let time = 0;
  let showDelayUntil = 0;   // pads shown right after a completion / level-up wait for the moment to play
  let showStagger = 0;

  // ---------------- names ----------------
  const ISLAND_NAMES = CAMP_ISLAND_NAMES || { west: 'Forest', north: 'Meadow', east: 'Copper isle', south: 'Deer glade' };
  function padName(id) {
    const [kind, raw = ''] = id.split(':');
    const [arg, nth] = raw.split('#');
    if (kind === 'build') return STATIONS[arg]?.name || arg;
    if (kind === 'hearth') return Number(arg) <= 1 ? 'Light the fire' : `Camp level ${arg}`;
    if (kind === 'bridge') return `Bridge to ${ISLAND_NAMES[arg] || 'new land'}`;
    if (kind === 'upgrade') return UPGRADES[arg]?.name || 'Upgrade';
    if (kind === 'hire') return `${WORKERS[arg]?.name || arg}${nth ? ` ${nth}` : ''}`;
    return id;
  }
  // every tag is drawn into the atlas up front: no texture uploads mid-game
  for (const def of PADS) { try { atlas.tag(padName(def.id)); atlas.icon(Object.keys(def.cost)[0]); for (const k of Object.keys(def.cost)) atlas.icon(k); } catch (e) { console.error('[pads] atlas', e); } }

  // ---------------- screen scale (anamorphic stretch + tag size) ----------------
  // Text lying on the ground is foreshortened by the camera pitch; quads are stretched along z by the ratio of a
  // tile's screen width to its screen depth so the print reads upright. Tags keep a readable pixel size.
  const view = { zs: 1.2, pxZ: 40, outline: 3 };
  const _a = new THREE.Vector3(), _b = new THREE.Vector3();
  function measureView() {
    const tx = views.camera?.target?.x ?? sim.player.x, tz = views.camera?.target?.z ?? sim.player.z;
    camera.updateMatrixWorld();
    _a.set(tx, 0, tz).project(camera); _b.set(tx + 1, 0, tz).project(camera);
    const pxX = Math.abs(_b.x - _a.x) * 0.5 * innerWidth;
    _b.set(tx, 0, tz + 1).project(camera);
    const pxZ = Math.abs(_b.y - _a.y) * 0.5 * innerHeight;
    if (pxX > 1 && pxZ > 1) { view.zs = clamp(pxX / pxZ, 1, 1.4); view.pxZ = pxZ; }
    const rtW = views.post?.rtScene?.width || renderer.domElement?.width || innerWidth;
    view.outline = 3.4 * (rtW / Math.max(1, innerWidth));
  }
  measureView();
  const tagDepth = () => clamp((mobile ? TAG_PX.mobile : TAG_PX.desktop) / Math.max(8, view.pxZ), 0.24, 0.56);

  // ---------------- what's around a zone (how far a plate may grow) ----------------
  function stationTiles() {
    const set = new Set();
    const add = r => { if (r) for (let j = 0; j < r[3]; j++) for (let i = 0; i < r[2]; i++) set.add(`${r[0] + i},${r[1] + j}`); };
    add(STATIONS.hearth?.footprint);
    for (const s of camp.stations?.values?.() || []) {
      const d = s.def || STATIONS[s.id];
      if (!d) continue;
      add(d.footprint); add(d.zone);
      for (const t of d.line || []) set.add(`${t[0]},${t[1]}`);
      if (d.pile) set.add(`${d.pile[0]},${d.pile[1]}`);
    }
    return set;
  }
  function growthRoom(v, blocked) {
    const [x0, z0, w, h] = v.zone;
    const room = [GROW, GROW, GROW, GROW]; // west, east, north, south
    const zoneOf = (x, z) => {
      for (const o of pads.values()) {
        if (o === v || o.phase === 'out') continue;
        const [ox, oz, ow, oh] = o.zone;
        if (x >= ox && x < ox + ow && z >= oz && z < oz + oh) return o;
      }
      return null;
    };
    const limit = (x, z) => {
      if (!(map.isLand?.(x, z) ?? true)) return 0;
      if (blocked.has(`${x},${z}`)) return 0.02;
      if (zoneOf(x, z)) return 0;
      const e = sim.at?.(x, z);
      if (e?.resource) return 0.3; // same for tree / stump / rock, so chopping never resizes a plate
      // a pad one tile further out shares the tile between us
      return GROW;
    };
    for (let z = z0; z < z0 + h; z++) { room[0] = Math.min(room[0], limit(x0 - 1, z)); room[1] = Math.min(room[1], limit(x0 + w, z)); }
    for (let x = x0; x < x0 + w; x++) { room[2] = Math.min(room[2], limit(x, z0 - 1)); room[3] = Math.min(room[3], limit(x, z0 + h)); }
    return room;
  }

  // ---------------- content measurement + layout ----------------
  const K = () => DIGIT_T / atlas.DH;                 // tiles per atlas px (digits)
  function numberWidth(str) {
    const k = K();
    let w = 0;
    for (let i = 0; i < str.length; i++) w += atlas.glyph(str[i]).adv * k + (i ? atlas.O * k * 0.9 : 0);
    return w;
  }
  const ICON_GAP = 0.05;
  const pairWidth = numW => ICON_T * ICON_INK + ICON_GAP + atlas.O * K() * 1.2 + numW;
  function layout(v) {
    const blocked = stationTiles();
    const room = growthRoom(v, blocked);
    const [x0, z0, w, h] = v.zone;
    const zl = x0 - 0.5, zr = x0 + w - 0.5, zt = z0 - 0.5, zb = z0 + h - 0.5;
    const L = zl + INSET - Math.max(0, room[0]) , R = zr - INSET + Math.max(0, room[1]);
    const T = zt + INSET - Math.max(0, room[2]), B = zb - INSET + Math.max(0, room[3]);
    const maxW = R - L, maxD = B - T;
    const n = v.entries.length;
    const pairW = Math.max(...v.entries.map(e => pairWidth(numberWidth(String(e.cost)))));
    const pairD = Math.max(ICON_T * 0.9, DIGIT_T + atlas.O * K() * 2) * view.zs;
    let best = null;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const pw = cols * pairW + (cols - 1) * COL_GAP + PAD_X * 2;
      const pd = rows * pairD + (rows - 1) * ROW_GAP + PAD_N + PAD_S;
      const s = Math.min(MAX_CS, maxW / pw, maxD / pd);
      const score = s + (rows === 1 ? 0.03 : 0);
      if (!best || score > best.score) best = { cols, rows, pw, pd, s, score };
    }
    const cs = clamp(best.s, MIN_CS, MAX_CS);
    const minW = w - INSET * 2, minD = h - INSET * 2;
    const pw = clamp(best.pw * cs, minW, Math.max(minW, maxW)), pd = clamp(best.pd * cs, minD, Math.max(minD, maxD));
    const zcx = (zl + zr) / 2, zcz = (zt + zb) / 2;
    const cx = clamp(zcx, L + pw / 2, Math.max(L + pw / 2, R - pw / 2));
    const cz = clamp(zcz, T + pd / 2, Math.max(T + pd / 2, B - pd / 2));
    const keepSide = v.target?.tagSide ?? null;
    v.target = { cx, cz, hx: pw / 2, hz: pd / 2, cs, cols: best.cols, rows: best.rows, pairW, pairD, tagSide: keepSide };
    if (!v.plate) v.plate = { ...v.target, fresh: true };
    v.coverWanted = coverTilesFor(v);
  }
  // Name tags sit on the plate's near (south) edge unless that would hide them (a tree right in front) or run
  // them into a neighbouring plate / tag: then the far edge. Decided for all plates together.
  function tagRect(v, side) {
    const T = v.target, tg = atlas.tag(v.name);
    const d = tagDepth() * view.zs, w = tagDepth() * (tg.w / tg.h);
    const z = T.cz + (T.hz - d * 0.18) * side;
    return { l: T.cx - w / 2, r: T.cx + w / 2, t: z - d / 2, b: z + d / 2 };
  }
  const overlap = (a, b) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
  const plateBox = (T, grow = 0) => ({ l: T.cx - T.hx - grow, r: T.cx + T.hx + grow, t: T.cz - T.hz - grow, b: T.cz + T.hz + grow });
  function tallTiles() {
    const set = new Set();
    const add = r => { if (r) for (let j = 0; j < r[3]; j++) for (let i = 0; i < r[2]; i++) set.add(`${r[0] + i},${r[1] + j}`); };
    add(STATIONS.hearth?.footprint);
    for (const st of camp.stations?.values?.() || []) add((st.def || STATIONS[st.id])?.footprint);
    return set;
  }
  // where a floating emblem shows on screen, as a ground-equivalent box (height h projects ~0.68 h north)
  function emblemBox(v, side) {
    const g = v.ghost;
    if (!g?.info?.float) return null;
    const T = v.target, ez = T.cz - T.hz * 0.42, y0 = 0.3 + (side < 0 ? 0.42 : 0), h = (g.info.height || 0.8) * 0.9;
    return { l: T.cx - 0.36, r: T.cx + 0.36, t: ez - (y0 + h) * 0.68, b: ez - y0 * 0.68 + 0.12 };
  }
  function placeTags(list) {
    const tall = tallTiles();
    for (const v of list) if (v.target.tagSide == null) v.target.tagSide = 1;
    // two passes: the second sees every neighbour's choice (its tag, and its emblem's height)
    for (let pass = 0; pass < 2; pass++) {
      for (const v of list) {
        let best = 1, bestCost = Infinity;
        for (const side of [1, -1]) {
          const r = tagRect(v, side);
          let cost = side < 0 ? 0.02 : 0;
          for (const o of list) {
            if (o === v) continue;
            cost += overlap(r, plateBox(o.target, 0.04)) * 4;
            if (pass) cost += overlap(r, tagRect(o, o.target.tagSide)) * 6;
            const eb = emblemBox(o, o.target.tagSide);
            if (eb) cost += overlap(r, eb) * 3;
          }
          // a tree or a building standing just in front (one or two rows nearer the camera) hides the tag
          for (let row = 1; row <= 2; row++) {
            const z = Math.round(r.b - 0.15 + row);
            for (let x = Math.round(r.l - 0.2); x <= Math.round(r.r + 0.2); x++) {   // canopies are wider than a tile
              const e = sim.at?.(x, z);
              if (e?.resource && e.kind !== 'stump') cost += row === 1 ? 0.35 : 0.3;
              if (tall.has(`${x},${z}`)) cost += row === 1 ? 0.3 : 0.15;
            }
          }
          if (side < 0 && v.ghost?.info?.float) cost += 0.2; // the floating emblem hovers over the far edge (it rises clear)
          // a tag hanging out over the water reads as floating
          const mz = Math.round((r.t + r.b) / 2), mx = Math.round((r.l + r.r) / 2);
          if (!(map.isLand?.(mx, mz) ?? true)) cost += 0.3;
          if (cost < bestCost - 1e-6) { bestCost = cost; best = side; }
        }
        v.target.tagSide = best;
      }
    }
  }
  function relayoutAll() {
    const list = [...pads.values()].filter(v => v.phase !== 'out');
    for (const v of list) layout(v);
    placeTags(list);
    for (const v of list) if (v.plate.fresh) { v.plate.fresh = false; v.plate.tagSide = v.target.tagSide; }
    applyCover();
  }

  // ---------------- grass under the plates (views.terrain.cover) ----------------
  const coverApplied = new Map(); // "x,z" -> amount we last set
  function coverTilesFor(v) {
    const P = v.target;
    const l = P.cx - P.hx, r = P.cx + P.hx, t = P.cz - P.hz, b = P.cz + P.hz;
    const out = [];
    for (let z = Math.floor(t + 0.5); z <= Math.ceil(b - 0.5); z++) {
      for (let x = Math.floor(l + 0.5); x <= Math.ceil(r - 0.5); x++) {
        const ox = Math.min(r, x + 0.5) - Math.max(l, x - 0.5), oz = Math.min(b, z + 0.5) - Math.max(t, z - 0.5);
        if (ox > 0.12 && oz > 0.12) out.push(`${x},${z}`);
      }
    }
    return out;
  }
  function applyCover() {
    const terrain = views.terrain;
    if (!terrain?.cover) return;
    const want = new Map();
    for (const v of pads.values()) {
      if (!v.coverWanted || v.uncovered) continue;
      for (const k of v.coverWanted) want.set(k, 0.6);
    }
    const protectedTiles = stationTiles();
    for (const [k, a] of want) {
      if (protectedTiles.has(k) || coverApplied.get(k) === a) continue;
      const [x, z] = k.split(',').map(Number);
      try { terrain.cover(x, z, 1, 1, a); coverApplied.set(k, a); } catch (e) { console.error('[pads] cover', e); }
    }
    for (const k of [...coverApplied.keys()]) {
      if (want.has(k)) continue;
      coverApplied.delete(k);
      if (protectedTiles.has(k)) continue;  // a station stands here now: it keeps its own cover
      const [x, z] = k.split(',').map(Number);
      try { terrain.cover(x, z, 1, 1, 0); } catch (e) { console.error('[pads] uncover', e); }
    }
  }

  // ---------------- ghosts ----------------
  function makeGhost(pad) {
    const [kind, raw = ''] = pad.id.split(':');
    const arg = raw.split('#')[0];
    // stations: the real model, translucent
    if (kind === 'build' && views.campview?.createModel) {
      let model = null;
      try { model = views.campview.createModel(arg, { opacity: 0 }); } catch (e) { console.error('[pads] createModel', e); }
      if (model?.object) {
        const holder = new THREE.Group();
        model.object.position.set(0, 0, 0);
        holder.add(model.object);
        const mat = model.material;
        if (mat) {
          mat.color?.set?.('#eef8ff');
          if (mat.emissive) mat.emissive.set('#33444c');
          mat.depthWrite = false;
        }
        model.object.traverse(o => { if (o.isMesh) { o.renderOrder = 3; o.castShadow = false; o.receiveShadow = false; } });
        const fp = STATIONS[arg]?.footprint || pad.zone;
        const c = { x: fp[0] + (fp[2] - 1) / 2, z: fp[1] + (fp[3] - 1) / 2 };
        holder.position.set(c.x, 0, c.z);
        scene.add(holder);
        return { type: 'model', model, holder, info: { float: false, height: STATIONS_H[arg] ?? 1, kind }, c };
      }
    }
    let info = null;
    try { info = buildGhost(pad, { map, stations: STATIONS }); } catch (e) { console.error('[pads] ghost', pad.id, e); }
    if (!info) return null;
    const mat = ghostMaterial();
    if (info.float) mat.uniforms.uTint.value = info.kind === 'hire' ? 0.1 : 0.18; // emblems keep their colours (hats, gold)
    const mesh = new THREE.Mesh(info.geometry, mat);
    mesh.renderOrder = 4;
    mesh.castShadow = false; mesh.receiveShadow = false;
    mesh.scale.setScalar(0.001);
    const depth = new THREE.Mesh(info.geometry, ghostDepth());
    depth.renderOrder = 3;
    mesh.add(depth);
    const holder = new THREE.Group();
    holder.add(mesh);
    let c = info.center;
    if (info.atHearth) c = camp.stationCenter?.('hearth') || { x: 20.5, z: 13.5 };
    holder.position.set(c.x, 0, c.z);
    scene.add(holder);
    return { type: 'mesh', mesh, holder, info, mat, c };
  }
  const STATIONS_H = { sawmill: 0.85, cookfire: 0.85, hut: 1.15, quarry: 1.1, copperDrill: 1.4, smelter: 1.25 };
  function disposeGhost(g) {
    if (!g) return;
    g.holder.removeFromParent();
    if (g.type === 'model') { try { g.model.dispose?.(); } catch { /* fine */ } }
    else { g.info.geometry.dispose(); g.mat.dispose(); }
  }

  // ---------------- pad views ----------------
  function ensure(pad, { delay = null } = {}) {
    let v = pads.get(pad.id);
    if (v) { v.pad = pad; return v; }
    const [kind, raw = ''] = pad.id.split(':');
    const [zx, zz, w, d] = pad.zone;
    const center = { x: zx + (w - 1) / 2, z: zz + (d - 1) / 2 };
    let dl = delay;
    if (dl == null) {
      if (time < showDelayUntil) { dl = showDelayUntil - time + showStagger; showStagger += 0.14; }
      else dl = 0.05;
    }
    v = {
      id: pad.id, pad, kind, arg: raw.split('#')[0], zone: pad.zone, center,
      name: padName(pad.id),
      entries: Object.keys(pad.cost).map(item => ({
        item, cost: pad.cost[item], shown: pad.cost[item] - (pad.paid?.[item] || 0), done: false,
        numW: 0, pop: new Spring(0, { stiffness: 430, damping: 17 }), bump: new Spring(0, { stiffness: 320, damping: 14 }),
      })),
      ghost: null,
      phase: 'in', t: -dl, outT: 0, doneT: -1,
      on: 0, press: 0, flash: 0, fillShown: 0, green: 0,
      landed: Object.fromEntries(Object.keys(pad.cost).map(k => [k, pad.paid?.[k] || 0])),
      inFlight: 0,
      bob: new Spring(0, { stiffness: 170, damping: 9 }),
      thump: new Spring(0, { stiffness: 380, damping: 15 }),
      phaseOff: (pads.size * 1.7) % 6.28,
      fxDone: false,
    };
    for (const e of v.entries) { e.done = e.shown <= 0; e.numW = numberWidth(e.done ? '✓' : String(e.shown)); }
    pads.set(pad.id, v);
    try { v.ghost = makeGhost(pad); } catch (e) { console.error('[pads] ghost', pad.id, e); }
    relayoutAll();
    return v;
  }

  function totalCost(v) { return Object.values(v.pad.cost).reduce((a, n) => a + n, 0); }
  function totalLanded(v) { return Object.values(v.landed).reduce((a, n) => a + n, 0); }
  function setShown(v, e, n, kick = true) {
    if (e.shown === n) return;
    e.shown = n;
    const done = n <= 0;
    if (done !== e.done) e.done = done;
    if (kick) { const k = reduced ? 0.3 : 1; e.pop.kick((done ? 7 : 5.2) * k); e.bump.kick((done ? 5 : 3.6) * k); }
  }

  function destroy(v) {
    disposeGhost(v.ghost);
    pads.delete(v.id);
    v.uncovered = true;
    applyCover();
    relayoutAll();
  }

  // ---------------- pay flights (stack -> pad) ----------------
  const flyMeshes = new Map(); // item -> InstancedMesh
  const flights = [];
  const fallbackGeo = new THREE.BoxGeometry(0.16, 0.16, 0.16).translate(0, 0.08, 0);
  function flyMesh(item) {
    let m = flyMeshes.get(item);
    if (m) return m;
    try { m = views.items?.getInstanced?.(item, FLY_CAP) || null; } catch { m = null; }
    if (!m) {
      m = new THREE.InstancedMesh(fallbackGeo, new THREE.MeshLambertMaterial({ color: config.ITEMS[item]?.color || '#ffffff' }), FLY_CAP);
      m.count = 0;
    }
    m.frustumCulled = false; m.castShadow = !mobile; m.receiveShadow = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.name = `padFlights:${item}`;
    scene.add(m);
    flyMeshes.set(item, m);
    return m;
  }
  function packTop(out) {
    const pl = views.player;
    let p = null;
    try { p = pl?.getStackTop?.(out) || null; } catch { p = null; }
    if (p && Number.isFinite(p.x)) return out;
    try { p = pl?.getPackPosition?.(out) || null; } catch { p = null; }
    if (p && Number.isFinite(p.x)) return out.add(_p.set(0, 0.16, 0));
    p = pl?.getPosition?.(out);
    if (p && Number.isFinite(p.x)) return out.set(p.x, (p.y || 0) + 0.65, p.z);
    return out.set(sim.player.x, 0.65, sim.player.z);
  }
  let flightSeq = 0;
  // Where a paid item lands: onto the printed number it pays for (the number ticks with a pop as it lands), so
  // the cause and the effect sit on the same spot and the player standing on the plate never hides it. The
  // hearth takes its wood / food straight into the fire.
  function flightTarget(v, item, ang, rr, out) {
    if (v.kind === 'hearth') {
      const hc = camp.stationCenter?.('hearth');
      if (hc) return out.set(hc.x + Math.cos(ang) * rr * 0.8, 0.32, hc.z + Math.sin(ang) * rr * 0.8);
    }
    const e = v.entries.find(x => x.item === item);
    const j = 0.05;
    if (e && Number.isFinite(e.wx)) return out.set(e.wx + Math.cos(ang) * j, PLATE_Y + 0.06, e.wz + Math.sin(ang) * j * 0.6);
    const P = v.plate || v.target;
    return out.set(P.cx + Math.cos(ang) * rr * 0.4, PLATE_Y + 0.06, P.cz + Math.sin(ang) * rr * 0.3);
  }
  function launch(v, item) {
    const from = packTop(new THREE.Vector3());
    // a fast stream flies shorter, flatter arcs so it stays a tidy pour and the counter keeps up
    const gap = v.lastLaunch == null ? 1 : time - v.lastLaunch;
    v.lastLaunch = time;
    const fast = clamp((0.12 - gap) / 0.07);
    const k = flightSeq++;
    const ang = k * 2.39996; // golden angle: a fast stream fans neatly instead of piling on one spot
    const rr = 0.12 + ((k * 0.37) % 1) * 0.16;
    const to = flightTarget(v, item, ang, rr, new THREE.Vector3());
    const dist = Math.hypot(to.x - from.x, to.z - from.z);
    flights.push({
      v, item, from, to,
      k: 0, rate: 1 / (clamp(FLIGHT_MIN + dist * 0.035, FLIGHT_MIN, FLIGHT_MAX) * (1 - 0.3 * fast)),
      h: (0.42 + Math.min(dist, 5) * 0.07) * (1 - 0.2 * fast),
      spin: 7 * (k % 2 ? 1 : -1), yaw0: ang,
    });
    v.inFlight++;
  }
  function landFlight(f) {
    const v = f.v;
    v.inFlight = Math.max(0, v.inFlight - 1);
    v.landed[f.item] = Math.min(v.pad.cost[f.item] ?? Infinity, (v.landed[f.item] || 0) + 1);
    // the number ticks as the item lands (cause -> effect), with a pop
    const e = v.entries.find(x => x.item === f.item);
    if (e && v.doneT < 0) setShown(v, e, v.pad.cost[f.item] - v.landed[f.item]);
    v.thump.velocity = Math.max(v.thump.velocity - 2.2, -7);
    v.flash = Math.min(1, v.flash + 0.12);
    // a tiny dust tick every few items so a fast stream reads as one continuous pour
    const n = totalLanded(v);
    if (n % 3 === 1 && f.to) views.fx?.puff?.({ x: f.to.x, y: f.to.y + 0.02, z: f.to.z }, { count: 2, size: 0.07, spread: 0.12, up: 0.3, color: '#fffaf0' });
    try { events.emit('pads:landed', { pad: v.pad, item: f.item }); } catch { /* listeners are someone else's */ }
  }
  function updateFlights(dt) {
    for (const m of flyMeshes.values()) m.userData.n = 0;
    for (let i = flights.length - 1; i >= 0; i--) {
      const f = flights[i];
      f.k = Math.min(1, f.k + dt * f.rate);
      if (f.k >= 1) { flights.splice(i, 1); landFlight(f); }
    }
    for (const f of flights) {
      const m = flyMesh(f.item);
      const n = m.userData.n || 0;
      if (n >= FLY_CAP) continue;
      const k = f.k;
      const kk = k * k * (1.55 - 0.55 * k); // leave easy, rush in
      _p.set(lerp(f.from.x, f.to.x, kk), lerp(f.from.y, f.to.y, kk) + arc(k) * f.h, lerp(f.from.z, f.to.z, kk));
      const sc = (k < 0.14 ? lerp(0.7, 1, ease.backOut(k / 0.14, 2.2)) : k > 0.7 ? lerp(1, 0.25, ease.quadIn((k - 0.7) / 0.3)) : 1) * ITEM_K;
      _e.set(Math.sin(k * 3.1) * 0.5, f.yaw0 + f.spin * k * 0.5, Math.sin(k * 2.3) * 0.35);
      _q.setFromEuler(_e);
      m.setMatrixAt(n, _m.compose(_p, _q, _s.set(sc, sc, sc)));
      m.userData.n = n + 1;
    }
    for (const m of flyMeshes.values()) {
      const n = m.userData.n || 0;
      if (n || m.count) { m.count = n; m.instanceMatrix.needsUpdate = true; }
      m.visible = n > 0;
    }
  }

  // ---------------- completion ----------------
  function complete(v) {
    if (v.phase === 'out') return;
    v.phase = 'out'; v.outT = 0;
    // anything still in the air hurries in (lands within ~0.12 s) so it reads as one moment with the station
    for (const f of flights) if (f.v === v) f.rate = Math.max(f.rate, (1 - f.k) / 0.12);
    // revealed pads (refreshPads runs right after) wait for the moment
    showDelayUntil = Math.max(showDelayUntil, time + 0.5);
    showStagger = 0;
  }
  function completionFx(v) {
    const fx = views.fx;
    if (!fx) return;
    const P = v.plate;
    const c = { x: P.cx, y: 0.05, z: P.cz };
    const r = Math.max(P.hx, P.hz) + 0.3;
    // build pads: the rising station brings its own dust ring + sparkles; ours would double them
    const stationRises = v.kind === 'build' && !!views.campview?.update;
    if (!stationRises) fx.ring?.(c, { radius: r + 0.2, count: Math.round(14 * FXN), size: 0.15 });
    if (v.kind === 'bridge') { fx.sparkle?.({ ...c, y: 0.3 }, { count: Math.round(6 * FXN), spread: 0.4 }); return; }
    if (!stationRises) fx.sparkle?.({ ...c, y: 0.45 }, { count: Math.round(10 * FXN), spread: r * 0.8, size: 0.11 });
    fx.confetti?.({ ...c, y: 0.25 }, { count: Math.round((v.kind === 'build' ? 30 : 22) * FXN) });
  }

  // ---------------- hearth level-up ----------------
  function levelUp() {
    const hc = camp.stationCenter?.('hearth') || { x: 20.5, z: 13.5 };
    burst.play(hc.x, hc.z, 0.95, () => views.lighting?.mood?.wave || null);
    const fx = views.fx;
    fx?.sparkle?.({ x: hc.x, y: 0.9, z: hc.z }, { count: Math.round(16 * FXN), spread: 1.1, size: 0.14, color: '#fff1b8' });
    fx?.sparkle?.({ x: hc.x, y: 0.6, z: hc.z }, { count: Math.round(10 * FXN), spread: 1.8, size: 0.1, delay: 0.12 });
    fx?.confetti?.({ x: hc.x, y: 0.8, z: hc.z }, { count: Math.round(44 * FXN) });
    views.camera?.shake?.(0.07);
    showDelayUntil = Math.max(showDelayUntil, time + 0.75);
    showStagger = 0;
  }

  // ---------------- events ----------------
  const offs = [];
  const on = (type, fn) => offs.push(events.on(type, p => { try { fn(p || {}); } catch (e) { console.error(`[pads] ${type}`, e); } }));
  on('pad:shown', ({ pad }) => { if (pad) ensure(pad); });
  on('pad:paid', ({ pad, item }) => {
    if (!pad || !item) return;
    const v = ensure(pad, { delay: 0 });
    if (views.fx?.handlesPadPaid) { landFlight({ v, item, to: null }); return; }
    launch(v, item);
  });
  on('pad:complete', ({ pad }) => { if (!pad) return; complete(ensure(pad, { delay: 0 })); });
  on('bridge:start', ({ bridge }) => {
    if (!bridge) return;
    const pv = pads.get(`bridge:${bridge.id}`);
    bridges.start(bridge, { shore: pv ? pv.center : null });
  });
  on('bridge:built', ({ bridge }) => { if (bridge && !bridges.has(bridge.id)) bridges.builtInstantly(bridge); });
  on('hearth:level', () => levelUp());
  on('station:built', () => relayoutAll());
  on('ui:icons', ({ changed }) => atlas.refreshIcons(changed));
  on('resource:spawned', () => relayoutAll());
  on('resource:depleted', () => relayoutAll());
  on('resource:removed', () => relayoutAll());

  // initial state: pads already visible + bridges already built
  camp.pads.forEach((pad, i) => ensure(pad, { delay: 0.35 + i * 0.12 }));
  for (const id of camp.bridges || []) { const b = map.bridges?.[id]; if (b) bridges.builtInstantly({ id, tiles: b.tiles, orientation: b.orientation }); }

  // ---------------- locked bridge hints ----------------
  const lockHints = Object.entries(map.bridges || {}).map(([id, b]) => {
    const layout = bridgeLayout(b.tiles, b.orientation);
    const fr = bridgeFrame(b.tiles, b.orientation, null);
    const uc = (layout.u0 + layout.u1) / 2;
    const c = fr.toWorld(uc, 0, { x: 0, z: 0 });
    return { id, c, yaw: Math.atan2(fr.dz, fr.dx), halfLen: (layout.u1 - layout.u0) / 2, a: 0 };
  });

  // ---------------- per-frame ----------------
  const pp = new THREE.Vector3();
  function playerXZ() {
    const p = views.player?.getPosition?.(pp);
    if (p && Number.isFinite(p.x)) return p;
    return pp.set(sim.player.x, 0, sim.player.z);
  }
  const P4 = [0, 0, 0, 0], R4 = [0, 0, 0, 0], S4 = [0, 0, 0, 0], E4 = [0, 0, 0, 0];

  function updatePad(v, dt, player, tagD) {
    v.t += dt;
    const pad = v.pad;
    const out = v.phase === 'out';
    if (out) v.outT += dt;
    const live = v.t >= 0;
    // reconcile: the sim dropped this pad without completing it -> fade it like a completion without fx
    if (!out && !camp.pads.includes(pad)) { v.phase = 'out'; v.outT = 0; v.fxDone = true; v.quiet = true; }

    // ---- plate rect eases to its layout ----
    const P = v.plate, T = v.target;
    for (const k of ['cx', 'cz', 'hx', 'hz', 'cs', 'tagSide']) P[k] = damp(P[k], T[k], 10, dt);

    // ---- appear ----
    const ka = live ? clamp(v.t / APPEAR_T) : 0;
    if (live && !v.started) { v.started = true; v.bob.kick(1.2); }
    let scale = ka > 0 ? lerp(0.6, 1, ease.backOut(ka, 1.6)) : 0;
    let alpha = ease.quadOut(clamp(ka / 0.3));

    // ---- standing on it: the slab presses down ----
    const onPad = !out && live && camp.inRect?.(v.zone, player.x, player.z);
    v.on = damp(v.on, onPad ? 1 : 0, onPad ? 12 : 6, dt);
    v.press = damp(v.press, onPad ? 1 : 0, 18, dt);
    // breathing (calmer while pressed)
    if (!reduced) scale *= 1 + 0.012 * Math.sin(time * 2.1 + v.phaseOff) * (1 - v.on * 0.7);

    // ---- springs ----
    v.bob.update(dt); v.thump.update(dt);
    v.flash = Math.max(0, v.flash - dt * 3.2);
    const total = totalCost(v);
    const fillTarget = total > 0 ? totalLanded(v) / total : 1;
    v.fillShown = damp(v.fillShown, fillTarget, 9, dt);
    scale *= 1 + v.thump.value * 0.014;

    // ---- completion ----
    let contentA = 1, ghostK = 1, lift = 0;
    if (out) {
      const t = v.outT;
      // all numbers flip to checks once the hurried items are in
      if (v.doneT < 0 && (v.inFlight === 0 || t > 0.14)) {
        v.doneT = 0;
        for (const id of Object.keys(v.landed)) v.landed[id] = v.pad.cost[id];
        if (!v.quiet) for (const e of v.entries) { const was = e.done; setShown(v, e, 0); if (was) e.pop.kick(4); }
      } else if (v.doneT >= 0) v.doneT += dt;
      v.press = Math.max(v.press, ease.quadOut(clamp(t / BURST_AT)));
      if (t >= BURST_AT && !v.fxDone) { v.fxDone = true; completionFx(v); v.flash = 1; }
      v.green = damp(v.green, v.quiet ? 0 : 1, 14, dt);
      v.fillShown = Math.max(v.fillShown, v.quiet ? v.fillShown : 1);
      // pop up a touch on the burst, then sink away
      // pop up a touch on the burst (0.08 s), then anticipate-and-shrink away (0.3 s, backIn)
      const tb = t - BURST_AT;
      scale *= tb < 0 ? 1 : tb < 0.08 ? 1 + 0.07 * ease.quadOut(tb / 0.08) : 1.07 * Math.max(0, 1 - ease.backIn(clamp((tb - 0.08) / 0.3), 1.6));
      alpha *= 1 - ease.quadIn(clamp((tb - 0.2) / 0.18));
      contentA = 1 - clamp((tb - 0.1) / 0.16);
      ghostK = 1 - clamp(t / 0.24);
      if (v.quiet) { scale = Math.max(0.001, scale * (1 - clamp(t / 0.4))); }
    }
    scale = Math.max(0.001, scale);
    const lipNow = lerp(LIP, LIP_PRESSED, v.press);

    // ---- plate instance ----
    const emb = v.ghost?.info.float ? v.ghost : null;
    const embOffZ = emb ? (emb.holder.position.z - P.cz) : 0;
    if (alpha > 0.002) {
      P4[0] = P.cx; P4[1] = PLATE_Y + lift; P4[2] = P.cz; P4[3] = scale;
      R4[0] = P.hx; R4[1] = P.hz; R4[2] = CORNER; R4[3] = lipNow;
      S4[0] = clamp(v.fillShown); S4[1] = alpha; S4[2] = v.on; S4[3] = v.flash;
      E4[0] = emb ? (v.shadowK || 0) * 0.5 : 0; E4[1] = embOffZ; E4[2] = v.green; E4[3] = 0;
      plates.push(P4, R4, S4, E4);
    }

    // ---- printed content: icons + numbers, then the name tag ----
    const ca = alpha * contentA;
    const kc = live ? clamp((v.t - CONTENT_DELAY) / 0.4) : 0;
    const cScale = kc > 0 ? lerp(0.5, 1, ease.backOut(kc, 2)) : 0;
    if (ca * kc > 0.003) pushContent(v, scale, cScale, ca * ease.quadOut(clamp(kc / 0.4)), lipNow, dt);
    else for (const e of v.entries) { e.pop.update(dt); e.bump.update(dt); }
    const kt = live ? clamp((v.t - TAG_DELAY) / 0.4) : 0;
    if (alpha * kt > 0.003) {
      const tg = atlas.tag(v.name);
      const s = scale * (kt > 0 ? lerp(0.6, 1, ease.backOut(kt, 2.2)) : 0);
      const d = tagD * view.zs, w = tagD * (tg.w / tg.h);
      // a tag switching edges fades through the middle instead of sliding visibly over the numbers
      const sideA = Math.pow(clamp(Math.abs(P.tagSide)), 3);
      glyphs.push(P.cx, P.cz + (P.hz - d * 0.18) * P.tagSide * scale - (P.tagSide < 0 ? lipNow * 0.5 * scale : 0), w * s, d * s, tg.uv, PLATE_Y + 0.004, alpha * sideA * ease.quadOut(clamp(kt / 0.4)));
    }

    // ---- ghost ----
    const g = v.ghost;
    if (g) {
      const info = g.info;
      const kg = live ? clamp((v.t - GHOST_DELAY) / 0.55) : 0;
      let gs = kg > 0 ? lerp(0.6, 1, ease.backOut(kg, 1.7)) : 0.001;
      let ga = ease.quadOut(clamp(kg / 0.4));
      if (out) {
        // stations hand over to the rising station: brief swell then gone; emblems shoot up and shrink
        const t = v.outT;
        if (info.float) { gs *= t < 0.08 ? 1 + t * 1.5 : Math.max(0.001, 1.12 * (1 - ease.quadIn(clamp((t - 0.08) / 0.24)))); }
        else gs *= 1 + 0.05 * Math.sin(clamp(t / 0.25) * Math.PI);
        ga *= ghostK;
      }
      v.shadowK = ga * gs;
      const th = v.thump.value;
      const es = info.kind === 'upgrade' ? 0.8 : info.kind === 'hire' ? 1.05 : 1; // emblems a touch smaller so they never smother a neighbour's print
      const sy = gs * es * (1 + th * 0.05), sxz = gs * es * (1 - th * 0.025);
      const bob = Math.sin(time * 2.1 + v.phaseOff);
      if (g.type === 'model') {
        // the real station, translucent, hovering a hair over its plate and bobbing gently
        g.holder.position.y = 0.05 + bob * 0.03 + Math.max(0, v.bob.value) * 0.03;
        g.holder.scale.set(sxz, Math.max(0.001, sy), sxz);
        g.model.setOpacity?.(0.5 * ga + Math.min(0.15, v.flash * 0.15));
        if (g.model.material) g.model.material.opacity = 0.5 * ga + Math.min(0.15, v.flash * 0.15);
        g.holder.visible = ga > 0.004;
      } else {
        g.mesh.scale.set(sxz, Math.max(0.001, sy), sxz);
        if (info.float) {
          // emblems hover over the far half of the plate so the number stays clear
          g.holder.position.x = P.cx;
          g.holder.position.z = P.cz - P.hz * 0.42;
          // with the tag on the far edge the emblem floats higher, clear of it
          const baseY = 0.3 + 0.42 * clamp(-P.tagSide);
          g.holder.position.y = out ? baseY + ease.quadIn(clamp(v.outT / 0.3)) * 0.7 : baseY + bob * 0.045 + v.bob.value * 0.03;
          if (info.kind === 'hire') g.mesh.rotation.y = Math.sin(time * 1.3 + v.phaseOff) * 0.35;
          else g.holder.rotation.x = -0.6; // emblems lean back to face the high camera
        } else if (info.atHearth) {
          g.holder.position.y = 0.04 + bob * 0.02;
          g.mesh.scale.y *= 1 + Math.sin(time * 8.5) * 0.035 + Math.sin(time * 13.1) * 0.02;
        } else if (!out) g.holder.position.y = Math.max(0, v.bob.value * 0.02);
        if (info.spin) { v.spinT = (v.spinT || 0) + dt * (1 + v.on * 1.5); g.mesh.rotation.y = Math.sin(v.spinT * info.spin * 1.6) * 0.55; }
        const u = g.mat.uniforms;
        u.uOpacity.value = ga;
        u.uGlow.value = v.on * 0.6 + v.flash * 0.6;
        u.uTime.value = time + v.phaseOff;
        g.mesh.visible = ga > 0.003 && gs > 0.002;
      }
    }

    if (out && v.outT >= OUT_T && v.inFlight === 0) destroy(v);
  }

  // icons + numbers on the top face (plate-local layout, scaled about the plate centre)
  function pushContent(v, scale, cScale, a, lipNow, dt) {
    const P = v.plate, T = v.target;
    const cs = P.cs;
    const zs = view.zs;
    const k = K();
    const n = v.entries.length, cols = Math.min(T.cols, n), rows = Math.ceil(n / cols);
    const pairD = T.pairD * cs;
    const cz0 = -lipNow * 0.5 + (PAD_N - PAD_S) * 0.5 * cs * P.tagSide;   // block centre (top face, clear of the tag)
    const y = PLATE_Y + 0.003;
    const S = scale * cScale;
    for (let i = 0; i < n; i++) {
      const e = v.entries[i];
      const pop = e.pop.update(dt), bump = e.bump.update(dt);
      const row = Math.floor(i / cols), inRow = Math.min(cols, n - row * cols), col = i - row * cols;
      const str = e.done ? '✓' : String(Math.max(0, e.shown));
      const wantW = numberWidth(str);
      e.numW = e.numW ? damp(e.numW, wantW, 18, dt) : wantW;
      const pairW = pairWidth(e.numW) * cs;
      const px = (col - (inRow - 1) / 2) * (T.pairW + COL_GAP) * cs;
      const pz = cz0 + (row - (rows - 1) / 2) * (pairD + ROW_GAP * cs);
      const left = px - pairW / 2;
      // icon (bumps on each landing)
      const ic = atlas.icon(e.item);
      const iw = ICON_T * cs * (1 + clamp(bump, -0.2, 0.3) * 0.3);
      const icx = left + ICON_T * ICON_INK * cs / 2;
      glyphs.push(P.cx + icx * S, P.cz + pz * S, iw * S, iw * zs * S, ic.uv, y, a, e.done ? 1 : 0);
      // number: backs (outline + lip) of every digit first, then the white fills
      const ps = 1 + clamp(pop, -0.2, 0.42);
      const numL = left + (ICON_T * ICON_INK + ICON_GAP + atlas.O * k * 1.2) * cs;
      const numC = numL + e.numW * cs / 2;
      e.wx = P.cx + numC * scale; e.wz = P.cz + pz * scale;   // where paid items land (flightTarget)
      const inkH = DIGIT_T * cs * zs;
      for (let pass = 0; pass < 2; pass++) {
        let pen = numL;
        for (let j = 0; j < str.length; j++) {
          const gph = atlas.glyph(str[j]);
          const gw = gph.w * k * cs, gd = gph.h * k * cs * zs;
          const qx = pen - gph.ox * k * cs + gw / 2;
          const qz = pz - inkH / 2 - gph.oy * k * cs * zs + gd / 2;
          // pop about the number's centre
          const wx = numC + (qx - numC) * ps, wz = pz + (qz - pz) * ps;
          glyphs.push(P.cx + wx * S, P.cz + wz * S, gw * ps * S, gd * ps * S, pass ? gph.f : gph.b, y + 0.0005 * pass, a);
          pen += (gph.adv + atlas.O * 0.9) * k * cs;
        }
      }
    }
  }

  function updateHints(dt) {
    hints.begin();
    for (const h of lockHints) {
      const want = !camp.bridges?.has?.(h.id) && !bridges.has(h.id) && !pads.has(`bridge:${h.id}`);
      h.a = damp(h.a, want ? 1 : 0, want ? 2.5 : 8, dt);
      if (h.a > 0.004) hints.push(h.c.x, h.c.z, h.yaw, h.a * 0.55, h.halfLen, 0.44, 0.41, time * 0.12);
    }
    hints.commit(time);
  }

  let iconCheck = 0.5;
  function update(dt) {
    if (!(dt >= 0)) return;
    time += dt;
    measureView();
    // any visible sim pad we haven't seen (e.g. created before we subscribed)
    for (const pad of camp.pads) if (!pads.has(pad.id)) ensure(pad);
    updateFlights(dt);
    const player = playerXZ();
    const tagD = tagDepth();
    plates.begin(); glyphs.begin();
    for (const v of [...pads.values()]) {
      try { updatePad(v, dt, player, tagD); } catch (e) { console.error('[pads] update', v.id, e); destroy(v); }
    }
    plates.commit(time, view.outline);
    glyphs.commit();
    // the HUD renders its 3D item icons a moment after load: pick them up (a string compare per icon)
    if ((iconCheck -= dt) <= 0) { iconCheck = time < 12 ? 1 : 6; atlas.refreshIcons(); }
    atlas.commit();
    updateHints(dt);
    bridges.update(dt);
    burst.update(dt);
  }

  const _out = new THREE.Vector3();
  const api = {
    // fx checks this: the pads view draws every pad:paid flight itself (pack -> pad), so fx doesn't.
    drawsPaidFlights: true,
    // The Group holding a pad's ghost (station model / emblem / plank path); null once the pad is gone.
    padObject: id => pads.get(id)?.ghost?.holder || null,
    // There is no DOM cost bubble any more (the cost is printed on the plate). Kept for callers: always null.
    bubble: () => null,
    // The plate as drawn: { x, z, hx, hz } in world tiles (centre + half size), or null.
    plateRect(id) {
      const v = pads.get(id);
      if (!v?.plate) return null;
      return { x: v.plate.cx, z: v.plate.cz, hx: v.plate.hx, hz: v.plate.hz };
    },
    // World point where a pointer (the guide's arrow) can hover over a pad without hiding its printed number:
    // above the emblem, above the ghost station, or over the plate's far edge.
    padTop(id, out = _out) {
      const v = pads.get(id);
      if (!v) return null;
      const g = v.ghost, P = v.plate;
      if (g?.info.float) return out.set(g.holder.position.x, g.holder.position.y + g.info.height, g.holder.position.z);
      if (g?.type === 'model') return out.set(g.holder.position.x, (g.info.height || 1) + 0.1, g.holder.position.z);
      return out.set(P.cx, 0.45, P.cz - P.hz * 0.9);
    },
    // The finished (baked) mesh of a bridge, or null while it assembles / before it is built.
    bridgeObject: id => bridges.object(id),
    get flights() { return flights.length; },
    get assemblingBridges() { return bridges.assembling; },
    get pads() { return [...pads.keys()]; },
    // test hooks
    _views: pads, _atlas: atlas,
    stats() { return { plates: pads.size, glyphs: glyphs.count, flights: flights.length, coveredTiles: coverApplied.size }; },
    update,
    dispose() {
      offs.forEach(off => off?.());
      for (const v of pads.values()) disposeGhost(v.ghost);
      atlas.dispose();
    },
  };
  return api;
}
