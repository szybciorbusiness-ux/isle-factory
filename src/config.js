// Shared game data. Every module reads from here; nobody hardcodes item ids, recipes or timings elsewhere.

// ---------- Grid & directions ----------
// One tile = 1 world unit. Tile (x, z) is centred on world (x, 0, z); the land top surface is y = 0.
// +x is east (screen right), +z is south (toward the camera / screen down).
export const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // 0 east, 1 south, 2 west, 3 north
export const DIR_NAMES = ['east', 'south', 'west', 'north'];
export const opposite = d => (d + 2) & 3;
// rotation.y that turns a model whose "front" faces local +x so it faces direction d.
export const dirAngle = d => -d * Math.PI / 2;
// Direction index from a delta (dx, dz), or -1.
export const dirFromDelta = (dx, dz) => DIRS.findIndex(([x, z]) => x === Math.sign(dx) && z === Math.sign(dz) && (dx === 0 || dz === 0));

export const WATER_Y = -0.32;   // water surface height
export const LAND_Y = 0;        // land top height

// ---------- Art palette (sampled from the reference look) ----------
export const PALETTE = {
  grassLight: '#9fd34e', grassMid: '#8cc742', grassDark: '#6aa834', grassBlade: '#79b93a',
  sand: '#f3de97', sandShade: '#dcc078', cliff: '#e9cf86',
  rock: '#f1e1b6', rockShade: '#d6bf88',
  leafDark: '#2e6a3a', leafMid: '#3d8746', leafLight: '#58a650', trunk: '#7a4b2b',
  barkDark: '#5f3820', stumpTop: '#e9c793',
  waterDeep: '#0d5873', waterMid: '#13808f', waterShallow: '#3fc2ac', waterGlow: '#a3f2d3',
  cloud: '#f4fbf6', cloudShade: '#c9ecdc', sky: '#cfeee2',
  flowerOrange: '#f39a4a', flowerWhite: '#fff6e6',
  wood: '#c98a4b', woodDark: '#9b6334', copper: '#e48b4f', copperDark: '#b9643a', stoneBlock: '#ece0c4',
  beltDark: '#4b505c', beltStripe: '#f2c14e',
  body: '#3b3430', hat: '#f4c430', pack: '#f08a24', packStrap: '#ffd36b',
  uiCream: '#fff7e6', uiInk: '#3b3226', uiAccent: '#f08a24', uiGreen: '#7cc243', uiRed: '#e2574c',
};

// ---------- Items ----------
// `building` marks items that place a building of that kind.
export const ITEMS = {
  wood:        { name: 'Wood',         color: '#8a5a33' },
  stone:       { name: 'Stone',        color: '#d9cba6' },
  copperOre:   { name: 'Copper ore',   color: '#d9814a' },
  plank:       { name: 'Plank',        color: '#e0b27a' },
  copperPlate: { name: 'Copper plate', color: '#f09a5a' },
  // camp items (GAMEPLAY.md)
  meat:        { name: 'Raw meat',     color: '#e07a6e' },
  cookedMeat:  { name: 'Cooked meat',  color: '#b8683a' },
  copperBar:   { name: 'Copper bar',   color: '#e8894a' },
  belt:        { name: 'Belt',         color: '#4b505c', building: 'belt' },
  drill:       { name: 'Drill',        color: '#e48b4f', building: 'drill' },
  chest:       { name: 'Chest',        color: '#c98a4b', building: 'chest' },
  workshop:    { name: 'Workshop',     color: '#ece0c4', building: 'workshop' },
};
export const RESOURCE_ITEMS = ['wood', 'stone', 'copperOre', 'plank', 'copperPlate'];
export const BUILDING_ITEMS = ['belt', 'drill', 'chest', 'workshop']; // hotbar order, keys 1-4

// ---------- Recipes ----------
// hand: craftable from the crafting panel. machine: a workshop can be set to it.
export const RECIPES = {
  plank:       { name: 'Planks',       inputs: { wood: 1 },                               outputs: { plank: 2 },       time: 0.6, hand: true, machine: true },
  copperPlate: { name: 'Copper plate', inputs: { copperOre: 2 },                          outputs: { copperPlate: 1 }, time: 1.6, hand: true, machine: true },
  belt:        { name: 'Belts',        inputs: { plank: 1, stone: 1 },                    outputs: { belt: 2 },        time: 0.5, hand: true },
  chest:       { name: 'Chest',        inputs: { plank: 4 },                              outputs: { chest: 1 },       time: 0.8, hand: true },
  drill:       { name: 'Drill',        inputs: { stone: 5, plank: 3 },                    outputs: { drill: 1 },       time: 1.2, hand: true },
  workshop:    { name: 'Workshop',     inputs: { plank: 6, stone: 4, copperPlate: 2 },    outputs: { workshop: 1 },    time: 1.6, hand: true },
};
export const HAND_RECIPES = ['plank', 'copperPlate', 'belt', 'chest', 'drill', 'workshop'];
export const MACHINE_RECIPES = ['plank', 'copperPlate'];

// ---------- Buildings ----------
export const BUILDINGS = {
  belt:     { name: 'Belt',     item: 'belt',     blocking: false, rotatable: true },
  drill:    { name: 'Drill',    item: 'drill',    blocking: true,  rotatable: true, needsDeposit: true, interval: 1.8 },
  chest:    { name: 'Chest',    item: 'chest',    blocking: true,  rotatable: false, capacity: 80 },
  workshop: { name: 'Workshop', item: 'workshop', blocking: true,  rotatable: true, outputBuffer: 10, outputInterval: 0.3 },
};
export const BELT = { speed: 1.5, spacing: 0.27 }; // speed in belt-lengths per second; min gap between items

// ---------- World resources ----------
export const RESOURCES = {
  tree:  { name: 'Tree',  hp: 3, drops: { wood: 4 },  becomes: 'stump', blocking: true },
  rock:  { name: 'Rock',  hp: 4, drops: { stone: 5 }, becomes: null,    blocking: true },
  stump: { name: 'Stump', hp: 1, drops: { wood: 1 },  becomes: null,    blocking: true },
};
// map.deposit codes -> what a drill (or a hand hit) yields there
export const DEPOSITS = {
  1: { id: 'copper', name: 'Copper ore', item: 'copperOre' },
  2: { id: 'stone',  name: 'Stone',      item: 'stone' },
};

// ---------- Player ----------
// reach: chop / mine distance (adjacent, diagonals included) so the critter walks up to what it hits.
// useReach: open chests / workshops. buildReach: place / remove buildings without walking.
// moveSpeed: free 8-direction walking, tiles per second.
export const PLAYER = { stepTime: 0.2, reach: 1.5, useReach: 4, buildReach: 10, moveSpeed: 4.2, swingTime: 0.4 };

export const START_INVENTORY = { belt: 10, chest: 1 };

// ---------- Quests ----------
// Off: the user wants a free sandbox, no quest tracker. The sim treats an empty list as "no quests".
export const QUESTS = [];
