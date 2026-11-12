// Friendly names + glyphs for what a pad unlocks (the level-up ribbon's chips, the badge's "next level" card).
import * as CAMP_DATA from '../sim/camp-data.js';
import { STATIONS, UPGRADES, WORKERS, PADS } from '../sim/camp-data.js';
import { ROLE_HAT } from './camp-glyphs.js';

// bridge id -> island name: shared with the pads view and the sim's data (camp-data.js ISLAND_NAMES)
export const ISLAND_NAMES = CAMP_DATA.ISLAND_NAMES || { west: 'Forest', north: 'Meadow', east: 'Copper isle', south: 'Deer glade' };
const NTH = ['', '', 'Second', 'Third', 'Fourth', 'Fifth'];

// 'build:hut', 'bridge:west', 'upgrade:pack1', 'hire:hunter#2' -> { text, icon, args? }
export function unlockLabel(padId) {
  const [kind, arg = ''] = String(padId).split(':');
  const [what, nth] = arg.split('#');
  if (kind === 'build') return { text: STATIONS[what]?.name || what, icon: what === 'hut' ? 'hut' : 'build' };
  if (kind === 'bridge') return { text: `${ISLAND_NAMES[what] || what} bridge`, icon: 'bridge' };
  if (kind === 'upgrade') return { text: UPGRADES[what]?.name || what, icon: UPGRADES[what]?.capacity ? 'pack' : 'axe' };
  if (kind === 'hire') {
    const name = WORKERS[what]?.name || what;
    return { text: nth ? `${NTH[Number(nth)] || 'Another'} ${name.toLowerCase()}` : name, icon: 'worker', args: [ROLE_HAT[what]] };
  }
  return null;
}
// Pads a hearth level opens (static data, for the "next level" card).
export const unlocksForLevel = level => PADS.filter(p => !p.id.startsWith('hearth:') && p.requires?.level === level).map(p => p.id);
