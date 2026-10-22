const TAU = Math.PI * 2;

function bilinear(src: Float32Array, sw: number, sh: number, x: number, y: number, wrap: boolean, out: Float32Array, o: number) {
  x -= 0.5;
  y -= 0.5;
  let x0 = Math.floor(x);
  let y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  let x1 = x0 + 1;
  let y1 = y0 + 1;
  if (wrap) {
    x0 = ((x0 % sw) + sw) % sw;
    x1 = ((x1 % sw) + sw) % sw;
  } else {
    x0 = x0 < 0 ? 0 : x0 >= sw ? sw - 1 : x0;
    x1 = x1 < 0 ? 0 : x1 >= sw ? sw - 1 : x1;
  }
  y0 = y0 < 0 ? 0 : y0 >= sh ? sh - 1 : y0;
  y1 = y1 < 0 ? 0 : y1 >= sh ? sh - 1 : y1;
  const a = (y0 * sw + x0) * 3;
  const b = (y0 * sw + x1) * 3;
  const c = (y1 * sw + x0) * 3;
  const d = (y1 * sw + x1) * 3;
  for (let k = 0; k < 3; k++) {
    const top = src[a + k] + (src[b + k] - src[a + k]) * fx;
    const bot = src[c + k] + (src[d + k] - src[c + k]) * fx;
    out[o + k] = top + (bot - top) * fy;
  }
}

/**
 * Convention de direction partagée avec la visionneuse 360° :
 * lon = 0 regarde vers +Z, lon croissant vers la droite de l'image.
 */
export function equirectDirection(u: number, v: number): [number, number, number] {
  const lon = (u - 0.5) * TAU;
  const lat = (0.5 - v) * Math.PI;
  const cl = Math.cos(lat);
  return [-Math.sin(lon) * cl, Math.sin(lat), Math.cos(lon) * cl];
}

/** Ré-échantillonne une image équirectangulaire avec rotation horizontale. */
export function equirectToEquirect(src: Float32Array, sw: number, sh: number, ow: number, oh: number, yawDeg: number): Float32Array {
  const out = new Float32Array(ow * oh * 3);
  const shift = (yawDeg / 360) * sw;
  for (let y = 0; y < oh; y++) {
    const sy = ((y + 0.5) / oh) * sh;
    for (let x = 0; x < ow; x++) {
      bilinear(src, sw, sh, ((x + 0.5) / ow) * sw + shift, sy, true, out, (y * ow + x) * 3);
    }
  }
  return out;
}

/**
 * Boule miroir (image recadrée sur le cercle, vue orthographique) vers équirectangulaire.
 * Le centre de la panorama correspond au côté de l'appareil photo, la couture à l'arrière de la boule.
 */
export function mirrorBallToEquirect(src: Float32Array, sw: number, sh: number, ow: number, oh: number, yawDeg: number): Float32Array {
  const out = new Float32Array(ow * oh * 3);
  const cx = sw / 2;
  const cy = sh / 2;
  const r = Math.min(sw, sh) / 2;
  const yaw = yawDeg / 360;
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const [dx, dy, dz] = equirectDirection((x + 0.5) / ow + yaw, (y + 0.5) / oh);
      // Normale = bissectrice entre direction réfléchie et direction vers l'appareil (0,0,1).
      let nx = dx;
      let ny = dy;
      let nz = dz + 1;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-6) { nx = 1; ny = 0; nz = 0; } else { nx /= len; ny /= len; nz /= len; }
      bilinear(src, sw, sh, cx + nx * r, cy - ny * r, false, out, (y * ow + x) * 3);
    }
  }
  return out;
}

/** Réduction par moyenne de zone (anti-aliasing) ; agrandissement bilinéaire. */
export function resizeRgb(src: Float32Array, sw: number, sh: number, ow: number, oh: number): Float32Array {
  const out = new Float32Array(ow * oh * 3);
  if (ow >= sw && oh >= sh) {
    for (let y = 0; y < oh; y++)
      for (let x = 0; x < ow; x++) bilinear(src, sw, sh, ((x + 0.5) / ow) * sw, ((y + 0.5) / oh) * sh, false, out, (y * ow + x) * 3);
    return out;
  }
  const kx = sw / ow;
  const ky = sh / oh;
  for (let y = 0; y < oh; y++) {
    const y0 = Math.floor(y * ky);
    const y1 = Math.max(y0 + 1, Math.min(sh, Math.floor((y + 1) * ky)));
    for (let x = 0; x < ow; x++) {
      const x0 = Math.floor(x * kx);
      const x1 = Math.max(x0 + 1, Math.min(sw, Math.floor((x + 1) * kx)));
      let r = 0, g = 0, b = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const s = (yy * sw + xx) * 3;
          r += src[s]; g += src[s + 1]; b += src[s + 2];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * ow + x) * 3;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
    }
  }
  return out;
}
