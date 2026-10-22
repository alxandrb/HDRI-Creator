import { solveSPD } from '../linalg';
import type { Features } from './features';
import {
  applyH, cross, dot, eigenSym, focalsFromHomography, homography, hornRotation, identity,
  mulMM, mulMV, normalize, rng, rodrigues, transpose, type M3, type V3,
} from './geometry';

/** Vue à assembler : points centrés sur le centre optique (pixels de la résolution d'alignement). */
export interface View {
  width: number;
  height: number;
  features: Features;
}

export interface PairMatch {
  i: number;
  j: number;
  /** Indices de points dans i et j. */
  matches: [number, number][];
  inliers: [number, number][];
}

/** Rayon caméra (x à droite, y vers le bas en pixels) dans la convention monde de la panorama (y en haut). */
export function ray(x: number, y: number, f: number): V3 {
  return normalize([-x, -y, f]);
}

function centered(v: View, k: number): [number, number] {
  return [v.features.points[k * 2] - v.width / 2, v.features.points[k * 2 + 1] - v.height / 2];
}

/** Estimation de la focale par homographies (rotation pure), médiane sur les paires fiables. */
export function estimateFocal(views: View[], pairs: PairMatch[]): number | undefined {
  const focals: number[] = [];
  const rand = rng(11);
  for (const p of pairs) {
    if (p.matches.length < 20) continue;
    const src = p.matches.map(([a]) => centered(views[p.i], a));
    const dst = p.matches.map(([, b]) => centered(views[p.j], b));
    let bestH: M3 | null = null;
    let bestIn: number[] = [];
    for (let it = 0; it < 400; it++) {
      const idx = new Set<number>();
      while (idx.size < 4) idx.add(Math.floor(rand() * src.length));
      const s = [...idx];
      const H = homography(s.map((k) => src[k]), s.map((k) => dst[k]));
      if (!H) continue;
      const inl: number[] = [];
      for (let k = 0; k < src.length; k++) {
        const [u, v] = applyH(H, src[k][0], src[k][1]);
        if ((u - dst[k][0]) ** 2 + (v - dst[k][1]) ** 2 < 9) inl.push(k);
      }
      if (inl.length > bestIn.length) { bestIn = inl; bestH = H; }
    }
    if (!bestH || bestIn.length < 15) continue;
    const H = homography(bestIn.map((k) => src[k]), bestIn.map((k) => dst[k])) ?? bestH;
    const { f0, f1 } = focalsFromHomography(H);
    if (f0 && f1) focals.push(Math.sqrt(f0 * f1));
  }
  if (!focals.length) return undefined;
  focals.sort((a, b) => a - b);
  return focals[Math.floor(focals.length / 2)];
}

/**
 * Rotation relative R telle que ray_j ≈ R · ray_i, par RANSAC à 2 points.
 * Les inliers sont stockés dans `pair.inliers`.
 */
export function pairRotation(views: View[], pair: PairMatch, f: number, thresholdPx = 3): M3 | null {
  const a = pair.matches.map(([k]) => ray(...centered(views[pair.i], k), f));
  const b = pair.matches.map(([, k]) => ray(...centered(views[pair.j], k), f));
  const n = a.length;
  pair.inliers = [];
  if (n < 6) return null;
  const thr = 1 - Math.cos(thresholdPx / f);
  const rand = rng(pair.i * 7919 + pair.j);
  let best: number[] = [];
  for (let it = 0; it < 300; it++) {
    const i1 = Math.floor(rand() * n);
    let i2 = Math.floor(rand() * n);
    if (i1 === i2) i2 = (i2 + 1) % n;
    if (dot(a[i1], a[i2]) > 0.9999) continue;
    const R = hornRotation([a[i1], a[i2]], [b[i1], b[i2]]);
    const inl: number[] = [];
    for (let k = 0; k < n; k++) if (1 - dot(mulMV(R, a[k]), b[k]) < thr) inl.push(k);
    if (inl.length > best.length) best = inl;
  }
  if (best.length < 6) return null;
  let R = hornRotation(best.map((k) => a[k]), best.map((k) => b[k]));
  const inl: number[] = [];
  for (let k = 0; k < n; k++) if (1 - dot(mulMV(R, a[k]), b[k]) < thr) inl.push(k);
  R = hornRotation(inl.map((k) => a[k]), inl.map((k) => b[k]));
  pair.inliers = inl.map((k) => pair.matches[k]);
  return R;
}

/** Une paire est jugée fiable si assez d'inliers et une proportion cohérente (critère de Brown & Lowe). */
export function pairIsReliable(p: PairMatch): boolean {
  return p.inliers.length >= 12 && p.inliers.length > 5.9 + 0.22 * p.matches.length;
}

/**
 * Orientation initiale de chaque vue (caméra → monde) par arbre couvrant maximal,
 * en partant de la vue la plus connectée. Les vues non reliées valent null.
 */
export function initialRotations(n: number, pairs: { i: number; j: number; R: M3; weight: number }[]): (M3 | null)[] {
  const out: (M3 | null)[] = new Array(n).fill(null);
  if (!n) return out;
  const degree = new Array(n).fill(0);
  for (const p of pairs) { degree[p.i] += p.weight; degree[p.j] += p.weight; }
  let root = 0;
  for (let k = 1; k < n; k++) if (degree[k] > degree[root]) root = k;
  out[root] = identity();
  const sorted = [...pairs].sort((x, y) => y.weight - x.weight);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of sorted) {
      // ray_j = R ray_i  ⇒  C_i = C_j · R  et  C_j = C_i · Rᵀ
      if (out[p.i] && !out[p.j]) { out[p.j] = mulMM(out[p.i]!, transpose(p.R)); changed = true; break; }
      if (out[p.j] && !out[p.i]) { out[p.i] = mulMM(out[p.j]!, p.R); changed = true; break; }
    }
  }
  return out;
}

export interface Observation {
  i: number;
  j: number;
  /** Coordonnées centrées du point dans i puis dans j. */
  xi: number; yi: number; xj: number; yj: number;
}

/**
 * Ajustement de faisceaux (Levenberg–Marquardt) : rotations de toutes les vues et focale commune,
 * en minimisant l'écart angulaire entre rayons appariés. La vue `fixed` sert de référence.
 */
export function bundleAdjust(rot: M3[], f0: number, obs: Observation[], fixed: number, refineFocal: boolean, iterations = 40): { rot: M3[]; f: number; rmsPx: number } {
  const n = rot.length;
  let R: M3[] = rot.map((r) => Float64Array.from(r));
  let f = f0;
  const varIndex = (k: number) => (k < fixed ? k : k - 1);
  const np = (n - 1) * 3 + (refineFocal ? 1 : 0);
  const fIdx = (n - 1) * 3;

  const residual = (Ri: M3, Rj: M3, ff: number, o: Observation): V3 => {
    const a = mulMV(Ri, ray(o.xi, o.yi, ff));
    const b = mulMV(Rj, ray(o.xj, o.yj, ff));
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  };
  const cost = (Rs: M3[], ff: number) => {
    let c = 0;
    const delta = 2 / ff;
    for (const o of obs) {
      const r = residual(Rs[o.i], Rs[o.j], ff, o);
      const e = Math.hypot(r[0], r[1], r[2]);
      c += e < delta ? e * e : 2 * delta * e - delta * delta;
    }
    return c;
  };

  let lambda = 1e-3;
  let current = cost(R, f);
  const eps = 1e-6;
  for (let it = 0; it < iterations && np > 0; it++) {
    const JtJ = new Float64Array(np * np);
    const Jtr = new Float64Array(np);
    const delta = 2 / f;
    for (const o of obs) {
      const r0 = residual(R[o.i], R[o.j], f, o);
      const e = Math.hypot(r0[0], r0[1], r0[2]);
      const w = e < delta ? 1 : delta / e;
      const cols: { idx: number; d: V3 }[] = [];
      for (const [cam, other, side] of [[o.i, o.j, 0], [o.j, o.i, 1]] as const) {
        if (cam === fixed) continue;
        for (let k = 0; k < 3; k++) {
          const wv: V3 = [0, 0, 0];
          wv[k] = eps;
          const Rp = mulMM(R[cam], rodrigues(wv));
          const r1 = side === 0 ? residual(Rp, R[other], f, o) : residual(R[other], Rp, f, o);
          cols.push({ idx: varIndex(cam) * 3 + k, d: [(r1[0] - r0[0]) / eps, (r1[1] - r0[1]) / eps, (r1[2] - r0[2]) / eps] });
        }
      }
      if (refineFocal) {
        const df = f * 1e-6;
        const r1 = residual(R[o.i], R[o.j], f + df, o);
        cols.push({ idx: fIdx, d: [(r1[0] - r0[0]) / df * f, (r1[1] - r0[1]) / df * f, (r1[2] - r0[2]) / df * f] });
      }
      for (const a of cols) {
        Jtr[a.idx] += w * dot(a.d, r0);
        for (const b of cols) JtJ[a.idx * np + b.idx] += w * dot(a.d, b.d);
      }
    }
    let improved = false;
    for (let tries = 0; tries < 8; tries++) {
      const A = Float64Array.from(JtJ);
      for (let k = 0; k < np; k++) A[k * np + k] += lambda * (JtJ[k * np + k] + 1e-9);
      const step = solveSPD(A, Jtr.map((v) => -v), np);
      const Rn = R.map((r, k) => (k === fixed ? r : mulMM(r, rodrigues([step[varIndex(k) * 3], step[varIndex(k) * 3 + 1], step[varIndex(k) * 3 + 2]]))));
      // La focale est paramétrée en log pour rester positive.
      const fn = refineFocal ? f * Math.exp(step[fIdx]) : f;
      const c = cost(Rn, fn);
      if (c < current) {
        const gain = (current - c) / Math.max(current, 1e-30);
        R = Rn;
        f = fn;
        current = c;
        lambda = Math.max(1e-7, lambda / 3);
        improved = gain > 1e-7;
        break;
      }
      lambda *= 4;
    }
    if (!improved) break;
  }
  let sq = 0;
  for (const o of obs) {
    const r = residual(R[o.i], R[o.j], f, o);
    sq += r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
  }
  return { rot: R, f, rmsPx: obs.length ? Math.sqrt(sq / obs.length) * f : 0 };
}

/**
 * Remet l'horizon à niveau : les axes horizontaux des photos sont quasi perpendiculaires à la verticale,
 * la verticale est donc la direction propre de plus petite valeur de Σ x·xᵀ (Brown & Lowe).
 * Le cap est choisi pour que la première vue regarde le centre de la panorama.
 */
export function levelRotations(rot: M3[], firstView: number): M3[] {
  const S = new Float64Array(9);
  let upSum: V3 = [0, 0, 0];
  for (const r of rot) {
    const x: V3 = [r[0], r[3], r[6]];
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) S[a * 3 + b] += x[a] * x[b];
    upSum = [upSum[0] + r[1], upSum[1] + r[4], upSum[2] + r[7]];
  }
  let up: V3;
  const { values, vectors } = eigenSym(S, 3);
  const order = [0, 1, 2].sort((a, b) => values[a] - values[b]);
  // Si les photos ne tournent quasiment qu'autour d'un axe, la décomposition reste ambiguë :
  // on prend alors la moyenne des axes verticaux des photos.
  if (rot.length >= 2 && values[order[1]] > 1e-3 * values[order[2]]) {
    up = [vectors[order[0]], vectors[3 + order[0]], vectors[6 + order[0]]];
    if (dot(up, upSum) < 0) up = [-up[0], -up[1], -up[2]];
  } else up = normalize(upSum);
  const fwdCam: V3 = [rot[firstView][2], rot[firstView][5], rot[firstView][8]];
  let fwd = normalize([fwdCam[0] - up[0] * dot(fwdCam, up), fwdCam[1] - up[1] * dot(fwdCam, up), fwdCam[2] - up[2] * dot(fwdCam, up)]);
  if (!Number.isFinite(fwd[0])) fwd = normalize(cross(up, [1, 0, 0]));
  const side = normalize(cross(up, fwd));
  // W envoie side→X, up→Y, fwd→Z.
  const W = new Float64Array([side[0], side[1], side[2], up[0], up[1], up[2], fwd[0], fwd[1], fwd[2]]);
  return rot.map((r) => mulMM(W, r));
}

/**
 * Compensation de gain : facteurs multiplicatifs par vue pour que les zones communes aient la même luminosité.
 * samples : couples de luminances (linéaires) observées au même point dans deux vues.
 */
export function solveGains(n: number, samples: { i: number; j: number; li: number; lj: number }[], prior = 0.5): number[] {
  const A = new Float64Array(n * n);
  const b = new Float64Array(n);
  for (const s of samples) {
    if (!(s.li > 0 && s.lj > 0)) continue;
    const d = Math.log(s.lj / s.li);
    // log g_i − log g_j = log(l_j / l_i)
    A[s.i * n + s.i] += 1; A[s.j * n + s.j] += 1;
    A[s.i * n + s.j] -= 1; A[s.j * n + s.i] -= 1;
    b[s.i] += d; b[s.j] -= d;
  }
  const count = Math.max(1, samples.length / Math.max(1, n));
  for (let k = 0; k < n; k++) A[k * n + k] += prior * count * 0.05 + 1e-6;
  const x = solveSPD(A, b, n);
  return Array.from(x, (v) => Math.exp(Math.max(-3, Math.min(3, v))));
}
