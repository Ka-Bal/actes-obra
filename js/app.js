// AVENTEC · Seguiment d'obra — VERSIÓ PORTÀTIL (sense servidor)
// Arrencada, navegació, capçalera, inici (obres) i configuració.
import { h, icon, on, live, clear, modal, toast, busy, fmtSize, promptDlg, confirmDlg } from './ui.js';
import { db, kv, requestPersistence } from './db.js';
import * as store from './store.js';
import { renderObra } from './screen-obra.js';
import { renderVisit } from './screen-visit.js';

export const APP_VERSION = '2.0.0-portàtil';
const root = document.getElementById('app');

// ------------------------------------------------------------- navegació
export const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };
window.addEventListener('hashchange', () => render());

let renderSeq = 0;
export async function render() {
  const seq = ++renderSeq;
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  const view = h('div.view');
  try {
    if (parts[0] === 'obra' && parts[1]) await renderObra(view, parts[1], parts[2] || 'visites');
    else if (parts[0] === 'visita' && parts[1]) await renderVisit(view, parts[1]);
    else await renderHome(view);
  } catch (e) {
    console.error(e);
    view.appendChild(topbar({ title: 'Error', back: '#/' }));
    view.appendChild(h('div.page', {}, h('div.empty', {}, h('p', {}, e.message))));
  }
  if (seq !== renderSeq) return;
  clear(root).appendChild(view);
}

// ------------------------------------------------------------- capçalera
export function topbar({ title, sub, back, actions = [] }) {
  return h('header.topbar', {},
    back ? h('button.icon-btn.back', { onclick: () => go(back), 'aria-label': 'Enrere' }, icon('back'))
      : h('div.brand', {}, h('img', { src: 'icons/logo.svg', alt: 'AVENTEC' })),
    h('div.tb-title', {}, h('div.t1', {}, title), sub ? h('div.t2', {}, sub) : null),
    h('div.tb-actions', {}, ...actions, sendBadge(),
      h('button.icon-btn', { onclick: openSettings, 'aria-label': 'Configuració' }, icon('settings'))));
}

/** Indicador: visites amb canvis que encara no s'han enviat */
function sendBadge() {
  const el = h('button.sync-badge', { onclick: openPending, 'aria-label': 'Visites per enviar' });
  const paint = async () => {
    const n = (await db.all('visites')).filter((v) => v.dirty).length;
    el.className = 'sync-badge ' + (n ? 'pend' : 'ok');
    clear(el).append(icon(n ? 'upload' : 'check'), h('span', {}, n ? `${n} per enviar` : 'Tot enviat'));
  };
  paint();
  live(el, 'changed', paint);
  return el;
}

async function openPending() {
  const visits = (await db.all('visites')).filter((v) => v.dirty).sort((a, b) => b.updatedAt - a.updatedAt);
  const obres = Object.fromEntries((await db.all('obres')).map((o) => [o.id, o]));
  const m = modal({
    title: 'Visites per enviar',
    body: visits.length ? h('div.list', {}, visits.map((v) => h('button.list-item', { onclick: () => { m.close(); go('#/visita/' + v.id); } },
      h('div.li-main', {}, h('div.li-title', {}, `${obres[v.exp]?.ref || ''} · Visita ${v.num}`),
        h('div.li-sub', {}, v.sentAt ? 'Té canvis des del darrer enviament' : 'Encara no s\'ha enviat')), icon('chevron'))))
      : h('p', {}, 'Totes les visites s\'han enviat. Recorda que les dades només són en aquesta tauleta fins que les envies.'),
    actions: [{ label: 'Tanca' }],
  });
}

// ------------------------------------------------------------- inici: llista d'obres
async function renderHome(view) {
  view.appendChild(topbar({ title: 'Obres', sub: 'AVENTEC · Seguiment d\'obra (portàtil)' }));
  const page = h('div.page');
  view.appendChild(page);

  if (isIOS() && !isStandalone() && !(await kv.get('hideInstall'))) {
    page.appendChild(h('div.banner', {}, icon('info'),
      h('div', {}, h('b', {}, 'Instal·la l\'app a la pantalla d\'inici. '),
        'A Safari: botó Compartir → «Afegeix a la pantalla d\'inici». Fes-la servir sempre des d\'aquesta icona: així funciona sense connexió i les dades no s\'esborren.'),
      h('button.icon-btn', { onclick: async (e) => { await kv.set('hideInstall', true); e.target.closest('.banner').remove(); } }, icon('x'))));
  }

  const obres = await store.listObres();
  const visits = await Promise.all(obres.map((o) => store.listVisits(o.id)));
  const docs = await Promise.all(obres.map((o) => db.keysByIndex('files', 'exp', o.id)));
  const search = h('input.input.search', { placeholder: 'Cerca per codi o nom…', type: 'search' });
  const grid = h('div.cards');
  const paint = () => {
    const q = search.value.trim().toLowerCase();
    clear(grid);
    obres.forEach((o, i) => {
      if (q && !(`${o.ref} ${o.titol}`.toLowerCase().includes(q))) return;
      const vs = visits[i]; const pend = vs.filter((v) => v.dirty).length;
      grid.appendChild(h('button.card.obra', { onclick: () => go('#/obra/' + encodeURIComponent(o.id)) },
        h('div.card-top', {}, h('span.ref', {}, o.ref), h('span.chip', {}, icon('folder'), `${docs[i].length} docs`)),
        h('div.card-title', {}, o.titol),
        h('div.card-sub', {}, `${vs.length} visit${vs.length === 1 ? 'a' : 'es'}`, pend ? h('span.chip.pend', {}, `${pend} per enviar`) : null)));
    });
    if (!grid.children.length) {
      grid.appendChild(h('div.empty', {}, obres.length ? 'Cap obra coincideix amb la cerca.' : h('div', {},
        h('p', {}, 'Encara no hi ha cap obra en aquesta tauleta.'),
        h('div.row', { style: { justifyContent: 'center' } },
          h('button.btn.primary', { onclick: newObra }, icon('plus'), 'Nova obra'),
          h('button.btn', { onclick: loadDemo }, icon('plan'), 'Carrega una obra d\'exemple')))));
    }
  };
  search.addEventListener('input', paint);
  page.append(h('div.row.between', {}, obres.length > 5 ? search : h('div'), h('button.btn.primary', { onclick: newObra }, icon('plus'), 'Nova obra')), grid);
  paint();
}

export async function newObra(existing = null) {
  const o = existing && existing.ref ? existing : null;
  const ref = h('input.input', { placeholder: 'E_26_012', autocapitalize: 'characters', value: o?.ref || '', disabled: !!o });
  const titol = h('input.input', { placeholder: 'Títol de l\'obra', value: o?.titol || '' });
  modal({
    title: o ? 'Dades de l\'obra' : 'Nova obra',
    body: h('div.form', {},
      h('label', {}, 'Codi AVENTEC (E_AA_NNN)', ref),
      h('label', {}, 'Títol de l\'obra', titol),
      o ? null : h('p.hint', {}, 'Després podràs afegir els participants habituals i carregar els plànols i documents de l\'obra des de la tauleta.')),
    actions: [{ label: 'Cancel·la' }, {
      label: o ? 'Desa' : 'Crea l\'obra', primary: true, onClick: async () => {
        try {
          if (o) { await store.updateObraFields(o, { titol: titol.value.trim() || o.titol }); render(); return; }
          const nova = await store.createObra({ ref: ref.value, titol: titol.value });
          go('#/obra/' + encodeURIComponent(nova.id) + '/docs');
        } catch (e) { toast(e.message, 'error'); return false; }
      },
    }],
  });
}

async function loadDemo() {
  const b = busy('Carregant l\'obra d\'exemple…');
  try {
    let obra = await store.getObra('E_26_999');
    if (!obra) obra = await store.createObra({
      ref: 'E_26_999', titol: 'Obra d\'exemple · Nau industrial',
      participants: [
        { nom: 'Laia Soler', empresa: 'Direcció d\'obra (AVENTEC)' }, { nom: 'Marc Riera', empresa: 'Contractista' },
        { nom: 'Núria Casals', empresa: 'Propietat' }, { nom: 'Oriol Puig', empresa: 'Coordinació de seguretat i salut' }],
    });
    const { files } = await (await fetch('demo/manifest.json')).json();
    for (const f of files) {
      const blob = await (await fetch('demo/files/' + encodeURIComponent(f.src))).blob();
      await store.putDoc(obra.id, f.path, new Blob([blob], { type: 'application/pdf' }), f.mtime);
    }
    go('#/obra/' + encodeURIComponent(obra.id));
  } catch (e) { toast('No s\'ha pogut carregar l\'exemple: ' + e.message, 'error'); } finally { b.close(); }
}

// ------------------------------------------------------------- configuració
async function openSettings() {
  const user = h('input.input', { value: await kv.get('userName', ''), placeholder: 'Nom i cognoms' });
  const lang = h('select.input', {}, [['ca-ES', 'Català'], ['es-ES', 'Castellà']].map(([v, l]) => h('option', { value: v }, l)));
  lang.value = await kv.get('dictLang', 'ca-ES');
  const est = await store.storageEstimate();
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted().catch(() => false) : false;
  const rows = [
    ['Versió de l\'app', APP_VERSION],
    ['Instal·lada com a app', isStandalone() ? 'Sí' : 'No (s\'està fent servir des del navegador)'],
    ['Espai utilitzat', est ? `${fmtSize(est.usage || 0)}${est.quota ? ' de ' + fmtSize(est.quota) : ''}` : '—'],
    ['Emmagatzematge protegit', persisted ? 'Sí' : 'No confirmat'],
  ];
  modal({
    title: 'Configuració',
    body: h('div.form', {},
      h('label', {}, 'El meu nom (apareix com a autor de les visites)', user),
      h('label', {}, 'Idioma del dictat', lang),
      h('table.kv', {}, rows.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v)))),
      h('div.row', {},
        h('button.btn', { onclick: async () => { const ok = await requestPersistence(); toast(ok ? 'Emmagatzematge protegit' : 'El navegador no ho ha confirmat. Instal·la l\'app a la pantalla d\'inici.'); } }, icon('save'), 'Protegir dades')),
      h('p.hint', {}, 'Versió portàtil: totes les dades són només en aquesta tauleta. Envia cada visita (ZIP) per correu o WhatsApp en acabar-la; si la tauleta es perd o s\'esborra l\'app, el que no s\'hagi enviat es perd.')),
    actions: [{ label: 'Desa', primary: true, onClick: async () => { await kv.set('userName', user.value.trim()); await kv.set('dictLang', lang.value); toast('Configuració desada'); } }],
  });
}

// ------------------------------------------------------------- utilitats d'entorn
export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// Botó «enrere» (Android): tanca primer el que hi hagi obert
window.__aventecBack = () => {
  const modals = document.querySelectorAll('.modal-back');
  if (modals.length) { const x = modals[modals.length - 1].querySelector('.modal-head .icon-btn'); if (x) { x.click(); return true; } }
  if (document.querySelector('.ann') && window.__annotator) { window.__annotator.close(); return true; }
  if (location.hash && location.hash !== '#/' && location.hash !== '#') { history.back(); return true; }
  return false;
};

// ------------------------------------------------------------- arrencada
async function boot() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker no registrat', e));
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) toast('S\'ha instal·lat una versió nova de l\'app. Es farà servir en tornar-la a obrir.');
    });
  }
  if (!(await kv.get('userName'))) {
    setTimeout(async () => {
      const n = await promptDlg('Com et dius? (apareixerà com a autor de les visites)', { placeholder: 'Nom i cognoms', ok: 'Desa' });
      if (n && n.trim()) await kv.set('userName', n.trim());
    }, 600);
  }
  on('data', () => { if (!location.hash || location.hash === '#/') render(); });
  render();
}

boot();
