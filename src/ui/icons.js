// Item icons rendered from the real 3D models with ONE small offscreen WebGLRenderer, cached as PNG data
// URLs. Building items use views.buildings.createModel(kind).object, everything else
// views.items.createItemMesh(id). Items without a real mesh yet (items.js draws a plain placeholder cube) and
// models that throw get a hand-drawn 2D icon (icon-drawings.js: meat, cooked meat, copper bar) or a soft disc.
// refresh(root, ids) re-renders and swaps any <img data-icon> whose picture changed (emits 'ui:icons').
// The offscreen renderer is released after a short idle (tick(dt)), so a late request never keeps a context.
import { drawIcon } from './icon-drawings.js';

const SIZE = 128;        // output icon size (px)
const RENDER = 256;      // supersampled render size, cropped + downscaled into SIZE
const PAD = 0.1;         // empty margin around the cropped model, fraction of SIZE
const IDLE_RELEASE = 0.6; // s without renders before the offscreen renderer is released

export function createIcons(ctx) {
  const { THREE, config, views } = ctx;
  const cache = new Map();   // id -> data URL
  const kinds = new Map();   // id -> 'model' | 'fallback'
  let gl = null;             // { renderer, scene, camera, pivot }
  let idle = 0;              // s since the last render (tick releases the renderer)

  function ensureRenderer() {
    if (gl) return gl;
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(1);
    renderer.setSize(RENDER, RENDER, false);
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    // Bright, warm and low contrast like the world: warm key from the upper left, minty bounce from below.
    scene.add(new THREE.HemisphereLight('#fff4dc', '#9fd8bf', 1.9));
    const key = new THREE.DirectionalLight('#fff1d8', 2.1);
    key.position.set(-2.2, 4, 3);
    scene.add(key);
    const rim = new THREE.DirectionalLight('#d8fff0', 0.55);
    rim.position.set(3, 2, -2.5);
    scene.add(rim);
    const camera = new THREE.PerspectiveCamera(24, 1, 0.01, 100);
    const pivot = new THREE.Group();
    scene.add(pivot);
    gl = { renderer, scene, camera, pivot };
    return gl;
  }

  // Build a fresh model for an item id. Returns { object, dispose } or null.
  function buildModel(id) {
    const def = config.ITEMS[id];
    if (!def) return null;
    if (def.building) {
      const m = views.buildings?.createModel?.(def.building, { ghost: false, icon: true });
      if (!m?.object) return null;
      try { m.setValid?.(true); } catch { /* optional */ }
      return { object: m.object, dispose: () => m.dispose?.(), building: def.building };
    }
    let obj = views.items?.createItemMesh?.(id);
    if (!obj) return null;
    if (obj.parent) obj = obj.clone();
    if (isPlaceholder(obj)) return null; // the drawn icon reads much better than a coloured cube
    return { object: obj, dispose: null, building: null };
  }

  // items.js gives ids it has no model for a plain 0.18 rounded cube: spot it by its bounding box.
  const pbox = new THREE.Box3(), psize = new THREE.Vector3();
  function isPlaceholder(obj) {
    let meshes = 0, geo = null;
    obj.traverse(o => { if (o.isMesh) { meshes++; geo = o.geometry; } });
    if (meshes !== 1 || !geo) return false;
    if (!geo.boundingBox) geo.computeBoundingBox();
    pbox.copy(geo.boundingBox).getSize(psize);
    const near = v => Math.abs(v - 0.18) < 0.006;
    return near(psize.x) && near(psize.y) && near(psize.z);
  }

  // Ghost previews may be translucent: render an opaque copy of any see-through material.
  function makeOpaque(object) {
    const clones = [];
    object.traverse(o => {
      if (!o.isMesh && !o.isLine && !o.isPoints) return;
      const fix = m => {
        if (!m || !(m.transparent || m.opacity < 1)) return m;
        const c = m.clone();
        c.transparent = false; c.opacity = 1; c.depthWrite = true;
        clones.push(c);
        return c;
      };
      o.material = Array.isArray(o.material) ? o.material.map(fix) : fix(o.material);
    });
    return () => clones.forEach(c => c.dispose());
  }

  const box = new THREE.Box3(), sphere = new THREE.Sphere(), dir = new THREE.Vector3();
  function renderModel(model) {
    const { renderer, scene, camera, pivot } = ensureRenderer();
    const { object, building } = model;
    const restore = makeOpaque(object);
    const prev = { parent: object.parent, pos: object.position.clone(), rot: object.rotation.clone(), scale: object.scale.clone() };
    pivot.add(object);
    object.position.set(0, 0, 0);
    // Front (local +x) turned a little toward the viewer so machines read three-quarter on.
    object.rotation.set(0, building ? -0.42 : 0.5, 0);
    pivot.updateMatrixWorld(true);
    box.setFromObject(object, true);
    if (box.isEmpty()) { pivot.remove(object); restore(); return null; }
    box.getBoundingSphere(sphere);
    // Flat things (belts) look best from higher up; chunky things from a lower three-quarter view.
    const size = box.getSize(new THREE.Vector3());
    const flat = size.y < Math.max(size.x, size.z) * 0.35;
    const pitch = flat ? 0.95 : 0.6, yaw = 0.62;
    dir.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    const fov = THREE.MathUtils.degToRad(camera.fov);
    const dist = (sphere.radius / Math.sin(fov / 2)) * (flat ? 0.98 : 0.92);
    camera.position.copy(sphere.center).addScaledVector(dir, dist);
    camera.near = Math.max(0.01, dist - sphere.radius * 3);
    camera.far = dist + sphere.radius * 3;
    camera.updateProjectionMatrix();
    camera.lookAt(sphere.center);
    renderer.toneMapping = ctx.renderer?.toneMapping ?? THREE.NoToneMapping;
    renderer.toneMappingExposure = ctx.renderer?.toneMappingExposure ?? 1;
    renderer.render(scene, camera);
    const url = cropToIcon(renderer.domElement);
    pivot.remove(object);
    object.position.copy(prev.pos); object.rotation.copy(prev.rot); object.scale.copy(prev.scale);
    if (prev.parent) prev.parent.add(object);
    restore();
    return url;
  }

  // Crop the render to the model's alpha bounds so every icon fills its frame the same way, add a soft
  // warm contact shadow under it, and downscale (supersampled) into the SIZE x SIZE output.
  let scratch = null;
  function cropToIcon(src) {
    scratch ||= { a: document.createElement('canvas'), b: document.createElement('canvas') };
    const { a, b } = scratch;
    a.width = a.height = RENDER;
    const ga = a.getContext('2d', { willReadFrequently: true });
    ga.clearRect(0, 0, RENDER, RENDER);
    ga.drawImage(src, 0, 0);
    const px = ga.getImageData(0, 0, RENDER, RENDER).data;
    let x0 = RENDER, y0 = RENDER, x1 = -1, y1 = -1;
    for (let y = 0; y < RENDER; y++) {
      for (let x = 0; x < RENDER; x++) {
        if (px[(y * RENDER + x) * 4 + 3] > 10) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const side = Math.max(bw, bh * 1.08) / (1 - PAD * 2); // leave room under the model for its shadow
    const cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2 + bh * 0.03;
    const s = SIZE / side;
    b.width = b.height = SIZE;
    const g = b.getContext('2d');
    g.clearRect(0, 0, SIZE, SIZE);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    // contact shadow: soft warm ellipse at the model's foot
    const fx = SIZE / 2, fy = SIZE / 2 + (y1 + 1 - cy) * s - bh * s * 0.06;
    const rx = Math.min(bw * s * 0.46, SIZE * 0.42), ry = Math.max(3, rx * 0.26);
    g.save();
    g.translate(fx, fy); g.scale(1, ry / rx);
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, rx);
    grad.addColorStop(0, 'rgba(110, 76, 30, 0.30)');
    grad.addColorStop(0.6, 'rgba(110, 76, 30, 0.14)');
    grad.addColorStop(1, 'rgba(110, 76, 30, 0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(0, 0, rx, 0, Math.PI * 2); g.fill();
    g.restore();
    g.drawImage(a, cx - side / 2, cy - side / 2, side, side, 0, 0, SIZE, SIZE);
    return b.toDataURL('image/png');
  }

  // Hand-drawn icon (meat, cooked meat, copper bar) or a soft coloured disc, for items without a model.
  function fallback(id) {
    return drawIcon(id, SIZE, config.ITEMS[id]?.color).toDataURL('image/png');
  }

  function render(id) {
    let model = null, url = null;
    idle = 0;
    try {
      model = buildModel(id);
      if (model) url = renderModel(model);
    } catch (e) {
      console.info(`[ui] icon for "${id}" fell back to a disc: ${e?.message || e}`);
      url = null;
    } finally {
      try { model?.dispose?.(); } catch { /* ignore */ }
    }
    kinds.set(id, url ? 'model' : 'fallback');
    return url || fallback(id);
  }

  function get(id) {
    if (!cache.has(id)) cache.set(id, render(id));
    return cache.get(id);
  }

  function img(id, cls = 'icon') {
    const im = new Image();
    im.className = cls;
    im.alt = '';
    im.draggable = false;
    im.decoding = 'async';
    im.dataset.icon = id;
    im.src = get(id);
    return im;
  }

  // Re-render icons (all, or just `ids`) after models changed and swap only the pictures that differ.
  // Modules holding icon URLs elsewhere (the pads' cost bubbles) can listen for 'ui:icons' { changed }.
  function refresh(root = ctx.uiRoot, ids = Object.keys(config.ITEMS)) {
    const changed = [];
    for (const id of ids) {
      if (!config.ITEMS[id]) continue;
      const url = render(id);
      if (url !== cache.get(id)) { cache.set(id, url); changed.push(id); }
    }
    for (const id of changed) root?.querySelectorAll(`img[data-icon="${id}"]`).forEach(im => { im.src = cache.get(id); });
    if (changed.length) { try { ctx.events?.emit?.('ui:icons', { changed }); } catch (e) { console.error('[ui] ui:icons listener', e); } }
    return changed;
  }

  function release() {
    if (!gl) return;
    gl.renderer.dispose();
    gl.renderer.forceContextLoss?.();
    gl = null;
  }

  // Release the offscreen renderer once nothing has rendered for a moment (call every frame).
  function tick(dt) {
    if (!gl) return;
    idle += dt;
    if (idle >= IDLE_RELEASE) release();
  }

  return { get, img, refresh, release, tick, kind: id => kinds.get(id) };
}
