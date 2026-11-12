// Headless screenshot / frame-sheet tool for checking the game without a visible browser.
// Renders on the real GPU (ANGLE D3D11) by default, so it is fast and light on the CPU; --swiftshader forces software.
// Needs the dev server running (node serve.mjs 4660).
//
//   node tools/shot.mjs --url "/?paused=1&scenario=factory&warm=10" --out shots/factory.png
//   node tools/shot.mjs --url "/?paused=1" --js "__game.sim.setPlayer(14,14,2)" --steps 30 --out a.png
//   node tools/shot.mjs --url "/?paused=1" --js "<start an animation>" --frames 12 --every 4 --sheet --out anim.png
//   node tools/shot.mjs ... --clip 600,300,500,400        (crop, CSS px)   --w 1600 --h 900 (viewport)
//
// --js runs in the page (async ok) after the game is ready; its return value is printed as JSON.
// --steps advances the game with __game.step(n) (deterministic, works with ?paused=1).
// --frames N --every K captures N frames, stepping K steps between them; --sheet tiles them into one image.
// --keys "KeyW:400,Space" presses keys (name:holdMs) after --js. --click x,y clicks the canvas (CSS px).
// Prints page errors, console errors/warnings and __game.errors.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const port = args.port || 4660;
const url = `http://localhost:${port}${args.url || '/?paused=1'}${(args.url || '').includes('shot') ? '' : ((args.url || '/?paused=1').includes('?') ? '&shot=1' : '?shot=1')}`;
const out = resolve(args.out || 'shots/shot.png');
const W = Number(args.w || 1600), H = Number(args.h || 900);
mkdirSync(dirname(out), { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: process.argv.includes('--swiftshader') ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] : ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'] /* real GPU (RTX); --swiftshader forces CPU rendering */,
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: Number(args.scale || 1) });
const logs = [];
page.on('pageerror', e => logs.push(`PAGEERROR ${e.message}`));
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`${m.type().toUpperCase()} ${m.text()}`); });

try {
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__game?.ready, null, { timeout: 60000 });
  if (args.js && args.js !== true) {
    const res = await page.evaluate(`(async () => { ${/\breturn\b/.test(args.js) ? args.js : `return (${args.js})`} })()`);
    if (res !== undefined) console.log('js ->', JSON.stringify(res, null, 0)?.slice(0, 4000));
  }
  if (args.keys && args.keys !== true) {
    for (const k of String(args.keys).split(',')) {
      const [key, hold] = k.split(':');
      await page.keyboard.down(key);
      await page.evaluate(n => window.__game.step(n), Math.max(1, Math.round((Number(hold) || 50) / 16.7)));
      await page.keyboard.up(key);
    }
  }
  if (args.click && args.click !== true) {
    const [x, y] = String(args.click).split(',').map(Number);
    await page.mouse.move(x, y); await page.mouse.down(); await page.evaluate(() => window.__game.step(2)); await page.mouse.up();
  }
  if (args.steps) await page.evaluate(n => window.__game.step(n), Number(args.steps));
  if (args.wait) await page.waitForTimeout(Number(args.wait));
  const clip = args.clip && args.clip !== true ? (([x, y, width, height]) => ({ x, y, width, height }))(String(args.clip).split(',').map(Number)) : undefined;

  if (args.frames) {
    const n = Number(args.frames), every = Number(args.every || 4);
    const frames = [];
    for (let i = 0; i < n; i++) {
      if (i > 0) await page.evaluate(k => window.__game.step(k), every);
      else await page.evaluate(() => window.__game.render());
      frames.push((await page.screenshot({ clip })).toString('base64'));
    }
    if (args.sheet) {
      const cols = Number(args.cols || Math.ceil(Math.sqrt(n)));
      const sheet = await browser.newPage();
      const dataUrl = await sheet.evaluate(async ({ frames, cols, label }) => {
        const imgs = await Promise.all(frames.map(b => new Promise(r => { const im = new Image(); im.onload = () => r(im); im.src = 'data:image/png;base64,' + b; })));
        const w = imgs[0].width, h = imgs[0].height, scale = Math.min(1, 2400 / (w * cols));
        const c = document.createElement('canvas');
        c.width = Math.round(w * cols * scale); c.height = Math.round(h * Math.ceil(imgs.length / cols) * scale);
        const g = c.getContext('2d');
        imgs.forEach((im, i) => {
          const x = (i % cols) * w * scale, y = Math.floor(i / cols) * h * scale;
          g.drawImage(im, x, y, w * scale, h * scale);
          if (label) { g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(x, y, 34, 18); g.fillStyle = '#fff'; g.font = '12px monospace'; g.fillText(String(i), x + 6, y + 13); }
        });
        return c.toDataURL('image/png');
      }, { frames, cols, label: true });
      const { writeFileSync } = await import('node:fs');
      writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
      console.log(`sheet (${n} frames, every ${every} steps) -> ${out}`);
    } else {
      const { writeFileSync } = await import('node:fs');
      frames.forEach((b, i) => writeFileSync(out.replace(/\.png$/, `_${String(i).padStart(2, '0')}.png`), Buffer.from(b, 'base64')));
      console.log(`${n} frames -> ${out.replace(/\.png$/, '_NN.png')}`);
    }
  } else {
    await page.evaluate(() => window.__game.render());
    await page.screenshot({ path: out, clip });
    console.log(`shot -> ${out}`);
  }
  const gameErrors = await page.evaluate(() => window.__game?.errors || []);
  gameErrors.forEach(e => logs.push(`GAME ${e}`));
} catch (e) {
  logs.push(`TOOL ${e.message}`);
  try { await page.screenshot({ path: out }); } catch {}
}
if (logs.length) console.log('--- logs ---\n' + [...new Set(logs)].slice(0, 40).join('\n'));
else console.log('no errors');
await browser.close();
