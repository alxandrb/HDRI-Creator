const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** Float32 → Float16 (IEEE 754, arrondi au plus proche). */
export function toHalf(v: number): number {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let h = mant >> shift;
    if ((mant >> (shift - 1)) & 1) h += 1;
    return sign | h;
  }
  let h = sign | (e << 10) | (mant >> 13);
  if (mant & 0x1000) h += 1;
  return h;
}

export function fromHalf(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 0x1f) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

export function toHalfArray(src: Float32Array): Uint16Array {
  const out = new Uint16Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = toHalf(src[i]);
  return out;
}
