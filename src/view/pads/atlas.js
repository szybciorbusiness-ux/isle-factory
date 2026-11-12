// One canvas atlas for everything printed on the floor plates (FIRST-20.md "Pads are floor plates", UI-STYLE.md
// sticker language): outlined numerals, item icons and the little name tags. Drawn once (digits + every pad's
// tag up front, icons when the HUD's rendered icons arrive), so a ticking number never redraws anything:
// ink.js lays numbers out per digit, blitting cells of this canvas onto the screen-space overlay.
//
// Digits come in two layers so neighbouring outlines never cut into a fill: 'b' (brown outline + 2 px-style lip)
// and 'f' (white fill). Every back layer of a number is drawn before its fronts. Colours follow the HUD's
// `.ol` numerals: white fill, 3 px brown outline, brown lip under the glyph.
//
// `texture` (premultiplied, sRGB, mipmapped) is kept for any WebGL consumer; the overlay reads `canvas`.
import * as THREE from 'three';

export const INK = '#5b3a21', INK2 = '#8a6644', CREAM = '#fff7e6', CREAM_LIP = '#e3c99a';
const FONT = "'Fredoka', 'Nunito', ui-rounded, system-ui, sans-serif";
const W = 2048, H = 1024, GAP = 8;

// Simple painted fallback icons (only used until the HUD hands us its rendered item icons).
function paintIcon(g, id, color, s) {
  g.save();
  g.scale(s / 64, s / 64);
  g.lineJoin = 'round'; g.lineCap = 'round';
  const stroke = (w = 4) => { g.lineWidth = w; g.strokeStyle = INK; g.stroke(); };
  g.translate(32, 34);
  switch (id) {
    case 'wood':
      g.rotate(-0.35);
      g.beginPath(); g.roundRect(-24, -11, 44, 22, 10); g.fillStyle = '#9a6136'; g.fill(); stroke();
      g.beginPath(); g.ellipse(20, 0, 7, 11, 0, 0, Math.PI * 2); g.fillStyle = '#ecc993'; g.fill(); stroke(3);
      break;
    case 'plank':
      g.rotate(-0.25);
      for (const [dy, col] of [[6, '#d9a66c'], [-5, '#f0c48b']]) { g.beginPath(); g.roundRect(-26, dy - 6, 52, 12, 4); g.fillStyle = col; g.fill(); stroke(3); }
      break;
    case 'stone':
      g.beginPath(); g.moveTo(-22, 8); g.lineTo(-14, -14); g.lineTo(6, -18); g.lineTo(22, -4); g.lineTo(18, 14); g.lineTo(-10, 18); g.closePath();
      g.fillStyle = '#e3d6b3'; g.fill(); stroke();
      break;
    case 'meat': case 'cookedMeat':
      g.rotate(0.5);
      g.beginPath(); g.ellipse(-4, 0, 17, 13, 0, 0, Math.PI * 2); g.fillStyle = id === 'meat' ? '#e98a7c' : '#b86a3a'; g.fill(); stroke();
      g.beginPath(); g.roundRect(10, -3.5, 14, 7, 3); g.fillStyle = '#fff4e2'; g.fill(); stroke(3);
      g.beginPath(); g.arc(25, -4, 4.5, 0, Math.PI * 2); g.arc(25, 4, 4.5, 0, Math.PI * 2); g.fillStyle = '#fff4e2'; g.fill();
      break;
    case 'copperBar': case 'copperPlate':
      g.beginPath(); g.moveTo(-24, 10); g.lineTo(-16, -8); g.lineTo(18, -8); g.lineTo(24, 10); g.closePath(); g.fillStyle = '#e8894a'; g.fill(); stroke();
      g.beginPath(); g.moveTo(-14, -8); g.lineTo(16, -8); g.lineTo(12, -1); g.lineTo(-10, -1); g.closePath(); g.fillStyle = '#ffb37a'; g.fill();
      break;
    default:
      g.beginPath(); g.arc(0, 0, 18, 0, Math.PI * 2); g.fillStyle = color || '#ddd'; g.fill(); stroke();
  }
  g.restore();
}

export function createAtlas({ renderer, config, iconUrl }) {
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.premultiplyAlpha = true;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() || 1);
  texture.name = 'padAtlas';

  // ---- shelf packer ----
  let sx = 0, sy = 0, sh = 0;
  function alloc(w, h) {
    w = Math.ceil(w); h = Math.ceil(h);
    if (sx + w + GAP * 2 > W) { sy += sh; sx = 0; sh = 0; }
    if (sy + h + GAP * 2 > H) { console.warn('[pads] atlas full'); sy = 0; }
    const r = { x: sx + GAP, y: sy + GAP, w, h };
    sx += w + GAP * 2; sh = Math.max(sh, h + GAP * 2);
    return r;
  }
  const uv = r => [r.x / W, 1 - r.y / H, (r.x + r.w) / W, 1 - (r.y + r.h) / H]; // u0, vTop, u1, vBot
  let dirty = true;

  // ---------------- digits ----------------
  const DH = 84;                              // digit ink height in atlas px
  const O = Math.round(DH * 0.13);            // outline (the HUD's 3 px at ~24 px numerals)
  const LIP = Math.round(DH * 0.085);         // lip drop under the glyph
  const DIGITS = '0123456789';
  const glyphs = new Map();                   // ch -> { b, f, adv, w, h, ox, oy } (px); b/f: uv quads
  let fontPx = 120;
  function measureFont() {
    g.font = `700 100px ${FONT}`;
    g.textBaseline = 'alphabetic'; g.textAlign = 'left'; // the tags leave 'middle' set: ascent is baseline-relative
    const m = g.measureText('0');
    const asc = m.actualBoundingBoxAscent || 72;
    fontPx = Math.round(100 * DH / Math.max(40, asc));
  }
  const cellW = Math.ceil(DH * 0.95 + O * 2 + 6), cellH = Math.ceil(DH + O * 2 + LIP + 6);
  const cells = {};
  for (const ch of DIGITS + '✓') cells[ch] = { b: alloc(cellW, cellH), f: alloc(cellW, cellH) };
  function drawDigits() {
    measureFont();
    for (const ch of DIGITS + '✓') {
      const { b, f } = cells[ch];
      g.clearRect(b.x - 2, b.y - 2, b.w + 4, b.h + 4);
      g.clearRect(f.x - 2, f.y - 2, f.w + 4, f.h + 4);
      let adv;
      const baseY = O + 3 + DH; // baseline inside the cell
      if (ch === '✓') {
        adv = DH * 0.86;
        const path = (x0, y0) => { g.beginPath(); g.moveTo(x0 + adv * 0.1, y0 - DH * 0.46); g.lineTo(x0 + adv * 0.4, y0 - DH * 0.14); g.lineTo(x0 + adv * 0.92, y0 - DH * 0.86); };
        g.lineCap = 'round'; g.lineJoin = 'round';
        g.strokeStyle = INK; g.lineWidth = DH * 0.2 + O * 2;
        path(b.x + O + 3, b.y + baseY + LIP); g.stroke();
        path(b.x + O + 3, b.y + baseY); g.stroke();
        g.strokeStyle = '#ffffff'; g.lineWidth = DH * 0.2;
        path(f.x + O + 3, f.y + baseY); g.stroke();
      } else {
        g.font = `700 ${fontPx}px ${FONT}`;
        g.textBaseline = 'alphabetic'; g.textAlign = 'left';
        const m = g.measureText(ch);
        adv = Math.min(cellW - O * 2 - 6, m.width);
        // centre the glyph's ink on its advance (Fredoka's side bearings differ per digit)
        const inkL = -(m.actualBoundingBoxLeft || 0), inkR = m.actualBoundingBoxRight || m.width;
        const inkW = inkR - inkL;
        adv = Math.max(adv, inkW);
        const x0 = O + 3 + (adv - inkW) / 2 - inkL;
        g.lineJoin = 'round'; g.miterLimit = 2;
        g.lineWidth = O * 2; g.strokeStyle = INK; g.fillStyle = INK;
        g.strokeText(ch, b.x + x0, b.y + baseY + LIP); g.fillText(ch, b.x + x0, b.y + baseY + LIP);
        g.strokeText(ch, b.x + x0, b.y + baseY);
        const grd = g.createLinearGradient(0, f.y + baseY - DH, 0, f.y + baseY);
        grd.addColorStop(0, '#ffffff'); grd.addColorStop(0.62, '#ffffff'); grd.addColorStop(1, '#fff0cf');
        g.fillStyle = grd;
        g.fillText(ch, f.x + x0, f.y + baseY);
      }
      // cell geometry: the drawn area is [0, adv + 2O + 6] x [0, cellH]; ink box starts at (O + 3, 3)
      const w = Math.min(cellW, adv + O * 2 + 6);
      glyphs.set(ch, {
        adv, w, h: cellH, ox: O + 3, oy: O + 3,
        b: uv({ x: b.x, y: b.y, w, h: cellH }), f: uv({ x: f.x, y: f.y, w, h: cellH }),
      });
    }
    dirty = true;
  }

  // ---------------- icons ----------------
  const IC = 128;
  const icons = new Map(); // id -> { r, uv, src, loading }
  function iconCell(id) {
    let e = icons.get(id);
    if (e) return e;
    const r = alloc(IC, IC);
    e = { r, uv: uv(r), src: null, img: null };
    icons.set(id, e);
    drawFallbackIcon(e, id);
    refreshIcon(id);
    return e;
  }
  function withShadow(fn) {
    g.save();
    g.shadowColor = 'rgba(60, 40, 20, 0.38)'; g.shadowBlur = 6; g.shadowOffsetY = 5;
    fn();
    g.restore();
  }
  function drawFallbackIcon(e, id) {
    const { r } = e;
    g.clearRect(r.x - 2, r.y - 2, r.w + 4, r.h + 4);
    withShadow(() => { g.save(); g.translate(r.x + 10, r.y + 6); paintIcon(g, id, config.ITEMS?.[id]?.color, IC - 20); g.restore(); });
    dirty = true;
  }
  function refreshIcon(id) {
    const e = icons.get(id);
    if (!e) return;
    let url = null;
    try { url = iconUrl?.(id) || null; } catch { url = null; }
    if (!url || url === e.src) return;
    e.src = url;
    const img = new Image();
    img.onload = () => {
      if (e.src !== url) return;
      const { r } = e;
      g.clearRect(r.x - 2, r.y - 2, r.w + 4, r.h + 4);
      withShadow(() => g.drawImage(img, r.x + 4, r.y + 2, IC - 8, IC - 8));
      dirty = true;
    };
    img.src = url;
  }

  // ---------------- name tags (sticker pills) ----------------
  const TH = 66;                  // pill height px
  const TF = 38;                  // font px
  const TO = 5;                   // outline px (the HUD's 3 px on a ~38 px pill)
  const tags = new Map();         // text -> { r, uv, w, h }
  function tagWidth(text) {
    g.font = `600 ${TF}px ${FONT}`;
    return Math.ceil(g.measureText(text).width + TH * 0.78 + TO * 2);
  }
  function drawTag(e, text) {
    const { r } = e;
    const w = e.w;
    g.clearRect(r.x - 2, r.y - 2, r.w + 4, r.h + 4);
    const x = r.x + TO / 2 + 1, y = r.y + TO / 2 + 1, pw = w - TO - 2, ph = TH - TO - 2, rad = ph / 2;
    // body + bottom lip (inset), then the 3 px-style brown outline
    g.save();
    g.beginPath(); g.roundRect(x, y, pw, ph, rad); g.clip();
    g.fillStyle = CREAM; g.fillRect(x, y, pw, ph);
    g.fillStyle = CREAM_LIP; g.fillRect(x, y + ph - ph * 0.17, pw, ph);
    g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillRect(x, y, pw, ph * 0.07);
    g.restore();
    g.beginPath(); g.roundRect(x, y, pw, ph, rad);
    g.lineWidth = TO; g.strokeStyle = INK; g.stroke();
    g.font = `600 ${TF}px ${FONT}`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = INK;
    g.fillText(text, x + pw / 2, y + ph * 0.45);
    dirty = true;
  }
  function tag(text) {
    let e = tags.get(text);
    if (e) return e;
    const w = tagWidth(text);
    const r = alloc(w + 24, TH); // a little slack for the web font's wider metrics
    e = { r, w, h: TH, uv: null };
    e.uv = uv({ x: r.x, y: r.y, w, h: TH });
    tags.set(text, e);
    drawTag(e, text);
    return e;
  }
  function redrawTags() {
    for (const [text, e] of tags) {
      const w = tagWidth(text);
      if (w > e.r.w) { const r = alloc(w + 24, TH); e.r = r; }
      e.w = w;
      e.uv = uv({ x: e.r.x, y: e.r.y, w, h: TH });
      drawTag(e, text);
    }
  }

  let version = 0;
  drawDigits();
  // the web font may still be loading: redraw once it's in (metrics change, so glyph data is rebuilt)
  let fontsReady = false;
  try {
    Promise.all([document.fonts?.load?.(`700 ${fontPx}px Fredoka`), document.fonts?.load?.(`600 ${TF}px Fredoka`)])
      .then(() => { fontsReady = true; drawDigits(); redrawTags(); version++; })
      .catch(() => {});
  } catch { /* no font loading API */ }

  return {
    texture, canvas,
    DH, O, LIP, TH,
    glyph: ch => glyphs.get(ch) || glyphs.get('0'),
    icon: id => iconCell(id),
    tag,
    refreshIcons(ids) { for (const id of ids || icons.keys()) refreshIcon(id); },
    get version() { return version; },
    get fontsReady() { return fontsReady; },
    get debug() { return { fontPx, cellW, cellH, O, LIP, glyph0: glyphs.get("0") }; },
    // upload at most once per frame, only when something was drawn
    commit() { if (dirty) { dirty = false; texture.needsUpdate = true; } },
    dispose() { texture.dispose(); },
  };
}
