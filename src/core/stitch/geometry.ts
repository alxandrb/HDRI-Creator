/** Matrices 3×3 en row-major. */
export type M3 = Float64Array;
export type V3 = [number, number, number];

export const identity = (): M3 => new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

export function mulMV(m: M3, v: V3): V3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function mulMM(a: M3, b: M3): M3 {
  const o = new Float64Array(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}

export function transpose(m: M3): M3 {
  return new Float64Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
}

export function normalize(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Rotation à partir d'un vecteur axe·angle (Rodrigues). */
export function rodrigues(w: V3): M3 {
  const t = Math.hypot(w[0], w[1], w[2]);
  if (t < 1e-12) return new Float64Array([1, -w[2], w[1], w[2], 1, -w[0], -w[1], w[0], 1]);
  const [x, y, z] = [w[0] / t, w[1] / t, w[2] / t];
  const c = Math.cos(t);
  const s = Math.sin(t);
  const k = 1 - c;
  return new Float64Array([
    c + x * x * k, x * y * k - z * s, x * z * k + y * s,
    y * x * k + z * s, c + y * y * k, y * z * k - x * s,
    z * x * k - y * s, z * y * k + x * s, c + z * z * k,
  ]);
}

export function rotationAngle(m: M3): number {
  return Math.acos(Math.max(-1, Math.min(1, (m[0] + m[4] + m[8] - 1) / 2)));
}

/** Valeurs/vecteurs propres d'une matrice symétrique n×n (Jacobi). Vecteurs en colonnes. */
export function eigenSym(a: Float64Array, n: number): { values: number[]; vectors: Float64Array } {
  const A = Float64Array.from(a);
  const V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p * n + q] ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = A[p * n + q];
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (A[q * n + q] - A[p * n + p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k * n + p];
          const akq = A[k * n + q];
          A[k * n + p] = c * akp - s * akq;
          A[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p * n + k];
          const aqk = A[q * n + k];
          A[p * n + k] = c * apk - s * aqk;
          A[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k * n + p];
          const vkq = V[k * n + q];
          V[k * n + p] = c * vkp - s * vkq;
          V[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: Array.from({ length: n }, (_, i) => A[i * n + i]), vectors: V };
}

/**
 * Rotation R minimisant Σ w·|R·a − b|² (méthode des quaternions de Horn).
 */
export function hornRotation(a: V3[], b: V3[], w?: number[]): M3 {
  let sxx = 0, sxy = 0, sxz = 0, syx = 0, syy = 0, syz = 0, szx = 0, szy = 0, szz = 0;
  for (let i = 0; i < a.length; i++) {
    const k = w ? w[i] : 1;
    sxx += k * a[i][0] * b[i][0]; sxy += k * a[i][0] * b[i][1]; sxz += k * a[i][0] * b[i][2];
    syx += k * a[i][1] * b[i][0]; syy += k * a[i][1] * b[i][1]; syz += k * a[i][1] * b[i][2];
    szx += k * a[i][2] * b[i][0]; szy += k * a[i][2] * b[i][1]; szz += k * a[i][2] * b[i][2];
  }
  const N = new Float64Array([
    sxx + syy + szz, syz - szy, szx - sxz, sxy - syx,
    syz - szy, sxx - syy - szz, sxy + syx, szx + sxz,
    szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy,
    sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz,
  ]);
  const { values, vectors } = eigenSym(N, 4);
  let best = 0;
  for (let i = 1; i < 4; i++) if (values[i] > values[best]) best = i;
  const [qw, qx, qy, qz] = [0, 1, 2, 3].map((r) => vectors[r * 4 + best]);
  return new Float64Array([
    qw * qw + qx * qx - qy * qy - qz * qz, 2 * (qx * qy - qw * qz), 2 * (qx * qz + qw * qy),
    2 * (qx * qy + qw * qz), qw * qw - qx * qx + qy * qy - qz * qz, 2 * (qy * qz - qw * qx),
    2 * (qx * qz - qw * qy), 2 * (qy * qz + qw * qx), qw * qw - qx * qx - qy * qy + qz * qz,
  ]);
}

/** Résout un petit système linéaire dense (pivot de Gauss). Retourne null si singulier. */
export function solveLinear(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  const M = Float64Array.from(A);
  const x = Float64Array.from(b);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n + c]) > Math.abs(M[piv * n + c])) piv = r;
    if (Math.abs(M[piv * n + c]) < 1e-12) return null;
    if (piv !== c) {
      for (let k = 0; k < n; k++) [M[c * n + k], M[piv * n + k]] = [M[piv * n + k], M[c * n + k]];
      [x[c], x[piv]] = [x[piv], x[c]];
    }
    for (let r = c + 1; r < n; r++) {
      const f = M[r * n + c] / M[c * n + c];
      if (!f) continue;
      for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k];
      x[r] -= f * x[c];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r];
    for (let k = r + 1; k < n; k++) s -= M[r * n + k] * x[k];
    x[r] = s / M[r * n + r];
  }
  return x;
}

/** Homographie (h33 = 1) par moindres carrés à partir de ≥ 4 correspondances. */
export function homography(src: [number, number][], dst: [number, number][]): M3 | null {
  const AtA = new Float64Array(64);
  const Atb = new Float64Array(8);
  const add = (row: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      Atb[i] += row[i] * rhs;
      for (let j = 0; j < 8; j++) AtA[i * 8 + j] += row[i] * row[j];
    }
  };
  for (let k = 0; k < src.length; k++) {
    const [x, y] = src[k];
    const [u, v] = dst[k];
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const h = solveLinear(AtA, Atb, 8);
  if (!h || h.some((v) => !Number.isFinite(v))) return null;
  return new Float64Array([h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1]);
}

export function applyH(h: M3, x: number, y: number): [number, number] {
  const w = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

/**
 * Focales candidates déduites d'une homographie entre deux vues d'une caméra en rotation pure
 * (coordonnées centrées sur le point principal). Même formule que le module de stitching d'OpenCV.
 */
export function focalsFromHomography(H: M3): { f0?: number; f1?: number } {
  const h = H;
  const out: { f0?: number; f1?: number } = {};
  let d1 = h[6] * h[7];
  let d2 = (h[7] - h[6]) * (h[7] + h[6]);
  let v1 = -(h[0] * h[1] + h[3] * h[4]) / d1;
  let v2 = (h[0] * h[0] + h[3] * h[3] - h[1] * h[1] - h[4] * h[4]) / d2;
  if (v1 < v2) [v1, v2] = [v2, v1];
  if (v1 > 0 && v2 > 0) out.f1 = Math.sqrt(Math.abs(d1) > Math.abs(d2) ? v1 : v2);
  else if (v1 > 0) out.f1 = Math.sqrt(v1);
  d1 = h[0] * h[3] + h[1] * h[4];
  d2 = h[0] * h[0] + h[1] * h[1] - h[3] * h[3] - h[4] * h[4];
  v1 = (-h[2] * h[5]) / d1;
  v2 = (h[5] * h[5] - h[2] * h[2]) / d2;
  if (v1 < v2) [v1, v2] = [v2, v1];
  if (v1 > 0 && v2 > 0) out.f0 = Math.sqrt(Math.abs(d1) > Math.abs(d2) ? v1 : v2);
  else if (v1 > 0) out.f0 = Math.sqrt(v1);
  if (out.f0 !== undefined && !Number.isFinite(out.f0)) delete out.f0;
  if (out.f1 !== undefined && !Number.isFinite(out.f1)) delete out.f1;
  return out;
}

/** Générateur pseudo-aléatoire déterministe (résultats reproductibles). */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
