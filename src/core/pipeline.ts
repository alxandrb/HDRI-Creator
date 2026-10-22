import { mtbShift, rgbaToGray, type Gray } from './align';
import { tonemapToRgba, luminance } from './color';
import { sampleForCrf, solveDebevec, srgbCrf, type Crf, type SampleSource } from './crf';
import { HdrMerger } from './merge';
import { equirectToEquirect, mirrorBallToEquirect, resizeRgb } from './projection';
import type { JobRequest, JobResult, OutputFile } from './types';
import { encodeExr } from './writers/exr';
import { encodeHdr } from './writers/hdr';

export interface Rect { x: number; y: number; w: number; h: number }

/** Accès au décodage d'images, fourni par le worker (navigateur) ou par les tests. */
export interface ImageIO {
  size(file: Blob): Promise<{ width: number; height: number }>;
  /** Décode la zone `crop` de l'image, redimensionnée en w×h, en RGBA 8 bits. */
  decode(file: Blob, crop: Rect, w: number, h: number): Promise<Uint8ClampedArray>;
  encodeJpeg(rgba: Uint8ClampedArray<ArrayBuffer>, w: number, h: number): Promise<Blob>;
}

export type Progress = (stage: string, progress: number) => void;

const ALIGN_WIDTH = 2048;
const PREVIEW_WIDTH = 2048;

export async function runPipeline(req: JobRequest, io: ImageIO, progress: Progress): Promise<JobResult> {
  const t0 = performance.now();
  const s = req.settings;
  if (!req.images.length) throw new Error('Aucune image dans ce groupe.');
  const images = [...req.images].sort((a, b) => a.ev - b.ev);
  const n = images.length;
  const lnT = images.map((im) => im.ev * Math.LN2);
  const refIndex = Math.floor((n - 1) / 2);

  const src = await io.size(images[0].file);
  let crop: Rect = { x: 0, y: 0, w: src.width, h: src.height };
  if (s.projection === 'mirrorball') {
    const r = s.ball.r * Math.min(src.width, src.height);
    const cx = s.ball.cx * src.width;
    const cy = s.ball.cy * src.height;
    crop = { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r };
    if (r < 8) throw new Error('Cercle de la boule miroir trop petit.');
  }
  const ww = Math.max(16, Math.round(Math.min(crop.w, s.outputWidth)));
  const wh = Math.max(8, Math.round((ww * crop.h) / crop.w));

  // Passe 1 : versions réduites pour l'alignement et l'estimation de la courbe de réponse.
  const aw = Math.min(ww, ALIGN_WIDTH);
  const ah = Math.max(8, Math.round((aw * wh) / ww));
  const small: { gray: Gray; rgb: Uint8Array }[] = [];
  for (let i = 0; i < n; i++) {
    progress(`Analyse ${i + 1}/${n}`, (0.3 * i) / n);
    const rgba = await io.decode(images[i].file, crop, aw, ah);
    const rgb = new Uint8Array(aw * ah * 3);
    for (let p = 0; p < aw * ah; p++) {
      rgb[p * 3] = rgba[p * 4];
      rgb[p * 3 + 1] = rgba[p * 4 + 1];
      rgb[p * 3 + 2] = rgba[p * 4 + 2];
    }
    small.push({ gray: rgbaToGray(rgba, aw, ah), rgb });
  }

  progress('Alignement', 0.3);
  const smallShifts: [number, number][] = small.map((im, i) =>
    s.align && i !== refIndex ? mtbShift(small[refIndex].gray, im.gray, 6, Math.round(aw * 0.03)) : [0, 0],
  );
  const scale = ww / aw;
  const shifts = smallShifts.map(([x, y]) => [Math.round(x * scale), Math.round(y * scale)] as [number, number]);

  progress('Courbe de réponse', 0.35);
  let crf: Crf = srgbCrf();
  let crfKind: 'debevec' | 'srgb' = 'srgb';
  if (s.crf === 'auto' && n >= 2 && new Set(images.map((im) => im.ev)).size >= 2) {
    const sources: SampleSource[] = small.map((im, i) => ({ rgb: im.rgb, width: aw, height: ah, shift: smallShifts[i] }));
    const count = Math.min(300, Math.max(60, Math.ceil(512 / (n - 1))));
    const samples = sampleForCrf(sources, refIndex, count);
    if (samples[0][0].length >= 20) {
      crf = samples.map((zs) => solveDebevec(zs, lnT)) as Crf;
      crfKind = 'debevec';
    }
  }
  small.length = 0;

  // Passe 2 : fusion pleine résolution, référence en premier pour l'anti-fantômes.
  const merger = new HdrMerger(ww, wh, crf, s.deghost);
  const order = [refIndex, ...images.keys()].filter((v, i, a) => a.indexOf(v) === i);
  for (const [k, i] of order.entries()) {
    progress(`Fusion ${k + 1}/${n}`, 0.4 + (0.4 * k) / n);
    const rgba = await io.decode(images[i].file, crop, ww, wh);
    merger.add({ rgba, lnT: lnT[i], shift: shifts[i], isDarkest: i === 0, isBrightest: i === n - 1, isRef: i === refIndex });
  }
  let rgb = merger.finish();

  if (s.normalize) normalizeExposure(rgb, ww * wh);

  progress('Projection', 0.82);
  let ow = ww;
  let oh = wh;
  if (s.projection === 'equirect') {
    ow = s.outputWidth;
    oh = ow / 2;
    rgb = equirectToEquirect(rgb, ww, wh, ow, oh, s.yaw);
  } else if (s.projection === 'mirrorball') {
    ow = s.outputWidth;
    oh = ow / 2;
    rgb = mirrorBallToEquirect(rgb, ww, wh, ow, oh, s.yaw);
  }

  return finalizeOutputs(req, io, progress, rgb, ow, oh, { shifts, crf: crfKind, durationMs: performance.now() - t0 });
}

/** Ramène la moyenne logarithmique de la luminance à un gris moyen de 18 %. */
export function normalizeExposure(rgb: Float32Array, pixels: number): void {
  let sum = 0;
  let count = 0;
  const step = Math.max(1, Math.floor(pixels / 200000));
  for (let p = 0; p < pixels; p += step) {
    const l = luminance(rgb[p * 3], rgb[p * 3 + 1], rgb[p * 3 + 2]);
    if (l > 0) { sum += Math.log(l); count++; }
  }
  if (!count) return;
  const k = 0.18 / Math.exp(sum / count);
  for (let i = 0; i < pixels * 3; i++) rgb[i] *= k;
}

/** Statistiques, encodage des fichiers et aperçu, communs à tous les modes. */
export async function finalizeOutputs(
  req: JobRequest,
  io: ImageIO,
  progress: Progress,
  rgb: Float32Array,
  ow: number,
  oh: number,
  info: Omit<JobResult['info'], 'peak' | 'dynamicRangeEv'>,
): Promise<JobResult> {
  const s = req.settings;
  let peak = 0;
  let floor = Infinity;
  for (let p = 0; p < ow * oh; p++) {
    const l = luminance(rgb[p * 3], rgb[p * 3 + 1], rgb[p * 3 + 2]);
    if (l > peak) peak = l;
    if (l > 0 && l < floor) floor = l;
  }

  progress('Export', 0.9);
  const files: OutputFile[] = [];
  const base = req.name.replace(/[^\w.-]+/g, '_');
  if (s.formats.hdr) files.push({ name: `${base}.hdr`, blob: new Blob([encodeHdr(rgb, ow, oh)], { type: 'image/vnd.radiance' }) });
  if (s.formats.exr) files.push({ name: `${base}.exr`, blob: new Blob([await encodeExr(rgb, ow, oh)], { type: 'image/x-exr' }) });

  const pw = Math.min(ow, PREVIEW_WIDTH);
  const ph = Math.max(1, Math.round((pw * oh) / ow));
  const preview = pw === ow ? rgb.slice() : resizeRgb(rgb, ow, oh, pw, ph);
  if (s.formats.jpg) {
    files.push({ name: `${base}_preview.jpg`, blob: await io.encodeJpeg(tonemapToRgba(rgb, ow, oh, 0), ow, oh) });
  }

  progress('Terminé', 1);
  return {
    width: ow,
    height: oh,
    files,
    preview: { width: pw, height: ph, data: preview },
    info: { ...info, peak, dynamicRangeEv: Number.isFinite(floor) && peak > 0 ? Math.log2(peak / floor) : 0 },
  };
}
