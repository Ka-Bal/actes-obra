// Assistent de configuració de OneDrive, pas a pas, pensat per a persones no informàtiques.
// Tot es fa des de l'iPad: no cal editar cap fitxer. Els valors es desen a la tauleta.
import { h, icon, clear, modal, toast, confirmDlg } from './ui.js';
import { kv } from './db.js';
import { cfg, isConfigured, accountInfo, login, logout, authError, friendlyAuthError, appRedirectUri } from './auth.js';
import * as G from './graph.js';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBRA_RE = /^E_\d{2}_\d{3}(?!\d)/;
const STEPS = [['codis', 'Codis'], ['login', 'Inicia sessió'], ['folder', 'Carpeta'], ['done', 'Fet']];

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copiat'); }
  catch { toast('No s\'ha pogut copiar: mantén el dit sobre el text i tria «Copia»', 'error'); }
}

export async function openOneDriveSetup(startStep) {
  let step = startStep || (!isConfigured() ? 'intro' : !accountInfo() ? 'login' : 'folder');
  const m = modal({ title: 'Configurar OneDrive', wide: true, body: h('div.wizard') });
  const box = m.body.firstChild;

  const header = () => h('ol.wiz-steps', {}, STEPS.map(([k, l], i) => {
    const cur = STEPS.findIndex(([x]) => x === step);
    return h('li' + (k === step ? '.on' : i < cur ? '.done' : ''), {}, h('span', {}, i < cur ? '✓' : String(i + 1)), l);
  }));

  async function render() {
    clear(box);
    if (step !== 'intro') box.appendChild(header());
    if (step === 'intro') return intro();
    if (step === 'codis') return codis();
    if (step === 'login') return loginStep();
    if (step === 'folder') return folderStep();
    if (step === 'done') return done();
  }
  const go = (s) => { step = s; render(); };

  // ---------------------------------------------------------------- 0. abans de començar
  function intro() {
    const uri = appRedirectUri();
    const okUrl = location.protocol === 'https:' || location.hostname === 'localhost';
    box.append(
      h('p', {}, 'Perquè l\'app pugi les fotos i documents sola al OneDrive d\'AVENTEC, Microsoft demana que l\'app estigui «registrada» a l\'empresa. És una tasca d\'',
        h('b', {}, '10 minuts, un sol cop, des d\'un ordinador'), ', que fa qui administra el Microsoft 365 d\'AVENTEC seguint la guia pas a pas.'),
      h('div.wiz-card', {},
        h('b', {}, 'L\'administrador necessitarà aquesta adreça (la de l\'app):'),
        h('div.wiz-copy', {}, h('code', {}, uri), h('button.btn.small', { type: 'button', onclick: () => copy(uri) }, 'Copia')),
        okUrl ? null : h('p.error', {}, 'Atenció: l\'app no està publicada amb https://. Microsoft no ho admet. Cal publicar-la amb una adreça https.')),
      h('p', {}, 'En acabar el registre, l\'administrador et donarà ', h('b', {}, 'dos codis'), ' (són llargs, amb guions): l\'«ID d\'aplicació» i l\'«ID del directori».'),
      h('div.wiz-card.soft', {}, icon('info'), h('div', {}, h('b', {}, 'Mentrestant: '),
        'pots fer servir el botó «Desa a OneDrive manualment» de cada visita. Desa les fotos i els documents al OneDrive de l\'iPad sense configurar res.')),
      h('div.wiz-actions', {},
        h('button.btn', { type: 'button', onclick: () => m.close() }, 'Ara no'),
        h('button.btn.primary', { type: 'button', onclick: () => go('codis') }, 'Ja tinc els dos codis', icon('chevron'))));
  }

  // ---------------------------------------------------------------- 1. codis
  async function codis() {
    const local = (await kv.get('odConfig', {})) || {};
    const client = h('input.input.mono', { value: local.clientId || cfg().clientId || '', placeholder: '00000000-0000-0000-0000-000000000000', autocapitalize: 'off', autocomplete: 'off', spellcheck: false });
    const tenant = h('input.input.mono', { value: local.tenant || (cfg().tenant !== 'organizations' ? cfg().tenant : '') || '', placeholder: '00000000-0000-0000-0000-000000000000', autocapitalize: 'off', autocomplete: 'off', spellcheck: false });
    const err = h('p.error');
    box.append(
      h('p', {}, 'Enganxa els dos codis que t\'ha donat l\'administrador. Mantén el dit dins la casella i tria «Enganxa».'),
      h('label', {}, h('b', {}, 'ID d\'aplicació (client)'), h('span.muted', {}, ' · «Application (client) ID»'), client),
      h('label', {}, h('b', {}, 'ID del directori (tenant)'), h('span.muted', {}, ' · «Directory (tenant) ID»'), tenant),
      err,
      h('div.wiz-actions', {},
        h('button.btn', { type: 'button', onclick: () => go('intro') }, 'Enrere'),
        h('button.btn.primary', { type: 'button', onclick: async () => {
          const c = client.value.trim().replace(/\s/g, ''), t = tenant.value.trim().replace(/\s/g, '');
          if (!GUID.test(c)) { err.textContent = 'L\'ID d\'aplicació no té el format correcte (8-4-4-4-12 caràcters amb guions). Revisa que l\'hagis copiat sencer.'; return; }
          if (t && !GUID.test(t) && !/\./.test(t)) { err.textContent = 'L\'ID del directori no té el format correcte. Copia el «Directory (tenant) ID».'; return; }
          if (!t) { err.textContent = 'Falta l\'ID del directori (tenant).'; return; }
          await kv.set('odConfig', { ...local, clientId: c, tenant: t });
          await kv.set('odRoot', null);
          sessionStorage.setItem('odSetup', 'login');
          toast('Desat. L\'app es torna a obrir…');
          setTimeout(() => location.reload(), 500);
        } }, 'Desa i continua', icon('chevron'))));
  }

  // ---------------------------------------------------------------- 2. inici de sessió
  function loginStep() {
    const acc = accountInfo();
    const e = authError();
    if (acc && !e) { go('folder'); return; }
    box.append(
      e ? h('div.wiz-card.bad', {}, h('b', {}, 'Microsoft ha retornat un error:'), h('p', {}, friendlyAuthError(e)),
        h('p.muted.small', {}, e.slice(0, 300)),
        h('button.btn.small', { type: 'button', onclick: () => go('codis') }, 'Revisa els codis')) : null,
      h('p', {}, 'Ara inicia sessió amb el ', h('b', {}, 'compte de Microsoft 365 d\'AVENTEC'), ' (el mateix del correu i del OneDrive).'),
      h('ul.wiz-list', {},
        h('li', {}, 'S\'obrirà la pàgina de Microsoft. Escriu el correu i la contrasenya.'),
        h('li', {}, 'Si demana «Accepta els permisos», toca ', h('b', {}, 'Accepta'), '.'),
        h('li', {}, 'Tornaràs sol a l\'app i l\'assistent continuarà.')),
      h('div.wiz-actions', {},
        h('button.btn', { type: 'button', onclick: () => go('codis') }, 'Enrere'),
        h('button.btn.primary', { type: 'button', onclick: async () => {
          sessionStorage.setItem('odSetup', 'folder');
          try { await login(); } catch (er) { sessionStorage.removeItem('odSetup'); toast(friendlyAuthError(er.message), 'error'); }
        } }, icon('key'), 'Inicia sessió amb Microsoft')));
  }

  // ---------------------------------------------------------------- 3. carpeta general
  async function folderStep() {
    const status = h('div.wiz-card', {}, h('div.row', {}, h('div.spinner'), 'Buscant la carpeta «', cfg().rootPath || '02 - EXPEDIENTS - Obra', '» al teu OneDrive…'));
    box.append(h('p', {}, 'Ara cal indicar quina és la carpeta general dels expedients d\'obra.'), status);
    let found = null;
    try {
      const me = await G.myDriveRoot();
      const it = await G.getItem(me.driveId, me.id, cfg().rootPath || '02 - EXPEDIENTS - Obra');
      if (it && (it.folder || it.remoteItem)) found = it.remoteItem ? { driveId: it.remoteItem.parentReference.driveId, id: it.remoteItem.id, name: it.name } : { driveId: me.driveId, id: it.id, name: it.name };
    } catch (e) {
      clear(status).append(h('b', {}, 'No s\'ha pogut accedir a OneDrive: '), friendlyAuthError(e.message),
        e.status === 403 ? h('p', {}, 'Probablement falta el permís «Files.ReadWrite.All» o el consentiment de l\'administrador (pas 5 i 6 de la guia).') : null);
      status.classList.add('bad');
    }
    if (found) {
      const n = (await G.subfolders(found.driveId, found.id).catch(() => [])).filter((f) => OBRA_RE.test(f.name)).length;
      clear(status).append(h('div.wiz-ok', {}, icon('check'), h('div', {}, h('b', {}, `Trobada: ${found.name}`), h('br'), `Hi ha ${n} carpetes d'expedient (E_XX_XXX).`)));
      status.classList.add('good');
      box.appendChild(h('div.wiz-actions', {},
        h('button.btn', { type: 'button', onclick: () => browser(box) }, 'No, tria una altra carpeta'),
        h('button.btn.primary', { type: 'button', onclick: () => pick(found) }, 'Fes servir aquesta carpeta', icon('chevron'))));
    } else if (!status.classList.contains('bad')) {
      clear(status).append(h('p', {}, 'No l\'he trobada directament al teu OneDrive. Pot ser una carpeta compartida o de SharePoint/Teams: busca-la tu.'));
      browser(box);
    }
  }

  function browser(container) {
    const wrap = h('div.wiz-browser');
    container.appendChild(wrap);
    let trail = []; // [{driveId,id,name}]
    let source = 'mine';
    const list = h('div.list');
    const crumbs = h('div.wiz-crumbs');
    const pickBtn = h('button.btn.primary', { type: 'button', disabled: true, onclick: () => pick(trail[trail.length - 1]) }, icon('check'), 'Tria aquesta carpeta');
    const tabs = h('div.seg', {},
      h('button.on', { type: 'button', onclick: (e) => setSource('mine', e) }, 'Els meus fitxers'),
      h('button', { type: 'button', onclick: (e) => setSource('shared', e) }, 'Compartit amb mi'),
      h('button', { type: 'button', onclick: (e) => setSource('link', e) }, 'Enganxa un enllaç'));
    wrap.append(h('h3.sec', {}, 'Busca la carpeta «02 - EXPEDIENTS - Obra»'), tabs, crumbs, list, h('div.wiz-actions', {}, pickBtn));
    const setSource = (s, e) => { source = s; tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); trail = []; load(); };

    async function load() {
      clear(list); clear(crumbs);
      pickBtn.disabled = !trail.length;
      if (source === 'link') {
        const inp = h('input.input', { placeholder: 'https://aventec-my.sharepoint.com/…', type: 'url', autocapitalize: 'off' });
        list.append(h('p.muted', {}, 'A l\'app OneDrive: mantén el dit sobre la carpeta → Comparteix → Copia l\'enllaç. Després enganxa\'l aquí.'), inp,
          h('button.btn', { type: 'button', onclick: async () => {
            try { const r = await G.resolveShareLink(inp.value); trail = [r]; pick(r); } catch (e) { toast('L\'enllaç no és vàlid o no hi tens accés: ' + e.message, 'error'); }
          } }, 'Fes servir aquest enllaç'));
        return;
      }
      crumbs.append(h('button.link', { type: 'button', onclick: () => { trail = []; load(); } }, source === 'mine' ? 'Els meus fitxers' : 'Compartit amb mi'),
        ...trail.map((t, i) => [' › ', h('button.link', { type: 'button', onclick: () => { trail = trail.slice(0, i + 1); load(); } }, t.name)]).flat());
      list.append(h('div.row', {}, h('div.spinner'), 'Carregant…'));
      try {
        let folders;
        if (!trail.length) folders = source === 'mine' ? await (async () => { const me = await G.myDriveRoot(); return G.subfolders(me.driveId, me.id); })() : await G.sharedFolders();
        else { const t = trail[trail.length - 1]; folders = await G.subfolders(t.driveId, t.id); }
        clear(list);
        if (!folders.length) list.append(h('p.muted', {}, trail.length ? 'No hi ha subcarpetes. Si és aquesta, toca «Tria aquesta carpeta».' : 'No hi ha carpetes.'));
        for (const f of folders) list.appendChild(h('button.list-item', { type: 'button', onclick: () => { trail.push(f); load(); } },
          icon('folder'), h('div.li-main', {}, h('div.li-title', {}, f.name), OBRA_RE.test(f.name) ? h('div.li-sub', {}, 'Carpeta d\'expedient (tria la carpeta que la conté)') : null), icon('chevron')));
      } catch (e) { clear(list); list.append(h('p.error', {}, friendlyAuthError(e.message))); }
    }
    load();
  }

  async function pick(f) {
    if (!f) return;
    const n = (await G.subfolders(f.driveId, f.id).catch(() => [])).filter((x) => OBRA_RE.test(x.name)).length;
    if (!n && !(await confirmDlg(`La carpeta «${f.name}» no conté cap carpeta d'expedient (E_XX_XXX). La vols fer servir igualment?`, { ok: 'Sí, aquesta' }))) return;
    const root = { driveId: f.driveId, id: f.id, name: f.name, sig: 'picked' };
    await kv.set('odRootPicked', root);
    await kv.set('odRoot', root);
    await kv.set('odObres', null);
    G.forgetFolders();
    sessionStorage.removeItem('odSetup');
    go('done');
  }

  // ---------------------------------------------------------------- 4. fet
  async function done() {
    const acc = accountInfo();
    const root = await kv.get('odRootPicked');
    box.append(
      h('div.wiz-ok.big', {}, icon('check'), h('div', {}, h('b', {}, 'OneDrive configurat'), h('br'),
        `Compte: ${acc ? acc.username : '—'}`, h('br'), `Carpeta: ${root ? root.name : '—'}`)),
      h('ul.wiz-list', {},
        h('li', {}, 'A la pantalla d\'inici veuràs les obres de OneDrive: toca ', h('b', {}, 'Afegeix a la tauleta'), ' a les que vulguis portar (millor amb wifi).'),
        h('li', {}, `Els plànols de «${cfg().folders.projecte}» es descarreguen sols.`),
        h('li', {}, `Les fotos aniran a «${cfg().folders.fotos}» i la resta a «${cfg().folders.documents}», soles, quan hi hagi connexió.`),
        h('li', {}, 'De tant en tant Microsoft pot demanar tornar a iniciar sessió: l\'indicador de dalt ho avisarà.')),
      h('div.wiz-actions', {}, h('button.btn.primary', { type: 'button', onclick: () => { m.close(); location.hash = '#/'; setTimeout(() => location.reload(), 100); } }, 'Comença')));
  }

  render();
}

/** Esborra la configuració de OneDrive d'aquesta tauleta (per tornar a començar). */
export async function resetOneDrive() {
  if (!(await confirmDlg('Esborrar la configuració de OneDrive d\'aquesta tauleta i tornar a començar? Les obres i visites de la tauleta es conserven.', { ok: 'Esborra la configuració', danger: true }))) return;
  await logout();
  for (const k of ['odConfig', 'odRoot', 'odRootPicked', 'odObres']) await kv.set(k, null);
  location.reload();
}
