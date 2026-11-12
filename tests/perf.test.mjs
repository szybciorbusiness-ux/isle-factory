// Performance: a 600+ belt map full of items must update in well under 1 ms per tick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { makeSim, loopBelts, line, place, run, beltItems, assertNoOverlap, DT, E, S } from './helpers.test.mjs';

// w x h snake loop (h even), belts in lane order
function snakePts(x0, z0, w, h) {
  const pts = [];
  for (let r = 0; r < h; r++) for (let i = 0; i < w - 1; i++) pts.push([r % 2 === 0 ? x0 + 1 + i : x0 + w - 1 - i, z0 + r]);
  for (let z = z0 + h - 1; z >= z0; z--) pts.push([x0, z]);
  return pts;
}

function buildStress() {
  const sim = makeSim({ w: 64, h: 64, deposits: Array.from({ length: 20 }, (_, i) => [2 + i * 3, 60, 1]) });
  const loops = [];
  // 8 snake loops of 10 x 8 = 640 belts
  for (let i = 0; i < 8; i++) loops.push(loopBelts(sim, snakePts(1 + (i % 4) * 15, 1 + Math.floor(i / 4) * 12, 12, 8)));
  // a line with drills side-loading and a straight merge, into chests (the open-ended part of a factory)
  const main = line(sim, 1, 58, E, 60);
  for (let i = 0; i < 20; i++) place(sim, 'drill', 2 + i * 3, 60, 3 /* north, onto (x, 59) */);
  for (let i = 0; i < 20; i++) place(sim, 'belt', 2 + i * 3, 59, 3); // side-load up into the main line
  place(sim, 'chest', 61, 58);
  void S; void main;
  let n = 0;
  for (const loop of loops) {
    let at = 0.1, total = 0;
    for (const b of loop) {
      const len = sim.beltLength(b);
      while (at < total + len - 1e-6) { if (sim.spawnBeltItem(b.id, 'stone', (at - total) / len)) n++; at += 0.4; }
      total += len;
    }
  }
  return { sim, n };
}

test('600+ belts with items update in well under 1 ms per tick', () => {
  const { sim, n } = buildStress();
  assert.ok(sim.belts.size >= 600, `${sim.belts.size} belts`);
  assert.ok(n >= 1000, `${n} items`);
  run(sim, 2); // warm up (JIT)
  // best of several batches, so other processes hogging the CPU don't make this flaky
  let ms = Infinity;
  for (let k = 0; k < 8; k++) {
    const t0 = performance.now();
    for (let i = 0; i < 150; i++) sim.update(DT);
    ms = Math.min(ms, (performance.now() - t0) / 150);
  }
  console.log(`  stress: ${sim.belts.size} belts, ${beltItems(sim).length} belt items, ${ms.toFixed(4)} ms / tick`);
  assert.ok(ms < 0.5, `${ms.toFixed(3)} ms per tick`);
  assertNoOverlap(sim, 'stress');
});

test('placing hundreds of belts one by one stays fast (links rebuild per build)', () => {
  const t0 = performance.now();
  const { sim } = buildStress();
  const ms = performance.now() - t0;
  console.log(`  build 700 belts + seed: ${ms.toFixed(1)} ms`);
  assert.ok(ms < 1500, `${ms.toFixed(0)} ms`);
  void sim;
});
