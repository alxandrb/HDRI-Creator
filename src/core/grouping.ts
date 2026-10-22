export interface GroupablePhoto {
  name: string;
  /** Stops issus de l'EXIF, si disponibles. */
  exifEv?: number;
  /** Clé de tri chronologique (DateTimeOriginal + sous-secondes). */
  time?: string;
}

export type GroupMode = 'auto' | 'fixed' | 'single';

const collator = new Intl.Collator(undefined, { numeric: true });

export function sortPhotos<T extends GroupablePhoto>(photos: T[]): T[] {
  return [...photos].sort((a, b) => {
    if (a.time && b.time && a.time !== b.time) return a.time < b.time ? -1 : 1;
    return collator.compare(a.name, b.name);
  });
}

/**
 * Regroupe une série en bracketings.
 * auto : un nouveau groupe commence dès qu'une exposition déjà présente dans le groupe courant réapparaît.
 */
export function groupPhotos<T extends GroupablePhoto>(photos: T[], mode: GroupMode, size = 3): T[][] {
  const sorted = sortPhotos(photos);
  if (!sorted.length) return [];
  if (mode === 'single') return [sorted];
  if (mode === 'fixed') {
    const n = Math.max(1, Math.floor(size));
    const out: T[][] = [];
    for (let i = 0; i < sorted.length; i += n) out.push(sorted.slice(i, i + n));
    return out;
  }
  if (sorted.some((p) => p.exifEv === undefined)) return [sorted];
  const out: T[][] = [[]];
  for (const p of sorted) {
    const cur = out[out.length - 1];
    if (cur.some((q) => Math.abs(q.exifEv! - p.exifEv!) < 1 / 6)) out.push([p]);
    else cur.push(p);
  }
  return out;
}

/** EV par défaut quand l'EXIF manque : classement par luminosité moyenne, pas constant. */
export function evFromBrightness(brightness: number[], step: number): number[] {
  const order = brightness.map((b, i) => [b, i] as const).sort((a, b) => a[0] - b[0]);
  const mid = (order.length - 1) / 2;
  const ev = new Array<number>(brightness.length);
  order.forEach(([, i], rank) => (ev[i] = (rank - mid) * step));
  return ev;
}
