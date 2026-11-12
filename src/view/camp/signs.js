// Station signs (FIRST-20.md "Stations explain themselves"): a little wooden signboard on a post at the back of
// each converting station showing input icon -> output icon (one icon for the quarry and the copper drill), plus
// the small red "Full" tag that gets planted on top of a full pickup pile.
//
// Cheap by construction: every face is painted once into ONE canvas atlas (crisp, mipmapped, anisotropic), and
// all signs share ONE material. Boards are instanced per shape (wide / square / tag) with a per-instance atlas
// rectangle; the wooden body samples a white texel and keeps its vertex colours. Posts are one more instanced
// mesh. So all signs in the camp cost at most 4 draw calls (wide, square, posts, tags only while a pile is full).
//
// Icons come from views.ui.iconUrl(id) (rendered from the real 3D items) and are repainted on 'ui:icons'.
// createSigns(ctx, parent, { castShadow }) -> { has(stationId), shapeFor(stationId), begin(dt),
//   board(shape, region, matrix), post(matrix), end(), material, atlas, canvas, meshes, dispose() }
// Boards pivot at their centre (the post top); the tag pivots at the foot of its stake. Posts are unit height.
import * as THREE from 'three';
import { Parts, rbox, C } from './geo.js';

export const SIGN = {
  wide: { w: 1.3, h: 0.64, d: 0.06 },
  square: { w: 0.7, h: 0.64, d: 0.06 },
  tag: { w: 0.46, h: 0.25, d: 0.04, stick: 0.2 },
  tilt: 0.72,          // radians the board leans back toward the high camera (58 deg pitch) so it reads face-on
};

// atlas layout in canvas px (x, y, w, h), 1024 x 1024
const AW = 1024, AH = 1024;
const REG = {
  sawmill: [0, 0, 512, 252], cookfire: [512, 0, 512, 252], smelter: [0, 256, 512, 252],
  quarry: [512, 256, 252, 252], copperDrill: [768, 256, 252, 252], full: [0, 512, 256, 138],
};
const WHITE = [1000, 1000, 16, 16];
// what each station sign shows: inputs (with counts) -> output
const CONTENT = {
  sawmill: { in: [['wood', 1]], out: 'plank' },
  cookfire: { in: [['meat', 1]], out: 'cookedMeat' },
  smelter: { in: [['copperOre', 2]], out: 'copperBar' },
  quarry: { out: 'stone' },
  copperDrill: { out: 'copperOre' },
};

const INK = '#5b3a21';
const FONT = '"Fredoka", "Baloo 2", "Nunito", system-ui, sans-serif';

// ---------- geometry ----------
// Board: origin at its centre (where it is bolted to the post top), leaning back by SIGN.tilt. The wooden body
// (uv.y = NO_TRACK from Parts -> white texel) wraps a face quad (uv 0..1 -> the instance's atlas rectangle).
function boardGeometry(shape) {
  const S = SIGN[shape];
  const p = new Parts({ ao: false });
  const r = [-SIGN.tilt, 0, 0];
  const lean = v => new THREE.Vector3(...v).applyEuler(new THREE.Euler(...r));
  // body: a chunky plank board with a darker back
  p.add(rbox(S.w, S.h, S.d, Math.min(0.05, S.h * 0.18), 2), C.woodDark, { r, flat: false, faceColor: (cx, cy, cz, nx, ny, nz) => (nz > 0.5 || ny > 0.5 ? C.wood : null) });
  // face: inset quad just in front of the body
  const inset = shape === 'tag' ? 0.022 : 0.036;
  const face = new THREE.PlaneGeometry(S.w - inset * 2, S.h - inset * 2);
  const fz = lean([0, 0, S.d / 2 + 0.003]);
  p.add(face, '#ffffff', { r, p: [fz.x, fz.y, fz.z], keepUv: true, ao: false });
  if (shape === 'tag') {
    // a short stake under the tag (pivot at the stake's foot): shift everything up
    const g = p.merge();
    const lift = S.stick + S.h * 0.5 * Math.cos(SIGN.tilt) - 0.02;
    g.translate(0, lift, 0);
    const q = new Parts({ ao: false });
    q.addGeometry(g);
    q.add(new THREE.CylinderGeometry(0.018, 0.022, S.stick + 0.04, 6), C.woodDark, { p: [0, (S.stick + 0.04) / 2 - 0.02, -0.02], flat: true });
    return q.merge();
  }
  return p.merge();
}
// Post: unit height (scaled per instance), faceted dark wood.
function postGeometry() {
  const p = new Parts({ ao: { y0: 0, y1: 0.4, min: 0.82 } });
  p.add(new THREE.CylinderGeometry(0.042, 0.05, 1, 7), C.woodDark, { p: [0, 0.5, 0], flat: true, jitter: 0.04, seed: 5 });
  return p.merge();
}

// ---------- material ----------
function signMaterial(atlas) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, map: atlas });
  const wu = (WHITE[0] + WHITE[2] / 2) / AW, wv = 1 - (WHITE[1] + WHITE[3] / 2) / AH;
  m.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 signUv;\nvarying float vSignFace;')
      .replace('#include <uv_vertex>', `#include <uv_vertex>
	vSignFace = 1.0 - step( 1.5, uv.y );
	#ifdef USE_MAP
	vMapUv = mix( vec2( ${wu.toFixed(5)}, ${wv.toFixed(5)} ), signUv.xy + uv * signUv.zw, vSignFace );
	#endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vSignFace;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += diffuseColor.rgb * 0.14 * vSignFace;');
  };
  m.customProgramCacheKey = () => 'isle-camp-signs-v2';
  return m;
}

// ---------- atlas painting ----------
function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function outlinedText(g, text, x, y, size, fill = '#ffffff', stroke = INK) {
  g.font = `700 ${size}px ${FONT}`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.fillStyle = stroke; g.fillText(text, x, y + size * 0.09);      // lip under the glyphs
  g.lineWidth = size * 0.2; g.strokeStyle = stroke; g.strokeText(text, x, y);
  g.fillStyle = fill; g.fillText(text, x, y);
}
// The face: a band of the board's own wood around a cream sticker panel (UI-STYLE: cream fill, warm-brown ink
// outline, top highlight, darker lip), so light items like planks still pop against it.
function panel(g, [x, y, w, h], seed) {
  g.fillStyle = '#d39556'; g.fillRect(x, y, w, h);
  // faint grain on the wooden band
  g.save();
  g.beginPath(); g.rect(x, y, w, h); g.clip();
  g.strokeStyle = 'rgba(150, 92, 44, 0.28)'; g.lineWidth = 2;
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 7; i++) {
    const yy = y + 4 + rnd() * (h - 8), x0 = x + rnd() * w * 0.6, len = w * (0.2 + rnd() * 0.35);
    g.beginPath(); g.moveTo(x0, yy); g.bezierCurveTo(x0 + len * 0.3, yy - 2, x0 + len * 0.6, yy + 2, x0 + len, yy); g.stroke();
  }
  g.restore();
  const m = 13, r = 26;
  // lip, cream panel, ink outline, top highlight
  g.fillStyle = '#e3c99a'; rr(g, x + m, y + m, w - m * 2, h - m * 2, r); g.fill();
  const grd = g.createLinearGradient(0, y + m, 0, y + h - m);
  grd.addColorStop(0, '#fffaf0'); grd.addColorStop(1, '#fbecd0');
  g.fillStyle = grd; rr(g, x + m, y + m, w - m * 2, h - m * 2 - 9, r); g.fill();
  g.lineWidth = 6; g.strokeStyle = INK; rr(g, x + m, y + m, w - m * 2, h - m * 2, r); g.stroke();
  g.lineWidth = 3.5; g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineCap = 'round';
  g.beginPath(); g.moveTo(x + m + r, y + m + 8); g.lineTo(x + w - m - r, y + m + 8); g.stroke();
}
// chunky sticker arrow pointing right, centred at (cx, cy)
function arrow(g, cx, cy, s) {
  const pts = [[-0.5, -0.2], [0.05, -0.2], [0.05, -0.45], [0.55, 0], [0.05, 0.45], [0.05, 0.2], [-0.5, 0.2]];
  const path = dy => { g.beginPath(); pts.forEach(([px, py], i) => (i ? g.lineTo : g.moveTo).call(g, cx + px * s, cy + py * s + dy)); g.closePath(); };
  g.lineJoin = 'round';
  path(s * 0.09); g.fillStyle = INK; g.fill(); g.lineWidth = s * 0.16; g.strokeStyle = INK; g.stroke();   // lip
  path(0); g.lineWidth = s * 0.16; g.strokeStyle = INK; g.stroke();
  g.fillStyle = '#ff9a2e'; g.fill();
  // highlight on the shaft
  g.fillStyle = 'rgba(255, 236, 200, 0.85)';
  g.beginPath(); g.moveTo(cx - 0.42 * s, cy - 0.13 * s); g.lineTo(cx + 0.02 * s, cy - 0.13 * s); g.lineTo(cx + 0.02 * s, cy - 0.06 * s); g.lineTo(cx - 0.42 * s, cy - 0.06 * s); g.closePath(); g.fill();
}
// opaque bounds of an icon image (alpha > 60, so the faint contact shadow doesn't count): [x, y, w, h]
let probe = null;
function opaqueBox(img) {
  const W = img.naturalWidth || img.width || 128, H = img.naturalHeight || img.height || 128;
  try {
    probe ||= document.createElement('canvas');
    probe.width = W; probe.height = H;
    const pg = probe.getContext('2d', { willReadFrequently: true });
    pg.clearRect(0, 0, W, H); pg.drawImage(img, 0, 0);
    const d = pg.getImageData(0, 0, W, H).data;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let yy = 0; yy < H; yy++) {
      for (let xx = 0; xx < W; xx++) {
        if (d[(yy * W + xx) * 4 + 3] > 60) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy; }
      }
    }
    if (x1 < 0) return [0, 0, W, H];
    return [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
  } catch { return [0, 0, W, H]; }
}
// fallback icon until the real one loads: a soft disc in the item colour
function discIcon(g, cx, cy, size, color) {
  g.fillStyle = 'rgba(110, 76, 30, 0.22)';
  g.beginPath(); g.ellipse(cx, cy + size * 0.36, size * 0.34, size * 0.1, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = color || '#ccc'; g.strokeStyle = INK; g.lineWidth = size * 0.05;
  g.beginPath(); g.arc(cx, cy, size * 0.3, 0, Math.PI * 2); g.fill(); g.stroke();
}

export function createSigns(ctx, parent, { castShadow = true } = {}) {
  const { config, events } = ctx;
  const canvas = document.createElement('canvas');
  canvas.width = AW; canvas.height = AH;
  const g = canvas.getContext('2d');
  const atlas = new THREE.CanvasTexture(canvas);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = Math.min(8, ctx.renderer?.capabilities?.getMaxAnisotropy?.() || 1);
  atlas.generateMipmaps = true;
  atlas.minFilter = THREE.LinearMipmapLinearFilter;
  const material = signMaterial(atlas);

  // ---- icons (from the HUD's 3D item renders) ----
  const icons = new Map();   // id -> { img, url, ok }
  function iconFor(id) {
    let rec = icons.get(id);
    let url = null;
    try { url = ctx.views.ui?.iconUrl?.(id) || null; } catch { url = null; }
    if (rec && rec.url === url) return rec.ok ? rec.img : null;
    if (!url) return null;
    rec = { url, img: new Image(), ok: false, box: null };
    icons.set(id, rec);
    rec.img.onload = () => { rec.box = opaqueBox(rec.img); rec.ok = true; dirty = true; };
    rec.img.onerror = () => { rec.ok = false; };
    rec.img.src = url;
    return null;
  }
  // fit the icon's opaque part into a size x size box centred at (cx, cy), with a soft warm shadow under it
  function drawIcon(id, cx, cy, size) {
    const img = iconFor(id);
    const rec = icons.get(id);
    if (img && rec?.box) {
      const [bx, by, bw, bh] = rec.box;
      const k = size / Math.max(bw, bh * 1.1);
      const dw = bw * k, dh = bh * k;
      g.fillStyle = 'rgba(120, 80, 36, 0.2)';
      g.beginPath(); g.ellipse(cx, cy + dh * 0.44, dw * 0.42, Math.max(5, dh * 0.1), 0, 0, Math.PI * 2); g.fill();
      g.drawImage(img, bx, by, bw, bh, cx - dw / 2, cy - dh / 2, dw, dh);
    } else discIcon(g, cx, cy, size * 0.9, config.ITEMS?.[id]?.color);
  }

  // ---- painting ----
  let dirty = true;
  function paint() {
    g.clearRect(0, 0, AW, AH);
    g.fillStyle = '#ffffff'; g.fillRect(...WHITE);
    let seed = 1;
    for (const [id, c] of Object.entries(CONTENT)) {
      const R = REG[id];
      const [x, y, w, h] = R;
      panel(g, R, seed++);
      const cy = y + h / 2 + 2;
      if (c.in) {
        const sz = h * 0.66;
        const [inId, n] = c.in[0];
        drawIcon(inId, x + w * 0.25, cy - 3, sz);
        if (n > 1) outlinedText(g, `${n}`, x + w * 0.25 + sz * 0.42, cy + sz * 0.24, 84);
        arrow(g, x + w * 0.5, cy, 70);
        drawIcon(c.out, x + w * 0.75, cy - 3, sz);
      } else {
        drawIcon(c.out, x + w / 2, cy - 3, h * 0.64);
      }
    }
    // the "Full" tag: a red sticker with outlined white text
    {
      const [x, y, w, h] = REG.full;
      g.fillStyle = INK; rr(g, x + 2, y + 2, w - 4, h - 4, 30); g.fill();
      g.fillStyle = '#c94236'; rr(g, x + 9, y + 9, w - 18, h - 18, 24); g.fill();
      g.fillStyle = '#ff6b5e'; rr(g, x + 9, y + 9, w - 18, h - 26, 24); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.35)'; rr(g, x + 22, y + 16, w - 44, 10, 5); g.fill();
      outlinedText(g, 'Full', x + w / 2, y + h / 2 - 6, 78);
    }
    atlas.needsUpdate = true;
    dirty = false;
  }
  // repaint once the font and the icons are ready (and whenever the HUD re-renders icons)
  try { document.fonts?.load?.(`700 64px ${FONT}`).then(() => { dirty = true; }, () => {}); } catch { /* optional */ }
  const offIcons = events?.on?.('ui:icons', () => { dirty = true; });

  // ---- meshes ----
  const CAP = { wide: 8, square: 8, tag: 8 };
  const boards = {};
  for (const shape of ['wide', 'square', 'tag']) {
    const geo = boardGeometry(shape);
    const uv = new THREE.InstancedBufferAttribute(new Float32Array(CAP[shape] * 4), 4);
    uv.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('signUv', uv);
    const mesh = new THREE.InstancedMesh(geo, material, CAP[shape]);
    mesh.count = 0; mesh.frustumCulled = false; mesh.castShadow = castShadow; mesh.receiveShadow = true;
    mesh.visible = false; mesh.name = `camp-signs:${shape}`;
    parent.add(mesh);
    boards[shape] = { mesh, uv, n: 0, cap: CAP[shape] };
  }
  const posts = new THREE.InstancedMesh(postGeometry(), material, 12);
  posts.geometry.setAttribute('signUv', new THREE.InstancedBufferAttribute(new Float32Array(12 * 4), 4));
  posts.count = 0; posts.frustumCulled = false; posts.castShadow = castShadow; posts.receiveShadow = true;
  posts.visible = false; posts.name = 'camp-signs:posts';
  parent.add(posts);
  let postN = 0;

  const regionUv = new Map();
  for (const [id, [x, y, w, h]] of Object.entries(REG)) regionUv.set(id, [x / AW, 1 - (y + h) / AH, w / AW, h / AH]);

  let iconTimer = 0;
  return {
    material, atlas, canvas,
    meshes: [...Object.values(boards).map(b => b.mesh), posts],
    has: id => !!CONTENT[id],
    shapeFor: id => (CONTENT[id]?.in ? 'wide' : 'square'),
    begin(dt = 0) {
      // poll for the HUD's icons until every one is the rendered kind (cheap: a map lookup per item)
      iconTimer -= dt;
      if (iconTimer <= 0) {
        iconTimer = 0.5;
        for (const c of Object.values(CONTENT)) { for (const [id] of c.in || []) iconFor(id); iconFor(c.out); }
      }
      if (dirty) paint();
      for (const b of Object.values(boards)) b.n = 0;
      postN = 0;
    },
    // one board: shape 'wide' | 'square' | 'tag', region = station id or 'full'
    board(shape, region, matrix) {
      const b = boards[shape];
      if (!b || b.n >= b.cap) return;
      const r = regionUv.get(region) || regionUv.get('full');
      b.mesh.setMatrixAt(b.n, matrix);
      b.uv.setXYZW(b.n, r[0], r[1], r[2], r[3]);
      b.n++;
    },
    post(matrix) { if (postN < 12) posts.setMatrixAt(postN++, matrix); },
    end() {
      for (const b of Object.values(boards)) {
        b.mesh.count = b.n; b.mesh.visible = b.n > 0;
        if (b.n) { b.mesh.instanceMatrix.needsUpdate = true; b.uv.needsUpdate = true; }
      }
      posts.count = postN; posts.visible = postN > 0;
      if (postN) posts.instanceMatrix.needsUpdate = true;
    },
    dispose() { offIcons?.(); atlas.dispose(); material.dispose(); },
  };
}
