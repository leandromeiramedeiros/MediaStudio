/* Shots: pick screenshots in a folder and convert each to a JPEG that lands just under a target size
   (a quality binary search per image), at the resolution you choose, into <folder>/jpeg/. */
import { $, $$, h, esc, get, post, toast, fileUrl, thumbUrl, fmtBytes, pickFolder, pref, setPref } from '../app.js';

let root, F = null, chosen = new Set(), busy = null;
const RES = [['Source', 0], ['4K', 3840], ['1440p', 2560], ['1080p', 1920], ['720p', 1280]];
const S = { mb: pref('shots.mb', 1.8), res: pref('shots.res', 3840), sub: pref('shots.sub', 'jpeg') };

export function mount(el) {
  root = el;
  el.append(h(`<div class="page-head"><div><h2>Shots</h2><p data-sub>Screenshots to JPEG at a target size, written next to them.</p></div><button class="btn" data-open>Open folder…</button></div>`));
  el.append(h(`<div class="split"><div data-grid><div class="empty">Open a folder with screenshots.</div></div>
    <div class="card"><h3>Convert</h3>
      <div class="field"><label class="lab">Target size per image (MB)</label><input class="input num" type="number" min="0.1" step="0.1" data-mb></div>
      <div class="field"><label class="lab">Resolution (long edge)</label><div class="seg" data-res></div></div>
      <div class="field"><label class="lab">Into subfolder</label><input class="input mono" data-subdir></div>
      <div class="row"><button class="btn sm" data-all>Select all</button><button class="btn sm" data-none>None</button><span class="grow"></span><span class="small dim" data-count></span></div>
      <div class="row" style="margin-top:12px"><button class="btn primary" data-go>Convert</button><button class="btn" data-stop hidden>Stop</button></div>
      <div class="list" data-out style="margin-top:12px"></div></div></div>`));
  $('[data-mb]', el).value = S.mb; $('[data-mb]', el).onchange = (e) => { S.mb = +e.target.value || 1.8; setPref('shots.mb', S.mb); };
  $('[data-subdir]', el).value = S.sub; $('[data-subdir]', el).onchange = (e) => { S.sub = e.target.value.trim(); setPref('shots.sub', S.sub); };
  const seg = $('[data-res]', el);
  for (const [l, v] of RES) { const b = h(`<button data-v="${v}">${l}</button>`); b.onclick = () => { S.res = v; setPref('shots.res', v); drawSeg(); }; seg.append(b); }
  const drawSeg = () => $$('button', seg).forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.v === S.res)));
  drawSeg();
  $('[data-open]', el).onclick = async () => { const d = await pickFolder('Open a screenshots folder', F?.dir); if (d) open(d); };
  $('[data-all]', el).onclick = () => { F?.items.forEach((it) => chosen.add(it.path)); draw(); };
  $('[data-none]', el).onclick = () => { chosen.clear(); draw(); };
  $('[data-go]', el).onclick = convert;
  $('[data-stop]', el).onclick = () => { if (busy) busy.stop = true; };
  const last = pref('shots.dir', pref('review.dir', null));
  if (last) open(last, true);
}

async function open(dir, quiet) {
  try {
    const r = await get('/api/folder?dir=' + encodeURIComponent(dir));
    F = { dir: r.dir, items: r.items.filter((x) => x.kind === 'image').reverse() };
    setPref('shots.dir', r.dir); chosen.clear();
    $('[data-sub]', root).textContent = `${r.dir} · ${F.items.length} screenshot${F.items.length === 1 ? '' : 's'}`;
    draw();
  } catch (e) { if (!quiet) toast(e.message, true); }
}

function draw() {
  const g = $('[data-grid]', root); g.innerHTML = '';
  if (!F || !F.items.length) { g.append(h('<div class="empty">No screenshots in this folder.</div>')); return; }
  const grid = h('<div class="grid"></div>');
  for (const it of F.items) {
    const t = h(`<div class="tile ${chosen.has(it.path) ? 'sel' : ''}" title="${esc(it.name)}"><img loading="lazy" alt=""><div class="badge"><b>${fmtBytes(it.size)}</b>${chosen.has(it.path) ? '<b class="ok">✓</b>' : ''}</div><div class="cap"><span>${esc(it.name)}</span></div></div>`);
    $('img', t).src = thumbUrl(it.path);
    t.onclick = () => { chosen.has(it.path) ? chosen.delete(it.path) : chosen.add(it.path); draw(); };
    grid.append(t);
  }
  g.append(grid);
  $('[data-count]', root).textContent = `${chosen.size} selected`;
}

function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('cannot read image')); i.src = src; });
}
const toBlob = (c, q) => new Promise((res) => c.toBlob(res, 'image/jpeg', q));

/* largest quality whose JPEG is at most target bytes (9 halvings: within ~0.2% quality) */
async function fitJpeg(canvas, target) {
  let lo = 0.05, hi = 0.98, best = await toBlob(canvas, lo);
  if (best.size > target) return { blob: best, q: lo, over: true };
  const top = await toBlob(canvas, hi);
  if (top.size <= target) return { blob: top, q: hi };
  for (let i = 0; i < 9; i++) {
    const mid = (lo + hi) / 2, b = await toBlob(canvas, mid);
    if (b.size <= target) { lo = mid; best = b; } else hi = mid;
  }
  return { blob: best, q: lo };
}

async function convert() {
  if (!F || !chosen.size || busy) return;
  busy = { stop: false };
  $('[data-go]', root).hidden = true; $('[data-stop]', root).hidden = false;
  const out = $('[data-out]', root); out.innerHTML = '';
  const target = Math.round(S.mb * 1e6);
  let done = 0;
  try {
    for (const it of F.items.filter((x) => chosen.has(x.path))) {
      if (busy.stop) break;
      const row = h(`<div class="item"><span class="grow">${esc(it.name)}</span><span class="small dim">working…</span></div>`); out.append(row);
      const img = await loadImage(fileUrl(it.path));
      const long = Math.max(img.naturalWidth, img.naturalHeight), k = S.res && long > S.res ? S.res / long : 1;
      const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, c.width, c.height);
      const r = await fitJpeg(c, target);
      const name = (S.sub ? S.sub + '/' : '') + it.name.replace(/\.[^.]+$/, '') + '.jpg';
      const w = await post(`/api/folder/write?dir=${encodeURIComponent(F.dir)}&name=${encodeURIComponent(name)}`, r.blob, true);
      row.lastChild.textContent = `${c.width}×${c.height} · ${fmtBytes(w.size)} · q ${Math.round(r.q * 100)}${r.over ? ' · over target' : ''}`;
      done++;
    }
    toast(`Converted ${done} screenshot${done === 1 ? '' : 's'} into ${S.sub || 'the folder'}.`);
  } catch (e) { toast(e.message, true); }
  finally { busy = null; $('[data-go]', root).hidden = false; $('[data-stop]', root).hidden = true; }
}
