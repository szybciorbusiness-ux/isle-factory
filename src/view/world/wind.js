// Shared wind field. One scrolling, low-frequency noise field drives everything that moves in the wind:
// the dense grass blades, the edge and field tufts, flowers and the light streaks on the grass cap.
// Gust fronts are stretched across the wind direction and travel downwind, so they read as rolling waves
// of bent, brighter grass sweeping over the islands (wind over a meadow).
//
// GLSL: include WIND_GLSL once in a shader (it declares `uniform float uWindTime`), then call
//   windGust(xz)              -> 0..1 gust strength at a world point
//   windSheen(xz)             -> light-streak amount: the gust crest, a little negative in the trough behind it
//   windLean(xz, phase, gust) -> lean along WIND_DIR (fraction of blade height); `gust` is an out parameter
// JS:   gustAt(x, z, t) mirrors windGust (other modules' foliage, tests). views.terrain.wind wraps it.
// Time comes from the dt-advanced uniform (terrain.update), never from wall-clock time.

export const WIND = {
  dir: normalize2(0.9, 0.44),  // world xz, gusts travel this way (east-south-east: left -> right on screen)
  speed: 1.7,                  // tiles per second the gust fronts travel
  along: 0.27,                 // noise frequency along the wind (smaller = longer gaps between fronts)
  across: 0.1,                 // noise frequency across the wind (smaller = longer fronts)
  base: 0.14,                  // constant lean (fraction of blade height)
  gust: 0.78,                  // extra lean inside a gust
  flutter: 0.08,               // per-blade flutter
  streak: 0.55,                // cap / blade brightening at a gust crest
  trough: 0.35,                // darkening just upwind of a crest (the back of the rolling wave)
};

function normalize2(x, z) { const l = Math.hypot(x, z); return [x / l, z / l]; }
const f = v => v.toFixed(5);

export const WIND_GLSL = /* glsl */`
uniform float uWindTime;
uniform float uSheen;   // light-streak gain (1 = default)
#define WIND_DIR vec2(${f(WIND.dir[0])}, ${f(WIND.dir[1])})
float windHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float windNoise(vec2 p) {
  vec2 i = floor(p), fr = fract(p);
  vec2 u = fr * fr * (3.0 - 2.0 * fr);
  float a = windHash(i), b = windHash(i + vec2(1.0, 0.0));
  float c = windHash(i + vec2(0.0, 1.0)), d = windHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float windGust(vec2 p) {
  vec2 q = vec2(dot(p, WIND_DIR), dot(p, vec2(-WIND_DIR.y, WIND_DIR.x)));
  float a = q.x - uWindTime * ${f(WIND.speed)};
  float n = windNoise(vec2(a * ${f(WIND.along)}, q.y * ${f(WIND.across)} + uWindTime * 0.02)) * 0.66
          + windNoise(vec2(a * ${f(WIND.along * 2.1)} + 7.3, q.y * ${f(WIND.across * 2.3)} - uWindTime * 0.05 + 1.7)) * 0.34;
  // rolling crests inside the gusty regions
  float crest = 0.5 + 0.5 * sin(a * 1.05 + n * 4.0);
  crest *= crest;
  return smoothstep(0.32, 0.72, n) * (0.3 + 0.7 * crest);
}
float windSheen(vec2 p) {
  float g = windGust(p);
  float back = windGust(p - WIND_DIR * 1.2);
  return (g - ${f(WIND.trough)} * max(back - g, 0.0)) * uSheen;
}
float windLean(vec2 p, float phase, out float gust) {
  gust = windGust(p);
  float fl = sin(uWindTime * 2.1 + phase) * 0.6 + sin(uWindTime * 3.4 + phase * 1.7) * 0.4;
  return ${f(WIND.base)} + gust * ${f(WIND.gust)} + fl * ${f(WIND.flutter)} * (0.5 + gust);
}
`;

// ---- JS mirror (float64 instead of GPU float32: matches closely, not bit-exactly) ----
const fract = v => v - Math.floor(v);
function hash(x, y) {
  let a = fract(x * 0.1031), b = fract(y * 0.1031), c = fract(x * 0.1031);
  const s = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33);
  a += s; b += s; c += s;
  return fract((a + b) * c);
}
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
  return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
}
const smooth = (e0, e1, v) => { const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
export function gustAt(x, z, t) {
  const [dx, dz] = WIND.dir;
  const qa = x * dx + z * dz, qc = -x * dz + z * dx;
  const a = qa - t * WIND.speed;
  const n = vnoise(a * WIND.along, qc * WIND.across + t * 0.02) * 0.66
          + vnoise(a * WIND.along * 2.1 + 7.3, qc * WIND.across * 2.3 - t * 0.05 + 1.7) * 0.34;
  let crest = 0.5 + 0.5 * Math.sin(a * 1.05 + n * 4);
  crest *= crest;
  return smooth(0.32, 0.72, n) * (0.3 + 0.7 * crest);
}
// Lean (fraction of height, along WIND.dir) that the grass has at a point, without the per-blade flutter.
export function leanAt(x, z, t) { return WIND.base + gustAt(x, z, t) * WIND.gust; }
