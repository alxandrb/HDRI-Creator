/** Encode une image RGB float en Radiance .hdr (RGBE, RLE « nouveau format »). */
export function encodeHdr(rgb: Float32Array, width: number, height: number): Uint8Array<ArrayBuffer> {
  const header = new TextEncoder().encode(
    `#?RADIANCE\n# Made with HDRI Creator\nFORMAT=32-bit_rle_rgbe\nEXPOSURE=1.0\n\n-Y ${height} +X ${width}\n`,
  );
  const out = new ByteWriter(header.length + width * height * 4 + height * 4);
  out.bytes(header);
  const scan = new Uint8Array(width * 4);
  const comp = new Uint8Array(width);
  const rle = width >= 8 && width <= 0x7fff;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      rgbe(rgb[i], rgb[i + 1], rgb[i + 2], scan, x * 4);
    }
    if (!rle) { out.bytes(scan); continue; }
    out.bytes([2, 2, width >> 8, width & 0xff]);
    for (let c = 0; c < 4; c++) {
      for (let x = 0; x < width; x++) comp[x] = scan[x * 4 + c];
      rleComponent(comp, out);
    }
  }
  return out.result();
}

function rgbe(r: number, g: number, b: number, out: Uint8Array, o: number) {
  r = r > 0 ? r : 0;
  g = g > 0 ? g : 0;
  b = b > 0 ? b : 0;
  const v = Math.max(r, g, b);
  if (!(v >= 1e-32) || !Number.isFinite(v)) {
    out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
    return;
  }
  let e = Math.floor(Math.log2(v)) + 1;
  let m = v / 2 ** e;
  if (m >= 1) { e++; m /= 2; } else if (m < 0.5) { e--; m *= 2; }
  const k = (m * 256) / v;
  out[o] = Math.min(255, Math.floor(r * k));
  out[o + 1] = Math.min(255, Math.floor(g * k));
  out[o + 2] = Math.min(255, Math.floor(b * k));
  out[o + 3] = e + 128;
}

function rleComponent(data: Uint8Array, out: ByteWriter) {
  const n = data.length;
  let cur = 0;
  while (cur < n) {
    let beg = cur;
    let run = 0;
    let oldRun = 0;
    while (run < 4 && beg < n) {
      beg += run;
      oldRun = run;
      run = 1;
      while (beg + run < n && run < 127 && data[beg] === data[beg + run]) run++;
    }
    if (oldRun > 1 && oldRun === beg - cur) {
      out.bytes([128 + oldRun, data[cur]]);
      cur = beg;
    }
    while (cur < beg) {
      const k = Math.min(128, beg - cur);
      out.byte(k);
      out.bytes(data.subarray(cur, cur + k));
      cur += k;
    }
    if (run >= 4) {
      out.bytes([128 + run, data[beg]]);
      cur += run;
    }
  }
}

export class ByteWriter {
  private buf: Uint8Array<ArrayBuffer>;
  private len = 0;
  constructor(capacity = 1024) {
    this.buf = new Uint8Array(Math.max(16, capacity));
  }
  private grow(extra: number) {
    if (this.len + extra <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + extra));
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  byte(v: number) {
    this.grow(1);
    this.buf[this.len++] = v;
  }
  bytes(v: ArrayLike<number>) {
    this.grow(v.length);
    this.buf.set(v, this.len);
    this.len += v.length;
  }
  get length() {
    return this.len;
  }
  result(): Uint8Array<ArrayBuffer> {
    return this.buf.slice(0, this.len);
  }
}
