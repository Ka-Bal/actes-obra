// Versió portàtil: ZIP de la visita (per enviar per correu o WhatsApp) i importació de documentació en ZIP.
import { Zip, ZipPassThrough, ZipDeflate, unzipSync } from '../vendor/fflate.mjs';
import { emit } from './ui.js';
import { getBlob, hash } from './db.js';
import * as store from './store.js';
import {
  buildSheetMd, buildSheetPdf, buildFotosCsv, buildVisitJson, sheetBase,
  photoFile, photoAnnotFile, audioFile, planFile, sortItems, safeName,
} from './exporter.js';

export const visitFolderName = (visit) => `${visit.date}_Visita ${visit.num}`;
export const zipName = (obra, visit) => `${obra.ref}_FO_${visitFolderName(visit)}.zip`;

const STORED = /\.(jpe?g|png|heic|webp|pdf|m4a|mp4|webm|ogg|mp3|zip)$/i;

async function reduceImage(blob, maxSide = 2048, q = 0.85) {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close();
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('No s\'ha pogut reduir la foto'))), 'image/jpeg', q));
}

/** Llista de fitxers de la visita (mateixa estructura que la carpeta de visita de la versió amb servidor). */
async function visitFiles(obra, visit, items, { reduced }) {
  const list = sortItems(items);
  // Amb fotos reduïdes, totes es desen en JPEG
  const photos = reduced ? list.photos.map((p) => ({ ...p, ext: 'jpg' })) : list.photos;
  const all = [...photos, ...list.audios, ...list.plans];
  const out = [];
  for (const p of photos) {
    const orig = list.photos.find((x) => x.id === p.id);
    out.push({ path: photoFile(p), get: async () => { const b = await getBlob(orig.blobId); return reduced ? reduceImage(b) : b; } });
    if (p.annotId) out.push({ path: photoAnnotFile(p), get: async () => { const b = await getBlob(p.annotId); return reduced ? reduceImage(b) : b; } });
    if (p.shapes) out.push({ path: `_dades_app/anotacions/${p.id}.json`, get: async () => txt(JSON.stringify({ foto: photoFile(p), formes: p.shapes })) });
  }
  for (const a of list.audios) out.push({ path: audioFile(a), get: () => getBlob(a.blobId) });
  for (const pl of list.plans) {
    if (pl.pdfId) out.push({ path: planFile(pl, visit), get: () => getBlob(pl.pdfId) });
    out.push({ path: `_dades_app/anotacions/${pl.id}.json`, get: async () => txt(JSON.stringify({ original: pl.src, pagines: pl.pages, meta: pl.pageMeta })) });
  }
  if (photos.length) out.push({ path: 'Fotos.csv', get: async () => txt(buildFotosCsv(all)) });
  const base = sheetBase(obra, visit);
  out.push({ path: base + '.md', get: async () => txt(buildSheetMd(obra, visit, all)) });
  out.push({ path: base + '.pdf', get: () => buildSheetPdf(obra, visit, all) });
  if (visit.sheetPages && Object.keys(visit.sheetPages).length) out.push({ path: '_dades_app/anotacions/full.json', get: async () => txt(JSON.stringify({ pagines: visit.sheetPages })) });
  out.push({ path: '_dades_app/visita.json', get: async () => txt(JSON.stringify(buildVisitJson(obra, visit, all), null, 2)) });
  return out;
}
const txt = (s) => new Blob([s], { type: 'text/plain' });

/** Mida aproximada (sense generar el ZIP) */
export async function estimateSize(items, { reduced }) {
  let total = 20000;
  for (const it of items) {
    for (const k of ['blobId', 'annotId', 'pdfId']) {
      if (!it[k]) continue;
      const b = await getBlob(it[k]); if (!b) continue;
      total += it.kind === 'photo' && reduced ? Math.min(b.size, 700000) : b.size;
    }
  }
  return total;
}

/** Genera el ZIP de la visita. onProgress(fet, total, nom) */
export async function buildVisitZip(obra, visit, items, { reduced = false, onProgress } = {}) {
  const files = await visitFiles(obra, visit, items, { reduced });
  const root = visitFolderName(visit) + '/';
  const chunks = [];
  let resolveDone, rejectDone;
  const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej; });
  const zip = new Zip((err, data, final) => {
    if (err) { rejectDone(err); return; }
    chunks.push(data);
    if (final) resolveDone();
  });
  const mtime = new Date();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    onProgress && onProgress(i, files.length, f.path);
    const blob = await f.get();
    if (!blob) continue;
    const entry = STORED.test(f.path) ? new ZipPassThrough(root + f.path) : new ZipDeflate(root + f.path, { level: 6 });
    entry.mtime = mtime;
    zip.add(entry);
    entry.push(new Uint8Array(await blob.arrayBuffer()), true);
    await new Promise((r) => setTimeout(r, 0)); // deixa respirar la interfície
  }
  zip.end();
  await done;
  onProgress && onProgress(files.length, files.length, '');
  return new Blob(chunks, { type: 'application/zip' });
}

// ------------------------------------------------------------- compartir
export function canShareFile(file) {
  try { return !!(navigator.canShare && navigator.share && navigator.canShare({ files: [file] })); } catch { return false; }
}

/** Ha de cridar-se directament des d'un toc de l'usuari (requisit dels navegadors). */
export async function shareFiles(files, { title, text } = {}) {
  try { await navigator.share({ files, title, text }); return 'shared'; }
  catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; throw e; }
}

export function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.style.display = 'none';
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 60000);
}

// ------------------------------------------------------------- importar documentació
/** Importa un ZIP de documentació a la carpeta local de l'obra (manté les subcarpetes). */
export async function importDocsZip(exp, file, { onProgress } = {}) {
  const data = new Uint8Array(await file.arrayBuffer());
  await new Promise((r) => setTimeout(r, 50)); // deixa pintar l'avís de «important…»
  const entries = unzipSync(data, { filter: (f) => !f.name.endsWith('/') && f.originalSize > 0 });
  let names = Object.keys(entries).filter((n) => !/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/i.test(n) && !/(^|\/)\./.test(n));
  // Si tot penja d'una sola carpeta arrel, la traiem
  const firsts = new Set(names.map((n) => n.split('/')[0]));
  const strip = firsts.size === 1 && names.every((n) => n.includes('/')) ? [...firsts][0] + '/' : '';
  let i = 0;
  for (const n of names) {
    onProgress && onProgress(i++, names.length, n);
    const path = n.slice(strip.length);
    const ext = store.extOf(path);
    const type = ext === 'pdf' ? 'application/pdf' : ['jpg', 'jpeg'].includes(ext) ? 'image/jpeg' : ext === 'png' ? 'image/png' : 'application/octet-stream';
    await store.putDoc(exp, path, new Blob([entries[n]], { type }));
  }
  emit('docs-changed', exp);
  return names.length;
}

export { hash, safeName };
