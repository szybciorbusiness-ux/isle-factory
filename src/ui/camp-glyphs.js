// Small filled SVG glyphs for the camp HUD (flame badge, stack, toasts, unlock chips). Same warm palette as the
// world: orange / cream / wood, a soft darker rim so they read at 18-28 px over cream. No strokes in black.

const wrap = (body, vb = 32) => `<svg viewBox="0 0 ${vb} ${vb}" aria-hidden="true" focusable="false">${body}</svg>`;

export const GLYPHS = {
  // campfire flame on two little logs
  flame: wrap(
    '<ellipse cx="16" cy="28.4" rx="9.5" ry="2" fill="#b48a52" opacity=".22"/>'
    + '<rect x="6.5" y="23.6" width="19" height="4.4" rx="2.2" fill="#a8683a" transform="rotate(-11 16 25.8)"/>'
    + '<rect x="6.5" y="23.6" width="19" height="4.4" rx="2.2" fill="#c98a4b" transform="rotate(11 16 25.8)"/>'
    + '<circle cx="8.3" cy="22.3" r="1.5" fill="#f3d3a0" transform="rotate(11 16 25.8)"/>'
    + '<path d="M16 2.6c1.5 4.6 7.6 7.2 8.2 13.4.5 5.6-3.4 9.4-8.2 9.4s-8.7-3.6-8.2-8.9c.3-3.6 2.7-5.6 3.9-8.3.7 2.2 1.7 3.5 3 4C14.4 9.3 14.6 5.8 16 2.6z" fill="#f08a24"/>'
    + '<path d="M16 2.6c1.5 4.6 7.6 7.2 8.2 13.4.5 5.6-3.4 9.4-8.2 9.4 3.4-1.2 5.4-4.4 5-8.6-.4-4.6-4.6-7.4-5-14.2z" fill="#e2721a" opacity=".55"/>'
    + '<path d="M16 12.6c.8 2.7 4.3 4.2 4.6 7.6.3 3.1-1.9 5.2-4.6 5.2s-4.9-2-4.6-5.1c.2-2 1.5-3.1 2.2-4.6.4 1.2 1 1.9 1.7 2.2 0-2.2.1-3.6.7-5.3z" fill="#ffd25e"/>'
    + '<ellipse cx="14.6" cy="20.6" rx="1.3" ry="2.1" fill="#fff4c9" opacity=".8"/>',
  ),
  // the same campfire drawn light, for the orange level badge (cream flame, butter core, dark logs)
  flameLight: wrap(
    '<rect x="6.5" y="23.4" width="19" height="4.6" rx="2.3" fill="#8a4f26" transform="rotate(-11 16 25.8)"/>'
    + '<rect x="6.5" y="23.4" width="19" height="4.6" rx="2.3" fill="#a8683a" transform="rotate(11 16 25.8)"/>'
    + '<path d="M16 2.2c1.6 4.8 8 7.5 8.6 14 .5 5.8-3.6 9.8-8.6 9.8s-9.1-3.7-8.6-9.3c.3-3.8 2.8-5.9 4.1-8.7.7 2.3 1.8 3.7 3.1 4.2C14.3 9.2 14.5 5.5 16 2.2z" fill="#fff6dd" stroke="#5b3a21" stroke-width="1.6" stroke-linejoin="round"/>'
    + '<path d="M16 12.4c.8 2.8 4.5 4.4 4.8 7.9.3 3.2-2 5.4-4.8 5.4s-5.1-2.1-4.8-5.3c.2-2.1 1.6-3.2 2.3-4.8.4 1.3 1 2 1.8 2.3 0-2.3.1-3.8.7-5.5z" fill="#ffc533"/>'
    + '<ellipse cx="13.4" cy="12.8" rx="1.3" ry="2.6" fill="#fff" opacity=".9" transform="rotate(18 13.4 12.8)"/>',
  ),
  // three stacked crates: "what you carry"
  stack: wrap(
    '<ellipse cx="16" cy="28.6" rx="10" ry="2" fill="#b48a52" opacity=".22"/>'
    + '<rect x="6" y="19.5" width="20" height="8.5" rx="2.6" fill="#c98a4b"/><rect x="6" y="19.5" width="20" height="3" rx="1.5" fill="#e0aa6c"/>'
    + '<rect x="8" y="11.5" width="17" height="8.5" rx="2.6" fill="#b8743f"/><rect x="8" y="11.5" width="17" height="3" rx="1.5" fill="#d4945a"/>'
    + '<rect x="9.5" y="4" width="14" height="8" rx="2.6" fill="#e0aa6c"/><rect x="9.5" y="4" width="14" height="2.8" rx="1.4" fill="#f3cc93"/>',
  ),
  // a backpack with a plus: bigger pack
  pack: wrap(
    '<ellipse cx="16" cy="28.8" rx="9" ry="1.9" fill="#b48a52" opacity=".22"/>'
    + '<path d="M11.5 8.5c0-3 2-4.6 4.5-4.6s4.5 1.6 4.5 4.6" fill="none" stroke="#a8683a" stroke-width="2.4" stroke-linecap="round"/>'
    + '<rect x="6.5" y="7.5" width="19" height="20.5" rx="6" fill="#f08a24"/>'
    + '<rect x="6.5" y="7.5" width="19" height="8" rx="4" fill="#f6a64a"/>'
    + '<rect x="10" y="17.5" width="12" height="8" rx="3" fill="#d9741a"/>'
    + '<path d="M16 19.4v4.2M13.9 21.5h4.2" stroke="#fff4dc" stroke-width="2" stroke-linecap="round"/>',
  ),
  // a villager bust with a knitted hat (hat colour per role)
  worker: (hat = '#e2574c') => wrap(
    '<ellipse cx="16" cy="29" rx="9" ry="1.8" fill="#b48a52" opacity=".22"/>'
    + '<path d="M6.5 28.4c.4-5.6 4.4-8.6 9.5-8.6s9.1 3 9.5 8.6z" fill="#7cc243"/>'
    + '<path d="M13.4 20.1 16 23.4l2.6-3.3" fill="#5f9e2f"/>'
    + '<circle cx="16" cy="13.4" r="6.4" fill="#f3c9a0"/>'
    + '<circle cx="13.6" cy="14" r=".95" fill="#5a4330"/><circle cx="18.4" cy="14" r=".95" fill="#5a4330"/>'
    + '<circle cx="12.4" cy="16.2" r="1.1" fill="#f2a08a" opacity=".7"/><circle cx="19.6" cy="16.2" r="1.1" fill="#f2a08a" opacity=".7"/>'
    + `<path d="M9.4 12.2c0-4.6 2.9-7.4 6.6-7.4s6.6 2.8 6.6 7.4z" fill="${hat}"/>`
    + '<rect x="8.8" y="10.8" width="14.4" height="3" rx="1.5" fill="#fff4dc" opacity=".9"/>'
    + `<circle cx="16" cy="4.6" r="2" fill="${hat}"/>`,
  ),
  // a tiny island with a tree: new island
  island: wrap(
    '<ellipse cx="16" cy="24.5" rx="13.5" ry="5" fill="#7fd9c4"/>'
    + '<ellipse cx="16" cy="22.4" rx="11" ry="4.4" fill="#f3dca8"/>'
    + '<ellipse cx="16" cy="21" rx="9.6" ry="3.6" fill="#9ccd52"/>'
    + '<rect x="18.1" y="12" width="2.4" height="8" rx="1.1" fill="#a8683a"/>'
    + '<circle cx="19.3" cy="10.4" r="5" fill="#4f9a3a"/><circle cx="17" cy="12.2" r="3.4" fill="#3f8a33"/><circle cx="20.8" cy="8.6" r="2.2" fill="#6cb84a"/>'
    + '<circle cx="10.6" cy="20.2" r="1.1" fill="#fff4dc"/><circle cx="12.8" cy="21.6" r=".9" fill="#f08a24"/>',
  ),
  // planks across a gap
  bridge: wrap(
    '<path d="M2 25h28" stroke="#7fd9c4" stroke-width="4" stroke-linecap="round"/>'
    + '<path d="M3 18c4.5-4 21.5-4 26 0" fill="none" stroke="#a8683a" stroke-width="2" stroke-linecap="round"/>'
    + '<rect x="3.5" y="17" width="5" height="9" rx="1.6" fill="#c98a4b"/><rect x="9.6" y="15.2" width="5" height="9" rx="1.6" fill="#e0aa6c"/>'
    + '<rect x="15.7" y="14.8" width="5" height="9" rx="1.6" fill="#c98a4b"/><rect x="21.8" y="16.4" width="5" height="9" rx="1.6" fill="#e0aa6c"/>',
  ),
  // a little wooden hut
  hut: wrap(
    '<ellipse cx="16" cy="28.6" rx="11" ry="2" fill="#b48a52" opacity=".22"/>'
    + '<rect x="7" y="14" width="18" height="14" rx="2.4" fill="#e0aa6c"/>'
    + '<rect x="13.4" y="19.2" width="5.2" height="8.8" rx="2.4" fill="#a8683a"/>'
    + '<path d="M4.4 15.6 16 5l11.6 10.6c.8.8.3 1.9-.8 1.9H5.2c-1.1 0-1.6-1.1-.8-1.9z" fill="#e2574c"/>'
    + '<path d="M8 13.4 16 6.4l8 7" fill="none" stroke="#f08a74" stroke-width="1.6" stroke-linecap="round" opacity=".8"/>',
  ),
  // hammer: something new to build
  build: wrap(
    '<ellipse cx="16" cy="28.6" rx="9" ry="1.9" fill="#b48a52" opacity=".22"/>'
    + '<path d="M9 26.5 20 15.5" stroke="#9b6334" stroke-width="5" stroke-linecap="round"/>'
    + '<path d="M9 26.5 20 15.5" stroke="#d89a58" stroke-width="2.6" stroke-linecap="round"/>'
    + '<g transform="rotate(45 21 11.5)"><rect x="12" y="7" width="18" height="9" rx="3" fill="#e48b4f"/><rect x="14" y="8.8" width="8" height="2.6" rx="1.3" fill="#ffd9a8" opacity=".9"/></g>',
  ),
  // copper axe: better tools
  axe: wrap(
    '<ellipse cx="16" cy="28.6" rx="9" ry="1.9" fill="#b48a52" opacity=".22"/>'
    + '<path d="M10 27 21 9" stroke="#9b6334" stroke-width="3.6" stroke-linecap="round"/>'
    + '<path d="M10 27 21 9" stroke="#d89a58" stroke-width="1.6" stroke-linecap="round"/>'
    + '<path d="M17.6 6.4c3.4-2.6 8.4-1.6 10.2 1.6l-6.2 6.4c-2.6-1.4-4.2-4.4-4-8z" fill="#e8894a"/>'
    + '<path d="M27.8 8c.6 1.4.4 3-.6 4.4l-5.6 2" fill="none" stroke="#ffc18f" stroke-width="1.6" stroke-linecap="round"/>',
  ),
  // gold star: celebration
  star: wrap(
    '<ellipse cx="16" cy="29" rx="9" ry="1.8" fill="#b48a52" opacity=".22"/>'
    + '<path d="M16 3.2l3.6 7.6 8.2 1-6 5.7 1.6 8.2L16 21.7l-7.4 4 1.6-8.2-6-5.7 8.2-1z" fill="#f6b73c" stroke="#e2952a" stroke-width="1.4" stroke-linejoin="round"/>'
    + '<path d="M16 7.4l2.2 4.6" stroke="#fff1c2" stroke-width="1.8" stroke-linecap="round"/>',
  ),
  // a soup bowl: hungry workers
  bowl: wrap(
    '<ellipse cx="16" cy="28.4" rx="10" ry="1.9" fill="#b48a52" opacity=".22"/>'
    + '<path d="M11 6.5c-1.4 1.6 1.4 2.6 0 4.2M16 5c-1.4 1.6 1.4 2.6 0 4.2M21 6.5c-1.4 1.6 1.4 2.6 0 4.2" fill="none" stroke="#e7d2aa" stroke-width="1.8" stroke-linecap="round"/>'
    + '<path d="M4.5 14h23c0 7-5.2 12-11.5 12S4.5 21 4.5 14z" fill="#e2574c"/>'
    + '<path d="M4.5 14h23c0 1.2-.2 2.3-.5 3.4H5c-.3-1.1-.5-2.2-.5-3.4z" fill="#f08a74"/>'
    + '<ellipse cx="16" cy="14" rx="11.5" ry="2.2" fill="#c98a4b"/>',
  ),
  // a round wooden clock: time played (completion card)
  clock: wrap(
    '<ellipse cx="16" cy="29" rx="9" ry="1.8" fill="#b48a52" opacity=".22"/>'
    + '<circle cx="16" cy="16" r="11.6" fill="#c98a4b"/>'
    + '<circle cx="16" cy="16" r="9" fill="#fff4dc"/>'
    + '<path d="M16 9.6v6.6l4.4 2.6" fill="none" stroke="#a8683a" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'
    + '<circle cx="16" cy="16" r="1.6" fill="#f08a24"/>'
    + '<path d="M9.4 9.2c1.4-1.6 3.2-2.5 5-2.8" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity=".7"/>',
  ),
  dot: wrap('<circle cx="16" cy="16" r="6" fill="#f08a24"/>'),
};

export function glyph(name, ...args) {
  const g = GLYPHS[name] ?? GLYPHS.dot;
  return typeof g === 'function' ? g(...args) : g;
}

// Hat colours per worker role (kept in step with the villagers' role hats where possible).
export const ROLE_HAT = { lumberjack: '#e2574c', hunter: '#4f9a3a' };
