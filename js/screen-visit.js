// Versió portàtil — pantalla de la visita d'obra: fotos, plànols anotats, full d'anotacions, manuscrit, àudio
// i enviament de la visita en un ZIP (correu, WhatsApp…)
import { h, icon, live, clear, modal, toast, busy, confirmDlg, promptDlg, fmtDate, fmtDur, fmtSize, fmtTime } from './ui.js';
import { kv, getBlob } from './db.js';
import * as store from './store.js';
import { buildVisitZip, estimateSize, zipName, canShareFile, shareFiles, downloadBlob } from './zipper.js';
import { openAnnotator } from './annotator.js';
import { dictationButton } from './dictation.js';
import { manualSave, preparePhotoFiles, shareNow } from './manual-save.js';
import { isConfigured, cfg } from './auth.js';
import { kick as odKick, odState, visitFolderName } from './onedrive.js';
import { openPdf } from './pdfsrc.js';
import { drawShapes } from './draw.js';
import { photoFile, sheetBase } from './exporter.js';
import { go, topbar } from './app.js';
import { statusChip, annotatePlan } from './screen-obra.js';

let urls = [];
const objUrl = (blob) => { const u = URL.createObjectURL(blob); urls.push(u); return u; };
function revokeAll() { urls.forEach((u) => URL.revokeObjectURL(u)); urls = []; }

export async function renderVisit(view, id) {
  revokeAll();
  let v = await store.getVisit(id);
  if (!v) throw new Error('Aquesta visita no és en aquest dispositiu.');
  const obra = await store.getObra(v.exp);
  if (!obra) throw new Error('Obra no trobada');

  const more = h('button.icon-btn', { 'aria-label': 'Més opcions', onclick: () => visitMenu(obra, id) }, icon('more'));
  const send = isConfigured() ? null : h('button.btn.small.send-top', { onclick: () => manualSave(obra, id, refresh) }, icon('upload'), h('span', {}, 'Desa a OneDrive'));
  view.appendChild(topbar({ title: `Visita ${v.num} · ${fmtDate(v.date)}`, sub: obra.titol === obra.ref ? obra.ref : `${obra.ref} · ${obra.titol}`, back: '#/obra/' + encodeURIComponent(obra.id), actions: [send, more].filter(Boolean) }));

  // Entrades de fitxer (càmera i galeria)
  const cam = h('input.hidden', { type: 'file', accept: 'image/*', capture: 'environment' });
  const gal = h('input.hidden', { type: 'file', accept: 'image/*', multiple: true });
  const onFiles = async (input) => {
    const files = [...input.files]; input.value = '';
    if (!files.length) return;
    const b = files.length > 1 ? busy('Afegint fotos…') : null;
    let last;
    try { for (const f of files) last = await store.addPhoto(await store.getVisit(id), f); }
    catch (e) { toast('No s\'ha pogut desar la foto: ' + e.message, 'error'); }
    finally { b && b.close(); }
    await refresh();
    if (files.length === 1 && last) photoModal(last, { isNew: true });
  };
  cam.addEventListener('change', () => onFiles(cam));
  gal.addEventListener('change', () => onFiles(gal));

  const actionBar = h('div.actionbar', {},
    h('button.act.primary', { onclick: () => cam.click() }, icon('camera'), h('span', {}, 'Foto')),
    h('button.act', { onclick: () => planPicker(obra, id) }, icon('plan'), h('span', {}, 'Plànol')),
    h('button.act', { onclick: () => recordAudio(id, refresh) }, icon('mic'), h('span', {}, 'Àudio')),
    h('button.act', { onclick: () => openSheet(id, null, refresh) }, icon('pen'), h('span', {}, 'Manuscrit')),
    h('button.act.sec', { onclick: () => gal.click() }, icon('image'), h('span', {}, 'Galeria')));

  // ---- seccions
  const secAssist = h('div.assist');
  const secHand = h('div.hand-pages');
  const secPhotos = h('div.photos');
  const secPlans = h('div.list');
  const secAudios = h('div.list');
  const footer = h('div.visit-foot');
  const cntPhotos = h('span.count'), cntPlans = h('span.count'), cntAudios = h('span.count');

  // ---- full d'anotacions (text)
  const ta = h('textarea.sheet', { placeholder: 'Observacions de la visita…\n\nEscriu amb el teclat o dicta amb el micròfon del teclat.', rows: 10 }, v.text || '');
  let saveT = null;
  const flush = async () => { clearTimeout(saveT); saveT = null; const val = ta.value; await store.mutateVisit(id, (x) => { x.text = val; }); };
  ta.addEventListener('input', () => { clearTimeout(saveT); saveT = setTimeout(flush, 700); });
  ta.addEventListener('blur', () => { if (saveT) flush(); });
  window.addEventListener('pagehide', () => { if (saveT) flush(); }, { once: true });
  const dict = dictationButton(ta, () => ta.dispatchEvent(new Event('input')));

  async function refresh() {
    revokeAll();
    v = await store.getVisit(id);
    const items = await store.listItems(id);
    const photos = items.filter((i) => i.kind === 'photo').sort((a, b) => a.createdAt - b.createdAt);
    const plans = items.filter((i) => i.kind === 'plan').sort((a, b) => a.createdAt - b.createdAt);
    const audios = items.filter((i) => i.kind === 'audio').sort((a, b) => a.createdAt - b.createdAt);
    cntPhotos.textContent = photos.length; cntPlans.textContent = plans.length; cntAudios.textContent = audios.length;

    clear(secAssist).append(
      ...(v.assistents?.length ? v.assistents.map((a) => h('span.pill', {}, a.nom, a.empresa ? h('small', {}, ' · ' + a.empresa) : null)) : [h('span.muted', {}, 'Cap assistent indicat')]),
      h('button.btn.small', { onclick: () => editAssistents(obra, id, refresh) }, icon('edit'), 'Edita'));

    clear(secHand);
    const pages = v.sheetPages || {};
    const count = Math.max(v.sheetPageCount || 0, ...Object.keys(pages).map((k) => Number(k) + 1), 0);
    for (let i = 0; i < count; i++) {
      if (!pages[i] || !pages[i].length) continue;
      const c = h('canvas', { width: 150, height: 212 });
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 150, 212);
      ctx.setTransform(150 / 595.28, 0, 0, 150 / 595.28, 0, 0); drawShapes(ctx, pages[i]);
      secHand.appendChild(h('button.hand-thumb', { onclick: () => openSheet(id, i, refresh) }, c, h('span', {}, `Pàgina ${i + 1}`)));
    }
    secHand.appendChild(h('button.hand-thumb.add', { onclick: () => openSheet(id, null, refresh) }, icon('plus'), h('span', {}, 'Nova pàgina')));

    clear(secPhotos);
    for (const p of photos) {
      const tb = await getBlob(p.annotThumbId || p.thumbId);
      secPhotos.appendChild(h('button.photo', { onclick: () => photoModal(p) },
        tb ? h('img', { src: objUrl(tb), alt: p.name, loading: 'lazy' }) : h('div.noimg', {}, icon('image')),
        p.annotId ? h('span.badge', { title: 'Amb anotacions' }, icon('pen')) : null,
        h('div.cap', {}, h('b', {}, p.name), h('span', {}, p.desc || 'Sense descripció'))));
    }
    if (!photos.length) secPhotos.appendChild(h('div.empty', {}, 'Encara no hi ha fotos. Toca «Foto» per fer-ne una.'));

    clear(secPlans);
    for (const pl of plans) {
      const nPages = Object.keys(pl.pages || {}).length;
      secPlans.appendChild(h('div.list-item.static', {},
        icon('pdf'),
        h('button.li-main.link', { onclick: () => annotatePlan(obra, v, { path: pl.src.path, mtime: pl.src.mtime, size: pl.src.size }).then(refresh) },
          h('div.li-title', {}, pl.name), h('div.li-sub', {}, `${nPages} pàgina${nPages === 1 ? '' : 'es'} anotada${nPages === 1 ? '' : 'es'} · original: ${pl.src.path}`)),
        h('button.icon-btn', { 'aria-label': 'Veure el PDF anotat', onclick: () => viewPdfBlob(pl.pdfId, pl.name + ' (anotat)') }, icon('eye')),
        h('button.icon-btn', { 'aria-label': 'Elimina', onclick: async () => {
          if (!(await confirmDlg(`Eliminar les anotacions del plànol «${pl.name}» d'aquesta visita? El plànol original no es modifica.`, { ok: 'Elimina', danger: true }))) return;
          await store.deleteItem(pl); refresh();
        } }, icon('trash'))));
    }
    if (!plans.length) secPlans.appendChild(h('div.empty', {}, 'Toca «Plànol» per obrir un plànol de l\'expedient i anotar-lo.'));

    clear(secAudios);
    for (const a of audios) secAudios.appendChild(audioRow(a, refresh));
    if (!audios.length) secAudios.appendChild(h('div.empty', {}, 'Toca «Àudio» per enregistrar un comentari de veu.'));

    paintFooter();
  }

  function paintFooter() {
    if (isConfigured()) {
      const F = cfg().folders, folder = v.odFolder || visitFolderName(v);
      const s = odState();
      const why = s.phase === 'login' ? 'Cal iniciar sessió a OneDrive (indicador de dalt).' : s.phase === 'offline' ? 'Sense connexió: es pujarà sola quan tornis a tenir xarxa.' : 'Es puja sola a OneDrive en uns segons.';
      clear(footer).append(h('div.send-box', {},
        h('div', {}, statusChip(v), h('p.muted.small', {},
          v.dirty ? why + ' ' : 'Tota la visita és a OneDrive. ',
          'Fotos → ', h('b', {}, `${obra.remote?.name || obra.ref}/${F.fotos}/${folder}`), ' · Full, plànols anotats i àudios → ', h('b', {}, `${F.documents}/${folder}`))),
        h('div.row', {},
          v.dirty ? h('button.btn.primary', { onclick: () => { odKick(0); toast('Pujant a OneDrive…'); } }, icon('upload'), 'Puja ara') : null,
          h('button.btn', { onclick: () => manualSave(obra, id, refresh) }, icon('folder'), 'Desa manualment'),
          h('button.btn', { onclick: () => sendVisit(obra, id, refresh) }, icon('pages'), 'Exporta en ZIP'))));
      return;
    }
    clear(footer).append(
      h('div.send-box', {},
        h('div', {}, statusChip(v), h('p.muted.small', {}, v.dirty
          ? 'Les dades d\'aquesta visita només són en aquesta tauleta. En acabar, desa-la al OneDrive de l\'iPad (o envia-la en ZIP).'
          : v.sentInfo?.mode === 'onedrive-manual' ? `Desada al OneDrive de l'iPad (carpeta ${v.sentInfo.name}). Si fas canvis, torna-la a desar.`
            : `ZIP enviat: ${v.sentInfo?.name || ''}${v.sentInfo?.size ? ' (' + fmtSize(v.sentInfo.size) + ')' : ''}. Si fas canvis, torna-la a enviar.`)),
        h('div.row', {},
          h('button.btn.primary.big-send', { onclick: () => manualSave(obra, id, refresh) }, icon('folder'), 'Desa a OneDrive manualment'),
          h('button.btn', { onclick: () => sendVisit(obra, id, refresh) }, icon('pages'), 'Envia en ZIP'))));
  }
  live(footer, 'changed', async (d) => { if (!d || d.visitId === id) { const nv = await store.getVisit(id); if (nv && nv.num !== v.num) { go('#/visita/' + id); return; } if (nv && (nv.dirty !== v.dirty || nv.sentAt !== v.sentAt || nv.uploadedAt !== v.uploadedAt || nv.lastError !== v.lastError || nv.odFolder !== v.odFolder || nv.num !== v.num)) { v = nv; paintFooter(); } } });
  live(footer, 'od', () => { if (isConfigured() && v.dirty) paintFooter(); });

  // ---- fitxa de foto
  async function photoModal(it, { isNew = false } = {}) {
    it = await store.getItem(it.id);
    if (!it) return;
    let showAnnot = !!it.annotId;
    const img = h('img.photo-big', { alt: it.name });
    const setImg = async () => { const b = await getBlob(showAnnot && it.annotId ? it.annotId : it.blobId); if (b) img.src = objUrl(b); };
    await setImg();
    const toggle = it.annotId ? h('div.seg', {},
      h('button' + (showAnnot ? '.on' : ''), { onclick: (e) => { showAnnot = true; setImg(); e.target.parentNode.querySelectorAll('button').forEach((x, i) => x.classList.toggle('on', i === 0)); } }, 'Anotada'),
      h('button' + (!showAnnot ? '.on' : ''), { onclick: (e) => { showAnnot = false; setImg(); e.target.parentNode.querySelectorAll('button').forEach((x, i) => x.classList.toggle('on', i === 1)); } }, 'Original')) : null;
    const name = h('input.input', { value: it.name, autocapitalize: 'off' });
    const desc = h('textarea.input', { rows: 3, placeholder: 'Què es veu a la foto? (p. ex. «Armadura de la llosa, eix 3»)' }, it.desc || '');
    let action = 'close';
    let shareList = null;
    preparePhotoFiles(it).then((l) => { shareList = l; });
    const persist = async () => {
      const cur = await store.getItem(it.id); if (!cur) return;
      const newName = await store.uniqueName(id, 'photo', name.value.trim() || cur.name, cur.id);
      if (newName !== cur.name || desc.value !== (cur.desc || '')) { cur.name = newName; cur.desc = desc.value.trim(); await store.saveItem(cur); }
    };
    const m = modal({
      title: isNew ? 'Foto nova' : it.name, wide: true,
      body: h('div.photo-modal', {}, h('div.photo-view', {}, img, toggle),
        h('div.form', {},
          h('label', {}, 'Descripció', desc),
          h('label', {}, 'Nom del fitxer', h('div.row.nowrap', {}, name, h('span.muted', {}, '.' + (it.ext || 'jpg')))),
          h('div.row', {},
            h('button.btn', { onclick: () => { action = 'annotate'; m.close(true); } }, icon('pen'), 'Anota la foto'),
            h('button.btn', { onclick: () => shareNow(shareList, it.name) }, icon('upload'), 'Desa a Fitxers / OneDrive'),
            h('button.btn.danger.ghost', { onclick: async () => {
              if (!(await confirmDlg('Eliminar aquesta foto de la visita?', { ok: 'Elimina', danger: true }))) return;
              action = 'deleted'; await store.deleteItem(it); m.close(true);
            } }, icon('trash'), 'Elimina')))),
      actions: [
        ...(isNew ? [{ label: 'Fes-ne una altra', icon: 'camera', onClick: () => { action = 'another'; cam.click(); } }] : []),
        { label: 'Fet', primary: true, icon: 'check' }],
      onClose: async () => {
        if (action !== 'deleted') await persist();
        await refresh();
        if (action === 'annotate') annotatePhoto(it.id);
      },
    });
    if (isNew) setTimeout(() => desc.focus(), 250);
  }

  async function annotatePhoto(itemId) {
    const it = await store.getItem(itemId);
    const bmp = await createImageBitmap(await getBlob(it.blobId));
    await openAnnotator({
      kind: 'image', bitmap: bmp, editable: true, title: `${it.name} · anotació`, pages: it.shapes || {},
      onSave: async ({ pages }) => {
        const b = busy('Desant la foto anotada…');
        try { await store.saveFotoAnnotation(await store.getItem(itemId), pages[0] || []); } finally { b.close(); }
      },
    });
    if (bmp.close) bmp.close();
    await refresh();
    photoModal(it);
  }

  // ---- muntatge
  const page = h('div.page.visit', {},
    cam, gal,
    actionBar,
    h('section.card-sec', {}, h('h3', {}, icon('users'), 'Assistents'), secAssist),
    h('section.card-sec', {}, h('h3', {}, icon('doc'), 'Full d\'anotacions', dict), ta,
      h('p.hint', {}, 'Es desa sol a la tauleta mentre escrius. Per dictar: botó «Dicta» o directament el micròfon 🎤 del teclat de l\'iPad.'),
      h('div.lbl', {}, 'Anotacions manuscrites'), secHand),
    h('section.card-sec', {}, h('h3', {}, icon('camera'), 'Fotografies', cntPhotos), secPhotos),
    h('section.card-sec', {}, h('h3', {}, icon('plan'), 'Plànols anotats', cntPlans), secPlans),
    h('section.card-sec', {}, h('h3', {}, icon('mic'), 'Enregistraments d\'àudio', cntAudios), secAudios),
    footer);
  view.appendChild(page);
  await refresh();
}

// ------------------------------------------------------------- full manuscrit
async function openSheet(id, pageIdx, refresh) {
  const v = await store.getVisit(id);
  const pages = v.sheetPages || {};
  const used = Object.keys(pages).filter((k) => pages[k] && pages[k].length).map(Number);
  const count = Math.max(v.sheetPageCount || 1, used.length ? Math.max(...used) + 1 : 1);
  let start = pageIdx;
  let pageCount = count;
  if (start === null) { // pàgina nova (o la primera si encara no n'hi ha cap)
    start = used.length ? count : 0;
    if (used.length) pageCount = count + 1;
  }
  await openAnnotator({
    kind: 'blank', pageCount, startPage: start, editable: true, pages, title: `Full manuscrit · Visita ${v.num}`, color: '#2b6cb0',
    onSave: async ({ pages: np, pageCount: pc }) => {
      await store.mutateVisit(id, (x) => { x.sheetPages = np; x.sheetPageCount = pc; });
    },
  });
  refresh();
}

// ------------------------------------------------------------- plànols
async function planPicker(obra, visitId) {
  const docs = await store.listDocs(obra.id);
  const pdfs = docs.filter((f) => store.extOf(f.path) === 'pdf');
  const search = h('input.input.search', { type: 'search', placeholder: 'Cerca un plànol…' });
  const list = h('div.doclist.picker');
  const paint = () => {
    clear(list);
    const q = search.value.trim().toLowerCase();
    let lastDir = null;
    for (const f of pdfs) {
      if (q && !f.path.toLowerCase().includes(q)) continue;
      const d = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      if (d !== lastDir) { list.appendChild(h('div.dir', {}, icon('folder'), d || '(arrel)')); lastDir = d; }
      list.appendChild(h('button.doc', { onclick: async () => {
        m.close(); const v = await store.getVisit(visitId); await annotatePlan(obra, v, f); go('#/visita/' + visitId);
      } }, icon('pdf'), h('span.doc-name', {}, f.path.split('/').pop()), h('span.muted.small', {}, fmtSize(f.size))));
    }
    if (!list.children.length) list.appendChild(h('div.empty', {}, pdfs.length ? 'Cap plànol coincideix amb la cerca.' : 'Aquesta obra encara no té plànols a la tauleta. Afegeix-los a la fitxa de l\'obra → Documentació.'));
  };
  search.addEventListener('input', paint);
  paint();
  const m = modal({ title: 'Obrir un plànol per anotar-lo', wide: true, body: h('div', {}, search, list) });
}

async function viewPdfBlob(blobId, title) {
  const blob = await getBlob(blobId);
  if (!blob) return toast('El PDF anotat encara no està generat', 'error');
  const pdf = await openPdf(blob);
  await openAnnotator({ kind: 'pdf', pdf, editable: false, title });
  pdf.destroy();
}

// ------------------------------------------------------------- àudio
function audioRow(a, refresh) {
  let audio = null;
  const playBtn = h('button.icon-btn.play', { 'aria-label': 'Reprodueix', onclick: async () => {
    if (audio && !audio.paused) { audio.pause(); return; }
    if (!audio) {
      audio = new Audio(objUrl(await getBlob(a.blobId)));
      audio.onplay = () => { clear(playBtn).append(icon('pause')); };
      audio.onpause = audio.onended = () => { clear(playBtn).append(icon('play')); };
    }
    audio.play().catch((e) => toast('No es pot reproduir: ' + e.message, 'error'));
  } }, icon('play'));
  return h('div.list-item.static', {}, playBtn,
    h('div.li-main', {}, h('div.li-title', {}, a.name), h('div.li-sub', {}, `${fmtDur(a.duration || 0)} · ${new Date(a.createdAt).toLocaleTimeString('ca-ES', { hour: '2-digit', minute: '2-digit' })}${a.desc ? ' · ' + a.desc : ''}`)),
    h('button.icon-btn', { 'aria-label': 'Canvia el nom', onclick: async () => {
      const n = await promptDlg('Nom de l\'enregistrament', { value: a.name });
      if (!n || !n.trim()) return;
      const cur = await store.getItem(a.id); cur.name = await store.uniqueName(cur.visitId, 'audio', n.trim(), cur.id); await store.saveItem(cur); refresh();
    } }, icon('edit')),
    h('button.icon-btn', { 'aria-label': 'Elimina', onclick: async () => {
      if (!(await confirmDlg(`Eliminar «${a.name}»?`, { ok: 'Elimina', danger: true }))) return;
      await store.deleteItem(a); refresh();
    } }, icon('trash')));
}

async function recordAudio(visitId, refresh) {
  if (!navigator.mediaDevices || !window.MediaRecorder) return toast('Aquest navegador no permet gravar àudio. Cal obrir l\'app amb HTTPS.', 'error');
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch (e) { return toast('No s\'ha pogut accedir al micròfon: ' + e.message, 'error'); }
  const types = ['audio/mp4', 'audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  const mimeType = types.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
  const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  let wake = null;
  try { wake = await navigator.wakeLock?.request('screen'); } catch { /* opcional */ }
  const t0 = Date.now();
  const time = h('div.rec-time', {}, '0:00');
  const tick = setInterval(() => { time.textContent = fmtDur((Date.now() - t0) / 1000); }, 250);
  let save = true;
  const finish = new Promise((res) => { rec.onstop = res; });
  rec.start(1000);
  const onHide = () => { if (document.visibilityState === 'hidden' && rec.state === 'recording') m.close(true); };
  document.addEventListener('visibilitychange', onHide);
  const m = modal({
    title: 'Enregistrant…',
    body: h('div.recorder', {}, h('div.rec-dot'), time, h('p.hint', {}, 'Mantén l\'app oberta mentre graves: si la pantalla es bloqueja, la gravació s\'atura i es desa el que s\'hagi gravat.')),
    actions: [{ label: 'Descarta', danger: true, onClick: async () => { if ((Date.now() - t0) > 5000 && !(await confirmDlg('Descartar aquesta gravació?', { ok: 'Descarta', danger: true }))) return false; save = false; return true; } },
      { label: 'Atura i desa', primary: true, icon: 'stop', value: true }],
    onClose: async () => {
      clearInterval(tick); document.removeEventListener('visibilitychange', onHide);
      if (rec.state !== 'inactive') rec.stop();
      await finish;
      stream.getTracks().forEach((t) => t.stop());
      try { await wake?.release(); } catch { /* */ }
      if (!save || !chunks.length) return;
      const blob = new Blob(chunks, { type: rec.mimeType || mimeType || 'audio/mp4' });
      await store.addAudio(await store.getVisit(visitId), blob, (Date.now() - t0) / 1000);
      toast('Enregistrament desat'); refresh();
    },
  });
}

// ------------------------------------------------------------- assistents i menú
async function editAssistents(obra, id, refresh) {
  const v = await store.getVisit(id);
  const all = [...(obra.participants || [])];
  for (const a of v.assistents || []) if (!all.some((p) => p.nom === a.nom && (p.empresa || '') === (a.empresa || ''))) all.push(a);
  const key = (p) => p.nom + '|' + (p.empresa || '');
  const sel = new Set((v.assistents || []).map(key));
  const listEl = h('div.checks');
  const paint = () => {
    clear(listEl);
    all.forEach((p) => listEl.appendChild(h('label.check' + (sel.has(key(p)) ? '.on' : ''), {},
      h('input', { type: 'checkbox', checked: sel.has(key(p)), onchange: (e) => { e.target.checked ? sel.add(key(p)) : sel.delete(key(p)); paint(); } }),
      h('span', {}, h('b', {}, p.nom), p.empresa ? h('small', {}, p.empresa) : null))));
  };
  paint();
  const nom = h('input.input', { placeholder: 'Nom' }), emp = h('input.input', { placeholder: 'Empresa o rol' });
  modal({
    title: 'Assistents a la visita', wide: true,
    body: h('div.form', {}, listEl, h('div.row.add-row', {}, nom, emp, h('button.btn', { onclick: () => {
      if (!nom.value.trim()) return; const p = { nom: nom.value.trim(), empresa: emp.value.trim() }; all.push(p); sel.add(key(p)); nom.value = ''; emp.value = ''; paint();
    } }, icon('plus'), 'Afegeix'))),
    actions: [{ label: 'Cancel·la' }, { label: 'Desa', primary: true, onClick: async () => {
      await store.mutateVisit(id, (x) => { x.assistents = all.filter((p) => sel.has(key(p))); }); refresh();
    } }],
  });
}

async function visitMenu(obra, id) {
  const v = await store.getVisit(id);
  const date = h('input.input', { type: 'date', value: v.date.replace(/_/g, '-') });
  modal({
    title: `Visita ${v.num}`,
    body: h('div.form', {},
      h('label', {}, 'Data de la visita', date),
      h('button.btn.danger.ghost', { onclick: async () => {
        const msg = v.dirty ? 'ATENCIÓ: aquesta visita té canvis que no s\'han enviat i es perdran. Vols esborrar-la de la tauleta?' : 'Esborrar aquesta visita de la tauleta per alliberar espai? (Ja s\'ha enviat.)';
        if (!(await confirmDlg(msg, { ok: 'Esborra-la', danger: true }))) return;
        await store.deleteVisitLocal(v); go('#/obra/' + encodeURIComponent(obra.id));
      } }, icon('trash'), 'Esborra la visita de la tauleta')),
    actions: [{ label: 'Tanca' }, { label: 'Desa', primary: true, onClick: async () => {
      const d = (date.value || '').replace(/-/g, '_');
      if (/^\d{4}_\d{2}_\d{2}$/.test(d) && d !== v.date) { await store.mutateVisit(id, (x) => { x.date = d; }); go('#/visita/' + id); }
    } }],
  });
}

// ------------------------------------------------------------- enviar la visita (ZIP)
async function sendVisit(obra, id, refresh) {
  const v = await store.getVisit(id);
  const items = await store.listItems(id);
  const n = (k) => items.filter((i) => i.kind === k).length;
  const reduced = h('input', { type: 'checkbox', checked: (await kv.get('zipReduced', true)) !== false });
  const est = h('b');
  const paintEst = async () => { est.textContent = '≈ ' + fmtSize(await estimateSize(items, { reduced: reduced.checked })); };
  reduced.addEventListener('change', () => { kv.set('zipReduced', reduced.checked); paintEst(); });
  paintEst();
  const status = h('div.zip-status');
  const actions = h('div.zip-actions');
  let zipBlob = null, file = null;

  const prepare = async () => {
    clear(actions); clear(status).append(h('div.row', {}, h('div.spinner'), h('span.zip-msg', {}, 'Preparant el ZIP…')));
    const msg = status.querySelector('.zip-msg');
    try {
      const cur = await store.getVisit(id);
      zipBlob = await buildVisitZip(obra, cur, await store.listItems(id), {
        reduced: reduced.checked, onProgress: (i, t, name) => { msg.textContent = `Preparant el ZIP… ${i}/${t}${name ? ' · ' + name.split('/').pop() : ''}`; },
      });
      file = new File([zipBlob], zipName(obra, cur), { type: 'application/zip' });
    } catch (e) {
      console.error(e); clear(status).append(h('p.error', {}, 'No s\'ha pogut preparar el ZIP: ' + e.message));
      actions.append(h('button.btn.primary', { onclick: prepare }, icon('sync'), 'Torna-ho a provar')); return;
    }
    const big = zipBlob.size > 20 * 1024 * 1024;
    clear(status).append(...[
      h('div.zip-ready', {}, icon('check'), h('div', {}, h('b', {}, file.name), h('br'), h('span.muted', {}, fmtSize(zipBlob.size)))),
      big ? h('p.hint', {}, 'Atenció: el ZIP fa més de 20 MB i molts servidors de correu no l\'acceptaran. Envia\'l per WhatsApp, o activa «Redueix les fotos».') : null].filter(Boolean));
    const done = async (mode) => { await store.markSent(id, { name: file.name, size: zipBlob.size, mode }, { clearDirty: !isConfigured() }); refresh(); };
    if (canShareFile(file)) {
      actions.append(h('button.btn.primary.big', { onclick: async () => {
        try { const r = await shareFiles([file], { title: file.name, text: `Visita ${v.num} · ${obra.ref} · ${obra.titol}` }); if (r === 'shared') { await done('compartit'); toast('Visita enviada'); m.close(); } }
        catch (e) { toast('No s\'ha pogut compartir: ' + e.message + '. Desa el fitxer i adjunta\'l.', 'error'); }
      } }, icon('upload'), 'Envia (correu, WhatsApp…)'));
    } else {
      actions.append(h('p.hint', {}, 'Aquest navegador no permet enviar un ZIP directament. Desa\'l i adjunta\'l des del correu o des de WhatsApp (Adjunta → Document → Baixades).'));
      const loose = await looseFiles(obra, id);
      if (loose.length && canShareFile(loose[0]) && navigator.canShare({ files: loose })) {
        actions.append(h('button.btn', { onclick: async () => {
          try { const r = await shareFiles(loose, { title: `Visita ${v.num} · ${obra.ref}` }); if (r === 'shared') toast('Fitxers compartits'); }
          catch (e) { toast(e.message, 'error'); }
        } }, icon('image'), 'Comparteix el full (PDF) i les fotos, sense ZIP'));
      }
    }
    actions.append(h('button.btn', { onclick: async () => { downloadBlob(zipBlob, file.name); await done('desat'); toast('ZIP desat'); } }, icon('download'), 'Desa el ZIP al dispositiu'));
  };

  const m = modal({
    title: `Enviar la visita ${v.num}`, wide: true,
    body: h('div.form', {},
      h('p', {}, `Es crearà un ZIP amb la carpeta de la visita (${n('photo')} fotos, ${n('plan')} plànols anotats, ${n('audio')} àudios, el full de visita en PDF i les dades per a l'acta). Al despatx, descomprimeix-lo dins la carpeta `, h('b', {}, `${obra.ref}_FO`), ' de l\'expedient.'),
      h('label.check', {}, reduced, h('span', {}, h('b', {}, 'Redueix les fotos (recomanat per correu)'), h('small', {}, 'Fotos a 2048 px. Desactiva-ho per enviar els originals a mida completa.'))),
      h('p.muted', {}, 'Mida aproximada: ', est),
      status, actions),
    actions: [{ label: 'Tanca' }, { label: 'Prepara el ZIP', primary: true, icon: 'pages', onClick: () => { prepare(); return false; } }],
  });
}

/** Alternativa sense ZIP (per a navegadors que no deixen compartir ZIP): PDF del full + fotos */
async function looseFiles(obra, id) {
  const { buildSheetPdf, sheetBase, photoFile, photoAnnotFile, sortItems } = await import('./exporter.js');
  const v = await store.getVisit(id);
  const items = await store.listItems(id);
  const { photos } = sortItems(items);
  const out = [new File([await buildSheetPdf(obra, v, items)], sheetBase(obra, v) + '.pdf', { type: 'application/pdf' })];
  for (const p of photos) {
    const b = await getBlob(p.annotId || p.blobId);
    if (b) out.push(new File([b], p.annotId ? photoAnnotFile(p) : photoFile(p), { type: 'image/jpeg' }));
  }
  return out;
}
