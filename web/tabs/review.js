/* Review: open a capture folder, watch every clip from the keyboard, mark takes with I/O named from the shot list,
   then "Make all" encodes each take as a Nexus GIF (640×360, under 8 MB) straight into the folder.
   Progress (reviewed clips, takes, made GIFs, where you were) lives in <folder>/.mediastudio.json. */
import { $, $$, h, esc, get, post, toast, fileUrl, thumbUrl, proxyUrl, fmtTime, fmtBytes, pickFolder, on, clamp, pref, setPref } from '../app.js';
import { makeNexusGif, NEXUS } from '../gif/nexus.js';

let root, F = null, cur = -1, video, saveTimer = null, making = null, selTake = null, markIn = null;
const SPEEDS = { 1: 1, 2: 2, 4: 4 };
const blank = () => ({ version: 1, shots: [], takes: [], reviewed: [], last: null, speed: 1 });

export function mount(el) {
  root = el;
  el.append(h(`<div class="page-head"><div><h2>Review</h2><p data-sub>Open a capture folder: every clip and screenshot in one grid. Hover to scrub.</p></div>
    <div class="row"><button class="btn primary" data-open>Open folder…</button><span class="row" data-recent></span></div></div>`));
  el.append(h(`<div data-body><div class="empty">No folder open. <br><span class="small">Keys: <kbd>Space</kbd> play · <kbd>1</kbd><kbd>2</kbd><kbd>4</kbd> speed · <kbd>←</kbd><kbd>→</kbd> seek (Shift ×5) · <kbd>,</kbd><kbd>.</kbd> frame · <kbd>N</kbd>/<kbd>P</kbd> next/prev clip · <kbd>I</kbd>/<kbd>O</kbd> take in/out</span></div></div>`));
  $('[data-open]', el).onclick = async () => { const d = await pickFolder('Open a capture folder', F?.dir); if (d) open(d); };
  on('proxy', (m) => { if (!F) return; const it = F.items.find((x) => x.path === m.src); if (it) { it.proxy = !m.error; const t = $(`.tile[data-i="${F.items.indexOf(it)}"]`, root); if (t) t.querySelector('.badge b.px')?.remove(); } });
  get('/api/drives').then((r) => {
    const box = $('[data-recent]', el);
    for (const d of r.recent.slice(0, 3)) { const b = h(`<button class="btn sm" title="${esc(d)}">↺ ${esc(d.split(/[\\/]/).filter(Boolean).pop())}</button>`); b.onclick = () => open(d); box.append(b); }
  });
  const last = pref('review.dir', null);
  if (last) open(last, true);
}

async function open(dir, quiet) {
  try {
    const r = await get('/api/folder?dir=' + encodeURIComponent(dir));
    F = { dir: r.dir, items: r.items, state: Object.assign(blank(), r.state || {}) };
    setPref('review.dir', r.dir);
    // proxies: queue every clip that has none (the server works newest-request-first, so ask in reverse)
    for (const it of [...F.items].reverse()) if (it.kind === 'video' && !it.proxy) fetch(proxyUrl(it.path)).catch(() => {});
    build();
    const li = F.state.last ? F.items.findIndex((x) => x.name === F.state.last.clip) : -1;
    select(li >= 0 ? li : 0, li >= 0 ? F.state.last.t : 0);
    if (li >= 0 && !quiet) toast('Picked up where you left off.');
  } catch (e) { if (!quiet) toast(e.message, true); }
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => post('/api/folder/state?dir=' + encodeURIComponent(F.dir), JSON.stringify(F.state), true).catch((e) => toast('Could not save review state: ' + e.message, true)), 400);
}

function build() {
  const body = $('[data-body]', root); body.innerHTML = '';
  const vids = F.items.filter((x) => x.kind !== 'image').length;
  $('[data-sub]', root).textContent = `${F.dir} · ${vids} clip${vids === 1 ? '' : 's'}, ${F.items.length - vids} screenshot${F.items.length - vids === 1 ? '' : 's'}`;
  const top = h(`<div class="split">
    <div><div class="viewer"><video playsinline></video><img hidden alt=""></div>
      <div class="transport"><button class="btn sm" data-play>▶</button><span class="num small" data-time>0:00.00</span><div class="timeline-mini" data-tl><div class="sel" hidden></div><div class="ph"></div></div>
        <div class="seg" data-speed><button data-v="1">1×</button><button data-v="2">2×</button><button data-v="4">4×</button></div>
        <button class="btn sm" data-in title="I">In</button><button class="btn sm" data-out title="O">Out → take</button></div>
      <p class="small faint" style="margin:6px 2px"><kbd>Space</kbd> play · <kbd>1</kbd><kbd>2</kbd><kbd>4</kbd> speed · <kbd>←</kbd><kbd>→</kbd> 1 s (Shift 5 s) · <kbd>,</kbd><kbd>.</kbd> frame · <kbd>N</kbd>/<kbd>P</kbd> clip · <kbd>I</kbd>/<kbd>O</kbd> take · <kbd>Del</kbd> remove take</p>
    </div>
    <div>
      <div class="card"><div class="row"><h3 class="grow">Shot list</h3><span class="small dim" data-shotcount></span></div><p class="small dim" style="margin:0 0 6px">One name per line. Each take gets the next free name.</p><textarea class="input mono" rows="6" data-shots></textarea></div>
      <div class="card"><div class="row" style="margin-bottom:8px"><h3 class="grow">Takes</h3><button class="btn primary sm" data-make>Make all</button><button class="btn sm" data-stop hidden>Stop</button></div>
        <div class="small dim" data-mk hidden><div class="bar"><i></i></div><span></span></div><div class="list" data-takes></div></div>
    </div></div>`);
  body.append(top, h('<h3 style="margin:18px 0 8px">Clips and screenshots</h3>'), h('<div class="grid" data-grid></div>'));
  video = $('video', top);
  video.muted = pref('review.muted', false);
  video.onvolumechange = () => setPref('review.muted', video.muted);
  video.onerror = () => {
    const it = F.items[cur];
    if (it && it.kind === 'video' && !video.src.includes('/api/proxy')) { toast('This clip cannot play in the browser (codec): showing the low-res proxy. GIFs from it are made with ffmpeg.', true); it.noPlay = true; video.src = proxyUrl(it.path); }
  };
  video.ontimeupdate = () => { drawTime(); remember(); };
  video.onplay = video.onpause = () => { $('[data-play]', root).textContent = video.paused ? '▶' : '❚❚'; };
  $('[data-play]', top).onclick = toggle;
  $('[data-in]', top).onclick = setIn;
  $('[data-out]', top).onclick = setOut;
  $('[data-speed]', top).onclick = (e) => { const b = e.target.closest('button'); if (b) speed(+b.dataset.v); };
  $('[data-tl]', top).onmousedown = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const seek = (ev) => { if (video.duration) video.currentTime = clamp((ev.clientX - r.left) / r.width, 0, 1) * video.duration; };
    seek(e);
    const mv = (ev) => seek(ev), up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
  };
  const ta = $('[data-shots]', top);
  ta.value = F.state.shots.join('\n');
  ta.oninput = () => { F.state.shots = ta.value.split('\n').map((s) => s.trim()).filter(Boolean); save(); drawTakes(); };
  $('[data-make]', top).onclick = makeAll;
  $('[data-stop]', top).onclick = () => { if (making) making.cancelled = true; };
  speed(F.state.speed || 1, true);
  drawGrid(); drawTakes();
}

function drawGrid() {
  const g = $('[data-grid]', root); g.innerHTML = '';
  F.items.forEach((it, i) => {
    const takes = F.state.takes.filter((t) => t.clip === it.name).length;
    const t = h(`<div class="tile ${i === cur ? 'cur' : ''}" data-i="${i}" title="${esc(it.name)}"><img loading="lazy" alt=""><div class="badge">${it.kind === 'image' ? '<b>shot</b>' : `<b>${fmtTime(it.dur).replace(/\.\d+$/, '')}</b>`}${F.state.reviewed.includes(it.name) ? '<b class="ok">✓</b>' : ''}${takes ? `<b class="mark">${takes} take${takes > 1 ? 's' : ''}</b>` : ''}${it.kind === 'video' && !it.proxy ? '<b class="px">…</b>' : ''}</div><div class="cap"><span>${esc(it.name)}</span></div><div class="scrub"></div></div>`);
    $('img', t).src = thumbUrl(it.path);
    t.onclick = () => select(i, 0);
    if (it.kind === 'video') {
      let pv = null;
      t.onmouseenter = () => {
        if (!it.proxy) return;
        pv = document.createElement('video'); pv.muted = true; pv.preload = 'auto'; pv.src = proxyUrl(it.path); t.insertBefore(pv, t.querySelector('.badge'));
      };
      t.onmousemove = (e) => {
        const r = t.getBoundingClientRect(), f = clamp((e.clientX - r.left) / r.width, 0, 1);
        $('.scrub', t).style.width = (f * 100) + '%';
        if (pv && pv.readyState >= 1 && it.dur) pv.currentTime = f * it.dur;
      };
      t.onmouseleave = () => { $('.scrub', t).style.width = '0'; if (pv) { pv.remove(); pv = null; } };
    }
    g.append(t);
  });
}

function select(i, t = 0) {
  if (!F || !F.items.length) return;
  i = (i + F.items.length) % F.items.length;
  if (cur >= 0 && F.items[cur] && !F.state.reviewed.includes(F.items[cur].name)) F.state.reviewed.push(F.items[cur].name);
  cur = i; markIn = null; selTake = null;
  const it = F.items[i], img = $('.viewer img', root);
  if (it.kind === 'image') {
    video.pause(); video.hidden = true; video.removeAttribute('src'); img.hidden = false; img.src = fileUrl(it.path);
  } else {
    img.hidden = true; video.hidden = false;
    video.src = it.noPlay ? proxyUrl(it.path) : fileUrl(it.path);
    video.playbackRate = SPEEDS[F.state.speed] || 1;
    video.onloadedmetadata = () => { video.currentTime = Math.min(t || 0, (video.duration || 1) - 0.05); video.playbackRate = SPEEDS[F.state.speed] || 1; drawTime(); };
    video.play().catch(() => {});
  }
  F.state.last = { clip: it.name, t: t || 0 };
  save(); drawGrid(); drawTakes();
  $(`.tile[data-i="${i}"]`, root)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

let lastRemember = 0;
function remember() {
  if (!F || cur < 0 || Date.now() - lastRemember < 3000) return;
  lastRemember = Date.now();
  F.state.last = { clip: F.items[cur].name, t: +video.currentTime.toFixed(2) };
  save();
}

function drawTime() {
  const d = video.duration || 0, tl = $('[data-tl]', root);
  $('[data-time]', root).textContent = `${fmtTime(video.currentTime)} / ${fmtTime(d)}`;
  if (!d) return;
  $('.ph', tl).style.left = (video.currentTime / d * 100) + '%';
  const sel = $('.sel', tl);
  if (markIn !== null) { sel.hidden = false; const a = Math.min(markIn, video.currentTime), b = Math.max(markIn, video.currentTime); sel.style.left = (a / d * 100) + '%'; sel.style.width = ((b - a) / d * 100) + '%'; }
  else sel.hidden = true;
  $$('.take', tl).forEach((x) => x.remove());
  for (const tk of F.state.takes.filter((x) => x.clip === F.items[cur]?.name)) tl.append(h(`<div class="take" style="left:${tk.in / d * 100}%;width:${(tk.out - tk.in) / d * 100}%" title="${esc(tk.name)}"></div>`));
}

function speed(v, quiet) {
  F.state.speed = v; video.playbackRate = SPEEDS[v] || 1;
  $$('[data-speed] button', root).forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.v === v)));
  if (!quiet) save();
}
function toggle() { if (video.hidden) return; video.paused ? video.play() : video.pause(); }
function setIn() { if (video.hidden) return; markIn = video.currentTime; drawTime(); toast(`In at ${fmtTime(markIn)}. Press O at the end of the take.`); }
function nextName() {
  const used = new Set(F.state.takes.map((t) => t.name));
  return F.state.shots.find((s) => !used.has(s)) || `take ${F.state.takes.length + 1}`;
}
function setOut() {
  if (video.hidden) return;
  if (markIn === null) return toast('Press I at the start of the take first.', true);
  const a = Math.min(markIn, video.currentTime), b = Math.max(markIn, video.currentTime);
  if (b - a < 0.3) return toast('Take too short.', true);
  const tk = { id: Date.now().toString(36), name: nextName(), clip: F.items[cur].name, path: F.items[cur].path, in: +a.toFixed(2), out: +b.toFixed(2), made: null };
  F.state.takes.push(tk); markIn = null; selTake = tk.id;
  save(); drawTakes(); drawTime(); drawGrid();
  toast(`Take "${tk.name}" saved (${(b - a).toFixed(1)} s).`);
}

function drawTakes() {
  const box = $('[data-takes]', root); if (!box) return;
  box.innerHTML = '';
  const used = new Set(F.state.takes.map((t) => t.name));
  $('[data-shotcount]', root).textContent = F.state.shots.length ? `${F.state.shots.filter((s) => used.has(s)).length}/${F.state.shots.length} taken · next: ${nextName()}` : `next: ${nextName()}`;
  if (!F.state.takes.length) box.append(h('<span class="small faint">No takes yet: I at the start, O at the end.</span>'));
  for (const tk of F.state.takes) {
    const it = h(`<div class="item ${tk.id === selTake ? 'active' : ''} ${tk.made ? 'done' : ''}"><div class="grow"><b>${esc(tk.name)}</b> <span class="small dim">${esc(tk.clip)} · ${fmtTime(tk.in)}–${fmtTime(tk.out)} · ${(tk.out - tk.in).toFixed(1)} s</span>${tk.made ? `<div class="small" style="color:var(--ok)">✓ ${esc(tk.made.file)} · ${fmtBytes(tk.made.size)}${tk.made.label ? ' · ' + esc(tk.made.label) : ''}</div>` : ''}</div></div>`);
    const name = h('<button class="btn ghost sm" title="Rename">✎</button>');
    name.onclick = (e) => { e.stopPropagation(); const n = prompt('Take name', tk.name); if (n && n.trim()) { tk.name = n.trim(); tk.made = null; save(); drawTakes(); } };
    const del = h('<button class="btn ghost sm" title="Remove take">✕</button>');
    del.onclick = (e) => { e.stopPropagation(); F.state.takes = F.state.takes.filter((x) => x !== tk); save(); drawTakes(); drawTime(); drawGrid(); };
    it.append(name, del);
    it.onclick = () => { selTake = tk.id; const i = F.items.findIndex((x) => x.name === tk.clip); if (i !== cur) select(i, tk.in); else video.currentTime = tk.in; drawTakes(); };
    box.append(it);
  }
}

async function makeAll() {
  if (making) return;
  const todo = F.state.takes.filter((t) => !t.made);
  if (!todo.length) return toast('Every take already has its GIF. Rename or re-add a take to make it again.');
  video.pause();
  making = { cancelled: false };
  const mk = $('[data-mk]', root), bar = $('i', mk), label = $('span', mk);
  mk.hidden = false; $('[data-make]', root).hidden = true; $('[data-stop]', root).hidden = false;
  let n = 0;
  try {
    for (const tk of todo) {
      if (making.cancelled) break;
      n++;
      const file = tk.name.replace(/[<>:"/\\|?*]+/g, '_') + '.gif';
      const pre = `${n}/${todo.length} ${tk.name}: `;
      const item = F.items.find((x) => x.name === tk.clip);
      if (item?.noPlay) {
        // the browser cannot decode this clip: ffmpeg makes the GIF (palettegen, same 640×360 / 8 MB limits)
        label.textContent = pre + 'ffmpeg…';
        const r = await post('/api/gif', { src: tk.path, start: tk.in, end: tk.out, dir: F.dir, name: file });
        const j = await new Promise((res) => { const iv = setInterval(async () => { const jj = await get('/api/job?id=' + r.id); bar.style.width = Math.round(jj.progress * 100) + '%'; if (!['queued', 'running', 'loading'].includes(jj.status)) { clearInterval(iv); res(jj); } }, 800); });
        if (j.status !== 'done') throw new Error(j.error || 'GIF failed');
        tk.made = { file, size: j.size || 0, label: `ffmpeg, ${j.fps} fps, ${j.colors} colors` };
      } else {
        const r = await makeNexusGif(fileUrl(tk.path), tk.in, tk.out, (f, t) => { bar.style.width = Math.round(f * 100) + '%'; label.textContent = pre + t; }, making);
        const w = await post(`/api/folder/write?dir=${encodeURIComponent(F.dir)}&name=${encodeURIComponent(file)}`, new Blob([r.bytes], { type: 'image/gif' }), true);
        tk.made = { file, size: w.size, label: r.label + (r.fits ? '' : ' · over 8 MB') };
        if (!r.fits) toast(`"${tk.name}" is too busy for 8 MB at this length: shorten the take.`, true);
      }
      save(); drawTakes();
    }
    if (!making.cancelled) toast(`Made ${n} GIF${n === 1 ? '' : 's'} in ${F.dir}.`);
  } catch (e) {
    if (e.message !== 'cancelled') toast('GIF failed: ' + e.message, true);
  } finally {
    making = null; mk.hidden = true; $('[data-make]', root).hidden = false; $('[data-stop]', root).hidden = true; save(); drawTakes();
  }
}

export function onKey(e) {
  if (!F) return;
  const k = e.key;
  if (k === ' ') { e.preventDefault(); toggle(); }
  else if (k === '1' || k === '2' || k === '4') speed(+k);
  else if (k === 'n' || k === 'N') select(cur + 1);
  else if (k === 'p' || k === 'P') select(cur - 1);
  else if (k === 'i' || k === 'I') setIn();
  else if (k === 'o' || k === 'O') setOut();
  else if (k === 'ArrowRight' || k === 'ArrowLeft') { e.preventDefault(); if (!video.hidden) video.currentTime = clamp(video.currentTime + (k === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 5 : 1), 0, video.duration || 0); }
  else if (k === '.' || k === ',') { if (!video.hidden) { video.pause(); video.currentTime = clamp(video.currentTime + (k === '.' ? 1 : -1) / 30, 0, video.duration || 0); } }
  else if ((k === 'Delete' || k === 'Backspace') && selTake) { F.state.takes = F.state.takes.filter((x) => x.id !== selTake); selTake = null; save(); drawTakes(); drawTime(); drawGrid(); }
}
export function hide() { if (video) video.pause(); }
export { NEXUS };
