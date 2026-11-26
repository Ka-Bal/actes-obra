// «Desa a OneDrive manualment»: fa servir el full de compartir de l'iPad (Desa a Fitxers → OneDrive).
// No cal cap configuració: l'app OneDrive de l'iPad ja té la sessió iniciada i puja els fitxers quan hi ha xarxa.
//   Pas 1: fotos (originals i anotades)  → 02 - EXPEDIENTS - Obra / E_XX_XXX / 002_Fotos / AAAA_MM_DD_Visita N
//   Pas 2: documentació                   → 02 - EXPEDIENTS - Obra / E_XX_XXX / 003_Documents_obra / AAAA_MM_DD_Visita N
import { h, icon, clear, modal, toast } from './ui.js';
import { getBlob } from './db.js';
import * as store from './store.js';
import { cfg, isConfigured } from './auth.js';
import { visitFolderName } from './onedrive.js';
import {
  buildSheetMd, buildSheetPdf, buildFotosCsv, buildVisitJson, sheetBase,
  photoFile, photoAnnotFile, audioFile, planFile, sortItems,
} from './exporter.js';

const leaf = (p) => p.split('/').pop();
const typeOf = (n) => (/\.jpe?g$/i.test(n) ? 'image/jpeg' : /\.png$/i.test(n) ? 'image/png' : /\.pdf$/i.test(n) ? 'application/pdf'
  : /\.m4a$/i.test(n) ? 'audio/mp4' : /\.webm$/i.test(n) ? 'audio/webm' : /\.csv$/i.test(n) ? 'text/csv' : /\.json$/i.test(n) ? 'application/json' : 'text/plain');

async function buildFiles(obra, visitId) {
  const v = await store.getVisit(visitId);
  const items = await store.listItems(visitId);
  const { photos, audios, plans } = sortItems(items);
  const fotos = [], docs = [];
  const add = (arr, name, blob) => { if (blob) arr.push(new File([blob], leaf(name), { type: typeOf(name) })); };
  for (const p of photos) {
    add(fotos, photoFile(p), await getBlob(p.blobId));
    if (p.annotId) add(fotos, photoAnnotFile(p), await getBlob(p.annotId));
  }
  const base = sheetBase(obra, v);
  add(docs, base + '.pdf', await buildSheetPdf(obra, v, items));
  add(docs, base + '.md', new Blob([buildSheetMd(obra, v, items)]));
  if (photos.length) add(docs, 'Fotos.csv', new Blob([buildFotosCsv(items)]));
  for (const pl of plans) if (pl.pdfId) add(docs, planFile(pl, v), await getBlob(pl.pdfId));
  for (const a of audios) add(docs, audioFile(a), await getBlob(a.blobId));
  add(docs, 'visita.json', new Blob([JSON.stringify(buildVisitJson(obra, v, items), null, 2)]));
  return { v, fotos, docs };
}

function shareable(files) {
  if (!navigator.share || !navigator.canShare) return null;
  try { if (navigator.canShare({ files })) return files; } catch { /* */ }
  const ok = files.filter((f) => { try { return navigator.canShare({ files: [f] }); } catch { return false; } });
  return ok.length ? ok : null;
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Nom copiat: enganxa\'l en crear la carpeta'); }
  catch { toast('Mantén el dit sobre el nom per copiar-lo', 'error'); }
}

export async function manualSave(obra, visitId, refresh) {
  const F = cfg().folders || { fotos: '002_Fotos', documents: '003_Documents_obra' };
  const v0 = await store.getVisit(visitId);
  const folder = v0.odFolder || visitFolderName(v0);
  const root = cfg().rootPath || '02 - EXPEDIENTS - Obra';
  const expName = obra.remote?.name || obra.ref;
  const steps = h('div.manual-files', {}, h('div.row', {}, h('div.spinner'), 'Preparant els fitxers…'));
  const m = modal({
    title: 'Desa a OneDrive manualment', wide: true,
    body: h('div.form', {},
      h('p', {}, 'Es fa servir l\'app ', h('b', {}, 'OneDrive'), ' de l\'iPad: funciona encara que ara no hi hagi connexió (OneDrive ho pujarà en tornar la xarxa).'),
      h('div.wiz-card', {},
        h('b', {}, 'Nom de la carpeta d\'aquesta visita:'),
        h('div.wiz-copy', {}, h('code', {}, folder), h('button.btn.small', { type: 'button', onclick: () => copy(folder) }, 'Copia'))),
      h('details.adv', {}, h('summary', {}, 'Com es fa? (llegeix-ho el primer cop)'),
        h('ol.wiz-list', {},
          h('li', {}, 'Toca el botó del pas. S\'obre el full de compartir de l\'iPad.'),
          h('li', {}, 'Tria ', h('b', {}, '«Desa a Fitxers»'), ' (si no surt, llisca la fila d\'accions cap avall).'),
          h('li', {}, 'A l\'esquerra tria ', h('b', {}, 'OneDrive'), ' i entra a: ', h('b', {}, `${root} › ${expName} › …`), ' (la carpeta que indica el pas).'),
          h('li', {}, 'Si la carpeta de la visita encara no existeix: toca la icona de ', h('b', {}, 'carpeta nova'), ' (a dalt), enganxa el nom copiat i entra-hi.'),
          h('li', {}, 'Toca ', h('b', {}, 'Desa'), '. Fet. Repeteix-ho amb el pas 2.'))),
      steps),
    actions: [{ label: 'Tanca' }],
  });

  let data;
  try { data = await buildFiles(obra, visitId); }
  catch (e) { clear(steps).append(h('p.error', {}, 'No s\'han pogut preparar els fitxers: ' + e.message)); return; }

  const done = { fotos: false, docs: false };
  const mark = async (part) => {
    done[part] = true;
    const v = await store.getVisit(visitId);
    v.manualSave = { ...(v.manualSave || {}), [part]: Date.now() };
    const ms = v.manualSave;
    const complete = (!data.fotos.length || ms.fotos > v.updatedAt) && ms.docs > v.updatedAt;
    if (complete && !isConfigured()) { v.dirty = false; v.sentAt = Date.now(); v.sentInfo = { mode: 'onedrive-manual', name: folder }; }
    await store.saveVisit(v, { touch: false });
    refresh && refresh();
  };

  const step = (n, part, title, dest, files) => {
    const list = shareable(files);
    const total = files.reduce((a, f) => a + f.size, 0);
    const el = h('div.manual-step', {},
      h('span.num', {}, String(n)),
      h('div', {}, h('b', {}, `${title} (${files.length} fitxer${files.length === 1 ? '' : 's'}, ${(total / 1048576).toFixed(1)} MB)`), h('br'),
        h('span.muted.small', {}, 'Desa-ho a: '), h('b.small', {}, dest)),
      list ? h('button.btn.primary', { type: 'button', onclick: async () => {
        try {
          await navigator.share({ files: list, title: `${obra.ref} · ${folder}` });
          el.classList.add('done'); el.querySelector('.num').textContent = '✓'; await mark(part);
          toast(part === 'fotos' ? 'Fotos desades' : 'Documentació desada');
        } catch (e) { if (e.name !== 'AbortError') toast('No s\'ha pogut obrir el full de compartir: ' + e.message, 'error'); }
      } }, icon('upload'), n === 1 ? 'Desa les fotos' : 'Desa la documentació')
        : h('span.muted.small', {}, 'Aquest navegador no permet desar fitxers així (fes-ho des de l\'iPad).'));
    if (list && list.length < files.length) el.appendChild(h('p.hint', {}, `${files.length - list.length} fitxer(s) no es poden compartir des d'aquest navegador.`));
    return el;
  };

  clear(steps).append(
    data.fotos.length ? step(1, 'fotos', 'Fotos', `${expName} › ${F.fotos} › ${folder}`, data.fotos) : h('p.muted', {}, 'Aquesta visita no té fotos.'),
    step(2, 'docs', 'Documentació: full de visita, plànols anotats, àudios i dades', `${expName} › ${F.documents} › ${folder}`, data.docs));
  return m;
}

/** Fitxers d'una foto (original i anotada), preparats abans del toc (Safari exigeix compartir dins del toc). */
export async function preparePhotoFiles(it) {
  const files = [];
  const b = await getBlob(it.blobId); if (b) files.push(new File([b], photoFile(it), { type: 'image/jpeg' }));
  if (it.annotId) { const a = await getBlob(it.annotId); if (a) files.push(new File([a], photoAnnotFile(it), { type: 'image/jpeg' })); }
  return shareable(files);
}
export function shareNow(list, title) {
  if (!list) { toast('Aquest navegador no permet compartir fitxers (fes-ho des de l\'iPad).', 'error'); return; }
  navigator.share({ files: list, title }).catch((e) => { if (e.name !== 'AbortError') toast(e.message, 'error'); });
}
