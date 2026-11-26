// Dictat amb el reconeixement de veu del navegador, adaptat a l'iPad.
//
// Problemes de Safari a l'iPad que aquest mòdul evita:
//  - El mode continu (continuous = true) no funciona bé: els resultats no es marquen mai com a definitius
//    (isFinal = false) i el text no arribava mai al full. → Sessions curtes (una frase) que es reprenen
//    soles, i el text s'escriu al full a mesura que es reconeix, sense esperar «isFinal».
//  - start() s'ha de cridar directament des del toc (sense esperes abans). → L'idioma es llegeix abans.
//  - Safari de vegades no avisa quan s'acaba (onend). → El botó canvia d'estat a l'instant i, en aturar,
//    es força l'aturada encara que Safari no respongui.
//  - En alguns iPad, el dictat de Safari no està disponible dins l'app instal·lada. → Missatge clar i
//    alternativa: el micròfon del teclat de l'iPad (sempre funciona).
import { h, icon, toast } from './ui.js';
import { kv } from './db.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let lang = 'ca-ES';
kv.get('dictLang', 'ca-ES').then((v) => { lang = v || 'ca-ES'; });

/** Text d'una sessió a partir dels resultats (Safari pot repetir el text acumulat en cada resultat). */
export function sessionText(results) {
  const parts = [];
  for (let i = 0; i < results.length; i++) { const t = (results[i][0] && results[i][0].transcript || '').trim(); if (t) parts.push(t); }
  if (parts.length > 1 && parts.every((p, i) => i === 0 || p.toLowerCase().startsWith(parts[i - 1].toLowerCase()))) return parts[parts.length - 1];
  return parts.join(' ');
}

const capitalize = (t) => t.charAt(0).toUpperCase() + t.slice(1);

/**
 * Botó «Dicta» lligat a un textarea. onChange() es crida quan el text canvia (per desar).
 */
export function dictationButton(ta, onChange) {
  if (!SR) return null;
  let active = false;      // l'usuari vol dictar
  let rec = null;          // sessió en curs
  let base = '';           // text del full abans de la sessió en curs
  let started = false;     // Safari ha confirmat l'inici
  let watchdog = null, maxTimer = null;

  const label = h('span', {}, 'Dicta');
  const live = h('span.interim', { 'aria-live': 'polite' });
  const btn = h('button.btn.small.dict', { type: 'button', onclick: () => (active ? stop() : start()) }, icon('mic'), label);

  const paint = () => {
    btn.classList.toggle('rec', active);
    label.textContent = active ? 'Atura' : 'Dicta';
    if (!active) live.textContent = '';
  };

  function begin() {
    base = ta.value;
    const r = new SR();               // instància nova cada vegada (Safari s'encalla si es reutilitza)
    r.lang = lang; r.continuous = false; r.interimResults = true; r.maxAlternatives = 1;
    r.onstart = () => { started = true; clearTimeout(watchdog); live.textContent = 'Escoltant…'; };
    r.onresult = (e) => {
      if (rec !== r) return;
      let t = sessionText(e.results);
      if (!t) return;
      const sep = !base || /\s$/.test(base) ? '' : ' ';
      if (!base.trim() || /[.!?:\n]\s*$/.test(base)) t = capitalize(t);
      ta.value = base + sep + t;
      live.textContent = 'Escoltant…';
      onChange && onChange();
    };
    r.onerror = (e) => {
      if (rec !== r) return;
      if (e.error === 'no-speech' || e.error === 'aborted') return; // es reprèn a onend
      active = false; paint();
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        kv.set('dictUnavailable', true);
        toast('El dictat de Safari no està disponible en aquesta app. Fes servir el micròfon del teclat de l\'iPad (tecla 🎤).', 'error');
      } else toast('El dictat s\'ha aturat (' + e.error + '). Pots fer servir el micròfon del teclat.', 'error');
    };
    r.onend = () => {
      if (rec !== r) return;
      rec = null;
      if (ta.value !== base) { base = ta.value; onChange && onChange(); }
      if (active) setTimeout(() => { if (active && !rec) begin(); }, 150); // nova frase
      else paint();
    };
    rec = r;
    try { r.start(); } catch (err) {
      rec = null; active = false; paint();
      toast('No s\'ha pogut iniciar el dictat: ' + err.message + '. Fes servir el micròfon del teclat.', 'error');
    }
  }

  function start() {
    active = true; started = false; paint();          // el botó canvia a l'instant
    begin();                                         // dins del toc: requisit de Safari
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {                    // Safari no ha arrencat
      if (active && !started) {
        stop(true);
        toast('El dictat no respon. Fes servir el micròfon del teclat de l\'iPad (tecla 🎤).', 'error');
      }
    }, 5000);
    clearTimeout(maxTimer);
    maxTimer = setTimeout(() => { if (active) stop(); }, 5 * 60 * 1000);
  }

  function stop(silent = false) {
    active = false; paint();
    clearTimeout(watchdog); clearTimeout(maxTimer);
    const r = rec; rec = null;
    if (r) {
      try { r.stop(); } catch { /* */ }
      setTimeout(() => { try { r.abort(); } catch { /* */ } }, 800); // Safari de vegades no s'atura amb stop()
    }
    if (ta.value !== base) onChange && onChange();
    if (!silent) live.textContent = '';
  }

  // Si l'usuari surt de la pantalla o l'app passa a segon pla, s'atura
  document.addEventListener('visibilitychange', () => { if (document.hidden && active) stop(); });

  return h('span.dict-wrap', {}, btn, live);
}
