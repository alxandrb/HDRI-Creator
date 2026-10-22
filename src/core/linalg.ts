/** Résout A·x = b pour A symétrique définie positive (n×n, row-major) par Cholesky. */
export function solveSPD(A: Float64Array, b: Float64Array, n: number): Float64Array {
  const L = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    const rj = j * n;
    let s = A[rj + j];
    for (let k = 0; k < j; k++) s -= L[rj + k] * L[rj + k];
    const d = Math.sqrt(s > 1e-12 ? s : 1e-12);
    L[rj + j] = d;
    for (let i = j + 1; i < n; i++) {
      const ri = i * n;
      let t = A[ri + j];
      for (let k = 0; k < j; k++) t -= L[ri + k] * L[rj + k];
      L[ri + j] = t / d;
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
    y[i] = s / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  return x;
}
