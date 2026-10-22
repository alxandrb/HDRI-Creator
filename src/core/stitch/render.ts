import { fromHalf } from '../half';
import type { M3 } from './geometry';

export interface RenderView {
  width: number;
  height: number;
  /** RGB demi-flottant linéaire. */
  data: Uint16Array;
  /** Focale en pixels à cette résolution. */
  f: number;
  /** Rotation caméra → monde. */
  rot: M3;
  gain: number;
}

let halfLut: Float32Array | null = null;
function lut(): Float32Array {
  if (!halfLut) {
    halfLut = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) halfLut[i] = fromHalf(i);
  }
  return halfLut;
}

/**
 * Projette toutes les vues dans une panorama équirectangulaire avec fondu linéaire (poids maximal au centre
 * de chaque photo). Retourne aussi la proportion de la sphère couverte.
 */
export function renderEquirect(views: RenderView[], ow: number, oh: number, yawDeg: number, onRow?: (y: number) => void): { rgb: Float32Array; coverage: number } {
  const L = lut();
  const out = new Float32Array(ow * oh * 3);
  const weight = new Float32Array(ow * oh);
  const yaw = (yawDeg / 360) * 2 * Math.PI;
  const sinLon = new Float64Array(ow);
  const cosLon = new Float64Array(ow);
  for (let x = 0; x < ow; x++) {
    const lon = ((x + 0.5) / ow - 0.5) * 2 * Math.PI + yaw;
    sinLon[x] = Math.sin(lon);
    cosLon[x] = Math.cos(lon);
  }
  const prepared = views.map((v) => {
    const r = v.rot;
    const halfDiag = Math.atan(Math.hypot(v.width, v.height) / 2 / v.f);
    return { ...v, cosLimit: Math.cos(Math.min(halfDiag + 0.01, Math.PI / 2 - 0.01)), cx: v.width / 2, cy: v.height / 2,
      // Monde → caméra = Rᵀ ; on garde les colonnes de R.
      r0: [r[0], r[3], r[6]], r1: [r[1], r[4], r[7]], r2: [r[2], r[5], r[8]] };
  });
  let covered = 0;
  let total = 0;
  for (let y = 0; y < oh; y++) {
    const lat = (0.5 - (y + 0.5) / oh) * Math.PI;
    const cl = Math.cos(lat);
    const sl = Math.sin(lat);
    for (let x = 0; x < ow; x++) {
      const dx = -sinLon[x] * cl;
      const dy = sl;
      const dz = cosLon[x] * cl;
      const p = y * ow + x;
      for (const v of prepared) {
        const cz = v.r2[0] * dx + v.r2[1] * dy + v.r2[2] * dz;
        if (cz < v.cosLimit) continue;
        const cxv = v.r0[0] * dx + v.r0[1] * dy + v.r0[2] * dz;
        const cyv = v.r1[0] * dx + v.r1[1] * dy + v.r1[2] * dz;
        // Rayon caméra = normalise(−x, −y, f).
        const px = (-cxv / cz) * v.f + v.cx;
        const py = (-cyv / cz) * v.f + v.cy;
        if (px < 0.5 || py < 0.5 || px > v.width - 0.5 || py > v.height - 0.5) continue;
        const wx = Math.min(px, v.width - px) / v.cx;
        const wy = Math.min(py, v.height - py) / v.cy;
        const w = wx * wy + 1e-6;
        const sx = px - 0.5;
        const sy = py - 0.5;
        const x0 = Math.min(v.width - 2, Math.floor(sx));
        const y0 = Math.min(v.height - 2, Math.floor(sy));
        const fx = sx - x0;
        const fy = sy - y0;
        const a = (y0 * v.width + x0) * 3;
        const b = a + 3;
        const c = a + v.width * 3;
        const d = c + 3;
        const k = w * v.gain;
        for (let ch = 0; ch < 3; ch++) {
          const top = L[v.data[a + ch]] + (L[v.data[b + ch]] - L[v.data[a + ch]]) * fx;
          const bot = L[v.data[c + ch]] + (L[v.data[d + ch]] - L[v.data[c + ch]]) * fx;
          out[p * 3 + ch] += k * (top + (bot - top) * fy);
        }
        weight[p] += w;
      }
      // Aire de la sphère ∝ cos(lat).
      total += cl;
      if (weight[p] > 0) covered += cl;
    }
    onRow?.(y);
  }
  for (let p = 0; p < ow * oh; p++) {
    const w = weight[p];
    if (w > 0) {
      out[p * 3] /= w;
      out[p * 3 + 1] /= w;
      out[p * 3 + 2] /= w;
    }
  }
  fillHoles(out, weight, ow, oh);
  return { rgb: out, coverage: total ? covered / total : 0 };
}

/**
 * Remplit les zones non couvertes (souvent zénith/nadir) par « push-pull » : moyenne pondérée
 * sur une pyramide, puis remontée en ne remplaçant que les pixels vides. Couture horizontale cyclique.
 */
export function fillHoles(rgb: Float32Array, weight: Float32Array, w: number, h: number): void {
  if (weight.every((v) => v > 0)) return;
  type Level = { rgb: Float32Array; wt: Float32Array; w: number; h: number };
  const levels: Level[] = [{ rgb: Float32Array.from(rgb), wt: weight.map((v) => (v > 0 ? 1 : 0)), w, h }];
  while (levels[levels.length - 1].w > 1 || levels[levels.length - 1].h > 1) {
    const s = levels[levels.length - 1];
    const nw = Math.max(1, Math.ceil(s.w / 2));
    const nh = Math.max(1, Math.ceil(s.h / 2));
    const nr = new Float32Array(nw * nh * 3);
    const nwt = new Float32Array(nw * nh);
    for (let y = 0; y < s.h; y++)
      for (let x = 0; x < s.w; x++) {
        const sp = y * s.w + x;
        const wt = s.wt[sp];
        if (!wt) continue;
        const dp = (y >> 1) * nw + (x >> 1);
        nwt[dp] += wt;
        for (let c = 0; c < 3; c++) nr[dp * 3 + c] += s.rgb[sp * 3 + c] * wt;
      }
    for (let p = 0; p < nw * nh; p++) if (nwt[p] > 0) for (let c = 0; c < 3; c++) nr[p * 3 + c] /= nwt[p];
    levels.push({ rgb: nr, wt: nwt.map((v) => Math.min(1, v)), w: nw, h: nh });
  }
  for (let l = levels.length - 2; l >= 0; l--) {
    const s = levels[l];
    const up = levels[l + 1];
    for (let y = 0; y < s.h; y++)
      for (let x = 0; x < s.w; x++) {
        const p = y * s.w + x;
        if (s.wt[p] >= 1) continue;
        // Interpolation bilinéaire du niveau grossier (cyclique en x).
        const gx = (x + 0.5) / 2 - 0.5;
        const gy = Math.max(0, Math.min(up.h - 1, (y + 0.5) / 2 - 0.5));
        const x0 = Math.floor(gx);
        const y0 = Math.floor(gy);
        const y1 = Math.min(up.h - 1, y0 + 1);
        const fx = gx - x0;
        const fy = gy - y0;
        const xa = ((x0 % up.w) + up.w) % up.w;
        const xb = (xa + 1) % up.w;
        const k = 1 - s.wt[p];
        for (let c = 0; c < 3; c++) {
          const v =
            (up.rgb[(y0 * up.w + xa) * 3 + c] * (1 - fx) + up.rgb[(y0 * up.w + xb) * 3 + c] * fx) * (1 - fy) +
            (up.rgb[(y1 * up.w + xa) * 3 + c] * (1 - fx) + up.rgb[(y1 * up.w + xb) * 3 + c] * fx) * fy;
          s.rgb[p * 3 + c] = s.rgb[p * 3 + c] * s.wt[p] + v * k;
        }
        s.wt[p] = 1;
      }
  }
  for (let p = 0; p < w * h; p++) if (!(weight[p] > 0)) for (let c = 0; c < 3; c++) rgb[p * 3 + c] = levels[0].rgb[p * 3 + c];
}
