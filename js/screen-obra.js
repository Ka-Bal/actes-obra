// Versió portàtil — fitxa d'obra: visites, documentació local (carpeta de l'obra a la tauleta) i participants
import { h, icon, live, clear, modal, toast, busy, confirmDlg, fmtDate, fmtSize, fmtTime, todayKey } from './ui.js';
import { getBlob } from './db.js';
import * as store from './store.js';
import { importDocsZip } from './zipper.js';
import { openAnnotator } from './annotator.js';
import { openPdf } from './pdfsrc.js';
import { go, topbar, newObra } from './app.js';

const extIcon = (p) => { const e = store.extOf(p); return e === 'pdf' ? 'pdf' : ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic'].includes(e) ? 'image' : 'file'; };
const baseName = (p) => p.split('/').pop();
const dirName = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

export async function renderObra(view, id, tab) {
  const obra = await store.getObra(id);
  if (!obra) throw new Error('Aquesta obra no és en aquesta tauleta.');
  const more = h('button.icon-btn', { 'aria-label': 'Opcions de l\'obra', onclick: () => obraMenu(obra) }, icon('more'));
  view.appendChild(topbar({ title: obra.titol, sub: obra.ref, back: '#/', actions: [more] }));
  const page = h('div.page');
  view.appendChild(page);
  const docs = await store.listDocs(obra.id);
  page.append(
    h('div.hero', {},
      h('button.btn.primary.huge', { onclick: () => newVisit(obra) }, icon('plus'), 'Nova visita'),
      h('div.hero-info', {}, h('b', {}, `${docs.length} documents a la tauleta`), h('br'),
        h('span.muted', {}, docs.length ? 'Els plànols es poden consultar i anotar sense connexió.' : 'Carrega els plànols i documents a la pestanya Documentació.'))),
    h('nav.tabs', {}, [['visites', 'Visites', 'camera'], ['docs', 'Documentació', 'folder'], ['participants', 'Participants', 'users']].map(([k, l, ic]) =>
      h('a.tab' + (tab === k ? '.on' : ''), { href: `#/obra/${encodeURIComponent(id)}/${k}` }, icon(ic), l))));
  const body = h('div.tab-body');
  page.appendChild(body);
  if (tab === 'docs') await renderDocs(body, obra);
  else if (tab === 'participants') renderParticipants(body, obra);
  else await renderVisits(body, obra);
}

async function obraMenu(obra) {
  modal({
    title: obra.ref,
    body: h('div.form', {},
      h('button.btn', { onclick: () => newObra(obra) }, icon('edit'), 'Canvia el títol de l\'obra'),
      h('button.btn.danger.ghost', { onclick: async () => {
        const vs = await store.listVisits(obra.id);
        const pend = vs.filter((v) => v.dirty).length;
        const msg = `S'esborrarà de la tauleta l'obra ${obra.ref}, la seva documentació i ${vs.length} visita/es.` + (pend ? ` ATENCIÓ: ${pend} visita/es tenen canvis sense enviar i es perdran.` : '');
        if (!(await confirmDlg(msg, { ok: 'Esborra l\'obra', danger: true }))) return;
        await store.deleteObra(obra); go('#/');
      } }, icon('trash'), 'Esborra l\'obra d\'aquesta tauleta')),
    actions: [{ label: 'Tanca' }],
  });
}

// ------------------------------------------------------------- visites
async function renderVisits(body, obra) {
  const local = await store.listVisits(obra.id);
  const list = h('div.list');
  for (const v of local) {
    const items = await store.listItems(v.id);
    const n = (k) => items.filter((i) => i.kind === k).length;
    list.appendChild(h('button.list-item', { onclick: () => go('#/visita/' + v.id) },
      h('div.li-main', {},
        h('div.li-title', {}, `Visita ${v.num}`, h('span.muted', {}, ' · ' + fmtDate(v.date))),
        h('div.li-sub', {}, `${n('photo')} fotos · ${n('plan')} plànols · ${n('audio')} àudios${v.author ? ' · ' + v.author : ''}`)),
      statusChip(v), icon('chevron')));
  }
  if (!local.length) list.appendChild(h('div.empty', {}, 'Encara no hi ha visites d\'aquesta obra.'));
  body.append(h('h3.sec', {}, 'Visites'), list);
}

export function statusChip(v) {
  if (v.dirty && v.sentAt) return h('span.chip.pend', { title: 'Enviada el ' + fmtDate(v.sentAt) }, 'Canvis per enviar');
  if (v.dirty) return h('span.chip.pend', {}, 'Per enviar');
  const what = v.sentInfo?.mode === 'desat' ? 'ZIP desat' : 'Enviada';
  return h('span.chip.ok', {}, icon('check'), `${what} ${fmtDate(v.sentAt)} ${fmtTime(v.sentAt)}`);
}

export async function newVisit(obra, { then } = {}) {
  const sel = new Set();
  const extra = [];
  const parts = obra.participants || [];
  const listEl = h('div.checks');
  const key = (p) => p.nom + '|' + (p.empresa || '');
  const paint = () => {
    clear(listEl);
    [...parts, ...extra].forEach((p, i) => {
      listEl.appendChild(h('label.check' + (sel.has(key(p)) ? '.on' : ''), {},
        h('input', { type: 'checkbox', checked: sel.has(key(p)), onchange: (e) => { e.target.checked ? sel.add(key(p)) : sel.delete(key(p)); paint(); } }),
        h('span', {}, h('b', {}, p.nom), p.empresa ? h('small', {}, p.empresa) : null),
        i >= parts.length ? h('em.muted', {}, ' (puntual)') : null));
    });
    if (!parts.length && !extra.length) listEl.appendChild(h('p.muted', {}, 'Aquesta obra no té participants habituals. Pots afegir-ne a la pestanya Participants o afegir assistents puntuals aquí.'));
  };
  paint();
  const nom = h('input.input', { placeholder: 'Nom' }), emp = h('input.input', { placeholder: 'Empresa o rol' });
  const date = h('input.input', { type: 'date', value: todayKey().replace(/_/g, '-') });
  modal({
    title: `Nova visita · ${obra.ref}`, wide: true,
    body: h('div.form', {},
      h('label', {}, 'Data de la visita', date),
      h('div', {}, h('div.lbl', {}, 'Assistents (marca qui hi és)'), listEl),
      h('div.row.add-row', {}, nom, emp, h('button.btn', { onclick: () => {
        if (!nom.value.trim()) return;
        const p = { nom: nom.value.trim(), empresa: emp.value.trim() };
        extra.push(p); sel.add(key(p)); nom.value = ''; emp.value = ''; paint();
      } }, icon('plus'), 'Assistent puntual'))),
    actions: [{ label: 'Cancel·la' }, {
      label: 'Comença la visita', primary: true, icon: 'camera', onClick: async () => {
        const assistents = [...parts, ...extra].filter((p) => sel.has(key(p)));
        const v = await store.createVisit(obra, { date: (date.value || todayKey()).replace(/-/g, '_'), assistents });
        if (then) then(v); else go('#/visita/' + v.id);
      },
    }],
  });
}

// ------------------------------------------------------------- documentació local
async function renderDocs(body, obra) {
  const search = h('input.input.search', { type: 'search', placeholder: 'Cerca un document…' });
  const listEl = h('div.doclist');
  const info = h('p.muted.small');
  body.append(
    h('div.banner', {}, icon('info'), h('div', {}, 'Carrega aquí els plànols i documents de l\'obra (PDF o imatges). Es guarden a la tauleta i es poden consultar i anotar sense connexió. ',
      h('b', {}, 'Consell: '), 'des del despatx, comprimeix en un ZIP la carpeta de plànols de l\'expedient i envia-la a la tauleta; després importa-la amb «Importa un ZIP».')),
    h('div.row.between', {}, search, h('div.row', {},
      h('button.btn.primary', { onclick: () => addFiles(obra) }, icon('plus'), 'Afegeix fitxers'),
      h('button.btn', { onclick: () => importZip(obra) }, icon('download'), 'Importa un ZIP'))),
    info, listEl);
  let docs = await store.listDocs(obra.id);
  const paint = () => {
    clear(listEl);
    const q = search.value.trim().toLowerCase();
    const files = docs.filter((f) => !q || f.path.toLowerCase().includes(q));
    const total = docs.reduce((a, f) => a + f.size, 0);
    info.textContent = `${docs.length} documents · ${fmtSize(total)}`;
    let lastDir = null;
    for (const f of files) {
      const d = dirName(f.path);
      if (d !== lastDir) { listEl.appendChild(h('div.dir', {}, icon('folder'), d || '(sense carpeta)')); lastDir = d; }
      listEl.appendChild(h('div.doc-row', {},
        h('button.doc', { onclick: () => openDoc(obra, f) }, icon(extIcon(f.path)), h('span.doc-name', {}, baseName(f.path)), h('span.muted.small', {}, fmtSize(f.size))),
        h('button.icon-btn', { 'aria-label': 'Esborra', onclick: async () => {
          if (!(await confirmDlg(`Esborrar «${baseName(f.path)}» de la tauleta? Les anotacions que ja s'hagin fet sobre aquest plànol es conserven a les visites.`, { ok: 'Esborra', danger: true }))) return;
          await store.deleteDoc(obra.id, f.path);
        } }, icon('trash'))));
    }
    if (!files.length) listEl.appendChild(h('div.empty', {}, q ? 'Cap document coincideix amb la cerca.' : 'Encara no hi ha documents. Toca «Afegeix fitxers» o «Importa un ZIP».'));
  };
  search.addEventListener('input', paint);
  paint();
  live(listEl, 'docs-changed', async (exp) => { if (exp === obra.id) { docs = await store.listDocs(obra.id); paint(); } });
}

async function addFiles(obra) {
  const docs = await store.listDocs(obra.id);
  const dirs = [...new Set(docs.map((f) => dirName(f.path)).filter(Boolean))].sort();
  const folder = h('input.input', { list: 'dirs-dl', value: dirs[0] || 'Plànols', placeholder: 'Carpeta (p. ex. Plànols)' });
  const input = h('input', { type: 'file', multiple: true, accept: 'application/pdf,image/*,.pdf,.dxf,.dwg,.docx,.xlsx' });
  modal({
    title: 'Afegir documents a l\'obra',
    body: h('div.form', {},
      h('label', {}, 'Carpeta', folder, h('datalist', { id: 'dirs-dl' }, ['Plànols', 'Documents', 'Seguretat i salut', ...dirs].map((d) => h('option', { value: d })))),
      h('label', {}, 'Fitxers (des de Fitxers, iCloud, OneDrive, correu…)', input)),
    actions: [{ label: 'Cancel·la' }, {
      label: 'Afegeix', primary: true, icon: 'plus', onClick: async () => {
        const files = [...input.files];
        if (!files.length) { toast('Tria algun fitxer', 'error'); return false; }
        const b = busy('Guardant a la tauleta…');
        try { await store.addDocs(obra.id, folder.value, files); toast(`${files.length} document(s) afegit(s)`); }
        catch (e) { toast(e.message, 'error'); } finally { b.close(); }
      },
    }],
  });
}

async function importZip(obra) {
  const input = h('input', { type: 'file', accept: '.zip,application/zip,application/x-zip-compressed' });
  input.addEventListener('change', async () => {
    const f = input.files[0]; if (!f) return;
    const b = busy('Important el ZIP…');
    try {
      const n = await importDocsZip(obra.id, f, { onProgress: (i, t) => b.set(`Important ${i + 1} de ${t}…`) });
      toast(`${n} documents importats`);
    } catch (e) { toast('No s\'ha pogut llegir el ZIP: ' + e.message, 'error'); } finally { b.close(); }
  });
  input.click();
}

export async function openDoc(obra, f) {
  const ext = store.extOf(f.path);
  if (ext === 'pdf') {
    const b = busy('Obrint el document…');
    let pdf;
    try { pdf = await openPdf(await store.getDocBlob(obra.id, f)); } catch (e) { b.close(); return toast(e.message, 'error'); }
    b.close();
    await openAnnotator({
      kind: 'pdf', pdf, editable: false, title: baseName(f.path),
      actions: [{ label: 'Anota en una visita', icon: 'pen', onClick: async (ann) => { await ann.close(); chooseVisitFor(obra, f); } }],
    });
    pdf.destroy();
  } else if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) {
    try { await openAnnotator({ kind: 'image', bitmap: await createImageBitmap(await store.getDocBlob(obra.id, f)), editable: false, title: baseName(f.path) }); }
    catch (e) { toast(e.message, 'error'); }
  } else {
    // Altres formats: es lliuren al sistema perquè els obri una altra app
    const blob = await store.getDocBlob(obra.id, f);
    const file = new File([blob], baseName(f.path), { type: blob.type || 'application/octet-stream' });
    try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return; } } catch (e) { if (e.name === 'AbortError') return; }
    const a = h('a', { href: URL.createObjectURL(blob), download: file.name }); document.body.appendChild(a); a.click(); a.remove();
  }
}

async function chooseVisitFor(obra, f) {
  const visits = await store.listVisits(obra.id);
  const m = modal({
    title: 'Anotar el plànol a…',
    body: h('div.list', {},
      visits.slice(0, 8).map((v) => h('button.list-item', { onclick: () => { m.close(); annotatePlan(obra, v, f); } },
        h('div.li-main', {}, h('div.li-title', {}, `Visita ${v.num}`, h('span.muted', {}, ' · ' + fmtDate(v.date)))), icon('chevron'))),
      h('button.list-item', { onclick: () => { m.close(); newVisit(obra, { then: (v) => { go('#/visita/' + v.id); annotatePlan(obra, v, f); } }); } },
        icon('plus'), h('div.li-main', {}, h('div.li-title', {}, 'Una visita nova')))),
  });
}

export async function annotatePlan(obra, visit, f) {
  let existing = await store.findPlanItem(visit.id, f.path);
  if (existing && f.mtime && existing.src.mtime && existing.src.mtime !== f.mtime) {
    const keep = await confirmDlg('Aquest plànol s\'ha substituït per una versió nova. Vols continuar l\'anotació existent sobre la versió anterior? (Cancel·la per començar una anotació nova sobre la versió actual.)', { ok: 'Continua l\'existent' });
    if (!keep) existing = null;
  }
  const b = busy('Obrint el plànol…');
  let srcBlob, pdf;
  try {
    srcBlob = existing?.srcBlobId ? await getBlob(existing.srcBlobId) : await store.getDocBlob(obra.id, f);
    pdf = await openPdf(srcBlob);
  } catch (e) { b.close(); return toast(e.message, 'error'); }
  b.close();
  await openAnnotator({
    kind: 'pdf', pdf, editable: true, title: `${baseName(f.path)} · Visita ${visit.num}`,
    pages: existing?.pages, pageMeta: existing?.pageMeta,
    onSave: async ({ pages, pageMeta }) => {
      const bb = busy('Desant la còpia anotada…');
      try { await store.savePlanAnnotation(visit, f, { pages, pageMeta }, srcBlob, existing); toast('Plànol anotat desat a la visita'); }
      finally { bb.close(); }
    },
  });
  pdf.destroy();
}

// ------------------------------------------------------------- participants
function renderParticipants(body, obra) {
  const list = h('div.list');
  const paint = () => {
    clear(list);
    (obra.participants || []).forEach((p, i) => list.appendChild(h('div.list-item.static', {},
      icon('users'), h('div.li-main', {}, h('div.li-title', {}, p.nom), h('div.li-sub', {}, p.empresa || '')),
      h('button.icon-btn', { 'aria-label': 'Elimina', onclick: async () => {
        if (!(await confirmDlg(`Treure ${p.nom} dels participants habituals?`, { ok: 'Treu', danger: true }))) return;
        obra.participants.splice(i, 1); await store.updateObraFields(obra, { participants: obra.participants }); paint();
      } }, icon('trash')))));
    if (!(obra.participants || []).length) list.appendChild(h('div.empty', {}, 'Encara no hi ha participants habituals.'));
  };
  paint();
  const nom = h('input.input', { placeholder: 'Nom i cognoms' }), emp = h('input.input', { placeholder: 'Empresa o rol (p. ex. Contractista, Propietat)' });
  const add = async () => {
    if (!nom.value.trim()) return;
    obra.participants = [...(obra.participants || []), { nom: nom.value.trim(), empresa: emp.value.trim() }];
    await store.updateObraFields(obra, { participants: obra.participants });
    nom.value = ''; emp.value = ''; paint(); nom.focus();
  };
  emp.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  body.append(
    h('p.hint', {}, 'Persones que solen assistir a les visites d\'aquesta obra. En cada visita es marquen les que hi són.'),
    list,
    h('div.row.add-row', {}, nom, emp, h('button.btn.primary', { onclick: add }, icon('plus'), 'Afegeix')));
}
