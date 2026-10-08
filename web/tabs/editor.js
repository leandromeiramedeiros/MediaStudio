/* Video editor (tiny): V1 sequence (video, image, GIF) with trims and crossfades; V2 overlays (image, SVG, GIF,
   video) and text; A audio (music, voice, sfx) with volume and fades. The canvas preview approximates the cut;
   Render sends the project to ffmpeg (studio/media.py) for the exact MP4, optionally a Nexus GIF too. */
import { $, $$, h, esc, get, post, toast, fileUrl, baseName, fmtTime, clamp, pickLibrary, saveBlob, watchJob, go, pref, setPref, confirmBox } from '../app.js';

let root, P, path = null, sel = null, pps = 60, t = 0, playing = false, raf = 0, playT0 = 0, playAt = 0, dirty = false;
const els = new Map(); // src -> media element for the preview
const SIZES = [['1920×1080', 1920, 1080], ['1280×720', 1280, 720], ['1080×1920', 1080, 1920], ['720×1280', 720, 1280], ['1080×1080', 1080, 1080]];
const blank = () => ({ title: 'Untitled', w: 1280, h: 720, fps: 30, v1: [], v2: [], audio: [] });
const kindOf = (p) => { const e = p.split('.').pop().toLowerCase(); return e === 'gif' ? 'gif' : e === 'svg' ? 'svg' : /^(mp4|mkv|mov|webm|avi|m4v)$/.test(e) ? 'video' : /^(png|jpe?g|webp|bmp)$/.test(e) ? 'image' : /^(mp3|wav|flac|ogg|m4a|aac|opus)$/.test(e) ? 'audio' : null; };

/* ---------- timeline math (same as the server's build()) ---------- */
function layout() {
  const out = []; let end = 0;
  P.v1.forEach((c, i) => {
    const d = clipDur(c);
    const xf = i ? Math.min(+(P.v1[i - 1].xfade || 0), d / 2, out[i - 1].d / 2) : 0;
    const start = end - xf; out.push({ c, start, d, xf }); end = start + d;
  });
  return { clips: out, total: end };
}
const n = (v, d) => (v === undefined || v === null || v === '' || Number.isNaN(+v) ? d : +v);
const clipDur = (c) => (c.kind === 'image' ? +(c.dur || 3) : Math.max(0.1, (+c.out || c.srcDur || 3) - (+c.in || 0)));
const total = () => Math.max(layout().total, ...P.v2.map((o) => +o.end || 0), ...P.audio.map((a) => (+a.start || 0) + Math.max(0, (+a.out || a.srcDur || 0) - (+a.in || 0))), 1);

async function probe(p) { try { return await get('/api/probe?path=' + encodeURIComponent(p)); } catch (e) { return { dur: 0 }; } }

async function addMedia(p, where) {
  const k = kindOf(p); if (!k) return toast('Not a media file.', true);
  const info = await probe(p);
  if (k === 'audio') P.audio.push({ src: p, start: +t.toFixed(2), in: 0, out: info.dur || 5, srcDur: info.dur, vol: 1, fadein: 0, fadeout: 0, track: info.dur > 20 ? 'music' : 'fx' });
  else if (where === 'v2' || k === 'svg') P.v2.push({ src: p, kind: k, start: +t.toFixed(2), end: +(t + Math.min(info.dur || 4, 4)).toFixed(2), x: 0.82, y: 0.2, scale: 0.25, opacity: 1 });
  else if (k === 'image') P.v1.push({ src: p, kind: 'image', dur: 3, zoom: false, xfade: 0 });
  else P.v1.push({ src: p, kind: k, in: 0, out: info.dur || 3, srcDur: info.dur, xfade: 0, vol: 1 });
  changed(); draw();
}

/* ---------- preview ---------- */
function media(src, kind) {
  if (els.has(src)) return els.get(src);
  let el;
  if (kind === 'video') { el = document.createElement('video'); el.preload = 'auto'; el.playsInline = true; el.muted = true; }
  else if (kind === 'audio') { el = document.createElement('audio'); el.preload = 'auto'; }
  else el = new Image();
  el.src = fileUrl(src); els.set(src, el);
  if (kind !== 'audio') el.addEventListener(kind === 'video' ? 'loadeddata' : 'load', () => paint());
  return el;
}
function fitDraw(x, el, W, H, alpha = 1, zoom = 0) {
  const iw = el.videoWidth || el.naturalWidth, ih = el.videoHeight || el.naturalHeight;
  if (!iw || !ih) return;
  x.globalAlpha = alpha;
  if (zoom) { // cover + push-in, like zoompan
    const k = Math.max(W / iw, H / ih) * (1 + 0.12 * zoom), w = iw * k, hh = ih * k;
    x.drawImage(el, (W - w) / 2, (H - hh) / 2, w, hh);
  } else {
    const k = Math.min(W / iw, H / ih), w = iw * k, hh = ih * k;
    x.drawImage(el, (W - w) / 2, (H - hh) / 2, w, hh);
  }
  x.globalAlpha = 1;
}
function syncVideo(el, want, play, vol) {
  if (!el.duration) return;
  if (Math.abs(el.currentTime - want) > (play ? 0.35 : 0.02)) el.currentTime = clamp(want, 0, el.duration - 0.01);
  if (play && el.paused) el.play().catch(() => {});
  if (!play && !el.paused) el.pause();
  if (vol !== undefined) { el.muted = !play || vol <= 0; el.volume = clamp(vol, 0, 1); }
}
function paint() {
  const cv = $('canvas', root); if (!cv) return;
  const W = cv.width, H = cv.height, x = cv.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
  const L = layout(), active = new Set();
  for (const { c, start, d, xf } of L.clips) {
    if (t < start || t > start + d) continue;
    const local = t - start, alpha = xf && local < xf ? local / xf : 1;
    const el = media(c.src, c.kind === 'image' ? 'image' : c.kind);
    if (c.kind === 'video') { active.add(el); syncVideo(el, (+c.in || 0) + local, playing, c.vol ?? 1); }
    fitDraw(x, el, W, H, alpha, c.kind === 'image' && c.zoom ? local / d : 0);
  }
  for (const o of P.v2) {
    if (t < +o.start || t > +o.end) continue;
    if (o.kind === 'text') {
      const size = (+o.size || P.h / 12) * (H / P.h);
      x.font = `600 ${size}px "IBM Plex Sans", "Segoe UI", sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.lineWidth = Math.max(2, size / 7); x.strokeStyle = 'rgba(0,0,0,.7)'; x.fillStyle = o.color || '#fff';
      x.strokeText(o.text || '', W * n(o.x, 0.5), H * n(o.y, 0.85)); x.fillText(o.text || '', W * n(o.x, 0.5), H * n(o.y, 0.85));
      continue;
    }
    const el = media(o.src, o.kind === 'video' ? 'video' : 'image');
    if (o.kind === 'video') { active.add(el); syncVideo(el, (t - o.start) % (el.duration || 1e9), playing, 0); }
    const iw = el.videoWidth || el.naturalWidth || 1, ih = el.videoHeight || el.naturalHeight || 1;
    const w = W * (+o.scale || 0.3), hh = w * ih / iw;
    x.globalAlpha = n(o.opacity, 1);
    x.drawImage(el, W * n(o.x, 0.5) - w / 2, H * n(o.y, 0.5) - hh / 2, w, hh);
    x.globalAlpha = 1;
  }
  for (const a of P.audio) {
    const el = media(a.src, 'audio'), s = +a.start || 0, len = (+a.out || a.srcDur || 0) - (+a.in || 0);
    const on = t >= s && t < s + len;
    if (on) { active.add(el); syncVideo(el, (+a.in || 0) + (t - s), playing, n(a.vol, 1)); }
  }
  for (const el of els.values()) if (!active.has(el) && el.pause && !el.paused) el.pause();
  const ph = $('.playhead', root); if (ph) ph.style.left = (74 + t * pps) + 'px';
  const tm = $('[data-time]', root); if (tm) tm.textContent = `${fmtTime(t)} / ${fmtTime(total())}`;
}
function loop() {
  t = playAt + (performance.now() - playT0) / 1000;
  if (t >= total()) { stop(); t = total(); }
  paint();
  if (playing) raf = requestAnimationFrame(loop);
}
function play() { if (playing) return stop(); playing = true; if (t >= total() - 0.05) t = 0; playAt = t; playT0 = performance.now(); $('[data-play]', root).textContent = '❚❚'; loop(); }
function stop() { playing = false; cancelAnimationFrame(raf); $('[data-play]', root).textContent = '▶'; paint(); }
function seek(v) { t = clamp(v, 0, total()); if (playing) { playAt = t; playT0 = performance.now(); } paint(); }

/* ---------- tracks ---------- */
function draw() {
  const tr = $('[data-tracks]', root); tr.innerHTML = '';
  const tot = total(), width = Math.max(800, (tot + 5) * pps);
  const ruler = h(`<div class="ruler" style="width:${width}px"></div>`);
  const step = pps > 80 ? 1 : pps > 30 ? 2 : 5;
  for (let s = 0; s <= tot + 5; s += step) ruler.append(h(`<i style="left:${s * pps}px">${s}s</i>`));
  ruler.onmousedown = (e) => { const r = ruler.getBoundingClientRect(); seek((e.clientX - r.left) / pps); };
  tr.append(ruler);
  const L = layout();
  const lane = (name, items) => {
    const row = h(`<div class="track"><div class="tname">${name}</div><div class="lane" style="width:${width}px"></div></div>`);
    for (const it of items) $('.lane', row).append(it);
    tr.append(row);
  };
  lane('V1', L.clips.map(({ c, start, d }, i) => clipEl(c, start, d, 'v', baseName(c.src), { list: P.v1, i, seq: true })));
  lane('V2', P.v2.map((o, i) => clipEl(o, +o.start, +o.end - +o.start, o.kind === 'text' ? 't' : 'o', o.kind === 'text' ? '🅣 ' + (o.text || '') : baseName(o.src), { list: P.v2, i })));
  lane('Music', P.audio.map((a, i) => [a, i]).filter(([a]) => a.track === 'music').map(([a, i]) => clipEl(a, +a.start || 0, (+a.out || a.srcDur || 0) - (+a.in || 0), 'a', '🎵 ' + baseName(a.src), { list: P.audio, i })));
  lane('FX', P.audio.map((a, i) => [a, i]).filter(([a]) => a.track !== 'music').map(([a, i]) => clipEl(a, +a.start || 0, (+a.out || a.srcDur || 0) - (+a.in || 0), 'a', '🔊 ' + baseName(a.src), { list: P.audio, i })));
  tr.append(h(`<div class="playhead" style="left:${74 + t * pps}px"></div>`));
  tr.style.position = 'relative';
  props();
  paint();
}

/* a clip box: drag to move (V1: reorder), edge handles to trim */
function clipEl(c, start, d, cls, label, ref) {
  const el = h(`<div class="clip ${cls} ${sel === c ? 'sel' : ''}" style="left:${start * pps}px;width:${Math.max(6, d * pps)}px" title="${esc(label)}"><div class="h l"></div><span>${esc(label)}</span><div class="h r"></div></div>`);
  if (c.src && ['video', 'image', 'gif'].includes(c.kind)) el.style.backgroundImage = `linear-gradient(rgba(0,0,0,.35),rgba(0,0,0,.35)),url("/api/thumb?path=${encodeURIComponent(c.src)}")`;
  el.onmousedown = (e) => {
    e.preventDefault(); sel = c; let x0 = e.clientX; const handle = e.target.classList.contains('h') ? (e.target.classList.contains('l') ? 'l' : 'r') : null;
    const orig = JSON.parse(JSON.stringify(c));
    const mv = (ev) => {
      const dt = (ev.clientX - x0) / pps;
      if (ref.seq) {
        if (handle === 'r') { if (c.kind === 'image') c.dur = Math.max(0.3, +orig.dur + dt); else c.out = clamp(+orig.out + dt, (+c.in || 0) + 0.2, c.srcDur || 1e9); }
        else if (handle === 'l') { if (c.kind !== 'image') c.in = clamp(+orig.in + dt, 0, (+c.out || 0) - 0.2); else c.dur = Math.max(0.3, +orig.dur - dt); }
        else { // reorder: move past half of a neighbour
          const i = ref.list.indexOf(c), L = layout().clips;
          if (dt > 0 && i < ref.list.length - 1 && dt > L[i + 1].d / 2) { ref.list.splice(i, 1); ref.list.splice(i + 1, 0, c); x0 = ev.clientX; }
          else if (dt < 0 && i > 0 && -dt > L[i - 1].d / 2) { ref.list.splice(i, 1); ref.list.splice(i - 1, 0, c); x0 = ev.clientX; }
        }
      } else if ('end' in c) { // overlay / text
        if (handle === 'r') c.end = Math.max(+c.start + 0.2, +orig.end + dt);
        else if (handle === 'l') c.start = clamp(+orig.start + dt, 0, +c.end - 0.2);
        else { const len = +orig.end - +orig.start; c.start = Math.max(0, +orig.start + dt); c.end = +c.start + len; }
        c.start = +(+c.start).toFixed(2); c.end = +(+c.end).toFixed(2);
      } else { // audio
        if (handle === 'r') c.out = clamp(+orig.out + dt, (+c.in || 0) + 0.2, c.srcDur || 1e9);
        else if (handle === 'l') { c.in = clamp(+orig.in + dt, 0, +c.out - 0.2); c.start = Math.max(0, +orig.start + (c.in - orig.in)); }
        else c.start = Math.max(0, +(+orig.start + dt).toFixed(2));
      }
      draw();
    };
    const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); changed(); draw(); };
    addEventListener('mousemove', mv); addEventListener('mouseup', up);
    draw();
  };
  return el;
}

/* ---------- properties of the selected clip ---------- */
function props() {
  const box = $('[data-props]', root); box.innerHTML = '';
  if (!sel) { box.append(h('<div class="empty small">Select a clip on the timeline.</div>')); return; }
  const c = sel, isV1 = P.v1.includes(c), isAudio = P.audio.includes(c), isText = c.kind === 'text';
  box.append(h(`<h3 style="margin-bottom:8px">${isText ? 'Text' : esc(baseName(c.src))}</h3>`));
  const num = (key, label, step = 0.1, min = 0, max) => {
    const f = h(`<div class="field"><label class="lab">${label}</label><input class="input num" type="number" step="${step}" min="${min}" ${max !== undefined ? `max="${max}"` : ''}></div>`);
    const i = $('input', f); i.value = c[key] ?? ''; i.onchange = () => { c[key] = i.value === '' ? undefined : +i.value; changed(); draw(); }; return f;
  };
  const two = (...fs) => { const d = h('<div class="two"></div>'); fs.forEach((f) => d.append(f)); return d; };
  if (isText) {
    const f = h('<div class="field"><label class="lab">Text</label><input class="input"></div>'); const i = $('input', f); i.value = c.text || ''; i.oninput = () => { c.text = i.value; changed(); draw(); }; box.append(f);
    const col = h('<div class="field"><label class="lab">Color</label><input type="color"></div>'); $('input', col).value = c.color || '#ffffff'; $('input', col).oninput = (e) => { c.color = e.target.value; changed(); paint(); };
    box.append(two(num('size', 'Size (px)', 1, 8)), col);
  }
  if (isV1) {
    if (c.kind === 'image') { box.append(two(num('dur', 'Seconds', 0.1, 0.2))); const z = h(`<label class="check field"><input type="checkbox"${c.zoom ? ' checked' : ''}> Slow push-in</label>`); $('input', z).onchange = (e) => { c.zoom = e.target.checked; changed(); paint(); }; box.append(z); }
    else box.append(two(num('in', 'In (s)'), num('out', 'Out (s)')), two(num('vol', 'Clip volume', 0.05, 0, 2)));
    box.append(two(num('xfade', 'Crossfade into next (s)', 0.1, 0)));
  } else if (isAudio) {
    box.append(two(num('start', 'Starts at (s)'), num('vol', 'Volume', 0.05, 0, 2)), two(num('in', 'In (s)'), num('out', 'Out (s)')), two(num('fadein', 'Fade in (s)'), num('fadeout', 'Fade out (s)')));
    const tk = h(`<div class="field"><label class="lab">Track</label><select class="input"><option value="music">Music</option><option value="fx">FX / voice</option></select></div>`);
    $('select', tk).value = c.track || 'fx'; $('select', tk).onchange = (e) => { c.track = e.target.value; changed(); draw(); }; box.append(tk);
  } else {
    box.append(two(num('start', 'Start (s)'), num('end', 'End (s)')), two(num('x', 'X center (0–1)', 0.01, 0, 1), num('y', 'Y center (0–1)', 0.01, 0, 1)));
    if (!isText) box.append(two(num('scale', 'Width (0–1 of frame)', 0.01, 0.01, 1), num('opacity', 'Opacity', 0.05, 0, 1)));
  }
  const row = h('<div class="row" style="margin-top:6px"></div>');
  const dup = h('<button class="btn sm">Duplicate</button>'); dup.onclick = () => { const list = isV1 ? P.v1 : isAudio ? P.audio : P.v2; const cp = JSON.parse(JSON.stringify(c)); list.splice(list.indexOf(c) + 1, 0, cp); sel = cp; changed(); draw(); };
  const del = h('<button class="btn sm danger">Remove</button>'); del.onclick = () => { for (const list of [P.v1, P.v2, P.audio]) { const i = list.indexOf(c); if (i >= 0) list.splice(i, 1); } sel = null; changed(); draw(); };
  row.append(dup, del); box.append(row);
}

/* ---------- project I/O, render ---------- */
function changed() { dirty = true; setPref('editor.draft', { path, P }); }
async function save(quiet) {
  const r = await post('/api/project/save', { path, project: clean(P) });
  path = r.path; dirty = false; setPref('editor.draft', { path, P });
  if (!quiet) toast('Saved to the Library (projects).');
}
const clean = (p) => JSON.parse(JSON.stringify(p));
async function rasterizeSvgs(p) {
  for (const o of p.v2) {
    if (o.kind !== 'svg') continue;
    const img = media(o.src, 'image');
    await (img.complete ? Promise.resolve() : new Promise((r) => { img.onload = r; img.onerror = r; }));
    const w = Math.round(p.w * (+o.scale || 0.3)), hh = Math.round(w * (img.naturalHeight || 1) / (img.naturalWidth || 1));
    const c = document.createElement('canvas'); c.width = w; c.height = hh; c.getContext('2d').drawImage(img, 0, 0, w, hh);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    o.src = (await post('/api/upload?ext=png', blob, true)).path; o.kind = 'image';
  }
  return p;
}
async function render(gif) {
  if (!P.v1.length) return toast('Add at least one clip to V1.', true);
  stop();
  try {
    await save(true);
    const proj = await rasterizeSvgs(clean(P));
    const r = await post('/api/render', { project: proj, gif });
    const out = $('[data-render]', root); out.hidden = false;
    watchJob(r.id, (j) => {
      out.innerHTML = '';
      out.append(h(`<div class="row"><span class="st ${j.status}">${j.status}</span><span class="grow small dim">${esc(j.task || '')}</span></div>`));
      if (['queued', 'running', 'loading'].includes(j.status)) out.append(h(`<div class="bar" style="margin-top:6px"><i style="width:${Math.round((j.progress || 0) * 100)}%"></i></div>`));
      if (j.error) out.append(h(`<p style="color:var(--danger)">${esc(j.error)}</p>`));
      if (j.status === 'done') {
        const v = h('<div class="viewer" style="margin-top:8px"><video controls></video></div>'); $('video', v).src = fileUrl(j.output); out.append(v);
        const row = h('<div class="row" style="margin-top:8px"></div>');
        const o = h('<button class="btn sm">Open</button>'); o.onclick = () => post('/api/open', { path: j.output });
        const s = h('<button class="btn sm">Show file</button>'); s.onclick = () => post('/api/reveal', { path: j.output });
        row.append(o, s); out.append(row);
      }
    });
  } catch (e) { toast(e.message, true); }
}
async function openProject(p) {
  const r = await get('/api/project?path=' + encodeURIComponent(p));
  P = Object.assign(blank(), r.project); path = r.path; sel = null; t = 0; dirty = false;
  for (const c of [...P.v1, ...P.audio]) if (!c.srcDur && c.kind !== 'image') c.srcDur = (await probe(c.src)).dur;
  setupStage(); draw();
}

function setupStage() {
  const cv = $('canvas', root), k = Math.min(1, 960 / Math.max(P.w, P.h));
  cv.width = Math.round(P.w * k); cv.height = Math.round(P.h * k);
  $('.ed-stage', root).style.aspectRatio = `${P.w} / ${P.h}`;
  $('[data-title]', root).value = P.title || '';
  $('[data-size]', root).value = `${P.w}x${P.h}`;
}

export async function mount(el, arg) {
  root = el;
  const draft = pref('editor.draft', null);
  P = draft?.P ? Object.assign(blank(), draft.P) : blank(); path = draft?.path || null;
  el.append(h(`<div class="page-head"><div class="row"><input class="input" data-title style="width:240px;font-weight:600"><select class="input" data-size style="width:140px">${SIZES.map(([l, w, hh]) => `<option value="${w}x${hh}">${l}</option>`).join('')}</select></div>
    <div class="row"><button class="btn" data-new>New</button><button class="btn" data-openp>Open project…</button><button class="btn" data-save>Save</button><button class="btn primary" data-render-btn>Render MP4</button><button class="btn" data-render-gif>MP4 + Nexus GIF</button></div></div>`));
  el.append(h(`<div class="split"><div><div class="ed-stage"><canvas></canvas></div>
      <div class="row" style="margin:8px 0"><button class="btn sm" data-play>▶</button><span class="num small" data-time></span><span class="grow"></span>
        <button class="btn sm" data-add>+ Media</button><button class="btn sm" data-addov>+ Overlay</button><button class="btn sm" data-text>+ Text</button><button class="btn sm" data-file>+ File…</button><input type="file" multiple hidden>
        <span class="small faint">zoom</span><input type="range" min="10" max="200" data-zoom style="width:100px"></div>
      <div class="tracks" data-tracks></div>
      <p class="small faint"><kbd>Space</kbd> play · drag clips to move (V1: reorder) · drag edges to trim · <kbd>Del</kbd> removes the selected clip</p></div>
    <div><div class="card props" data-props></div><div class="card" data-render hidden></div></div></div>`));
  $('[data-title]', el).oninput = (e) => { P.title = e.target.value; changed(); };
  $('[data-size]', el).onchange = (e) => { const [w, hh] = e.target.value.split('x').map(Number); P.w = w; P.h = hh; changed(); setupStage(); paint(); };
  $('[data-new]', el).onclick = async () => { if (dirty && !(await confirmBox('New project', 'Discard unsaved changes?', 'Discard', true))) return; P = blank(); path = null; sel = null; t = 0; changed(); setupStage(); draw(); };
  $('[data-openp]', el).onclick = async () => { const it = await pickLibrary('Open a project', ['projects']); if (it) openProject(it.path); };
  $('[data-save]', el).onclick = () => save();
  $('[data-render-btn]', el).onclick = () => render(false);
  $('[data-render-gif]', el).onclick = () => render(true);
  $('[data-play]', el).onclick = play;
  $('[data-add]', el).onclick = async () => { const r = await pickLibrary('Add media', ['video', 'image', 'gif', 'audio', 'svg'], true); for (const it of r || []) await addMedia(it.path); };
  $('[data-addov]', el).onclick = async () => { const r = await pickLibrary('Add overlay', ['image', 'gif', 'svg', 'video'], true); for (const it of r || []) await addMedia(it.path, 'v2'); };
  $('[data-text]', el).onclick = () => { const o = { kind: 'text', text: 'Title', start: +t.toFixed(2), end: +(t + 3).toFixed(2), x: 0.5, y: 0.85, size: Math.round(P.h / 12), color: '#ffffff' }; P.v2.push(o); sel = o; changed(); draw(); };
  const fi = $('input[type=file]', el); $('[data-file]', el).onclick = () => fi.click();
  fi.onchange = async () => { for (const f of fi.files) { const k = kindOf(f.name); if (!k) continue; const r = await saveBlob(f, f.name, k === 'audio' ? 'sfx' : k, 'import'); await addMedia(r.path); } fi.value = ''; };
  const z = $('[data-zoom]', el); z.value = pps; z.oninput = () => { pps = +z.value; draw(); };
  setupStage(); draw();
  if (arg) await show(arg);
}

export async function show(arg) {
  if (!arg) return;
  if (arg.project) await openProject(arg.project);
  if (arg.add) await addMedia(arg.add);
}
export function hide() { stop(); }
export function onKey(e) {
  if (e.key === ' ') { e.preventDefault(); play(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { for (const list of [P.v1, P.v2, P.audio]) { const i = list.indexOf(sel); if (i >= 0) list.splice(i, 1); } sel = null; changed(); draw(); }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); seek(t + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 5 : 1 / P.fps)); }
}
