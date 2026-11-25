// Generació dels fitxers que es desen a la carpeta de la visita:
// full de visita (MD + PDF amb manuscrit), Fotos.csv, plànols anotats (PDF vectorial) i visita.json.
import { pdfLib } from './pdfsrc.js';
import { drawShapesOnPdfPage, winAnsiSafe } from './draw.js';
import { fmtDate, fmtDur } from './ui.js';
import { getBlob } from './db.js';

const BRAND = { title: [0x51 / 255, 0x60 / 255, 0x88 / 255], head: [0x4c / 255, 0x63 / 255, 0x89 / 255], text: [0x1d / 255, 0x1d / 255, 0x1d / 255], accent: [0x2b / 255, 0x6c / 255, 0xb0 / 255] };

// ------------------------------------------------------------- noms de fitxer
export function safeName(s, fallback = 'Sense nom') {
  const n = String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120);
  return n || fallback;
}
export const sheetBase = (obra, visit) => `${obra.ref}_FO_Full de visita ${visit.num}`;
export const photoFile = (it) => `${safeName(it.name)}.${it.ext || 'jpg'}`;
export const photoAnnotFile = (it) => `${safeName(it.name)}_anotada.jpg`;
export const audioFile = (it) => `Àudio/${safeName(it.name)}.${it.ext || 'm4a'}`;
export const planFile = (it, visit) => `Plànols anotats/${safeName(it.name)}_anotat V${visit.num}.pdf`;

export function sortItems(items) {
  const by = (k) => items.filter((i) => i.kind === k).sort((a, b) => a.createdAt - b.createdAt);
  return { photos: by('photo'), audios: by('audio'), plans: by('plan') };
}

// ------------------------------------------------------------- text
export function buildSheetMd(obra, visit, items) {
  const { photos, audios, plans } = sortItems(items);
  const L = [];
  L.push(`# Full de visita d'obra ${visit.num}`, '');
  L.push(`- **Obra:** ${obra.titol}`, `- **Expedient:** ${obra.ref}`, `- **Data:** ${fmtDate(visit.date)}`);
  if (visit.author) L.push(`- **Redactat per:** ${visit.author}`);
  L.push('', '## Assistents', '');
  if (visit.assistents?.length) visit.assistents.forEach((a) => L.push(`- ${a.nom}${a.empresa ? ' (' + a.empresa + ')' : ''}`));
  else L.push('- (no s\'han indicat assistents)');
  L.push('', '## Observacions', '', (visit.text || '').trim() || '(sense observacions escrites)', '');
  const hw = Object.values(visit.sheetPages || {}).filter((p) => p && p.length).length;
  if (hw) L.push(`*Hi ha ${hw} pàgina/es d'anotacions manuscrites: vegeu el PDF del full de visita.*`, '');
  L.push('## Fotografies', '');
  if (photos.length) photos.forEach((p) => L.push(`- **${photoFile(p)}**${p.annotId ? ` (anotada: ${photoAnnotFile(p)})` : ''}: ${p.desc || '(sense descripció)'}`));
  else L.push('- Cap');
  L.push('', '## Plànols anotats', '');
  if (plans.length) plans.forEach((p) => L.push(`- **${planFile(p, visit)}** — original: \`${p.src?.path || ''}\`${p.desc ? ' — ' + p.desc : ''}`));
  else L.push('- Cap');
  L.push('', '## Enregistraments d\'àudio', '');
  if (audios.length) audios.forEach((a) => L.push(`- **${audioFile(a)}** (${fmtDur(a.duration || 0)})${a.desc ? ': ' + a.desc : ''}`));
  else L.push('- Cap');
  L.push('');
  return L.join('\n');
}

export function buildFotosCsv(items) {
  const { photos } = sortItems(items);
  const esc = (s) => `"${String(s || '').replace(/"/g, '""')}"`;
  const rows = [['Fitxer', 'Fitxer anotat', 'Descripció', 'Data i hora'].map(esc).join(';')];
  photos.forEach((p) => rows.push([photoFile(p), p.annotId ? photoAnnotFile(p) : '', p.desc || '', new Date(p.createdAt).toLocaleString('ca-ES')].map(esc).join(';')));
  return '﻿' + rows.join('\r\n') + '\r\n';
}

export function buildVisitJson(obra, visit, items) {
  const { photos, audios, plans } = sortItems(items);
  return {
    id: visit.id, num: visit.num, data: visit.date,
    obra: { ref: obra.ref, titol: obra.titol },
    assistents: visit.assistents || [],
    autor: visit.author || '', dispositiu: visit.deviceId || '',
    creada: new Date(visit.createdAt).toISOString(), actualitzada: new Date(visit.updatedAt).toISOString(),
    observacions: visit.text || '',
    full: { markdown: sheetBase(obra, visit) + '.md', pdf: sheetBase(obra, visit) + '.pdf', paginesManuscrites: Object.values(visit.sheetPages || {}).filter((p) => p && p.length).length },
    fotos: photos.map((p) => ({ id: p.id, fitxer: photoFile(p), anotada: p.annotId ? photoAnnotFile(p) : null, descripcio: p.desc || '', data: new Date(p.createdAt).toISOString() })),
    plansAnotats: plans.map((p) => ({ id: p.id, fitxer: planFile(p, visit), original: p.src, descripcio: p.desc || '' })),
    audios: audios.map((a) => ({ id: a.id, fitxer: audioFile(a), durada: Math.round(a.duration || 0), descripcio: a.desc || '', data: new Date(a.createdAt).toISOString() })),
  };
}

// ------------------------------------------------------------- PDF del full de visita
function wrap(text, font, size, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    if (!para.trim()) { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/\s+/)) {
      const tryL = line ? line + ' ' + word : word;
      if (font.widthOfTextAtSize(tryL, size) <= maxW) { line = tryL; continue; }
      if (line) out.push(line);
      let w = word;
      while (font.widthOfTextAtSize(w, size) > maxW) {
        let k = w.length; while (k > 1 && font.widthOfTextAtSize(w.slice(0, k), size) > maxW) k--;
        out.push(w.slice(0, k)); w = w.slice(k);
      }
      line = w;
    }
    out.push(line);
  }
  return out;
}

export async function buildSheetPdf(obra, visit, items) {
  const L = await pdfLib();
  const { PDFDocument, StandardFonts, rgb } = L;
  const doc = await PDFDocument.create();
  doc.setTitle(`${sheetBase(obra, visit)}`); doc.setAuthor(visit.author || 'AVENTEC'); doc.setCreator('AVENTEC · Seguiment d\'obra');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28, H = 841.89, M = 50, maxW = W - 2 * M;
  const C = (a) => rgb(...a);
  let page, y;
  const pages = [];
  const newPage = () => {
    page = doc.addPage([W, H]); pages.push(page); y = H - M;
    page.drawText(winAnsiSafe(obra.titol).slice(0, 80), { x: M, y: H - 28, size: 8, font, color: C(BRAND.head) });
    const t = `Full de visita ${visit.num}`;
    page.drawText(t, { x: W - M - bold.widthOfTextAtSize(t, 8), y: H - 28, size: 8, font: bold, color: C(BRAND.head) });
    page.drawLine({ start: { x: M, y: H - 34 }, end: { x: W - M, y: H - 34 }, thickness: 0.6, color: C(BRAND.accent) });
    y = H - 60;
  };
  const ensure = (need) => { if (y - need < M + 20) newPage(); };
  const textLine = (s, { f = font, size = 10.5, color = BRAND.text, indent = 0, gap = 1.35 } = {}) => {
    for (const ln of wrap(winAnsiSafe(s), f, size, maxW - indent)) {
      ensure(size * gap); page.drawText(ln, { x: M + indent, y: y - size, size, font: f, color: C(color) }); y -= size * gap;
    }
  };
  const heading = (s) => { y -= 8; ensure(30); page.drawText(winAnsiSafe(s), { x: M, y: y - 13, size: 13, font: bold, color: C(BRAND.title) }); y -= 22; };

  newPage();
  page.drawText(winAnsiSafe(`Full de visita d'obra ${visit.num}`), { x: M, y: y - 20, size: 20, font: bold, color: C(BRAND.title) }); y -= 34;
  const meta = [['Obra', obra.titol], ['Expedient', obra.ref], ['Data', fmtDate(visit.date)]];
  if (visit.author) meta.push(['Redactat per', visit.author]);
  for (const [k, v] of meta) {
    ensure(16);
    page.drawText(winAnsiSafe(k + ':'), { x: M, y: y - 10.5, size: 10.5, font: bold, color: C(BRAND.head) });
    const lines = wrap(winAnsiSafe(v), font, 10.5, maxW - 95);
    lines.forEach((ln, i) => page.drawText(ln, { x: M + 95, y: y - 10.5 - i * 14, size: 10.5, font, color: C(BRAND.text) }));
    y -= 14 * lines.length + 2;
  }

  heading('Assistents');
  if (visit.assistents?.length) visit.assistents.forEach((a) => textLine(`•  ${a.nom}${a.empresa ? ' (' + a.empresa + ')' : ''}`));
  else textLine('(no s\'han indicat assistents)', { color: BRAND.head });

  heading('Observacions');
  textLine((visit.text || '').trim() || '(sense observacions escrites)');

  const { photos, audios, plans } = sortItems(items);
  heading('Fotografies');
  if (!photos.length) textLine('Cap');
  for (const p of photos) {
    const thumb = await getBlob(p.annotThumbId || p.thumbId);
    let img = null;
    if (thumb) { try { img = await doc.embedJpg(new Uint8Array(await thumb.arrayBuffer())); } catch { img = null; } }
    const tw = 110, th = img ? (img.height / img.width) * tw : 0;
    const descLines = wrap(winAnsiSafe(p.desc || '(sense descripció)'), font, 10, maxW - tw - 14);
    const need = Math.max(th, 16 + descLines.length * 13) + 10;
    ensure(need);
    if (img) page.drawImage(img, { x: M, y: y - th, width: tw, height: th });
    const tx = M + (img ? tw + 14 : 0);
    page.drawText(winAnsiSafe(photoFile(p) + (p.annotId ? '  (amb anotacions)' : '')), { x: tx, y: y - 11, size: 10, font: bold, color: C(BRAND.head) });
    descLines.forEach((ln, i) => page.drawText(ln, { x: tx, y: y - 26 - i * 13, size: 10, font, color: C(BRAND.text) }));
    y -= need;
  }

  heading('Plànols anotats');
  if (!plans.length) textLine('Cap');
  plans.forEach((p) => textLine(`•  ${planFile(p, visit)}  —  original: ${p.src?.path || ''}`));

  heading('Enregistraments d\'àudio');
  if (!audios.length) textLine('Cap');
  audios.forEach((a) => textLine(`•  ${audioFile(a)} (${fmtDur(a.duration || 0)})${a.desc ? ': ' + a.desc : ''}`));

  // Pàgines manuscrites (vectorials)
  const hw = Object.entries(visit.sheetPages || {}).filter(([, s]) => s && s.length).sort((a, b) => a[0] - b[0]);
  for (const [idx, shapes] of hw) {
    newPage();
    page.drawText(winAnsiSafe(`Anotacions manuscrites · pàgina ${Number(idx) + 1}`), { x: M, y: H - 50, size: 9, font, color: C(BRAND.head) });
    drawShapesOnPdfPage(L, page, shapes, [1, 0, 0, -1, 0, H], font);
  }

  // Peu de pàgina
  pages.forEach((pg, i) => {
    const t = `AVENTEC  ·  ${obra.ref}  ·  ${sheetBase(obra, visit)}  ·  ${i + 1}/${pages.length}`;
    pg.drawText(winAnsiSafe(t), { x: M, y: 24, size: 7.5, font, color: C(BRAND.head) });
  });
  return new Blob([await doc.save()], { type: 'application/pdf' });
}

// ------------------------------------------------------------- plànol anotat
export async function buildAnnotatedPlan(srcBlob, pages, pageMeta, info = {}) {
  const L = await pdfLib();
  const doc = await L.PDFDocument.load(await srcBlob.arrayBuffer(), { ignoreEncryption: true, updateMetadata: false });
  const font = await doc.embedFont(L.StandardFonts.HelveticaBold);
  const docPages = doc.getPages();
  for (const [idx, shapes] of Object.entries(pages || {})) {
    const pg = docPages[Number(idx)], meta = pageMeta?.[idx];
    if (!pg || !meta || !shapes?.length) continue;
    drawShapesOnPdfPage(L, pg, shapes, meta.m, font);
  }
  try {
    doc.setSubject(winAnsiSafe(`Còpia anotada de ${info.original || ''}`));
    doc.setKeywords([winAnsiSafe(`original: ${info.original || ''}`), `visita: ${info.visit || ''}`]);
    doc.setModificationDate(new Date());
  } catch { /* metadades opcionals */ }
  return new Blob([await doc.save({ useObjectStreams: false })], { type: 'application/pdf' });
}
