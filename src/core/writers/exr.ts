import { toHalf } from '../half';

const MAX_HALF = 65504;
const LINES_PER_BLOCK = 16;

/** Encode une image RGB float en OpenEXR demi-flottant, compression ZIP (lisible par Blender, Nuke, Unreal…). */
export async function encodeExr(rgb: Float32Array, width: number, height: number, compress = true): Promise<Uint8Array<ArrayBuffer>> {
  const linesPerBlock = compress ? LINES_PER_BLOCK : 1;
  const header = buildHeader(width, height, compress ? 3 : 0);
  const blockCount = Math.ceil(height / linesPerBlock);

  const blocks = await Promise.all(
    Array.from({ length: blockCount }, async (_, bi) => {
      const y0 = bi * linesPerBlock;
      const lines = Math.min(linesPerBlock, height - y0);
      const raw = new Uint8Array(lines * width * 6);
      const view = new DataView(raw.buffer);
      let o = 0;
      for (let ly = 0; ly < lines; ly++) {
        const row = (y0 + ly) * width;
        // Canaux par ordre alphabétique : B, G, R.
        for (const c of [2, 1, 0]) {
          for (let x = 0; x < width; x++) {
            const v = rgb[(row + x) * 3 + c];
            view.setUint16(o, toHalf(Number.isFinite(v) ? Math.min(Math.max(v, 0), MAX_HALF) : 0), true);
            o += 2;
          }
        }
      }
      if (!compress) return { y: y0, data: raw };
      const packed = await zlib(predictAndInterleave(raw));
      return { y: y0, data: packed.length < raw.length ? packed : raw };
    }),
  );

  const tableSize = blockCount * 8;
  let total = header.length + tableSize;
  for (const b of blocks) total += 8 + b.data.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out.set(header, 0);
  let offset = header.length + tableSize;
  blocks.forEach((b, i) => {
    dv.setBigUint64(header.length + i * 8, BigInt(offset), true);
    dv.setInt32(offset, b.y, true);
    dv.setInt32(offset + 4, b.data.length, true);
    out.set(b.data, offset + 8);
    offset += 8 + b.data.length;
  });
  return out;
}

function predictAndInterleave(raw: Uint8Array): Uint8Array {
  const n = raw.length;
  const t = new Uint8Array(n);
  const half = (n + 1) >> 1;
  for (let i = 0, a = 0, b = half; i < n; i += 2) {
    t[a++] = raw[i];
    if (i + 1 < n) t[b++] = raw[i + 1];
  }
  let p = t[0];
  for (let i = 1; i < n; i++) {
    const d = (t[i] - p + 128 + 256) & 0xff;
    p = t[i];
    t[i] = d;
  }
  return t;
}

async function zlib(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function buildHeader(width: number, height: number, compression: number): Uint8Array {
  const parts: number[] = [];
  const u8 = (v: number) => parts.push(v & 0xff);
  const i32 = (v: number) => { for (let k = 0; k < 4; k++) u8(v >> (8 * k)); };
  const f32 = (v: number) => { const b = new Uint8Array(new Float32Array([v]).buffer); b.forEach(u8); };
  const str = (s: string) => { for (const ch of s) u8(ch.charCodeAt(0)); u8(0); };
  const attr = (name: string, type: string, size: number, body: () => void) => { str(name); str(type); i32(size); body(); };

  i32(20000630);
  i32(2);
  attr('channels', 'chlist', 3 * 18 + 1, () => {
    for (const ch of ['B', 'G', 'R']) { str(ch); i32(1); u8(0); u8(0); u8(0); u8(0); i32(1); i32(1); }
    u8(0);
  });
  attr('compression', 'compression', 1, () => u8(compression));
  const box = () => { i32(0); i32(0); i32(width - 1); i32(height - 1); };
  attr('dataWindow', 'box2i', 16, box);
  attr('displayWindow', 'box2i', 16, box);
  attr('lineOrder', 'lineOrder', 1, () => u8(0));
  attr('pixelAspectRatio', 'float', 4, () => f32(1));
  attr('screenWindowCenter', 'v2f', 8, () => { f32(0); f32(0); });
  attr('screenWindowWidth', 'float', 4, () => f32(1));
  u8(0);
  return new Uint8Array(parts);
}
