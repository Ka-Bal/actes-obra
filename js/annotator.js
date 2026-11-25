// Visor i editor d'anotacions a pantalla completa, per a plànols PDF, fotografies i fulls manuscrits.
// - El llapis (Apple Pencil o similar) dibuixa; el dit desplaça i amplia (rebuig del palmell).
// - Mode «dibuixar amb el dit» per a dispositius sense llapis; amb ratolí, el botó esquerre dibuixa.
// - Els plànols es renderitzen per zones visibles: funciona amb plànols A0 sense esgotar la memòria de l'iPad.

import { h, icon, promptDlg, confirmDlg, toast } from './ui.js';
import { COLORS, WIDTHS, TEXT_SIZES, drawShapes, drawShape, drawPenTail, hitTest, roundPts, invertMatrix } from './draw.js';
import { kv } from './db.js';

const TOOLS = [
  ['hand', 'hand', 'Navegar'], ['pen', 'pen', 'Llapis'], ['mk', 'marker', 'Retolador'], ['ar', 'arrow', 'Fletxa'],
  ['el', 'circle', 'Cercle'], ['rc', 'rect', 'Rectangle'], ['tx', 'text', 'Text'], ['erase', 'eraser', 'Esborrar'],
];
const BLANK = { w: 595.28, h: 841.89 }; // A4 en punts

export function openAnnotator(opts) {
  return new Promise((resolve) => { new Annotator(opts, resolve); });
}

class Annotator {
  constructor(o, done) {
    this.o = o; this.done = done;
    this.kind = o.kind; this.editable = !!o.editable;
    this.pages = {}; for (const [k, v] of Object.entries(o.pages || {})) this.pages[k] = v.slice();
    this.pageMeta = { ...(o.pageMeta || {}) };
    this.pageCount = o.kind === 'pdf' ? o.pdf.numPages : o.kind === 'blank' ? Math.max(1, o.pageCount || 1) : 1;
    this.pageIdx = Math.min(o.startPage || 0, this.pageCount - 1);
    this.tool = this.editable ? 'pen' : 'hand';
    this.color = o.color || COLORS[0]; this.widthIdx = 1;
    window.__annotator = this; // ajuda per a proves i diagnòstic
    this.zoom = 1; this.tx = 0; this.ty = 0;
    this.pointers = new Map(); this.mode = null; this.penDown = false;
    this.undo = []; this.redo = []; this.dirty = false;
    this.preview = null; this.hires = null; this.renderTask = null; this.hiresTimer = null;
    this.build();
    // Per defecte: a Android (tauletes sovint sense llapis) el dit dibuixa; a l'iPad, el dit desplaça.
    kv.get('fingerDraw', null).then((v) => { this.fingerDraw = v === null ? /Android/i.test(navigator.userAgent) : !!v; this.syncToolbar(); });
    this.loadPage(this.pageIdx);
  }

  // ------------------------------------------------------------ UI
  build() {
    const o = this.o;
    this.base = h('canvas.ann-base'); this.ink = h('canvas.ann-ink');
    this.stage = h('div.ann-stage', {}, this.base, this.ink);
    this.pageLabel = h('span.ann-page');
    const nav = this.pageCount > 1 || this.kind === 'blank'
      ? h('div.ann-nav', {},
        h('button.icon-btn', { onclick: () => this.gotoPage(this.pageIdx - 1), 'aria-label': 'Pàgina anterior' }, icon('back')),
        this.pageLabel,
        h('button.icon-btn', { onclick: () => this.gotoPage(this.pageIdx + 1), 'aria-label': 'Pàgina següent' }, icon('chevron')),
        this.kind === 'blank' && this.editable ? h('button.btn.small', { onclick: () => this.addPage() }, icon('plus'), 'Pàgina') : null)
      : null;
    const top = h('div.ann-top', {},
      h('button.btn.primary.ann-done', { onclick: () => this.close() }, icon(this.editable ? 'check' : 'x'), this.editable ? 'Fet' : 'Tanca'),
      h('div.ann-title', {}, o.title || ''),
      nav,
      h('div.ann-zoom', {},
        h('button.icon-btn', { onclick: () => this.zoomBy(1 / 1.5), 'aria-label': 'Redueix' }, icon('zoomOut')),
        h('button.icon-btn', { onclick: () => { this.fit(); this.requestDraw(true); }, 'aria-label': 'Ajusta a la pantalla' }, icon('fit')),
        h('button.icon-btn', { onclick: () => this.zoomBy(1.5), 'aria-label': 'Amplia' }, icon('zoomIn'))),
      ...(o.actions || []).map((a) => h('button.btn.small', { onclick: () => a.onClick(this) }, a.icon ? icon(a.icon) : null, a.label)));

    let tools = null;
    if (this.editable) {
      this.toolBtns = TOOLS.map(([id, ic, label]) => h('button.tool', { title: label, 'aria-label': label, onclick: () => { this.tool = id; this.syncToolbar(); } }, icon(ic), h('span', {}, label)));
      this.colorBtns = COLORS.map((c) => h('button.swatch', { style: { background: c }, 'aria-label': 'Color', onclick: () => { this.color = c; this.syncToolbar(); } }));
      this.widthBtns = WIDTHS.map((w, i) => h('button.wbtn', { 'aria-label': 'Gruix', onclick: () => { this.widthIdx = i; this.syncToolbar(); } }, h('i', { style: { height: Math.max(2, w) + 'px' } })));
      this.fingerBtn = h('button.tool', { title: 'Dibuixar amb el dit', onclick: async () => { this.fingerDraw = !this.fingerDraw; await kv.set('fingerDraw', this.fingerDraw); this.syncToolbar(); toast(this.fingerDraw ? 'Ara el dit també dibuixa (dos dits per moure)' : 'El dit desplaça; dibuixa amb el llapis'); } }, icon('finger'), h('span', {}, 'Dit'));
      this.undoBtn = h('button.tool', { onclick: () => this.doUndo(), title: 'Desfés' }, icon('undo'), h('span', {}, 'Desfés'));
      this.redoBtn = h('button.tool', { onclick: () => this.doRedo(), title: 'Refés' }, icon('redo'), h('span', {}, 'Refés'));
      tools = h('div.ann-tools', {},
        h('div.grp', {}, this.toolBtns),
        h('div.grp', {}, this.colorBtns),
        h('div.grp', {}, this.widthBtns),
        h('div.grp', {}, this.undoBtn, this.redoBtn, this.fingerBtn,
          h('button.tool', { title: 'Esborra-ho tot', onclick: () => this.clearPage() }, icon('trash'), h('span', {}, 'Neteja'))));
    }
    this.root = h('div.ann', { role: 'dialog', 'aria-label': o.title || 'Visor' }, top, this.stage, tools);
    document.body.appendChild(this.root);
    document.body.classList.add('noscroll');
    this.syncToolbar();

    this.ctxBase = this.base.getContext('2d');
    this.ctxInk = this.ink.getContext('2d');
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.stage);
    const s = this.stage;
    s.addEventListener('pointerdown', (e) => this.onDown(e));
    s.addEventListener('pointermove', (e) => this.onMove(e));
    s.addEventListener('pointerup', (e) => this.onUp(e));
    s.addEventListener('pointercancel', (e) => this.onUp(e, true));
    s.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    // A l'iPad cal evitar els gestos del navegador (lupa, desplaçament) mentre s'escriu
    const stop = (e) => { if (e.cancelable) e.preventDefault(); };
    s.addEventListener('touchstart', stop, { passive: false });
    s.addEventListener('touchmove', stop, { passive: false });
    s.addEventListener('contextmenu', stop);
    this.onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.doRedo() : this.doUndo(); }
      else if (e.key === 'Escape') this.close();
    };
    document.addEventListener('keydown', this.onKey);
  }

  syncToolbar() {
    if (this.pageLabel) this.pageLabel.textContent = `${this.pageIdx + 1} / ${this.pageCount}`;
    if (!this.editable) return;
    TOOLS.forEach(([id], i) => this.toolBtns[i].classList.toggle('on', this.tool === id));
    COLORS.forEach((c, i) => this.colorBtns[i].classList.toggle('on', this.color === c));
    this.widthBtns.forEach((b, i) => b.classList.toggle('on', this.widthIdx === i));
    this.fingerBtn.classList.toggle('on', !!this.fingerDraw);
    this.undoBtn.disabled = !this.undo.length; this.redoBtn.disabled = !this.redo.length;
    this.stage.style.cursor = this.tool === 'hand' ? 'grab' : this.tool === 'erase' ? 'cell' : this.tool === 'tx' ? 'text' : 'crosshair';
  }

  get shapes() { return (this.pages[this.pageIdx] ||= []); }

  // ------------------------------------------------------------ pàgines
  async loadPage(i) {
    this.pageIdx = i; this.syncToolbar();
    for (const t of [this.renderTask, this.previewTask]) if (t) { try { t.cancel(); } catch { /* */ } }
    this.renderTask = null; this.previewTask = null;
    this.preview = null; this.hires = null; this.page = null;
    if (this.kind === 'pdf') {
      const page = await this.o.pdf.getPage(i + 1);
      if (this.pageIdx !== i) return;
      const vp = page.getViewport({ scale: 1 });
      this.page = page; this.W = vp.width; this.H = vp.height;
      this.pageMeta[i] = { w: this.W, h: this.H, m: invertMatrix(vp.transform) };
      this.resize(true);
      // Vista prèvia de tota la pàgina (es fa servir mentre es desplaça o amplia)
      const ps = Math.min(2048 / Math.max(this.W, this.H), 3);
      const c = document.createElement('canvas');
      c.width = Math.ceil(this.W * ps); c.height = Math.ceil(this.H * ps);
      try {
        this.previewTask = page.render({ canvasContext: c.getContext('2d'), viewport: page.getViewport({ scale: ps }) });
        await this.previewTask.promise;
        if (this.pageIdx !== i) return;
        this.preview = { canvas: c, scale: ps };
      } catch (e) { if (e && e.name !== 'RenderingCancelledException') console.error(e); }
      this.previewTask = null;
      this.requestDraw(true);
    } else if (this.kind === 'image') {
      this.W = this.o.bitmap.width; this.H = this.o.bitmap.height;
      this.resize(true);
    } else {
      this.W = BLANK.w; this.H = BLANK.h;
      this.pageMeta[i] = { w: BLANK.w, h: BLANK.h, m: [1, 0, 0, -1, 0, BLANK.h] };
      this.resize(true);
    }
  }

  gotoPage(i) {
    if (i < 0 || i >= this.pageCount || i === this.pageIdx) return;
    this.undo = []; this.redo = [];
    this.loadPage(i);
  }

  addPage() {
    this.pageCount++; this.gotoPage(this.pageCount - 1);
  }

  // ------------------------------------------------------------ vista
  resize(refit = false) {
    const r = this.stage.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const changed = r.width !== this.cssW || r.height !== this.cssH || dpr !== this.dpr;
    if (changed && this.cssW && !refit) { this.tx += (r.width - this.cssW) / 2; this.ty += (r.height - this.cssH) / 2; }
    this.cssW = r.width; this.cssH = r.height; this.dpr = dpr;
    for (const c of [this.base, this.ink]) {
      c.width = Math.max(1, Math.round(r.width * dpr)); c.height = Math.max(1, Math.round(r.height * dpr));
    }
    if (refit || !this.fitted) { this.fit(); this.fitted = true; }
    this.requestDraw(true);
  }

  fit() {
    if (!this.W || !this.cssW) return;
    const pad = 16;
    this.zoom = Math.min((this.cssW - pad) / this.W, (this.cssH - pad) / this.H);
    this.minZoom = this.zoom * 0.5; this.maxZoom = Math.max(this.zoom * 60, 8);
    this.tx = (this.cssW - this.W * this.zoom) / 2; this.ty = (this.cssH - this.H * this.zoom) / 2;
  }

  zoomAt(cx, cy, f) {
    const z = Math.max(this.minZoom || 0.01, Math.min(this.maxZoom || 100, this.zoom * f));
    f = z / this.zoom;
    this.tx = cx - (cx - this.tx) * f; this.ty = cy - (cy - this.ty) * f; this.zoom = z;
    this.requestDraw(true);
  }
  zoomBy(f) { this.zoomAt(this.cssW / 2, this.cssH / 2, f); }

  toWorld(e) {
    const r = this.stage.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    return { sx, sy, x: (sx - this.tx) / this.zoom, y: (sy - this.ty) / this.zoom };
  }

  requestDraw(viewChanged = false) {
    if (viewChanged) this.scheduleHires();
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.drawBase(); this.drawInk(); });
  }

  scheduleHires() {
    if (this.kind !== 'pdf' || !this.page) return;
    clearTimeout(this.hiresTimer);
    this.hiresTimer = setTimeout(() => this.renderHires(), 220);
  }

  async renderHires() {
    if (!this.page || this.mode) { if (this.mode) this.scheduleHires(); return; }
    const { zoom, tx, ty, dpr } = this;
    if (this.preview && zoom * dpr <= this.preview.scale * 0.9) { this.hires = null; this.requestDraw(); return; }
    if (this.renderTask) { try { this.renderTask.cancel(); } catch { /* */ } }
    const c = document.createElement('canvas');
    c.width = this.base.width; c.height = this.base.height;
    const vp = this.page.getViewport({ scale: zoom * dpr, offsetX: tx * dpr, offsetY: ty * dpr });
    const task = this.page.render({ canvasContext: c.getContext('2d'), viewport: vp });
    this.renderTask = task;
    try {
      await task.promise;
      if (this.renderTask !== task) return;
      this.hires = { canvas: c, zoom, tx, ty };
      this.requestDraw();
    } catch (e) { if (e && e.name !== 'RenderingCancelledException') console.error(e); }
    if (this.renderTask === task) this.renderTask = null;
  }

  worldTransform(ctx) {
    const { dpr, zoom, tx, ty } = this;
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * tx, dpr * ty);
  }

  drawBase() {
    const ctx = this.ctxBase, { dpr } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#4a4f5c'; ctx.fillRect(0, 0, this.base.width, this.base.height);
    if (!this.W) return;
    this.worldTransform(ctx);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 12 * dpr;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, this.W, this.H);
    ctx.restore();
    if (this.kind === 'image') {
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.o.bitmap, 0, 0, this.W, this.H);
    } else if (this.kind === 'blank') {
      ctx.strokeStyle = '#dfe6f0'; ctx.lineWidth = 0.6;
      for (let y = 70; y < this.H - 30; y += 24) { ctx.beginPath(); ctx.moveTo(36, y); ctx.lineTo(this.W - 36, y); ctx.stroke(); }
    } else if (this.kind === 'pdf') {
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, this.W, this.H); ctx.clip();
      if (this.preview) ctx.drawImage(this.preview.canvas, 0, 0, this.W, this.H);
      const hr = this.hires;
      if (hr) {
        const k = this.zoom / hr.zoom;
        ctx.setTransform(k, 0, 0, k, (this.tx - hr.tx * k) * dpr, (this.ty - hr.ty * k) * dpr);
        ctx.drawImage(hr.canvas, 0, 0);
      }
      ctx.restore();
      if (!this.preview) {
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#6b7280'; ctx.font = `${14 * dpr}px sans-serif`;
        ctx.textAlign = 'center'; ctx.fillText('Carregant el plànol…', this.base.width / 2, this.base.height / 2);
      }
    }
  }

  drawInk() {
    const ctx = this.ctxInk;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, this.ink.width, this.ink.height);
    this.worldTransform(ctx);
    drawShapes(ctx, this.pages[this.pageIdx]);
    if (this.cur) drawShape(ctx, this.cur);
  }

  // ------------------------------------------------------------ edició
  snapshot() { this.undo.push(JSON.stringify(this.shapes)); if (this.undo.length > 80) this.undo.shift(); this.redo = []; this.dirty = true; this.syncToolbar(); }
  doUndo() { if (!this.undo.length) return; this.redo.push(JSON.stringify(this.shapes)); this.pages[this.pageIdx] = JSON.parse(this.undo.pop()); this.dirty = true; this.syncToolbar(); this.requestDraw(); }
  doRedo() { if (!this.redo.length) return; this.undo.push(JSON.stringify(this.shapes)); this.pages[this.pageIdx] = JSON.parse(this.redo.pop()); this.dirty = true; this.syncToolbar(); this.requestDraw(); }
  async clearPage() {
    if (!this.shapes.length) return;
    if (!(await confirmDlg('Vols esborrar totes les anotacions d\'aquesta pàgina?', { ok: 'Esborra', danger: true }))) return;
    this.snapshot(); this.pages[this.pageIdx] = []; this.requestDraw();
  }

  // ------------------------------------------------------------ punter
  canDraw(e) {
    if (!this.editable || this.tool === 'hand') return false;
    if (e.pointerType === 'pen') return true;
    if (e.pointerType === 'mouse') return e.button === 0;
    return !!this.fingerDraw; // touch
  }

  onDown(e) {
    if (e.pointerType === 'touch' && this.penDown) return; // rebuig del palmell
    if (e.pointerType === 'pen') {
      this.penDown = true;
      if (this.fingerDraw && !this.penNoticed) {
        // S'ha detectat un llapis: el dit passa a desplaçar (rebuig del palmell)
        this.penNoticed = true; this.fingerDraw = false; kv.set('fingerDraw', false); this.syncToolbar();
        toast('Llapis detectat: el llapis dibuixa i el dit desplaça');
      }
      if (this.mode === 'pan' || this.mode === 'pinch') { this.pointers.clear(); this.mode = null; }
    }
    try { this.stage.setPointerCapture(e.pointerId); } catch { /* */ }
    const pt = this.toWorld(e);
    this.pointers.set(e.pointerId, { ...pt, type: e.pointerType });

    const touches = [...this.pointers.values()].filter((p) => p.type === 'touch');
    if (touches.length >= 2 && e.pointerType === 'touch') {
      if (this.mode === 'draw' && this.drawPointer && this.pointers.get(this.drawPointer)?.type === 'touch') { this.cur = null; this.requestDraw(); }
      this.startPinch(); return;
    }
    if (this.mode) return;
    if (this.canDraw(e)) {
      this.mode = 'draw'; this.drawPointer = e.pointerId; this.downAt = pt;
      const w = WIDTHS[this.widthIdx] / this.zoom;
      if (this.tool === 'erase') { this.erasedAny = false; this.eraseAt(pt); return; }
      if (this.tool === 'tx') return;
      const t = this.tool;
      this.cur = { t, c: this.color, w: t === 'mk' ? w * 4 : w, p: [pt.x, pt.y] };
      if (t !== 'pen' && t !== 'mk') this.cur.p.push(pt.x, pt.y);
      this.requestDraw();
    } else {
      this.mode = 'pan'; this.panPointer = e.pointerId; this.stage.style.cursor = 'grabbing';
    }
  }

  startPinch() {
    const [a, b] = [...this.pointers.values()].filter((p) => p.type === 'touch');
    this.mode = 'pinch';
    this.pinch = { d: Math.hypot(a.sx - b.sx, a.sy - b.sy) || 1, cx: (a.sx + b.sx) / 2, cy: (a.sy + b.sy) / 2 };
  }

  onMove(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const events = this.mode === 'draw' && e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of (events.length ? events : [e])) {
      const pt = this.toWorld(ev);
      const prev = { ...p };
      Object.assign(p, pt);
      if (this.mode === 'draw' && e.pointerId === this.drawPointer) {
        if (this.tool === 'erase') { this.eraseAt(pt); continue; }
        if (!this.cur) continue;
        if (this.cur.t === 'pen' || this.cur.t === 'mk') {
          const n = this.cur.p.length;
          const dx = (pt.x - this.cur.p[n - 2]) * this.zoom, dy = (pt.y - this.cur.p[n - 1]) * this.zoom;
          if (dx * dx + dy * dy < 1) continue;
          this.cur.p.push(pt.x, pt.y);
          this.worldTransform(this.ctxInk); drawPenTail(this.ctxInk, this.cur);
        } else {
          this.cur.p[2] = pt.x; this.cur.p[3] = pt.y; this.requestDraw();
        }
      } else if (this.mode === 'pan' && e.pointerId === this.panPointer) {
        this.tx += pt.sx - prev.sx; this.ty += pt.sy - prev.sy; this.requestDraw(true);
      } else if (this.mode === 'pinch') {
        const ts = [...this.pointers.values()].filter((q) => q.type === 'touch');
        if (ts.length < 2) continue;
        const [a, b] = ts;
        const d = Math.hypot(a.sx - b.sx, a.sy - b.sy) || 1, cx = (a.sx + b.sx) / 2, cy = (a.sy + b.sy) / 2;
        this.tx += cx - this.pinch.cx; this.ty += cy - this.pinch.cy;
        this.zoomAt(cx, cy, d / this.pinch.d);
        this.pinch = { d, cx, cy };
      }
    }
  }

  async onUp(e, cancelled = false) {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (e.pointerType === 'pen') this.penDown = false;
    if (!p) return;
    if (this.mode === 'draw' && e.pointerId === this.drawPointer) {
      this.mode = null;
      if (this.tool === 'tx' && !cancelled) {
        const pt = this.downAt;
        const txt = await promptDlg('Text de l\'anotació', { multiline: true, ok: 'Afegeix' });
        if (txt && txt.trim()) {
          this.snapshot();
          this.shapes.push({ t: 'tx', c: this.color, s: TEXT_SIZES[this.widthIdx] / this.zoom, p: roundPts([pt.x, pt.y]), v: txt.trim() });
        }
      } else if (this.cur && !cancelled) {
        const s = this.cur;
        const big = s.t === 'pen' || s.t === 'mk' || Math.hypot(s.p[2] - s.p[0], s.p[3] - s.p[1]) * this.zoom > 4;
        if (big) { this.snapshot(); s.p = roundPts(s.p); s.w = Math.round(s.w * 1000) / 1000; this.shapes.push(s); }
      }
      this.cur = null; this.requestDraw();
      return;
    }
    if (this.mode === 'pinch') {
      const ts = [...this.pointers.values()].filter((q) => q.type === 'touch');
      if (ts.length < 2) { this.mode = ts.length === 1 ? 'pan' : null; this.panPointer = ts.length === 1 ? [...this.pointers.keys()][0] : null; }
      if (!this.mode) this.scheduleHires();
      return;
    }
    if (this.mode === 'pan' && e.pointerId === this.panPointer) { this.mode = null; this.syncToolbar(); this.scheduleHires(); }
  }

  eraseAt(pt) {
    const i = hitTest(this.shapes, pt.x, pt.y, 10 / this.zoom);
    if (i >= 0) { this.snapshot(); this.shapes.splice(i, 1); this.requestDraw(); }
  }

  onWheel(e) {
    e.preventDefault();
    const pt = this.toWorld(e);
    if (e.ctrlKey || e.metaKey || !e.shiftKey) {
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
      this.zoomAt(pt.sx, pt.sy, f);
    } else { this.tx -= e.deltaY; this.requestDraw(true); }
  }

  // ------------------------------------------------------------ tancar
  async close() {
    if (this.closing) return; this.closing = true;
    try {
      if (this.editable && this.dirty && this.o.onSave) {
        const pages = {}; for (const [k, v] of Object.entries(this.pages)) if (v && v.length) pages[k] = v;
        await this.o.onSave({ pages, pageMeta: this.pageMeta, pageCount: this.pageCount });
      }
    } catch (e) {
      console.error(e); this.closing = false;
      toast('No s\'han pogut desar les anotacions: ' + e.message, 'error'); return;
    }
    clearTimeout(this.hiresTimer);
    for (const t of [this.renderTask, this.previewTask]) if (t) { try { t.cancel(); } catch { /* */ } }
    this.ro.disconnect();
    document.removeEventListener('keydown', this.onKey);
    document.body.classList.remove('noscroll');
    this.root.remove();
    this.done({ saved: this.dirty, pageCount: this.pageCount });
  }
}
