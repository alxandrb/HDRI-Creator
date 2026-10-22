import { runPipeline, type ImageIO } from '../core/pipeline';
import type { JobRequest, WorkerOutMsg } from '../core/types';

const post = (msg: WorkerOutMsg, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

const io: ImageIO = {
  async size(file) {
    const bmp = await createImageBitmap(file);
    const out = { width: bmp.width, height: bmp.height };
    bmp.close();
    return out;
  },
  async decode(file, crop, w, h) {
    const bmp = await createImageBitmap(file);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h);
    bmp.close();
    return ctx.getImageData(0, 0, w, h).data;
  },
  async encodeJpeg(rgba, w, h) {
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d')!.putImageData(new ImageData(rgba, w, h), 0, 0);
    return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  },
};

self.onmessage = async (e: MessageEvent<JobRequest>) => {
  const req = e.data;
  try {
    const result = await runPipeline(req, io, (stage, progress) => post({ type: 'progress', id: req.id, stage, progress }));
    post({ type: 'done', id: req.id, result }, [result.preview.data.buffer]);
  } catch (err) {
    post({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
  }
};
