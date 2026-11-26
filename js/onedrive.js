// Sincronització automàtica amb OneDrive
//
//  OneDrive / 02 - EXPEDIENTS - Obra / E_XX_XXX /
//     001_Projecte        → es descarrega a la tauleta (plànols i documents de projecte, per consultar sense connexió)
//     002_Fotos           ← fotos de cada visita            (subcarpeta AAAA_MM_DD_Visita N)
//     003_Documents_obra  ← full de visita, plànols anotats, àudios, Fotos.csv, dades  (mateixa subcarpeta)
//
// Tot es desa primer a la tauleta. La pujada es fa sola, fitxer a fitxer, quan hi ha connexió i l'app és
// oberta (l'iPad no permet que una web app treballi tancada). Res no es dona per pujat fins que OneDrive
// ho confirma. Si es reanomena una foto, es reanomena a OneDrive (no es duplica).
import { db, getBlob, hash, kv } from './db.js';
import { emit, on } from './ui.js';
import * as store from './store.js';
import * as G from './graph.js';
import { cfg, isConfigured, getToken, AuthError, accountInfo } from './auth.js';
import {
  buildSheetMd, buildSheetPdf, buildFotosCsv, buildVisitJson, sheetBase,
  photoFile, photoAnnotFile, audioFile, planFile, sortItems,
} from './exporter.js';

const OBRA_RE = /^(E_\d{2}_\d{3})(?![\d])/;
let state = { phase: 'off', pending: 0, error: null, lastOk: null, current: null };
let timer = null, running = false, again = false, forceDocs = false;
const DOCS_EVERY = 5 * 60 * 1000; // revisa 001_Projecte cada 5 minuts (o a l'instant amb «Actualitza»)

export const odState = () => state;
function setState(p) { state = { ...state, ...p }; emit('od', state); }
export const visitFolderName = (v) => `${v.date}_Visita ${v.num}`;

export function startOneDrive() {
  on('changed', (d) => { refreshPending(); if (!d || !d.fromSync) kick(3000); });
  on('obra-changed', () => kick(1500));
  window.addEventListener('online', () => kick(500));
  window.addEventListener('offline', () => setState({ phase: isConfigured() ? 'offline' : 'off' }));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(500); });
  setInterval(() => kick(0), 60000);
  refreshPending();
  kick(300);
}

export function kick(delay = 1500, { docs = false } = {}) { if (docs) forceDocs = true; clearTimeout(timer); timer = setTimeout(run, delay); }

async function refreshPending() {
  const n = (await db.all('visites')).filter((v) => v.dirty).length;
  setState({ pending: n });
}

async function run() {
  if (running) { again = true; return; }
  running = true;
  try {
    await refreshPending();
    if (!isConfigured()) { setState({ phase: 'off' }); return; }
    if (!navigator.onLine) { setState({ phase: 'offline' }); return; }
    try { await getToken(); } catch (e) {
      if (e instanceof AuthError) { setState({ phase: e.kind === 'offline' ? 'offline' : e.kind === 'login' ? 'login' : 'error', error: e.message }); return; }
      throw e;
    }
    setState({ phase: 'syncing', error: null });
    const checkDocs = forceDocs; forceDocs = false;
    const root = await G.resolveRoot();
    await refreshRemoteObres(root);
    for (const obra of await store.listObres()) {
      try {
        const od = await ensureObraFolder(root, obra);
        if (obra.metaDirty) await pushObraMeta(od, obra);
        for (const v of (await store.listVisits(obra.id)).filter((x) => x.dirty)) {
          try { await syncVisit(od, obra, v.id); }
          catch (e) {
            if (e instanceof AuthError) throw e;
            console.error(e);
            const cur = await store.getVisit(v.id); if (cur) { cur.lastError = e.message; await db.put('visites', cur); }
            setState({ error: `Visita ${v.num} (${obra.ref}): ${e.message}` });
          }
        }
        if (checkDocs || !obra.odDocsAt || Date.now() - obra.odDocsAt > DOCS_EVERY) await downloadProject(od, obra);
      } catch (e) {
        if (e instanceof AuthError) throw e;
        console.error(e); setState({ error: `${obra.ref}: ${e.message}` });
      }
    }
    await refreshPending();
    setState({ phase: state.error ? 'error' : 'ok', lastOk: state.error ? state.lastOk : Date.now(), current: null });
  } catch (e) {
    console.error(e);
    if (e instanceof AuthError) setState({ phase: e.kind === 'offline' ? 'offline' : e.kind === 'login' ? 'login' : 'error', error: e.message, current: null });
    else setState({ phase: 'error', error: e.message, current: null });
  } finally {
    running = false;
    if (again) { again = false; kick(500); }
  }
}

// ------------------------------------------------------------- obres
/** Llista de carpetes d'expedient a OneDrive (es desa per poder-la mostrar sense connexió). */
export async function refreshRemoteObres(root) {
  root ||= await G.resolveRoot();
  const items = await G.listChildren(root.driveId, root.id);
  const list = items.filter((i) => i.folder && OBRA_RE.test(i.name))
    .map((i) => ({ ref: OBRA_RE.exec(i.name)[1], name: i.name, id: i.id, driveId: root.driveId }))
    .sort((a, b) => b.ref.localeCompare(a.ref));
  await kv.set('odObres', { list, at: Date.now() });
  emit('od-obres', list);
  return list;
}
export async function cachedRemoteObres() { return (await kv.get('odObres', null)) || { list: [], at: 0 }; }

/** Afegeix a la tauleta una obra que ja existeix a OneDrive (llegeix participants si n'hi ha). */
export async function addRemoteObra(r) {
  const titol = r.name.replace(OBRA_RE, '').replace(/^[\s_\-–·]+/, '').trim() || r.ref;
  let meta = null;
  try {
    const f = await G.getItem(r.driveId, r.id, `${cfg().folders.documents}/_dades_app/obra.json`);
    if (f) meta = JSON.parse(await (await G.download({ ...f, driveId: r.driveId, downloadUrl: f['@microsoft.graph.downloadUrl'] })).text());
  } catch { /* sense dades prèvies */ }
  const obra = await store.createObra({ ref: r.ref, titol: meta?.titol || titol, participants: meta?.participants || [] });
  obra.remote = { driveId: r.driveId, id: r.id, name: r.name };
  obra.offline = true;
  await store.saveObra(obra);
  kick(200);
  return obra;
}

async function ensureObraFolder(root, obra) {
  const F = cfg().folders;
  let rem = obra.remote;
  if (rem && rem.driveId === root.driveId) {
    const it = await G.getItem(rem.driveId, rem.id);
    if (!it || it.deleted) rem = null;
  } else rem = null;
  if (!rem) {
    const known = ((await kv.get('odObres', null))?.list || []).find((x) => x.ref === obra.ref);
    if (known) rem = { driveId: known.driveId, id: known.id, name: known.name };
    else {
      const it = await G.createFolder(root.driveId, root.id, obra.ref);
      rem = { driveId: root.driveId, id: it.id, name: it.name };
    }
    const cur = await store.getObra(obra.id); cur.remote = rem; await db.put('obres', cur); obra.remote = rem;
  }
  for (const f of [F.projecte, F.fotos, F.documents]) await G.ensureFolder(rem.driveId, rem.id, f);
  return rem;
}

async function pushObraMeta(od, obra) {
  const F = cfg().folders;
  const parent = await G.ensureFolder(od.driveId, od.id, `${F.documents}/_dades_app`);
  const body = JSON.stringify({ ref: obra.ref, titol: obra.titol, participants: obra.participants || [], actualitzada: new Date().toISOString() }, null, 2);
  await G.upload(od.driveId, parent, 'obra.json', new Blob([body], { type: 'application/json' }));
  const cur = await store.getObra(obra.id); if (cur) { cur.metaDirty = false; await db.put('obres', cur); }
}

// ------------------------------------------------------------- 001_Projecte → tauleta
async function downloadProject(od, obra) {
  const F = cfg().folders;
  const projId = await G.ensureFolder(od.driveId, od.id, F.projecte);
  const remote = await G.listRecursive(od.driveId, projId);
  const local = await db.byIndex('files', 'exp', obra.id);
  const byPath = new Map(local.map((f) => [f.path, f]));
  const wanted = new Set();
  let done = 0, changed = false;
  const total = remote.length;
  for (const f of remote) {
    wanted.add(f.path);
    const l = byPath.get(f.path);
    if (l && l.source === 'onedrive' && l.rid === f.id && l.ctag === f.ctag) { done++; continue; }
    if (f.size > 300 * 1024 * 1024) continue; // massa gran per a la tauleta
    setState({ current: { label: `Descarregant ${obra.ref}`, done, total } });
    const blob = await G.download(f);
    await db.put('files', { key: obra.id + '|' + f.path, exp: obra.id, path: f.path, size: blob.size, mtime: f.mtime, blob, source: 'onedrive', rid: f.id, ctag: f.ctag });
    done++; changed = true;
    emit('docs-changed', obra.id);
  }
  // Documents que s'han tret de 001_Projecte (només els que venien de OneDrive)
  for (const l of local) if (l.source === 'onedrive' && !wanted.has(l.path)) { await db.del('files', l.key); changed = true; }
  const cur = await store.getObra(obra.id);
  if (cur) { cur.odDocsAt = Date.now(); cur.odDocsCount = remote.length; await db.put('obres', cur); }
  if (changed) emit('docs-changed', obra.id);
}

// ------------------------------------------------------------- visita → 002_Fotos i 003_Documents_obra
async function desiredFiles(obra, visit, items) {
  const F = cfg().folders;
  const folder = visit.odFolder;
  const P = (base, rel) => `${base}/${folder}/${rel}`;
  const { photos, audios, plans } = sortItems(items);
  const out = [];
  const json = (s) => new Blob([s], { type: 'application/json' });
  for (const p of photos) {
    out.push({ path: P(F.fotos, photoFile(p)), v: p.blobId, cid: p.blobId, make: () => getBlob(p.blobId) });
    if (p.annotId) out.push({ path: P(F.fotos, photoAnnotFile(p)), v: p.annotId, cid: p.annotId, make: () => getBlob(p.annotId) });
    if (p.shapes) { const j = JSON.stringify({ foto: photoFile(p), formes: p.shapes }); out.push({ path: P(F.documents, `_dades_app/anotacions/${p.id}.json`), v: hash(j), make: async () => json(j) }); }
  }
  for (const a of audios) out.push({ path: P(F.documents, audioFile(a)), v: a.blobId, cid: a.blobId, make: () => getBlob(a.blobId) });
  for (const pl of plans) {
    if (pl.pdfId) out.push({ path: P(F.documents, planFile(pl, visit)), v: pl.pdfId, cid: pl.pdfId, make: () => getBlob(pl.pdfId) });
    const j = JSON.stringify({ original: pl.src, pagines: pl.pages, meta: pl.pageMeta });
    out.push({ path: P(F.documents, `_dades_app/anotacions/${pl.id}.json`), v: hash(j), make: async () => json(j) });
  }
  if (photos.length) { const csv = buildFotosCsv(items); out.push({ path: P(F.documents, 'Fotos.csv'), v: hash(csv), make: async () => new Blob([csv], { type: 'text/csv' }) }); }
  const md = buildSheetMd(obra, visit, items);
  const base = sheetBase(obra, visit);
  out.push({ path: P(F.documents, base + '.md'), v: hash(md), make: async () => new Blob([md], { type: 'text/markdown' }) });
  const pdfV = hash(md + JSON.stringify(visit.sheetPages || {}) + photos.map((p) => (p.annotThumbId || p.thumbId || '')).join());
  out.push({ path: P(F.documents, base + '.pdf'), v: pdfV, make: () => buildSheetPdf(obra, visit, items) });
  if (visit.sheetPages && Object.keys(visit.sheetPages).length) {
    const j = JSON.stringify({ pagines: visit.sheetPages });
    out.push({ path: P(F.documents, '_dades_app/anotacions/full.json'), v: hash(j), make: async () => json(j) });
  }
  const vj = JSON.stringify({ ...buildVisitJson(obra, visit, items), carpetes: { fotos: `${F.fotos}/${folder}`, documents: `${F.documents}/${folder}` } }, null, 2);
  out.push({ path: P(F.documents, '_dades_app/visita.json'), v: hash(vj), make: async () => json(vj), last: true });
  return out;
}

/** Assigna el nom de la carpeta de la visita evitant col·lisions amb visites d'altres tauletes. */
async function assignVisitFolder(od, visitId) {
  const F = cfg().folders;
  const v = await store.getVisit(visitId);
  if (v.odFolder) return v;
  const used = new Set();
  for (const f of [F.fotos, F.documents]) {
    const pid = await G.ensureFolder(od.driveId, od.id, f);
    for (const c of await G.listChildren(od.driveId, pid)) if (c.folder) used.add(c.name);
  }
  const nums = [...used].map((n) => Number((/_Visita (\d+)$/.exec(n) || [])[1] || 0));
  let num = v.num;
  if (used.has(visitFolderName(v))) num = Math.max(v.num, ...nums) + 1;
  const cur = await store.getVisit(visitId);
  cur.num = num; cur.odFolder = visitFolderName(cur);
  await db.put('visites', cur);
  return cur;
}

export async function syncVisit(od, obra, visitId) {
  let visit = await store.getVisit(visitId);
  if (!visit || !visit.dirty) return;
  const startedAt = visit.updatedAt;
  visit = await assignVisitFolder(od, visitId);
  const items = await store.listItems(visitId);
  const files = await desiredFiles(obra, visit, items);
  const remote = (await db.get('remote', visitId)) || { visitId, files: {} };
  const want = new Set(files.map((f) => f.path));
  const save = () => db.put('remote', remote);
  const dir = (p) => p.slice(0, p.lastIndexOf('/'));
  const name = (p) => p.slice(p.lastIndexOf('/') + 1);

  const todo = files.filter((f) => remote.files[f.path]?.v !== f.v);
  let done = 0;
  const progress = () => setState({ current: { label: `Pujant visita ${visit.num} (${obra.ref})`, done, total: todo.length } });
  progress();
  for (const f of [...todo.filter((x) => !x.last), ...todo.filter((x) => x.last)]) {
    // Mateix contingut amb un altre nom → es reanomena/mou a OneDrive
    if (f.cid) {
      const old = Object.keys(remote.files).find((k) => remote.files[k].cid === f.cid && k !== f.path && !want.has(k));
      if (old && remote.files[old].id) {
        try {
          const parentId = await G.ensureFolder(od.driveId, od.id, dir(f.path));
          const it = await G.renameMove(od.driveId, remote.files[old].id, { name: name(f.path), parentId: dir(old) !== dir(f.path) ? parentId : undefined });
          remote.files[f.path] = { ...remote.files[old], id: it.id }; delete remote.files[old]; await save();
          done++; progress(); continue;
        } catch (e) { if (e instanceof AuthError) throw e; /* si falla, es puja de nou i s'esborra l'antic */ }
      }
    }
    const blob = await f.make();
    if (!blob) throw new Error('Falta el contingut local de ' + f.path);
    const parentId = await G.ensureFolder(od.driveId, od.id, dir(f.path));
    const it = await G.upload(od.driveId, parentId, name(f.path), blob);
    remote.files[f.path] = { v: f.v, cid: f.cid || null, id: it.id, size: blob.size, at: Date.now() };
    await save();
    done++; progress();
  }
  for (const k of Object.keys(remote.files)) {
    if (want.has(k)) continue;
    if (remote.files[k].id) await G.remove(od.driveId, remote.files[k].id);
    delete remote.files[k]; await save();
  }
  const cur = await store.getVisit(visitId);
  if (cur && cur.updatedAt === startedAt) { cur.dirty = false; cur.uploadedAt = Date.now(); cur.lastError = null; await db.put('visites', cur); }
  emit('changed', { visitId, fromSync: true });
}

export { accountInfo };
