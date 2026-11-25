// Model de formes vectorials de les anotacions, dibuix en canvas i exportació a PDF (vectorial).
//
// Forma: { t: 'pen'|'mk'|'ar'|'el'|'rc'|'tx', c: '#rrggbb', w: amplada, p: [x0,y0,x1,y1,…], v?: text, s?: mida de text }
// Coordenades "món": punts del PDF (visor a escala 1, amb rotació aplicada) o píxels de la imatge.

export const COLORS = ['#e3172d', '#2b6cb0', '#111111', '#13a050', '#f39c12'];
export const WIDTHS = [2, 4, 8];          // píxels de pantalla en el moment de dibuixar
export const TEXT_SIZES = [16, 24, 36];
export const MARKER_ALPHA = 0.35;
const KAPPA = 0.5522847498;

const hexToRgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };

// ------------------------------------------------------------- canvas
function penPath(ctx, p) {
  if (p.length < 2) return;
  ctx.moveTo(p[0], p[1]);
  if (p.length === 2) { ctx.lineTo(p[0] + 0.01, p[1]); return; }
  if (p.length === 4) { ctx.lineTo(p[2], p[3]); return; }
  for (let i = 2; i < p.length - 2; i += 2) {
    const mx = (p[i] + p[i + 2]) / 2, my = (p[i + 1] + p[i + 3]) / 2;
    ctx.quadraticCurveTo(p[i], p[i + 1], mx, my);
  }
  ctx.lineTo(p[p.length - 2], p[p.length - 1]);
}

export function arrowHead(s) {
  const [x1, y1, x2, y2] = s.p;
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const len = Math.max(s.w * 4, Math.min(Math.hypot(x2 - x1, y2 - y1) * 0.35, s.w * 7));
  const a1 = ang + Math.PI * 0.82, a2 = ang - Math.PI * 0.82;
  return [x2 + len * Math.cos(a1), y2 + len * Math.sin(a1), x2, y2, x2 + len * Math.cos(a2), y2 + len * Math.sin(a2)];
}

export function drawShape(ctx, s) {
  ctx.save();
  ctx.strokeStyle = s.c; ctx.fillStyle = s.c;
  ctx.lineWidth = s.w; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  switch (s.t) {
    case 'mk': ctx.globalAlpha = MARKER_ALPHA; // continua
    // falls through
    case 'pen': penPath(ctx, s.p); ctx.stroke(); break;
    case 'ar': {
      const [x1, y1, x2, y2] = s.p; ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
      const h = arrowHead(s); ctx.moveTo(h[0], h[1]); ctx.lineTo(h[2], h[3]); ctx.lineTo(h[4], h[5]);
      ctx.stroke(); break;
    }
    case 'el': {
      const [x1, y1, x2, y2] = s.p;
      ctx.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2 || 0.01, Math.abs(y2 - y1) / 2 || 0.01, 0, 0, Math.PI * 2);
      ctx.stroke(); break;
    }
    case 'rc': {
      const [x1, y1, x2, y2] = s.p; ctx.rect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      ctx.stroke(); break;
    }
    case 'tx': {
      ctx.font = `600 ${s.s}px Helvetica, Arial, sans-serif`; ctx.textBaseline = 'top';
      const lines = String(s.v || '').split('\n');
      lines.forEach((ln, i) => {
        ctx.lineWidth = s.s / 6; ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.strokeText(ln, s.p[0], s.p[1] + i * s.s * 1.2);
        ctx.fillText(ln, s.p[0], s.p[1] + i * s.s * 1.2);
      });
      break;
    }
  }
  ctx.restore();
}

export function drawShapes(ctx, shapes) { for (const s of shapes || []) drawShape(ctx, s); }

/** Dibuixa només el darrer tram d'un traç (dibuix incremental mentre s'escriu). */
export function drawPenTail(ctx, s) {
  const p = s.p, n = p.length;
  if (n < 6) return drawShape(ctx, s);
  ctx.save();
  ctx.strokeStyle = s.c; ctx.lineWidth = s.w; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (s.t === 'mk') ctx.globalAlpha = MARKER_ALPHA;
  const ax = (p[n - 6] + p[n - 4]) / 2, ay = (p[n - 5] + p[n - 3]) / 2;
  const bx = (p[n - 4] + p[n - 2]) / 2, by = (p[n - 3] + p[n - 1]) / 2;
  ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(p[n - 4], p[n - 3], bx, by); ctx.stroke();
  ctx.restore();
}

function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, l = dx * dx + dy * dy;
  let t = l ? ((px - x1) * dx + (py - y1) * dy) / l : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Retorna l'índex de la forma més propera al punt (o -1). */
export function hitTest(shapes, x, y, tol) {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const s = shapes[i], p = s.p, w = tol + (s.w || 0) / 2;
    if (s.t === 'pen' || s.t === 'mk' || s.t === 'ar') {
      if (p.length === 2 && Math.hypot(x - p[0], y - p[1]) < w) return i;
      for (let k = 0; k < p.length - 2; k += 2) if (distToSeg(x, y, p[k], p[k + 1], p[k + 2], p[k + 3]) < w) return i;
    } else if (s.t === 'rc') {
      const [x1, y1, x2, y2] = p;
      const segs = [[x1, y1, x2, y1], [x2, y1, x2, y2], [x2, y2, x1, y2], [x1, y2, x1, y1]];
      if (segs.some((g) => distToSeg(x, y, ...g) < w)) return i;
    } else if (s.t === 'el') {
      const cx = (p[0] + p[2]) / 2, cy = (p[1] + p[3]) / 2, rx = Math.abs(p[2] - p[0]) / 2 || 1, ry = Math.abs(p[3] - p[1]) / 2 || 1;
      const r = Math.hypot((x - cx) / rx, (y - cy) / ry);
      if (Math.abs(r - 1) * Math.min(rx, ry) < w) return i;
    } else if (s.t === 'tx') {
      const lines = String(s.v || '').split('\n');
      const wmax = Math.max(...lines.map((l) => l.length)) * s.s * 0.6;
      if (x >= p[0] - tol && x <= p[0] + wmax + tol && y >= p[1] - tol && y <= p[1] + lines.length * s.s * 1.2 + tol) return i;
    }
  }
  return -1;
}

export const roundPts = (arr) => arr.map((v) => Math.round(v * 100) / 100);

// ------------------------------------------------------------- composició d'imatges
/** Imatge (bitmap) + formes → canvas. maxSide limita la mida (límits de memòria de l'iPad). */
export function composeImage(bitmap, shapes, maxSide = 4096) {
  const W = bitmap.width, H = bitmap.height;
  const k = Math.min(1, maxSide / Math.max(W, H));
  const c = document.createElement('canvas');
  c.width = Math.round(W * k); c.height = Math.round(H * k);
  const ctx = c.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, c.width, c.height);
  ctx.setTransform(k, 0, 0, k, 0, 0);
  drawShapes(ctx, shapes);
  return c;
}

export const canvasToBlob = (c, type = 'image/jpeg', q = 0.9) => new Promise((res, rej) =>
  c.toBlob((b) => (b ? res(b) : rej(new Error('No s\'ha pogut generar la imatge'))), type, q));

// ------------------------------------------------------------- PDF (pdf-lib)
/** Inversa d'una matriu [a,b,c,d,e,f]. */
export function invertMatrix([a, b, c, d, e, f]) {
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

const WINANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
/** Helvetica estàndard només admet WinAnsi: substitueix la resta de caràcters. */
export function winAnsiSafe(str) {
  return String(str || '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/[^\n\t\x20-\x7E\xA0-\xFF]/g, (ch) => (WINANSI_EXTRA.includes(ch) ? ch : (ch === 'ŀ' ? 'l·' : ch === 'Ŀ' ? 'L·' : '?')));
}

/**
 * Dibuixa formes en una pàgina pdf-lib, de forma vectorial.
 * m: matriu que converteix coordenades "món" (visor) a l'espai d'usuari del PDF.
 */
export function drawShapesOnPdfPage(L, page, shapes, m, font) {
  if (!shapes || !shapes.length) return;
  const {
    pushGraphicsState: q, popGraphicsState: Q, concatTransformationMatrix: cm, setStrokingRgbColor, setLineWidth,
    setLineCap, setLineJoin, moveTo, lineTo, appendBezierCurve, stroke, closePath, setGraphicsState, LineCapStyle, LineJoinStyle, rgb,
  } = L;
  // Aïllem el contingut original perquè el seu estat gràfic no afecti les anotacions
  if (!page.__aventecWrapped) {
    page.node.normalize();
    const start = page.doc.context.register(page.createContentStream(q()));
    const end = page.doc.context.register(page.createContentStream(Q()));
    page.node.wrapContentStreams(start, end);
    page.__aventecWrapped = true;
  }
  const gsKey = shapes.some((s) => s.t === 'mk') ? page.maybeEmbedGraphicsState({ borderOpacity: MARKER_ALPHA, opacity: MARKER_ALPHA }) : null;

  for (const s of shapes) {
    if (s.t === 'tx') continue;
    const [r, g, b] = hexToRgb(s.c);
    const ops = [q(), cm(...m), setStrokingRgbColor(r, g, b), setLineWidth(s.w), setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round)];
    if (s.t === 'mk' && gsKey) ops.push(setGraphicsState(gsKey));
    const p = s.p;
    if (s.t === 'pen' || s.t === 'mk') {
      ops.push(moveTo(p[0], p[1]));
      if (p.length === 2) ops.push(lineTo(p[0] + 0.01, p[1]));
      else if (p.length === 4) ops.push(lineTo(p[2], p[3]));
      else {
        let cx = p[0], cy = p[1];
        for (let i = 2; i < p.length - 2; i += 2) {
          const qx = p[i], qy = p[i + 1], ex = (p[i] + p[i + 2]) / 2, ey = (p[i + 1] + p[i + 3]) / 2;
          ops.push(appendBezierCurve(cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey));
          cx = ex; cy = ey;
        }
        ops.push(lineTo(p[p.length - 2], p[p.length - 1]));
      }
    } else if (s.t === 'ar') {
      const hd = arrowHead(s);
      ops.push(moveTo(p[0], p[1]), lineTo(p[2], p[3]), moveTo(hd[0], hd[1]), lineTo(hd[2], hd[3]), lineTo(hd[4], hd[5]));
    } else if (s.t === 'rc') {
      const [x1, y1, x2, y2] = p;
      ops.push(moveTo(x1, y1), lineTo(x2, y1), lineTo(x2, y2), lineTo(x1, y2), closePath());
    } else if (s.t === 'el') {
      const cx = (p[0] + p[2]) / 2, cy = (p[1] + p[3]) / 2, rx = Math.abs(p[2] - p[0]) / 2, ry = Math.abs(p[3] - p[1]) / 2;
      const ox = rx * KAPPA, oy = ry * KAPPA;
      ops.push(moveTo(cx + rx, cy),
        appendBezierCurve(cx + rx, cy + oy, cx + ox, cy + ry, cx, cy + ry),
        appendBezierCurve(cx - ox, cy + ry, cx - rx, cy + oy, cx - rx, cy),
        appendBezierCurve(cx - rx, cy - oy, cx - ox, cy - ry, cx, cy - ry),
        appendBezierCurve(cx + ox, cy - ry, cx + rx, cy - oy, cx + rx, cy), closePath());
    }
    ops.push(stroke(), Q());
    page.pushOperators(...ops);
  }
  // Textos: girem l'eix Y localment perquè es llegeixin rectes, tal com es veuen al visor
  for (const s of shapes.filter((x) => x.t === 'tx')) {
    const [r, g, b] = hexToRgb(s.c);
    String(s.v || '').split('\n').forEach((ln, i) => {
      page.pushOperators(q(), cm(...m), cm(1, 0, 0, -1, s.p[0], s.p[1] + i * s.s * 1.2));
      page.drawText(winAnsiSafe(ln), { x: 0, y: -s.s * 0.8, size: s.s, font, color: rgb(r, g, b) });
      page.pushOperators(Q());
    });
  }
}
