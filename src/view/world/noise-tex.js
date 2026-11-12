// Seamless, tileable value-noise fbm packed into an RGBA DataTexture (cached, shared by water and sky).
//   R: fbm, base period 4 (5 octaves)    G: fbm, base period 8 (4 octaves)
//   B: fbm, base period 16 (3 octaves)   A: fbm, base period 2 (5 octaves, very soft)
import * as THREE from 'three';

let cached = null;

function hash(i, j, seed) {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(seed, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const q = t => t * t * t * (t * (t * 6 - 15) + 10);

function periodicNoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const m = v => ((v % period) + period) % period;
  const x0 = m(xi), x1 = m(xi + 1), y0 = m(yi), y1 = m(yi + 1);
  const a = hash(x0, y0, seed), b = hash(x1, y0, seed), c = hash(x0, y1, seed), d = hash(x1, y1, seed);
  const u = q(xf), v = q(yf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(u, v, basePeriod, octaves, seed) {
  let sum = 0, amp = 0.5, norm = 0, p = basePeriod;
  for (let o = 0; o < octaves; o++) {
    sum += amp * periodicNoise(u * p, v * p, p, seed + o * 31);
    norm += amp; amp *= 0.5; p *= 2;
  }
  return sum / norm;
}

export function getNoiseTexture(size = 256) {
  if (cached) return cached;
  const data = new Uint8Array(size * size * 4);
  const spec = [[4, 5, 11], [8, 4, 23], [16, 3, 37], [2, 5, 53]];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    for (let c = 0; c < 4; c++) {
      const [p, o, s] = spec[c];
      // stretch contrast a little around the mean so thresholds have range to work with
      const n = (fbm(u, v, p, o, s) - 0.5) * 1.6 + 0.5;
      data[(y * size + x) * 4 + c] = Math.max(0, Math.min(255, Math.round(n * 255)));
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  cached = tex;
  return tex;
}
