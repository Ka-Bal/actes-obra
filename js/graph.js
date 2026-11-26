// Accés a OneDrive amb Microsoft Graph: carpetes, llistes, descàrrega, pujada (fitxers grans per parts),
// reanomenar, moure i esborrar.
import { cfg, getToken, AuthError } from './auth.js';
import { kv } from './db.js';

export class GraphError extends Error {
  constructor(status, msg, code) { super(msg); this.status = status; this.code = code; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const enc = (path) => String(path).split('/').filter(Boolean).map(encodeURIComponent).join('/');

async function gfetch(url, { method = 'GET', body, json, headers = {}, auth = true, raw = false } = {}) {
  const full = /^https?:/.test(url) ? url : cfg().graphBase.replace(/\/$/, '') + url;
  let forced = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const h = { ...headers };
    if (auth) h.Authorization = 'Bearer ' + (await getToken({ force: forced }));
    if (json !== undefined) h['Content-Type'] = 'application/json';
    let res;
    try { res = await fetch(full, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : body, cache: 'no-store' }); }
    catch { throw new AuthError('offline', 'Sense connexió amb OneDrive'); }
    if (res.status === 401 && auth && !forced) { forced = true; continue; }
    if ([429, 500, 502, 503, 504].includes(res.status) && attempt < 4) {
      const ra = Number(res.headers.get('Retry-After')) || (2 ** attempt);
      await sleep(Math.min(ra, 30) * 1000); continue;
    }
    if (!res.ok) {
      let msg = res.statusText, code = '';
      try { const j = await res.json(); msg = j.error?.message || msg; code = j.error?.code || ''; } catch { /* */ }
      throw new GraphError(res.status, msg, code);
    }
    if (raw) return res;
    if (res.status === 204) return null;
    const txt = await res.text();
    return txt ? JSON.parse(txt) : null;
  }
  throw new GraphError(503, 'OneDrive no respon. Es tornarà a provar més tard.');
}

const itemUrl = (driveId, id, rel = '') => `/drives/${driveId}/items/${id}` + (rel ? `:/${enc(rel)}:` : '');

// ------------------------------------------------------------- carpeta general
/** Localitza la carpeta general (p. ex. «02 - EXPEDIENTS - Obra») → { driveId, id, name } */
export async function resolveRoot({ refresh = false } = {}) {
  const c = cfg();
  // Carpeta triada amb l'assistent (té prioritat)
  const picked = await kv.get('odRootPicked', null);
  if (picked && picked.driveId && picked.id) return picked;
  const sig = (c.rootShareUrl || '') + '|' + (c.rootPath || '');
  const cached = await kv.get('odRoot');
  if (!refresh && cached && cached.sig === sig) return cached;
  let item;
  if (c.rootShareUrl) {
    const b64 = btoa(unescape(encodeURIComponent(c.rootShareUrl.trim()))).replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
    item = await gfetch(`/shares/u!${b64}/driveItem`);
  } else {
    try { item = await gfetch(`/me/drive/root:/${enc(c.rootPath)}`); }
    catch (e) {
      if (e.status === 404) throw new GraphError(404, `No es troba la carpeta «${c.rootPath}» al OneDrive de l'usuari. Si és una carpeta compartida, indica'n l'enllaç a Configuració → OneDrive.`);
      throw e;
    }
  }
  // Drecera a una carpeta compartida ("Afegeix a Els meus fitxers")
  const target = item.remoteItem ? { driveId: item.remoteItem.parentReference.driveId, id: item.remoteItem.id } : { driveId: item.parentReference.driveId, id: item.id };
  const root = { ...target, name: item.name, sig };
  await kv.set('odRoot', root);
  return root;
}

// ------------------------------------------------------------- consultes
export async function getItem(driveId, id, rel = '') {
  try { return await gfetch(itemUrl(driveId, id, rel)); }
  catch (e) { if (e.status === 404) return null; throw e; }
}

export async function listChildren(driveId, id, rel = '') {
  const out = [];
  let url = itemUrl(driveId, id, rel) + '/children?$top=200';
  while (url) {
    const r = await gfetch(url);
    out.push(...(r.value || []));
    url = r['@odata.nextLink'] || null;
  }
  return out;
}

/** Tots els fitxers d'una carpeta i subcarpetes → [{ path, id, size, mtime, ctag, downloadUrl }] */
export async function listRecursive(driveId, id, prefix = '', depth = 0, out = []) {
  if (depth > 8 || out.length > 5000) return out;
  for (const it of await listChildren(driveId, id)) {
    const p = prefix ? prefix + '/' + it.name : it.name;
    if (it.folder) await listRecursive(driveId, it.id, p, depth + 1, out);
    else if (it.file && !it.name.startsWith('~$') && !it.name.startsWith('.')) {
      out.push({ path: p, id: it.id, size: it.size, mtime: Date.parse(it.lastModifiedDateTime) || 0, ctag: it.cTag || it.eTag || '', downloadUrl: it['@microsoft.graph.downloadUrl'] || null, driveId });
    }
  }
  return out;
}

export async function download(f) {
  let url = f.downloadUrl;
  if (url) {
    const res = await fetch(url).catch(() => null);
    if (res && res.ok) return res.blob();
  }
  // URL caducada o no disponible: es demana de nou
  const fresh = await gfetch(`/drives/${f.driveId}/items/${f.id}`);
  url = fresh['@microsoft.graph.downloadUrl'];
  if (url) { const r = await fetch(url).catch(() => null); if (r && r.ok) return r.blob(); }
  const r = await gfetch(`/drives/${f.driveId}/items/${f.id}/content`, { raw: true });
  return r.blob();
}

// ------------------------------------------------------------- carpetes
const folderCache = new Map();

export async function createFolder(driveId, parentId, name) {
  try {
    return await gfetch(`/drives/${driveId}/items/${parentId}/children`, { method: 'POST', json: { name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' } });
  } catch (e) {
    if (e.status === 409) return getItem(driveId, parentId, name);
    throw e;
  }
}

/** Assegura que existeix la ruta de carpetes (relativa a parentId) i en retorna l'ID. */
export async function ensureFolder(driveId, parentId, rel) {
  const parts = String(rel || '').split('/').filter(Boolean);
  let cur = parentId, acc = '';
  for (const p of parts) {
    acc += '/' + p;
    const key = `${driveId}|${parentId}|${acc}`;
    if (folderCache.has(key)) { cur = folderCache.get(key); continue; }
    let it = await getItem(driveId, cur, p);
    if (!it) it = await createFolder(driveId, cur, p);
    if (!it || !it.folder) throw new GraphError(409, `«${p}» existeix però no és una carpeta`);
    folderCache.set(key, it.id);
    cur = it.id;
  }
  return cur;
}
export const forgetFolders = () => folderCache.clear();

// ------------------------------------------------------------- pujada
const SMALL = 4 * 1024 * 1024 - 1024;
const CHUNK = 320 * 1024 * 10; // múltiple de 320 KiB (requisit de OneDrive)

export async function upload(driveId, parentId, name, blob, onProgress) {
  if (blob.size <= SMALL) {
    return gfetch(`${itemUrl(driveId, parentId, name)}/content?@microsoft.graph.conflictBehavior=replace`, {
      method: 'PUT', body: blob, headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    });
  }
  const s = await gfetch(`${itemUrl(driveId, parentId, name)}/createUploadSession`, {
    method: 'POST', json: { item: { '@microsoft.graph.conflictBehavior': 'replace' } },
  });
  let start = 0;
  while (start < blob.size) {
    const end = Math.min(start + CHUNK, blob.size);
    let res;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(s.uploadUrl, { method: 'PUT', body: blob.slice(start, end), headers: { 'Content-Range': `bytes ${start}-${end - 1}/${blob.size}` } });
      } catch {
        if (attempt < 3) { await sleep(2000 * (attempt + 1)); continue; }
        throw new AuthError('offline', 'Sense connexió amb OneDrive');
      }
      if (res.ok || res.status === 202) break;
      if (attempt < 3 && [500, 502, 503, 504].includes(res.status)) { await sleep(2000 * (attempt + 1)); continue; }
      throw new GraphError(res.status, 'Error pujant el fitxer per parts');
    }
    onProgress && onProgress(end / blob.size);
    if (res.status === 200 || res.status === 201) return res.json();
    const j = await res.json().catch(() => ({}));
    const next = j.nextExpectedRanges && j.nextExpectedRanges[0];
    start = next ? Number(next.split('-')[0]) : end;
  }
  throw new GraphError(500, 'Pujada incompleta');
}

/** Reanomena i/o mou un element. */
export function renameMove(driveId, id, { name, parentId }) {
  const body = {};
  if (name) body.name = name;
  if (parentId) body.parentReference = { id: parentId };
  return gfetch(`/drives/${driveId}/items/${id}`, { method: 'PATCH', json: body });
}

export async function remove(driveId, id) {
  try { await gfetch(`/drives/${driveId}/items/${id}`, { method: 'DELETE' }); }
  catch (e) { if (e.status !== 404) throw e; }
}

// ------------------------------------------------------------- navegador de carpetes (assistent)
export async function myDriveRoot() {
  const r = await gfetch('/me/drive/root');
  return { driveId: r.parentReference?.driveId || (await gfetch('/me/drive')).id, id: r.id, name: 'Els meus fitxers' };
}
/** Carpetes compartides amb mi (inclou les de SharePoint/Teams que m'han compartit) */
export async function sharedFolders() {
  try {
    const r = await gfetch('/me/drive/sharedWithMe?$top=200');
    return (r.value || []).filter((i) => (i.remoteItem && i.remoteItem.folder) || i.folder)
      .map((i) => ({ driveId: i.remoteItem ? i.remoteItem.parentReference.driveId : i.parentReference.driveId, id: i.remoteItem ? i.remoteItem.id : i.id, name: i.name }));
  } catch { return []; }
}
/** Subcarpetes d'una carpeta (les dreceres a carpetes compartides es resolen) */
export async function subfolders(driveId, id) {
  const items = await listChildren(driveId, id);
  return items.filter((i) => i.folder || (i.remoteItem && i.remoteItem.folder))
    .map((i) => (i.remoteItem ? { driveId: i.remoteItem.parentReference.driveId, id: i.remoteItem.id, name: i.name } : { driveId, id: i.id, name: i.name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ca', { numeric: true }));
}
export async function resolveShareLink(url) {
  const b64 = btoa(unescape(encodeURIComponent(url.trim()))).replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
  const item = await gfetch(`/shares/u!${b64}/driveItem`);
  return { driveId: item.parentReference.driveId, id: item.id, name: item.name };
}
