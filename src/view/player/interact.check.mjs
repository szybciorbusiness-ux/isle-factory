// Functional checks for interact.js + player.js in the real page (headless). Needs the dev server.
//   node src/view/player/interact.check.mjs [--mobile]
// Drives the game with synthetic keyboard / pointer events and __game.step, and prints pass / fail per check.
import { chromium } from 'playwright-core';

const mobile = process.argv.includes('--mobile');
const url = `http://localhost:4660/?paused=1&shot=1${mobile ? '&mobile=1&safeTop=59&safeBottom=24' : ''}`;
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] });
const page = await browser.newPage({ viewport: mobile ? { width: 402, height: 874 } : { width: 960, height: 540 } });
const logs = [];
page.on('pageerror', e => logs.push(`PAGEERROR ${e.message}`));
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()} ${m.text()}`); });
await page.goto(url, { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction(() => window.__game?.ready, null, { timeout: 90000 });

const results = await page.evaluate(async () => {
  const G = __game, sim = G.sim, P = G.views.player, I = G.views.interact, cam = G.views.camera, canvas = G.ctx.canvas;
  const out = [];
  const ok = (c, msg) => out.push(`${c ? 'ok  ' : 'FAIL'} ${msg}`);
  const step = (n, dt = 1 / 60) => { for (let i = 0; i < n; i++) G.step(1, dt); };
  const tp = (x, z, h = Math.PI / 2) => { P._motion.teleport(x, z, h); sim.setPlayerPos(x, z); step(3); cam.snap(); };
  const key = (type, code) => dispatchEvent(new KeyboardEvent(type, { code, key: code, bubbles: true }));
  const scr = (x, z, y = 0) => { const s = G.toScreen(x, y, z); const r = canvas.getBoundingClientRect(); return { x: s.x + 0 * r.left, y: s.y }; };
  const ptr = (type, x, z, o = {}) => {
    const s = scr(x, z, o.y || 0);
    const ev = new PointerEvent(type, { clientX: s.x + (o.dx || 0), clientY: s.y + (o.dy || 0), button: o.button ?? 0, buttons: 1, pointerId: o.id ?? 1, pointerType: o.type || 'mouse', isPrimary: (o.id ?? 1) === 1, bubbles: true });
    (type === 'pointerup' ? window : canvas).dispatchEvent(ev);
  };
  const hp = id => sim.entities.get(id)?.hp ?? 0;

  // 1. Space chops the tree in front (tree at 18,18; the robot stands east of it facing west)
  tp(19.25, 18.0, Math.PI);
  const tree = sim.at(18, 18);
  const hp0 = tree.hp;
  key('keydown', 'Space'); step(30); key('keyup', 'Space'); step(30);
  ok(hp(tree.id) === hp0 - 1, `Space: one chop on the tree in front (hp ${hp0} -> ${hp(tree.id)})`);
  // hold Space: keeps chopping until the tree is down, then keeps going on the stump
  key('keydown', 'Space'); step(150); key('keyup', 'Space'); step(20);
  ok(!sim.entities.has(tree.id), `hold Space: tree felled (felled ${sim.metrics['felled.tree'] || 0})`);
  // 2. click a rock far away: walks up and keeps mining until it is gone (rock hp 4)
  const rock = sim.at(26, 13);
  tp(21, 13, 0);
  I.clickTile(26, 13, false);
  let walked = false;
  for (let i = 0; i < 360 && sim.entities.has(rock.id); i++) { step(1); if (P.moving) walked = true; }
  const p = P.getPosition();
  ok(walked && !sim.entities.has(rock.id), `click rock 5 tiles away: walked (${walked}) and mined it out; stood ${Math.hypot(p.x - 26, p.z - 13).toFixed(2)} from it`);
  // 3. a movement key cancels a click job
  const rock2 = sim.at(26, 15);
  tp(21, 15, 0);
  I.clickTile(26, 15, false); step(10);
  key('keydown', 'KeyW'); step(10); key('keyup', 'KeyW'); step(60);
  ok(sim.entities.get(rock2.id)?.hp === rock2.maxHp && !I.job, `movement key cancels a click-to-mine walk (job ${JSON.stringify(I.job)})`);
  // 4. deposits: one hit per click, keep mining while held
  tp(29, 13, 0);
  const ore0 = sim.inventory.get('copperOre');
  I.clickTile(30, 13, false); step(80);
  const ore1 = sim.inventory.get('copperOre');
  ok(ore1 - ore0 === 1, `deposit click: one hit (+${ore1 - ore0} ore)`);
  // held via a real mouse press on the deposit
  I.pointAt(30, 13); step(2);
  ptr('pointerdown', 30, 13); step(90);
  const ore2 = sim.inventory.get('copperOre');
  ptr('pointerup', 30, 13); step(40);
  ok(ore2 - ore1 >= 3, `deposit held: keeps mining (+${ore2 - ore1} ore in 1.5 s)`);
  // 5. chests: open within useReach, walk then open when farther
  sim.inventory.add('chest', 3);
  tp(20, 13, 0);
  const c1 = sim.place('chest', 23, 13, 0).entity;
  G.ui.panel = null;
  I.clickTile(23, 13); step(4);
  ok(G.ui.panel?.id === c1.id && !P.moving, `chest 3 tiles away opens at once (panel ${JSON.stringify(G.ui.panel)})`);
  G.ui.panel = null;
  tp(15, 13, 0);
  I.clickTile(23, 13); step(4);
  const startedWalking = P.moving;
  for (let i = 0; i < 240 && !G.ui.panel; i++) step(1);
  const pc = P.getPosition();
  ok(startedWalking && G.ui.panel?.id === c1.id, `chest 8 tiles away: walks, then opens at ${Math.hypot(pc.x - 23, pc.z - 13).toFixed(2)} tiles (useReach 4)`);
  G.ui.panel = null;
  // 6. Space with nothing to hit opens the chest being faced
  tp(21, 13, 0); step(10);
  key('keydown', 'Space'); step(4); key('keyup', 'Space');
  ok(G.ui.panel?.id === c1.id, 'Space with nothing in reach opens the faced chest');
  G.ui.panel = null;
  sim.remove(c1.id); step(5);
  // 7. belts: drag-paint an L with an auto-corner
  sim.inventory.add('belt', 20);
  tp(18, 15, 0);
  G.ui.selected = 'belt'; G.ui.buildDir = 0; step(2);
  I.pointAt(16, 12); step(2);
  ptr('pointerdown', 16, 12); step(1);
  for (const [x, z] of [[17, 12], [18, 12], [19, 12], [19, 13], [19, 14]]) { I.pointAt(x, z); ptr('pointermove', x, z); step(1); }
  ptr('pointerup', 19, 14); step(2);
  const b = [[16, 12], [17, 12], [18, 12], [19, 12], [19, 13], [19, 14]].map(([x, z]) => sim.at(x, z));
  ok(b.every(e => e?.kind === 'belt'), `belt drag placed 6 belts (${b.map(e => e?.kind || '-').join(',')})`);
  ok(b[3]?.dir === 1 && b[2]?.dir === 0 && b[4]?.dir === 1 && b[3]?.shape !== 'straight', `auto-corner: the corner belt re-pointed south and curves (dirs ${b.map(e => e?.dir).join(',')}, corner ${b[3]?.shape})`);
  // 8. right-drag removes many
  G.ui.selected = null; step(2);
  I.pointAt(16, 12); step(2);
  ptr('pointerdown', 16, 12, { button: 2 }); step(1);
  for (const [x, z] of [[17, 12], [18, 12], [19, 12]]) { I.pointAt(x, z); step(1); }
  ptr('pointerup', 19, 12, { button: 2 }); step(2);
  ok([[16, 12], [17, 12], [18, 12], [19, 12]].every(([x, z]) => !sim.at(x, z)), 'right-drag removed 4 belts');
  // 9. R rotates the ghost direction, Shift+R back
  G.ui.selected = 'belt'; G.ui.buildDir = 0; step(2);
  key('keydown', 'KeyR'); key('keyup', 'KeyR');
  const d1 = G.ui.buildDir;
  dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', shiftKey: true })); key('keyup', 'KeyR');
  ok(d1 === 1 && G.ui.buildDir === 0, `R rotates (0 -> ${d1}), Shift+R reverses (-> ${G.ui.buildDir})`);
  G.ui.selected = null; step(2);

  // 10. touch: tap on ground walks there
  tp(18, 15, 0);
  ptr('pointerdown', 20, 13, { type: 'touch', id: 7 }); step(2); ptr('pointerup', 20, 13, { type: 'touch', id: 7 });
  for (let i = 0; i < 120 && P.moving; i++) step(1);
  step(30);
  const pt = P.getPosition();
  ok(Math.hypot(pt.x - 20, pt.z - 13) < 0.2, `touch tap walks to the tapped tile (at ${pt.x.toFixed(2)}, ${pt.z.toFixed(2)})`);
  // 11. touch long-press removes a building, with the ring showing first
  const c2 = sim.place('chest', 22, 13, 0).entity;
  step(2);
  ptr('pointerdown', 22, 13, { type: 'touch', id: 8, y: 0.3 }); step(15);
  const midRing = I.longPress?.t > 0.1 && sim.entities.has(c2.id);
  step(15);
  const removed = !sim.entities.has(c2.id);
  ptr('pointerup', 22, 13, { type: 'touch', id: 8, y: 0.3 }); step(5);
  ok(midRing && removed && !G.ui.panel, `touch long-press: ring at 0.25 s, removed by 0.5 s, no panel opened (${midRing}, ${removed})`);
  // 12. touch tap on a chest opens it
  const c3 = sim.place('chest', 22, 13, 0).entity;
  step(2);
  ptr('pointerdown', 22, 13, { type: 'touch', id: 9, y: 0.3 }); step(5); ptr('pointerup', 22, 13, { type: 'touch', id: 9, y: 0.3 }); step(4);
  ok(G.ui.panel?.id === c3.id, 'touch tap on a chest opens it');
  G.ui.panel = null; sim.remove(c3.id);
  // 13. two-finger pinch zooms
  const z0 = cam.zoomLevel;
  const c = canvas.getBoundingClientRect(), cx = c.width / 2, cy = c.height / 2;
  const tev = (type, id, x, y) => (type === 'pointerup' ? window : canvas).dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: id, pointerType: 'touch', bubbles: true }));
  tev('pointerdown', 11, cx - 40, cy); tev('pointerdown', 12, cx + 40, cy); step(1);
  tev('pointermove', 11, cx - 20, cy); tev('pointermove', 12, cx + 20, cy); step(30);
  tev('pointerup', 11, cx - 20, cy); tev('pointerup', 12, cx + 20, cy); step(2);
  ok(cam.zoomLevel > z0 * 1.5 && Math.abs(cam.distance / cam.baseDistance - cam.zoomLevel) < 0.05, `pinch in zooms out (zoom ${z0.toFixed(2)} -> ${cam.zoomLevel.toFixed(2)}, distance ${cam.distance.toFixed(1)})`);
  cam.setZoomLevel(1); step(40);
  // 14. touch one-finger drag with belts selected paints belts
  tp(18, 16, 0);
  G.ui.selected = 'belt'; G.ui.buildDir = 0; step(2);
  ptr('pointerdown', 16, 13, { type: 'touch', id: 13 }); step(1);
  for (const [x, z] of [[16.45, 13], [17, 13], [18, 13], [18, 14]]) { ptr('pointermove', x, z, { type: 'touch', id: 13 }); step(1); }
  ptr('pointerup', 18, 14, { type: 'touch', id: 13 }); step(2);
  const tb = [[16, 13], [17, 13], [18, 13], [18, 14]].map(([x, z]) => sim.at(x, z)?.kind || '-');
  ok(tb.every(k => k === 'belt'), `touch drag painted belts (${tb.join(',')})`);
  ok(I.touchTile && I.touchTile.x === 18 && I.touchTile.z === 14, `ghost tile follows the last touch (${JSON.stringify(I.touchTile)})`);
  G.ui.selected = null; step(2);
  // 15. analog stick input moves at the stick magnitude; supportsAnalog is set
  tp(18, 16, 0);
  // (on mobile the real stick in touch.js rewrites input.move every frame: hold it still for this check)
  const tu = G.views.touch?.update;
  if (tu) G.views.touch.update = () => {};
  G.ctx.input.move.x = 0; G.ctx.input.move.z = -0.5; step(40);
  const sp = P.speed;
  G.ctx.input.move.x = 0; G.ctx.input.move.z = 0; step(20);
  if (tu) G.views.touch.update = tu;
  ok(P.supportsAnalog === true && Math.abs(sp - 2.1) < 0.05, `analog stick at 0.5 walks at ${sp.toFixed(2)} tiles/s (half of 4.2)`);
  ok((G.errors || []).length === 0, `no game errors (${(G.errors || []).length})`);
  return out;
});
console.log(results.join('\n'));
console.log(logs.length ? '--- logs ---\n' + [...new Set(logs)].slice(0, 20).join('\n') : 'no console errors');
const fails = results.filter(r => r.startsWith('FAIL')).length;
console.log(fails ? `${fails} check(s) failed` : 'all interaction checks passed');
await browser.close();
process.exitCode = fails ? 1 : 0;
