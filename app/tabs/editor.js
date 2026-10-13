/* Editor tab: a tiny video editor. V1 sequence (video, image, gif) with trims and crossfades, T text, O overlays (image, gif),
   A audio. The canvas preview follows the renderer (app/video/render.js); Export hands the project to the queue. */
(() => {
  const { $, $$, h, esc, clamp, fmtTime, pref, setPref, debounce, uid } = MS.util;
  const SIZES = [['1920×1080', '1920x1080'], ['1280×720', '1280x720'], ['1080×1920', '1080x1920'], ['1080×1080', '1080x1080']];
  const FONT = '"Bricolage Grotesque", "IBM Plex Sans", system-ui, sans-serif';
  const LANE = 44, HEAD = 74;
  const TRACKS = [['v1', 'V1'], ['text', 'T'], ['ov', 'O'], ['au', 'A']];
  const blank = () => ({ id: uid(), title: 'Untitled', w: 1920, h: 1080, fps: 30, quality: 'high', v1: [], text: [], overlays: [], audio: [], bin: [] });
  const r2 = (v) => Math.round(v * 100) / 100, r3 = (v) => Math.round(v * 1000) / 1000;
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  const ICON = 'M3 5h18v14H3zM7 5v14M17 5v14M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4';
  const svg = (d, w = 15) => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  const IC = {
    play: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M7 4.5v15l12-7.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z"/></svg>',
    home: svg('M6 5v14M18 5l-9 7 9 7z'), end: svg('M18 5v14M6 5l9 7-9 7z'), prev: svg('M15 5l-8 7 8 7'), next: svg('M9 5l8 7-8 7'),
    text: svg('M5 6V4h14v2M12 4v16M9 20h6'), split: svg('M12 3v18M7 7l-4 5 4 5M17 7l4 5-4 5'), trash: svg('M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3'),
    undo: svg('M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3'), redo: svg('M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3'), fit: svg('M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'),
  };
  const CSS = `
.ed-main{display:grid;grid-template-columns:204px minmax(0,1fr) 292px;gap:14px;align-items:start;margin-bottom:12px}
@media(max-width:1180px){.ed-main{grid-template-columns:196px minmax(0,1fr)}.ed-insp{grid-column:1/-1}}
.ed-title{width:230px;font-weight:600}
.ed-projects{margin-bottom:12px}.ed-projects .item{cursor:pointer}
.ed-bin{display:grid;grid-template-columns:1fr 1fr;gap:6px;max-height:44vh;overflow:auto;margin-top:10px;padding:2px}
.ed-bin .tile{aspect-ratio:4/3;cursor:grab;touch-action:none}.ed-bin .tile .cap{padding-top:10px;font-size:10.5px}
.ed-bin .tile .audio-tile svg{width:30px;height:30px}
.ed-bin .tile .x{position:absolute;top:3px;right:3px;width:18px;height:18px;border-radius:50%;border:0;background:rgba(0,0,0,.65);color:#fff;font-size:12px;line-height:1;padding:0;opacity:0;cursor:pointer;z-index:2}
.ed-bin .tile:hover .x{opacity:1}
.ed-view{background:var(--screen);border-radius:var(--r) var(--r) 0 0;display:flex;justify-content:center}
.ed-view .ed-stage{border-radius:0;margin:0;max-height:none}
.ed-stage canvas{cursor:default;touch-action:none}
.ed-empty{position:absolute;inset:0;display:grid;place-content:center;justify-items:center;gap:10px;text-align:center;color:#c9cde0;padding:16px;font-size:13px;pointer-events:none}
.ed-empty .btn{pointer-events:auto}
.ed-tools{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:12px 0 8px}
.ed-tools .sep{width:1px;height:20px;background:var(--line);margin:0 4px}
.ed-tools input[type=range]{width:110px}
.ed-tl{position:relative}
.ed-tl .tname{position:sticky;left:0;z-index:4;background:var(--surface)}
.ed-tl .lane.drop{background:var(--accent-soft)}
.ed-tl .clip{height:34px;bottom:auto;min-width:0}
.ed-tl .clip .h:hover{background:rgba(255,255,255,.35)}
.ed-tl .clip.v{background-color:#3b54d6}
.ed-tl .clip.dragging{z-index:6;opacity:.85;box-shadow:0 6px 18px rgba(0,0,0,.4);cursor:grabbing}
.ed-tl .clip .fi,.ed-tl .clip .fo{position:absolute;top:0;bottom:0;background:linear-gradient(90deg,rgba(0,0,0,.5),transparent);pointer-events:none}
.ed-tl .clip .fo{right:0;background:linear-gradient(270deg,rgba(0,0,0,.5),transparent)}
.ed-xf{position:absolute;top:5px;height:34px;background:repeating-linear-gradient(135deg,rgba(255,255,255,.6) 0 3px,rgba(255,255,255,.05) 3px 6px);border:1px solid rgba(255,255,255,.7);border-radius:4px;pointer-events:none;z-index:3}
.ed-xh{position:absolute;top:13px;width:16px;height:18px;margin-left:-8px;border-radius:5px;background:var(--surface);border:2px solid var(--mark);cursor:ew-resize;z-index:5;box-shadow:var(--sh-1)}
.ed-xh::after{content:"";position:absolute;left:3px;right:3px;top:4px;height:6px;border-left:2px solid var(--mark);border-right:2px solid var(--mark)}
.ed-drop,.ed-snap{position:absolute;top:0;bottom:0;width:2px;background:var(--accent);z-index:7;pointer-events:none}
.ed-snap{background:var(--mark);width:1px}
.ed-insp h3{margin:0 0 10px;font-size:14px}.ed-insp input[type=range]{width:100%}.ed-insp textarea{resize:vertical;min-height:54px}
.ed-insp .lab{display:flex;justify-content:space-between}.ed-insp input[type=color]{width:100%;height:34px;padding:2px;border:1px solid var(--line);border-radius:var(--r-sm);background:var(--surface)}
.ed-insp .seg{display:flex}.ed-insp .seg button{flex:1;padding-inline:6px}.ed-insp .ed-size{display:grid!important;grid-template-columns:1fr 1fr}
`;

  /* ---------- state ---------- */
  let root, cv, P = blank(), sel = null, t = 0, playing = false, rate = 1, raf = 0, lastT = 0;
  let pps = pref('editor.pps', 60), snapOn = pref('editor.snap', true), hits = [], syncs = [];
  let hist = [], hi = -1, lastKey = '', lastAt = 0, projects = [], dragRef = null, snapLine = null, tl = null;
  let readyRes; const ready = new Promise((r) => { readyRes = r; });
  const els = new Map(), infos = new Map(), thumbs = new Map();

  /* ---------- project helpers ---------- */
  const cdur = (c) => (c.kind === 'video' ? Math.max(0.1, num(+c.out, 0) - num(+c.in, 0)) : Math.max(0.1, num(+c.dur, 3)));
  const adur = (a) => Math.max(0.1, num(+a.out, 0) - num(+a.in, 0));
  const fallbackLayout = (p) => {
    const clips = []; let end = 0;
    p.v1.forEach((c, i) => {
      const d = cdur(c), prev = clips[i - 1], xf = prev ? Math.max(0, Math.min(num(+prev.c.xfade, 0), d / 2, prev.d / 2)) : 0;
      const start = prev ? prev.start + prev.d - xf : 0; clips.push({ c, start, d, xf }); end = Math.max(end, start + d);
    });
    let total = end;
    for (const x of p.text) total = Math.max(total, num(+x.end, 0));
    for (const x of p.overlays) total = Math.max(total, num(+x.end, 0));
    for (const a of p.audio) total = Math.max(total, num(+a.start, 0) + adur(a));
    return { clips, total };
  };
  const lay = () => (MS.render && MS.render.layout ? MS.render.layout(P) : fallbackLayout(P));
  const total = () => lay().total;
  const all = () => [...P.v1, ...P.text, ...P.overlays, ...P.audio];
  const find = (id) => all().find((i) => i.id === id);
  const cur = () => (sel ? find(sel) : null);
  const typeOf = (it) => (P.v1.includes(it) ? 'v1' : P.text.includes(it) ? 'text' : P.overlays.includes(it) ? 'ov' : 'au');
  const listOf = (it) => ({ v1: P.v1, text: P.text, ov: P.overlays, au: P.audio })[typeOf(it)];
  const isEmpty = (p) => !p.v1.length && !p.text.length && !p.overlays.length && !p.audio.length && !(p.bin || []).length;
  const itemName = (it) => (it.ref ? it.ref.name : it.text || 'Text');
  function sanitize(p) {
    const o = Object.assign(blank(), p);
    for (const k of ['v1', 'text', 'overlays', 'audio', 'bin']) if (!Array.isArray(o[k])) o[k] = [];
    for (const it of [...o.v1, ...o.text, ...o.overlays, ...o.audio]) if (!it.id) it.id = uid();
    return o;
  }

  /* ---------- media info, thumbs, preview elements ---------- */
  function infoOf(ref) {
    if (!infos.has(ref.ref)) {
      infos.set(ref.ref, (async () => {
        let i = null;
        try { const f = await MS.src.file(ref); if (MS.render && MS.render.probe) i = await MS.render.probe(f); } catch (e) { /* try the meta */ }
        if (!i || (!i.dur && (ref.kind === 'video' || ref.kind === 'audio'))) { try { const m = await MS.src.meta(ref); if (m) i = Object.assign({}, i, m); } catch (e) { /* none */ } }
        i = i || {}; return { dur: +i.dur || 0, w: i.w || 0, h: i.h || 0, hasAudio: i.hasAudio !== false };
      })());
    }
    return infos.get(ref.ref);
  }
  function thumbOf(ref, fn) {
    if (thumbs.has(ref.ref)) return fn(thumbs.get(ref.ref));
    Promise.resolve(MS.src.thumb(ref)).then((u) => { if (u) { thumbs.set(ref.ref, u); fn(u); } }, () => {});
  }
  const kick = (() => { let q = 0; return () => { if (!q) q = requestAnimationFrame(() => { q = 0; paint(); }); }; })();
  function elOf(key, ref, kind) {
    let e = els.get(key); if (e) return e;
    e = kind === 'video' ? document.createElement('video') : kind === 'audio' ? document.createElement('audio') : new Image();
    if (kind !== 'image') { e.preload = 'auto'; e.playsInline = true; e.addEventListener('loadeddata', kick); e.addEventListener('seeked', kick); } else e.addEventListener('load', kick);
    els.set(key, e);
    Promise.resolve(MS.src.url(ref)).then((u) => { e.src = u; }, () => { e.dataset.err = '1'; });
    return e;
  }
  const clipEl = (c) => (c.kind === 'video' ? elOf(c.id, c.ref, 'video') : elOf(c.ref.ref, c.ref, 'image'));
  function prune() {
    const keep = new Set([...P.v1.filter((c) => c.kind === 'video').map((c) => c.id), ...P.audio.map((a) => a.id), ...P.v1.filter((c) => c.kind !== 'video').map((c) => c.ref.ref), ...P.overlays.map((o) => o.ref.ref)]);
    for (const [k, e] of els) if (!keep.has(k)) { if (e.pause) e.pause(); e.removeAttribute('src'); els.delete(k); }
  }
  function syncMedia(e, want, gain, mp) {
    if (!e.duration || !isFinite(e.duration)) return;
    e.volume = clamp(gain, 0, 1); e.muted = gain <= 0; e.playbackRate = mp ? Math.abs(rate) : 1;
    const thr = mp ? 0.3 : 0.5 / P.fps;
    if (Math.abs(e.currentTime - want) > thr) e.currentTime = clamp(want, 0, e.duration - 0.001);
    if (mp && e.paused) e.play().catch(() => {});
    if (!mp && !e.paused) e.pause();
  }

  /* ---------- preview (same compositing as app/video/render.js) ---------- */
  function drawFit(x, e, W, H, alpha, fit, zoom) {
    const iw = e.videoWidth || e.naturalWidth, ih = e.videoHeight || e.naturalHeight;
    if (!iw || !ih) return;
    const k = (fit === 'cover' ? Math.max : Math.min)(W / iw, H / ih) * zoom, w = iw * k, hh = ih * k;
    x.globalAlpha = alpha; try { x.drawImage(e, (W - w) / 2, (H - hh) / 2, w, hh); } catch (err) { /* not decoded yet */ } x.globalAlpha = 1;
  }
  function wrap(x, txt, maxW) {
    const out = [];
    for (const para of String(txt).split('\n')) {
      let line = '';
      for (const word of para.split(' ')) { const s = line ? line + ' ' + word : word; if (line && x.measureText(s).width > maxW) { out.push(line); line = word; } else line = s; }
      out.push(line);
    }
    return out;
  }
  function paint() {
    if (!cv || !root) return;
    const W = cv.width, H = cv.height, x = cv.getContext('2d'), L = lay(), tt = t, mp = playing && rate > 0, k = H / P.h;
    x.globalAlpha = 1; x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
    const active = new Set(); hits = [];
    L.clips.forEach(({ c, start, d, xf }, i) => {
      const e = clipEl(c);
      if (tt < start || tt >= start + d) {
        if (c.kind === 'video' && tt < start && start - tt < 1.2 && e.duration && !e.seeking && Math.abs(e.currentTime - num(+c.in, 0)) > 0.05) e.currentTime = num(+c.in, 0); // warm up the next clip
        return;
      }
      const local = tt - start, a = xf && local < xf ? local / xf : 1, nx = L.clips[i + 1];
      if (c.kind === 'video') {
        const fo = nx && nx.xf ? clamp((start + d - tt) / nx.xf, 0, 1) : 1;
        active.add(e); syncMedia(e, num(+c.in, 0) + local, c.muted ? 0 : num(+c.vol, 1) * a * fo, mp);
      }
      drawFit(x, e, W, H, a, c.fit, c.kind === 'image' && c.zoom ? 1 + 0.08 * (local / d) : 1);
    });
    for (const o of P.overlays) {
      if (tt < o.start || tt >= o.end) continue;
      const e = elOf(o.ref.ref, o.ref, 'image'), iw = e.naturalWidth, ih = e.naturalHeight;
      if (!iw) continue;
      const w = W * num(+o.scale, 0.2), hh = w * ih / iw, cx = W * num(+o.x, 0.5), cy = H * num(+o.y, 0.5);
      x.globalAlpha = clamp(num(+o.opacity, 1), 0, 1); try { x.drawImage(e, cx - w / 2, cy - hh / 2, w, hh); } catch (err) { /* loading */ } x.globalAlpha = 1;
      hits.push({ it: o, x: cx - w / 2, y: cy - hh / 2, w, h: hh, ov: true });
    }
    for (const o of P.text) {
      if (tt < o.start || tt >= o.end || !o.text) continue;
      const fd = num(+o.fade, 0), a = fd > 0 ? clamp(Math.min((tt - o.start) / fd, (o.end - tt) / fd), 0, 1) : 1, px = num(+o.size, 48) * k;
      x.globalAlpha = a; x.font = `${o.weight || 700} ${px}px ${FONT}`; x.fillStyle = o.color || '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
      const ls = wrap(x, o.text, W * 0.92), lh = px * 1.25, cx = num(+o.x, 0.5) * W, cy = num(+o.y, 0.5) * H, y0 = cy - ((ls.length - 1) * lh) / 2;
      const tw = Math.max(...ls.map((l) => x.measureText(l).width));
      if (o.shadow) { x.shadowColor = 'rgba(0,0,0,.75)'; x.shadowBlur = px * 0.12; x.shadowOffsetY = px * 0.04; }
      ls.forEach((l, i) => x.fillText(l, cx, y0 + i * lh));
      x.shadowColor = 'transparent'; x.shadowBlur = 0; x.shadowOffsetY = 0; x.globalAlpha = 1;
      hits.push({ it: o, x: cx - tw / 2 - 6, y: cy - (lh * ls.length) / 2, w: tw + 12, h: lh * ls.length });
    }
    for (const a of P.audio) {
      const s = num(+a.start, 0), d = adur(a);
      if (tt < s || tt >= s + d) continue;
      const e = elOf(a.id, a.ref, 'audio'); active.add(e);
      const fi = num(+a.fadein, 0), fo = num(+a.fadeout, 0);
      syncMedia(e, num(+a.in, 0) + (tt - s), num(+a.vol, 1) * (fi > 0 ? clamp((tt - s) / fi, 0, 1) : 1) * (fo > 0 ? clamp((s + d - tt) / fo, 0, 1) : 1), mp);
    }
    for (const e of els.values()) if (e.pause && !e.paused && !active.has(e)) e.pause();
    const s = !playing && cur();
    if (s) {
      const hb = hits.find((o) => o.it === s);
      if (hb) {
        x.save(); x.lineWidth = 3; x.strokeStyle = 'rgba(0,0,0,.6)'; x.strokeRect(hb.x, hb.y, hb.w, hb.h);
        x.lineWidth = 1.5; x.strokeStyle = '#fff'; x.setLineDash([6, 4]); x.strokeRect(hb.x, hb.y, hb.w, hb.h); x.setLineDash([]);
        if (hb.ov) { x.fillStyle = '#fff'; x.strokeStyle = '#000'; x.lineWidth = 1; x.fillRect(hb.x + hb.w - 6, hb.y + hb.h - 6, 12, 12); x.strokeRect(hb.x + hb.w - 6, hb.y + hb.h - 6, 12, 12); }
        x.restore();
      }
    }
    uiTime();
  }
  function uiTime() {
    if (!root) return;
    const ph = $('.ed-ph', root); if (ph) ph.style.left = (HEAD + t * pps) + 'px';
    const tm = $('[data-time]', root); if (tm) tm.textContent = `${fmtTime(t)} / ${fmtTime(total())}${playing && Math.abs(rate) !== 1 ? `  ${rate}×` : ''}`;
    if (playing) { const bx = $('.tracks', root), px = HEAD + t * pps; if (px < bx.scrollLeft + HEAD || px > bx.scrollLeft + bx.clientWidth - 30) bx.scrollLeft = Math.max(0, px - HEAD - 40); }
  }
  function tick(now) {
    t += ((now - lastT) / 1000) * rate; lastT = now;
    const T = total();
    if (t >= T && rate > 0) { t = T; stopPlay(); return; }
    if (t <= 0 && rate < 0) { t = 0; stopPlay(); return; }
    paint();
    if (playing) raf = requestAnimationFrame(tick);
  }
  function startPlay(r = 1) {
    if (!total()) return;
    if (r > 0 && t >= total() - 0.02) t = 0;
    rate = r; if (!playing) { playing = true; lastT = performance.now(); raf = requestAnimationFrame(tick); }
    icons();
  }
  function stopPlay() { playing = false; rate = 1; cancelAnimationFrame(raf); icons(); paint(); }
  const playPause = () => (playing ? stopPlay() : startPlay(1));
  function shuttle(dir) {
    if (dir > 0) { if (playing && rate > 0) startPlay(Math.min(4, rate * 2)); else startPlay(1); }
    else if (playing && rate < 0) startPlay(Math.max(-4, rate * 2)); else { if (t <= 0) return; startPlay(-1); }
  }
  function seek(v) { t = clamp(v, 0, total()); if (playing) lastT = performance.now(); paint(); }
  function icons() { const b = $('[data-act=play]', root); if (b) b.innerHTML = playing ? IC.pause : IC.play; }
  async function settle(ms = 6000) {
    const t0 = performance.now();
    for (;;) {
      paint(); await MS.util.sleep(60);
      const busy = [...els.values()].some((e) => (e.tagName === 'VIDEO' && e.src && (e.seeking || e.readyState < 2)) || (e.tagName === 'IMG' && e.src && !e.complete));
      if (!busy || performance.now() - t0 > ms) break;
    }
    await MS.util.sleep(60); paint();
  }

  /* ---------- history, autosave ---------- */
  const resetHist = () => { hist = [JSON.stringify(P)]; hi = 0; lastKey = ''; uiTop(); };
  function changed(key) {
    const s = JSON.stringify(P);
    if (s !== hist[hi]) {
      if (key && key === lastKey && Date.now() - lastAt < 1200 && hi > 0) hist[hi] = s;
      else { hist.length = hi + 1; hist.push(s); if (hist.length > 80) hist.shift(); hi = hist.length - 1; }
      lastKey = key || ''; lastAt = Date.now(); prune();
    }
    autosave(); uiTop();
  }
  function restore(i) {
    hi = i; P = JSON.parse(hist[hi]); if (sel && !find(sel)) sel = null; t = Math.min(t, total());
    autosave(); renderAll();
  }
  const undo = () => { if (hi > 0) restore(hi - 1); };
  const redo = () => { if (hi < hist.length - 1) restore(hi + 1); };
  async function saveNow() {
    if (!P || (isEmpty(P) && !projects.some((p) => p.id === P.id))) return;
    const e = { id: P.id, title: P.title, at: Date.now() }, i = projects.findIndex((p) => p.id === P.id);
    if (i >= 0) projects[i] = e; else projects.push(e);
    try { await MS.db.set('editor.p.' + P.id, JSON.parse(JSON.stringify(P))); await MS.db.set('editor.projects', projects); } catch (err) { console.warn('editor save', err); }
  }
  const autosave = debounce(saveNow, 500);

  /* ---------- projects ---------- */
  async function openProject(id) {
    await saveNow(); stopPlay();
    const p = await MS.db.get('editor.p.' + id);
    if (!p) { MS.ui.toast('That project is gone.', true); return; }
    P = sanitize(p); sel = null; t = 0; setPref('editor.cur', P.id); resetHist(); renderAll();
  }
  async function newProject() { await saveNow(); stopPlay(); P = blank(); sel = null; t = 0; setPref('editor.cur', P.id); resetHist(); renderAll(); }
  async function dupProject(id) {
    await saveNow();
    const p = await MS.db.get('editor.p.' + id); if (!p) return;
    const n = Object.assign({}, p, { id: uid(), title: p.title + ' copy' });
    await MS.db.set('editor.p.' + n.id, n); projects.push({ id: n.id, title: n.title, at: Date.now() }); await MS.db.set('editor.projects', projects);
    await openProject(n.id);
  }
  async function delProject(id) {
    const e = projects.find((p) => p.id === id);
    if (!(await MS.ui.confirmBox('Delete project', `Delete "${e ? e.title : 'this project'}"? Media files are not touched.`, 'Delete', true))) return;
    projects = projects.filter((p) => p.id !== id); await MS.db.del('editor.p.' + id).catch(() => {}); await MS.db.set('editor.projects', projects);
    if (P.id === id) { const n = [...projects].sort((a, b) => b.at - a.at)[0]; if (n) await openProject(n.id); else await newProject(); }
    drawProjects();
  }
  function drawProjects() {
    const box = $('[data-plist]', root); if (box.hidden) return;
    const list = [...projects].sort((a, b) => b.at - a.at);
    box.replaceChildren(h('<h3 class="mb-2">Projects</h3>'));
    if (!list.length) box.append(h('<div class="empty small">Nothing saved yet: projects are saved as you edit.</div>'));
    const l = h('<div class="list"></div>');
    for (const p of list) {
      const it = h(`<div class="item${p.id === P.id ? ' active' : ''}"><div class="grow"><b>${esc(p.title || 'Untitled')}</b> <span class="small dim">${esc(new Date(p.at).toLocaleString())}</span></div><button class="btn sm ghost" data-d title="Duplicate" type="button">Duplicate</button><button class="btn sm ghost danger" data-x title="Delete" type="button">Delete</button></div>`);
      it.onclick = () => { box.hidden = true; if (p.id !== P.id) openProject(p.id); };
      $('[data-d]', it).onclick = (e) => { e.stopPropagation(); box.hidden = true; dupProject(p.id); };
      $('[data-x]', it).onclick = (e) => { e.stopPropagation(); delProject(p.id); };
      l.append(it);
    }
    box.append(l);
  }

  /* ---------- adding media ---------- */
  async function build(ref, track, pos) {
    const inf = await infoOf(ref), k = ref.kind, base = { id: uid(), ref };
    if (track === 'au') {
      if (!inf.dur) throw new Error('no duration');
      return Object.assign(base, { start: r2(pos == null ? t : pos), in: 0, out: r3(inf.dur), srcDur: r3(inf.dur), vol: 1, fadein: 0, fadeout: 0 });
    }
    if (track === 'ov') {
      const s = r2(pos == null ? t : pos);
      return Object.assign(base, { start: s, end: r2(s + 4), x: 0.82, y: 0.2, scale: 0.25, opacity: 1 });
    }
    if (k === 'video') {
      if (!inf.dur) throw new Error('no duration');
      return Object.assign(base, { kind: 'video', in: 0, out: r3(inf.dur), srcDur: r3(inf.dur), xfade: 0, vol: 1, muted: false, fit: 'contain' });
    }
    return Object.assign(base, { kind: k, dur: 3, xfade: 0, fit: 'contain', zoom: false });
  }
  const accepts = (track, ref) => (track === 'v1' ? ['video', 'image', 'gif'] : track === 'ov' ? ['image', 'gif'] : track === 'au' ? ['audio'] : []).includes(ref.kind);
  async function addRefs(refs, track, pos) {
    refs = (refs || []).filter((r) => r && r.ref && ['video', 'image', 'gif', 'audio'].includes(r.kind));
    if (!refs.length) return;
    const wasEmpty = !P.v1.length; let last = null;
    for (const r of refs) if (!P.bin.some((b) => b.ref === r.ref)) P.bin.push(r);
    for (const r of refs) {
      const tr = track || (r.kind === 'audio' ? 'au' : 'v1');
      if (!accepts(tr, r)) { MS.ui.toast(`${r.name} cannot go on that track.`, true); continue; }
      try {
        const it = await build(r, tr, pos);
        if (tr === 'v1') { P.v1.splice(pos == null ? P.v1.length : pos, 0, it); if (pos != null) pos++; }
        else (tr === 'ov' ? P.overlays : P.audio).push(it);
        last = it;
        if (wasEmpty && tr === 'v1' && P.v1.length === 1 && P.w === 1920 && P.h === 1080 && r.kind !== 'audio') {
          const inf = await infoOf(r); if (inf.w && inf.h && inf.h > inf.w * 1.2) { P.w = 1080; P.h = 1920; }
        }
      } catch (e) { MS.ui.toast(`Cannot read ${r.name}.`, true); }
    }
    if (last) sel = last.id;
    changed(); renderAll();
  }
  async function addFromPicker() {
    const refs = await MS.src.choose({ title: 'Add media', kinds: ['video', 'image', 'gif', 'audio'], multiple: true });
    if (refs && refs.length) addRefs(refs);
  }
  function addText() {
    const o = { id: uid(), text: 'Text', start: r2(t), end: r2(t + 3), x: 0.5, y: 0.85, size: Math.round(P.h / 12), color: '#ffffff', weight: 700, shadow: true, fade: 0.3 };
    P.text.push(o); sel = o.id; changed(); renderAll();
  }
  function delSel() {
    const it = cur(); if (!it) return;
    const l = listOf(it); l.splice(l.indexOf(it), 1); sel = null; changed(); renderAll();
  }
  function dupSel() {
    const it = cur(); if (!it) return;
    const n = structuredClone(it); n.id = uid(); const l = listOf(it), ty = typeOf(it);
    if (ty === 'v1') { n.xfade = 0; l.splice(l.indexOf(it) + 1, 0, n); }
    else { const len = ty === 'au' ? adur(it) : it.end - it.start; n.start = r2(it.start + len); if (ty !== 'au') n.end = r2(n.start + len); l.push(n); }
    sel = n.id; changed(); renderAll();
  }
  function split() {
    const L = lay(); let it = cur(), ty = it && typeOf(it);
    const range = (x, y) => (y === 'v1' ? (() => { const k = L.clips.find((c) => c.c === x); return [k.start, k.start + k.d]; })() : y === 'au' ? [num(+x.start, 0), num(+x.start, 0) + adur(x)] : [x.start, x.end]);
    if (!it || !(t > range(it, ty)[0] + 0.05 && t < range(it, ty)[1] - 0.05)) {
      const k = [...L.clips].reverse().find((c) => t > c.start + 0.05 && t < c.start + c.d - 0.05);
      if (!k) { MS.ui.toast('Nothing to split at the playhead.', true); return; }
      it = k.c; ty = 'v1';
    }
    const n = structuredClone(it); n.id = uid(); const l = listOf(it);
    if (ty === 'v1') {
      const k = L.clips.find((c) => c.c === it), local = t - k.start;
      if (it.kind === 'video') { n.in = r3(num(+it.in, 0) + local); it.out = n.in; } else { n.dur = r3(k.d - local); it.dur = r3(local); }
      it.xfade = 0;
    } else if (ty === 'au') { it.out = r3(num(+it.in, 0) + (t - it.start)); n.in = it.out; n.start = r2(t); n.fadein = 0; it.fadeout = 0; }
    else { n.start = r2(t); it.end = n.start; n.fade = it.fade; }
    l.splice(l.indexOf(it) + 1, 0, n); sel = n.id; changed(); renderAll();
  }
  function exportProject() {
    if (!P.v1.length) { MS.ui.toast('Add at least one clip to V1 first.', true); return; }
    stopPlay();
    const p = structuredClone(P); delete p.bin;
    const T = total();
    MS.queue.add({ type: 'video', name: P.title, title: `${P.title} · ${P.w}×${P.h} ${P.fps} fps · ${fmtTime(T)}`, params: { project: p } });
    MS.ui.toast('Added to the export queue.', false, { label: 'Open Exporter', fn: () => MS.go('export') });
  }

  /* ---------- stage ---------- */
  function setupStage() {
    const k = Math.min(1, 960 / Math.max(P.w, P.h)), w = Math.round(P.w * k), hh = Math.round(P.h * k);
    if (cv.width !== w || cv.height !== hh) { cv.width = w; cv.height = hh; }
    const st = $('.ed-stage', root); st.style.aspectRatio = `${P.w} / ${P.h}`; st.style.width = `min(100%, ${(42 * P.w / P.h).toFixed(2)}vh)`;
  }
  function stageDown(ev) {
    if (ev.button) return;
    const r = cv.getBoundingClientRect(), p = [(ev.clientX - r.left) * cv.width / r.width, (ev.clientY - r.top) * cv.height / r.height];
    const s = cur(), hb = s && hits.find((o) => o.it === s);
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    if (hb && hb.ov && Math.abs(p[0] - (hb.x + hb.w)) < 14 && Math.abs(p[1] - (hb.y + hb.h)) < 14) {
      ev.stopPropagation(); const o0 = hb.it.scale;
      return drag(ev, (pev, dx) => { hb.it.scale = clamp(r3(o0 + (2 * dx) / r.width), 0.02, 1); paint(); }, (m) => { if (m) { changed(); drawInsp(); } });
    }
    const hit = [...hits].reverse().find((o) => p[0] >= o.x && p[0] <= o.x + o.w && p[1] >= o.y && p[1] <= o.y + o.h);
    if (!hit) { if (sel) { sel = null; markSel(); drawInsp(); paint(); } return; }
    ev.stopPropagation();
    const it = hit.it, o = { x: it.x, y: it.y };
    sel = it.id; markSel(); drawInsp(); paint();
    drag(ev, (pev, dx, dy) => {
      let nx = clamp(o.x + dx / r.width, 0, 1), ny = clamp(o.y + dy / r.height, 0, 1);
      if (Math.abs(nx - 0.5) < 0.015) nx = 0.5;
      if (Math.abs(ny - 0.5) < 0.015) ny = 0.5;
      it.x = r3(nx); it.y = r3(ny); paint();
    }, (m) => { if (m) { changed(); drawInsp(); } });
  }

  /* ---------- pointer drags ---------- */
  function drag(ev, move, end) {
    ev.preventDefault(); const x0 = ev.clientX, y0 = ev.clientY; let moved = false;
    const mv = (e) => { const dx = e.clientX - x0, dy = e.clientY - y0; if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return; moved = true; move(e, dx, dy); };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); end && end(moved); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  }
  const tlX = (ev) => (ev.clientX - tl.getBoundingClientRect().left - HEAD) / pps;
  function edges(skip) {
    const e = [0, t];
    for (const { c, start, d } of lay().clips) if (c.id !== skip) e.push(start, start + d);
    for (const o of [...P.text, ...P.overlays]) if (o.id !== skip) e.push(o.start, o.end);
    for (const a of P.audio) if (a.id !== skip) e.push(num(+a.start, 0), num(+a.start, 0) + adur(a));
    return e;
  }
  function snapper(skip, off) {
    const c = snapOn && !off ? edges(skip) : [], thr = 8 / pps;
    const best = (v) => { let b = null, bd = thr; for (const e of c) if (Math.abs(e - v) < bd) { bd = Math.abs(e - v); b = e; } return b; };
    const show = (v) => { if (snapLine) { snapLine.style.display = v == null ? 'none' : ''; if (v != null) snapLine.style.left = HEAD + v * pps + 'px'; } };
    return { one: (v) => { const b = best(v); show(b); return b == null ? v : b; },
      move: (s, len) => { const a = best(s), b = best(s + len); const da = a == null ? 1e9 : Math.abs(a - s), db = b == null ? 1e9 : Math.abs(b - s - len); show(da <= db ? a : b); return a == null && b == null ? s : da <= db ? a : b - len; } };
  }
  function clipDown(ev, it, ty, hd, el) {
    if (ev.button) return;
    sel = it.id; markSel(); drawInsp(); paint();
    const o = structuredClone(it), sn = snapper(it.id, ev.shiftKey);
    const L = lay(), k0 = L.clips.find((c) => c.c === it), s0 = k0 ? k0.start : 0;
    let ni = -1;
    drag(ev, (pev, dx) => {
      const dt = dx / pps;
      if (ty === 'v1') {
        if (hd === 'r') {
          const nd = Math.max(0.2, sn.one(s0 + cdur(o) + dt) - s0);
          if (it.kind === 'video') it.out = r3(clamp(num(+o.in, 0) + nd, num(+o.in, 0) + 0.1, it.srcDur || 1e9)); else it.dur = r3(nd);
        } else if (hd === 'l') {
          if (it.kind === 'video') it.in = r3(clamp(num(+o.in, 0) + dt, 0, num(+o.out, 0) - 0.1)); else it.dur = r3(Math.max(0.2, o.dur - dt));
        } else {
          const mids = L.clips.map((c) => c.start + c.d / 2), i0 = L.clips.indexOf(k0), center = mids[i0] + dt;
          ni = mids.filter((m, j) => j !== i0 && m < center).length;
          el.classList.add('dragging'); el.style.transform = `translateX(${dt * pps}px)`;
          const others = L.clips.filter((c) => c !== k0), bx = ni === 0 ? 0 : others[ni - 1].start + others[ni - 1].d;
          if (tl) { let dl = $('.ed-drop', tl); if (!dl) { dl = h('<div class="ed-drop"></div>'); tl.append(dl); } dl.style.left = HEAD + bx * pps + 'px'; }
          return;
        }
      } else if (ty === 'au') {
        const len = adur(o), st = num(+o.start, 0);
        if (hd === 'r') { const nl = Math.max(0.1, sn.one(st + len + dt) - st); it.out = r3(clamp(num(+o.in, 0) + nl, num(+o.in, 0) + 0.1, it.srcDur || 1e9)); }
        else if (hd === 'l') {
          let dl = sn.one(st + dt) - st; dl = clamp(dl, Math.max(-num(+o.in, 0), -st), num(+o.out, 0) - 0.1 - num(+o.in, 0));
          it.in = r3(num(+o.in, 0) + dl); it.start = r2(st + dl);
        } else it.start = r2(Math.max(0, sn.move(st + dt, len)));
      } else {
        const len = o.end - o.start;
        if (hd === 'r') it.end = r2(Math.max(o.start + 0.2, sn.one(o.end + dt)));
        else if (hd === 'l') it.start = r2(clamp(sn.one(o.start + dt), 0, o.end - 0.2));
        else { it.start = r2(Math.max(0, sn.move(o.start + dt, len))); it.end = r2(it.start + len); }
      }
      drawTL(); paint();
    }, (moved) => {
      if (snapLine) snapLine.style.display = 'none';
      if (moved && ty === 'v1' && !hd) {
        const i0 = P.v1.indexOf(it); if (ni >= 0 && ni !== i0) { P.v1.splice(i0, 1); P.v1.splice(ni, 0, it); }
      }
      if (moved) changed(); drawTL(); drawInsp(); paint();
    });
  }
  function scrub(ev) {
    seek(tlX(ev));
    drag(ev, (pev) => seek(tlX(pev)), null);
    const mv = (e) => seek(tlX(e));
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  }

  /* ---------- timeline ---------- */
  function pack(list, st, en) {
    const ends = [], row = new Map();
    [...list].sort((a, b) => st(a) - st(b)).forEach((it) => {
      let r = ends.findIndex((e) => e <= st(it) + 1e-6); if (r < 0) { r = ends.length; ends.push(0); }
      ends[r] = en(it); row.set(it, r);
    });
    return { row, n: Math.max(1, ends.length) };
  }
  function drawTL() {
    const box = $('.tracks', root), sx = box.scrollLeft, L = lay(), T = L.total;
    const W = Math.max(box.clientWidth - HEAD - 24, (T + 6) * pps);
    tl = h(`<div class="ed-tl" style="width:${HEAD + W}px"></div>`);
    const ruler = h(`<div class="ruler" style="width:${W}px"></div>`);
    const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300], step = steps.find((s) => s * pps >= 64) || 300;
    for (let s = 0; s <= W / pps; s += step) { const v = r3(s); ruler.append(h(`<i style="left:${v * pps}px">${v < 60 ? v + 's' : Math.floor(v / 60) + ':' + String(Math.round(v % 60)).padStart(2, '0')}</i>`)); }
    ruler.onpointerdown = (ev) => { if (!ev.button) { sel = null; markSel(); drawInsp(); scrub(ev); } };
    tl.append(ruler);
    const lane = (name, track, n) => {
      const row = h(`<div class="track"><div class="tname">${name}</div><div class="lane" data-track="${track}" style="width:${W}px;height:${n * LANE}px"></div></div>`), ln = $('.lane', row);
      ln.onpointerdown = (ev) => { if (ev.target === ln && !ev.button) { sel = null; markSel(); drawInsp(); paint(); scrub(ev); } };
      ln.ondragover = (ev) => { if (dragRef && accepts(track, dragRef)) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; ln.classList.add('drop'); } };
      ln.ondragleave = () => ln.classList.remove('drop');
      ln.ondrop = (ev) => {
        ln.classList.remove('drop'); if (!dragRef || !accepts(track, dragRef)) return;
        ev.preventDefault(); ev.stopPropagation();
        const tm = Math.max(0, tlX(ev)), ref = dragRef; dragRef = null;
        if (track === 'v1') addRefs([ref], 'v1', lay().clips.filter((c) => c.start + c.d / 2 < tm).length);
        else addRefs([ref], track, r2(tm));
      };
      tl.append(row); return ln;
    };
    const mk = (it, ty, start, d, label, row) => {
      const cls = { v1: 'v', text: 't', ov: 'o', au: 'a' }[ty];
      const e = h(`<div class="clip ${cls}${sel === it.id ? ' sel' : ''}" data-id="${it.id}" style="left:${start * pps}px;width:${Math.max(8, d * pps)}px;top:${row * LANE + 5}px" title="${esc(label)}"><div class="h l"></div><span>${esc(label)}</span><div class="h r"></div></div>`);
      if (it.ref && ty !== 'au') thumbOf(it.ref, (u) => { e.style.backgroundImage = `linear-gradient(rgba(0,0,0,.35),rgba(0,0,0,.35)),url("${u}")`; });
      if (ty === 'au') {
        const fi = num(+it.fadein, 0), fo = num(+it.fadeout, 0);
        if (fi > 0) e.append(h(`<i class="fi" style="width:${fi * pps}px"></i>`)); if (fo > 0) e.append(h(`<i class="fo" style="width:${fo * pps}px"></i>`));
      }
      e.onpointerdown = (ev) => clipDown(ev, it, ty, ev.target.classList.contains('h') ? (ev.target.classList.contains('l') ? 'l' : 'r') : null, e);
      return e;
    };
    const v1 = lane('V1', 'v1', 1);
    L.clips.forEach(({ c, start, d, xf }, i) => {
      v1.append(mk(c, 'v1', start, d, `${c.ref.name}  ${d.toFixed(1)}s`, 0));
      if (i) {
        if (xf > 0) v1.append(h(`<div class="ed-xf" style="left:${start * pps}px;width:${xf * pps}px"></div>`));
        const hdl = h(`<div class="ed-xh" style="left:${start * pps}px" title="Crossfade ${xf.toFixed(2)} s: drag left to lengthen, double-click to clear"></div>`), prev = L.clips[i - 1].c;
        hdl.ondblclick = () => { prev.xfade = 0; changed(); drawTL(); drawInsp(); paint(); };
        hdl.onpointerdown = (ev) => {
          if (ev.button) return; ev.stopPropagation(); sel = prev.id; markSel(); drawInsp();
          const x0 = num(+prev.xfade, 0), mx = Math.min(d / 2, L.clips[i - 1].d / 2);
          drag(ev, (pev, dx) => { prev.xfade = r2(clamp(x0 - dx / pps, 0, mx)); drawTL(); paint(); }, (m) => { if (m) { changed(); drawInsp(); } });
        };
        v1.append(hdl);
      }
    });
    const free = (name, track, ty, list, st, en, lab) => {
      const pk = pack(list, st, en), ln = lane(name, track, pk.n);
      for (const it of list) ln.append(mk(it, ty, st(it), en(it) - st(it), lab(it), pk.row.get(it)));
    };
    free('T', 'text', 'text', P.text, (x) => x.start, (x) => x.end, (x) => x.text || 'Text');
    free('O', 'ov', 'ov', P.overlays, (x) => x.start, (x) => x.end, (x) => x.ref.name);
    free('A', 'au', 'au', P.audio, (x) => num(+x.start, 0), (x) => num(+x.start, 0) + adur(x), (x) => x.ref.name);
    tl.append(h(`<div class="playhead ed-ph" style="left:${HEAD + t * pps}px"></div>`));
    snapLine = h('<div class="ed-snap" style="display:none"></div>'); tl.append(snapLine);
    box.replaceChildren(tl); box.scrollLeft = sx;
  }
  const markSel = () => $$('.ed-tl .clip', root).forEach((e) => e.classList.toggle('sel', e.dataset.id === sel));
  function setPps(v, atX = 0) {
    const box = $('.tracks', root), old = pps, tAt = (box.scrollLeft + atX - HEAD) / old;
    pps = clamp(Math.round(v), 8, 400); setPref('editor.pps', pps); $('[data-zoom]', root).value = pps; drawTL(); box.scrollLeft = Math.max(0, tAt * pps + HEAD - atX);
  }

  /* ---------- bin ---------- */
  function drawBin() {
    const g = $('[data-bin]', root); g.replaceChildren();
    if (!P.bin.length) g.append(h('<div class="empty small" style="grid-column:1/-1">Your media will show here.</div>'));
    for (const ref of P.bin) {
      const tile = MS.ui.tile(ref, {}); tile.draggable = true;
      tile.append(h('<button class="x" type="button" title="Remove from the bin">×</button>'));
      $('.x', tile).onclick = (e) => { e.stopPropagation(); P.bin = P.bin.filter((b) => b.ref !== ref.ref); changed(); drawBin(); };
      tile.ondragstart = (e) => { dragRef = ref; e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('text/plain', ref.name); };
      tile.ondragend = () => { dragRef = null; };
      tile.ondblclick = () => addRefs([ref]);
      g.append(tile);
    }
  }

  /* ---------- inspector ---------- */
  function apply(fn, key) { fn(); changed(key); drawTL(); paint(); syncs.forEach((s) => s()); drawTop(); }
  function field(label, input, sync) { const f = h(`<div class="field"><label class="lab">${label}</label></div>`); f.append(input); if (sync) { syncs.push(sync); sync(); } return f; }
  function fnum(label, get, set, o = {}) {
    const i = h(`<input class="input num" type="number" step="${o.step || 0.1}"${o.min != null ? ` min="${o.min}"` : ''}${o.max != null ? ` max="${o.max}"` : ''}>`);
    const sync = () => { i.value = r3(num(+get(), 0)); };
    i.onchange = () => { if (i.value !== '' && isFinite(+i.value)) apply(() => set(+i.value)); else sync(); };
    return field(label, i, sync);
  }
  function frange(label, get, set, min, max, step, fmt) {
    const i = h(`<input type="range" min="${min}" max="${max}" step="${step}">`), f = h(`<div class="field"><label class="lab"><span>${label}</span><span class="num dim" data-v></span></label></div>`), v = $('[data-v]', f);
    const sync = () => { i.value = num(+get(), 0); v.textContent = fmt(+i.value); };
    i.oninput = () => apply(() => set(+i.value), label); f.append(i); syncs.push(sync); sync(); return f;
  }
  function fcheck(label, get, set) {
    const f = h(`<label class="check field"><input type="checkbox"> ${label}</label>`), i = $('input', f);
    const sync = () => { i.checked = !!get(); }; i.onchange = () => apply(() => set(i.checked)); syncs.push(sync); sync(); return f;
  }
  function fseg(label, opts, get, set) {
    const e = h('<div></div>'), s = MS.ui.seg(e, opts, get(), (v) => apply(() => set(v)));
    return field(label, e, () => s.set(get()));
  }
  const two = (...fs) => { const d = h('<div class="two"></div>'); fs.forEach((f) => d.append(f)); return d; };
  const pct = (v) => Math.round(v * 100) + '%', sec = (v) => r2(v) + ' s';
  function drawInsp() {
    const box = $('[data-insp]', root); syncs = []; box.replaceChildren();
    const it = cur();
    if (!it) {
      box.append(h('<h3>Project</h3>'));
      const ti = h('<input class="input">'); ti.value = P.title; ti.oninput = () => { P.title = ti.value; $('[data-title]', root).value = P.title; changed('title'); };
      box.append(field('Title', ti));
      const size = h('<div class="ed-size"></div>'), ss = MS.ui.seg(size, SIZES, `${P.w}x${P.h}`, (v) => {
        const [w, hh] = v.split('x').map(Number), f = hh / P.h; P.w = w; P.text.forEach((x) => { x.size = Math.round(num(+x.size, 48) * f); }); P.h = hh; changed(); setupStage(); drawTL(); paint();
      });
      box.append(field('Size', size));
      const fps = h('<div></div>'); MS.ui.seg(fps, [['30 fps', 30], ['60 fps', 60]], P.fps, (v) => { P.fps = v; changed(); drawTop(); }); box.append(field('Frame rate', fps));
      const q = h('<div></div>'); MS.ui.seg(q, [['High', 'high'], ['Medium', 'medium'], ['Small', 'small']], P.quality, (v) => { P.quality = v; changed(); }); box.append(field('Quality', q));
      box.append(h(`<p class="hint">${P.v1.length} clip${P.v1.length === 1 ? '' : 's'} · ${fmtTime(total())} · ${P.w}×${P.h}. Select an item on the timeline to edit it.</p>`));
      const del = h('<button class="btn sm danger mt-2" type="button">Delete project</button>'); del.onclick = () => delProject(P.id); box.append(del);
      void ss; return;
    }
    const ty = typeOf(it), L = lay();
    box.append(h(`<h3>${{ v1: it.kind === 'video' ? 'Video clip' : it.kind === 'gif' ? 'GIF' : 'Image', text: 'Text', ov: 'Overlay', au: 'Audio' }[ty]}${it.ref ? ` <span class="small dim">${esc(it.ref.name)}</span>` : ''}</h3>`));
    if (ty === 'v1') {
      if (it.kind === 'video') {
        box.append(two(fnum('In (s)', () => it.in, (v) => { it.in = r3(clamp(v, 0, num(+it.out, 0) - 0.1)); }), fnum('Out (s)', () => it.out, (v) => { it.out = r3(clamp(v, num(+it.in, 0) + 0.1, it.srcDur || 1e9)); })));
        box.append(frange('Volume', () => it.vol ?? 1, (v) => { it.vol = v; }, 0, 2, 0.05, pct), fcheck('Mute', () => it.muted, (v) => { it.muted = v; }));
      } else box.append(fnum('Duration (s)', () => it.dur, (v) => { it.dur = r3(Math.max(0.2, v)); }));
      box.append(fnum('Crossfade into next (s)', () => it.xfade, (v) => { it.xfade = r2(Math.max(0, v)); }, { min: 0 }));
      box.append(fseg('Fit', [['Contain', 'contain'], ['Cover', 'cover']], () => it.fit || 'contain', (v) => { it.fit = v; }));
      if (it.kind === 'image') box.append(fcheck('Slow push-in', () => it.zoom, (v) => { it.zoom = v; }));
      box.append(h(`<p class="hint">Starts at ${fmtTime(L.clips.find((c) => c.c === it).start)} · ${fmtTime(cdur(it))} long.</p>`));
    } else if (ty === 'text') {
      const ta = h('<textarea class="input" rows="2"></textarea>'), tsync = () => { if (document.activeElement !== ta) ta.value = it.text || ''; };
      ta.oninput = () => apply(() => { it.text = ta.value; }, 'text'); box.append(field('Text', ta, tsync));
      box.append(two(fnum('Size (px)', () => it.size, (v) => { it.size = Math.max(8, Math.round(v)); }, { step: 1, min: 8 }), field('Color', Object.assign(h('<input type="color">'), {}), null)));
      const col = $('input[type=color]', box); col.value = it.color || '#ffffff'; col.oninput = () => apply(() => { it.color = col.value; }, 'color');
      box.append(fseg('Weight', [['Regular', 400], ['Bold', 700]], () => it.weight || 700, (v) => { it.weight = v; }), two(fcheck('Shadow', () => it.shadow, (v) => { it.shadow = v; }), fnum('Fade (s)', () => it.fade, (v) => { it.fade = r2(Math.max(0, v)); }, { min: 0 })));
      box.append(two(fnum('Start (s)', () => it.start, (v) => { const len = it.end - it.start; it.start = r2(Math.max(0, v)); it.end = r2(it.start + len); }), fnum('End (s)', () => it.end, (v) => { it.end = r2(Math.max(it.start + 0.2, v)); })));
      box.append(two(fnum('X (0–1)', () => it.x, (v) => { it.x = clamp(v, 0, 1); }, { step: 0.01, min: 0, max: 1 }), fnum('Y (0–1)', () => it.y, (v) => { it.y = clamp(v, 0, 1); }, { step: 0.01, min: 0, max: 1 })));
    } else if (ty === 'ov') {
      box.append(two(fnum('Start (s)', () => it.start, (v) => { const len = it.end - it.start; it.start = r2(Math.max(0, v)); it.end = r2(it.start + len); }), fnum('End (s)', () => it.end, (v) => { it.end = r2(Math.max(it.start + 0.2, v)); })));
      box.append(two(fnum('X (0–1)', () => it.x, (v) => { it.x = clamp(v, 0, 1); }, { step: 0.01, min: 0, max: 1 }), fnum('Y (0–1)', () => it.y, (v) => { it.y = clamp(v, 0, 1); }, { step: 0.01, min: 0, max: 1 })));
      box.append(frange('Size', () => it.scale, (v) => { it.scale = v; }, 0.02, 1, 0.01, pct), frange('Opacity', () => it.opacity ?? 1, (v) => { it.opacity = v; }, 0, 1, 0.05, pct));
    } else {
      box.append(two(fnum('Starts at (s)', () => it.start, (v) => { it.start = r2(Math.max(0, v)); }), frange('Volume', () => it.vol ?? 1, (v) => { it.vol = v; }, 0, 2, 0.05, pct)));
      box.append(two(fnum('In (s)', () => it.in, (v) => { it.in = r3(clamp(v, 0, num(+it.out, 0) - 0.1)); }), fnum('Out (s)', () => it.out, (v) => { it.out = r3(clamp(v, num(+it.in, 0) + 0.1, it.srcDur || 1e9)); })));
      box.append(two(fnum('Fade in (s)', () => it.fadein, (v) => { it.fadein = r2(Math.max(0, v)); }, { min: 0 }), fnum('Fade out (s)', () => it.fadeout, (v) => { it.fadeout = r2(Math.max(0, v)); }, { min: 0 })));
    }
    const row = h('<div class="actions"><button class="btn sm" data-dup type="button">Duplicate</button><button class="btn sm danger" data-del type="button">Delete</button></div>');
    $('[data-dup]', row).onclick = dupSel; $('[data-del]', row).onclick = delSel; box.append(row);
  }

  /* ---------- top bar, whole redraw ---------- */
  function uiTop() {
    if (!root) return;
    const u = $('[data-act=undo]', root), r = $('[data-act=redo]', root), x = $('[data-act=export]', root);
    if (u) u.disabled = hi <= 0; if (r) r.disabled = hi >= hist.length - 1; if (x) x.disabled = !P.v1.length;
  }
  function drawTop() {
    const ti = $('[data-title]', root); if (document.activeElement !== ti) ti.value = P.title;
    const e = $('.ed-empty', root); e.hidden = !isEmpty(P) ? true : false;
    if (!e.hidden) e.hidden = !!(P.v1.length || P.text.length || P.overlays.length || P.audio.length);
    $('[data-res]', root).textContent = `${P.w}×${P.h} · ${P.fps} fps`; uiTop(); drawProjects();
  }
  function renderAll() { setupStage(); drawBin(); drawTL(); drawInsp(); drawTop(); icons(); paint(); }

  /* ---------- tab ---------- */
  const MARKUP = `
<div class="page-head"><div><h2>Editor</h2><p>Cut clips, add text, overlays and audio, then export an MP4.</p></div>
  <div class="row"><input class="input ed-title" data-title placeholder="Project title" aria-label="Project title">
    <button class="btn" data-act="projects" type="button">Projects</button><button class="btn" data-act="new" type="button">New</button>
    <button class="btn primary" data-act="export" type="button">Export</button></div></div>
<div class="card ed-projects" data-plist hidden></div>
<div class="ed-main">
  <div class="card ed-binbox"><button class="btn sm primary" style="width:100%" data-act="add" type="button">Add media…</button><div class="ed-bin" data-bin></div>
    <p class="hint">Double-click adds to the timeline, or drag a tile to a track. Ctrl+V pastes.</p></div>
  <div><div class="ed-view"><div class="ed-stage"><canvas></canvas><div class="ed-empty"><div>Add clips from the library, from disk or paste them</div><button class="btn primary" data-act="add" type="button">Add media…</button></div></div></div>
    <div class="transport"><button class="btn icon-btn ghost" data-act="home" title="Start (Home)" type="button">${IC.home}</button><button class="btn icon-btn ghost" data-act="prev" title="Back one frame (←)" type="button">${IC.prev}</button>
      <button class="btn icon-btn" data-act="play" title="Play / pause (Space)" type="button">${IC.play}</button>
      <button class="btn icon-btn ghost" data-act="next" title="Forward one frame (→)" type="button">${IC.next}</button><button class="btn icon-btn ghost" data-act="end" title="End (End)" type="button">${IC.end}</button>
      <span class="num" data-time>0:00.00 / 0:00.00</span><span class="grow"></span><span class="small dim num" data-res></span></div></div>
  <div class="card ed-insp props" data-insp></div>
</div>
<div class="ed-tools"><button class="btn sm" data-act="text" type="button">${IC.text} Add text</button><button class="btn sm" data-act="split" type="button">${IC.split} Split</button>
  <button class="btn sm" data-act="del" type="button">${IC.trash} Delete</button><span class="sep"></span>
  <button class="btn sm icon-btn ghost" data-act="undo" title="Undo (Ctrl+Z)" type="button">${IC.undo}</button><button class="btn sm icon-btn ghost" data-act="redo" title="Redo (Ctrl+Shift+Z)" type="button">${IC.redo}</button>
  <span class="grow"></span><label class="check small"><input type="checkbox" data-snap> Snap</label>
  <span class="small dim">Zoom</span><input type="range" min="8" max="400" data-zoom aria-label="Timeline zoom"><button class="btn sm ghost" data-act="fit" title="Fit the timeline" type="button">${IC.fit}</button></div>
<div class="tracks" data-tracks></div>
<p class="hint"><kbd>Space</kbd> play · <kbd>J</kbd> <kbd>K</kbd> <kbd>L</kbd> shuttle · <kbd>S</kbd> split · <kbd>T</kbd> text · <kbd>Del</kbd> delete · drag edges to trim · drag the handle between clips for a crossfade · <kbd>Ctrl</kbd>+wheel zooms the timeline</p>`;

  function injectCss() { if (!document.getElementById('ed-css')) document.head.append(Object.assign(document.createElement('style'), { id: 'ed-css', textContent: CSS })); }
  const ACTS = {
    projects() { const b = $('[data-plist]', root); b.hidden = !b.hidden; drawProjects(); }, new: newProject, export: exportProject, add: addFromPicker,
    home: () => seek(0), end: () => seek(total()), prev: () => { stopPlay(); seek(t - 1 / P.fps); }, next: () => { stopPlay(); seek(t + 1 / P.fps); },
    play: playPause, text: addText, split, del: delSel, undo, redo,
    fit() { setPps(($('.tracks', root).clientWidth - HEAD - 30) / Math.max(1, total() + 0.5), 0); $('.tracks', root).scrollLeft = 0; },
  };

  async function mount(el) {
    root = el; injectCss(); el.innerHTML = MARKUP; cv = $('canvas', el);
    $$('[data-act]', el).forEach((b) => { b.onclick = () => ACTS[b.dataset.act](); });
    $('[data-title]', el).oninput = (e) => { P.title = e.target.value; changed('title'); };
    const z = $('[data-zoom]', el); z.value = pps; z.oninput = () => setPps(+z.value, 100);
    const sn = $('[data-snap]', el); sn.checked = snapOn; sn.onchange = () => { snapOn = sn.checked; setPref('editor.snap', snapOn); };
    const tr = $('.tracks', el);
    tr.addEventListener('wheel', (e) => { if (!e.ctrlKey) return; e.preventDefault(); setPps(pps * Math.exp(-e.deltaY * 0.002), e.clientX - tr.getBoundingClientRect().left); }, { passive: false });
    cv.addEventListener('pointerdown', stageDown);
    if (MS.ui.zoomable) MS.ui.zoomable($('.ed-stage', el), cv, { pan: 'none' });
    el.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
    el.addEventListener('drop', (e) => { const fs = MS.src.filesOf(e.dataTransfer); if (fs.length) { e.preventDefault(); MS.src.fromFiles(fs).then((r) => addRefs(r)); } });
    addEventListener('pagehide', () => { saveNow(); });
    try { projects = (await MS.db.get('editor.projects')) || []; } catch (e) { projects = []; }
    const id = pref('editor.cur', null), want = projects.find((p) => p.id === id) || [...projects].sort((a, b) => b.at - a.at)[0];
    let p = null; if (want) { try { p = await MS.db.get('editor.p.' + want.id); } catch (e) { p = null; } }
    P = p ? sanitize(p) : blank(); setPref('editor.cur', P.id); resetHist(); renderAll(); readyRes();
  }
  async function show(arg) {
    await ready;
    if (arg && arg.refs && arg.refs.length) await addRefs(arg.refs);
    else { drawTL(); paint(); }
  }
  function hide() { stopPlay(); saveNow(); }
  async function onPaste(files) {
    await ready; const refs = await MS.src.fromFiles(files);
    if (refs.length) { await addRefs(refs); MS.ui.toast(`Added ${refs.length} file${refs.length === 1 ? '' : 's'}.`); } else MS.ui.toast('Nothing usable in that paste.', true);
  }
  function onKey(e) {
    const k = e.key, lk = k.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (mod && k === 'Enter') { e.preventDefault(); exportProject(); return; }
    if (e.altKey || (e.target && e.target.closest && e.target.closest('input, textarea, select, [contenteditable]'))) return;
    let ok = true;
    if (mod) { if (lk === 'z') (e.shiftKey ? redo : undo)(); else if (lk === 'y') redo(); else ok = false; }
    else if (k === ' ') playPause();
    else if (lk === 'k') stopPlay();
    else if (lk === 'l') shuttle(1);
    else if (lk === 'j') shuttle(-1);
    else if (lk === 's') split();
    else if (lk === 't') addText();
    else if (k === 'Delete' || k === 'Backspace') delSel();
    else if (k === 'ArrowLeft' || k === 'ArrowRight') { stopPlay(); seek(t + (k === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 1 : 1 / P.fps)); }
    else if (k === 'Home') seek(0);
    else if (k === 'End') seek(total());
    else ok = false;
    if (ok) e.preventDefault();
  }

  /* ---------- export runner (registered at load: a persisted job runs even if this tab never mounted) ---------- */
  MS.queue.runner('video', async (job, ctx) => {
    const proj = job.params.project;
    const r = await MS.render.project(proj, { files: (ref) => MS.src.file(ref), onProgress: ctx.progress, signal: ctx.signal, quality: proj.quality });
    return { blob: r.blob, ext: 'mp4', label: r.label };
  });

  MS.tab({
    id: 'editor', label: 'Editor', order: 4, icon: ICON, mount, show, hide, onKey, onPaste,
    keys: [
      { k: 'Space', d: 'Play / pause' }, { k: 'J K L', d: 'Shuttle back / stop / forward (press again for 2×, 4×)' }, { k: '← →', d: 'One frame (Shift: 1 s)' }, { k: 'Home End', d: 'Start / end' },
      { k: 'S', d: 'Split at the playhead' }, { k: 'T', d: 'Add text' }, { k: 'Del', d: 'Delete the selected item' }, { k: 'Ctrl Z', d: 'Undo (Ctrl Shift Z: redo)' },
      { k: 'Ctrl Enter', d: 'Export' }, { k: 'Ctrl wheel', d: 'Zoom the timeline (over it)' },
    ],
    claims: ['j', 'k', 'l', 's', 't', ' ', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Delete', 'Backspace'],
    hotkeys: [{ sel: '[data-act=play]', k: 'Space' }, { sel: '[data-act=split]', k: 'S' }, { sel: '[data-act=text]', k: 'T' }, { sel: '[data-act=del]', k: 'Del' }, { sel: '[data-act=export]', k: 'Ctrl+⏎' }],
  });

  /* test hook */
  MS.editor = {
    get project() { return P; }, get time() { return t; }, get sel() { return sel; }, get hist() { return [hi, hist.length]; },
    seek: async (v) => { seek(v); await settle(); }, select(id) { sel = id; markSel(); drawInsp(); paint(); }, changed, undo, redo, split, addText, delSel, addRefs, settle, renderAll, exportProject,
  };
})();
