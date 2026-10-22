export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/** Courbe filmique ACES (approximation de Narkowicz). */
export function aces(x: number): number {
  const y = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
  return y < 0 ? 0 : y > 1 ? 1 : y;
}

export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Tone mapping ACES + sRGB vers RGBA 8 bits, pour les aperçus. */
export function tonemapToRgba(src: Float32Array, width: number, height: number, ev: number): Uint8ClampedArray<ArrayBuffer> {
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  const k = Math.pow(2, ev);
  const lut = new Uint8Array(4096);
  for (let i = 0; i < 4096; i++) lut[i] = Math.round(linearToSrgb(i / 4095) * 255);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) out[i * 4 + c] = lut[(aces(src[i * 3 + c] * k) * 4095) | 0];
    out[i * 4 + 3] = 255;
  }
  return out;
}
