/* Library: everything generated, rendered or imported, with the settings that made it (the .json sidecar). */
import { $, $$, h, esc, get, post, toast, fileUrl, baseName, fmtBytes, tileFor, confirmBox, saveBlob, on, go, pref, setPref, flash } from '../app.js';

let root, items = [], filter = pref('lib.filter', 'all'), q = '', selected = null;
const FILTERS = ['all', 'image', 'video', 'gif', 'voice', 'music', 'sfx', 'svg', 'text', 'renders', 'projects'];
const IMPORT_KIND = { video: 'video', image: 'image', gif: 'gif', svg: 'svg', audio: 'sfx' };

export async function mount(el, arg) {
  root = el;
  el.append(h(`<div class="page-head"><div><h2>Library</h2><p>Drop files anywhere on this page to import them.</p></div><div class="row"><input class="input" data-q placeholder="Search prompts and names" style="width:260px"><button class="btn" data-imp>Import…</button><input type="file" multiple hidden></div></div>`));
  el.append(h('<div class="row" data-f style="margin-bottom:12px"></div>'), h('<div class="split wide-side"><div data-grid></div><div class="card" data-detail><div class="empty">Select an item.</div></div></div>'));
  for (const f of FILTERS) { const b = h(`<button class="btn sm" data-k="${f}">${f}</button>`); b.onclick = () => { filter = f; setPref('lib.filter', f); draw(); }; $('[data-f]', el).append(b); }
  $('[data-q]', el).oninput = (e) => { q = e.target.value.toLowerCase(); draw(); };
  const fi = $('input[type=file]', el);
  $('[data-imp]', el).onclick = () => fi.click();
  fi.onchange = () => importFiles(fi.files);
  el.addEventListener('dragover', (e) => e.preventDefault());
  el.addEventListener('drop', (e) => { e.preventDefault(); importFiles(e.dataTransfer.files); });
  on('library-changed', () => { if (!root.hidden) load(); });
  await load();
  if (arg?.path) reveal(arg.path);
}

/* select an item, open its details and flash its tile (a jump from System or the job tray) */
function reveal(path) {
  const norm = (p) => String(p).replace(/\//g, '\\').toLowerCase();
  const it = items.find((x) => norm(x.path) === norm(path));
  if (!it) { toast(`${baseName(path)} is no longer in the Library.`, true); return; }
  if (filter !== 'all' && it.kind !== filter) { filter = 'all'; setPref('lib.filter', filter); }
  if (q) { q = ''; $('[data-q]', root).value = ''; }
  selected = it; draw(); detail(it);
  flash($$('[data-grid] .tile', root).find((t) => t.dataset.path === it.path));
}

async function importFiles(files) {
  for (const f of files) {
    const ext = f.name.split('.').pop().toLowerCase();
    const media = ext === 'gif' ? 'gif' : ext === 'svg' ? 'svg' : /^(mp4|mkv|mov|webm|avi|m4v)$/.test(ext) ? 'video' : /^(png|jpe?g|webp|bmp)$/.test(ext) ? 'image' : /^(mp3|wav|flac|ogg|m4a|aac)$/.test(ext) ? 'audio' : null;
    if (!media) { toast(`Skipped ${f.name}: not a media file.`, true); continue; }
    let kind = IMPORT_KIND[media];
    if (media === 'audio' && f.size > 3e6) kind = 'music';
    await saveBlob(f, f.name, kind, 'import');
  }
  toast('Imported.'); load();
}

async function load() {
  items = (await get('/api/library')).items;
  draw();
}

function draw() {
  $$('[data-f] .btn', root).forEach((b) => b.classList.toggle('primary', b.dataset.k === filter));
  const grid = $('[data-grid]', root); grid.innerHTML = '';
  const list = items.filter((it) => (filter === 'all' || it.kind === filter) && (!q || (it.name + ' ' + (it.meta?.prompt || '')).toLowerCase().includes(q)));
  if (!list.length) { grid.append(h('<div class="empty">Nothing here yet. Make something in Generate or Orchestrate, or drop files here.</div>')); return; }
  const g = h('<div class="grid"></div>');
  for (const it of list) {
    const t = tileFor(it); t.dataset.path = it.path; if (selected && selected.path === it.path) t.classList.add('sel');
    t.onclick = () => { selected = it; $$('.tile.sel', g).forEach((x) => x.classList.remove('sel')); t.classList.add('sel'); detail(it); };
    g.append(t);
  }
  grid.append(g);
}

async function detail(it) {
  const d = $('[data-detail]', root); d.innerHTML = '';
  const m = it.meta || {};
  if (it.media === 'video') { const v = h('<div class="viewer"><video controls loop autoplay muted></video></div>'); $('video', v).src = fileUrl(it.path); d.append(v); }
  else if (it.media === 'image' || it.media === 'gif' || it.media === 'svg') { const v = h('<div class="viewer"><img alt=""></div>'); $('img', v).src = fileUrl(it.path); d.append(v); }
  else if (it.media === 'audio') { const a = h('<audio controls style="width:100%"></audio>'); a.src = fileUrl(it.path); d.append(a); }
  else if (it.media === 'text') { const a = h('<div class="answer"></div>'); a.textContent = (await get('/api/text?path=' + encodeURIComponent(it.path))).text; d.append(a); }
  d.append(h(`<div style="margin-top:10px"><div class="mono small" style="word-break:break-all">${esc(it.name)}</div><div class="small dim">${esc(it.kind)} · ${fmtBytes(it.size)} · ${new Date(it.mtime * 1000).toLocaleString()}</div></div>`));
  if (m.prompt) d.append(h(`<div class="field" style="margin-top:10px"><label class="lab">${m.engine === 'import' ? 'Note' : 'Prompt'}</label><div class="small">${esc(m.prompt)}</div></div>`));
  if (m.caption) d.append(h(`<details class="field"><summary class="lab" style="cursor:pointer">Caption qwen wrote</summary><div class="small" style="white-space:pre-wrap">${esc(m.caption)}</div></details>`));
  if (m.model) d.append(h(`<div class="small dim">${esc(m.model)}${m.preset ? ' · ' + esc(m.preset) : ''}</div>`));
  const params = m.params && Object.entries(m.params).filter(([k]) => k !== 'project');
  if (params && params.length) d.append(h(`<div class="row small" style="margin-top:6px">${params.map(([k, v]) => `<span class="tag">${esc(k)} ${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</span>`).join('')}</div>`));
  const acts = h('<div class="row" style="margin-top:12px"></div>');
  const btn = (label, fn, cls = '') => { const b = h(`<button class="btn sm ${cls}">${label}</button>`); b.onclick = fn; acts.append(b); };
  if (m.engine === 'comfy' || m.engine === 'qwen') btn('↻ Regenerate', () => regenerate(m));
  if (it.kind === 'projects') btn('Open in Video editor', () => go('editor', { project: it.path }), 'primary');
  if (m.project) btn('Open project', () => go('editor', { project: m.project }), 'primary');
  if (['video', 'image', 'gif', 'audio'].includes(it.media) && it.kind !== 'projects') btn('Add to Video editor', () => go('editor', { add: it.path }));
  if (it.media === 'image' || it.media === 'svg') btn('Image editor', () => go('image', { path: it.path }));
  if (it.media === 'video') btn('Make Nexus GIF', async () => { await post('/api/gif', { src: it.path }); toast('GIF job started.'); });
  btn('Open', () => post('/api/open', { path: it.path }));
  btn('Show file', () => post('/api/reveal', { path: it.path }));
  btn('Delete', async () => {
    if (!(await confirmBox('Delete', `Move ${it.name} and its settings to the Recycle Bin?`, 'Delete', true))) return;
    await post('/api/delete', { path: it.path }); selected = null; d.innerHTML = '<div class="empty">Deleted.</div>'; load();
  }, 'danger');
  d.append(acts);
}

async function regenerate(m) {
  try {
    const p = m.params || {};
    if (m.engine === 'comfy') {
      const { seed, effort, ...rest } = p;
      if (m.inputs?.[0]) rest.image = m.inputs[0];
      await post('/api/comfy', { preset: m.preset, prompt: m.prompt, params: rest, seed, effort: effort || 3 });
    } else {
      await post('/api/qwen', { preset: m.preset, prompt: m.prompt, material: m.material || '', images: m.inputs || [], seed: p.seed, think: p.think, max_tokens: p.max_tokens, online: p.online });
    }
    toast('Regenerating with the same settings: see the job tray.');
  } catch (e) { toast(e.message, true); }
}

export async function show(arg) { await load(); if (arg?.path) reveal(arg.path); }
