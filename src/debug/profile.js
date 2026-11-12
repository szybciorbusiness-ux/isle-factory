// GPU profiler (real GPU only; SwiftShader numbers are meaningless). In the page:
//   const r = await (await import('/src/debug/profile.js')).profile(window.__game, { megapixels: 2.07 })
// Keeps the GPU busy (so clocks don't drift), then measures each piece by switching it off, interleaved with
// fresh baseline frames, and reports the median GPU ms of the full frame and what each piece costs.
// megapixels temporarily sets the render size (1080p ≈ 2.07 MP; phone 402x874 @1.6x ≈ 0.9 MP).
export async function profile(g, { megapixels = null, frames = 14 } = {}) {
  const R = g.ctx.renderer, gl = R.getContext(), sc = g.ctx.scene, v = g.views;
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext) return { error: 'EXT_disjoint_timer_query_webgl2 not available' };
  const dpr0 = R.getPixelRatio();
  const setMP = mp => { R.setPixelRatio(Math.sqrt((mp * 1e6) / (innerWidth * innerHeight))); v.post?.resize?.(innerWidth, innerHeight); };
  if (megapixels) setMP(megapixels);
  const px = new Uint8Array(4);
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const timed = async (n) => {
    const qs = [];
    for (let i = 0; i < n; i++) { const q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); g.render(); gl.endQuery(ext.TIME_ELAPSED_EXT); qs.push(q); }
    sync();
    for (let k = 0; k < 40 && !gl.getQueryParameter(qs[qs.length - 1], gl.QUERY_RESULT_AVAILABLE); k++) await new Promise(r => setTimeout(r, 5));
    const ms = qs.slice(3).map(q => gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
    qs.forEach(q => gl.deleteQuery(q));
    ms.sort((a, b) => a - b);
    return ms[ms.length >> 1];
  };
  // warm up: compile, upload, and get the GPU to steady clocks
  for (let i = 0; i < 50; i++) g.render();
  sync();
  const hideBy = test => { const objs = sc.children.filter(test); return [() => objs.forEach(o => (o.userData.__v = o.visible, o.visible = false)), () => objs.forEach(o => (o.visible = o.userData.__v))]; };
  const named = prefix => hideBy(o => (o.name || '').toLowerCase().startsWith(prefix));
  const post = v.post?.render;
  const tests = [
    ['post', () => { v.post.render = undefined; }, () => { v.post.render = post; }],
    ['shadows', () => { R.shadowMap.enabled = false; }, () => { R.shadowMap.enabled = true; R.shadowMap.needsUpdate = true; }],
    ['clouds', ...named('cloud')], ['water', ...named('water')], ['terrain', ...named('terrain')],
    ['camp', ...named('campview')], ['creatures', ...named('creatures')], ['player', ...named('player')], ['pads', ...named('pad')],
    ['props', ...hideBy(o => o.isInstancedMesh && !o.name)],
  ].filter(([k]) => k !== 'post' || post);
  const out = { megapixels: +(innerWidth * innerHeight * R.getPixelRatio() ** 2 / 1e6).toFixed(2), frameGpuMs: 0, cost: {} };
  const bases = [];
  for (const [label, on, off] of tests) {
    const base = await timed(frames);
    on(); for (let i = 0; i < 4; i++) g.render();
    const without = await timed(frames);
    off(); for (let i = 0; i < 4; i++) g.render();
    bases.push(base);
    out.cost[label] = +(base - without).toFixed(2);
  }
  bases.sort((a, b) => a - b);
  out.frameGpuMs = +bases[bases.length >> 1].toFixed(2);
  if (megapixels) { R.setPixelRatio(dpr0); v.post?.resize?.(innerWidth, innerHeight); }
  return out;
}
