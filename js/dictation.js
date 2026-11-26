// Dictat del full d'anotacions
//
// IMPORTANT (iPad): Apple no permet el reconeixement de veu de Safari (Web Speech API) dins de les web apps
// instal·lades a la pantalla d'inici: el micròfon s'encén i surt «Escoltant…», però no arriba mai cap text.
// Per això, a l'app instal·lada el botó «Dicta» fa servir el DICTAT DEL TECLAT de l'iPad, que funciona sempre
// (també sense connexió als iPad recents i en català): obre el teclat al final del full i indica on tocar.
//
// El reconeixement de Safari només s'utilitza quan l'app s'obre en una pestanya del navegador (o a
// l'ordinador); si en 8 segons no arriba cap text, s'atura sol i es passa al dictat del teclat.
import { h, icon, toast } from './ui.js';
import { kv } from './db.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

let lang = 'ca-ES';
let mode = 'auto'; // auto | keyboard | safari
kv.get('dictLang', 'ca-ES').then((v) => { lang = v || 'ca-ES'; });
kv.get('dictMode', 'auto').then((v) => { mode = v || 'auto'; });

export function setDictMode(v) { mode = v || 'auto'; }

/** Quin sistema de dictat es farà servir en aquest dispositiu */
export function dictationEngine() {
  if (mode === 'keyboard' || !SR) return 'keyboard';
  if (mode === 'safari') return 'safari';
  return isIOS() && isStandalone() ? 'keyboard' : 'safari';
}

/** Text d'una sessió a partir dels resultats (Safari pot repetir el text acumulat en cada resultat). */
export function sessionText(results) {
  const parts = [];
  for (let i = 0; i < results.length; i++) { const t = (results[i][0] && results[i][0].transcript || '').trim(); if (t) parts.push(t); }
  if (parts.length > 1 && parts.every((p, i) => i === 0 || p.toLowerCase().startsWith(parts[i - 1].toLowerCase()))) return parts[parts.length - 1];
  return parts.join(' ');
}
const capitalize = (t) => t.charAt(0).toUpperCase() + t.slice(1);

// ------------------------------------------------------------- dictat amb el teclat de l'iPad
function keyboardHelp(ta, anchor) {
  document.querySelectorAll('.dict-help').forEach((x) => x.remove());
  const more = h('div.dict-more.hidden', {},
    h('p', {}, h('b', {}, 'No veus el micròfon 🎤 al teclat?'), ' A l\'iPad: Configuració › General › Teclat › activa «Dictat». Torna a l\'app i ja hi serà.'),
    h('p', {}, h('b', {}, 'Amb teclat físic (Magic Keyboard): '), 'prem dues vegades la tecla 🌐 (o Ctrl) per començar a dictar.'),
    h('p', {}, 'Per escriure en català, tria el teclat català (tecla 🌐) abans de dictar.'));
  const box = h('div.dict-help', { role: 'status' },
    h('div.dict-help-main', {}, icon('mic'),
      h('div', {}, h('b', {}, 'Toca el micròfon 🎤 del teclat i parla.'), h('br'),
        h('span', {}, 'És a baix, al costat de la barra d\'espai. Torna\'l a tocar per acabar. El text es desa sol.'))),
    h('div.row', {},
      h('button.btn.small', { type: 'button', onclick: () => more.classList.toggle('hidden') }, 'No el veig'),
      h('button.btn.small', { type: 'button', onclick: () => box.remove() }, 'D\'acord')),
    more);
  anchor.after(box);
  const close = () => { box.remove(); ta.removeEventListener('blur', onBlur); };
  const onBlur = () => setTimeout(() => { if (!box.matches(':hover')) close(); }, 4000);
  ta.addEventListener('blur', onBlur);
  setTimeout(() => { if (box.isConnected && more.classList.contains('hidden')) close(); }, 20000);
}

function startKeyboard(ta, anchor) {
  // El focus s'ha de donar dins del mateix toc perquè l'iPad obri el teclat
  ta.focus();
  const end = ta.value.length;
  try { ta.setSelectionRange(end, end); } catch { /* */ }
  if (ta.value && !/\s$/.test(ta.value)) { /* el dictat del teclat ja posa l'espai */ }
  keyboardHelp(ta, anchor);
  setTimeout(() => ta.scrollIntoView({ block: 'center', behavior: 'smooth' }), 350);
}

// ------------------------------------------------------------- botó
export function dictationButton(ta, onChange) {
  let active = false, rec = null, base = '', started = false, gotResult = false;
  let watchdog = null, noResult = null, maxTimer = null;
  const label = h('span', {}, 'Dicta');
  const live = h('span.interim', { 'aria-live': 'polite' });
  const wrap = h('span.dict-wrap');
  const btn = h('button.btn.small.dict', { type: 'button', onclick: () => {
    if (active) return stop();
    if (dictationEngine() === 'keyboard') return startKeyboard(ta, ta);
    start();
  } }, icon('mic'), label);
  wrap.append(btn, live);

  const paint = () => { btn.classList.toggle('rec', active); label.textContent = active ? 'Atura' : 'Dicta'; if (!active) live.textContent = ''; };

  function fallbackToKeyboard(msg) {
    stop(true);
    kv.set('dictMode', 'keyboard'); mode = 'keyboard';
    toast(msg, 'error');
    startKeyboard(ta, ta);
  }

  function begin() {
    base = ta.value;
    const r = new SR();
    r.lang = lang; r.continuous = false; r.interimResults = true; r.maxAlternatives = 1;
    r.onstart = () => {
      started = true; clearTimeout(watchdog); live.textContent = 'Escoltant…';
      clearTimeout(noResult);
      if (!gotResult) noResult = setTimeout(() => { if (active && !gotResult) fallbackToKeyboard('El reconeixement de veu del navegador no respon. Fes servir el micròfon del teclat.'); }, 8000);
    };
    r.onresult = (e) => {
      if (rec !== r) return;
      let t = sessionText(e.results);
      if (!t) return;
      gotResult = true; clearTimeout(noResult);
      const sep = !base || /\s$/.test(base) ? '' : ' ';
      if (!base.trim() || /[.!?:\n]\s*$/.test(base)) t = capitalize(t);
      ta.value = base + sep + t;
      onChange && onChange();
    };
    r.onerror = (e) => {
      if (rec !== r) return;
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      fallbackToKeyboard('El dictat del navegador no està disponible (' + e.error + '). Fes servir el micròfon del teclat.');
    };
    r.onend = () => {
      if (rec !== r) return;
      rec = null;
      if (ta.value !== base) { base = ta.value; onChange && onChange(); }
      if (active) setTimeout(() => { if (active && !rec) begin(); }, 150);
      else paint();
    };
    rec = r;
    try { r.start(); } catch (err) { rec = null; fallbackToKeyboard('No s\'ha pogut iniciar el dictat del navegador. Fes servir el micròfon del teclat.'); }
  }

  function start() {
    active = true; started = false; gotResult = false; paint();
    begin();
    clearTimeout(watchdog);
    watchdog = setTimeout(() => { if (active && !started) fallbackToKeyboard('El dictat del navegador no arrenca. Fes servir el micròfon del teclat.'); }, 5000);
    clearTimeout(maxTimer);
    maxTimer = setTimeout(() => { if (active) stop(); }, 5 * 60 * 1000);
  }

  function stop(silent = false) {
    active = false; paint();
    clearTimeout(watchdog); clearTimeout(noResult); clearTimeout(maxTimer);
    const r = rec; rec = null;
    if (r) { try { r.stop(); } catch { /* */ } setTimeout(() => { try { r.abort(); } catch { /* */ } }, 800); }
    if (ta.value !== base) onChange && onChange();
    if (!silent) live.textContent = '';
  }

  document.addEventListener('visibilitychange', () => { if (document.hidden && active) stop(); });
  return wrap;
}
