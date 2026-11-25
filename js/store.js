// Dades locals de la versió portàtil: obres, documentació, visites i els seus elements. Tot es guarda a la tauleta.
import { db, kv, uid, putBlob, getBlob, delBlob, requestPersistence } from './db.js';
import { emit, todayKey } from './ui.js';
import { composeImage, canvasToBlob } from './draw.js';
import { safeName } from './exporter.js';

export const extOf = (p) => (String(p).split('.').pop() || '').toLowerCase();

// ------------------------------------------------------------- dispositiu i usuari
export async function device() {
  let id = await kv.get('deviceId');
  if (!id) { id = 'D' + uid().slice(0, 10); await kv.set('deviceId', id); }
  return { id, user: await kv.get('userName', '') };
}

// ------------------------------------------------------------- obres
export const listObres = async () => (await db.all('obres')).sort((a, b) => String(b.ref).localeCompare(String(a.ref)));
export const getObra = (id) => db.get('obres', id);
export async function saveObra(o) { o.actualitzada = new Date().toISOString(); await db.put('obres', o); emit('data'); return o; }

export async function createObra({ ref, titol, participants = [] }) {
  ref = String(ref || '').trim().toUpperCase();
  if (!/^E_\d{2}_\d{3}$/.test(ref)) throw new Error('El codi ha de tenir el format E_AA_NNN');
  if (await getObra(ref)) throw new Error('Ja hi ha una obra amb aquest codi en aquesta tauleta');
  requestPersistence();
  const o = { id: ref, ref, titol: String(titol || '').trim() || ref, participants, creada: new Date().toISOString() };
  return saveObra(o);
}

export async function updateObraFields(obra, fields) { Object.assign(obra, fields); await saveObra(obra); }

export async function deleteObra(obra) {
  for (const v of await listVisits(obra.id)) await deleteVisitLocal(v);
  for (const k of await db.keysByIndex('files', 'exp', obra.id)) await db.del('files', k);
  await db.del('obres', obra.id);
  emit('data');
}

// ------------------------------------------------------------- documentació (carpeta local de l'obra)
const fileKey = (exp, path) => exp + '|' + path;

export async function listDocs(exp) {
  const all = await db.byIndex('files', 'exp', exp);
  return all.map(({ path, size, mtime }) => ({ path, size, mtime }))
    .sort((a, b) => a.path.localeCompare(b.path, 'ca', { numeric: true }));
}

export async function getDocBlob(exp, file) {
  const rec = await db.get('files', fileKey(exp, file.path));
  if (!rec) throw new Error('Document no trobat a la tauleta');
  return rec.blob;
}

export function cleanPath(p) {
  return String(p || '').split(/[\\/]+/).map((s) => safeName(s, '')).filter(Boolean).join('/');
}

export async function putDoc(exp, path, blob, mtime = Date.now()) {
  path = cleanPath(path);
  if (!path) return null;
  await db.put('files', { key: fileKey(exp, path), exp, path, size: blob.size, mtime, blob });
  return path;
}

export async function addDocs(exp, folder, files) {
  requestPersistence();
  const dir = cleanPath(folder);
  for (const f of files) await putDoc(exp, (dir ? dir + '/' : '') + f.name, new Blob([await f.arrayBuffer()], { type: f.type }), f.lastModified || Date.now());
  emit('docs-changed', exp);
}

export async function deleteDoc(exp, path) { await db.del('files', fileKey(exp, path)); emit('docs-changed', exp); }

// ------------------------------------------------------------- visites
export async function listVisits(exp) {
  return (await db.byIndex('visites', 'exp', exp)).sort((a, b) => (b.num - a.num) || (b.createdAt - a.createdAt));
}
export const getVisit = (id) => db.get('visites', id);

/** dirty = hi ha canvis que encara no s'han enviat */
export async function saveVisit(v, { touch = true } = {}) {
  if (touch) { v.updatedAt = Date.now(); v.dirty = true; }
  await db.put('visites', v);
  emit('changed', { visitId: v.id });
  return v;
}

export async function mutateVisit(id, fn) {
  const v = await getVisit(id);
  if (!v) throw new Error('Visita no trobada');
  await fn(v);
  return saveVisit(v);
}

export async function markSent(id, info) {
  const v = await getVisit(id); if (!v) return;
  v.dirty = false; v.sentAt = Date.now(); v.sentInfo = info;
  await saveVisit(v, { touch: false });
}

export async function nextVisitNum(obra) {
  const local = await listVisits(obra.id);
  return Math.max(0, ...local.map((v) => v.num || 0)) + 1;
}

export async function createVisit(obra, { date = todayKey(), assistents = [] } = {}) {
  const dev = await device();
  requestPersistence();
  const v = {
    id: uid(), exp: obra.id, ref: obra.ref, num: await nextVisitNum(obra), date,
    assistents, text: '', sheetPages: {}, sheetPageCount: 1,
    createdAt: Date.now(), updatedAt: Date.now(), deviceId: dev.id, author: dev.user, dirty: true,
  };
  await saveVisit(v, { touch: false });
  return v;
}

export async function deleteVisitLocal(v) {
  const items = await listItems(v.id);
  for (const it of items) { await deleteItemBlobs(it); await db.del('items', it.id); }
  await db.del('visites', v.id);
  emit('changed');
}

// ------------------------------------------------------------- elements de la visita
export const listItems = (visitId) => db.byIndex('items', 'visitId', visitId);
export const getItem = (id) => db.get('items', id);

async function touchVisit(visitId) { const v = await getVisit(visitId); if (v) await saveVisit(v); }

export async function saveItem(it) {
  it.updatedAt = Date.now();
  await db.put('items', it);
  await touchVisit(it.visitId);
  return it;
}

async function deleteItemBlobs(it) {
  for (const k of ['blobId', 'thumbId', 'annotId', 'annotThumbId', 'pdfId', 'srcBlobId']) if (it[k]) await delBlob(it[k]);
}
export async function deleteItem(it) {
  await deleteItemBlobs(it);
  await db.del('items', it.id);
  await touchVisit(it.visitId);
}

export async function uniqueName(visitId, kind, name, exceptId = null) {
  const items = (await listItems(visitId)).filter((i) => i.kind === kind && i.id !== exceptId);
  const used = new Set(items.map((i) => safeName(i.name).toLowerCase()));
  let base = safeName(name), n = base, k = 2;
  while (used.has(n.toLowerCase())) n = `${base} (${k++})`;
  return n;
}

async function nextName(visitId, kind, prefix, digits) {
  const items = (await listItems(visitId)).filter((i) => i.kind === kind);
  let max = 0;
  for (const i of items) { const m = new RegExp('^' + prefix + '\\s?(\\d+)$').exec(i.name); if (m) max = Math.max(max, Number(m[1])); }
  return uniqueName(visitId, kind, prefix + String(Math.max(max, items.length) + 1).padStart(digits, '0'));
}

export async function makeThumb(source, max = 360) {
  const bmp = source instanceof Blob ? await createImageBitmap(source) : source;
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return canvasToBlob(c, 'image/jpeg', 0.8);
}

export async function addPhoto(visit, file) {
  const mime = file.type || 'image/jpeg';
  const ext = mime === 'image/png' ? 'png' : mime === 'image/heic' ? 'heic' : mime === 'image/webp' ? 'webp' : 'jpg';
  const blob = file instanceof File ? new Blob([await file.arrayBuffer()], { type: mime }) : file;
  let thumbId = null;
  try { thumbId = await putBlob(await makeThumb(blob)); } catch (e) { console.warn('Sense miniatura', e); }
  const it = {
    id: uid(), visitId: visit.id, kind: 'photo', name: await nextName(visit.id, 'photo', 'F', 3), desc: '',
    ext, mime, blobId: await putBlob(blob), thumbId, createdAt: Date.now(),
  };
  return saveItem(it);
}

export async function saveFotoAnnotation(it, shapes) {
  const blob = await getBlob(it.blobId);
  const bmp = await createImageBitmap(blob);
  if (it.annotId) await delBlob(it.annotId);
  if (it.annotThumbId) await delBlob(it.annotThumbId);
  if (shapes && shapes.length) {
    const canvas = composeImage(bmp, shapes);
    it.annotId = await putBlob(await canvasToBlob(canvas, 'image/jpeg', 0.9));
    it.annotThumbId = await putBlob(await makeThumb(canvas));
    it.shapes = { 0: shapes };
  } else { it.annotId = null; it.annotThumbId = null; it.shapes = null; }
  return saveItem(it);
}

export async function addAudio(visit, blob, duration) {
  const mime = blob.type || 'audio/mp4';
  const ext = /webm/.test(mime) ? 'webm' : /ogg/.test(mime) ? 'ogg' : /wav/.test(mime) ? 'wav' : 'm4a';
  const it = {
    id: uid(), visitId: visit.id, kind: 'audio', name: await nextName(visit.id, 'audio', 'Àudio ', 2), desc: '',
    ext, mime, duration, blobId: await putBlob(blob), createdAt: Date.now(),
  };
  return saveItem(it);
}

export async function findPlanItem(visitId, path) {
  return (await listItems(visitId)).find((i) => i.kind === 'plan' && i.src?.path === path) || null;
}

export async function savePlanAnnotation(visit, file, { pages, pageMeta }, srcBlob, existing) {
  const { buildAnnotatedPlan } = await import('./exporter.js');
  const base = file.path.split('/').pop().replace(/\.[^.]+$/, '');
  const it = existing || {
    id: uid(), visitId: visit.id, kind: 'plan', name: await uniqueName(visit.id, 'plan', base), desc: '',
    src: { path: file.path, mtime: file.mtime || 0, size: file.size || srcBlob.size }, createdAt: Date.now(),
  };
  if (!Object.keys(pages).length) { if (existing) await deleteItem(existing); return null; }
  it.pages = pages; it.pageMeta = pageMeta;
  if (!it.srcBlobId) it.srcBlobId = await putBlob(srcBlob);
  const pdf = await buildAnnotatedPlan(await getBlob(it.srcBlobId), pages, pageMeta, { original: file.path, visit: visit.num });
  if (it.pdfId) await delBlob(it.pdfId);
  it.pdfId = await putBlob(pdf);
  return saveItem(it);
}

export async function storageEstimate() {
  try { return navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch { return null; }
}
