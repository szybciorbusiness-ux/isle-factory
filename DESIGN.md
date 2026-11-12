# Isle Factory — design + module contract

A tiny Factorio-style demo (chop, mine, craft, belts, drills, chests, a workshop) dressed in the look and
motion of a cosy low-poly island puzzle game. Reference frame: `ref/reference.png` (open it — it is the art target).

**The priority is feel**: smoothness, soft springy animation, and the reference look. Gameplay is deliberately small.

---

## 1. Art direction (match `ref/reference.png`)

- **Camera**: high-angle perspective (~55–62° pitch), narrow FOV (~28–32°), so the world reads like a diorama.
  Roughly 16×10 tiles visible at default zoom.
- **Islands**: square-tile islands with chunky lobed outlines. Grass tops in soft yellow-green with a *subtle*
  per-tile checker (alternate tiles a touch lighter/darker) and painted grass-blade texture. Every exposed edge has a
  cream **sand rim** with **rounded outer corners** (and filleted inner corners), and **grass blade tufts** that
  overhang the edge. The island side drops as a sand-coloured cliff into the water. Tiny orange/white **flowers**
  dotted on the grass.
- **Water**: deep teal-blue far away, **bright mint/turquoise glow** in the shallows hugging every island,
  faint animated **caustic** lines in the shallows, a soft foam line at the shore.
- **Clouds**: thick soft white-mint clouds frame the play area (the camera looks down through a hole in them),
  drifting slowly; distant islands fade into them. Top/bottom of the frame is softly out of focus (tilt-shift).
- **Lighting**: bright, warm, low contrast. Soft sun shadows, never black: shadows are tinted blue-green.
  Use `MeshLambertMaterial` (faceted props: `flatShading: true`) — no PBR shine, no pure black anywhere.
- **Props**: trees are chunky clusters of dark-green faceted blobs on a short brown trunk; rocks are cream faceted
  boulders (some tall pillars); stumps show light ring tops. Proportions are cute and slightly oversized.
- **Buildings** (ours, not in the reference — design them in the same language): chunky, rounded, toy-like.
  Wood (`wood`, `woodDark`), copper accents (`copper`), cream stone (`stoneBlock`). Belts: dark slate bed with
  warm yellow chevrons that scroll. Nothing realistic or gritty.
- **Player**: original character — a small round critter with a yellow hard hat and an orange tool backpack.
- **Colours**: use `PALETTE` in `src/config.js`. Saturated but soft, never neon.

## 2. Motion principles (the most important section)

The reference game is loved for how *smooth* everything is. Every visible change must be animated:

- **Nothing pops.** Things appear by scaling from ~0.6–0.8 with a spring/backOut overshoot (never from 0 in one
  frame), disappear by anticipating (tiny grow) then shrinking with easeIn.
- **Squash & stretch** with volume preservation (scale.y = s, scale.xz = 1/sqrt(s)) on landings, hits, item arrivals.
- **Anticipation → action → follow-through**: swings wind up, trees lean before they fall, falls accelerate (easeIn)
  then bounce once on impact with a dust puff.
- **Secondary motion**: backpack lags behind the body on a spring, leaves shiver after a hit, chest lid bounces.
- **Continuous motion is continuous**: belt items glide at constant speed with no jitter; camera follow is damped;
  rotations use `dampAngle` / springs, never snap.
- **Everything uses dt** from `update(dt, t)` and the helpers in `src/util/anim.js` (`Spring`, `tween`, `damp`,
  `dampAngle`, `Wobble`, `ease`). **Never** read `performance.now()` / `Date.now()` for animation — the test hooks
  step the game deterministically and pausing must freeze everything.
- Timings: UI 150–250 ms ease-out (`cubic-bezier(0.23, 1, 0.32, 1)`); world reactions 0.15–0.5 s; a player step
  0.2 s. Springs: stiffness 150–400, damping 12–26.

## 3. Architecture

Plain ES modules, no build step. `three` and `three/addons/...` come from the import map (vendored three r183).
No new dependencies, no CDN imports in game code.

```
index.html            import map, #app (canvas), #ui (DOM overlay), #errors      [lead]
serve.mjs             static server, port 4660                                   [lead]
src/main.js           renderer, scene, camera, loop, module loading, __game hooks [lead]
src/config.js         palette, items, recipes, buildings, quests, directions      [lead]
src/util/anim.js      easing, Spring, tween, damp, Wobble                         [lead]
src/util/noise.js     rng, hash, value noise, fbm                                 [lead]
src/world/map.js      island layout data                                          [lead]
src/sim/sim.js        simulation + public API + events                            [SIM]
src/debug/scenarios.js  ?scenario= setups                                         [SIM]
tests/*.test.mjs      node tests (node --test tests/sim.test.mjs)                 [SIM]
src/view/lighting.js, sky.js, terrain.js, water.js, post.js (+ src/view/world/*)   [WORLD]
src/view/props.js, fx.js (+ src/view/props/*)                                      [PROPS]
src/view/buildings.js, items.js (+ src/view/buildings/*)                           [BUILDINGS]
src/view/player.js, camera.js, interact.js (+ src/view/player/*)                   [PLAYER]
src/ui/hud.js, ui.css, icons.js (+ src/ui/*)                                       [UI]
```

**Only edit files you own.** If you need something from another module, code defensively against its contract
(`ctx.views.fx?.puff?.(...)`) and list the request in your report. Module-specific tuning constants live in your
own module, not in `config.js`.

### Module contract

Each view module exports `create(ctx)` (may be async) returning an object. Optional methods:
`update(dt, t)` every frame, `resize(w, h)`. Modules load in this order (later ones can use earlier ones at
create-time; any module can use any other at runtime through `ctx.views`):

`lighting, sky, terrain, water, items, fx, props, buildings, player, camera, interact, ui, post`

`ctx` = `{ THREE, renderer, scene, camera, canvas, uiRoot, config, anim, noise, map, sim, events, ui, views,
params, debug, beltPath, time }`. A module that throws is isolated (main.js falls back to `{}` and shows the
error in the red box at bottom-left).

### Coordinates

Tile `(x, z)` is centred at world `(x, 0, z)`; tiles are 1×1; land top is `y = 0`; water surface
`config.WATER_Y = -0.32`. +x = east/screen right, +z = south/screen down (toward camera).
Directions: `0 east, 1 south, 2 west, 3 north`; `config.DIRS[d] = [dx, dz]`. Models are built with their
**front/output facing local +x**, then `rotation.y = config.dirAngle(dir)`.

### Map (`ctx.map`)

`{ w, h, land: Uint8Array, bridge: Uint8Array (0, 1 along x, 2 along z), deposit: Uint8Array (0, 1 copper,
2 stone), props: [{kind, x, z, variant, rot, scale}], start: {x, z}, idx(x,z), inBounds, isLand, isBridge,
isGround, depositAt(x,z), toAscii() }`. Bridges are walkable plank tiles over water; not buildable.

### Sim (`ctx.sim`) — the only source of truth

Entities live in `sim.entities: Map<id, entity>`; `sim.at(x, z)` returns the entity on a tile (one per tile).
- Resources: `{ id, kind: 'tree'|'rock'|'stump', x, z, hp, maxHp, variant, rot, scale, resource: true }`
- Belt: `{ id, kind:'belt', x, z, dir, from, shape: 'straight'|'left'|'right', items: [{ type, p, uid }] }`
  — `p` 0 (entry edge) → 1 (exit edge); `from` = side items enter from. **Item world position = `beltPath(belt, p)`
  → `{ x, z, angle }`** (handles curves). Items are sorted front-first.
- Drill: `{ kind:'drill', dir, deposit:'copper'|'stone', output, timer, progress 0..1, held, working }`
- Chest: `{ kind:'chest', items: {type: n}, total }` (capacity `BUILDINGS.chest.capacity`)
- Workshop: `{ kind:'workshop', dir, recipe|null, input:{}, output:{}, crafting, progress 0..1 }`

API (all safe to call any time):
`update(dt)`, `isWalkable(x,z)`, `setPlayer(x,z,dir)`, `player {x,z,dir}`, `canPlace(kind,x,z,dir) → {ok, reason}`,
`place(kind,x,z,dir) → {ok, reason, entity}` (uses inventory), `rotate(id)`, `remove(id) → returned items`,
`hitResource(id, fromDir)`, `mineDeposit(x,z)`, `craft(recipe, n) → queued count`, `cancelCraft(i)`,
`canCraft(recipe)`, `maxCraftable(recipe)`, `craftQueue [{recipe, t, time}]`, `takeChest(id)`,
`storeInChest(id, item, n)`, `setRecipe(id, recipe)`, `feedWorkshop(id)`, `takeWorkshop(id)`,
`inventory { counts, get, has, hasAll, add(item, n, source), remove }`, `currentQuest() → {text, goal, value,
index} | null`, `quest`, `metrics`, `toast(text, kind)`, `belts/drills/chests/workshops` (Sets), `time`.

Belt details (from the sim hardening pass): items move at a constant world speed, `BELT.speed` tiles/s, along
the lane. A curve lane is π/4 long (`beltLength(belt)`, `BELT_CURVE_LENGTH`), so `p` advances faster on curves.
`BELT.spacing` is a world distance that holds across belt edges. An item keeps its `uid` for its whole life on
belts. While side-loading, `p` runs past 1 (up to 1.5) and `beltPath` extends straight along `belt.dir`; at 1.5
the item joins the target lane at p = 0.5 (its heading turns 90°, so views damp yaw). `beltShape`: 'right' is a
clockwise turn on screen. `drill:output` / `workshop:output` carry `{ target, uid }`; `chest:received` /
`workshop:received` from belts carry `{ uid, from }`. `sim.spawnBeltItem` exists for tests and scenarios.

Player reach (`config.PLAYER`): `reach` 1.5 for chopping and mining (adjacent, diagonals included), `useReach` 4
to open chests/workshops, `buildReach` 10 to place or remove, `moveSpeed` 4.2 tiles/s of free 8-direction walking.

### Events (`ctx.events.on(type, fn)` returns an unsubscribe)

| event | payload |
|---|---|
| `build:placed` | `{ entity }` |
| `build:removed` | `{ entity, returned }` |
| `build:rotated` | `{ entity }` |
| `belt:shape` | `{ entity }` (belt became straight/curved) |
| `resource:hit` | `{ entity, fromDir, hp }` |
| `resource:depleted` | `{ entity, fromDir, drops, replacedBy }` (tree → stump entity in `replacedBy`) |
| `deposit:mined` | `{ x, z, item }` (hand mining) |
| `drill:mined` / `drill:output` | `{ entity, item }` |
| `chest:received` | `{ entity, item, count? }` ; `chest:taken` `{ entity, items }` |
| `workshop:recipe` / `workshop:start` | `{ entity }` ; `workshop:crafted` `{ entity, outputs }` |
| `workshop:received` / `workshop:output` | `{ entity, item }` |
| `inventory:changed` | `{ item, delta, total, source: {x,z} | null }` — source set when items come from the world |
| `craft:queued` `{recipe, count}` ; `craft:done` `{recipe, outputs}` ; `craft:cancelled` `{recipe}` |
| `quest:progress` `{index, quest, value}` ; `quest:done` `{index, quest}` ; `quests:complete` `{}` |
| `player:moved` | `{ x, z, dir }` |
| `toast` | `{ text, kind: 'info' | 'warn' }` |
| `ui:select` `{ selected }` ; `ui:panel` `{ panel }` ; `ui:hover` `{ hover }` ; `fx:itemArrived` `{ item }` |

### Shared UI state (`ctx.ui`)

`{ selected: building item id | null, buildDir: 0..3, panel: null | {type:'craft'} | {type:'chest'|'workshop', id},
hover: null | {x, z, entityId, deposit, inReach}, pointerOverUi: bool }`. Whoever changes `selected`/`panel`
emits `ui:select` / `ui:panel`.

### Per-module contracts

- **lighting** → `{ sun, hemi, update }`. Sun + shadow camera follow `views.camera.target`.
- **sky** → background, fog, cloud frame around `views.camera.target`.
- **terrain** → island meshes (grass, sand rim, cliffs, tufts, flowers, bridges) from `map`.
- **water** → animated water with shallow glow / caustics / foam from the land layout.
- **post** → `{ render(dt), resize(w,h) }` tilt-shift + gentle grade; must fall back cleanly.
- **items** → `{ createItemMesh(id) → Object3D (origin at its bottom centre, ~0.2 tall), itemHeight,
  getInstanced?(id) }` for every id in `config.ITEMS`.
- **buildings** → renders every non-resource entity and all belt items; `{ createModel(kind) → { object, setValid(ok),
  dispose() } (ghost preview), meshFor(id), update }`. Reacts to the build/belt/drill/chest/workshop events.
- **props** → renders resources (trees/rocks/stumps) and deposit nuggets; `{ meshFor(id), hitPoint(id) → Vector3 }`.
  Reacts to `resource:hit`, `resource:depleted`, `deposit:mined`.
- **fx** → pooled effects: `puff(pos, opts)`, `ring(pos, opts)`, `leaves(pos, opts)`, `chips(pos, color, opts)`,
  `sparkle(pos, opts)`, `confetti(pos)`, `flyItem(itemId, from, to, {delay, onArrive})`. **fx owns item pickup
  flights**: on `inventory:changed` with a `source` and `delta > 0` it flies item meshes from the source to the
  player and emits `fx:itemArrived` and calls `views.player.gulp?.()` on arrival.
- **player** → `{ object, getPosition() → Vector3, facing, busy, swing(targetPos, onImpact), gulp(), celebrate(),
  faceTile(x,z) }`; owns WASD/arrow grid movement, calls `sim.setPlayer` when a step starts.
- **camera** → `{ target: {x, z}, shake(amount), distance }`; damped follow, wheel zoom; honours `debug.cam`.
- **interact** → raycast hover + tile highlight, build ghost (`views.buildings.createModel`), place / drag-place,
  rotate (R), remove (right click), pipette (Q), chop / mine (click or Space/E), open chest/workshop panels,
  click-to-walk-then-act for targets out of reach. Owns keys R, Q, E, Space and mouse on the canvas.
- **ui** → DOM in `ctx.uiRoot`, styles in `src/ui/ui.css`. Hotbar (keys 1–4), resource counts, crafting panel
  (C or Tab) with queue, chest/workshop panels, quest tracker, toasts, hover tooltip, controls hint, completion
  banner. Owns keys 1–4, C, Tab, Escape (closes panel, else clears selection). Item icons rendered from the 3D
  item/building models (`src/ui/icons.js`). Text in normal case, modest sizes, font Fredoka.

## 3b. Mobile / portrait (the /phone simulator and real phones)

`/phone` (phone.html, lead) shows the game in an iPhone bezel with a fake status bar. Inside is an iframe of
`/?mobile=1&safeTop=59&safeBottom=24`, a true 402×874 CSS-px portrait viewport. Real phones get the same mode
from `(pointer: coarse)`.

- `ctx.mobile` is true and `body.mobile` is set. Insets: CSS vars `--safe-top` / `--safe-bottom` (status bar / home
  indicator). Nothing interactive goes under them.
- **UI** sets the CSS var `--hud-bottom` on `document.documentElement`: px from the viewport bottom to the top of the
  bottom HUD stack, safe area included, kept current on resize. The touch controls sit just above it.
- **Touch controls** (`src/view/touch.js`, lead): a floating joystick bottom-left and a big action button
  bottom-right (holds Space), plus Rotate (R) / Cancel (Escape) buttons while a building is selected. The joystick
  writes `ctx.input.move = {x, z}` (world xz, magnitude 0..1, dead-zoned) and `ctx.input.active`.
- **player** reads `ctx.input.move` as analog movement alongside the keyboard (speed scales with magnitude) and
  sets `supportsAnalog = true` on its view object. Without that flag, touch.js falls back to synthetic WASD keys.
- **interact** handles touch on the canvas:
  - a tap behaves as a left click (chop / mine / open / place)
  - a long-press (~0.45 s) on a building removes it, with a visible progress ring
  - a one-finger drag with a belt selected paints belts
  - a two-finger pinch zooms the camera
  - there is no hover, so in build mode the ghost sits on the last touched tile.
- **camera**: on portrait screens keep about 9–10 tiles across the width, so the world isn't cramped.
- Synthetic keys from touch.js are dispatched on `document.body` (bubbling to window), with `code` set
  (`Space`, `KeyR`, `Escape`, `KeyW`…), so key listeners must read `e.code`.

## 4. Testing

- Server: `node serve.mjs 4660` (usually already running) → http://localhost:4660
- URL params: `paused` (no rAF loop; drive with `__game.step`), `scenario=factory|forest|belts|quests|stress`, `warm=<s>` (pre-run sim),
  `cam=x,z[,dist]` (fixed camera), `seed`.
- Hooks: `window.__game = { sim, map, views, ui, ctx, step(n, dt), render(), pause(bool), toScreen(x,y,z), errors }`.
- Headless shots: `node tools/shot.mjs --url "/?paused=1&scenario=factory&warm=10" --steps 30 --out shots/<you>/x.png`
  (`--js`, `--keys`, `--click`, `--clip`, `--frames N --every K --sheet` for animation sheets). Headless uses
  SwiftShader: slow, so don't judge FPS from it. Put your shots under `shots/<your-module>/`.
- Sim tests: `node --test tests/*.test.mjs`.
- Budget: aim for ≤ 300 draw calls; use `InstancedMesh` for anything repeated (blades, flowers, nuggets, items).
