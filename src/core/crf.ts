import { solveSPD } from './linalg';
import { srgbToLinear } from './color';

/** Courbe de réponse inverse : g[z] = ln(exposition) pour la valeur de pixel z. */
export type Crf = [Float64Array, Float64Array, Float64Array];

const MID_LN = Math.log(srgbToLinear(128 / 255));

export function debevecWeight(z: number): number {
  return z <= 127 ? z + 1 : 256 - z;
}

export function srgbCrf(): Crf {
  const g = new Float64Array(256);
  for (let z = 0; z < 256; z++) g[z] = Math.log(Math.max(srgbToLinear(z / 255), 1e-4));
  return [g, g.slice(), g.slice()];
}

/**
 * Debevec & Malik (1997) : estime g à partir de P échantillons observés sur N poses.
 * zs[j][i] = valeur du pixel échantillon i dans l'image j, lnT[j] = ln(exposition) de l'image j.
 */
export function solveDebevec(zs: Uint8Array[], lnT: number[], lambda = 50): Float64Array {
  const P = zs[0].length;
  const n = 256 + P;
  const A = new Float64Array(n * n);
  const b = new Float64Array(n);

  for (let j = 0; j < zs.length; j++) {
    for (let i = 0; i < P; i++) {
      const z = zs[j][i];
      const w2 = debevecWeight(z) ** 2;
      const e = 256 + i;
      A[z * n + z] += w2;
      A[e * n + e] += w2;
      A[z * n + e] -= w2;
      A[e * n + z] -= w2;
      b[z] += w2 * lnT[j];
      b[e] -= w2 * lnT[j];
    }
  }
  A[128 * n + 128] += 1;
  for (let z = 1; z < 255; z++) {
    const w = lambda * debevecWeight(z);
    const idx = [z - 1, z, z + 1];
    const coef = [w, -2 * w, w];
    for (let a = 0; a < 3; a++) for (let c = 0; c < 3; c++) A[idx[a] * n + idx[c]] += coef[a] * coef[c];
  }
  for (let i = 0; i < n; i++) A[i * n + i] += 1e-9;

  const x = solveSPD(A, b, n);
  const g = x.slice(0, 256);
  // Recalage pour coïncider avec sRGB au gris moyen, puis monotonie stricte.
  const off = MID_LN - g[128];
  for (let z = 0; z < 256; z++) g[z] += off;
  for (let z = 129; z < 256; z++) if (g[z] <= g[z - 1]) g[z] = g[z - 1] + 1e-4;
  for (let z = 127; z >= 0; z--) if (g[z] >= g[z + 1]) g[z] = g[z + 1] - 1e-4;
  return g;
}

export interface SampleSource {
  rgb: Uint8Array;
  width: number;
  height: number;
  shift: [number, number];
}

/** Choisit des pixels répartis sur toute la plage tonale, dans des zones lisses de l'image de référence. */
export function sampleForCrf(images: SampleSource[], refIndex: number, count: number, seed = 1): Uint8Array[][] {
  const ref = images[refIndex];
  const { width: w, height: h } = ref;
  let s = seed >>> 0 || 1;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const bins: number[][] = Array.from({ length: 32 }, () => []);
  const lum = (img: SampleSource, x: number, y: number) => {
    const o = (y * img.width + x) * 3;
    return (img.rgb[o] * 54 + img.rgb[o + 1] * 183 + img.rgb[o + 2] * 19) >> 8;
  };
  const margin = images.reduce((m, im) => Math.max(m, Math.abs(im.shift[0]), Math.abs(im.shift[1])), 0) + 2;
  for (let t = 0; t < 40000; t++) {
    const x = margin + Math.floor(rand() * (w - 2 * margin - 1));
    const y = margin + Math.floor(rand() * (h - 2 * margin - 1));
    if (x < 0 || y < 0) break;
    const l = lum(ref, x, y);
    const grad = Math.abs(lum(ref, x + 1, y) - l) + Math.abs(lum(ref, x, y + 1) - l);
    if (grad > 10) continue;
    const bin = bins[l >> 3];
    if (bin.length < count) bin.push(y * w + x);
  }
  const perBin = Math.ceil(count / 32);
  const picks: number[] = [];
  for (let round = 0; picks.length < count && round < count; round++) {
    let added = false;
    for (const bin of bins) {
      if (round < bin.length && picks.length < count) { picks.push(bin[round]); added = true; }
    }
    if (!added || round > perBin * 4) break;
  }
  return [0, 1, 2].map((c) =>
    images.map((img) => {
      const out = new Uint8Array(picks.length);
      picks.forEach((p, i) => {
        const x = (p % w) + img.shift[0];
        const y = Math.floor(p / w) + img.shift[1];
        out[i] = img.rgb[(y * img.width + x) * 3 + c];
      });
      return out;
    }),
  );
}
