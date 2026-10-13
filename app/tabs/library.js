/* Library: the capture folder as the home screen. Videos, screenshots and GIFs grouped by day, hover to scrub a clip, a sticky preview
   on the right, and the hand-off to the other tabs (GIF, Compress, Editor). Read-only: nothing here writes into the folder. */
(() => {
  const { $, $$, h, esc, clamp, fmtTime, fmtBytes, pref, setPref, on, debounce } = MS.util;

  const FILTERS = [['All', 'all'], ['Videos', 'video'], ['Screenshots', 'image'], ['GIFs', 'gif'], ['Exports', 'export']];
  const FILTER_OF = { all: () => true, video: (i) => i.kind === 'video', image: (i) => i.kind === 'image', gif: (i) => i.kind === 'gif', export: (i) => i.exported };
  const SORTS = {
    new: ['Newest', (a, b) => b.mtime - a.mtime || cmpName(a, b), true],
    old: ['Oldest', (a, b) => a.mtime - b.mtime || cmpName(a, b), true],
    name: ['Name', cmpName, false],
    size: ['Size', (a, b) => b.size - a.size || cmpName(a, b), false],
  };
  function cmpName(a, b) { return a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }); }
  const KIND_LABEL = { video: 'Video', image: 'Screenshot', gif: 'GIF' };

  let root, days, prev, selbar, sel, search, sizeInput, head;
  let filter = pref('lib.filter', 'all'), sort = pref('lib.sort', 'new'), tileSize = pref('lib.tile', 220), q = '';
  let cur = null, shown = [], stageEl = null, previewTok = 0;
  const tiles = new Map(), secs = new Map();

  const CSS = `
.lib-tools { gap: 8px; }
.lib-tools .input { width: 200px; }
.lib-tools input[type=range] { width: 110px; }
.lib-day { margin-bottom: 14px; }
.lib-dh { position: sticky; top: 0; z-index: 4; display: flex; align-items: baseline; gap: 8px; margin: 0 -4px 8px; padding: 7px 4px 6px; font: 650 13px/1.2 var(--f-display); letter-spacing: -.005em; color: var(--ink);
  background: color-mix(in srgb, var(--bg) 78%, transparent); backdrop-filter: blur(12px) saturate(1.4); }
.lib-dh small { font: 500 11.5px var(--f-body); color: var(--ink-3); }
.lib-grid { grid-template-columns: repeat(auto-fill, minmax(var(--lib-tile, 220px), 1fr)); }
.lib-grid .tile .scrub-v { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity .2s var(--ease); pointer-events: none; }
.lib-grid .tile .scrub-v.on { opacity: 1; }
.lib-grid .tile .badge b.new { background: linear-gradient(135deg, var(--accent), var(--cyan)); color: #fff; letter-spacing: .06em; animation: libNew 1.9s ease-in-out infinite; }
.lib-grid .tile .badge b.exp { background: var(--purple); color: #fff; }
.lib-grid .tile .badge b.t { background: rgba(0, 0, 0, .65); }
.lib-grid .tile.just { animation: popTile .6s var(--spring) both, libJust 2.6s var(--ease-out) both; }
@keyframes libNew { 50% { box-shadow: 0 0 12px 1px color-mix(in srgb, var(--accent) 80%, transparent); } }
@keyframes libJust { 0%, 60% { box-shadow: 0 0 0 2px var(--accent), 0 0 26px 2px color-mix(in srgb, var(--accent) 60%, transparent); } 100% { box-shadow: none; } }
.lib-prev { position: sticky; top: 14px; max-height: calc(100vh - 110px); overflow: auto; padding: 12px; }
.lib-prev .viewer video, .lib-prev .viewer img { max-height: 44vh; }
.lib-prev .gal-stage { border-radius: var(--r); overflow: hidden; }
.lib-prev .gal-stage:fullscreen { overflow: visible; }
.lib-pn { font: 500 12.5px/1.35 var(--f-mono); word-break: break-all; margin-top: 12px; }
.lib-chips { display: flex; flex-wrap: wrap; gap: 4px 6px; margin-top: 6px; }
.lib-prev .actions .btn svg { margin-right: -2px; }
.lib-prev .mini { font-size: 11.5px; color: var(--ink-3); margin: 10px 0 0; line-height: 1.7; }
.lib-empty { padding: 56px 20px; }
.lib-empty b { display: block; font: 650 16px var(--f-display); color: var(--ink); margin-bottom: 4px; }
`;
  const IC = {
    gif: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9l5 3-5 3z"/></svg>',
    compress: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/></svg>',
    editor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v5M16 4v5M7 14h4M13 14h4"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg>',
  };

  /* ---------- helpers ---------- */
  const items = () => MS.lib.items || [];
  const byId = (id) => items().find((i) => i.id === id);
  const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  function dayLabel(t) {
    const d = new Date(t), n = new Date(), s = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((s(n) - s(d)) / 864e5);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== n.getFullYear() ? { year: 'numeric' } : {}) });
  }
  const visible = () => {
    const f = FILTER_OF[filter] || FILTER_OF.all, k = q.trim().toLowerCase();
    return items().filter((i) => f(i) && (!k || i.path.toLowerCase().includes(k))).sort(SORTS[sort][1]);
  };
  const tileEl = (id) => tiles.get(id);
  const sig = (i) => [i.fresh, i.exported, i.size, i.mtime].join('|');

  /* ---------- tiles ---------- */
  function badge(t, cls, text, title) {
    let b = $('.badge', t);
    if (!b) { b = h('<div class="badge"></div>'); t.append(b); }
    const x = h(`<b class="${cls}"${title ? ` title="${esc(title)}"` : ''}>${text}</b>`);
    b.append(x);
  }
  function makeTile(it) {
    const t = MS.ui.tile(it);
    t.dataset.id = it.id; t._it = it; t._sig = sig(it);
    if (it.fresh) badge(t, 'new', 'NEW', 'Arrived since you last looked');
    if (it.exported) badge(t, 'exp', 'EXPORT', 'Made by Media Studio');
    if (!$('.scrub', t)) t.append(h('<div class="scrub"></div>'));
    t.classList.toggle('cur', it.id === cur);
    t.classList.toggle('msel', !!sel?.has(it.id));
    return t;
  }

  /* Keyed reconcile: tiles that stay are never recreated or moved (no flicker, no scroll jump); new ones pop in with the motion kit. */
  function reconcile(justAdded) {
    shown = visible();
    const want = new Set(shown.map((i) => i.id));
    for (const [id, t] of tiles) if (!want.has(id)) { t.remove(); tiles.delete(id); }
    const flat = !SORTS[sort][2];
    const groups = [];
    for (const it of shown) {
      const key = flat ? 'all' : dayKey(it.mtime);
      let g = groups[groups.length - 1];
      if (!g || g.key !== key) groups.push(g = { key, label: flat ? `${SORTS[sort][0] === 'Name' ? 'By name' : 'Largest first'}` : dayLabel(it.mtime), items: [] });
      g.items.push(it);
    }
    const keep = new Set(groups.map((g) => g.key));
    for (const [k, s] of secs) if (!keep.has(k)) { s.el.remove(); secs.delete(k); }
    groups.forEach((g, gi) => {
      let s = secs.get(g.key);
      if (!s) { s = { el: h(`<section class="lib-day"><h4 class="lib-dh"><span></span><small></small></h4><div class="grid lib-grid"></div></section>`) }; s.grid = $('.grid', s.el); s.t = $('span', s.el); s.n = $('small', s.el); secs.set(g.key, s); }
      if (days.children[gi] !== s.el) days.insertBefore(s.el, days.children[gi] || null);
      s.t.textContent = g.label; s.n.textContent = `${g.items.length} item${g.items.length === 1 ? '' : 's'}`;
      g.items.forEach((it, i) => {
        let t = tiles.get(it.id);
        if (t && t._sig !== sig(it)) { t.remove(); t = null; }
        if (!t) { t = makeTile(it); tiles.set(it.id, t); if (justAdded?.has(it.id)) t.classList.add('just'); }
        t._it = it;
        if (s.grid.children[i] !== t) s.grid.insertBefore(t, s.grid.children[i] || null);
      });
    });
    $('.lib-empty', days)?.remove();
    if (!shown.length) days.append(emptyState());
    sel?.prune?.(want);
    drawHead();
    if (cur && !want.has(cur)) cur = null;
    if (!cur && shown.length) cur = shown[0].id;
    $$('.tile.cur', days).forEach((t) => t.classList.toggle('cur', t.dataset.id === cur));
    tileEl(cur)?.classList.add('cur');
    drawBar();
    drawPreview(cur && byId(cur), { quiet: true });
  }
  function emptyState() {
    const none = !items().length;
    return h(`<div class="empty lib-empty">${none
      ? `<b>This folder has no captures yet</b>Record a clip or take a screenshot: new files in <span class="mono">${esc(MS.lib.name || 'the folder')}</span> appear here by themselves.`
      : `<b>Nothing matches</b>${q ? `No name contains “${esc(q)}”.` : 'No items of this kind in the folder.'} <button class="btn sm ghost" data-reset>Show everything</button>`}</div>`);
  }

  function drawHead() {
    const all = items(), c = { video: 0, image: 0, gif: 0 };
    let bytes = 0, ex = 0;
    for (const i of all) { c[i.kind] = (c[i.kind] || 0) + 1; bytes += i.size; if (i.exported) ex++; }
    const p = (n, a, b) => `${n} ${n === 1 ? a : b}`;
    $('[data-name]', root).textContent = MS.lib.name || 'Library';
    $('[data-sub]', root).textContent = all.length
      ? [p(c.video, 'clip', 'clips'), p(c.image, 'screenshot', 'screenshots'), p(c.gif, 'GIF', 'GIFs'), ex ? p(ex, 'export', 'exports') : '', fmtBytes(bytes)].filter(Boolean).join(' · ')
      : 'Empty folder';
  }

  /* ---------- hover scrub ---------- */
  let hot = null;
  function scrubStop() {
    if (!hot) return;
    const { t, v } = hot; hot = null;
    $('.scrub', t).style.width = '0';
    if (v) { v.remove(); v.removeAttribute('src'); v.load(); }
  }
  async function scrubStart(t) {
    const it = t._it;
    hot = { t, v: null, want: 0 };
    if (it.kind !== 'video') return;
    const me = hot;
    let url; try { url = await MS.lib.url(it); } catch (e) { return; }
    if (hot !== me) return;
    const v = document.createElement('video');
    v.className = 'scrub-v'; v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = url;
    const apply = () => { if (v.duration && !v.seeking) v.currentTime = clamp(me.want, 0, 1) * v.duration; };
    v.onloadeddata = () => { apply(); };
    v.onseeked = () => { v.classList.add('on'); apply(); };
    me.v = v; me.apply = apply; t.prepend(v);
  }
  function scrubMove(e) {
    const t = e.target.closest?.('.tile');
    if (hot && hot.t !== t) scrubStop();
    if (!t || !t._it) return;
    if (!hot) scrubStart(t);
    const r = t.getBoundingClientRect(), f = clamp((e.clientX - r.left) / r.width, 0, 1);
    hot.want = f;
    if (t._it.kind === 'video') $('.scrub', t).style.width = (f * 100) + '%';
    hot.apply?.();
  }

  /* ---------- preview panel ---------- */
  const targets = () => (sel.size ? sel.keys.map(byId).filter(Boolean) : [byId(cur)].filter(Boolean));
  const refs = (list) => list.map((i) => MS.src.fromLib(i));
  async function copyImage(it) {
    try {
      const file = await MS.lib.file(it);
      let blob = file.type === 'image/png' ? file : null;
      if (!blob) {
        const bmp = await createImageBitmap(file), c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height; c.getContext('2d').drawImage(bmp, 0, 0);
        blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      MS.ui.toast(`Copied ${it.name} to the clipboard.`);
    } catch (e) { MS.ui.toast('Could not copy: ' + (e.message || e), true); }
  }
  const act = {
    gif() { const v = targets().find((i) => i.kind === 'video'); if (v) MS.go('gif', { ref: MS.src.fromLib(v) }); else MS.ui.toast('Make GIF needs a video.', true); },
    compress() { const l = targets().filter((i) => i.kind === 'image'); if (l.length) MS.go('compress', { refs: refs(l) }); else MS.ui.toast('Compress needs screenshots: select some.', true); },
    editor() { const l = targets().filter((i) => i.kind === 'video' || i.kind === 'image' || i.kind === 'gif'); if (l.length) MS.go('editor', { refs: refs(l) }); },
    copy() { const i = byId(cur); if (i?.kind === 'image') copyImage(i); },
  };

  function actionsEl(it) {
    const list = targets(), vids = list.filter((i) => i.kind === 'video').length, imgs = list.filter((i) => i.kind === 'image').length;
    const multi = list.length > 1, a = h('<div class="actions"></div>');
    const add = (label, ic, fn, on_, cls = '', title = '') => { const b = h(`<button class="btn sm ${cls}" ${on_ ? '' : 'disabled'} title="${esc(title)}">${IC[ic]}${label}</button>`); b.onclick = fn; a.append(b); };
    add('Make GIF', 'gif', act.gif, vids > 0, vids ? 'primary' : '', 'G');
    add(multi && imgs ? `Compress ${imgs}` : 'Compress', 'compress', act.compress, imgs > 0, '', 'C');
    add(multi ? `Add ${list.length} to editor` : 'Add to editor', 'editor', act.editor, list.some((i) => i.kind !== 'audio'), '', 'E');
    if (!multi && it.kind === 'image') add('Copy', 'copy', act.copy, true, '', 'Copy the picture');
    return a;
  }

  async function drawPreview(it, { play = false, quiet = false } = {}) {
    const tok = ++previewTok;
    if (!it) { prev.innerHTML = '<div class="empty small">Select a capture to preview it.</div>'; stageEl = null; return; }
    const same = prev.dataset.id === it.id && prev.dataset.sig === sig(it) && stageEl?.isConnected;
    if (same && quiet) { refreshActions(it); return; }
    const url = await MS.lib.url(it).catch(() => null);
    if (tok !== previewTok) return;
    const fs = stageEl?.isConnected && document.fullscreenElement === stageEl;
    const v = MS.ui.mediaViewer(url, it.kind, { autoplay: play, loop: true, muted: true });
    const idx = shown.findIndex((x) => x.id === it.id);
    v.append(h(`<span class="gal-count num">${idx + 1} / ${shown.length}</span>`));
    for (const [cls, d, label] of [['prev', -1, '‹'], ['next', 1, '›']]) {
      if ((d < 0 && idx <= 0) || (d > 0 && idx >= shown.length - 1)) continue;
      const b = h(`<button class="gal-nav ${cls}" title="${d < 0 ? 'Previous (←)' : 'Next (→)'}">${label}</button>`);
      b.onpointerdown = (e) => e.stopPropagation();
      b.onclick = (e) => { e.stopPropagation(); move(d); };
      v.append(b);
    }
    if (fs) { stageEl.replaceChildren(v); [...prev.children].forEach((c) => c !== stageEl && c.remove()); }
    else { prev.innerHTML = ''; stageEl = h('<div class="gal-stage"></div>'); stageEl.append(v); prev.append(stageEl); }
    prev.dataset.id = it.id; prev.dataset.sig = sig(it);
    $('video', v)?.addEventListener('error', () => v.append(h('<div class="empty small" style="position:absolute;inset:0;display:grid;place-content:center;background:var(--screen);color:var(--ink-2);border:0">The browser cannot play this clip (codec, e.g. HEVC).<br>It can still be added to the Editor.</div>')));
    prev.append(h(`<div class="lib-pn" title="${esc(it.path)}">${esc(it.name)}</div>`), h('<div class="lib-chips" data-chips></div>'), h('<div data-acts></div>'));
    fillChips(it);
    refreshActions(it);
    prev.append(h('<p class="mini"><kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Space</kbd> play · <kbd>Enter</kbd> fullscreen · <kbd>G</kbd> GIF · <kbd>C</kbd> compress · <kbd>E</kbd> editor</p>'));
  }
  function refreshActions(it) { const box = $('[data-acts]', prev); if (box) box.replaceChildren(actionsEl(it)); }
  async function fillChips(it) {
    const box = $('[data-chips]', prev); if (!box) return;
    const chip = (t, cls = '') => `<span class="tag ${cls}">${esc(t)}</span>`;
    const sub = it.path.includes('/') ? it.path.slice(0, it.path.lastIndexOf('/')) : '';
    const base = [chip(KIND_LABEL[it.kind] || it.kind), chip(fmtBytes(it.size)), chip(new Date(it.mtime).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })), sub ? chip(sub + '/') : '', it.exported ? chip('export', 't-mark') : '', it.fresh ? chip('new', 't-mark') : ''];
    box.innerHTML = base.join('');
    try {
      const m = await MS.lib.meta(it);
      if (prev.dataset.id !== it.id || !m) return;
      box.innerHTML = [chip(KIND_LABEL[it.kind] || it.kind), m.w ? chip(`${m.w}×${m.h}`) : '', m.dur ? chip(fmtTime(m.dur).replace(/\.\d+$/, '')) : '', ...base.slice(1)].join('');
    } catch (e) { /* unreadable: the plain chips stay */ }
  }

  /* ---------- current item, selection, keys ---------- */
  const showPrev = debounce((it, play) => drawPreview(it, { play }), 70);
  function setCur(it, { play = false, scroll = false, now = false } = {}) {
    if (!it) return;
    if (it.id !== cur) {
      tileEl(cur)?.classList.remove('cur');
      cur = it.id;
      tileEl(cur)?.classList.add('cur');
      if (now) drawPreview(it, { play }); else showPrev(it, play);
    } else if (play) drawPreview(it, { play });
    if (scroll) tileEl(cur)?.scrollIntoView({ block: 'nearest', behavior: MS.ui.reduced?.() ? 'auto' : 'smooth' });
    refreshActions(it);
  }
  function neighbor(dir) {
    const els = $$('.tile', days), me = els.findIndex((t) => t.dataset.id === cur);
    if (me < 0) return els[0];
    if (dir === 'left') return els[me - 1];
    if (dir === 'right') return els[me + 1];
    const r = els[me].getBoundingClientRect(), cx = r.left + r.width / 2;
    let best = null, bd = Infinity, rowTop = null;
    const order = dir === 'up' ? els.slice(0, me).reverse() : els.slice(me + 1);
    for (const t of order) {
      const b = t.getBoundingClientRect();
      if (dir === 'up' ? b.bottom > r.top + 2 : b.top < r.bottom - 2) continue;
      if (rowTop === null) rowTop = b.top;
      if (Math.abs(b.top - rowTop) > 4) break;
      const d = Math.abs(b.left + b.width / 2 - cx);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }
  function move(d) {
    const i = shown.findIndex((x) => x.id === cur), n = shown[clamp(i + d, 0, shown.length - 1)];
    if (n) setCur(n, { scroll: true });
  }
  function drawBar() {
    if (!selbar) return;
    const list = sel.keys.map(byId).filter(Boolean);
    selbar.hidden = !list.length;
    $('[data-n]', selbar).textContent = `${list.length} selected`;
    $('[data-bgif]', selbar).hidden = !list.some((i) => i.kind === 'video');
    $('[data-bcmp]', selbar).hidden = !list.some((i) => i.kind === 'image');
  }
  function cycleFilter(d = 1) {
    const ks = FILTERS.map((f) => f[1]);
    setFilter(ks[(ks.indexOf(filter) + d + ks.length) % ks.length]);
  }
  function setFilter(f) {
    filter = f; setPref('lib.filter', f);
    $$('[data-fseg] button', root).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === f)));
    reconcile();
  }

  /* ---------- tab ---------- */
  function mount(el) {
    root = el;
    const st = h('<style data-tab="library"></style>'); st.textContent = CSS; document.head.append(st);
    el.append(h(`<div class="page-head"><div><h2 data-name>Library</h2><p data-sub></p></div>
      <div class="row lib-tools">
        <div class="seg" data-fseg>${FILTERS.map(([l, v]) => `<button data-v="${v}" aria-pressed="${v === filter}">${l}</button>`).join('')}</div>
        <input class="input" data-q type="search" placeholder="Search by name" autocomplete="off">
        <select class="input lib-sort" data-sort title="Sort">${Object.entries(SORTS).map(([k, [l]]) => `<option value="${k}"${k === sort ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <input type="range" min="130" max="420" step="10" value="${tileSize}" data-size title="Tile size">
        <button class="btn sm ghost" data-change title="Choose another capture folder">Change folder</button>
      </div></div>`));
    el.append(h('<div class="split wide-side"><div data-days></div><aside class="card lib-prev" data-prev></aside></div>'));
    days = $('[data-days]', el); prev = $('[data-prev]', el); search = $('[data-q]', el); sizeInput = $('[data-size]', el);
    el.style.setProperty('--lib-tile', tileSize + 'px');
    selbar = h(`<div class="selbar" hidden><b data-n></b><button class="btn sm primary" data-bgif>Make GIF</button><button class="btn sm" data-bcmp>Compress</button><button class="btn sm" data-bed>Add to editor</button><button class="btn ghost sm" data-bclr>Clear</button></div>`);
    el.append(selbar);
    sel = MS.ui.selection(days, '.tile', { onChange: () => { drawBar(); const t = byId(cur); if (t) refreshActions(t); }, key: (t) => t.dataset.id });

    $('[data-fseg]', el).onclick = (e) => { const b = e.target.closest('button'); if (b) setFilter(b.dataset.v); };
    search.oninput = () => { q = search.value; reconcile(); };
    search.onkeydown = (e) => { if (e.key === 'Escape') { if (q) { search.value = ''; q = ''; reconcile(); } search.blur(); e.stopPropagation(); } };
    $('[data-sort]', el).onchange = (e) => { sort = e.target.value; setPref('lib.sort', sort); reconcile(); };
    sizeInput.oninput = () => { tileSize = +sizeInput.value; setPref('lib.tile', tileSize); el.style.setProperty('--lib-tile', tileSize + 'px'); };
    $('[data-change]', el).onclick = () => MS.lib.pick();
    $('[data-bgif]', selbar).onclick = act.gif; $('[data-bcmp]', selbar).onclick = act.compress; $('[data-bed]', selbar).onclick = act.editor;
    $('[data-bclr]', selbar).onclick = () => sel.clear();

    days.onclick = (e) => {
      if (e.target.closest('[data-reset]')) { search.value = ''; q = ''; setFilter('all'); return; }
      const t = e.target.closest('.tile'); if (!t) return;
      const it = byId(t.dataset.id); if (!it) return;
      const multi = sel.click(e, t);
      setCur(it, { play: !multi && it.kind !== 'image', now: true });
    };
    days.ondblclick = (e) => { if (e.target.closest('.tile')) fullscreen(); };
    days.addEventListener('pointermove', scrubMove);
    days.addEventListener('pointerleave', scrubStop);
    on('library', (ev) => {
      if (!root || !MS.lib || MS.lib.status !== 'ready') return;
      const added = new Set((ev?.added || []).map((x) => x.id || x));
      reconcile(tiles.size ? added : null);
    });
  }

  function fullscreen() {
    if (!stageEl?.isConnected) return;
    if (document.fullscreenElement === stageEl) document.exitFullscreen().catch(() => {});
    else stageEl.requestFullscreen().catch(() => {});
  }
  function playPause() {
    const v = $('video', stageEl || prev);
    if (v) v.paused ? v.play().catch(() => {}) : v.pause();
  }

  function show() {
    reconcile(null);
    if (cur) tileEl(cur)?.scrollIntoView({ block: 'nearest' });
  }
  function hide() { scrubStop(); const v = $('video', prev); if (v) v.pause(); if (document.fullscreenElement === stageEl) document.exitFullscreen().catch(() => {}); }

  function onKey(e) {
    const k = e.key, mod = e.ctrlKey || e.metaKey, lk = k.length === 1 ? k.toLowerCase() : k;
    if (e.target.closest?.('input, textarea, select')) return;
    if (mod && lk === 'a') { sel.all(); }
    else if (mod || e.altKey) return;
    else if (k === 'Escape') { if (sel.size) sel.clear(); else if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else return; }
    else if (k.startsWith('Arrow')) {
      const dir = k.slice(5).toLowerCase(), t = neighbor(dir);
      if (t) {
        const it = byId(t.dataset.id);
        if (e.shiftKey) { if (!sel.size) sel.setAnchor(cur); sel.click({ shiftKey: true }, t); }
        setCur(it, { scroll: true });
      }
    }
    else if (k === '/') search.focus();
    else if (k === 'Home') setCur(shown[0], { scroll: true });
    else if (k === 'End') setCur(shown[shown.length - 1], { scroll: true });
    else if (k === ' ') playPause();
    else if (k === 'Enter') fullscreen();
    else if (lk === 'g') act.gif();
    else if (lk === 'c') act.compress();
    else if (lk === 'e') act.editor();
    else if (lk === 'f') cycleFilter(e.shiftKey ? -1 : 1);
    else return;
    e.preventDefault();
  }

  async function onPaste(files) {
    const list = await MS.src.fromFiles(files);
    const img = list.filter((r) => r.kind === 'image'), vid = list.filter((r) => r.kind === 'video' || r.kind === 'gif');
    if (img.length) { MS.ui.toast(`Pasted ${img.length} image${img.length === 1 ? '' : 's'}: opened in Compress.`); MS.go('compress', { refs: img }); }
    else if (vid.length) { MS.ui.toast(`Pasted ${vid.length} clip${vid.length === 1 ? '' : 's'}: opened in the Editor.`); MS.go('editor', { refs: vid }); }
    else MS.ui.toast('Nothing to paste: the Library only shows the folder.', true);
  }

  MS.tab({
    id: 'library', label: 'Library', order: 1,
    icon: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    mount, show, hide, onKey, onPaste,
    keys: [
      { k: '← → ↑ ↓', d: 'Move the current tile (↑ ↓ jump a grid row)' }, { k: 'Shift ←→↑↓', d: 'Extend the selection' }, { k: 'Home End', d: 'First / last capture' },
      { k: 'Space', d: 'Play / pause the preview' }, { k: 'Enter', d: 'Fullscreen preview' }, { k: 'G', d: 'Make GIF (video)' }, { k: 'C', d: 'Compress (screenshots)' },
      { k: 'E', d: 'Add to the editor' }, { k: 'F', d: 'Next filter (Shift: previous)' }, { k: '/', d: 'Search by name' }, { k: 'Ctrl A', d: 'Select all' }, { k: 'Esc', d: 'Clear the selection' },
    ],
    claims: ['/', 'Escape'],
    hotkeys: [{ sel: '[data-q]', k: '/' }, { sel: '[data-fseg]', k: 'F' }, { sel: '.lib-prev [data-acts] .btn:first-child', k: 'G' }],
  });
})();
