import { describe, expect, it } from 'vitest';
import { linearToSrgb } from '../src/core/color';
import type { ImageIO, Rect } from '../src/core/pipeline';
import { equirectDirection } from '../src/core/projection';
import { hornRotation, mulMM, mulMV, normalize, rodrigues, rotationAngle, transpose, type M3, type V3 } from '../src/core/stitch/geometry';
import { runStitchPipeline } from '../src/core/stitch/pipeline';
import { fillHoles } from '../src/core/stitch/render';
import type { JobImage, Settings } from '../src/core/types';

// Environnement procédural : bruit de valeur 3D multi-octaves (texturé, non périodique) + soleil.
function hash(x: number, y: number, z: number) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x: number, y: number, z: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const s = (t: number) => t * t * (3 - 2 * t);
  const [u, v, w] = [s(fx), s(fy), s(fz)];
  let r = 0;
  for (let c = 0; c < 8; c++) {
    const dx = c & 1, dy = (c >> 1) & 1, dz = c >> 2;
    r += hash(xi + dx, yi + dy, zi + dz) * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w);
  }
  return r;
}
function env(d: V3): [number, number, number] {
  let n = 0, amp = 1;
  for (let o = 0; o < 4; o++) { n += amp * noise(d[0] * 12 * 2 ** o + 50, d[1] * 12 * 2 ** o + 50, d[2] * 12 * 2 ** o + 50); amp *= 0.5; }
  const base = 0.03 + 0.5 * n * n;
  const sky = d[1] > 0 ? 1 + d[1] : 0.6;
  const sun = Math.exp((normalize([0.3, 0.8, 0.5])[0] * d[0] + normalize([0.3, 0.8, 0.5])[1] * d[1] + normalize([0.3, 0.8, 0.5])[2] * d[2] - 1) * 400) * 20;
  return [base * sky * 0.9 + sun, base * sky + sun, base * sky * 1.2 + sun];
}

const W = 480, H = 360;
function cameraRot(yawDeg: number, pitchDeg: number, rollDeg = 0): M3 {
  const y = (yawDeg * Math.PI) / 180, p = (pitchDeg * Math.PI) / 180, r = (rollDeg * Math.PI) / 180;
  // forward = col2 : yaw autour de Y (vers −X quand yaw > 0, comme la visionneuse), pitch vers le haut.
  return mulMM(mulMM(rodrigues([0, -y, 0]), rodrigues([-p, 0, 0])), rodrigues([0, 0, r]));
}
function shoot(C: M3, f: number, ev: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const d = mulMV(C, normalize([-(x + 0.5 - W / 2), -(y + 0.5 - H / 2), f]));
      const c = env(d);
      for (let k = 0; k < 3; k++) out[(y * W + x) * 4 + k] = Math.round(linearToSrgb(Math.min(1, c[k] * 2 ** ev)) * 255);
      out[(y * W + x) * 4 + 3] = 255;
    }
  return out;
}

function fakeIO(store: Map<Blob, Uint8ClampedArray>): ImageIO {
  return {
    async size() { return { width: W, height: H }; },
    async decode(file: Blob, crop: Rect, w: number, h: number) {
      const src = store.get(file)!;
      const out = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const sx = Math.min(W - 1, Math.floor(crop.x + ((x + 0.5) * crop.w) / w));
          const sy = Math.min(H - 1, Math.floor(crop.y + ((y + 0.5) * crop.h) / h));
          out.set(src.subarray((sy * W + sx) * 4, (sy * W + sx) * 4 + 4), (y * w + x) * 4);
        }
      return out;
    },
    async encodeJpeg() { return new Blob([]); },
  };
}

const settings: Settings = {
  projection: 'stitch', outputWidth: 512, align: true, crf: 'srgb', deghost: false, normalize: false, yaw: 0,
  ball: { cx: 0.5, cy: 0.5, r: 0.5 }, hfov: 0, gainCompensation: true, formats: { hdr: false, exr: false, jpg: false },
};

describe('géométrie', () => {
  it('Horn retrouve une rotation connue', () => {
    const R = rodrigues([0.3, -0.5, 0.2]);
    const a: V3[] = [[1, 0, 0], [0, 1, 0], [0.3, 0.3, 0.9].map((v) => v / Math.hypot(0.3, 0.3, 0.9)) as V3];
    const b = a.map((v) => mulMV(R, v));
    expect(rotationAngle(mulMM(transpose(hornRotation(a, b)), R))).toBeLessThan(1e-6);
  });
});

describe('remplissage des trous', () => {
  it('remplit sans toucher aux pixels couverts', () => {
    const w = 16, h = 8;
    const rgb = new Float32Array(w * h * 3).fill(2);
    const wt = new Float32Array(w * h).fill(1);
    for (let x = 0; x < w; x++) { wt[x] = 0; rgb.fill(0, x * 3, x * 3 + 3); }
    fillHoles(rgb, wt, w, h);
    expect(rgb[0]).toBeCloseTo(2, 3);
    expect(rgb[(4 * w + 3) * 3]).toBe(2);
  });
});

describe('assemblage de panorama', () => {
  const trueHfov = 75;
  const fTrue = W / 2 / Math.tan((trueHfov * Math.PI) / 360);
  const poses: [number, number, number][] = [
    ...[0, 45, 90, 135, 180, 225, 270, 315].map((yaw, k) => [yaw, k % 2 ? 4 : -3, k % 3 - 1] as [number, number, number]),
    ...[20, 140, 260].map((yaw) => [yaw, 50, 0] as [number, number, number]),
    ...[80, 200, 320].map((yaw) => [yaw, -50, 0] as [number, number, number]),
  ];

  async function run(opts: { exif: boolean; evs?: number[] }) {
    const store = new Map<Blob, Uint8ClampedArray>();
    const images: JobImage[] = [];
    poses.forEach(([yaw, pitch, roll], dir) => {
      const C = cameraRot(yaw, pitch, roll);
      for (const ev of opts.evs ?? [0]) {
        const blob = new Blob([`${dir}/${ev}`]);
        store.set(blob, shoot(C, fTrue, ev));
        images.push({ file: blob, name: `d${dir}_${ev}.jpg`, ev, dir, focal35: opts.exif ? (fTrue * 43.27) / Math.hypot(W, H) : undefined });
      }
    });
    return runStitchPipeline({ id: 't', name: 'pano', images, settings }, fakeIO(store), () => {});
  }

  function compare(rgb: Float32Array, w: number, h: number) {
    // Erreur en log sur les pixels hors pôles (le soleil compte peu ici).
    let sum = 0, n = 0;
    for (let y = Math.round(h * 0.15); y < h * 0.85; y++)
      for (let x = 0; x < w; x++) {
        const d = equirectDirection((x + 0.5) / w, (y + 0.5) / h);
        const t = env(d);
        const o = (y * w + x) * 3;
        const g = (t[0] + t[1] + t[2]) / 3;
        const r = (rgb[o] + rgb[o + 1] + rgb[o + 2]) / 3;
        if (g > 0.95 || r <= 0) continue;
        sum += Math.abs(Math.log2(r / g));
        n++;
      }
    return sum / n;
  }

  it('retrouve focale, orientations et image (focale estimée, sans EXIF)', async () => {
    const res = await run({ exif: false });
    const st = res.info.stitch!;
    expect(st.used).toBe(poses.length);
    expect(Math.abs(st.hfovDeg - trueHfov)).toBeLessThan(1.5);
    expect(st.rmsErrorPx).toBeLessThan(1.5);
    expect(st.coverage).toBeGreaterThan(0.9);
    const err = compare(res.preview.data, res.preview.width, res.preview.height);
    expect(err).toBeLessThan(0.15);
  }, 60000);

  it('fusionne des bracketings par direction avec focale EXIF', async () => {
    const res = await run({ exif: true, evs: [-2, 0, 2] });
    const st = res.info.stitch!;
    expect(st.focalSource).toBe('exif');
    expect(st.used).toBe(poses.length);
    const err = compare(res.preview.data, res.preview.width, res.preview.height);
    expect(err).toBeLessThan(0.15);
  }, 120000);
});
