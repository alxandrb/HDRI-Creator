import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { mtbShift, rgbaToGray } from '../src/core/align';
import { linearToSrgb, srgbToLinear } from '../src/core/color';
import { solveDebevec, srgbCrf } from '../src/core/crf';
import { exposureEv, parseExif } from '../src/core/exif';
import { evFromBrightness, groupPhotos } from '../src/core/grouping';
import { fromHalf, toHalf } from '../src/core/half';
import { HdrMerger } from '../src/core/merge';
import { equirectDirection, equirectToEquirect, mirrorBallToEquirect } from '../src/core/projection';
import { encodeExr } from '../src/core/writers/exr';
import { encodeHdr } from '../src/core/writers/hdr';
import { crc32, makeZip } from '../src/core/zip';
import { buildExifApp1, decodeHdr, injectExif } from './helpers';

const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9]);

describe('EXIF', () => {
  it('lit temps de pose, ouverture, ISO, date et modèle', () => {
    const jpeg = injectExif(fakeJpeg, buildExifApp1({ exposure: [1, 250], fNumber: [80, 10], iso: 200, date: '2026:10:01 12:00:03', model: 'TestCam' }));
    const e = parseExif(jpeg.buffer as ArrayBuffer);
    expect(e.exposureTime).toBeCloseTo(1 / 250);
    expect(e.fNumber).toBe(8);
    expect(e.iso).toBe(200);
    expect(e.dateTimeOriginal).toBe('2026:10:01 12:00:03');
    expect(e.model).toBe('TestCam');
    expect(exposureEv(e)).toBeCloseTo(Math.log2((1 / 250) * 2 / 64));
  });
  it('renvoie un objet vide sans EXIF', () => {
    expect(parseExif(fakeJpeg.buffer as ArrayBuffer)).toEqual({});
    expect(parseExif(new Uint8Array([1, 2, 3]).buffer as ArrayBuffer)).toEqual({});
  });
});

describe('regroupement', () => {
  const p = (name: string, exifEv?: number) => ({ name, exifEv });
  it('découpe quand une exposition se répète', () => {
    const g = groupPhotos([p('a1', 0), p('a2', -2), p('a3', 2), p('b1', 0), p('b2', -2), p('b3', 2)], 'auto');
    expect(g.map((x) => x.map((y) => y.name))).toEqual([['a1', 'a2', 'a3'], ['b1', 'b2', 'b3']]);
  });
  it('par paquets fixes et tri naturel', () => {
    const g = groupPhotos([p('IMG_10'), p('IMG_2'), p('IMG_1'), p('IMG_3')], 'fixed', 2);
    expect(g.map((x) => x.map((y) => y.name))).toEqual([['IMG_1', 'IMG_2'], ['IMG_3', 'IMG_10']]);
  });
  it('estime les EV par luminosité', () => {
    expect(evFromBrightness([200, 20, 90], 2)).toEqual([2, -2, 0]);
  });
});

describe('demi-flottants', () => {
  it('aller-retour précis', () => {
    for (const v of [0, 1, 0.5, 3.14159, 1e-5, 1000, 65504, 1e-7]) {
      expect(Math.abs(fromHalf(toHalf(v)) - v)).toBeLessThanOrEqual(Math.max(v * 1e-3, 6e-8));
    }
    expect(fromHalf(toHalf(1e6))).toBe(Infinity);
  });
});

/** Scène synthétique : dégradé de radiance sur ~14 EV. */
function scene(w: number, h: number) {
  const rad = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const base = 2 ** ((x / (w - 1)) * 14 - 9) * (1 + 0.3 * Math.sin(y * 0.7));
      rad.set([base, base * 0.8, base * 0.6], (y * w + x) * 3);
    }
  return rad;
}

function expose(rad: Float32Array, w: number, h: number, ev: number, curve: (v: number) => number, shift: [number, number] = [0, 0]) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = Math.min(w - 1, Math.max(0, x - shift[0]));
      const sy = Math.min(h - 1, Math.max(0, y - shift[1]));
      for (let c = 0; c < 3; c++) rgba[(y * w + x) * 4 + c] = Math.round(curve(Math.min(1, rad[(sy * w + sx) * 3 + c] * 2 ** ev)) * 255);
      rgba[(y * w + x) * 4 + 3] = 255;
    }
  return rgba;
}

describe('courbe de réponse (Debevec)', () => {
  it('retrouve une réponse gamma 2.2', () => {
    const gamma = (v: number) => Math.pow(v, 1 / 2.2);
    const evs = [-4, -2, 0, 2, 4];
    const P = 120;
    const rad = Array.from({ length: P }, (_, i) => 2 ** ((i / (P - 1)) * 12 - 8));
    const zs = evs.map((ev) => Uint8Array.from(rad.map((r) => Math.round(gamma(Math.min(1, r * 2 ** ev)) * 255))));
    const g = solveDebevec(zs, evs.map((e) => e * Math.LN2));
    // Pente en log : ln(v) = 2.2·ln(z) + cste.
    const slope = (g[200] - g[60]) / Math.log(200 / 60);
    expect(slope).toBeGreaterThan(1.9);
    expect(slope).toBeLessThan(2.5);
    for (let z = 1; z < 256; z++) expect(g[z]).toBeGreaterThan(g[z - 1]);
  });
});

describe('fusion HDR', () => {
  it('reconstruit la radiance sur toute la plage', () => {
    const w = 64, h = 8;
    const rad = scene(w, h);
    const evs = [-4, 0, 4];
    const crf = srgbCrf();
    const m = new HdrMerger(w, h, crf, false);
    evs.forEach((ev, i) =>
      m.add({ rgba: expose(rad, w, h, ev, linearToSrgb), lnT: ev * Math.LN2, shift: [0, 0], isDarkest: i === 0, isBrightest: i === 2, isRef: i === 1 }),
    );
    const out = m.finish();
    let worst = 0;
    for (let i = 0; i < out.length; i++) {
      if (rad[i] * 2 ** -4 > 1) continue; // saturé même dans la pose la plus sombre
      if (rad[i] * 2 ** 4 * 255 < 2) continue; // sous le bruit de quantification de la pose la plus claire
      worst = Math.max(worst, Math.abs(Math.log2(out[i] / rad[i])));
    }
    expect(worst).toBeLessThan(0.15);
  });
  it('compense un décalage connu', () => {
    const w = 64, h = 32;
    const rad = scene(w, h);
    const m = new HdrMerger(w, h, srgbCrf(), false);
    m.add({ rgba: expose(rad, w, h, 0, linearToSrgb), lnT: 0, shift: [0, 0], isDarkest: false, isBrightest: true, isRef: true });
    m.add({ rgba: expose(rad, w, h, -3, linearToSrgb, [3, 2]), lnT: -3 * Math.LN2, shift: [3, 2], isDarkest: true, isBrightest: false, isRef: false });
    const out = m.finish();
    const p = (10 * w + 30) * 3;
    expect(Math.abs(Math.log2(out[p] / rad[p]))).toBeLessThan(0.1);
  });
});

describe('alignement MTB', () => {
  it('détecte une translation malgré l\'écart d\'exposition', () => {
    const w = 256, h = 192;
    const rad = new Float32Array(w * h * 3);
    let s = 7;
    const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let k = 0; k < 40; k++) {
      const cx = rnd() * w, cy = rnd() * h, r = 6 + rnd() * 20, v = 0.02 + rnd() * 0.6;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) rad.fill(v, (y * w + x) * 3, (y * w + x) * 3 + 3);
    }
    for (let i = 0; i < rad.length; i++) rad[i] += 0.05;
    const ref = rgbaToGray(expose(rad, w, h, 0, linearToSrgb), w, h);
    const img = rgbaToGray(expose(rad, w, h, -2, linearToSrgb, [5, -3]), w, h);
    expect(mtbShift(ref, img)).toEqual([5, -3]);
  });
});

describe('projections', () => {
  it('direction équirectangulaire de référence', () => {
    const [x, y, z] = equirectDirection(0.5, 0.5);
    expect(Math.abs(x)).toBeLessThan(1e-9);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(1);
    expect(equirectDirection(0.5, 0)[1]).toBeCloseTo(1);
  });
  it('rotation de 180° décale d\'une demi-image', () => {
    const w = 8, h = 4;
    const src = new Float32Array(w * h * 3).map((_, i) => Math.floor(i / 3) % w);
    const out = equirectToEquirect(src, w, h, w, h, 180);
    expect(out[0]).toBeCloseTo(4);
  });
  it('boule miroir : le centre de la boule va au centre de la panorama', () => {
    const s = 65;
    const src = new Float32Array(s * s * 3);
    for (let y = 31; y <= 33; y++) src.fill(5, (y * s + 31) * 3, (y * s + 34) * 3);
    const out = mirrorBallToEquirect(src, s, s, 64, 32, 0);
    const near = [31, 32].flatMap((x) => [15, 16].map((y) => out[(y * 64 + x) * 3]));
    expect(Math.max(...near)).toBeGreaterThan(0.5);
    expect(out[(16 * 64 + 5) * 3]).toBe(0);
    // Le haut de la boule correspond au ciel.
    const sky = new Float32Array(s * s * 3);
    for (let x = 0; x < s; x++) for (let y = 0; y < 20; y++) sky.fill(1, (y * s + x) * 3, (y * s + x) * 3 + 3);
    const sk = mirrorBallToEquirect(sky, s, s, 64, 32, 0);
    expect(sk[(1 * 64 + 10) * 3]).toBe(1);
    expect(sk[(30 * 64 + 10) * 3]).toBe(0);
  });
});

describe('formats de sortie', () => {
  const w = 37, h = 19;
  const rgb = new Float32Array(w * h * 3).map((_, i) => (i % 7 === 0 ? 0 : 2 ** ((i % 23) - 8) * (1 + (i % 3) * 0.1)));
  for (let x = 0; x < 20; x++) rgb.fill(1.5, x * 3, x * 3 + 3); // une plage pour tester le RLE

  it('.hdr : aller-retour avec la précision RGBE', () => {
    const dec = decodeHdr(encodeHdr(rgb, w, h));
    expect([dec.width, dec.height]).toEqual([w, h]);
    for (let p = 0; p < w * h; p++) {
      const m = Math.max(rgb[p * 3], rgb[p * 3 + 1], rgb[p * 3 + 2]);
      for (let c = 0; c < 3; c++) expect(Math.abs(dec.data[p * 3 + c] - rgb[p * 3 + c])).toBeLessThanOrEqual(m / 100 + 1e-9);
    }
  });

  it('.exr ZIP : en-tête et données décodables', async () => {
    const bytes = await encodeExr(rgb, w, h);
    const dv = new DataView(bytes.buffer);
    expect(dv.getUint32(0, true)).toBe(20000630);
    let pos = 8;
    const str = () => { let s = ''; while (bytes[pos]) s += String.fromCharCode(bytes[pos++]); pos++; return s; };
    const attrs: Record<string, number> = {};
    for (;;) {
      const name = str();
      if (!name) break;
      str();
      const size = dv.getInt32(pos, true);
      attrs[name] = pos + 4;
      pos += 4 + size;
    }
    expect(bytes[attrs.compression]).toBe(3);
    const blocks = Math.ceil(h / 16);
    const out = new Float32Array(w * h * 3);
    for (let b = 0; b < blocks; b++) {
      const off = Number(dv.getBigUint64(pos + b * 8, true));
      const y0 = dv.getInt32(off, true);
      const size = dv.getInt32(off + 4, true);
      const lines = Math.min(16, h - y0);
      let raw = bytes.subarray(off + 8, off + 8 + size);
      if (size < lines * w * 6) {
        const t = new Uint8Array(inflateSync(raw));
        for (let i = 1; i < t.length; i++) t[i] = (t[i - 1] + t[i] - 128) & 0xff;
        const r = new Uint8Array(t.length);
        const half = (t.length + 1) >> 1;
        for (let i = 0; i < t.length; i++) r[i] = i % 2 ? t[half + (i >> 1)] : t[i >> 1];
        raw = r;
      }
      const rv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      for (let ly = 0; ly < lines; ly++)
        [2, 1, 0].forEach((c, ci) => {
          for (let x = 0; x < w; x++) out[((y0 + ly) * w + x) * 3 + c] = fromHalf(rv.getUint16(((ly * 3 + ci) * w + x) * 2, true));
        });
    }
    for (let i = 0; i < rgb.length; i++) expect(Math.abs(out[i] - rgb[i])).toBeLessThanOrEqual(rgb[i] * 1e-3 + 1e-7);
  });

  it('.zip : structure valide', async () => {
    const blob = await makeZip([{ name: 'a.txt', blob: new Blob(['hello']) }]);
    const b = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(b.buffer);
    expect(dv.getUint32(0, true)).toBe(0x04034b50);
    expect(dv.getUint32(14, true)).toBe(crc32(new TextEncoder().encode('hello')));
    expect(dv.getUint32(b.length - 22, true)).toBe(0x06054b50);
  });
});

describe('couleur', () => {
  it('sRGB aller-retour', () => {
    for (const v of [0, 0.001, 0.2, 0.5, 1]) expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 6);
  });
});

describe('alignement MTB — garde-fous', () => {
  it('ne s\'accroche pas à la période d\'un motif répétitif', () => {
    const w = 320, h = 160;
    const rad = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rad.fill((Math.floor(x / 40) + Math.floor(y / 40)) % 2 ? 0.4 : 0.1, (y * w + x) * 3, (y * w + x) * 3 + 3);
    const ref = rgbaToGray(expose(rad, w, h, 0, linearToSrgb), w, h);
    const img = rgbaToGray(expose(rad, w, h, -2, linearToSrgb), w, h);
    expect(mtbShift(ref, img, 6, 10)).toEqual([0, 0]);
  });
});
