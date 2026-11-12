// Hand-drawn 2D item icons, used when an item has no proper 3D mesh yet (items.js falls back to a plain cube)
// or when rendering the model fails. Same framing as the rendered icons: three-quarter view, warm key light
// from the upper left, a soft warm contact shadow at the foot. Drawn at `size` px (square).

const TAU = Math.PI * 2;

function shadow(g, cx, cy, rx, ry) {
  g.save();
  g.translate(cx, cy); g.scale(1, ry / rx);
  const grad = g.createRadialGradient(0, 0, 0, 0, 0, rx);
  grad.addColorStop(0, 'rgba(110, 76, 30, 0.30)');
  grad.addColorStop(0.6, 'rgba(110, 76, 30, 0.14)');
  grad.addColorStop(1, 'rgba(110, 76, 30, 0)');
  g.fillStyle = grad;
  g.beginPath(); g.arc(0, 0, rx, 0, TAU); g.fill();
  g.restore();
}

// A drumstick lying diagonally: bone to the lower left, the meaty end up and to the right.
function drumstick(g, s, cooked) {
  const c = cooked
    ? { base: '#bf6f3c', hi: '#e19a5f', lo: '#8f4b27', rim: '#7a3d1f', spot: 'rgba(255, 222, 170, 0.75)' }
    : { base: '#e8796c', hi: '#f8aa9c', lo: '#c4564d', rim: '#b24a43', spot: 'rgba(255, 236, 228, 0.8)' };
  shadow(g, 0.52 * s, 0.8 * s, 0.4 * s, 0.085 * s);

  // bone: shaft + double knob, cream with a soft lower shade
  g.save();
  g.lineCap = 'round';
  g.strokeStyle = '#dcc7a2'; g.lineWidth = 0.13 * s;
  g.beginPath(); g.moveTo(0.27 * s, 0.7 * s); g.lineTo(0.5 * s, 0.5 * s); g.stroke();
  g.strokeStyle = '#f7ecd6'; g.lineWidth = 0.095 * s;
  g.beginPath(); g.moveTo(0.27 * s, 0.69 * s); g.lineTo(0.5 * s, 0.49 * s); g.stroke();
  for (const [x, y] of [[0.19, 0.66], [0.25, 0.76]]) {
    g.fillStyle = '#dcc7a2';
    g.beginPath(); g.arc(x * s, (y + 0.012) * s, 0.072 * s, 0, TAU); g.fill();
    g.fillStyle = '#fbf2e0';
    g.beginPath(); g.arc(x * s, y * s, 0.062 * s, 0, TAU); g.fill();
  }
  g.fillStyle = 'rgba(255, 255, 255, 0.7)';
  g.beginPath(); g.ellipse(0.175 * s, 0.64 * s, 0.024 * s, 0.014 * s, -0.6, 0, TAU); g.fill();
  g.restore();

  // the meat: an egg pointing at the bone
  g.save();
  g.translate(0.62 * s, 0.4 * s);
  g.rotate(-0.72);
  const rx = 0.27 * s, ry = 0.215 * s;
  const egg = () => {
    g.beginPath();
    // fatter at +x (away from the bone), narrower toward -x
    g.moveTo(-rx, 0);
    g.bezierCurveTo(-rx, -ry * 0.75, -rx * 0.2, -ry * 1.05, rx * 0.35, -ry);
    g.bezierCurveTo(rx * 0.95, -ry * 0.92, rx * 1.08, -ry * 0.3, rx, 0.05 * ry);
    g.bezierCurveTo(rx * 0.95, ry * 0.75, rx * 0.4, ry * 1.04, -rx * 0.05, ry * 0.98);
    g.bezierCurveTo(-rx * 0.6, ry * 0.92, -rx, ry * 0.6, -rx, 0);
    g.closePath();
  };
  // rim (slightly bigger, darker) then the body with a top-left light
  g.save(); g.scale(1.045, 1.06); egg(); g.fillStyle = c.rim; g.fill(); g.restore();
  egg();
  const grad = g.createRadialGradient(-rx * 0.15, -ry * 0.55, ry * 0.1, 0, 0, rx * 1.15);
  grad.addColorStop(0, c.hi);
  grad.addColorStop(0.45, c.base);
  grad.addColorStop(1, c.lo);
  g.fillStyle = grad;
  g.fill();
  g.save();
  egg(); g.clip();
  if (cooked) {
    // grill marks
    g.strokeStyle = 'rgba(110, 50, 22, 0.55)'; g.lineWidth = 0.035 * s; g.lineCap = 'round';
    for (const k of [-0.32, 0.08, 0.48]) { g.beginPath(); g.moveTo(rx * (k - 0.22), -ry * 0.9); g.lineTo(rx * (k + 0.18), ry * 0.9); g.stroke(); }
  } else {
    // soft marbling
    g.strokeStyle = 'rgba(255, 214, 204, 0.75)'; g.lineWidth = 0.022 * s; g.lineCap = 'round';
    g.beginPath(); g.moveTo(-rx * 0.5, ry * 0.2); g.quadraticCurveTo(0, -ry * 0.1, rx * 0.55, ry * 0.32); g.stroke();
    g.beginPath(); g.moveTo(-rx * 0.1, ry * 0.62); g.quadraticCurveTo(rx * 0.3, ry * 0.42, rx * 0.7, ry * 0.58); g.stroke();
  }
  // glossy highlight
  g.fillStyle = c.spot;
  g.beginPath(); g.ellipse(-rx * 0.05, -ry * 0.58, rx * 0.34, ry * 0.16, 0.05, 0, TAU); g.fill();
  g.restore();
  g.restore();
}

// A copper ingot (trapezoid prism) in three-quarter view, with a lighter top and an embossed panel.
function ingot(g, s) {
  shadow(g, 0.52 * s, 0.76 * s, 0.42 * s, 0.09 * s);
  const P = (pts, fill) => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x * s, y * s) : g.moveTo(x * s, y * s))); g.closePath(); g.fillStyle = fill; g.fill(); };
  // bottom outline (rim) under everything
  g.save();
  g.lineJoin = 'round'; g.lineWidth = 0.035 * s; g.strokeStyle = '#a65530';
  g.beginPath();
  [[0.2, 0.42], [0.62, 0.3], [0.86, 0.43], [0.88, 0.6], [0.44, 0.76], [0.12, 0.6]].forEach(([x, y], i) => (i ? g.lineTo(x * s, y * s) : g.moveTo(x * s, y * s)));
  g.closePath(); g.stroke();
  g.restore();
  // left end (shadow side), front (main), top (lit)
  P([[0.2, 0.42], [0.42, 0.53], [0.44, 0.76], [0.12, 0.6]], '#c4683a');
  P([[0.42, 0.53], [0.86, 0.43], [0.88, 0.6], [0.44, 0.76]], '#e8894a');
  P([[0.2, 0.42], [0.62, 0.3], [0.86, 0.43], [0.42, 0.53]], '#f7ae72');
  // top panel + highlights
  P([[0.3, 0.42], [0.6, 0.345], [0.76, 0.43], [0.44, 0.505]], '#fbc28f');
  g.save();
  g.lineCap = 'round'; g.strokeStyle = 'rgba(255, 240, 220, 0.9)'; g.lineWidth = 0.022 * s;
  g.beginPath(); g.moveTo(0.25 * s, 0.415 * s); g.lineTo(0.58 * s, 0.325 * s); g.stroke();
  g.strokeStyle = 'rgba(255, 214, 170, 0.7)'; g.lineWidth = 0.018 * s;
  g.beginPath(); g.moveTo(0.47 * s, 0.6 * s); g.lineTo(0.8 * s, 0.52 * s); g.stroke();
  g.restore();
}

// A plank pair, a log, a stone, an ore lump: only used if items.js is missing entirely.
function disc(g, s, col) {
  const r = s * 0.3, cx = s / 2, cy = s / 2;
  shadow(g, cx, cy + r * 0.95, r * 0.95, r * 0.28);
  g.fillStyle = col;
  g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.fill();
  g.fillStyle = 'rgba(255, 255, 255, 0.35)';
  g.beginPath(); g.ellipse(cx - r * 0.3, cy - r * 0.35, r * 0.38, r * 0.24, -0.5, 0, TAU); g.fill();
}

export const DRAWN = {
  meat: (g, s) => drumstick(g, s, false),
  cookedMeat: (g, s) => drumstick(g, s, true),
  copperBar: (g, s) => ingot(g, s),
};

// Returns a canvas with the icon drawn (hand-drawn when we have one, else a soft disc in the item colour).
export function drawIcon(id, size, color) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  if (DRAWN[id]) DRAWN[id](g, size);
  else disc(g, size, color || '#c9b99c');
  return c;
}
