import type { Crf } from './crf';

export interface MergeImage {
  rgba: Uint8ClampedArray;
  /** ln(exposition relative). */
  lnT: number;
  shift: [number, number];
  isDarkest: boolean;
  isBrightest: boolean;
  isRef: boolean;
}

const FLOOR = 1e-3;

function plateau(z: number): number {
  if (z >= 254 || z <= 1) return 0;
  const t = (2 * z) / 255 - 1;
  return 1 - t ** 8;
}

/**
 * Fusion HDR incrémentale : chaque pose est ajoutée puis libérée, la mémoire reste
 * bornée à 16 octets par pixel quel que soit le nombre de poses.
 */
export class HdrMerger {
  private num: Float32Array;
  private den: Float32Array;
  private refLum: Float32Array | null = null;

  constructor(
    readonly width: number,
    readonly height: number,
    private crf: Crf,
    private deghost: boolean,
  ) {
    this.num = new Float32Array(width * height * 3);
    this.den = new Float32Array(width * height);
  }

  add(img: MergeImage): void {
    const { width: w, height: h } = this;
    const [dx, dy] = img.shift;
    const rad = this.crf.map((g) => {
      const t = new Float32Array(256);
      for (let z = 0; z < 256; z++) t[z] = Math.exp(g[z] - img.lnT);
      return t;
    });
    const weight = new Float32Array(256);
    for (let z = 0; z < 256; z++) {
      let wz = plateau(z);
      if (img.isDarkest && z >= 128) wz = Math.max(wz, FLOOR);
      if (img.isBrightest && z < 128) wz = Math.max(wz, FLOOR);
      if (img.isRef) wz = Math.max(wz, 1e-6);
      weight[z] = wz;
    }
    const trackRef = this.deghost && img.isRef;
    if (trackRef) this.refLum = new Float32Array(w * h).fill(-1);
    const ghost = this.deghost && !img.isRef ? this.refLum : null;
    const { num, den } = this;
    const [rr, rg, rb] = rad;

    for (let y = 0; y < h; y++) {
      const sy = y + dy;
      if (sy < 0 || sy >= h) continue;
      const x0 = Math.max(0, -dx);
      const x1 = Math.min(w, w - dx);
      for (let x = x0; x < x1; x++) {
        const s = (sy * w + x + dx) * 4;
        const zr = img.rgba[s];
        const zg = img.rgba[s + 1];
        const zb = img.rgba[s + 2];
        const zmax = zr > zg ? (zr > zb ? zr : zb) : zg > zb ? zg : zb;
        let wt = weight[zmax];
        const p = y * w + x;
        const r = rr[zr];
        const g = rg[zg];
        const b = rb[zb];
        if (trackRef && zmax > 10 && zmax < 245) this.refLum![p] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (ghost && ghost[p] > 0 && zmax < 245) {
          const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          if (Math.abs(Math.log((l + 1e-6) / ghost[p])) > 0.7) wt *= 0.02;
        }
        if (wt === 0) continue;
        num[p * 3] += wt * r;
        num[p * 3 + 1] += wt * g;
        num[p * 3 + 2] += wt * b;
        den[p] += wt;
      }
    }
  }

  /** Termine la fusion ; le tampon interne est réutilisé pour le résultat. */
  finish(): Float32Array {
    const { num, den } = this;
    for (let p = 0; p < den.length; p++) {
      const d = den[p];
      const k = d > 0 ? 1 / d : 0;
      num[p * 3] *= k;
      num[p * 3 + 1] *= k;
      num[p * 3 + 2] *= k;
    }
    this.refLum = null;
    return num;
  }
}
