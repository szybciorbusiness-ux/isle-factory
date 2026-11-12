// Player-module dev tool (headless, like tools/shot.mjs): close-up sheets that follow the robot, and numeric
// movement logs stepped deterministically in the page. Needs the dev server (node serve.mjs 4660).
//
//   node src/view/player/shots.mjs turntable --out shots/polish3-player/turn.png [--mobile] [--dist 14]
//   node src/view/player/shots.mjs sheet --out x.png --seq "<js run before frames>" --frames 12 --every 3
//          [--keys KeyD,KeyS] [--move 0.5,0] [--follow] [--box 220] [--scale 2] [--mobile] [--url ...]
//   node src/view/player/shots.mjs log --out x.json --script <name> [--dt 60|120|jitter]
// Real GPU by default (--swiftshader for software). Default URLs add noboot=1; --cy <world y> centres the clip higher.
//
// Sheets: each frame is clipped around the robot's screen position (--follow) or the first frame's position.
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const mode = argv[0];
const args = Object.fromEntries(argv.slice(1).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const mobile = !!args.mobile;
const W = Number(args.w || (mobile ? 402 : 1920)), H = Number(args.h || (mobile ? 874 : 1080));
const scale = Number(args.scale || 2);
let url = args.url || (mobile ? '/?paused=1&noboot=1&mobile=1&safeTop=59&safeBottom=24' : '/?paused=1&noboot=1');
url = `http://localhost:${args.port || 4660}${url}${url.includes('?') ? '&' : '?'}shot=1`;
const out = resolve(args.out || 'shots/polish3-player/dev.png');
mkdirSync(dirname(out), { recursive: true });

const browser = await chromium.launch({ headless: true, args: args.swiftshader ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] : ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: scale });
const logs = [];
page.on('pageerror', e => logs.push(`PAGEERROR ${e.message}`));
page.on('crash', () => console.log('PAGE CRASHED'));
page.on('close', () => console.log('PAGE CLOSED'));
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type().toUpperCase()} ${m.text()}`); });
await page.goto(url, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__game?.ready, null, { timeout: 60000 });
if (args.dist) await page.evaluate(d => { const c = __game.views.camera; c.setDistance(Number(d)); c.snap(); }, args.dist);
if (args.hideui) await page.addStyleTag({ content: '#ui{display:none!important}' });

async function robotScreen() {
  return page.evaluate(cy => { const p = __game.views.player.getPosition(); return __game.toScreen(p.x, cy, p.z); }, Number(args.cy || 0.35));
}
async function sheet(frames, cols, label = true) {
  const p2 = await browser.newPage();
  const dataUrl = await p2.evaluate(async ({ frames, cols, label }) => {
    const imgs = await Promise.all(frames.map(b => new Promise(r => { const im = new Image(); im.onload = () => r(im); im.src = 'data:image/png;base64,' + b; })));
    const w = imgs[0].width, h = imgs[0].height, sc = Math.min(1, 2600 / (w * cols));
    const c = document.createElement('canvas');
    c.width = Math.round(w * cols * sc); c.height = Math.round(h * Math.ceil(imgs.length / cols) * sc);
    const g = c.getContext('2d');
    imgs.forEach((im, i) => {
      const x = (i % cols) * w * sc, y = Math.floor(i / cols) * h * sc;
      g.drawImage(im, x, y, w * sc, h * sc);
      if (label) { g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(x, y, 30, 16); g.fillStyle = '#fff'; g.font = '12px monospace'; g.fillText(String(i), x + 5, y + 12); }
    });
    return c.toDataURL('image/png');
  }, { frames, cols, label });
  writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
  await p2.close();
}
const box = Number(args.box || (mobile ? 120 : 220));
const clipAt = s => ({ x: Math.max(0, Math.min(W - box, s.x - box / 2)), y: Math.max(0, Math.min(H - box, s.y - box * 0.55)), width: box, height: box });

try {
  if (args.pre) await page.evaluate(`(async () => { ${args.pre} })()`);
  if (mode === 'turntable') {
    const frames = [];
    const heads = [90, 45, 0, -45, -90, -135, 180, 135];
    for (const deg of heads) {
      await page.evaluate(d => { const m = __game.views.player._motion; m.teleport(m.state.x, m.state.z, d * Math.PI / 180); __game.views.camera.snap(); __game.step(Number(d === 90 ? 30 : 4)); }, deg);
      frames.push((await page.screenshot({ clip: clipAt(await robotScreen()) })).toString('base64'));
    }
    await sheet(frames, 4);
  } else if (mode === 'sheet') {
    if (args.seq) await page.evaluate(`(async () => { ${args.seq} })()`);
    const n = Number(args.frames || 12), every = Number(args.every || 3);
    const keys = args.keys && args.keys !== true ? String(args.keys).split(',') : [];
    const mv = args.move && args.move !== true ? String(args.move).split(',').map(Number) : null;
    for (const k of keys) await page.keyboard.down(k);
    if (mv) await page.evaluate(([x, z]) => { __game.ctx.input.move = { x, z }; __game.ctx.input.active = true; }, mv);
    const frames = [];
    let first = null;
    for (let i = 0; i < n; i++) {
      if (args.at && Number(args.at) === i) await page.evaluate(`(async () => { ${args.then || ''} })()`);
      if (i > 0) await page.evaluate(k => __game.step(k), every); else await page.evaluate(() => __game.step(1));
      if (args.side) await page.evaluate(az => {
        // re-aim the camera for a profile view of the robot (the camera module re-places it on the next step)
        const c = __game.ctx.camera, p = __game.views.player.getPosition(), a = Number(az) * Math.PI / 180;
        c.position.set(p.x + Math.cos(a) * 3.6, 1.3, p.z + Math.sin(a) * 3.6); c.lookAt(p.x, 0.42, p.z); c.updateMatrixWorld();
        __game.render();
      }, args.side === true ? 90 : args.side);
      const sp = args.side ? { x: W / 2, y: H / 2 + box * 0.05 } : await robotScreen();
      if (!first || args.follow) first = sp;
      frames.push((await page.screenshot({ clip: clipAt(first) })).toString('base64'));
    }
    await sheet(frames, Number(args.cols || Math.min(6, n)));
  } else if (mode === 'log') {
    // Numeric movement proof: run every scenario at each dt mode, record per-frame state, summarise.
    const SCEN = {
      straight: { start: [18, 13], tl: [[0, ['KeyD']], [1.0, []]], T: 1.4 },
      diagonal: { start: [17, 12], tl: [[0, ['KeyD', 'KeyS']], [0.9, []]], T: 1.3 },
      reversal: { start: [17, 13], tl: [[0, ['KeyD']], [0.7, ['KeyA']], [1.4, []]], T: 1.8 },
      turn90: { start: [19, 11], tl: [[0, ['KeyD']], [0.6, ['KeyS']], [1.2, []]], T: 1.6 },
      analog: { start: [17, 13], tl: [[0, [], [0.5, 0]], [0.8, [], [0, 0.5]], [1.5, [], [0, 0]]], T: 1.9 },
      coast: { start: [22, 15], tl: [[0, ['KeyD']], [0.5, ['KeyD', 'KeyS']], [1.1, []]], T: 1.4 },
      gap: { start: [19.62, 15.2], tl: [[0, ['KeyW']], [1.1, []]], T: 1.4, gap: true },
      stop: { start: [17, 13], tl: [[0, ['KeyD']], [0.6, []]], T: 1.0 },
    };
    const dtModes = String(args.dt || '60,120,jitter').split(',');
    const names = args.script && args.script !== true ? String(args.script).split(',') : Object.keys(SCEN);
    const all = {};
    for (const name of names) for (const dm of dtModes) {
      const rows = await page.evaluate(async ({ sc, dm }) => {
        const G = __game, sim = G.sim, pl = G.views.player, cam = G.views.camera, m = pl._motion;
        if (sc.gap && !sim.at(19, 14)) {
          // two chests at (19,14) and (21,14) leave a one-tile gap at x = 20 (the robot starts 0.38 off-centre)
          sim.inventory.add('chest', 2);
          sim.place('chest', 19, 14, 0); sim.place('chest', 21, 14, 0);
        }
        m.teleport(sc.start[0], sc.start[1], Math.PI / 2);
        sim.setPlayerPos?.(sc.start[0], sc.start[1]);
        G.step(2); cam.snap(); G.step(30);
        let r = 99991;
        const rnd = () => ((r = (r * 1103515245 + 12345) >>> 0) / 4294967296);
        const held = new Set();
        const setKeys = keys => {
          for (const k of [...held]) if (!keys.includes(k)) { dispatchEvent(new KeyboardEvent('keyup', { code: k, key: k })); held.delete(k); }
          for (const k of keys) if (!held.has(k)) { dispatchEvent(new KeyboardEvent('keydown', { code: k, key: k })); held.add(k); }
        };
        const out = [];
        const fl = new G.THREE.Vector3(), fr = new G.THREE.Vector3();
        let t = 0, ti = 0;
        while (t < sc.T - 1e-9) {
          while (ti < sc.tl.length && sc.tl[ti][0] <= t + 1e-9) {
            setKeys(sc.tl[ti][1]);
            const mv = sc.tl[ti][2];
            if (mv) G.ctx.input.move = { x: mv[0], z: mv[1] };
            ti++;
          }
          const dt = dm === 'jitter' ? 1 / 144 + rnd() * (1 / 30 - 1 / 144) : 1 / Number(dm);
          G.step(1, dt);
          t += dt;
          const s = m.state, rig = pl._rig;
          rig.footL.getWorldPosition(fl); rig.footR.getWorldPosition(fr);
          out.push({ t, dt, x: s.x, z: s.z, vx: s.vx, vz: s.vz, h: s.heading, cx: cam.target.x, cz: cam.target.z,
            camX: G.ctx.camera.position.x, camZ: G.ctx.camera.position.z,
            fl: [fl.x, fl.y, fl.z], fr: [fr.x, fr.y, fr.z], tile: [sim.player.x, sim.player.z, sim.player.dir] });
        }
        setKeys([]);
        G.ctx.input.move = { x: 0, z: 0 };
        return out;
      }, { sc: SCEN[name], dm });
      all[`${name}@${dm}`] = rows;
    }
    writeFileSync(out.replace(/\.png$/, '.json'), JSON.stringify(all));
    // ---- summary ----
    const SPEED = 4.2;
    const lines = [];
    for (const [key, rows] of Object.entries(all)) {
      let maxJump = 0, maxAcc = 0, maxDH = 0, camAcc = 0, camFlips = 0, prevSg = 0, slide = 0, maxRel = 0, relJerk = 0;
      for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1], b = rows[i];
        maxJump = Math.max(maxJump, Math.hypot(b.x - a.x, b.z - a.z) / (SPEED * b.dt));
        maxDH = Math.max(maxDH, Math.abs(Math.atan2(Math.sin(b.h - a.h), Math.cos(b.h - a.h))) / b.dt);
        if (i >= 2) {
          const z = rows[i - 2];
          const v1 = [(a.x - z.x) / a.dt, (a.z - z.z) / a.dt], v2 = [(b.x - a.x) / b.dt, (b.z - a.z) / b.dt];
          maxAcc = Math.max(maxAcc, Math.hypot(v2[0] - v1[0], v2[1] - v1[1]) / ((a.dt + b.dt) / 2));
          const c1 = [(a.cx - z.cx) / a.dt, (a.cz - z.cz) / a.dt], c2 = [(b.cx - a.cx) / b.dt, (b.cz - a.cz) / b.dt];
          const ca = Math.hypot(c2[0] - c1[0], c2[1] - c1[1]) / ((a.dt + b.dt) / 2);
          camAcc = Math.max(camAcc, ca);
          // camera jitter = sign flips of its acceleration along the main axis while the input is steady
          const acc = (c2[0] - c1[0]) + (c2[1] - c1[1]);
          const sg = ca < 0.3 ? 0 : Math.sign(acc); // ignore numerically tiny wiggles (< 0.3 tiles/s^2)
          if (sg && prevSg && sg !== prevSg) camFlips++;
          if (sg) prevSg = sg;
          // the player's offset from the camera target should change smoothly (no camera-vs-player fight)
          const r0 = [a.x - a.cx - (z.x - z.cx), a.z - a.cz - (z.z - z.cz)], r1 = [b.x - b.cx - (a.x - a.cx), b.z - b.cz - (a.z - a.cz)];
          relJerk = Math.max(relJerk, Math.hypot(r1[0] / b.dt - r0[0] / a.dt, r1[1] / b.dt - r0[1] / a.dt) / ((a.dt + b.dt) / 2));
        }
        maxRel = Math.max(maxRel, Math.hypot(b.x - b.cx, b.z - b.cz));
        // foot sliding: a foot on the ground (y < 0.004) that stays down between frames should not move
        for (const f of ['fl', 'fr']) if (a[f][1] < 1e-4 && b[f][1] < 1e-4 && Math.hypot(b.x - a.x, b.z - a.z) > SPEED * b.dt * 0.9) {
          slide = Math.max(slide, Math.hypot(b[f][0] - a[f][0], b[f][2] - a[f][2]));
        }
      }
      const last = rows[rows.length - 1];
      lines.push(`${key.padEnd(18)} jump<=${maxJump.toFixed(3)}x  acc<=${maxAcc.toFixed(0).padStart(3)}  dH<=${maxDH.toFixed(1).padStart(4)}rad/s  camAcc<=${camAcc.toFixed(1).padStart(5)}  camFlips=${camFlips}  relJerk<=${relJerk.toFixed(0).padStart(4)}  camLead<=${maxRel.toFixed(2)}  footSlide@full<=${slide.toFixed(4)}  end=(${last.x.toFixed(2)},${last.z.toFixed(2)}) tile=${last.tile.join(',')}`);
    }
    console.log(lines.join('\n'));
  } else if (mode === 'shot') {
    if (args.seq) await page.evaluate(`(async () => { ${args.seq} })()`);
    await page.evaluate(() => __game.step(1));
    await page.screenshot({ path: out, clip: args.clip ? (([x, y, width, height]) => ({ x, y, width, height }))(String(args.clip).split(',').map(Number)) : undefined });
  }
  console.log(`${mode} -> ${out}`);
  const ge = await page.evaluate(() => __game.errors || []);
  ge.forEach(e => logs.push(`GAME ${e}`));
} catch (e) { logs.push(`TOOL ${e.stack || e.message}`); }
console.log(logs.length ? '--- logs ---\n' + [...new Set(logs)].slice(0, 30).join('\n') : 'no errors');
await browser.close();
