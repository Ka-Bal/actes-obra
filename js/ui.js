// Utilitats d'interfície: creació d'elements, esdeveniments, avisos, modals i icones.

// ---- bus d'esdeveniments
const listeners = {};
export function on(ev, fn) { (listeners[ev] ||= new Set()).add(fn); return () => listeners[ev].delete(fn); }
export function emit(ev, data) { (listeners[ev] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); }

// ---- creació d'elements
export function h(tag, attrs = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
export const icon = (name, cls = '') => h('span.ico' + (cls ? '.' + cls : ''), { html: ICONS[name] || '', 'aria-hidden': 'true' });
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

// ---- formats
export const fmtDate = (d) => {
  if (!d) return '';
  if (/^\d{4}_\d{2}_\d{2}$/.test(d)) { const [y, m, dd] = d.split('_'); return `${dd}/${m}/${y}`; }
  const x = new Date(d); return x.toLocaleDateString('ca-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
};
export const fmtTime = (d) => new Date(d).toLocaleTimeString('ca-ES', { hour: '2-digit', minute: '2-digit' });
export const fmtSize = (b) => (b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' kB' : (b / 1048576).toFixed(1) + ' MB');
export const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export const todayKey = () => { const d = new Date(); return `${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, '0')}_${String(d.getDate()).padStart(2, '0')}`; };

// ---- avisos
let toastBox;
export function toast(msg, kind = '') {
  toastBox ||= document.body.appendChild(h('div.toasts'));
  const t = h('div.toast' + (kind ? '.' + kind : ''), {}, msg);
  toastBox.appendChild(t);
  setTimeout(() => t.classList.add('out'), kind === 'error' ? 5000 : 2800);
  setTimeout(() => t.remove(), kind === 'error' ? 5400 : 3200);
}

// ---- modals
export function modal({ title, body, actions = [], wide = false, onClose } = {}) {
  const prevFocus = document.activeElement;
  const box = h('div.modal' + (wide ? '.wide' : ''), { role: 'dialog', 'aria-modal': 'true' });
  const back = h('div.modal-back', {}, box);
  let closed = false;
  const close = (val) => {
    if (closed) return; closed = true;
    back.classList.add('out'); setTimeout(() => back.remove(), 160);
    document.removeEventListener('keydown', onKey);
    if (prevFocus && prevFocus.focus) try { prevFocus.focus(); } catch { /* */ }
    onClose && onClose(val);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(null); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(null); });
  if (title) box.appendChild(h('div.modal-head', {}, h('h2', {}, title), h('button.icon-btn', { onclick: () => close(null), 'aria-label': 'Tanca' }, icon('x'))));
  const bodyEl = h('div.modal-body', {}, body);
  box.appendChild(bodyEl);
  if (actions.length) {
    box.appendChild(h('div.modal-actions', {}, actions.map((a) =>
      h('button.btn' + (a.primary ? '.primary' : '') + (a.danger ? '.danger' : ''), {
        onclick: async () => { const r = a.onClick ? await a.onClick() : a.value; if (r !== false) close(r === undefined ? a.value : r); },
      }, a.icon ? icon(a.icon) : null, a.label))));
  }
  document.body.appendChild(back);
  requestAnimationFrame(() => back.classList.add('in'));
  return { el: box, body: bodyEl, close };
}

export function confirmDlg(message, { ok = 'D\'acord', danger = false } = {}) {
  return new Promise((resolve) => {
    modal({
      title: 'Confirmació', body: h('p', {}, message), onClose: (v) => resolve(!!v),
      actions: [{ label: 'Cancel·la', value: false }, { label: ok, value: true, primary: !danger, danger }],
    });
  });
}

export function promptDlg(title, { value = '', placeholder = '', multiline = false, ok = 'D\'acord' } = {}) {
  return new Promise((resolve) => {
    const input = multiline
      ? h('textarea.input', { rows: 4, placeholder }, value)
      : h('input.input', { value, placeholder, autocapitalize: 'sentences' });
    if (!multiline) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); m.close(input.value); } });
    const m = modal({
      title, body: input, onClose: (v) => resolve(v === null || v === undefined || v === false ? null : String(v)),
      actions: [{ label: 'Cancel·la', value: null }, { label: ok, primary: true, onClick: () => input.value }],
    });
    setTimeout(() => { input.focus(); if (input.select) input.select(); }, 50);
  });
}

export function busy(message) {
  const el = h('div.busy', {}, h('div.busy-box', {}, h('div.spinner'), h('div.busy-msg', {}, message)));
  document.body.appendChild(el);
  return { set: (m) => { el.querySelector('.busy-msg').textContent = m; }, close: () => el.remove() };
}

// ---- icones (traç senzill, 24×24)
const S = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
export const ICONS = {
  back: S('<path d="M15 18l-6-6 6-6"/>'),
  chevron: S('<path d="M9 18l6-6-6-6"/>'),
  plus: S('<path d="M12 5v14M5 12h14"/>'),
  x: S('<path d="M18 6L6 18M6 6l12 12"/>'),
  check: S('<path d="M20 6L9 17l-5-5"/>'),
  camera: S('<path d="M3 8a2 2 0 0 1 2-2h2.5l1.5-2h6l1.5 2H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="4"/>'),
  image: S('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>'),
  mic: S('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>'),
  stop: S('<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>'),
  play: S('<path d="M7 5l12 7-12 7z" fill="currentColor"/>'),
  pause: S('<path d="M8 5v14M16 5v14"/>'),
  plan: S('<path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15M15 6v15"/>'),
  pen: S('<path d="M15 4l5 5L9 20H4v-5z"/><path d="M13 6l5 5"/>'),
  marker: S('<path d="M9 14l6-10 4 2-6 10z"/><path d="M9 14l-2 5 4-1 2-2"/><path d="M4 21h8"/>'),
  arrow: S('<path d="M5 19L19 5M10 5h9v9"/>'),
  circle: S('<ellipse cx="12" cy="12" rx="9" ry="7"/>'),
  rect: S('<rect x="4" y="6" width="16" height="12" rx="1"/>'),
  text: S('<path d="M5 6V4h14v2M12 4v16M9 20h6"/>'),
  eraser: S('<path d="M8 20l-5-5 10-10 7 7-8 8z"/><path d="M8 20h12"/><path d="M6.5 11.5l6 6"/>'),
  hand: S('<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4.5a1.5 1.5 0 0 1 3 0V12M14 11V6a1.5 1.5 0 0 1 3 0v7M8 13l-1.6-1.8a1.6 1.6 0 0 0-2.4 2.1L8 19a5 5 0 0 0 4 2h1a5 5 0 0 0 5-5v-4"/>'),
  finger: S('<path d="M10 11V4.5a1.5 1.5 0 0 1 3 0V11l4.5 1a2 2 0 0 1 1.5 2.2L18 21h-8l-4-5a1.6 1.6 0 0 1 2.4-2.1L10 15.5"/>'),
  undo: S('<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
  redo: S('<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>'),
  trash: S('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
  edit: S('<path d="M4 20h4L19 9l-4-4L4 16z"/>'),
  file: S('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>'),
  pdf: S('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M8 17v-4h1.5a1.2 1.2 0 0 1 0 2.5H8M13 13v4h1a2 2 0 0 0 0-4z"/>'),
  folder: S('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  sync: S('<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4"/>'),
  cloud: S('<path d="M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19.5 10 4 4 0 0 1 18 18z"/>'),
  cloudOff: S('<path d="M3 3l18 18"/><path d="M8.5 8.2A5 5 0 0 0 7 18h11M20.5 15.8A4 4 0 0 0 19.5 10 6 6 0 0 0 11 6.3"/>'),
  download: S('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  upload: S('<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>'),
  settings: S('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  users: S('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>'),
  zoomIn: S('<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5M11 8v6M8 11h6"/>'),
  zoomOut: S('<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5M8 11h6"/>'),
  fit: S('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  save: S('<path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8V3M7 21v-7h10v7"/>'),
  search: S('<circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/>'),
  info: S('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>'),
  key: S('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>'),
  doc: S('<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>'),
  more: S('<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>'),
  eye: S('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  pages: S('<rect x="7" y="3" width="13" height="16" rx="1"/><path d="M4 7v13a1 1 0 0 0 1 1h11"/>'),
};

/** Subscripció lligada a un element: s'anul·la sola quan l'element deixa d'estar a la pàgina. */
export function live(el, ev, fn) {
  let seen = false;
  const off = on(ev, (d) => {
    if (el.isConnected) seen = true;
    else { if (seen) off(); return; }
    fn(d);
  });
  return off;
}
