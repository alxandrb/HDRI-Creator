/** Construit un segment APP1 EXIF minimal (little-endian) pour les tests. */
export function buildExifApp1(opts: { exposure: [number, number]; fNumber?: [number, number]; iso?: number; date?: string; model?: string }): Uint8Array {
  const entries0: [number, number, number, Uint8Array][] = [];
  const exifEntries: [number, number, number, Uint8Array][] = [];
  const rat = ([n, d]: [number, number]) => { const b = new Uint8Array(8); const v = new DataView(b.buffer); v.setUint32(0, n, true); v.setUint32(4, d, true); return b; };
  const asc = (s: string) => new TextEncoder().encode(s + '\0');
  if (opts.model) entries0.push([0x0110, 2, opts.model.length + 1, asc(opts.model)]);
  exifEntries.push([0x829a, 5, 1, rat(opts.exposure)]);
  if (opts.fNumber) exifEntries.push([0x829d, 5, 1, rat(opts.fNumber)]);
  if (opts.iso) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, opts.iso, true); exifEntries.push([0x8827, 3, 1, b]); }
  if (opts.date) exifEntries.push([0x9003, 2, opts.date.length + 1, asc(opts.date)]);

  const tiff: number[] = [];
  const ifdSize = (n: number) => 2 + n * 12 + 4;
  const ifd0Off = 8;
  const ifd0Count = entries0.length + 1;
  let dataOff = ifd0Off + ifdSize(ifd0Count);
  const exifOff = dataOff + entries0.reduce((s, e) => s + (e[3].length > 4 ? e[3].length : 0), 0);
  const buf = new Uint8Array(4096);
  const v = new DataView(buf.buffer);
  buf.set([0x49, 0x49]); v.setUint16(2, 42, true); v.setUint32(4, ifd0Off, true);
  const writeIfd = (off: number, entries: [number, number, number, Uint8Array][], extra: [number, number, number, Uint8Array][] = []) => {
    const all = [...entries, ...extra].sort((a, b) => a[0] - b[0]);
    v.setUint16(off, all.length, true);
    all.forEach(([tag, type, count, data], i) => {
      const e = off + 2 + i * 12;
      v.setUint16(e, tag, true); v.setUint16(e + 2, type, true); v.setUint32(e + 4, count, true);
      if (data.length <= 4) buf.set(data, e + 8);
      else { v.setUint32(e + 8, dataOff, true); buf.set(data, dataOff); dataOff += data.length; }
    });
    v.setUint32(off + 2 + all.length * 12, 0, true);
  };
  const ptr = new Uint8Array(4); new DataView(ptr.buffer).setUint32(0, exifOff, true);
  writeIfd(ifd0Off, entries0, [[0x8769, 4, 1, ptr]]);
  dataOff = exifOff + ifdSize(exifEntries.length);
  writeIfd(exifOff, exifEntries);
  tiff.push(...buf.subarray(0, dataOff));

  const seg = new Uint8Array(4 + 6 + tiff.length);
  const sv = new DataView(seg.buffer);
  sv.setUint16(0, 0xffe1); sv.setUint16(2, 2 + 6 + tiff.length);
  seg.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4);
  seg.set(tiff, 10);
  return seg;
}

/** Insère un segment APP1 juste après le SOI d'un JPEG. */
export function injectExif(jpeg: Uint8Array, app1: Uint8Array): Uint8Array {
  const out = new Uint8Array(jpeg.length + app1.length);
  out.set(jpeg.subarray(0, 2));
  out.set(app1, 2);
  out.set(jpeg.subarray(2), 2 + app1.length);
  return out;
}

/** Lecteur .hdr (RLE) pour vérifier l'encodeur. */
export function decodeHdr(bytes: Uint8Array): { width: number; height: number; data: Float32Array } {
  let pos = 0;
  const line = () => { let s = ''; while (bytes[pos] !== 0x0a) s += String.fromCharCode(bytes[pos++]); pos++; return s; };
  if (!line().startsWith('#?RADIANCE')) throw new Error('magic');
  while (line() !== '');
  const m = /-Y (\d+) \+X (\d+)/.exec(line())!;
  const height = +m[1], width = +m[2];
  const data = new Float32Array(width * height * 3);
  const scan = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    if (bytes[pos] === 2 && bytes[pos + 1] === 2) {
      pos += 4;
      for (let c = 0; c < 4; c++) {
        let x = 0;
        while (x < width) {
          let n = bytes[pos++];
          if (n > 128) { n -= 128; const v = bytes[pos++]; for (let k = 0; k < n; k++) scan[(x++) * 4 + c] = v; }
          else for (let k = 0; k < n; k++) scan[(x++) * 4 + c] = bytes[pos++];
        }
      }
    } else { scan.set(bytes.subarray(pos, pos + width * 4)); pos += width * 4; }
    for (let x = 0; x < width; x++) {
      const e = scan[x * 4 + 3];
      const f = e ? 2 ** (e - 136) : 0;
      for (let c = 0; c < 3; c++) data[(y * width + x) * 3 + c] = (scan[x * 4 + c] + 0.5) * f;
    }
  }
  return { width, height, data };
}
