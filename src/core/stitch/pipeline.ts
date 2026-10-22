import { mtbShift, rgbaToGray } from '../align';
import { luminance } from '../color';
import { sampleForCrf, solveDebevec, srgbCrf, type Crf } from '../crf';
import { toHalfArray } from '../half';
import { HdrMerger } from '../merge';
import { finalizeOutputs, normalizeExposure, type ImageIO, type Progress } from '../pipeline';
import type { JobImage, JobRequest, JobResult } from '../types';
import { detectFeatures, matchFeatures } from './features';
import type { M3 } from './geometry';
import { renderEquirect, type RenderView } from './render';
import {
  bundleAdjust, estimateFocal, initialRotations, levelRotations, pairIsReliable, pairRotation, solveGains,
  type Observation, type PairMatch, type View,
} from './solve';

// Résolution de détection : plus robuste au bruit JPEG qu'en pleine définition.
const ALIGN_WIDTH = 800;

interface Direction {
  images: JobImage[];
  /** Index de la pose de référence (exposition médiane). */
  ref: number;
}

/**
 * Assemblage de photos prises dans plusieurs directions (rotation autour du point de vue).
 * Chaque direction peut être un bracketing : il est d'abord fusionné en HDR.
 */
export async function runStitchPipeline(req: JobRequest, io: ImageIO, progress: Progress): Promise<JobResult> {
  const t0 = performance.now();
  const s = req.settings;
  const byDir = new Map<number, JobImage[]>();
  for (const im of req.images) {
    const d = im.dir ?? 0;
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d)!.push(im);
  }
  const dirs: Direction[] = [...byDir.keys()].sort((a, b) => a - b).map((k) => {
    const images = byDir.get(k)!.sort((a, b) => a.ev - b.ev);
    return { images, ref: Math.floor((images.length - 1) / 2) };
  });
  if (dirs.length < 2) throw new Error("Il faut au moins 2 directions pour assembler une panorama.");

  const src = await io.size(dirs[0].images[0].file);
  const aw = Math.min(src.width, ALIGN_WIDTH);
  const ah = Math.round((aw * src.height) / src.width);
  const full = { x: 0, y: 0, w: src.width, h: src.height };

  // 1. Versions réduites : alignement intra-bracketing, points d'intérêt, luminance pour la compensation de gain.
  const nd = dirs.length;
  const views: View[] = [];
  const smallLin: Float32Array[] = [];
  const bracketShifts: [number, number][][] = [];
  let crf: Crf = srgbCrf();
  let crfKind: 'debevec' | 'srgb' = 'srgb';
  const smallRgba: Uint8ClampedArray[][] = [];
  for (let d = 0; d < nd; d++) {
    progress(`Analyse ${d + 1}/${nd}`, (0.25 * d) / nd);
    const imgs: Uint8ClampedArray[] = [];
    for (const im of dirs[d].images) imgs.push(await io.decode(im.file, full, aw, ah));
    smallRgba.push(imgs);
    const grays = imgs.map((rgba) => rgbaToGray(rgba, aw, ah));
    const ref = dirs[d].ref;
    bracketShifts.push(grays.map((g, i) => (s.align && i !== ref ? mtbShift(grays[ref], g, 6, Math.round(aw * 0.03)) : [0, 0])));
    // Flou et nombre de points proportionnels à la résolution (calibrés à 800 px de large).
    const maxFeatures = Math.round(Math.min(1000, Math.max(700, (aw * ah) / 430)));
    views.push({ width: aw, height: ah, features: detectFeatures(grays[ref].data, aw, ah, maxFeatures, aw >= 700 ? 2 : 1) });
  }
  // Courbe de réponse estimée sur le premier bracketing qui a de vrais écarts d'exposition.
  if (s.crf === 'auto') {
    const d = dirs.findIndex((dir) => new Set(dir.images.map((im) => im.ev)).size >= 2);
    if (d >= 0) {
      const sources = smallRgba[d].map((rgba, i) => {
        const rgb = new Uint8Array(aw * ah * 3);
        for (let p = 0; p < aw * ah; p++) { rgb[p * 3] = rgba[p * 4]; rgb[p * 3 + 1] = rgba[p * 4 + 1]; rgb[p * 3 + 2] = rgba[p * 4 + 2]; }
        return { rgb, width: aw, height: ah, shift: bracketShifts[d][i] };
      });
      const n = sources.length;
      const samples = sampleForCrf(sources, dirs[d].ref, Math.min(300, Math.max(60, Math.ceil(512 / (n - 1)))));
      if (samples[0][0].length >= 20) {
        crf = samples.map((zs) => solveDebevec(zs, dirs[d].images.map((im) => im.ev * Math.LN2))) as Crf;
        crfKind = 'debevec';
      }
    }
  }
  for (let d = 0; d < nd; d++) {
    smallLin.push(mergeDirection(smallRgba[d], dirs[d], bracketShifts[d], aw, ah, crf, s.deghost));
  }
  smallRgba.length = 0;

  // 2. Appariements entre toutes les paires de directions.
  progress('Appariement', 0.3);
  const pairs: PairMatch[] = [];
  const totalPairs = (nd * (nd - 1)) / 2;
  let done = 0;
  for (let i = 0; i < nd; i++)
    for (let j = i + 1; j < nd; j++) {
      const matches = matchFeatures(views[i].features, views[j].features, 0.8);
      if (matches.length >= 12) pairs.push({ i, j, matches, inliers: [] });
      if (++done % 8 === 0) progress('Appariement', 0.3 + (0.15 * done) / totalPairs);
    }

  // 3. Focale : EXIF, sinon estimation par homographies, sinon réglage manuel.
  progress('Focale et orientations', 0.45);
  const diag = Math.hypot(aw, ah);
  const f35 = dirs[0].images[0].focal35;
  let f: number;
  let focalSource: 'exif' | 'estimée' | 'réglage';
  if (f35) {
    f = (f35 * diag) / 43.27;
    focalSource = 'exif';
  } else {
    const est = s.hfov > 0 ? undefined : estimateFocal(views, pairs);
    if (est && est > aw * 0.2 && est < aw * 8) {
      f = est;
      focalSource = 'estimée';
    } else {
      f = aw / 2 / Math.tan(((s.hfov > 0 ? s.hfov : 60) * Math.PI) / 360);
      focalSource = 'réglage';
    }
  }

  // 4. Rotations relatives, puis orientations globales.
  const rel: { i: number; j: number; R: M3; weight: number }[] = [];
  let reliable = pairs.filter((p) => {
    const R = pairRotation(views, p, f, 4);
    if (!R || !pairIsReliable(p)) return false;
    rel.push({ i: p.i, j: p.j, R, weight: p.inliers.length });
    return true;
  });
  const init = initialRotations(nd, rel);
  const used = init.map((r, k) => (r ? k : -1)).filter((k) => k >= 0);
  if (used.length < 2) {
    throw new Error("Impossible de relier les photos entre elles : vérifiez qu'elles se chevauchent d'environ 30 %.");
  }
  const index = new Map(used.map((k, i) => [k, i]));
  reliable = reliable.filter((p) => index.has(p.i) && index.has(p.j));
  const observations = (pairsList: PairMatch[]): Observation[] =>
    pairsList.flatMap((p) =>
      p.inliers.map(([a, b]) => ({
        i: index.get(p.i)!,
        j: index.get(p.j)!,
        xi: views[p.i].features.points[a * 2] - aw / 2,
        yi: views[p.i].features.points[a * 2 + 1] - ah / 2,
        xj: views[p.j].features.points[b * 2] - aw / 2,
        yj: views[p.j].features.points[b * 2 + 1] - ah / 2,
      })),
    );

  progress('Ajustement global', 0.5);
  let rot: M3[] = used.map((k) => init[k]!);
  const fixed = 0;
  let ba = bundleAdjust(rot, f, observations(reliable), fixed, focalSource !== 'exif');
  // Deuxième passe : inliers recalculés avec la focale affinée, puis nouvel ajustement.
  if (Math.abs(ba.f - f) / f > 0.02) {
    for (const p of reliable) pairRotation(views, p, ba.f, 3);
    reliable = reliable.filter(pairIsReliable);
    ba = bundleAdjust(ba.rot, ba.f, observations(reliable), fixed, focalSource !== 'exif');
  }
  f = ba.f;
  rot = levelRotations(ba.rot, 0);

  // 5. Compensation de gain d'après la luminance aux points appariés.
  let gains = used.map(() => 1);
  if (s.gainCompensation) {
    const lumAt = (d: number, x: number, y: number) => {
      const img = smallLin[d];
      let sum = 0;
      let n = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const xx = Math.round(x) + dx;
          const yy = Math.round(y) + dy;
          if (xx < 0 || yy < 0 || xx >= aw || yy >= ah) continue;
          const o = (yy * aw + xx) * 3;
          sum += luminance(img[o], img[o + 1], img[o + 2]);
          n++;
        }
      return n ? sum / n : 0;
    };
    const samples = reliable.flatMap((p) =>
      p.inliers.map(([a, b]) => ({
        i: index.get(p.i)!,
        j: index.get(p.j)!,
        li: lumAt(p.i, views[p.i].features.points[a * 2], views[p.i].features.points[a * 2 + 1]),
        lj: lumAt(p.j, views[p.j].features.points[b * 2], views[p.j].features.points[b * 2 + 1]),
      })),
    );
    gains = solveGains(used.length, samples);
  }

  // 6. Rendu pleine résolution : chaque direction est fusionnée puis projetée.
  const hfov = 2 * Math.atan(aw / 2 / f);
  const rw = Math.max(aw, Math.min(src.width, Math.round((s.outputWidth * hfov) / (2 * Math.PI) * 1.4)));
  const rh = Math.round((rw * src.height) / src.width);
  const scale = rw / aw;
  const renderViews: RenderView[] = [];
  for (const [vi, d] of used.entries()) {
    progress(`Fusion ${vi + 1}/${used.length}`, 0.55 + (0.2 * vi) / used.length);
    const imgs: Uint8ClampedArray[] = [];
    for (const im of dirs[d].images) imgs.push(await io.decode(im.file, full, rw, rh));
    const shifts = bracketShifts[d].map(([x, y]) => [Math.round(x * scale), Math.round(y * scale)] as [number, number]);
    const lin = mergeDirection(imgs, dirs[d], shifts, rw, rh, crf, s.deghost);
    renderViews.push({ width: rw, height: rh, data: toHalfArray(lin), f: f * scale, rot: rot[vi], gain: gains[vi] });
  }

  progress('Projection', 0.78);
  const ow = s.outputWidth;
  const oh = ow / 2;
  const { rgb, coverage } = renderEquirect(renderViews, ow, oh, s.yaw, (y) => {
    if (y % 64 === 0) progress('Projection', 0.78 + (0.1 * y) / oh);
  });
  if (s.normalize) normalizeExposure(rgb, ow * oh);

  return finalizeOutputs(req, io, progress, rgb, ow, oh, {
    shifts: used.map(() => [0, 0] as [number, number]),
    crf: crfKind,
    durationMs: performance.now() - t0,
    stitch: {
      directions: nd,
      used: used.length,
      hfovDeg: (hfov * 180) / Math.PI,
      focalSource,
      coverage,
      rmsErrorPx: ba.rmsPx * scale,
      unplaced: dirs.filter((_, d) => !index.has(d)).map((dir) => dir.images[dir.ref].name),
    },
  });
}

function mergeDirection(imgs: Uint8ClampedArray[], dir: Direction, shifts: [number, number][], w: number, h: number, crf: Crf, deghost: boolean): Float32Array {
  const n = imgs.length;
  const merger = new HdrMerger(w, h, crf, deghost && n > 1);
  const order = [dir.ref, ...imgs.keys()].filter((v, i, a) => a.indexOf(v) === i);
  for (const i of order) {
    merger.add({
      rgba: imgs[i],
      lnT: dir.images[i].ev * Math.LN2,
      shift: shifts[i],
      isDarkest: i === 0,
      isBrightest: i === n - 1,
      isRef: i === dir.ref,
    });
  }
  return merger.finish();
}
