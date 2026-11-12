// Camp gameplay data (arcade-idle survival). Layout coordinates are tiles on src/world/map-camp.js.
// Rects are [x, z, w, h]. Lines are ordered tile paths from the station edge to their destination.

export const CAMP = {
  capacity: 10,              // starting carry stack
  gatherRadius: 1.55,        // player centre -> resource tile centre (adjacent incl. diagonals: 1.41)
  huntRadius: 1.45,          // player centre -> animal centre
  swingTime: 0.42,           // seconds between auto swings
  hitDelay: 0.13,            // swing start -> impact
  payStart: 0.14,            // first transfer interval on a pad / zone / pile
  payMin: 0.035,             // transfer interval after ramping up
  payRamp: 0.82,             // interval multiplier per transfer while standing still on it
  pileCap: 40,
  inputCap: 24,
  lineSpeed: 1.1,            // tiles per second along a production line
  lineSpacing: 0.45,
  looseLife: 40,             // seconds a dropped item lies around before it fades
  regrow: { stump: 35, rock: 50 },
};

// Stations. footprint blocks walking once built. zone = where the player / workers drop inputs.
// line -> pile (pickup) or -> another station's input (to: id).
export const STATIONS = {
  hearth:      { name: 'Hearth',       footprint: [20, 13, 2, 2] },
  sawmill:     { name: 'Sawmill',      footprint: [16, 12, 2, 2], zone: [16, 14, 2, 1], accepts: ['wood'],
                 recipe: { in: { wood: 1 }, out: 'plank', time: 0.9 }, line: [[15, 13], [15, 14]], pile: [15, 15] },
  cookfire:    { name: 'Cookfire',     footprint: [24, 12, 2, 2], zone: [24, 14, 2, 1], accepts: ['meat'],
                 recipe: { in: { meat: 1 }, out: 'cookedMeat', time: 1.2 }, line: [[26, 13], [26, 14]], pile: [26, 15] },
  hut:         { name: 'Workers’ hut', footprint: [16, 16, 2, 2], door: [18, 16] },
  quarry:      { name: 'Quarry',       footprint: [17, 4, 2, 2], auto: { out: 'stone', time: 2.4 }, line: [[19, 5], [20, 5]], pile: [21, 5] },
  copperDrill: { name: 'Copper drill', footprint: [33, 12, 2, 2], auto: { out: 'copperOre', time: 2.0 }, line: [[35, 12], [35, 13]], to: 'smelter' },
  smelter:     { name: 'Smelter',      footprint: [36, 12, 2, 2], zone: [36, 14, 2, 1], accepts: ['copperOre'],
                 recipe: { in: { copperOre: 2 }, out: 'copperBar', time: 2.0 }, line: [[38, 12], [38, 13]], pile: [38, 14] },
};

// Hearth levels: cost to reach level N (index N). The camp starts at level 0: a cold hearth.
export const HEARTH = [null,
  { wood: 4 },                                  // level 1: light the cold hearth (the opening beat)
  { plank: 22, cookedMeat: 4 },
  { plank: 45, cookedMeat: 12 },
  { plank: 70, stone: 35, cookedMeat: 20 },
  { plank: 60, copperBar: 20 },
];
export const HEARTH_ZONE = [20, 15, 2, 1];
export const MAX_LEVEL = HEARTH.length - 1;

// Build pads. zone = where you stand to pay. requires: all listed conditions must hold for the pad to show.
// action: build:<station> | hearth | bridge:<id> | upgrade:<id> | hire:<role>
// ORDER = the main line (FIRST-20.md). camp.nextGoal() guides to the first visible pad in this order.
export const PADS = [
  { id: 'hearth:1',          zone: HEARTH_ZONE,    cost: HEARTH[1],                      requires: {} },
  { id: 'build:sawmill',     zone: [16, 12, 2, 2], cost: { wood: 10 },                   requires: { level: 1 } },
  { id: 'build:cookfire',    zone: [24, 12, 2, 2], cost: { plank: 12 },                  requires: { built: ['sawmill'] } },
  { id: 'hearth:2',          zone: HEARTH_ZONE,    cost: HEARTH[2],                      requires: { level: 1, built: ['cookfire'] } },
  { id: 'upgrade:pack1',     zone: [23, 17, 1, 1], cost: { plank: 16 },                  requires: { level: 2 } },
  { id: 'build:hut',         zone: [16, 16, 2, 2], cost: { plank: 24 },                  requires: { level: 2 } },
  { id: 'hire:lumberjack',   zone: [18, 13, 1, 1], cost: { cookedMeat: 5 },              requires: { built: ['hut', 'sawmill'] } },
  { id: 'hire:hunter',       zone: [23, 15, 1, 1], cost: { cookedMeat: 5 },              requires: { built: ['hut', 'cookfire'] } },
  { id: 'bridge:west',       zone: [14, 15, 1, 1], cost: { plank: 20 },                  requires: { level: 2 } },
  { id: 'bridge:south',      zone: [20, 21, 1, 1], cost: { plank: 25 },                  requires: { level: 2 } },
  { id: 'hearth:3',          zone: HEARTH_ZONE,    cost: HEARTH[3],                      requires: { level: 2, built: ['hut'] } },
  { id: 'bridge:north',      zone: [21, 11, 1, 1], cost: { plank: 30 },                  requires: { level: 3 } },
  { id: 'build:quarry',      zone: [17, 4, 2, 2],  cost: { plank: 35 },                  requires: { level: 3, bridges: ['north'] } },
  { id: 'upgrade:pack2',     zone: [23, 17, 1, 1], cost: { plank: 40, stone: 15 },       requires: { level: 3, upgrades: ['pack1'] } },
  { id: 'hire:lumberjack#2', zone: [18, 13, 1, 1], cost: { cookedMeat: 10 },             requires: { level: 3, hired: ['hire:lumberjack'] } },
  { id: 'bridge:east',       zone: [28, 15, 1, 1], cost: { plank: 40, stone: 20 },       requires: { level: 3 } },
  { id: 'build:copperDrill', zone: [33, 12, 2, 2], cost: { plank: 35, stone: 25 },       requires: { bridges: ['east'] } },
  { id: 'build:smelter',     zone: [36, 12, 2, 2], cost: { stone: 35, plank: 20 },       requires: { bridges: ['east'] } },
  { id: 'upgrade:axe',       zone: [22, 17, 1, 1], cost: { copperBar: 10 },              requires: { built: ['smelter'] } },
  { id: 'hire:hunter#2',     zone: [23, 15, 1, 1], cost: { cookedMeat: 10 },             requires: { level: 3, hired: ['hire:hunter'] } },
  { id: 'hearth:4',          zone: HEARTH_ZONE,    cost: HEARTH[4],                      requires: { level: 3, built: ['quarry'] } },
  { id: 'hearth:5',          zone: HEARTH_ZONE,    cost: HEARTH[5],                      requires: { level: 4, built: ['smelter'] } },
];

export const UPGRADES = {
  pack1: { name: 'Bigger pack', capacity: 20 },
  pack2: { name: 'Huge pack', capacity: 30 },
  axe:   { name: 'Copper tools', gatherSpeed: 1.6 },
};

// Animals: drops are cute, not gory (the animal poofs, drumsticks pop out).
export const ANIMALS = {
  deer:   { name: 'Deer',   hp: 2, drops: { meat: 2 }, speed: 1.1, fleeSpeed: 3.0, size: 0.55 },
  boar:   { name: 'Boar',   hp: 3, drops: { meat: 3 }, speed: 0.9, fleeSpeed: 2.4, size: 0.5 },
  rabbit: { name: 'Rabbit', hp: 1, drops: { meat: 1 }, speed: 1.5, fleeSpeed: 3.6, size: 0.3 },
};
// island -> [[kind, count]]
export const ANIMAL_SPAWNS = {
  home: [['deer', 2]],
  forest: [['boar', 3]],
  north: [['rabbit', 3]],
  south: [['deer', 3]],
  east: [['boar', 2]],
};
export const ANIMAL_RESPAWN = 16;

// Bridge id -> the island it opens, by name (toasts, pad labels, edge chips).
export const ISLAND_NAMES = { west: 'Forest', north: 'Meadow', east: 'Copper isle', south: 'Deer glade' };

export const WORKERS = {
  lumberjack: { name: 'Lumberjack', carry: 4, speed: 2.2, workTime: 0.62, target: 'tree', deliver: 'sawmill' },
  hunter:     { name: 'Hunter',     carry: 4, speed: 2.4, workTime: 0.6,  target: 'animal', deliver: 'cookfire' },
};
export const HUNGER_TIME = 55;   // seconds until a worker needs a cooked meal
