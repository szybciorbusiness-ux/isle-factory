// The robot's visor face: a small canvas drawn as a glowing mint screen with simple expressive pupils.
// player.js sets the expression every frame; the canvas is only redrawn (and re-uploaded) when the quantised
// expression actually changes, so an idle robot costs nothing.
//
// state: { lookX -1..1 (viewer's right), lookY -1..1 (up), open 0..1 (0 = blink), squint 0..1 (strike),
//          wide 0..1 (looking around), happy 0..1 (^ ^ arcs) }
import * as THREE from 'three';

const W = 256, H = 112;
export const FACE_ASPECT = W / H;

const SCREEN_IN = '#e4fff6', SCREEN_MID = '#9af5dc', SCREEN_OUT = '#4fd3bb';
const PUPIL = '#17585a', PUPIL_HI = '#c9fff0';

export function createFace() {
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;

  // background is static: draw it once into its own canvas
  const bg = document.createElement('canvas');
  bg.width = W; bg.height = H;
  {
    const b = bg.getContext('2d');
    const grd = b.createRadialGradient(W / 2, H * 0.42, 4, W / 2, H / 2, W * 0.62);
    grd.addColorStop(0, SCREEN_IN); grd.addColorStop(0.45, SCREEN_MID); grd.addColorStop(1, SCREEN_OUT);
    b.fillStyle = grd; b.fillRect(0, 0, W, H);
    // faint scanlines, and a soft sheen across the top
    b.fillStyle = 'rgba(40, 140, 130, 0.07)';
    for (let y = 2; y < H; y += 6) b.fillRect(0, y, W, 2);
    const sheen = b.createLinearGradient(0, 0, 0, H * 0.45);
    sheen.addColorStop(0, 'rgba(255,255,255,0.45)'); sheen.addColorStop(1, 'rgba(255,255,255,0)');
    b.fillStyle = sheen; b.fillRect(0, 0, W, H * 0.45);
  }

  const q = v => Math.round(v * 40) / 40;
  let lastKey = '';

  function roundRect(cx, cy, w, h, r, rot) {
    g.save();
    g.translate(cx, cy);
    g.rotate(rot);
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(-w / 2 + r, -h / 2);
    g.arcTo(w / 2, -h / 2, w / 2, h / 2, r);
    g.arcTo(w / 2, h / 2, -w / 2, h / 2, r);
    g.arcTo(-w / 2, h / 2, -w / 2, -h / 2, r);
    g.arcTo(-w / 2, -h / 2, w / 2, -h / 2, r);
    g.closePath();
    g.fill();
    g.restore();
  }

  function draw(s) {
    const key = [s.lookX, s.lookY, s.open, s.squint, s.wide, s.happy].map(q).join(',');
    if (key === lastKey) return;
    lastKey = key;
    g.drawImage(bg, 0, 0);
    const wide = s.wide, squint = s.squint * (1 - s.happy), happy = s.happy;
    const gap = W * (0.19 + 0.012 * wide);
    const cx = W / 2 + s.lookX * W * 0.12, cy = H / 2 - s.lookY * H * 0.16 + 2;
    for (const side of [-1, 1]) {
      const ex = cx + side * gap;
      const ew = W * (0.15 + 0.035 * wide - 0.01 * squint);
      const full = H * (0.6 + 0.1 * wide);
      const eh = Math.max(H * 0.07, full * s.open * (1 - 0.68 * squint));
      g.fillStyle = PUPIL;
      if (happy > 0.5) {
        // ^ ^ : thick upward arcs
        g.save();
        g.strokeStyle = PUPIL; g.lineWidth = H * 0.13; g.lineCap = 'round';
        g.beginPath();
        g.arc(ex, cy + H * 0.16, ew * 0.55, Math.PI * 1.15, Math.PI * 1.85);
        g.stroke();
        g.restore();
        continue;
      }
      // squint: flattened and tilted inward (a determined frown); blink: a short bar
      roundRect(ex, cy + (full - eh) * 0.12, ew, eh, Math.min(ew, eh) * 0.48, side * 0.32 * squint);
      if (s.open > 0.55 && squint < 0.4) {
        g.fillStyle = PUPIL_HI;
        const r = W * 0.018 * (1 + 0.4 * wide);
        g.beginPath();
        g.arc(ex - ew * 0.2, cy - eh * 0.22, r, 0, Math.PI * 2);
        g.fill();
      }
    }
    texture.needsUpdate = true;
  }

  draw({ lookX: 0, lookY: 0, open: 1, squint: 0, wide: 0, happy: 0 });
  return { texture, draw, canvas };
}
