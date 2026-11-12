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

export const DECAL_W = 256, DECAL_H = 96;

const EYE = '#24100f', BROW = '#2c1214', LID = '#3a1819', HI = '#fff3dc', WHISKER = '#f6e6c4';

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
  const EX = 0.06, EY = 0.004, RX = 0.0145, RY = 0.0165;

  function whiskers() {
    g.strokeStyle = WHISKER; g.lineCap = 'round'; g.lineWidth = 0.0052;
    for (const s of [-1, 1]) {
      g.beginPath(); g.moveTo(s * 0.083, -0.03); g.quadraticCurveTo(s * 0.12, -0.024, s * 0.158, -0.018); g.stroke();
      g.beginPath(); g.moveTo(s * 0.081, -0.045); g.quadraticCurveTo(s * 0.118, -0.048, s * 0.154, -0.055); g.stroke();
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
    whiskers();

    const happy = st.happy, squint = st.squint * (1 - happy), wide = st.wide * (1 - happy);
    const lx = st.lookX * 0.0075, ly = st.lookY * 0.005;
    for (const s of [-1, 1]) {
      const ex = s * (EX + 0.002 * wide) + lx, ey = EY + ly - 0.003 * squint;
      // brows: thick, dark, sloping down toward the snout (stern); squint pulls them lower, wide / happy lift them
      const lift = 0.013 * wide + 0.009 * happy - 0.006 * squint;
      const innerDrop = 0.004 * squint - 0.01 * wide - 0.012 * happy;
      const ix = s * 0.03, ox = s * 0.104;
      const iy = EY + 0.024 + lift - innerDrop, oy = EY + 0.046 + lift + 0.004 * squint;
      const ti = 0.017, to = 0.011;
      g.fillStyle = BROW; g.strokeStyle = BROW; g.lineWidth = 0.004;
      g.beginPath();
      g.moveTo(ix, iy + ti * 0.5);
      g.quadraticCurveTo((ix + ox) / 2, (iy + oy) / 2 + 0.008 + ti * 0.3, ox, oy + to * 0.5);
      g.lineTo(ox + s * 0.004, oy - to * 0.5);
      g.quadraticCurveTo((ix + ox) / 2, (iy + oy) / 2 - 0.002, ix, iy - ti * 0.5);
      g.closePath();
      g.fill(); g.stroke();

      if (happy > 0.5) {
        // ^ ^ : closed, upward arcs
        g.strokeStyle = EYE; g.lineWidth = 0.0085; g.lineCap = 'round';
        g.beginPath(); g.arc(ex, ey - 0.012, 0.014, 0.18 * Math.PI, 0.82 * Math.PI); g.stroke();
        continue;
      }
      const rx = RX * (1 + 0.18 * wide), ry = RY * (1 + 0.22 * wide);
      // the upper lid is a slanted line (inner corner lower): everything above it is fur
      const k = (0.42 + 0.4 * squint - 0.32 * wide) * s;      // rise toward the outer corner
      const open = st.open;
      const h0 = ry * (0.38 - 0.62 * squint + 0.5 * wide) - (1 - open) * (ry * 2.1);
      const lid = x => ey + h0 + k * (x - ex);
      if (open < 0.3 || h0 < -ry * 0.92) {
        // closed: a short dark line where the lid meets the lower lid
        g.strokeStyle = EYE; g.lineWidth = 0.0055; g.lineCap = 'round';
        g.beginPath(); g.moveTo(ex - rx, ey - 0.004 - k * rx * 0.4); g.lineTo(ex + rx, ey - 0.004 + k * rx * 0.4); g.stroke();
        continue;
      }
      g.save();
      g.beginPath();
      g.moveTo(ex - 0.04, lid(ex - 0.04)); g.lineTo(ex + 0.04, lid(ex + 0.04)); g.lineTo(ex + 0.04, ey - 0.05); g.lineTo(ex - 0.04, ey - 0.05);
      g.closePath();
      g.clip();
      g.fillStyle = EYE;
      g.beginPath(); g.ellipse(ex, ey, rx, ry, 0, 0, Math.PI * 2); g.fill();
      if (open > 0.6 && squint < 0.5) {
        g.fillStyle = HI;
        g.beginPath(); g.arc(ex - 0.0045 + lx * 0.3, ey + 0.0015, 0.0042 * (1 + 0.3 * wide), 0, Math.PI * 2); g.fill();
      }
      g.restore();
      // lid edge: a heavier dark line along the lid across the eye
      g.strokeStyle = LID; g.lineWidth = 0.0048; g.lineCap = 'round';
      const x0 = ex - rx * 1.08, x1 = ex + rx * 1.08;
      g.beginPath(); g.moveTo(x0, lid(x0)); g.lineTo(x1, lid(x1)); g.stroke();
    }
    texture.needsUpdate = true;
  }

  draw({ lookX: 0, lookY: 0, open: 1, squint: 0, wide: 0, happy: 0 });
  return { texture, draw, canvas };
}
