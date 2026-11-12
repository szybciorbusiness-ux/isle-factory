// Functional checks for the player / camera / interact camp integration in the real page (headless, real GPU).
// Needs the dev server.   node src/view/player/camp.check.mjs [--mobile]
// Boot-up lock, the back stack staying in sync with camp.stack (with flights in the air), camp swings landing
// on hitIn (standing and walking), the eject hop, camera framing per orientation + the level beat, camp input.
import { chromium } from 'playwright-core';

const mobile = process.argv.includes('--mobile');
const base = `http://localhost:4660/?paused=1&shot=1${mobile ? '&mobile=1&safeTop=59&safeBottom=24' : ''}`;
const browser = await chromium.launch({ headless: true, args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: mobile ? { width: 402, height: 874 } : { width: 1600, height: 900 } });
const logs = [];
page.on('pageerror', e => logs.push(`PAGEERROR ${e.message}`));
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type()} ${m.text()}`); });
const out = [];
const load = async q => {
  await page.goto(base + q, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => window.__game?.ready, null, { timeout: 90000 });
};

// ---- boot ----
await load('');
out.push(...await page.evaluate(() => {
  const G = __game, P = G.views.player, r = [];
  const ok = (c, m) => r.push(`${c ? 'ok  ' : 'FAIL'} ${m}`);
  const s = P._motion.state, x0 = s.x;
  ok(P.booting === true, `fresh camp (level ${G.camp.level}) boots`);
  dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD' }));
  for (let i = 0; i < 60; i++) G.step(1);
  ok(Math.abs(s.x - x0) < 1e-6, `input locked while booting (moved ${(s.x - x0).toFixed(3)})`);
  let t = 61;
  while (P.booting && t < 400) { G.step(1); t++; }
  ok(Math.abs(t / 60 - 2.2) < 0.05, `control unlocks at ${(t / 60).toFixed(2)} s`);
  for (let i = 0; i < 30; i++) G.step(1);
  ok(s.x - x0 > 0.5, `held key walks right after the boot (moved ${(s.x - x0).toFixed(2)})`);
  dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD' }));
  return r;
}));
await load('&noboot=1');
out.push(...await page.evaluate(() => [`${__game.views.player.booting ? 'FAIL' : 'ok  '} ?noboot=1 skips the boot`]));

// ---- stack, swings, eject, camera, input ----
out.push(...await page.evaluate(async () => {
  const G = __game, P = G.views.player, camp = G.camp, sim = G.sim, cam = G.views.camera, I = G.views.interact;
  const r = [];
  const ok = (c, m) => r.push(`${c ? 'ok  ' : 'FAIL'} ${m}`);
  const step = n => { for (let i = 0; i < n; i++) G.step(1); };
  const tp = (x, z, h = Math.PI / 2) => { P._motion.teleport(x, z, h); sim.setPlayerPos(x, z); step(3); cam.snap(); };
  const V = () => new G.THREE.Vector3();

  // camera framing
  const c = G.ctx.camera, aspect = c.aspect;
  const across = 2 * cam.distance * Math.tan((c.fov * Math.PI) / 360) * aspect;
  if (aspect < 1) ok(across > 6.4 && across < 7.1, `portrait shows ${across.toFixed(2)} tiles across`);
  else ok(Math.abs(cam.distance - 20) < 0.01, `landscape keeps distance 20 (${cam.distance.toFixed(2)})`);

  // stack: instant adds, then sourced adds (fx flights) appear on arrival
  tp(23, 15);
  const st = P.stack;
  sim.inventory.add('wood', 3);
  step(2);
  ok(st.count === 3, `3 unsourced items show at once (${st.count})`);
  step(40);
  const topA = P.getStackTop(V()).y;
  sim.inventory.add('wood', 2, { x: 23, z: 17 });
  step(2);
  ok(st.count === 3 && st.hidden === 2, `2 flying items wait (shown ${st.count}, hidden ${st.hidden})`);
  step(90);
  ok(st.count === 5 && st.hidden === 0, `they land on the stack (shown ${st.count})`);
  const topB = P.getStackTop(V()).y;
  ok(topB > topA + 0.12, `stack top rises (${topA.toFixed(2)} -> ${topB.toFixed(2)}), stackTopY ${P.stackTopY().toFixed(2)}`);
  sim.inventory.remove('wood', 5);
  step(20);
  ok(st.count === 0, `paid away -> empty (${st.count})`);
  camp.capacity = 30;
  sim.inventory.add('plank', 30);
  step(60);
  ok(st.count === 30 && P.stackTopY() < 3.4 && P.stackTopY() > 1.6, `30 items: top at ${P.stackTopY().toFixed(2)} above the ground`);
  sim.inventory.remove('plank', 30);
  camp.capacity = 10;
  step(10);

  // swings: the strike lands at hitIn, standing (whole body turns) and walking (upper body twists)
  const swingAt = (tx, tz, hitIn = 0.13, tool = 'axe') => {
    G.ctx.events.emit('camp:swing', { by: 'player', target: { type: 'resource', id: -1, kind: 'tree', x: tx, z: tz }, tool, fromDir: 0, hitIn });
    let t = 0, hitT = -1;
    for (let i = 0; i < 40; i++) {
      G.step(1); t += 1 / 60;
      const s = P._swing;
      if (s?.impacted && hitT < 0) hitT = t;
    }
    return hitT;
  };
  tp(23, 15, Math.PI / 2); // open ground: no real tree in gather reach
  const h0 = P.heading;
  const hit = swingAt(25, 15, 0.13);
  ok(hit > 0 && Math.abs(hit - 0.13) <= 1 / 60 + 1e-6, `standing swing strikes at ${hit.toFixed(3)} s (hitIn 0.13)`);
  ok(Math.abs(Math.atan2(Math.sin(P.heading), Math.cos(P.heading))) < 0.35, `standing: the robot turned to the target (heading ${h0.toFixed(2)} -> ${P.heading.toFixed(2)})`);
  const hit2 = swingAt(25, 15, 0.25, 'club');
  ok(Math.abs(hit2 - 0.25) <= 1 / 60 + 1e-6, `slower hitIn 0.25 -> strike at ${hit2.toFixed(3)} s`);
  // walking south with a target to the east: legs keep going, the egg twists, the heading stays
  tp(19, 14, Math.PI / 2);
  dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyS' }));
  step(20);
  const hw = P.heading, x0 = P._motion.state.z;
  G.ctx.events.emit('camp:swing', { by: 'player', target: { type: 'resource', id: -1, kind: 'tree', x: 21, z: P._motion.state.z + 0.5 }, tool: 'pick', fromDir: 0, hitIn: 0.13 });
  let maxTwist = 0, minHead = Infinity, maxHead = -Infinity;
  for (let i = 0; i < 16; i++) { G.step(1); const s = P._swing; if (s) maxTwist = Math.max(maxTwist, Math.abs(s.twist)); minHead = Math.min(minHead, P.heading); maxHead = Math.max(maxHead, P.heading); }
  dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyS' }));
  ok(maxTwist > 0.5, `walking swing twists the upper body (${maxTwist.toFixed(2)} rad)`);
  ok(maxHead - minHead < 0.05 && Math.abs(hw - Math.PI / 2) < 0.05, `walking swing keeps the walking heading (${minHead.toFixed(2)}..${maxHead.toFixed(2)})`);
  ok(P._motion.state.z - x0 > 0.8, `legs keep going (moved ${(P._motion.state.z - x0).toFixed(2)})`);
  step(30);

  // eject hop out of a new station's footprint
  camp.completePad('hearth:1');
  step(120);
  tp(16.6, 12.7, 0.9);
  camp.completePad('build:sawmill');
  ok(P.ejecting, 'standing on the sawmill when it builds: hop');
  let n = 0;
  while (P.ejecting && n < 120) { G.step(1); n++; }
  const s = P._motion.state;
  ok(!P.ejecting && sim.isWalkable(Math.round(s.x), Math.round(s.z)) && !(s.x > 15.5 && s.x < 17.5 && s.z > 11.5 && s.z < 13.5),
    `landed outside the footprint at (${s.x.toFixed(2)}, ${s.z.toFixed(2)}) after ${(n / 60).toFixed(2)} s`);
  const ex = s.x;
  dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD' }));
  step(30);
  dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD' }));
  ok(s.x - ex > 0.8, `walks on cleanly after the hop (+${(s.x - ex).toFixed(2)})`);

  // camera: level pull-back and the level beat
  const d1 = cam.distance;
  ok(cam.levelMul > 1.02, `level ${camp.level}: pulled back x${cam.levelMul.toFixed(3)}`);
  camp.completePad('build:cookfire'); step(20);
  // forge a level-up through the sim's own path
  const before = cam.distance;
  let peak = 0;
  G.ctx.events.emit('hearth:level', { level: 2 });
  for (let i = 0; i < 80; i++) { G.step(1); peak = Math.max(peak, cam.beat); }
  ok(peak > 0.9 && cam.beat === 0, `hearth:level beat breathes out and settles (peak ${peak.toFixed(2)})`);
  ok(cam.distance > before, `settles farther out (${before.toFixed(2)} -> ${cam.distance.toFixed(2)}, d1 ${d1.toFixed(2)})`);

  // camp input: no hover / ghost, click walks
  tp(21, 17);
  I.clickTile(24, 16); step(80);
  ok(Math.hypot(s.x - 24, s.z - 16) > 0.6 && Math.hypot(s.x - 24, s.z - 16) < 1.6, `click on a rock walks up next to it (${s.x.toFixed(2)}, ${s.z.toFixed(2)})`);
  tp(21, 17);
  I.pointAt?.(22, 18);
  step(2);
  ok(!I.hover && !I.ghost, 'camp mode: no hover target, no build ghost');
  I.clickTile(23, 16);
  step(80);
  ok(Math.hypot(s.x - 23, s.z - 16) < 0.2, `click on ground walks there (${s.x.toFixed(2)}, ${s.z.toFixed(2)})`);
  ok(G.errors.length === 0, `no game errors (${G.errors.length})`);
  return r;
}));

console.log(out.join('\n'));
console.log(logs.length ? '--- logs ---\n' + [...new Set(logs)].slice(0, 20).join('\n') : 'no console errors');
console.log(out.some(l => l.startsWith('FAIL')) ? 'SOME CHECKS FAILED' : 'all camp checks passed');
await browser.close();
