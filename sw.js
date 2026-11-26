// Service worker generat automàticament (tools/build-sw.js). No l'editis a mà.
// Guarda l'aplicació a la tauleta perquè s'obri i funcioni sense connexió.
const VERSION = 'bb68f668bdc3';
const CACHE = 'aventec-app-' + VERSION;
const RUNTIME = 'aventec-runtime';
const FILES = [
 "./",
 "./app.css",
 "./config.js",
 "./demo/files/E_26_999_PR_Fonamentacio_v1.pdf",
 "./demo/files/E_26_999_PR_Planta general_v1.pdf",
 "./demo/files/Pla de seguretat i salut.pdf",
 "./demo/manifest.json",
 "./icons/apple-touch-icon.png",
 "./icons/favicon.png",
 "./icons/icon-192.png",
 "./icons/icon-512.png",
 "./icons/icon-maskable-512.png",
 "./icons/logo-color.svg",
 "./icons/logo.svg",
 "./index.html",
 "./js/annotator.js",
 "./js/app.js",
 "./js/auth.js",
 "./js/db.js",
 "./js/dictation.js",
 "./js/draw.js",
 "./js/exporter.js",
 "./js/graph.js",
 "./js/ipad.js",
 "./js/manual-save.js",
 "./js/onedrive-setup.js",
 "./js/onedrive.js",
 "./js/pdfsrc.js",
 "./js/screen-obra.js",
 "./js/screen-visit.js",
 "./js/store.js",
 "./js/ui.js",
 "./js/zipper.js",
 "./manifest.webmanifest",
 "./vendor/fflate.mjs",
 "./vendor/msal-browser.min.js",
 "./vendor/pdf-lib.esm.min.js",
 "./vendor/pdf.min.mjs",
 "./vendor/pdf.worker.min.mjs",
 "./vendor/standard_fonts/FoxitDingbats.pfb",
 "./vendor/standard_fonts/FoxitFixed.pfb",
 "./vendor/standard_fonts/FoxitFixedBold.pfb",
 "./vendor/standard_fonts/FoxitFixedBoldItalic.pfb",
 "./vendor/standard_fonts/FoxitFixedItalic.pfb",
 "./vendor/standard_fonts/FoxitSerif.pfb",
 "./vendor/standard_fonts/FoxitSerifBold.pfb",
 "./vendor/standard_fonts/FoxitSerifBoldItalic.pfb",
 "./vendor/standard_fonts/FoxitSerifItalic.pfb",
 "./vendor/standard_fonts/FoxitSymbol.pfb",
 "./vendor/standard_fonts/LiberationSans-Bold.ttf",
 "./vendor/standard_fonts/LiberationSans-BoldItalic.ttf",
 "./vendor/standard_fonts/LiberationSans-Italic.ttf",
 "./vendor/standard_fonts/LiberationSans-Regular.ttf"
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('aventec-app-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return; // les dades no passen per aquí
  if (req.mode === 'navigate') {
    // Primer la còpia local: a l'obra, amb cobertura dolenta, l'app s'obre a l'instant
    e.respondWith(caches.match('./', { cacheName: CACHE }).then((r) => r || fetch(req)));
    return;
  }
  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && url.pathname.includes('/vendor/')) (await caches.open(RUNTIME)).put(req, res.clone());
      return res;
    } catch (err) {
      const r = await caches.match(req, { cacheName: RUNTIME });
      if (r) return r;
      throw err;
    }
  })());
});
