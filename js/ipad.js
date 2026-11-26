// Ajustos per a l'iPad (Safari / app instal·lada a la pantalla d'inici)
//
// Problema detectat: en anotar plànols o fotos, Safari ampliava tota la PÀGINA (no el plànol) i les eines
// i el botó de tancar quedaven fora de la pantalla. Safari ignora en part «user-scalable=no», així que
// es bloquegen directament els gestos de zoom del navegador. El zoom del plànol el fa l'app (dos dits).

const stop = (e) => { if (e.cancelable) e.preventDefault(); };

// Gestos de pinça propis de Safari (gesturestart/change/end): bloquejats a tota l'app
['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) => document.addEventListener(ev, stop, { passive: false }));

// Dos o més dits: mai no ha de fer zoom de pàgina
document.addEventListener('touchmove', (e) => { if (e.touches && e.touches.length > 1) stop(e); }, { passive: false });

// El doble toc (zoom) es desactiva amb «touch-action: manipulation» a app.css.

/** Si la pàgina havia quedat ampliada, la torna a escala 1 (canviant momentàniament el viewport). */
export function resetPageZoom() {
  const vv = window.visualViewport;
  if (!vv || Math.abs(vv.scale - 1) < 0.01) return;
  const meta = document.querySelector('meta[name=viewport]');
  if (!meta) return;
  const orig = meta.getAttribute('content');
  meta.setAttribute('content', 'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
  setTimeout(() => meta.setAttribute('content', orig), 300);
}

export const isIPad = () => /iPad/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
