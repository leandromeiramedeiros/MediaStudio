/* GIF: watch clips from the keyboard, mark takes with I/O named from the shot list, export each take as a Nexus GIF (640×360, 15 fps,
   under 8 MB). Nothing is written here: "Export" hands the takes to the Exporter queue (runner 'gif'). State per library folder in MS.db. */
(() => {
  const { $, $$, h, esc, clamp, fmtTime, fmtBytes, debounce, on, uid } = MS.util;
  const SPEEDS = [1, 2, 4];
  const blank = () => ({ shots: [], takes: [], reviewed: [], last: null, speed: 1, ext: [] });

  let root, video, S = blank(), dbKey = null, curRef = null, selTake = null, markIn = null, loadTok = 0, broken = false, loadedFor = null;
  const clipEls = new Map(), metaCache = new Map();

  const CSS = `
.gif-wrap { display: grid; grid-template-columns: 250px minmax(0, 1fr) 350px; gap: 14px; align-items: start; }
@media (max-width: 1250px) { .gif-wrap { grid-template-columns: 220px minmax(0, 1fr); } .gif-side { grid-column: 1 / -1; } }
@media (max-width: 820px) { .gif-wrap { grid-template-columns: 1fr; } }
.gif-clips { position: sticky; top: 14px; padding: 10px; max-height: calc(100vh - 120px); display: flex; flex-direction: column; }
.gif-clips .list { overflow: auto; min-height: 0; padding: 2px; margin: -2px; gap: 4px; }
.gif-clip { display: flex; gap: 9px; align-items: center; padding: 5px; border: 1px solid transparent; border-radius: var(--r-sm); cursor: pointer; position: relative; transition: background-color .2s var(--ease), border-color .2s var(--ease), transform .4s var(--spring); }
.gif-clip:hover { background: var(--surface-2); }
.gif-clip:active { transform: scale(.98); transition-duration: .09s; }
.gif-clip.active { border-color: var(--accent); background: var(--accent-soft); }
.gif-clip .th { width: 64px; height: 38px; flex: none; border-radius: 5px; overflow: hidden; background: var(--screen); }
.gif-clip .th img { width: 100%; height: 100%; object-fit: cover; display: block; }
.gif-clip .tx { min-width: 0; flex: 1; font-size: 12px; line-height: 1.35; }
.gif-clip .tx b { display: block; font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gif-clip .tx span { color: var(--ink-3); font: 500 11px var(--f-mono); }
.gif-clip .mk { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; font: 600 10.5px/1.2 var(--f-mono); }
.gif-clip .mk .ok { color: var(--ok); }
.gif-clip .mk .tk { background: var(--mark-soft); color: var(--mark); padding: 1px 5px; border-radius: 4px; }
.gif-clip .x { position: absolute; top: 2px; right: 2px; opacity: 0; padding: 0 5px; line-height: 1.5; }
.gif-clip:hover .x { opacity: 1; }
.gif-stage { position: relative; }
.gif-stage .viewer video { cursor: pointer; min-height: 220px; }
.gif-stage .gif-msg { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; gap: 4px; padding: 20px; background: var(--screen); color: var(--ink-2); }
.gif-stage .gif-msg b { color: var(--ink); font: 650 15px var(--f-display); }
.gif-stage .gif-msg[hidden] { display: none; }
.gif-top { display: flex; gap: 8px; align-items: center; margin: 0 0 8px; min-height: 28px; }
.gif-top .nm { font: 600 13px var(--f-display); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gif-top .info { color: var(--ink-3); font: 500 11.5px var(--f-mono); white-space: nowrap; }
.gif-side textarea { resize: vertical; }
.tk-row { padding: 8px 10px 8px 12px; align-items: flex-start; }
.tk-row .tn { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.tk-row .tn b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tk-row .grow { white-space: normal; overflow: visible; }
.tk-row .st { margin-top: 3px; font-size: 11.5px; line-height: 1.4; display: block; word-break: break-word; }
.tk-row .st.err { color: var(--danger); }
.tk-row .st .bar { margin: 4px 0 2px; height: 4px; }
.tk-row .acts { display: flex; gap: 2px; flex: none; }
.tk-row .acts .btn { padding: 3px 8px; }
.gif-limit { font: 500 11px var(--f-mono); color: var(--ink-3); }
`;

  /* ---------- state ---------- */
  const save = debounce(() => { if (dbKey) MS.db.set(dbKey, S).catch(() => {}); }, 400);
  async function load() {
    const key = 'gif.' + (MS.lib.name || '');
    if (loadedFor === key) return;
    loadedFor = key; dbKey = key;
    let st = null; try { st = await MS.db.get(key); } catch (e) { /* none */ }
    S = Object.assign(blank(), st || {});
    curRef = null; selTake = null; markIn = null;
    $('[data-shots]', root).value = S.shots.join('\n');
    speed(S.speed || 1, true);
  }

  /* ---------- clips ---------- */
  const libRefs = () => (MS.lib.items || []).filter((i) => i.kind === 'video').map(MS.src.fromLib);
  const clips = () => { const seen = new Set(), out = []; for (const r of [...S.ext, ...libRefs()]) if (!seen.has(r.ref)) { seen.add(r.ref); out.push(r); } return out; };
  const clipOf = (ref) => clips().find((c) => c.ref === ref);
  const takesOf = (ref) => S.takes.filter((t) => t.ref.ref === ref);
  const nameOf = (ref) => clipOf(ref)?.name || S.takes.find((t) => t.ref.ref === ref)?.ref.name || ref;
  const dur = (r) => { if (!metaCache.has(r.ref)) metaCache.set(r.ref, MS.src.meta(r).catch(() => null)); return metaCache.get(r.ref); };
  const fmtShort = (t) => fmtTime(t).replace(/\.\d+$/, '');

  function drawClips() {
    const box = $('[data-clips]', root), list = clips();
    $('[data-sub]', root).textContent = list.length ? `${list.length} clip${list.length === 1 ? '' : 's'} · ${S.takes.length} take${S.takes.length === 1 ? '' : 's'} · ${S.reviewed.length} reviewed` : 'Mark takes on a clip, then export them as GIFs.';
    for (const [k, el] of clipEls) if (!list.some((c) => c.ref === k)) { el.remove(); clipEls.delete(k); }
    $('.empty', box)?.remove();
    if (!list.length) box.append(h('<div class="empty small">No clips yet. Record one, or use Add clip…</div>'));
    list.forEach((r, i) => {
      let el = clipEls.get(r.ref);
      if (!el) {
        el = h(`<div class="gif-clip" data-ref="${esc(r.ref)}" title="${esc(r.name)}"><div class="th"><img alt=""></div><div class="tx"><b>${esc(r.name)}</b><span data-d>…</span></div><div class="mk"></div>${r.ref.startsWith('ext:') ? '<button class="btn ghost sm x" title="Remove from this list">✕</button>' : ''}</div>`);
        MS.src.thumb(r).then((u) => { if (u) $('img', el).src = u; }, () => {});
        dur(r).then((m) => { const d = $('[data-d]', el); if (d) d.textContent = m?.dur ? fmtShort(m.dur) + (r.ref.startsWith('ext:') ? ' · disk' : '') : (r.ref.startsWith('ext:') ? 'disk' : ''); });
        el.onclick = (e) => { if (e.target.closest('.x')) removeClip(r); else select(r.ref, 0); };
        clipEls.set(r.ref, el);
      }
      if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
      el.classList.toggle('active', r.ref === curRef);
      const n = takesOf(r.ref).length;
      $('.mk', el).innerHTML = `${S.reviewed.includes(r.ref) ? '<span class="ok" title="Reviewed">✓</span>' : ''}${n ? `<span class="tk">${n} take${n > 1 ? 's' : ''}</span>` : ''}`;
    });
  }
  async function removeClip(r) {
    const n = takesOf(r.ref).length;
    if (n && !(await MS.ui.confirmBox('Remove clip', `${r.name} has ${n} take${n > 1 ? 's' : ''}. Remove both from this list? Files on disk stay.`, 'Remove', true))) return;
    S.ext = S.ext.filter((x) => x.ref !== r.ref); S.takes = S.takes.filter((t) => t.ref.ref !== r.ref);
    MS.src.forget(r); save();
    if (curRef === r.ref) { curRef = null; const c = clips()[0]; if (c) select(c.ref, 0); else clearViewer(); }
    drawClips(); drawTakes(); drawTime();
  }
  function addExt(refs) {
    const inLib = new Set(libRefs().map((r) => r.ref));
    for (const r of refs) if (!inLib.has(r.ref) && !S.ext.some((x) => x.ref === r.ref)) S.ext.unshift(r);
    save(); drawClips();
    if (refs[0]) select(refs[0].ref, 0);
  }

  /* ---------- viewer ---------- */
  function clearViewer() {
    video.pause(); video.removeAttribute('src'); video.load();
    $('.nm', root).textContent = 'No clip'; $('.info', root).textContent = '';
    msg('No clip selected', 'Pick one on the left, or add one from disk.');
  }
  function msg(title, text) {
    const m = $('.gif-msg', root);
    if (!title) { m.hidden = true; return; }
    m.hidden = false; m.innerHTML = `<b>${esc(title)}</b><span>${esc(text)}</span>`;
  }
  async function select(ref, t = 0) {
    const r = clips().find((c) => c.ref === ref) || S.takes.find((x) => x.ref.ref === ref)?.ref;
    if (!r) return;
    if (curRef && curRef !== ref && !broken && !S.reviewed.includes(curRef)) S.reviewed.push(curRef);
    curRef = ref; markIn = null; broken = false;
    const tok = ++loadTok;
    $('.nm', root).textContent = r.name; $('.info', root).textContent = r.size ? fmtBytes(r.size) : '';
    msg(null);
    S.last = { ref: r, t: t || 0 }; save();
    drawClips(); drawTakes(); drawTime();
    clipEls.get(ref)?.scrollIntoView({ block: 'nearest' });
    let url; try { url = await MS.src.url(r); } catch (e) { if (tok === loadTok) { broken = true; msg('Cannot open this clip', e.message || String(e)); } return; }
    if (tok !== loadTok) return;
    video.src = url;
    video.playbackRate = S.speed || 1;
    video.onloadedmetadata = () => {
      if (tok !== loadTok) return;
      if (!video.videoWidth) return fail();
      video.currentTime = Math.min(t || 0, Math.max(0, (video.duration || 1) - 0.05)); video.playbackRate = S.speed || 1; drawTime();
      const m = $('.info', root); m.textContent = `${video.videoWidth}×${video.videoHeight} · ${fmtShort(video.duration)}${r.size ? ' · ' + fmtBytes(r.size) : ''}`;
    };
    video.play().catch(() => {});
  }
  function fail() {
    broken = true; video.pause();
    msg('The browser cannot decode this clip', 'Usually HEVC / H.265. Re-encode it to H.264 in Compress or the Editor, then mark takes on the result.');
  }

  function drawTime() {
    const d = video.duration || 0, tl = $('[data-tl]', root);
    $('[data-time]', root).textContent = `${fmtTime(video.currentTime || 0)} / ${fmtTime(d)}`;
    if (!d) { $$('.take', tl).forEach((x) => x.remove()); $('.sel', tl).hidden = true; return; }
    $('.ph', tl).style.left = (video.currentTime / d * 100) + '%';
    const sel = $('.sel', tl);
    if (markIn !== null) { sel.hidden = false; const a = Math.min(markIn, video.currentTime), b = Math.max(markIn, video.currentTime); sel.style.left = (a / d * 100) + '%'; sel.style.width = ((b - a) / d * 100) + '%'; }
    else sel.hidden = true;
    $$('.take', tl).forEach((x) => x.remove());
    for (const tk of takesOf(curRef)) tl.append(h(`<div class="take${tk.id === selTake ? ' on' : ''}" style="left:${tk.in / d * 100}%;width:${(tk.out - tk.in) / d * 100}%;${tk.id === selTake ? 'opacity:1;background:var(--mark)' : ''}" title="${esc(tk.name)}"></div>`));
  }
  let lastRemember = 0;
  function remember() {
    if (!curRef || Date.now() - lastRemember < 3000) return;
    lastRemember = Date.now();
    const r = clipOf(curRef); if (!r) return;
    S.last = { ref: r, t: +video.currentTime.toFixed(2) }; save();
  }
  function speed(v, quiet) {
    S.speed = v; if (video) video.playbackRate = v;
    $$('[data-speed] button', root).forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.v === v)));
    if (!quiet) save();
  }
  const ready = () => curRef && !broken && video.videoWidth;
  const toggle = () => { if (ready()) video.paused ? video.play().catch(() => {}) : video.pause(); };
  const seekBy = (d) => { if (ready()) video.currentTime = clamp(video.currentTime + d, 0, video.duration || 0); };

  /* ---------- takes ---------- */
  function nextName() {
    const used = new Set(S.takes.map((t) => t.name));
    return S.shots.find((s) => !used.has(s)) || `take ${S.takes.length + 1}`;
  }
  function setIn() {
    if (!ready()) return MS.ui.toast(broken ? 'This clip cannot be decoded here.' : 'Open a clip first.', true);
    markIn = video.currentTime; drawTime(); MS.ui.toast(`In at ${fmtTime(markIn)}. Press O at the end of the take.`);
  }
  function setOut() {
    if (!ready()) return MS.ui.toast(broken ? 'This clip cannot be decoded here.' : 'Open a clip first.', true);
    if (markIn === null) return MS.ui.toast('Press I at the start of the take first.', true);
    const a = Math.min(markIn, video.currentTime), b = Math.max(markIn, video.currentTime);
    if (b - a < 0.3) return MS.ui.toast('Take too short.', true);
    const r = clipOf(curRef) || S.last?.ref;
    const tk = { id: uid(), name: nextName(), ref: r, in: +a.toFixed(2), out: +b.toFixed(2), jobId: null };
    S.takes.push(tk); markIn = null; selTake = tk.id; save();
    drawTakes(); drawTime(); drawClips();
    MS.ui.toast(`Take "${tk.name}" saved (${(b - a).toFixed(1)} s).`);
  }
  function delTake(id) {
    const tk = S.takes.find((t) => t.id === id); if (!tk) return;
    S.takes = S.takes.filter((t) => t !== tk); if (selTake === id) selTake = null; save();
    MS.sound?.('trash'); drawTakes(); drawTime(); drawClips();
  }
  async function rename(tk) {
    const n = await MS.ui.promptBox('Rename take', 'Name (also the GIF file name)', tk.name);
    if (!n) return;
    tk.name = n; tk.jobId = null; save(); drawTakes();
  }
  const jobOf = (tk) => tk.jobId && MS.queue.jobs().find((j) => j.id === tk.jobId);
  function queueTake(tk) {
    const r = tk.ref, j = MS.queue.add({ type: 'gif', name: tk.name, title: `${tk.name} · ${r.name} ${fmtTime(tk.in)}–${fmtTime(tk.out)}`, params: { ref: r, in: tk.in, out: tk.out }, ref: r });
    tk.jobId = j.id; save(); return j;
  }
  function exportAll() {
    const todo = S.takes.filter((t) => { const j = jobOf(t); return !j || j.status === 'cancelled' || j.status === 'error'; });
    if (!S.takes.length) return MS.ui.toast('No takes yet: I at the start, O at the end.', true);
    if (!todo.length) return MS.ui.toast('Every take is already queued or exported. Use a take\'s Export to make it again.');
    for (const t of todo) queueTake(t);
    drawTakes();
    MS.ui.toast(`${todo.length} GIF${todo.length === 1 ? '' : 's'} queued.`, false, { label: 'Open Exporter', fn: () => MS.go('export') });
  }

  function stateHtml(tk) {
    const j = jobOf(tk);
    if (!j) return '';
    if (j.status === 'queued') return `<span class="st dim">Queued in the Exporter</span>`;
    if (j.status === 'running') return `<span class="st dim num">${Math.round((j.progress || 0) * 100)}%${j.text ? ' · ' + esc(j.text) : ''}<div class="bar"${j.progress == null ? ' data-job' : ''}><i style="width:${Math.round((j.progress ?? 1) * 100)}%"></i></div></span>`;
    if (j.status === 'done') return `<span class="st t-ok">✓ ${esc(j.out?.file || '')} · ${fmtBytes(j.out?.size || 0)}${j.out?.label ? ' · ' + esc(j.out.label) : ''}</span>`;
    if (j.status === 'cancelled') return `<span class="st dim">Cancelled</span>`;
    return `<span class="st err">${esc(j.error || 'Failed')}</span>`;
  }
  function takeRow(tk) {
    const el = h(`<div class="item tk-row${tk.id === selTake ? ' active' : ''}" data-id="${esc(tk.id)}"><div class="grow"><div class="tn"><b></b><span class="small dim ellipsis"></span></div><div data-st></div></div><div class="acts"><button class="btn sm" data-x>Export</button><button class="btn ghost sm" data-ren title="Rename">✎</button><button class="btn ghost sm" data-del title="Remove take (Del)">✕</button></div></div>`);
    $('b', el).textContent = tk.name;
    $('.tn span', el).textContent = `${nameOf(tk.ref.ref)} · ${fmtTime(tk.in)}–${fmtTime(tk.out)} · ${(tk.out - tk.in).toFixed(1)} s`;
    $('[data-st]', el).innerHTML = stateHtml(tk);
    paintExport(el, tk);
    $('[data-x]', el).onclick = (e) => { e.stopPropagation(); const j = jobOf(tk); if (j && j.status === 'error') MS.queue.retry(j.id); else queueTake(tk); drawTakes(); };
    $('[data-ren]', el).onclick = (e) => { e.stopPropagation(); rename(tk); };
    $('[data-del]', el).onclick = (e) => { e.stopPropagation(); delTake(tk.id); };
    el.onclick = () => { selTake = tk.id; if (curRef !== tk.ref.ref) select(tk.ref.ref, tk.in); else { if (ready()) video.currentTime = tk.in; } $$('.tk-row', root).forEach((x) => x.classList.toggle('active', x === el)); drawTime(); };
    return el;
  }
  function paintExport(el, tk) {
    const j = jobOf(tk), b = $('[data-x]', el);
    b.textContent = !j ? 'Export' : j.status === 'error' ? 'Retry' : j.status === 'done' ? 'Again' : 'Export';
    b.disabled = !!j && (j.status === 'queued' || j.status === 'running');
  }
  function drawTakes() {
    const box = $('[data-takes]', root); if (!box) return;
    box.replaceChildren();
    const used = new Set(S.takes.map((t) => t.name));
    $('[data-shotcount]', root).textContent = S.shots.length ? `${S.shots.filter((s) => used.has(s)).length}/${S.shots.length} taken · next: ${nextName()}` : `next: ${nextName()}`;
    const exp = $('[data-export]', root), n = S.takes.filter((t) => { const j = jobOf(t); return !j || j.status === 'cancelled' || j.status === 'error'; }).length;
    exp.textContent = n ? `Export takes (${n})` : 'Export takes'; exp.disabled = !n;
    if (!S.takes.length) box.append(h('<div class="empty small">No takes yet: <kbd>I</kbd> at the start, <kbd>O</kbd> at the end.</div>'));
    for (const tk of S.takes) box.append(takeRow(tk));
  }
  /* queue events patch the matching row only: no rebuild while a bar moves */
  function onQueue(ev) {
    if (!root) return;
    if (!ev || ev.removed) {
      if (ev?.removed) for (const t of S.takes) if (t.jobId === ev.id) t.jobId = null;
      return drawTakes();
    }
    const tk = S.takes.find((t) => t.jobId === ev.id); if (!tk) return;
    const el = $(`.tk-row[data-id="${tk.id}"]`, root); if (!el) return;
    $('[data-st]', el).innerHTML = stateHtml(tk); paintExport(el, tk);
    const exp = $('[data-export]', root), n = S.takes.filter((t) => { const j = jobOf(t); return !j || j.status === 'cancelled' || j.status === 'error'; }).length;
    exp.textContent = n ? `Export takes (${n})` : 'Export takes'; exp.disabled = !n;
  }

  /* ---------- tab ---------- */
  function mount(el) {
    root = el;
    const st = h('<style data-tab="gif"></style>'); st.textContent = CSS; document.head.append(st);
    el.append(h(`<div class="page-head"><div><h2>GIF</h2><p data-sub></p></div>
      <div class="row"><span class="gif-limit">640×360 max · 15 fps · under 8 MB</span><button class="btn" data-add>Add clip…</button><button class="btn primary" data-export>Export takes</button><button class="btn ghost" data-open>Open Exporter</button></div></div>`));
    el.append(h(`<div class="gif-wrap">
      <aside class="card gif-clips"><div class="row mb-2"><h3 class="grow">Clips</h3><span class="small dim">N / P</span></div><div class="list" data-clips></div></aside>
      <div>
        <div class="gif-top"><span class="nm">No clip</span><span class="info"></span></div>
        <div class="gif-stage"><div class="viewer"><video playsinline></video></div><div class="gif-msg" hidden></div></div>
        <div class="transport"><button class="btn sm" data-play title="Space">▶</button><span class="num small" data-time>0:00.00 / 0:00.00</span><div class="timeline-mini" data-tl><div class="sel" hidden></div><div class="ph"></div></div>
          <div class="seg" data-speed>${SPEEDS.map((s) => `<button data-v="${s}">${s}×</button>`).join('')}</div>
          <button class="btn sm" data-in title="I">In</button><button class="btn sm" data-out title="O">Out → take</button></div>
        <p class="hint"><kbd>Space</kbd> play · <kbd>1</kbd><kbd>2</kbd><kbd>4</kbd> speed · <kbd>←</kbd><kbd>→</kbd> 1 s (Shift 5 s) · <kbd>,</kbd><kbd>.</kbd> frame · <kbd>N</kbd>/<kbd>P</kbd> clip · <kbd>I</kbd>/<kbd>O</kbd> take · <kbd>Del</kbd> remove take</p>
      </div>
      <div class="gif-side">
        <div class="card"><div class="row"><h3 class="grow">Shot list</h3><span class="small dim" data-shotcount></span></div><p class="lead">One name per line. Each take gets the next free name.</p><textarea class="input mono" rows="6" data-shots></textarea></div>
        <div class="card"><div class="row mb-2"><h3 class="grow">Takes</h3></div><div class="list" data-takes></div></div>
      </div></div>`));
    video = $('video', el);
    video.muted = !!MS.util.pref('gif.muted', false);
    video.onvolumechange = () => MS.util.setPref('gif.muted', video.muted);
    video.onerror = () => { if (curRef && video.src) fail(); };
    video.ontimeupdate = () => { drawTime(); remember(); };
    video.onplay = video.onpause = () => { $('[data-play]', el).textContent = video.paused ? '▶' : '❚❚'; };
    video.onclick = toggle;
    $('[data-play]', el).onclick = toggle;
    $('[data-in]', el).onclick = setIn; $('[data-out]', el).onclick = setOut;
    $('[data-speed]', el).onclick = (e) => { const b = e.target.closest('button'); if (b) speed(+b.dataset.v); };
    $('[data-tl]', el).onpointerdown = (e) => {
      const tl = e.currentTarget, r = tl.getBoundingClientRect();
      const seek = (ev) => { if (video.duration) video.currentTime = clamp((ev.clientX - r.left) / r.width, 0, 1) * video.duration; };
      tl.setPointerCapture(e.pointerId); seek(e);
      tl.onpointermove = seek; tl.onpointerup = () => { tl.onpointermove = tl.onpointerup = null; };
    };
    const ta = $('[data-shots]', el);
    ta.oninput = () => { S.shots = ta.value.split('\n').map((s) => s.trim()).filter(Boolean); save(); drawTakes(); };
    $('[data-export]', el).onclick = exportAll;
    $('[data-open]', el).onclick = () => MS.go('export');
    $('[data-add]', el).onclick = addClip;
    speed(1, true);
    on('queue', onQueue);
    on('library', () => { if (loadedFor) { drawClips(); drawTakes(); } });
  }

  async function addClip() {
    const refs = await MS.src.choose({ title: 'Add a clip', kinds: ['video'], multiple: true });
    if (refs?.length) addExt(refs);
  }
  async function onPaste(files) {
    const refs = (await MS.src.fromFiles(files)).filter((r) => r.kind === 'video');
    if (refs.length) { addExt(refs); MS.ui.toast(`Added ${refs.length} clip${refs.length === 1 ? '' : 's'}.`); }
    else MS.ui.toast('Paste a video file here to add it as a clip.', true);
  }

  async function show(arg) {
    await load();
    const want = arg?.ref;
    if (want) {
      if (want.ref.startsWith('ext:') && !S.ext.some((x) => x.ref === want.ref)) { S.ext.unshift(want); save(); }
      drawClips(); drawTakes();
      if (want.ref !== curRef) return select(want.ref, 0);
      return;
    }
    drawClips(); drawTakes();
    if (!curRef) {
      const l = S.last?.ref && (clipOf(S.last.ref.ref) || S.takes.some((t) => t.ref.ref === S.last.ref.ref)) ? S.last : null;
      const first = clips()[0];
      if (l) { select(l.ref.ref, l.t); MS.ui.toast('Picked up where you left off.'); }
      else if (first) select(first.ref, 0);
      else clearViewer();
    }
  }
  function hide() { if (video) video.pause(); }

  function onKey(e) {
    if (e.target.closest?.('input, textarea, select') && !(e.ctrlKey && e.key === 'Enter')) return;
    const k = e.key, lk = k.length === 1 ? k.toLowerCase() : k;
    if (e.ctrlKey && k === 'Enter') exportAll();
    else if (e.ctrlKey || e.metaKey || e.altKey) return;
    else if (k === ' ') toggle();
    else if (k === '1' || k === '2' || k === '4') speed(+k);
    else if (lk === 'n' || lk === 'p') {
      const list = clips(), i = list.findIndex((c) => c.ref === curRef), n = list[clamp(i + (lk === 'n' ? 1 : -1), 0, list.length - 1)];
      if (n && n.ref !== curRef) select(n.ref, 0);
    }
    else if (lk === 'i') setIn();
    else if (lk === 'o') setOut();
    else if (k === 'ArrowRight' || k === 'ArrowLeft') seekBy((k === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 5 : 1));
    else if (k === '.' || k === ',') { if (ready()) { video.pause(); seekBy((k === '.' ? 1 : -1) / 30); } }
    else if ((k === 'Delete' || k === 'Backspace') && selTake) delTake(selTake);
    else return;
    e.preventDefault();
  }

  /* the Exporter's runner: decode in the page, encode in the GIF worker, hand the Blob back to the queue to write */
  MS.queue.runner('gif', async (job, ctx) => {
    const url = await MS.src.url(job.params.ref);
    const r = await MS.nexus.makeNexusGif(url, job.params.in, job.params.out, ctx.progress, { get cancelled() { try { ctx.check(); return false; } catch (e) { return true; } } });
    ctx.check();
    return { blob: new Blob([r.bytes], { type: 'image/gif' }), ext: 'gif', label: r.label + (r.fits ? '' : ' · over 8 MB') };
  });

  MS.tab({
    id: 'gif', label: 'GIF', order: 2,
    icon: 'M3 5h18v14H3zM10 9l5 3-5 3z',
    mount, show, hide, onKey, onPaste,
    keys: [
      { k: 'Space', d: 'Play / pause' }, { k: '1 2 4', d: 'Speed' }, { k: 'N P', d: 'Next / previous clip' }, { k: 'I O', d: 'Mark in / out (O makes the take)' },
      { k: '← →', d: '1 s back / forward (Shift: 5 s)' }, { k: ', .', d: 'One frame back / forward' }, { k: 'Del', d: 'Delete the selected take' }, { k: 'Ctrl Enter', d: 'Export takes' },
    ],
    claims: ['1', '2', '4', ',', '.', 'n', 'N', 'p', 'P', 'i', 'I', 'o', 'O'],
    hotkeys: [{ sel: '[data-play]', k: 'Space' }, { sel: '[data-in]', k: 'I' }, { sel: '[data-out]', k: 'O' }, { sel: '[data-export]', k: 'Ctrl+Enter' }],
  });
})();
