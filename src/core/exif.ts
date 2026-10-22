export interface ExifData {
  exposureTime?: number;
  fNumber?: number;
  iso?: number;
  exposureBias?: number;
  dateTimeOriginal?: string;
  subSec?: string;
  model?: string;
  focalLength?: number;
  focalLength35?: number;
}

const TAG_MODEL = 0x0110;
const TAG_EXIF_IFD = 0x8769;
const TAG_EXPOSURE_TIME = 0x829a;
const TAG_FNUMBER = 0x829d;
const TAG_ISO = 0x8827;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_EXPOSURE_BIAS = 0x9204;
const TAG_SUBSEC_ORIGINAL = 0x9291;
const TAG_FOCAL_LENGTH = 0x920a;
const TAG_FOCAL_LENGTH_35 = 0xa405;

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

/** Lit les métadonnées EXIF utiles d'un JPEG. Retourne {} si absent ou illisible. */
export function parseExif(buf: ArrayBuffer): ExifData {
  try {
    const tiff = findTiff(new DataView(buf));
    return tiff ? readTiff(tiff) : {};
  } catch {
    return {};
  }
}

function findTiff(view: DataView): DataView | null {
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;
  let off = 2;
  while (off + 4 <= view.byteLength) {
    if (view.getUint8(off) !== 0xff) return null;
    const marker = view.getUint8(off + 1);
    if (marker === 0xda || marker === 0xd9) return null;
    const len = view.getUint16(off + 2);
    if (marker === 0xe1 && off + 10 <= view.byteLength && view.getUint32(off + 4) === 0x45786966 && view.getUint16(off + 8) === 0) {
      const start = off + 10;
      const size = Math.min(len - 8, view.byteLength - start);
      return new DataView(view.buffer, view.byteOffset + start, size);
    }
    off += 2 + len;
  }
  return null;
}

function readTiff(t: DataView): ExifData {
  const order = t.getUint16(0);
  if (order !== 0x4949 && order !== 0x4d4d) return {};
  const le = order === 0x4949;
  const u16 = (o: number) => t.getUint16(o, le);
  const u32 = (o: number) => t.getUint32(o, le);
  const i32 = (o: number) => t.getInt32(o, le);
  const out: ExifData = {};

  const readIfd = (ifdOff: number, visit: (tag: number, type: number, count: number, valOff: number) => void) => {
    if (ifdOff + 2 > t.byteLength) return;
    const n = u16(ifdOff);
    for (let i = 0; i < n; i++) {
      const e = ifdOff + 2 + i * 12;
      if (e + 12 > t.byteLength) return;
      const tag = u16(e);
      const type = u16(e + 2);
      const count = u32(e + 4);
      const size = (TYPE_SIZE[type] ?? 1) * count;
      const valOff = size <= 4 ? e + 8 : u32(e + 8);
      if (valOff + size > t.byteLength) continue;
      visit(tag, type, count, valOff);
    }
  };

  const ascii = (off: number, count: number) => {
    let s = '';
    for (let i = 0; i < count; i++) {
      const c = t.getUint8(off + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  };
  const rational = (off: number, signed: boolean) => {
    const n = signed ? i32(off) : u32(off);
    const d = signed ? i32(off + 4) : u32(off + 4);
    return d === 0 ? undefined : n / d;
  };
  const num = (type: number, off: number) =>
    type === 3 ? u16(off) : type === 4 ? u32(off) : type === 5 ? rational(off, false) : type === 10 ? rational(off, true) : undefined;

  let exifIfd = 0;
  readIfd(u32(4), (tag, type, count, off) => {
    if (tag === TAG_MODEL && type === 2) out.model = ascii(off, count);
    if (tag === TAG_EXIF_IFD) exifIfd = u32(off);
  });
  if (exifIfd) {
    readIfd(exifIfd, (tag, type, count, off) => {
      switch (tag) {
        case TAG_EXPOSURE_TIME: out.exposureTime = num(type, off); break;
        case TAG_FNUMBER: out.fNumber = num(type, off); break;
        case TAG_ISO: out.iso = num(type, off); break;
        case TAG_EXPOSURE_BIAS: out.exposureBias = num(type, off); break;
        case TAG_DATETIME_ORIGINAL: if (type === 2) out.dateTimeOriginal = ascii(off, count); break;
        case TAG_SUBSEC_ORIGINAL: if (type === 2) out.subSec = ascii(off, count); break;
        case TAG_FOCAL_LENGTH: out.focalLength = num(type, off); break;
        case TAG_FOCAL_LENGTH_35: out.focalLength35 = num(type, off) || undefined; break;
      }
    });
  }
  return out;
}

/** Exposition relative en stops : log2(t · ISO/100 / N²). Undefined si le temps de pose manque. */
export function exposureEv(e: ExifData): number | undefined {
  if (!e.exposureTime || e.exposureTime <= 0) return undefined;
  const iso = e.iso && e.iso > 0 ? e.iso : 100;
  const n = e.fNumber && e.fNumber > 0 ? e.fNumber : 1;
  return Math.log2((e.exposureTime * iso) / 100 / (n * n));
}

export function formatExposureTime(t?: number): string {
  if (!t) return '—';
  if (t >= 1) return `${Math.round(t * 10) / 10}s`;
  return `1/${Math.round(1 / t)}`;
}
