export interface Gray {
  data: Uint8Array;
  width: number;
  height: number;
}

export function rgbaToGray(rgba: Uint8ClampedArray, width: number, height: number): Gray {
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) {
    data[i] = (rgba[i * 4] * 54 + rgba[i * 4 + 1] * 183 + rgba[i * 4 + 2] * 19) >> 8;
  }
  return { data, width, height };
}

function half(g: Gray): Gray {
  const w = g.width >> 1;
  const h = g.height >> 1;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = 2 * y * g.width + 2 * x;
      data[y * w + x] = (g.data[o] + g.data[o + 1] + g.data[o + g.width] + g.data[o + g.width + 1] + 2) >> 2;
    }
  }
  return { data, width: w, height: h };
}

function bitmaps(g: Gray): { tb: Uint8Array; eb: Uint8Array } {
  const hist = new Uint32Array(256);
  for (const v of g.data) hist[v]++;
  let acc = 0;
  let median = 0;
  for (; median < 255; median++) if ((acc += hist[median]) >= g.data.length / 2) break;
  const tb = new Uint8Array(g.data.length);
  const eb = new Uint8Array(g.data.length);
  for (let i = 0; i < g.data.length; i++) {
    tb[i] = g.data[i] > median ? 1 : 0;
    eb[i] = Math.abs(g.data[i] - median) > 4 ? 1 : 0;
  }
  return { tb, eb };
}

/**
 * Alignement par Median Threshold Bitmap (Ward 2003), insensible à l'exposition.
 * Retourne (dx, dy) tel que le pixel (x, y) de `ref` correspond au pixel (x+dx, y+dy) de `img`.
 */
export function mtbShift(ref: Gray, img: Gray, levels = 6, maxShift = Infinity): [number, number] {
  const pyrA: Gray[] = [ref];
  const pyrB: Gray[] = [img];
  for (let l = 1; l < levels && pyrA[l - 1].width >= 32 && pyrA[l - 1].height >= 32; l++) {
    pyrA.push(half(pyrA[l - 1]));
    pyrB.push(half(pyrB[l - 1]));
  }
  let sx = 0;
  let sy = 0;
  for (let l = pyrA.length - 1; l >= 0; l--) {
    sx *= 2;
    sy *= 2;
    const a = bitmaps(pyrA[l]);
    const b = bitmaps(pyrB[l]);
    let best = Infinity;
    let bx = sx;
    let by = sy;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const score = mismatch(a, b, pyrA[l].width, pyrA[l].height, sx + dx, sy + dy);
        if (score < best) { best = score; bx = sx + dx; by = sy + dy; }
      }
    }
    sx = bx;
    sy = by;
  }
  // Garde-fous : un décalage hors limite ou à peine meilleur que « pas de décalage »
  // est le plus souvent un faux appariement (motif répétitif qui se replie dans la pyramide).
  const a = bitmaps(ref);
  const b = bitmaps(img);
  const still = mismatch(a, b, ref.width, ref.height, 0, 0);
  const accept = (x: number, y: number) =>
    Math.abs(x) <= maxShift && Math.abs(y) <= maxShift && mismatch(a, b, ref.width, ref.height, x, y) < still * 0.8;
  if ((sx || sy) && accept(sx, sy)) return [sx, sy];
  // Second essai : recherche locale directe autour de zéro (petits tremblements à main levée).
  const [lx, ly] = localSearch(pyrA[1] ?? ref, pyrB[1] ?? img, pyrA[1] ? 4 : 8);
  const k = pyrA[1] ? 2 : 1;
  let best = still;
  let res: [number, number] = [0, 0];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = lx * k + dx;
      const y = ly * k + dy;
      const score = mismatch(a, b, ref.width, ref.height, x, y);
      if (score < best) { best = score; res = [x, y]; }
    }
  }
  return (res[0] || res[1]) && accept(res[0], res[1]) ? res : [0, 0];
}

function localSearch(ref: Gray, img: Gray, radius: number): [number, number] {
  const a = bitmaps(ref);
  const b = bitmaps(img);
  let best = Infinity;
  let res: [number, number] = [0, 0];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const score = mismatch(a, b, ref.width, ref.height, dx, dy);
      if (score < best) { best = score; res = [dx, dy]; }
    }
  }
  return res;
}

function mismatch(a: { tb: Uint8Array; eb: Uint8Array }, b: { tb: Uint8Array; eb: Uint8Array }, w: number, h: number, ox: number, oy: number): number {
  let err = 0;
  let count = 0;
  for (let y = Math.max(0, -oy); y < Math.min(h, h - oy); y++) {
    const ra = y * w;
    const rb = (y + oy) * w + ox;
    for (let x = Math.max(0, -ox); x < Math.min(w, w - ox); x++) {
      err += (a.tb[ra + x] ^ b.tb[rb + x]) & a.eb[ra + x] & b.eb[rb + x];
      count++;
    }
  }
  return count ? err / count : Infinity;
}
