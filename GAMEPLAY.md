# Isle Camp — gameplay spec (arcade-idle survival)

The game is now an arcade-idle survival camp in the style of the "Whiteout Survival" ads (user: "survival
progression with production lines, killing animals and growing — this will be kinda our game"), dressed in
our cosy island look (DESIGN.md sections 1–2 still apply: art direction and motion principles).

No quests, no crafting menu, no hotbar. **The world is the UI**: you walk (joystick / WASD), your robot
gathers automatically, carries a visible stack, and you pay for things by standing on build pads.

## Core loop

1. **Gather (automatic).** Walk next to a tree/stump/rock and the robot swings at it on its own. Walk near an
   animal (deer, boar, rabbit) and it bonks it; the animal poofs (cute, never gory) and drumsticks pop out.
   No clicking. Items fly onto the **stack on the robot's back** (capacity 10 → 20 → 30).
2. **Process.** Stand in a station's **drop zone**: your stack streams into it item by item (speeding up the
   longer you stand). The station works it and sends the output down a short **production line** (a little
   conveyor) onto a **pickup pile**. Walk onto the pile to grab it.
   - Sawmill: wood → plank.  Cookfire: raw meat → cooked meat.  Smelter: 2 copper ore → copper bar.
   - Quarry and copper drill run by themselves (the drill's line feeds the smelter directly).
3. **Build / grow.** Dashed **build pads** on the ground show a cost bubble. Stand on one and the stack
   streams in; when paid, the building rises with a bounce, or a bridge assembles plank by plank to a new island.
4. **Level the hearth.** The hearth's pad (in front of it) takes planks / meat / stone / copper to level up the
   camp (1 → 5). Each level reveals new pads and the cloud frame opens wider (the world literally grows).
5. **Workers.** Build the workers' hut, then hire a lumberjack and a hunter with cooked meat. They path to
   trees/animals, carry up to 4, deliver to the sawmill / cookfire, and get hungry: they walk to the cookfire
   pile to eat. No food → a hungry bubble and they work at half speed. The camp slowly runs itself.

Loose items: if your stack is full, extra drops fall on the ground and wait ~40 s to be picked up by walking over.
Regrowth: stumps grow back into trees (35 s), rocks respawn (50 s), animals respawn (~16–24 s).

## Map (src/world/map-camp.js)

Home isle (camp) x14..28 z11..21. Bridges (built by pads) lead to: **forest** (west: dense trees, boars),
**north** meadow (stone deposit, rocks, rabbits), **east** (copper deposit, rocks, boars), **south** (trees,
deer). Map has `islands`, `islandAt(x,z)`, `bridges` {id → {tiles, orientation}}; `map.bridge[]` flips on as a
bridge is built (tiles are water until then).

## Sim API (src/sim/camp.js → `ctx.camp`)

Data in `src/sim/camp-data.js` (layout, costs, timings). State to read every frame:

- `camp.level`, `camp.capacity`, `camp.stack` (carried items bottom → top; mirrors `sim.inventory`),
  `camp.total()`, `camp.free()`, `camp.gatherSpeed`, `camp.complete`.
- `camp.stations: Map<id, {id, def, input:{item:n}, busy, progress 0..1, working, held,
  line: {path:[[x,z]...], items:[{item, p, uid}]}, pile: {tile:[x,z], item, count}}>`. Only built stations.
  A line item's world position: walk `path` by `p` tiles (p=0 at the station edge … p=path.length at the end);
  segments go from the station footprint edge through each path tile centre.
- `camp.pads: [{id, zone:[x,z,w,h], cost:{item:n}, paid:{item:n}}]` visible unfinished pads.
  `camp.padRemaining(pad)`, `camp.padCenter(pad)`.
- `camp.animals: Map<id, {id, kind, island, x, z, heading, hp, maxHp, state 'idle'|'walk'|'flee'|'dead', speed}>`.
- `camp.workers: Map<id, {id, role 'lumberjack'|'hunter', x, z, heading, state, speed, carry:{item, n}, cap,
  hunger, hungry}>`. States: seek, idle, toTarget, work, deliver, drop, toFood, eat.
- `camp.loose: [{id, item, x, z, t}]`, `camp.bridges` (Set of built ids).
- Positions are floats in tile units (tile centre = integer). Headings are atan2(dz, dx).

### Camp events (`ctx.events`)

| event | payload |
|---|---|
| `camp:swing` | `{ by: 'player' | workerId, target: {type 'resource'|'animal', id, kind, x, z}, tool 'axe'|'pick'|'club', fromDir, hitIn }` — the hit lands `hitIn` s later |
| `camp:stackFull` | `{}` (throttle any UI) |
| `pad:shown` / `pad:paid` / `pad:complete` | `{ pad }` / `{ pad, item }` / `{ pad }` |
| `station:built` | `{ station }` |
| `station:drop` | `{ station, item, by }` (an item went into a station; `by` = 'player', worker id, or a station id for lines) |
| `station:start` / `station:produced` | `{ station }` / `{ station, item }` |
| `line:arrived` | `{ station, item, to? }` |
| `pile:changed` / `pile:take` | `{ station }` / `{ station, item, by }` |
| `hearth:level` | `{ level }` ; `camp:complete` `{}` at the top level |
| `bridge:start` / `bridge:plank` / `bridge:built` | `{ bridge }` / `{ bridge, index, tile }` / `{ bridge }` |
| `upgrade` | `{ id, upgrade }` ; `capacity:changed` `{ capacity }` |
| `animal:spawned` / `animal:hit` / `animal:killed` / `animal:removed` | `{ animal, by?, drops? }` |
| `worker:hired` / `worker:state` / `worker:carry` / `worker:hungry` / `worker:ate` | `{ worker, ... }` |
| `loose:spawned` / `loose:taken` / `loose:expired` | `{ loose }` |
| `camp:regrow` | `{ entity }` (a tree/rock grew back; also `resource:spawned`) |
| `inventory:changed` | as before; with `source` when items come from the world → fx flies them to the pack |

Resource sim additions (sim.js): `hitResource(id, fromDir, { collect: false })` returns `{ depleted, drops,
replacedBy, entity }` without touching the inventory; `spawnResource(kind, x, z, opts)` emits
`resource:spawned { entity, grow }`; `removeResource(id)` emits `resource:removed { entity }`.
Built station footprints block walking (`sim.isWalkable` is wrapped by the camp).

## Views (who draws what)

- **camp view** (`src/view/camp.js` + `src/view/camp/*`): stations (hearth, sawmill, cookfire, hut, quarry,
  copper drill, smelter) and their working animations, production lines with items riding them, pickup piles
  (neat stacks that grow), drop-zone markers, build pads (dashed rounded outline, ghost of what's coming, cost
  bubble with item icons and remaining counts, fill progress, the paying stream), the build-complete moment,
  bridges assembling plank by plank, hearth level-up moment.
- **creatures** (`src/view/creatures.js` + `src/view/creatures/*`): animals (deer, boar, rabbit) and workers
  (villagers with role hats + carried stacks), all animated from camp state with smoothing.
- **player**: the robot + movement (polish round) + auto-gather swings from `camp:swing` (by 'player'), the
  back stack (items stacked on the pack with springy sway), STACK FULL bubble.
- **fx**: flights to the pack (existing), plus flights *from* the pack to pads / zones (`pad:paid`,
  `station:drop` by player), poof clouds for animals, level-up sparkles.
- **ui**: minimal HUD — hearth level pill with a ring showing progress of the current hearth pad, carried
  count `7/10` near the stack, toasts, a level-up banner, settings (sound later). Desktop + mobile.
- **world**: clouds open wider per hearth level (`hearth:level`), the new map, regrowth.
