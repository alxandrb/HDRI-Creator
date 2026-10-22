import './style.css';
import { tonemapToRgba } from './core/color';
import { exposureEv, formatExposureTime, parseExif, type ExifData } from './core/exif';
import { evFromBrightness, groupPhotos, type GroupMode } from './core/grouping';
import type { JobResult, Projection, Settings } from './core/types';
import { makeZip } from './core/zip';
import { Viewer360 } from './ui/viewer360';
import { WorkerPool } from './worker/pool';

interface Photo {
  id: string;
  file: File;
  name: string;
  exif: ExifData;
  exifEv?: number;
  time?: string;
  ev: number;
  evEdited: boolean;
  brightness: number;
  thumbUrl: string;
  width: number;
  height: number;
}

interface Group {
  id: string;
  name: string;
  photos: Photo[];
  status: 'idle' | 'queued' | 'running' | 'done' | 'error';
  stage: string;
  progress: number;
  result?: JobResult;
  urls: { name: string; url: string }[];
  error?: string;
  previewEv: number;
  /** EV affiché comme 0 : les EV sont montrés relativement au milieu du bracketing. */
  evAnchor: number;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
let uid = 0;
const nextId = () => `id${++uid}`;

let photos: Photo[] = [];
let groups: Group[] = [];

const pool = new WorkerPool(() => {
  const cores = navigator.hardwareConcurrency || 4;
  const heavy = readSettings().outputWidth >= 8192;
  return heavy ? 1 : Math.max(1, Math.min(3, cores - 1));
});

// ---------- Import ----------

async function importFiles(files: FileList | File[]) {
  const list = [...files].filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|avif)$/i.test(f.name));
  $('drop').querySelector('span')!.textContent = `Lecture de ${list.length} photo(s)…`;
  const loaded = await Promise.all(list.map(loadPhoto));
  photos.push(...loaded.filter((p): p is Photo => !!p));
  $('drop').querySelector('span')!.textContent = 'ou cliquez pour choisir — JPEG conseillé (EXIF lu automatiquement)';
  regroup();
}

async function loadPhoto(file: File): Promise<Photo | null> {
  try {
    const exif = parseExif(await file.slice(0, 256 * 1024).arrayBuffer());
    const bmp = await createImageBitmap(file);
    const scale = 512 / Math.max(bmp.width, bmp.height);
    const tw = Math.max(1, Math.round(bmp.width * Math.min(1, scale)));
    const th = Math.max(1, Math.round(bmp.height * Math.min(1, scale)));
    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0, tw, th);
    const px = ctx.getImageData(0, 0, tw, th).data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) sum += px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722;
    const blob = await new Promise<Blob>((res) => canvas.toBlob((b) => res(b!), 'image/jpeg', 0.85));
    const photo: Photo = {
      id: nextId(),
      file,
      name: file.name,
      exif,
      exifEv: exposureEv(exif),
      time: exif.dateTimeOriginal ? `${exif.dateTimeOriginal}.${(exif.subSec ?? '').padStart(3, '0')}` : undefined,
      ev: 0,
      evEdited: false,
      brightness: sum / (px.length / 4),
      thumbUrl: URL.createObjectURL(blob),
      width: bmp.width,
      height: bmp.height,
    };
    bmp.close();
    return photo;
  } catch (err) {
    console.warn(`Impossible de lire ${file.name}`, err);
    return null;
  }
}

function regroup() {
  const mode = $<HTMLSelectElement>('groupMode').value as GroupMode;
  const size = Number($<HTMLInputElement>('groupSize').value) || 3;
  const prev = new Map(groups.map((g) => [g.photos.map((p) => p.id).join(), g]));
  groups = groupPhotos(photos, mode, size).map((ps) => {
    const kept = prev.get(ps.map((p) => p.id).join());
    if (kept) return kept;
    return { id: nextId(), name: groupName(ps), photos: ps, status: 'idle', stage: '', progress: 0, urls: [], previewEv: 0, evAnchor: 0 } as Group;
  });
  for (const [key, g] of prev) if (!groups.some((x) => x.photos.map((p) => p.id).join() === key)) revoke(g);
  assignEv();
  render();
}

function groupName(ps: Photo[]) {
  const base = ps[0].name.replace(/\.[^.]+$/, '');
  return ps.length > 1 ? `${base}_HDRI` : base;
}

/** EV par photo : EXIF si toute la série en a, sinon classement par luminosité. */
function assignEv() {
  const step = Number($<HTMLInputElement>('evStep').value) || 2;
  for (const g of groups) {
    const allExif = g.photos.every((p) => p.exifEv !== undefined);
    const guessed = evFromBrightness(g.photos.map((p) => p.brightness), step);
    g.photos.forEach((p, i) => {
      if (p.evEdited) return;
      p.ev = allExif ? Math.round(p.exifEv! * 100) / 100 : guessed[i];
    });
    const sorted = g.photos.map((p) => p.ev).sort((a, b) => a - b);
    g.evAnchor = sorted[Math.floor((sorted.length - 1) / 2)];
  }
}

function revoke(g: Group) {
  g.urls.forEach((u) => URL.revokeObjectURL(u.url));
  g.urls = [];
}

// ---------- Réglages ----------

function readSettings(): Settings {
  const num = (id: string) => Number($<HTMLInputElement>(id).value);
  const chk = (id: string) => $<HTMLInputElement>(id).checked;
  return {
    projection: $<HTMLSelectElement>('projection').value as Projection,
    outputWidth: num('outputWidth'),
    align: chk('align'),
    crf: $<HTMLSelectElement>('crf').value as Settings['crf'],
    deghost: chk('deghost'),
    normalize: chk('normalize'),
    yaw: num('yaw'),
    ball: { cx: num('ballCx'), cy: num('ballCy'), r: num('ballR') },
    formats: { hdr: chk('fmtHdr'), exr: chk('fmtExr'), jpg: chk('fmtJpg') },
  };
}

const SETTINGS_KEY = 'hdri-creator.settings';

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(readSettings()));
  } catch { /* stockage indisponible */ }
}

function restoreSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Settings | null;
    if (!s) return;
    const set = (id: string, v: string | number | boolean) => {
      const el = $<HTMLInputElement>(id);
      if (typeof v === 'boolean') el.checked = v;
      else el.value = String(v);
    };
    set('projection', s.projection);
    set('outputWidth', s.outputWidth);
    set('align', s.align);
    set('crf', s.crf);
    set('deghost', s.deghost);
    set('normalize', s.normalize);
    set('yaw', s.yaw);
    set('ballCx', s.ball.cx);
    set('ballCy', s.ball.cy);
    set('ballR', s.ball.r);
    set('fmtHdr', s.formats.hdr);
    set('fmtExr', s.formats.exr);
    set('fmtJpg', s.formats.jpg);
  } catch { /* réglages corrompus : valeurs par défaut */ }
}

function updateSettingsUi() {
  const s = readSettings();
  $('yawVal').textContent = `${s.yaw}°`;
  $('ballEditor').hidden = s.projection !== 'mirrorball';
  $('groupSizeWrap').hidden = $<HTMLSelectElement>('groupMode').value !== 'fixed';
  updateBall();
}

function updateBall() {
  const ref = groups[0]?.photos[Math.floor((groups[0].photos.length - 1) / 2)];
  const img = $<HTMLImageElement>('ballImg');
  const circle = $('ballCircle');
  if (!ref) { img.removeAttribute('src'); circle.hidden = true; return; }
  if (img.dataset.id !== ref.id) { img.src = ref.thumbUrl; img.dataset.id = ref.id; }
  const { cx, cy, r } = readSettings().ball;
  const rpx = r * Math.min(ref.width, ref.height);
  circle.hidden = false;
  circle.style.left = `${((cx * ref.width - rpx) / ref.width) * 100}%`;
  circle.style.top = `${((cy * ref.height - rpx) / ref.height) * 100}%`;
  circle.style.width = `${((2 * rpx) / ref.width) * 100}%`;
  circle.style.height = `${((2 * rpx) / ref.height) * 100}%`;
}

function bindBallEditor() {
  const stage = $('ballStage');
  let drag = false;
  const setFrom = (e: PointerEvent) => {
    const rect = stage.getBoundingClientRect();
    $<HTMLInputElement>('ballCx').value = String(Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)));
    $<HTMLInputElement>('ballCy').value = String(Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)));
    updateBall();
  };
  stage.addEventListener('pointerdown', (e) => { drag = true; stage.setPointerCapture(e.pointerId); setFrom(e); });
  stage.addEventListener('pointermove', (e) => drag && setFrom(e));
  stage.addEventListener('pointerup', () => { drag = false; saveSettings(); });
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const el = $<HTMLInputElement>('ballR');
    el.value = String(Math.min(0.75, Math.max(0.05, Number(el.value) * Math.exp(-e.deltaY * 0.001))));
    updateBall();
    saveSettings();
  }, { passive: false });
}

// ---------- Rendu ----------

function render() {
  const container = $('groups');
  $('groupCount').textContent = groups.length ? `(${groups.length})` : '';
  $<HTMLButtonElement>('runAll').disabled = !groups.length || groups.some((g) => g.status === 'running' || g.status === 'queued');
  $<HTMLButtonElement>('zipAll').disabled = !groups.some((g) => g.result);
  if (!groups.length) {
    container.innerHTML = '<p class="empty">Aucune photo pour l\'instant.</p>';
    updateBall();
    return;
  }
  container.innerHTML = groups.map(groupHtml).join('');
  for (const g of groups) if (g.result) drawPreview(g);
  updateBall();
}

function groupHtml(g: Group): string {
  const busy = g.status === 'running' || g.status === 'queued';
  const noExif = g.photos.some((p) => p.exifEv === undefined);
  const span = Math.max(...g.photos.map((p) => p.ev)) - Math.min(...g.photos.map((p) => p.ev));
  const thumbs = [...g.photos]
    .sort((a, b) => a.ev - b.ev)
    .map(
      (p) => `<div class="thumb">
        <img src="${p.thumbUrl}" alt="" loading="lazy" />
        <button class="rm" type="button" data-act="remove" data-photo="${p.id}" title="Retirer">×</button>
        <div class="name" title="${esc(p.name)}">${esc(p.name)}</div>
        <div>${formatExposureTime(p.exif.exposureTime)}${p.exif.fNumber ? ` · f/${p.exif.fNumber}` : ''}${p.exif.iso ? ` · ISO ${p.exif.iso}` : ''}</div>
        <div class="ev">EV <input type="number" step="0.33" value="${+(p.ev - g.evAnchor).toFixed(2)}" data-act="ev" data-photo="${p.id}" data-group="${g.id}" ${busy ? 'disabled' : ''} /></div>
      </div>`,
    )
    .join('');
  const status =
    g.status === 'error'
      ? `<div class="status err">Erreur : ${esc(g.error ?? '')}</div>`
      : busy
        ? `<div class="progress"><div style="width:${Math.round(g.progress * 100)}%"></div></div><div class="status">${g.status === 'queued' ? 'En attente…' : esc(g.stage)}</div>`
        : '';
  return `<article class="group" data-group="${g.id}">
    <div class="group-head">
      <h3>${esc(g.name)}<span class="meta">${g.photos.length} photo(s) · ${span.toFixed(1)} EV d'écart</span>
        ${noExif ? '<span class="tag warn">EV estimés — vérifiez-les</span>' : ''}
        ${g.photos.length < 2 ? '<span class="tag warn">1 seule pose : pas de vraie plage HDR</span>' : ''}</h3>
      <button type="button" data-act="run" data-group="${g.id}" ${busy ? 'disabled' : ''}>${g.result ? 'Regénérer' : 'Générer'}</button>
    </div>
    <div class="thumbs">${thumbs}</div>
    ${status}
    ${g.result ? resultHtml(g) : ''}
  </article>`;
}

function resultHtml(g: Group): string {
  const r = g.result!;
  const links = g.urls.map((u) => `<a href="${u.url}" download="${esc(u.name)}">⬇ ${esc(u.name.split('.').pop()!.toUpperCase())}</a>`).join('');
  return `<div class="result">
    <canvas data-preview="${g.id}"></canvas>
    <div class="side">
      <div class="stats">
        <div>Taille : <b>${r.width} × ${r.height}</b></div>
        <div>Plage dynamique : <b>${r.info.dynamicRangeEv.toFixed(1)} EV</b></div>
        <div>Courbe : <b>${r.info.crf === 'debevec' ? 'estimée (Debevec)' : 'sRGB'}</b></div>
        <div>Décalages : <b>${r.info.shifts.map(([x, y]) => `${x},${y}`).join(' | ')}</b></div>
        <div>Temps : <b>${(r.info.durationMs / 1000).toFixed(1)} s</b></div>
      </div>
      <label>Exposition de l'aperçu <span class="val">${g.previewEv > 0 ? '+' : ''}${g.previewEv} EV</span>
        <input type="range" min="-8" max="8" step="0.5" value="${g.previewEv}" data-act="previewEv" data-group="${g.id}" />
      </label>
      ${r.width === 2 * r.height ? `<button class="ghost" type="button" data-act="view" data-group="${g.id}">Vue 360°</button>` : ''}
      <div class="downloads">${links}</div>
    </div>
  </div>`;
}

function drawPreview(g: Group) {
  const canvas = document.querySelector<HTMLCanvasElement>(`canvas[data-preview="${g.id}"]`);
  const p = g.result?.preview;
  if (!canvas || !p) return;
  canvas.width = p.width;
  canvas.height = p.height;
  canvas.getContext('2d')!.putImageData(new ImageData(tonemapToRgba(p.data, p.width, p.height, g.previewEv), p.width, p.height), 0, 0);
}

function updateGroupStatus(g: Group) {
  const el = document.querySelector(`[data-group="${g.id}"].group`);
  const bar = el?.querySelector<HTMLElement>('.progress > div');
  const st = el?.querySelector('.status');
  if (bar && st) {
    bar.style.width = `${Math.round(g.progress * 100)}%`;
    st.textContent = g.status === 'queued' ? 'En attente…' : g.stage;
  } else render();
}

// ---------- Traitement ----------

async function runGroup(g: Group) {
  if (g.status === 'running' || g.status === 'queued') return;
  revoke(g);
  g.result = undefined;
  g.error = undefined;
  g.status = 'queued';
  g.progress = 0;
  render();
  try {
    const result = await pool.run(
      {
        id: g.id,
        name: g.name,
        images: g.photos.map((p) => ({ file: p.file, name: p.name, ev: p.ev })),
        settings: readSettings(),
      },
      (stage, progress) => {
        g.status = 'running';
        g.stage = stage;
        g.progress = progress;
        updateGroupStatus(g);
      },
    );
    g.result = result;
    g.urls = result.files.map((f) => ({ name: f.name, url: URL.createObjectURL(f.blob) }));
    g.status = 'done';
  } catch (err) {
    g.status = 'error';
    g.error = err instanceof Error ? err.message : String(err);
  }
  render();
}

async function downloadZip() {
  const files = groups.flatMap((g) => g.result?.files ?? []);
  if (!files.length) return;
  const btn = $<HTMLButtonElement>('zipAll');
  btn.disabled = true;
  btn.textContent = 'Préparation…';
  const blob = await makeZip(files);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'hdri.zip';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
  btn.textContent = 'Tout télécharger (.zip)';
  btn.disabled = false;
}

// ---------- Visionneuse ----------

let viewer: Viewer360 | null = null;

function openViewer(g: Group) {
  if (!g.result) return;
  const dlg = $<HTMLDialogElement>('viewer');
  $('viewerTitle').textContent = g.name;
  dlg.showModal();
  try {
    viewer = new Viewer360($<HTMLCanvasElement>('viewerCanvas'));
    viewer.exposure = Number($<HTMLInputElement>('viewerEv').value);
    viewer.setImage(g.result.preview);
  } catch (err) {
    $('viewerTitle').textContent = err instanceof Error ? err.message : String(err);
  }
}

function closeViewer() {
  viewer?.destroy();
  viewer = null;
  // Nouveau canvas : un contexte WebGL perdu ne peut pas être réutilisé.
  const old = $('viewerCanvas');
  const fresh = document.createElement('canvas');
  fresh.id = 'viewerCanvas';
  old.replaceWith(fresh);
}

// ---------- Événements ----------

function bind() {
  const drop = $('drop');
  const input = $<HTMLInputElement>('files');
  input.addEventListener('change', () => { if (input.files) importFiles(input.files); input.value = ''; });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer?.files) importFiles(e.dataTransfer.files);
  });

  for (const id of ['groupMode', 'groupSize']) $(id).addEventListener('change', () => { updateSettingsUi(); regroup(); });
  $('evStep').addEventListener('change', () => { assignEv(); render(); });
  $('clear').addEventListener('click', () => {
    groups.forEach(revoke);
    photos.forEach((p) => URL.revokeObjectURL(p.thumbUrl));
    photos = [];
    groups = [];
    render();
  });

  $('settingsPanel').addEventListener('input', () => { updateSettingsUi(); saveSettings(); });
  bindBallEditor();

  $('runAll').addEventListener('click', () => groups.forEach(runGroup));
  $('zipAll').addEventListener('click', downloadZip);

  const container = $('groups');
  container.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!el) return;
    const g = groups.find((x) => x.id === el.dataset.group);
    switch (el.dataset.act) {
      case 'run': if (g) runGroup(g); break;
      case 'view': if (g) openViewer(g); break;
      case 'remove': {
        const p = photos.find((x) => x.id === el.dataset.photo);
        if (p) URL.revokeObjectURL(p.thumbUrl);
        photos = photos.filter((x) => x.id !== el.dataset.photo);
        regroup();
        break;
      }
    }
  });
  container.addEventListener('change', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.act !== 'ev') return;
    const p = photos.find((x) => x.id === el.dataset.photo);
    const g = groups.find((x) => x.id === el.dataset.group);
    if (p && g && el.value !== '') { p.ev = Number(el.value) + g.evAnchor; p.evEdited = true; render(); }
  });
  container.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.act !== 'previewEv') return;
    const g = groups.find((x) => x.id === el.dataset.group);
    if (!g) return;
    g.previewEv = Number(el.value);
    el.parentElement!.querySelector('.val')!.textContent = `${g.previewEv > 0 ? '+' : ''}${g.previewEv} EV`;
    drawPreview(g);
  });

  const dlg = $<HTMLDialogElement>('viewer');
  $('viewerClose').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', closeViewer);
  $('viewerEv').addEventListener('input', (e) => {
    if (!viewer) return;
    viewer.exposure = Number((e.target as HTMLInputElement).value);
    viewer.draw();
  });
}

restoreSettings();
bind();
updateSettingsUi();
render();
