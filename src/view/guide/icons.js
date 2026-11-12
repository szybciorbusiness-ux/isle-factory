// Item icon for the guide's stickers: the HUD's rendered 3D icon (views.ui.iconUrl) when it has one, else a
// small painted fallback. iconEl(slot, item) keeps one <img> / <canvas> per slot and only swaps when the
// picture changes (the HUD re-renders icons lazily).
const OUT = 'rgba(91,58,33,.85)';

export function drawIcon(id) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.lineJoin = 'round'; g.lineCap = 'round';
  const stroke = (w = 4) => { g.lineWidth = w; g.strokeStyle = OUT; g.stroke(); };
  g.translate(32, 33);
  switch (id) {
    case 'wood':
      g.rotate(-0.35);
      g.beginPath(); g.roundRect(-24, -11, 44, 22, 10); g.fillStyle = '#a8693a'; g.fill(); stroke();
      g.beginPath(); g.ellipse(20, 0, 7, 11, 0, 0, Math.PI * 2); g.fillStyle = '#f0cf98'; g.fill(); stroke(3);
      break;
    case 'plank':
      g.rotate(-0.25);
      for (const [dy, col] of [[6, '#d9a66c'], [-5, '#f0c48b']]) { g.beginPath(); g.roundRect(-26, dy - 6, 52, 12, 4); g.fillStyle = col; g.fill(); stroke(3); }
      break;
    case 'stone':
      g.beginPath(); g.moveTo(-22, 8); g.lineTo(-14, -14); g.lineTo(6, -18); g.lineTo(22, -4); g.lineTo(18, 14); g.lineTo(-10, 18); g.closePath();
      g.fillStyle = '#ece0c4'; g.fill(); stroke();
      break;
    case 'meat': case 'cookedMeat':
      g.rotate(0.5);
      g.beginPath(); g.ellipse(-4, 0, 17, 13, 0, 0, Math.PI * 2); g.fillStyle = id === 'meat' ? '#ee8f80' : '#bf6f3c'; g.fill(); stroke();
      g.beginPath(); g.roundRect(10, -3.5, 14, 7, 3); g.fillStyle = '#fff4e2'; g.fill(); stroke(3);
      g.beginPath(); g.arc(25, -4, 4.5, 0, Math.PI * 2); g.arc(25, 4, 4.5, 0, Math.PI * 2); g.fillStyle = '#fff4e2'; g.fill();
      break;
    case 'copperOre':
      g.beginPath(); g.moveTo(-20, 10); g.lineTo(-12, -14); g.lineTo(10, -16); g.lineTo(21, 2); g.lineTo(10, 16); g.lineTo(-12, 16); g.closePath();
      g.fillStyle = '#d8c7a4'; g.fill(); stroke();
      for (const [x, y] of [[-6, -4], [7, 3], [-2, 9]]) { g.beginPath(); g.arc(x, y, 4.5, 0, Math.PI * 2); g.fillStyle = '#e8894a'; g.fill(); }
      break;
    case 'copperBar':
      g.beginPath(); g.moveTo(-24, 10); g.lineTo(-16, -8); g.lineTo(18, -8); g.lineTo(24, 10); g.closePath(); g.fillStyle = '#e8894a'; g.fill(); stroke();
      g.beginPath(); g.moveTo(-14, -8); g.lineTo(16, -8); g.lineTo(12, -1); g.lineTo(-10, -1); g.closePath(); g.fillStyle = '#ffb37a'; g.fill();
      break;
    case 'tree':
      g.beginPath(); g.roundRect(-5, 6, 10, 16, 3); g.fillStyle = '#8a5530'; g.fill(); stroke(3);
      g.beginPath(); g.arc(-9, 0, 13, 0, Math.PI * 2); g.arc(9, 0, 13, 0, Math.PI * 2); g.arc(0, -12, 14, 0, Math.PI * 2);
      g.fillStyle = '#3d8746'; g.fill(); stroke(3.5);
      break;
    case 'pad': {
      // a build pad: a cream floor plate with a dashed outline, an orange arrow stepping onto it
      g.translate(0, 6);
      g.save(); g.scale(1, 0.62);
      g.beginPath(); g.roundRect(-25, -25, 50, 50, 14); g.fillStyle = '#f6e7c4'; g.fill(); stroke(3.5);
      g.setLineDash([7, 6]); g.beginPath(); g.roundRect(-17, -17, 34, 34, 9); g.lineWidth = 3; g.strokeStyle = '#c99a5b'; g.stroke();
      g.restore();
      g.translate(0, -16);
      g.beginPath(); g.moveTo(-6, -14); g.lineTo(6, -14); g.lineTo(6, -2); g.lineTo(13, -2); g.lineTo(0, 12); g.lineTo(-13, -2); g.lineTo(-6, -2); g.closePath();
      g.fillStyle = '#ff8616'; g.fill(); stroke(3);
      break;
    }
    default:
      g.beginPath(); g.arc(0, 0, 17, 0, Math.PI * 2); g.fillStyle = '#ffc77a'; g.fill(); stroke();
  }
  return c;
}

// One icon element per slot (a wrapper element): swaps between the HUD's PNG and our drawing.
export function createIconSlot(views, items = {}) {
  const drawn = new Map();
  let cur = { item: null, url: null, el: null };
  return function set(wrap, item) {
    const url = item && items[item] ? (views.ui?.iconUrl?.(item) || null) : null;
    if (cur.item === item && cur.url === url && cur.el?.parentNode === wrap) return;
    let el;
    if (!item) el = null;
    else if (url) { el = document.createElement('img'); el.alt = ''; el.decoding = 'async'; el.src = url; }
    else {
      if (!drawn.has(item)) drawn.set(item, drawIcon(item));
      el = drawn.get(item);
    }
    wrap.replaceChildren(...(el ? [el] : []));
    cur = { item, url, el };
  };
}
