// Dug's face: small stern eyes under heavy angled brows, plus cream whiskers, drawn into a transparent canvas
// that dug.js wraps on the front of the head as a decal (the snout is real geometry on top of it). Same API as
// face.js: player.js calls draw(state) every frame and the canvas is only redrawn (and re-uploaded) when the
// quantised expression actually changes, so an idle mole costs nothing.
//
// state: { lookX -1..1 (viewer's right), lookY -1..1 (up), open 0..1 (0 = blink), squint 0..1 (strike),
//          wide 0..1 (looking around), happy 0..1 (^ ^ arcs) }
//
// Drawing happens in head-surface units: x = arc length toward the viewer's right, y = height above the
// decal centre (both in model units), so circles stay round on the head.
import * as THREE from 'three';

export const DECAL_W = 384, DECAL_H = 176;

const EYE = '#1c0c0b', BROW = '#241011', LID = '#2e1314', HI = '#fff6e4', WHISKER = '#f6e6c4', MASK = 'rgba(146,78,70,0.9)';

// arcW / arcH: the decal's size on the head (model units): the canvas is stretched over it.
export function createDugFace({ arcW = 0.34, arcH = 0.13 } = {}) {
  const W = DECAL_W, H = DECAL_H;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const sx = W / arcW, sy = H / arcH;

  const q = v => Math.round(v * 40) / 40;
  let lastKey = '';

  // eye layout (head-surface units, relative to the decal centre)
  // (big: from the high game camera the eyes and brows are the whole expression)
  const EX = 0.074, EY = 0.004, RX = 0.027, RY = 0.03;

  function whiskers() {
    g.strokeStyle = WHISKER; g.lineCap = 'round'; g.lineWidth = 0.0062;
    for (const s of [-1, 1]) {
      g.beginPath(); g.moveTo(s * 0.092, -0.04); g.quadraticCurveTo(s * 0.13, -0.034, s * 0.17, -0.028); g.stroke();
      g.beginPath(); g.moveTo(s * 0.09, -0.056); g.quadraticCurveTo(s * 0.128, -0.059, s * 0.166, -0.067); g.stroke();
    }
  }
  // a soft, slightly lighter plum band behind the eyes and brows, so the dark features separate from the fur
  function mask() {
    for (const s of [-1, 1]) {
      g.save();
      g.translate(s * EX, EY + 0.012);
      g.scale(1, 0.78);
      const r = 0.058;
      const grd = g.createRadialGradient(0, 0, r * 0.25, 0, 0, r);
      grd.addColorStop(0, MASK); grd.addColorStop(0.6, MASK); grd.addColorStop(1, 'rgba(140,72,64,0)');
      g.fillStyle = grd;
      g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
      g.restore();
    }
  }

  function draw(st) {
    const key = [st.lookX, st.lookY, st.open, st.squint, st.wide, st.happy].map(q).join(',');
    if (key === lastKey) return;
    lastKey = key;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    g.setTransform(sx, 0, 0, -sy, W / 2, H / 2); // y up, x = viewer's right, units = model units
    g.lineJoin = 'round';
    mask();
    whiskers();

    const happy = st.happy, squint = st.squint * (1 - happy), wide = st.wide * (1 - happy);
    const lx = st.lookX * 0.011, ly = st.lookY * 0.007;
    for (const s of [-1, 1]) {
      const ex = s * (EX + 0.003 * wide) + lx, ey = EY + ly - 0.004 * squint;
      // brows: thick, dark, sloping down toward the snout (stern); squint pulls them lower, wide / happy lift them
      const lift = 0.018 * wide + 0.013 * happy - 0.008 * squint;
      const innerDrop = 0.006 * squint - 0.014 * wide - 0.017 * happy;
      const ix = s * 0.026, ox = s * 0.112;
      const iy = EY + 0.03 + lift - innerDrop, oy = EY + 0.06 + lift + 0.005 * squint;
      const ti = 0.027, to = 0.017;
      g.fillStyle = BROW; g.strokeStyle = BROW; g.lineWidth = 0.005;
      g.beginPath();
      g.moveTo(ix, iy + ti * 0.5);
      g.quadraticCurveTo((ix + ox) / 2, (iy + oy) / 2 + 0.011 + ti * 0.3, ox, oy + to * 0.5);
      g.lineTo(ox + s * 0.005, oy - to * 0.5);
      g.quadraticCurveTo((ix + ox) / 2, (iy + oy) / 2 - 0.003, ix, iy - ti * 0.5);
      g.closePath();
      g.fill(); g.stroke();

      if (happy > 0.5) {
        // ^ ^ : closed, upward arcs
        g.strokeStyle = EYE; g.lineWidth = 0.012; g.lineCap = 'round';
        g.beginPath(); g.arc(ex, ey - 0.017, 0.021, 0.18 * Math.PI, 0.82 * Math.PI); g.stroke();
        continue;
      }
      const rx = RX * (1 + 0.18 * wide), ry = RY * (1 + 0.22 * wide);
      // the upper lid is a slanted line (inner corner lower): everything above it is fur
      const k = (0.4 + 0.4 * squint - 0.32 * wide) * s;      // rise toward the outer corner
      const open = st.open;
      const h0 = ry * (0.48 - 0.7 * squint + 0.45 * wide) - (1 - open) * (ry * 2.1);
      const lid = x => ey + h0 + k * (x - ex);
      if (open < 0.3 || h0 < -ry * 0.92) {
        // closed: a short dark line where the lid meets the lower lid
        g.strokeStyle = EYE; g.lineWidth = 0.008; g.lineCap = 'round';
        g.beginPath(); g.moveTo(ex - rx, ey - 0.006 - k * rx * 0.4); g.lineTo(ex + rx, ey - 0.006 + k * rx * 0.4); g.stroke();
        continue;
      }
      g.save();
      g.beginPath();
      g.moveTo(ex - 0.06, lid(ex - 0.06)); g.lineTo(ex + 0.06, lid(ex + 0.06)); g.lineTo(ex + 0.06, ey - 0.07); g.lineTo(ex - 0.06, ey - 0.07);
      g.closePath();
      g.clip();
      g.fillStyle = EYE;
      g.beginPath(); g.ellipse(ex, ey, rx, ry, 0, 0, Math.PI * 2); g.fill();
      if (open > 0.6 && squint < 0.5) {
        g.fillStyle = HI;
        g.beginPath(); g.arc(ex - 0.008 + lx * 0.3, ey + 0.003, 0.0085 * (1 + 0.3 * wide), 0, Math.PI * 2); g.fill();
      }
      g.restore();
      // lid edge: a heavier dark line along the lid across the eye
      g.strokeStyle = LID; g.lineWidth = 0.0072; g.lineCap = 'round';
      const x0 = ex - rx * 1.1, x1 = ex + rx * 1.1;
      g.beginPath(); g.moveTo(x0, lid(x0)); g.lineTo(x1, lid(x1)); g.stroke();
    }
    texture.needsUpdate = true;
  }

  draw({ lookX: 0, lookY: 0, open: 1, squint: 0, wide: 0, happy: 0 });
  return { texture, draw, canvas };
}
