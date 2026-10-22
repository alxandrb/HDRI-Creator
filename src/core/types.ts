export type Projection = 'equirect' | 'mirrorball' | 'plain';

export interface BallCircle {
  /** Centre X, fraction de la largeur de l'image source. */
  cx: number;
  /** Centre Y, fraction de la hauteur de l'image source. */
  cy: number;
  /** Rayon, fraction du plus petit côté de l'image source. */
  r: number;
}

export interface Settings {
  projection: Projection;
  /** Largeur de sortie (équirectangulaire) ou largeur max (mode « plain »). */
  outputWidth: number;
  align: boolean;
  crf: 'auto' | 'srgb';
  deghost: boolean;
  normalize: boolean;
  /** Rotation horizontale en degrés. */
  yaw: number;
  ball: BallCircle;
  formats: { hdr: boolean; exr: boolean; jpg: boolean };
}

export interface JobImage {
  file: Blob;
  name: string;
  /** Exposition relative en stops (log2), plus grand = image plus claire. */
  ev: number;
}

export interface JobRequest {
  id: string;
  name: string;
  images: JobImage[];
  settings: Settings;
}

export interface OutputFile {
  name: string;
  blob: Blob;
}

export interface FloatImage {
  width: number;
  height: number;
  /** RGB entrelacé, linéaire. */
  data: Float32Array;
}

export interface JobResult {
  width: number;
  height: number;
  files: OutputFile[];
  preview: FloatImage;
  info: {
    shifts: [number, number][];
    crf: 'debevec' | 'srgb';
    peak: number;
    dynamicRangeEv: number;
    durationMs: number;
  };
}

export type WorkerOutMsg =
  | { type: 'progress'; id: string; stage: string; progress: number }
  | { type: 'done'; id: string; result: JobResult }
  | { type: 'error'; id: string; message: string };
