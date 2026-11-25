// Càrrega de pdf.js i pdf-lib (locals, funcionen sense connexió)
let pdfjsP, pdfLibP;

export function pdfjs() {
  pdfjsP ||= import('../vendor/pdf.min.mjs').then((m) => {
    m.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
    return m;
  });
  return pdfjsP;
}

export function pdfLib() {
  pdfLibP ||= import('../vendor/pdf-lib.esm.min.js');
  return pdfLibP;
}

export async function openPdf(blob) {
  const lib = await pdfjs();
  const data = new Uint8Array(await blob.arrayBuffer());
  const base = new URL('../vendor/', import.meta.url).href;
  return lib.getDocument({
    data, cMapUrl: base + 'cmaps/', cMapPacked: true, standardFontDataUrl: base + 'standard_fonts/',
    isEvalSupported: false, enableXfa: false,
  }).promise;
}
