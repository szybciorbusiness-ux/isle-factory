// Playtest: a bot plays the first N minutes of the camp IN THE REAL GAME (headless Chromium, phone portrait),
// steering the robot through ctx.input.move exactly like the touch joystick does, following camp.nextGoal().
// It captures a frame shortly after every beat (pad done, level up, bridge, worker, firsts) plus one per minute,
// and writes a timeline. Critics review the frames for UI, feel and understanding.
// Beats that land together share one frame ("done hearth:2 + camp level 2"). timeline.json also records, per frame,
// the guide goal and the stack, plus summary.noGoal (time with no guide target) and summary.gaps (longest gaps
// between beats).
//   node tools/playtest.mjs [minutes=20] [--out shots/playtest] [--landscape] [--every 60]
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const minutes = Number(argv.find(a => /^\d+(\.\d+)?$/.test(a))) || 20;
const outDir = resolve(argv[argv.indexOf('--out') + 1] && argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'shots/playtest');
const landscape = argv.includes('--landscape');
const every = Number(argv.includes('--every') ? argv[argv.indexOf('--every') + 1] : 60);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const vp = landscape ? { width: 1280, height: 720 } : { width: 402, height: 874 };
const url = `http://localhost:4660/?paused=1&camp=1&fresh=1&fixeddpr${landscape ? '' : '&mobile=1&safeTop=59&safeBottom=24'}`;
const browser = await chromium.launch({ args: process.argv.includes('--swiftshader') ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] : ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'] /* real GPU (RTX); --swiftshader forces CPU rendering */ });
const page = await browser.newPage({ viewport: vp, deviceScaleFactor: landscape ? 1 : 2 });
const logs = [];
page.on('pageerror', e => logs.push(`PAGEERROR ${e.message}`));
page.on('console', m => { if (m.type() === 'error') logs.push(`ERROR ${m.text().slice(0, 300)}`); });
await page.goto(url, { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction(() => window.__game?.ready && window.__game.camp, null, { timeout: 90000 });

// ---- the bot lives in the page ----
await page.evaluate(() => {
  const g = window.__game, camp = g.camp, ctx = g.ctx;
  const beats = [];
  const firsts = new Set();
  const beat = (label, important = true) => beats.push({ t: camp.time, label, important });
  const ev = ctx.events;
  ev.on('pad:complete', ({ pad }) => beat(`done ${pad.id}`));
  ev.on('hearth:level', ({ level }) => beat(`camp level ${level}`));
  ev.on('bridge:built', ({ bridge }) => beat(`bridge ${bridge.id}`));
  ev.on('worker:hired', ({ worker }) => beat(`worker ${worker.role}`));
  ev.on('pad:paid', ({ pad }) => { if (!firsts.has('pay')) { firsts.add('pay'); beat(`first payment ${pad.id}`); } });
  ev.on('station:drop', ({ by }) => { if (by === 'player' && !firsts.has('drop')) { firsts.add('drop'); beat('first drop at a station'); } });
  ev.on('pile:take', ({ by }) => { if (by === 'player' && !firsts.has('pick')) { firsts.add('pick'); beat('first pickup from a pile'); } });
  ev.on('animal:killed', ({ by }) => { if (by === 'player' && !firsts.has('hunt')) { firsts.add('hunt'); beat('first hunt'); } });
  ev.on('resource:depleted', ({ entity }) => { if (entity.kind === 'tree' && !firsts.has('tree')) { firsts.add('tree'); beat('first tree felled'); } });
  ev.on('camp:stackFull', () => { if (!firsts.has('full')) { firsts.add('full'); beat('stack full for the first time', false); } });

  const pos = () => g.views.player?.getPosition?.() || { x: g.sim.player.x, z: g.sim.player.z };
  let path = null, pi = 0, goal = null, think = 0, stuck = 0, last = null;
  function plan() {
    goal = camp.nextGoal();
    if (!goal) { path = null; return; }
    const p = pos(), sx = Math.round(p.x), sz = Math.round(p.z);
    const tx = Math.round(goal.x), tz = Math.round(goal.z);
    const isGoal = (goal.kind === 'gather' || goal.kind === 'hunt')
      ? (x, z) => Math.max(Math.abs(x - tx), Math.abs(z - tz)) <= 1 && !(x === tx && z === tz)
      : (x, z) => x === tx && z === tz;
    path = camp.bfs(sx, sz, isGoal); pi = 1;
  }
  // stretches where camp.nextGoal() gives nothing (no guide arrow on screen: the player has no "go here")
  const noGoal = { total: 0, stretches: [], cur: null };
  window.__bot = {
    beats, noGoal,
    get goal() { return goal; },
    tick(dt) {
      if ((think -= dt) <= 0) { think = 0.4; plan(); }
      if (!goal && !camp.complete) { noGoal.total += dt; if (!noGoal.cur) noGoal.stretches.push(noGoal.cur = { from: camp.time, to: camp.time }); noGoal.cur.to = camp.time; }
      else noGoal.cur = null;
      const p = pos();
      let tx = null, tz = null, near = 0.12;
      if (path && pi < path.length) {
        [tx, tz] = path[pi];
        if (Math.hypot(tx - p.x, tz - p.z) < 0.3) { pi++; }
      } else if (goal) {
        tx = goal.x; tz = goal.z;
        if (goal.kind === 'hunt') { const a = camp.animals.get(goal.animalId); if (a && !a.dead) { tx = a.x; tz = a.z; } near = 0.9; }
        else if (goal.kind === 'gather') near = 1.0;
      }
      let mx = 0, mz = 0;
      if (tx != null) { const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz); if (d > near) { mx = dx / d; mz = dz / d; } }
      ctx.input.move.x = mx; ctx.input.move.z = mz; ctx.input.active = mx !== 0 || mz !== 0;
      // unstick: if we want to move but don't, re-plan
      if (last && (mx || mz) && Math.hypot(p.x - last.x, p.z - last.z) < 0.002) { if ((stuck += dt) > 1.2) { stuck = 0; think = 0; path = null; } } else stuck = 0;
      last = { x: p.x, z: p.z };
    },
  };
});

const fmt = t => `${Math.floor(t / 60)}m${String(Math.floor(t % 60)).padStart(2, '0')}s`;
const dt = 1 / 30;
const total = minutes * 60;
let captured = 0, nextPeriodic = 0, seenBeats = 0;
const timeline = [];
async function capture(label) {
  await page.evaluate(() => window.__game.render());
  // what the guide is pointing at and what the robot carries, so reviewers can read each frame
  const { t, goal, stack } = await page.evaluate(() => {
    const c = window.__game.camp, gl = window.__bot.goal;
    return { t: c.time, goal: gl ? [gl.kind, gl.item, gl.padId || gl.stationId].filter(Boolean).join(' ') : 'none', stack: `${c.stack.length}/${c.capacity}` };
  });
  const name = `${String(captured++).padStart(3, '0')}_${fmt(t)}_${label.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}.png`;
  await page.screenshot({ path: resolve(outDir, name) });
  timeline.push({ t: +t.toFixed(1), label, goal, stack, file: name });
}
await capture('start');
const CHUNK = 15; // ticks per round trip
for (let t = 0; t < total; t += dt * CHUNK) {
  await page.evaluate(([n, d]) => { for (let i = 0; i < n; i++) { window.__bot.tick(d); window.__game.tick(1, d); } }, [CHUNK, dt]);
  const state = await page.evaluate(() => ({ t: window.__game.camp.time, beats: window.__bot.beats.length }));
  if (state.beats > seenBeats) {
    const newBeats = await page.evaluate(i => window.__bot.beats.slice(i), seenBeats);
    seenBeats = state.beats;
    // let the moment play out a little, then capture
    await page.evaluate(([n, d]) => { for (let i = 0; i < n; i++) { window.__bot.tick(d); window.__game.tick(1, d); } }, [24, dt]);
    // beats that land together (pad done + camp level, hire + worker) show the same moment: one frame for the batch
    const labels = newBeats.filter(b => b.important).map(b => b.label);
    if (labels.length) await capture(labels.join(' + '));
  }
  if (state.t >= nextPeriodic) { await capture(`minute ${Math.round(state.t / 60)}`); nextPeriodic += every; }
}
const summary = await page.evaluate(() => {
  const c = window.__game.camp;
  const mmss = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  const imp = window.__bot.beats.filter(b => b.important);
  // longest stretches between progress beats (where the first 20 minutes can sag)
  const gaps = imp.slice(1).map((b, i) => ({ from: mmss(imp[i].t), to: mmss(b.t), s: Math.round(b.t - imp[i].t), after: imp[i].label, next: b.label }))
    .sort((a, b) => b.s - a.s).slice(0, 5);
  const ng = window.__bot.noGoal;
  return {
    level: c.level, capacity: c.capacity, workers: c.workers.size, bridges: [...c.bridges], pads: c.pads.map(p => p.id),
    beats: window.__bot.beats.map(b => `${mmss(b.t)} ${b.label}`),
    noGoal: { seconds: Math.round(ng.total), stretches: ng.stretches.filter(s => s.to - s.from >= 3).map(s => `${mmss(s.from)}-${mmss(s.to)}`) },
    gaps, errors: window.__game.errors,
  };
});
writeFileSync(resolve(outDir, 'timeline.json'), JSON.stringify({ minutes, viewport: vp, timeline, summary, logs: [...new Set(logs)].slice(0, 30) }, null, 2));
console.log(summary.beats.join('\n'));
console.log(`\nlevel ${summary.level}, workers ${summary.workers}, bridges ${summary.bridges.join(',') || '-'}; ${captured} frames -> ${outDir}`);
console.log(`no guide goal for ${summary.noGoal.seconds}s${summary.noGoal.stretches.length ? ` (3 s+: ${summary.noGoal.stretches.join(', ')})` : ''}`);
console.log('longest gaps between beats: ' + summary.gaps.map(g => `${g.s}s ${g.from}-${g.to} (${g.after} -> ${g.next})`).join('; '));
if (logs.length) console.log('--- logs ---\n' + [...new Set(logs)].slice(0, 15).join('\n'));
await browser.close();
