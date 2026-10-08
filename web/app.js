/* Media Studio shell: tabs, the live event stream, the job tray, and helpers every tab shares. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }

/* ---------- API ---------- */
export async function get(path) {
  const r = await fetch(path);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
export async function post(path, body, raw) {
  const r = await fetch(path, { method: 'POST', headers: raw ? { 'X-Studio': '1' } : { 'X-Studio': '1', 'Content-Type': 'application/json' }, body: raw ? body : JSON.stringify(body ?? {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
export const fileUrl = (p) => '/api/file?path=' + encodeURIComponent(p);
export const thumbUrl = (p) => '/api/thumb?path=' + encodeURIComponent(p);
export const proxyUrl = (p) => '/api/proxy?path=' + encodeURIComponent(p);
export const baseName = (p) => String(p || '').split(/[\\/]/).pop();

/* ---------- formatting ---------- */
export function fmtTime(t) {
  if (!isFinite(t)) t = 0;
  const cs = Math.round(t * 100), m = Math.floor(cs / 6000), s = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${m}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}
export function fmtBytes(n) {
  if (n < 1000) return n + ' B';
  if (n < 1e6) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + ' KB';
  if (n < 1e9) return (n / 1e6).toFixed(2) + ' MB';
  return (n / 1e9).toFixed(2) + ' GB';
}
export const secs = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`);

/* ---------- events ---------- */
const listeners = {};
export function on(kind, fn) { (listeners[kind] ||= new Set()).add(fn); return () => listeners[kind].delete(fn); }
export function emit(kind, data) { for (const fn of listeners[kind] || []) { try { fn(data); } catch (e) { console.error(e); } } }
export const store = { snap: null, jobs: new Map(), online: false };

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('snapshot', (e) => {
    const s = JSON.parse(e.data); store.snap = s;
    for (const j of s.jobs) if (!store.jobs.has(j.id) || ['loading', 'running', 'queued'].includes(store.jobs.get(j.id).status)) store.jobs.set(j.id, j);
    emit('snapshot', s); renderStatus();
  });
  es.addEventListener('job', (e) => {
    const j = JSON.parse(e.data); store.jobs.set(j.id, j); emit('job', j); renderStatus();
    if (j.status === 'done') emit('library-changed', j);
  });
  es.addEventListener('text', (e) => emit('text', JSON.parse(e.data)));
  es.addEventListener('proxy', (e) => emit('proxy', JSON.parse(e.data)));
  es.addEventListener('agent', (e) => emit('agent', JSON.parse(e.data)));
  es.onerror = () => { es.close(); setTimeout(connect, 2000); };
}

/* A job's live state: the server pushes it on start and end; GET /api/job fills the middle. */
export function watchJob(id, fn, ms = 700) {
  let stop = false;
  const off = on('job', (j) => { if (j.id === id) fn(j); });
  (async function poll() {
    while (!stop) {
      try { const j = await get('/api/job?id=' + encodeURIComponent(id)); fn(j); if (!['loading', 'running', 'queued'].includes(j.status)) break; } catch (e) { /* not written yet */ }
      await new Promise((r) => setTimeout(r, ms));
    }
  })();
  return () => { stop = true; off(); };
}
export function cancelJob(id) { return post('/api/cancel', { id }); }

/* ---------- toast, modal ---------- */
let toastTimer;
export function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, err ? 6000 : 2800);
}
export function modal(title, body, buttons = []) {
  return new Promise((resolve) => {
    const back = h(`<div class="modal-back"><div class="modal" role="dialog" aria-modal="true"><header><h3 class="grow">${esc(title)}</h3><button class="btn ghost sm" data-x>✕</button></header><div class="body"></div><footer></footer></div></div>`);
    const close = (v) => { back.remove(); document.removeEventListener('keydown', key, true); resolve(v); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
    $('.body', back).append(typeof body === 'string' ? h(`<div>${body}</div>`) : body);
    for (const b of buttons) {
      const el = h(`<button class="btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}">${esc(b.label)}</button>`);
      el.onclick = () => close(b.value !== undefined ? b.value : (b.get ? b.get() : b.label)); $('footer', back).append(el);
    }
    if (!buttons.length) $('footer', back).remove();
    $('[data-x]', back).onclick = () => close(null);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(null); });
    document.addEventListener('keydown', key, true);
    document.body.append(back);
    back.close = close;
  });
}
export async function confirmBox(title, text, okLabel = 'OK', danger) {
  return modal(title, `<p>${esc(text)}</p>`, [{ label: 'Cancel', value: false }, { label: okLabel, value: true, primary: !danger, danger }]);
}

/* Folder picker: the server browses the disk (a browser cannot hand over a real path). */
export async function pickFolder(title = 'Open a folder', start) {
  const roots = await get('/api/drives');
  const box = h(`<div><div class="row nowrap" style="margin-bottom:10px"><input class="input grow mono" placeholder="C:\\path\\to\\folder"><button class="btn" data-go>Go</button></div><div class="row small" data-roots style="margin-bottom:10px"></div><div class="list" data-list></div></div>`);
  const input = $('input', box), list = $('[data-list]', box);
  let cur = start || roots.recent[0] || roots.places[0] || roots.drives[0];
  const chip = (label, path) => { const b = h(`<button class="btn sm">${esc(label)}</button>`); b.onclick = () => go(path); return b; };
  for (const r of roots.recent.slice(0, 5)) $('[data-roots]', box).append(chip('↺ ' + baseName(r.replace(/[\\/]$/, '')), r));
  for (const p of roots.places) $('[data-roots]', box).append(chip(baseName(p), p));
  for (const d of roots.drives) $('[data-roots]', box).append(chip(d, d));
  async function go(d) {
    try {
      const r = await get('/api/dir?dir=' + encodeURIComponent(d));
      cur = r.dir; input.value = r.dir; list.innerHTML = '';
      if (r.parent && r.parent !== r.dir) { const up = h(`<button class="item btn ghost" style="justify-content:flex-start">⬑ ..</button>`); up.onclick = () => go(r.parent); list.append(up); }
      for (const name of r.dirs) { const it = h(`<button class="item btn ghost" style="justify-content:flex-start">📁 ${esc(name)}</button>`); it.onclick = () => go(r.dir.replace(/[\\/]$/, '') + '\\' + name); list.append(it); }
      list.prepend(h(`<p class="small dim" style="margin:0 0 4px">${r.media} media file${r.media === 1 ? '' : 's'} here</p>`));
    } catch (e) { toast(e.message, true); }
  }
  $('[data-go]', box).onclick = () => go(input.value);
  input.onkeydown = (e) => { if (e.key === 'Enter') go(input.value); };
  if (cur) go(cur);
  return modal(title, box, [{ label: 'Cancel', value: null }, { label: 'Open this folder', primary: true, get: () => cur }]);
}

/* Library picker: choose one or more library items (filtered by media kinds). */
export async function pickLibrary(title, kinds, multi) {
  const { items } = await get('/api/library');
  const ok = items.filter((it) => !kinds || kinds.includes(it.media) || kinds.includes(it.kind));
  const chosen = new Set();
  const box = h(`<div>${ok.length ? '' : '<div class="empty">Nothing in the library yet.</div>'}<div class="grid small"></div></div>`);
  for (const it of ok) {
    const t = tileFor(it); t.onclick = () => {
      if (!multi) { chosen.clear(); $$('.tile.sel', box).forEach((x) => x.classList.remove('sel')); }
      chosen.has(it) ? chosen.delete(it) : chosen.add(it); t.classList.toggle('sel', chosen.has(it));
    };
    $('.grid', box).append(t);
  }
  const r = await modal(title, box, [{ label: 'Cancel', value: null }, { label: multi ? 'Add selected' : 'Choose', primary: true, get: () => [...chosen] }]);
  return r && r.length ? (multi ? r : r[0]) : null;
}

const AUDIO_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
export function tileFor(it) {
  const label = it.meta?.prompt || it.name;
  if (it.media === 'video' || it.media === 'image' || it.media === 'gif') {
    const t = h(`<div class="tile" title="${esc(label)}"><img loading="lazy" alt=""><div class="badge"><b>${esc(it.kind)}</b></div><div class="cap"><span>${esc(label)}</span></div></div>`);
    $('img', t).src = it.media === 'gif' ? fileUrl(it.path) : thumbUrl(it.path);
    return t;
  }
  if (it.media === 'svg') {
    const t = h(`<div class="tile" title="${esc(label)}" style="background:var(--surface-2)"><img loading="lazy" alt="" style="object-fit:contain;padding:8px"><div class="badge"><b>svg</b></div><div class="cap"><span>${esc(label)}</span></div></div>`);
    $('img', t).src = fileUrl(it.path); return t;
  }
  if (it.media === 'audio') return h(`<div class="tile audio-tile" title="${esc(label)}">${AUDIO_ICON}<div class="badge"><b>${esc(it.kind)}</b></div><div class="cap"><span>${esc(label)}</span></div></div>`);
  return h(`<div class="tile text-tile" title="${esc(label)}"><div class="badge" style="position:static;margin-bottom:6px"><b>${esc(it.kind)}</b></div>${esc(label).slice(0, 220)}</div>`);
}

/* Read an image from the clipboard (or a dropped/picked file) and store it in the library inbox. */
export async function saveBlob(blob, name, kind = 'image', source = 'import') {
  return post(`/api/library/save?kind=${kind}&name=${encodeURIComponent(name)}&source=${source}`, blob, true);
}
export async function pasteImage() {
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) return (await saveBlob(await item.getType(type), 'clipboard.png')).path;
    }
  } catch (e) { /* permission or empty */ }
  toast('No image in the clipboard.', true); return null;
}

/* Faster <-> Better: 5 levels; describe(level) returns what the level means for this model. */
export function effortSlider(value, onChange, describe) {
  const el = h(`<div class="field"><div class="row"><label class="lab grow" style="margin:0">Effort</label><span class="small dim" data-d></span></div>
    <div class="row nowrap"><span class="small faint">Faster</span><input type="range" min="1" max="5" step="1" class="grow"><span class="small faint">Better</span></div></div>`);
  const r = $('input', el), d = $('[data-d]', el);
  const upd = () => { d.textContent = describe ? describe(+r.value) : ''; };
  r.value = value; upd();
  r.oninput = () => { upd(); onChange(+r.value); };
  el.set = (v) => { r.value = v; upd(); };
  return el;
}
/* Remembered per-key UI choices (localStorage; the app works without it). */
export function pref(key, fallback) { try { const v = localStorage.getItem('ms.' + key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; } }
export function setPref(key, v) { try { localStorage.setItem('ms.' + key, JSON.stringify(v)); } catch (e) { /* storage off */ } }
export const newSeed = () => 1 + Math.floor(Math.random() * 2 ** 31);

/* Reference images: a strip of thumbnails with add-from-library, paste, and remove. Returns { el, list }. */
export function imagePicker(label = 'Images') {
  const list = [];
  const el = h(`<div class="field"><div class="row" style="margin-bottom:6px"><label class="lab grow" style="margin:0">${esc(label)}</label><button class="btn sm" data-lib>Library</button><button class="btn sm" data-paste>Paste</button><button class="btn sm" data-file>File…</button><input type="file" accept="image/*" multiple hidden></div><div class="thumbs"></div></div>`);
  const draw = () => {
    const box = $('.thumbs', el); box.innerHTML = '';
    if (!list.length) box.append(h('<span class="small faint">none</span>'));
    list.forEach((p, i) => { const t = h(`<div class="t" title="${esc(baseName(p))}"><img alt=""><button title="Remove">✕</button></div>`); $('img', t).src = thumbUrl(p); $('button', t).onclick = () => { list.splice(i, 1); draw(); }; box.append(t); });
  };
  const add = (p) => { if (p && !list.includes(p)) list.push(p); draw(); };
  $('[data-lib]', el).onclick = async () => { const r = await pickLibrary('Choose images', ['image'], true); (r || []).forEach((it) => add(it.path)); };
  $('[data-paste]', el).onclick = async () => add(await pasteImage());
  const fi = $('input[type=file]', el);
  $('[data-file]', el).onclick = () => fi.click();
  fi.onchange = async () => { for (const f of fi.files) add((await saveBlob(f, f.name)).path); fi.value = ''; };
  draw();
  return { el, list, add, clear: () => { list.length = 0; draw(); } };
}

/* ---------- header: status pills and job tray ---------- */
const STATUS_ACTIVE = ['loading', 'running', 'queued'];
export const jobLabel = (j) => `${j.preset}${j.model && j.model !== j.preset ? ' · ' + j.model : ''}`;
export function jobCard(j, opts = {}) {
  const el = h(`<div class="job ${j.status === 'error' ? 'error' : ''}"><div class="head"><span class="st ${j.status}">${j.status}</span><span class="grow" title="${esc(j.task)}"><b>${esc(jobLabel(j))}</b> <span class="dim">${esc(j.task || '')}</span></span><span class="num small dim">${secs(j.elapsedS ?? Math.round(((j.ended || Date.now() / 1000) - j.started)))}</span></div></div>`);
  if (STATUS_ACTIVE.includes(j.status)) {
    el.append(h(`<div class="bar"><i style="width:${Math.round((j.progress || 0) * 100)}%"></i></div>`));
    const c = h('<button class="btn ghost sm" title="Cancel">✕</button>'); c.onclick = () => cancelJob(j.id); $('.head', el).append(c);
  }
  if (j.error) el.append(h(`<div class="small" style="color:var(--danger);margin-top:4px">${esc(j.error)}</div>`));
  if (j.output && j.status === 'done' && !opts.noOutput) {
    const row = h(`<div class="row small" style="margin-top:6px"><span class="grow mono dim" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(baseName(j.output))}</span></div>`);
    const o = h('<button class="btn ghost sm">Open</button>'); o.onclick = () => post('/api/open', { path: j.output });
    const r = h('<button class="btn ghost sm">Show</button>'); r.onclick = () => post('/api/reveal', { path: j.output });
    row.append(o, r); el.append(row);
  }
  return el;
}
function renderStatus() {
  const s = store.snap;
  if (s) $('#dd2').hidden = !s.dd2;
  const active = [...store.jobs.values()].filter((j) => STATUS_ACTIVE.includes(j.status));
  $('#tray-count').textContent = active.length ? `${active.length} working` : 'no jobs';
  $('#tray-btn').classList.toggle('busy', active.length > 0);
  if (!$('#tray').hidden) renderTray();
}
function renderTray() {
  const tray = $('#tray'); tray.innerHTML = '';
  const jobs = [...store.jobs.values()].sort((a, b) => (b.started || 0) - (a.started || 0)).slice(0, 12);
  if (!jobs.length) tray.append(h('<div class="empty">No jobs yet.</div>'));
  for (const j of jobs) tray.append(jobCard(j));
  const all = h('<button class="btn ghost sm" style="margin-top:8px;width:100%">All jobs in System</button>'); all.onclick = () => { tray.hidden = true; go('system'); }; tray.append(all);
}
$('#tray-btn').onclick = () => { const t = $('#tray'); t.hidden = !t.hidden; if (!t.hidden) renderTray(); };
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#tray, #tray-btn')) $('#tray').hidden = true; });
async function checkOnline() {
  try { const r = await get('/api/online'); store.online = r.online; } catch (e) { store.online = false; }
  const n = $('#net'); n.classList.toggle('on', store.online); $('span:last-child', n).textContent = store.online ? 'online' : 'offline';
  emit('online', store.online);
}

/* theme: system by default, toggled light/dark, remembered */
function setTheme(t) { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; try { localStorage.setItem('ms.theme', t || ''); } catch (e) { /* storage off */ } }
try { setTheme(localStorage.getItem('ms.theme') || ''); } catch (e) { /* storage off */ }
$('#theme').onclick = () => {
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  setTheme(dark ? 'light' : 'dark');
};

/* ---------- tabs ---------- */
const I = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const TABS = [
  { id: 'orchestrate', label: 'Orchestrate', icon: I('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>') },
  { id: 'agent', label: 'Agent', icon: I('<path d="M4 5h16v11H9l-5 4z"/><path d="M8 10h.01M12 10h.01M16 10h.01"/>') },
  { id: 'generate', label: 'Generate', icon: I('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>') },
  { id: 'review', label: 'Review', icon: I('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9.5v5l4-2.5z"/>') },
  { id: 'shots', label: 'Shots', icon: I('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-8 8"/>') },
  { id: 'editor', label: 'Video', icon: I('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v5M16 4v5M3 15h18"/>') },
  { id: 'image', label: 'Image', icon: I('<path d="M4 4h10v10H4z"/><path d="M10 10h10v10H10z"/>') },
  { id: 'library', label: 'Library', icon: I('<path d="M4 4h4v16H4zM10 4h4v16h-4z"/><path d="M16 5l3.5-1 3 15.5-3.5 1z"/>') },
  { id: 'system', label: 'System', icon: I('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/>') },
];
const mounted = {};
let current = null;
export async function go(id, arg) {
  if (!TABS.some((t) => t.id === id)) id = 'orchestrate';
  if (current === id && arg === undefined) return;
  if (current && mounted[current]) { mounted[current].el.hidden = true; mounted[current].mod.hide?.(); }
  current = id;
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.id === id)));
  if (location.hash !== '#' + id) history.replaceState(null, '', '#' + id);
  try { localStorage.setItem('ms.tab', id); } catch (e) { /* storage off */ }
  if (!mounted[id]) {
    const el = h('<section class="page"></section>'); $('#view').append(el);
    const mod = await import(`./tabs/${id}.js`);
    mounted[id] = { el, mod };
    await mod.mount(el, arg);
  } else {
    mounted[id].el.hidden = false;
    mounted[id].mod.show?.(arg);
  }
}
export const currentTab = () => current;
for (const t of TABS) {
  const b = h(`<button class="tab" role="tab" data-id="${t.id}">${t.icon}${t.label}</button>`);
  b.onclick = () => go(t.id); $('#tabs').append(b);
}
/* keyboard: the visible tab gets keys unless typing in a field */
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('.modal-back')) return;
  const m = mounted[current];
  if (m && m.mod.onKey) m.mod.onKey(e);
});

connect();
checkOnline(); setInterval(checkOnline, 30000);
let first = location.hash.slice(1);
try { first = first || localStorage.getItem('ms.tab'); } catch (e) { /* storage off */ }
go(first || 'orchestrate');
