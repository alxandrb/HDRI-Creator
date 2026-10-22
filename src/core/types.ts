export type Projection = 'equirect' | 'mirrorball' | 'plain' | 'stitch';

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
  /** Assemblage : champ de vision horizontal en degrés si l'EXIF ne le donne pas (0 = estimation auto). */
  hfov: number;
  /** Assemblage : égalise la luminosité entre photos voisines. */
  gainCompensation: boolean;
  formats: { hdr: boolean; exr: boolean; jpg: boolean };
}

export interface JobImage {
  file: Blob;
  name: string;
  /** Exposition relative en stops (log2), plus grand = image plus claire. */
  ev: number;
  /** Assemblage : indice de la direction de prise de vue (un bracketing par direction). */
  dir?: number;
  /** Focale équivalent 24×36 lue dans l'EXIF. */
  focal35?: number;
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
    stitch?: {
      directions: number;
      used: number;
      hfovDeg: number;
      focalSource: 'exif' | 'estimée' | 'réglage';
      coverage: number;
      rmsErrorPx: number;
      /** Photos (de référence) qui n'ont pu être reliées à aucune autre. */
      unplaced: string[];
    };
  };
}

export type WorkerOutMsg =
  | { type: 'progress'; id: string; stage: string; progress: number }
  | { type: 'done'; id: string; result: JobResult }
  | { type: 'error'; id: string; message: string };
