/* Image editor (tiny): crop, rotate, flip, resize, brightness/contrast/saturation, text and image/SVG layers
   (drag to move), export PNG or JPEG (optionally to a target size) to the Library or a folder. */
import { $, $$, h, esc, get, post, toast, fileUrl, baseName, clamp, pickLibrary, pickFolder, saveBlob, fmtBytes, pref, setPref } from '../app.js';

let root, cv, D = null, selLayer = null, mode = 'move', cropRect = null, base = null;
const ADJ = { b: 100, c: 100, s: 100 };

const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('cannot load ' + baseName(src))); i.src = src; });

/* the base after rotate/flip/crop, as a canvas */
function rebuildBase() {
  const img = D.img, r = D.rot % 360, sw = r % 180 ? img.naturalHeight : img.naturalWidth, sh = r % 180 ? img.naturalWidth : img.naturalHeight;
  const t = document.createElement('canvas'); t.width = sw; t.height = sh;
  const x = t.getContext('2d');
  x.translate(sw / 2, sh / 2); x.rotate(r * Math.PI / 180); x.scale(D.flipH ? -1 : 1, D.flipV ? -1 : 1);
  x.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  if (D.crop) {
    const c = document.createElement('canvas'); c.width = Math.round(D.crop.w); c.height = Math.round(D.crop.h);
    c.getContext('2d').drawImage(t, D.crop.x, D.crop.y, D.crop.w, D.crop.h, 0, 0, c.width, c.height);
    base = c;
  } else base = t;
  if (!D.keepSize) { D.w = base.width; D.h = base.height; }
  syncSize();
}

function render(target = cv, forExport = false) {
  const x = target.getContext('2d');
  target.width = D.w; target.height = D.h;
  x.clearRect(0, 0, D.w, D.h);
  if (D.bg) { x.fillStyle = D.bg; x.fillRect(0, 0, D.w, D.h); }
  if (base) {
    x.filter = `brightness(${ADJ.b}%) contrast(${ADJ.c}%) saturate(${ADJ.s}%)`;
    x.drawImage(base, 0, 0, D.w, D.h);
    x.filter = 'none';
  }
  for (const L of D.layers) {
    if (L.type === 'text') {
      x.font = `${L.bold ? 700 : 500} ${L.size}px ${L.font || '"Bricolage Grotesque", "Segoe UI", sans-serif'}`;
      x.textAlign = 'center'; x.textBaseline = 'middle';
      const lines = String(L.text).split('\n');
      lines.forEach((ln, i) => {
        const y = L.y + (i - (lines.length - 1) / 2) * L.size * 1.15;
        if (L.stroke) { x.lineWidth = Math.max(2, L.size / 8); x.strokeStyle = 'rgba(0,0,0,.75)'; x.strokeText(ln, L.x, y); }
        x.fillStyle = L.color; x.fillText(ln, L.x, y);
      });
    } else if (L.img) {
      const w = L.w, hh = w * L.img.naturalHeight / L.img.naturalWidth;
      x.globalAlpha = L.opacity ?? 1; x.drawImage(L.img, L.x - w / 2, L.y - hh / 2, w, hh); x.globalAlpha = 1;
    }
    if (!forExport && L === selLayer) { const b = bounds(L); x.strokeStyle = '#f2b84b'; x.lineWidth = Math.max(2, D.w / 500); x.setLineDash([8, 6]); x.strokeRect(b.x, b.y, b.w, b.h); x.setLineDash([]); }
  }
  if (!forExport && cropRect) {
    x.fillStyle = 'rgba(0,0,0,.5)';
    x.fillRect(0, 0, D.w, cropRect.y); x.fillRect(0, cropRect.y + cropRect.h, D.w, D.h); x.fillRect(0, cropRect.y, cropRect.x, cropRect.h); x.fillRect(cropRect.x + cropRect.w, cropRect.y, D.w, cropRect.h);
    x.strokeStyle = '#f2b84b'; x.lineWidth = Math.max(2, D.w / 500); x.strokeRect(cropRect.x, cropRect.y, cropRect.w, cropRect.h);
  }
}
function bounds(L) {
  if (L.type === 'text') { const x = cv.getContext('2d'); x.font = `${L.bold ? 700 : 500} ${L.size}px "Bricolage Grotesque", sans-serif`; const lines = String(L.text).split('\n'); const w = Math.max(...lines.map((l) => x.measureText(l).width)); const hh = L.size * 1.15 * lines.length; return { x: L.x - w / 2 - 6, y: L.y - hh / 2 - 4, w: w + 12, h: hh + 8 }; }
  const hh = L.w * L.img.naturalHeight / L.img.naturalWidth; return { x: L.x - L.w / 2, y: L.y - hh / 2, w: L.w, h: hh };
}
const toDoc = (e) => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * D.w / r.width, y: (e.clientY - r.top) * D.h / r.height }; };

function syncSize() { if (!root) return; $('[data-w]', root).value = D.w; $('[data-hh]', root).value = D.h; }
function syncVis() { if (!root) return; $('[data-none]', root).hidden = !!D; cv.hidden = !D; }

async function openImage(path) {
  const src = fileUrl(path);
  D = { path, img: await load(src), rot: 0, flipH: false, flipV: false, crop: null, layers: [], w: 0, h: 0, keepSize: false, bg: null };
  Object.assign(ADJ, { b: 100, c: 100, s: 100 }); selLayer = null; cropRect = null;
  rebuildBase(); drawControls(); render(); syncVis();
  setPref('image.last', path);
}
function blankDoc(w, hh, bg) {
  D = { path: null, img: null, rot: 0, flipH: false, flipV: false, crop: null, layers: [], w, h: hh, keepSize: true, bg };
  base = null; selLayer = null; cropRect = null; syncSize(); drawControls(); render(); syncVis();
}

function drawControls() {
  $$('[data-adj]', root).forEach((i) => { i.value = ADJ[i.dataset.adj]; });
  const box = $('[data-layers]', root); box.innerHTML = '';
  if (!D.layers.length) box.append(h('<span class="small faint">No layers. Add text or an image on top.</span>'));
  D.layers.forEach((L, i) => {
    const it = h(`<div class="item ${L === selLayer ? 'active' : ''}"><span class="grow">${L.type === 'text' ? '🅣 ' + esc(L.text.split('\n')[0]) : '🖼 ' + esc(baseName(L.src))}</span></div>`);
    const up = h('<button class="btn ghost sm" title="Up">↑</button>'); up.onclick = (e) => { e.stopPropagation(); if (i < D.layers.length - 1) { D.layers.splice(i, 1); D.layers.splice(i + 1, 0, L); drawControls(); render(); } };
    const del = h('<button class="btn ghost sm" title="Remove">✕</button>'); del.onclick = (e) => { e.stopPropagation(); D.layers.splice(i, 1); if (selLayer === L) selLayer = null; drawControls(); render(); };
    it.append(up, del); it.onclick = () => { selLayer = L; drawControls(); render(); };
    box.append(it);
  });
  const lp = $('[data-lprops]', root); lp.innerHTML = '';
  const L = selLayer; if (!L) return;
  const f = (label, el) => { const w = h(`<div class="field"><label class="lab">${label}</label></div>`); w.append(el); return w; };
  if (L.type === 'text') {
    const ta = h('<textarea class="input" rows="2"></textarea>'); ta.value = L.text; ta.oninput = () => { L.text = ta.value; render(); drawLayersOnly(); }; lp.append(f('Text', ta));
    const sz = h('<input class="input num" type="number" min="6">'); sz.value = L.size; sz.oninput = () => { L.size = +sz.value || 10; render(); };
    const col = h('<input type="color">'); col.value = L.color; col.oninput = () => { L.color = col.value; render(); };
    const two = h('<div class="two"></div>'); two.append(f('Size', sz), f('Color', col)); lp.append(two);
    const b = h(`<label class="check"><input type="checkbox"${L.bold ? ' checked' : ''}> Bold</label>`); $('input', b).onchange = (e) => { L.bold = e.target.checked; render(); };
    const s = h(`<label class="check"><input type="checkbox"${L.stroke ? ' checked' : ''}> Outline</label>`); $('input', s).onchange = (e) => { L.stroke = e.target.checked; render(); };
    const row = h('<div class="row"></div>'); row.append(b, s); lp.append(row);
  } else {
    const w = h(`<input type="range" min="10" max="${Math.max(D.w, D.h) * 1.5}">`); w.value = L.w; w.oninput = () => { L.w = +w.value; render(); }; lp.append(f('Width', w));
    const o = h('<input type="range" min="0" max="1" step="0.05">'); o.value = L.opacity ?? 1; o.oninput = () => { L.opacity = +o.value; render(); }; lp.append(f('Opacity', o));
  }
}
const drawLayersOnly = () => { const sel = selLayer; drawControlsLite(sel); };
function drawControlsLite() { $$('[data-layers] .item .grow', root).forEach((g, i) => { const L = D.layers[i]; if (L && L.type === 'text') g.textContent = '🅣 ' + L.text.split('\n')[0]; }); }

async function exportBlob(fmt, targetMB) {
  const c = document.createElement('canvas'); render(c, true);
  if (fmt === 'png') return new Promise((r) => c.toBlob(r, 'image/png'));
  const tb = (q) => new Promise((r) => c.toBlob(r, 'image/jpeg', q));
  if (!targetMB) return tb(0.92);
  const target = targetMB * 1e6; let lo = 0.05, hi = 0.98, best = await tb(lo);
  const top = await tb(hi); if (top.size <= target) return top;
  for (let i = 0; i < 9; i++) { const m = (lo + hi) / 2, b = await tb(m); if (b.size <= target) { lo = m; best = b; } else hi = m; }
  return best;
}

export function mount(el, arg) {
  root = el;
  el.append(h(`<div class="page-head"><div><h2>Image</h2><p>Crop, adjust, add text and overlays, export.</p></div><div class="row"><button class="btn" data-open>Open from Library…</button><button class="btn" data-file>Open file…</button><input type="file" accept="image/*,.svg" hidden><button class="btn" data-blank>Blank canvas</button></div></div>`));
  el.append(h(`<div class="split"><div><div class="img-stage"><canvas></canvas><div class="empty" data-none style="border:0">Open an image or start a blank canvas.</div></div>
      <div class="row" style="margin-top:8px"><div class="seg" data-mode><button data-v="move" aria-pressed="true">Move</button><button data-v="crop">Crop</button></div><button class="btn sm" data-apply-crop hidden>Apply crop</button>
        <button class="btn sm" data-rot>⟳ 90°</button><button class="btn sm" data-fh>⇋ Flip</button><button class="btn sm" data-fv>⇵ Flip</button><button class="btn sm" data-reset>Reset</button></div></div>
    <div><div class="card"><h3>Size and look</h3>
        <div class="two" style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div class="field"><label class="lab">Width</label><input class="input num" type="number" data-w></div><div class="field"><label class="lab">Height</label><input class="input num" type="number" data-hh></div></div>
        <label class="check field"><input type="checkbox" data-lock checked> Keep proportions</label>
        <div class="field"><label class="lab">Brightness</label><input type="range" min="0" max="200" data-adj="b" style="width:100%"></div>
        <div class="field"><label class="lab">Contrast</label><input type="range" min="0" max="200" data-adj="c" style="width:100%"></div>
        <div class="field"><label class="lab">Saturation</label><input type="range" min="0" max="200" data-adj="s" style="width:100%"></div></div>
      <div class="card"><div class="row" style="margin-bottom:8px"><h3 class="grow">Layers</h3><button class="btn sm" data-addtext>+ Text</button><button class="btn sm" data-addimg>+ Image</button></div><div class="list" data-layers></div><div class="props" data-lprops style="margin-top:10px"></div></div>
      <div class="card"><h3>Export</h3><div class="row field"><div class="seg" data-fmt><button data-v="png">PNG</button><button data-v="jpg">JPEG</button></div><input class="input num" data-target placeholder="target MB" style="width:110px" title="JPEG only: largest quality under this size"></div>
        <div class="row"><button class="btn primary" data-save>Save to Library</button><button class="btn" data-savefolder>Save to folder…</button></div><p class="small dim" data-saved></p></div></div></div>`));
  cv = $('canvas', el);
  let fmt = pref('image.fmt', 'png');
  const seg = $('[data-fmt]', el); const drawFmt = () => $$('button', seg).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === fmt)));
  seg.onclick = (e) => { const b = e.target.closest('button'); if (b) { fmt = b.dataset.v; setPref('image.fmt', fmt); drawFmt(); } }; drawFmt();
  $('[data-mode]', el).onclick = (e) => { const b = e.target.closest('button'); if (!b) return; mode = b.dataset.v; $$('[data-mode] button', el).forEach((x) => x.setAttribute('aria-pressed', String(x === b))); cropRect = null; $('[data-apply-crop]', el).hidden = true; render(); };
  $('[data-apply-crop]', el).onclick = () => {
    if (!cropRect || !base) return;
    const kx = base.width / D.w, ky = base.height / D.h, prev = D.crop || { x: 0, y: 0 };
    D.crop = { x: prev.x + cropRect.x * kx, y: prev.y + cropRect.y * ky, w: cropRect.w * kx, h: cropRect.h * ky };
    cropRect = null; D.keepSize = false; $('[data-apply-crop]', el).hidden = true; rebuildBase(); render();
  };
  const tf = (fn) => () => { if (!D || !D.img) return; fn(); D.crop = null; D.keepSize = false; rebuildBase(); render(); };
  $('[data-rot]', el).onclick = tf(() => { D.rot = (D.rot + 90) % 360; });
  $('[data-fh]', el).onclick = tf(() => { D.flipH = !D.flipH; });
  $('[data-fv]', el).onclick = tf(() => { D.flipV = !D.flipV; });
  $('[data-reset]', el).onclick = () => { if (D?.path) openImage(D.path); };
  $$('[data-adj]', el).forEach((i) => { i.oninput = () => { ADJ[i.dataset.adj] = +i.value; render(); }; });
  const wIn = $('[data-w]', el), hIn = $('[data-hh]', el), lock = $('[data-lock]', el);
  wIn.onchange = () => { const r = D.h / D.w; D.w = Math.max(1, +wIn.value); if (lock.checked) D.h = Math.round(D.w * r); D.keepSize = true; syncSize(); render(); };
  hIn.onchange = () => { const r = D.w / D.h; D.h = Math.max(1, +hIn.value); if (lock.checked) D.w = Math.round(D.h * r); D.keepSize = true; syncSize(); render(); };
  $('[data-open]', el).onclick = async () => { const it = await pickLibrary('Open an image', ['image', 'svg']); if (it) openImage(it.path); };
  const fi = $('input[type=file]', el); $('[data-file]', el).onclick = () => fi.click();
  fi.onchange = async () => { const f = fi.files[0]; if (f) openImage((await saveBlob(f, f.name, f.name.endsWith('.svg') ? 'svg' : 'image', 'import')).path); fi.value = ''; };
  $('[data-blank]', el).onclick = () => blankDoc(1920, 1080, '#101318');
  $('[data-addtext]', el).onclick = () => { if (!D) blankDoc(1920, 1080, '#101318'); const L = { type: 'text', text: 'Title', x: D.w / 2, y: D.h / 2, size: Math.round(D.h / 8), color: '#ffffff', bold: true, stroke: true }; D.layers.push(L); selLayer = L; drawControls(); render(); };
  $('[data-addimg]', el).onclick = async () => { if (!D) blankDoc(1920, 1080, '#101318'); const it = await pickLibrary('Add an image layer', ['image', 'svg', 'gif']); if (!it) return; const img = await load(fileUrl(it.path)); const L = { type: 'image', src: it.path, img, x: D.w / 2, y: D.h / 2, w: Math.round(D.w / 3), opacity: 1 }; D.layers.push(L); selLayer = L; drawControls(); render(); };
  const doSave = async (toFolder) => {
    if (!D) return;
    const blob = await exportBlob(fmt, fmt === 'jpg' ? parseFloat($('[data-target]', el).value) || 0 : 0);
    const name = (D.path ? baseName(D.path).replace(/\.[^.]+$/, '') : 'image') + '-edit.' + fmt;
    let r;
    if (toFolder) { const dir = await pickFolder('Save into folder'); if (!dir) return; r = await post(`/api/folder/write?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`, blob, true); }
    else r = await saveBlob(blob, name, 'image', 'editor');
    $('[data-saved]', el).textContent = `Saved ${baseName(r.path)} · ${fmtBytes(blob.size)}`;
    toast('Saved.');
  };
  $('[data-save]', el).onclick = () => doSave(false);
  $('[data-savefolder]', el).onclick = () => doSave(true);

  // canvas interaction: select and drag layers, or draw the crop box
  cv.onmousedown = (e) => {
    if (!D) return;
    const p0 = toDoc(e);
    if (mode === 'crop') {
      const mv = (ev) => { const p = toDoc(ev); cropRect = { x: clamp(Math.min(p0.x, p.x), 0, D.w), y: clamp(Math.min(p0.y, p.y), 0, D.h), w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y) }; render(); };
      const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); $('[data-apply-crop]', el).hidden = !(cropRect && cropRect.w > 4 && cropRect.h > 4); };
      addEventListener('mousemove', mv); addEventListener('mouseup', up); return;
    }
    const hit = [...D.layers].reverse().find((L) => { const b = bounds(L); return p0.x >= b.x && p0.x <= b.x + b.w && p0.y >= b.y && p0.y <= b.y + b.h; });
    selLayer = hit || null; drawControls(); render();
    if (!hit) return;
    const ox = hit.x - p0.x, oy = hit.y - p0.y;
    const mv = (ev) => { const p = toDoc(ev); hit.x = p.x + ox; hit.y = p.y + oy; render(); };
    const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  };
  syncVis();
  if (arg?.path) show(arg); else { const last = pref('image.last', null); if (last) openImage(last).catch(() => {}); }
}
export async function show(arg) {
  if (arg?.path) await openImage(arg.path);
}
export function onKey(e) {
  if ((e.key === 'Delete' || e.key === 'Backspace') && selLayer) { D.layers = D.layers.filter((L) => L !== selLayer); selLayer = null; drawControls(); render(); }
}
