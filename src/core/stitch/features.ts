import { rng } from './geometry';

export interface Features {
  /** Coordonnées (x, y) en pixels, entrelacées. */
  points: Float32Array;
  /** Descripteurs binaires 256 bits : 8 × uint32 par point. */
  desc: Uint32Array;
  count: number;
}

const PATCH = 15;
const BORDER = 23;

// 256 tests de comparaison dans un patch 31×31, tirage gaussien fixe (rBRIEF).
const PAIRS = (() => {
  const r = rng(0x5eed);
  const gauss = () => {
    const u = Math.max(1e-9, r());
    const v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * (PATCH / 2.5);
  };
  const clamp = (v: number) => Math.max(-PATCH, Math.min(PATCH, Math.round(v)));
  const out = new Int8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    let a: number[];
    do a = [gauss(), gauss(), gauss(), gauss()].map(clamp);
    while (a[0] === a[2] && a[1] === a[3]);
    out.set(a, i * 4);
  }
  return out;
})();

function blurF(src: Float32Array, w: number, h: number): Float32Array {
  return blur(src, w, h);
}

function blur(src: ArrayLike<number>, w: number, h: number): Float32Array {
  // Flou gaussien séparable 5 taps (1 4 6 4 1)/16.
  const k = [1, 4, 6, 4, 1];
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -2; i <= 2; i++) s += k[i + 2] * src[y * w + Math.min(w - 1, Math.max(0, x + i))];
      tmp[y * w + x] = s / 16;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -2; i <= 2; i++) s += k[i + 2] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
      out[y * w + x] = s / 16;
    }
  return out;
}

/**
 * Coins de Harris répartis sur une grille + descripteurs binaires orientés.
 * `max` limite le nombre de points (répartis équitablement entre les cellules).
 */
export function detectFeatures(gray: Uint8Array, w: number, h: number, max = 700, blurPasses = 1): Features {
  let img = blur(gray, w, h);
  for (let k = 1; k < blurPasses; k++) img = blurF(img, w, h);
  const n = w * h;
  const ixx = new Float32Array(n);
  const iyy = new Float32Array(n);
  const ixy = new Float32Array(n);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const gx = img[p + 1] - img[p - 1];
      const gy = img[p + w] - img[p - w];
      ixx[p] = gx * gx;
      iyy[p] = gy * gy;
      ixy[p] = gx * gy;
    }
  const sxx = boxSum(ixx, w, h, 2);
  const syy = boxSum(iyy, w, h, 2);
  const sxy = boxSum(ixy, w, h, 2);
  const resp = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const det = sxx[p] * syy[p] - sxy[p] * sxy[p];
    const tr = sxx[p] + syy[p];
    resp[p] = det - 0.04 * tr * tr;
  }

  // Maxima locaux 5×5 regroupés par cellule de grille pour une bonne couverture.
  const gx = Math.max(1, Math.round(Math.sqrt((max * w) / h / 4)));
  const gy = Math.max(1, Math.round((gx * h) / w));
  const cells: { p: number; r: number }[][] = Array.from({ length: gx * gy }, () => []);
  let globalMax = 0;
  for (let p = 0; p < n; p++) if (resp[p] > globalMax) globalMax = resp[p];
  const minResp = globalMax * 1e-4;
  for (let y = BORDER; y < h - BORDER; y++) {
    for (let x = BORDER; x < w - BORDER; x++) {
      const p = y * w + x;
      const r = resp[p];
      if (r <= minResp) continue;
      let isMax = true;
      for (let dy = -2; dy <= 2 && isMax; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          if ((dx || dy) && resp[p + dy * w + dx] >= r) { isMax = false; break; }
        }
      if (!isMax) continue;
      cells[Math.min(gy - 1, Math.floor((y * gy) / h)) * gx + Math.min(gx - 1, Math.floor((x * gx) / w))].push({ p, r });
    }
  }
  const perCell = Math.ceil(max / cells.length);
  const picked: number[] = [];
  for (const c of cells) {
    c.sort((a, b) => b.r - a.r);
    for (let i = 0; i < Math.min(perCell, c.length); i++) picked.push(c[i].p);
  }

  const points = new Float32Array(picked.length * 2);
  const desc = new Uint32Array(picked.length * 8);
  picked.forEach((p, i) => {
    const x = p % w;
    const y = (p - x) / w;
    points[i * 2] = x;
    points[i * 2 + 1] = y;
    // Orientation par centroïde d'intensité.
    let m10 = 0;
    let m01 = 0;
    for (let dy = -PATCH; dy <= PATCH; dy++) {
      const span = Math.floor(Math.sqrt(PATCH * PATCH - dy * dy));
      for (let dx = -span; dx <= span; dx++) {
        const v = img[(y + dy) * w + x + dx];
        m10 += dx * v;
        m01 += dy * v;
      }
    }
    const a = Math.atan2(m01, m10);
    const c = Math.cos(a);
    const s = Math.sin(a);
    for (let b = 0; b < 256; b++) {
      const o = b * 4;
      const x1 = Math.round(c * PAIRS[o] - s * PAIRS[o + 1]);
      const y1 = Math.round(s * PAIRS[o] + c * PAIRS[o + 1]);
      const x2 = Math.round(c * PAIRS[o + 2] - s * PAIRS[o + 3]);
      const y2 = Math.round(s * PAIRS[o + 2] + c * PAIRS[o + 3]);
      if (img[(y + y1) * w + x + x1] < img[(y + y2) * w + x + x2]) desc[i * 8 + (b >> 5)] |= 1 << (b & 31);
    }
  });
  return { points, desc, count: picked.length };
}

function boxSum(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = -r; x <= r; x++) s += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = s;
      s += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

function popcount(v: number): number {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Appariement par distance de Hamming, test du ratio de Lowe et vérification croisée. */
export function matchFeatures(a: Features, b: Features, ratio = 0.8, maxDist = 80): [number, number][] {
  const na = a.count;
  const nb = b.count;
  if (!na || !nb) return [];
  const dist = new Uint16Array(na * nb);
  for (let i = 0; i < na; i++) {
    const oa = i * 8;
    for (let j = 0; j < nb; j++) {
      const ob = j * 8;
      let d = 0;
      for (let k = 0; k < 8; k++) d += popcount(a.desc[oa + k] ^ b.desc[ob + k]);
      dist[i * nb + j] = d;
    }
  }
  const bestB = new Int32Array(nb).fill(-1);
  for (let j = 0; j < nb; j++) {
    let best = 1e9;
    for (let i = 0; i < na; i++) if (dist[i * nb + j] < best) { best = dist[i * nb + j]; bestB[j] = i; }
  }
  const out: [number, number][] = [];
  for (let i = 0; i < na; i++) {
    let d1 = 1e9, d2 = 1e9, j1 = -1;
    for (let j = 0; j < nb; j++) {
      const d = dist[i * nb + j];
      if (d < d1) { d2 = d1; d1 = d; j1 = j; } else if (d < d2) d2 = d;
    }
    if (j1 >= 0 && d1 <= maxDist && d1 < ratio * d2 && bestB[j1] === i) out.push([i, j1]);
  }
  return out;
}
