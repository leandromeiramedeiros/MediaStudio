/* Compress tab: screenshots -> JPEG or WebP at a target size or a quality, long edge capped. Exports queue as 'image' jobs. */
(() => {
  const { $, $$, h, fmtBytes, stem, debounce, clamp } = MS.util;

  const FMT = [['JPEG', 'jpeg'], ['WebP', 'webp']];
  const MODE = [['Target size', 'target'], ['Quality', 'quality']];
  const RES = [['Source', 0], ['4K', 3840], ['1440p', 2560], ['1080p', 1920], ['720p', 1280]];
  const DEF = { fmt: 'jpeg', mode: 'target', mb: 1.8, q: 85, res: 0 };
  const ICON = '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>';
  const CSS = `
.cp-cmp { position: relative; user-select: none; touch-action: none; cursor: ew-resize; --p: 50%; }
.cp-cmp .cp-top { position: absolute; inset: 0; width: 100%; height: 100%; max-height: none; clip-path: inset(0 0 0 var(--p)); }
.cp-cmp .cp-div { position: absolute; top: 0; bottom: 0; left: var(--p); width: 2px; margin-left: -1px; background: #fff; box-shadow: 0 0 0 1px rgba(0, 0, 0, .35); pointer-events: none; }
.cp-cmp .cp-div::after { content: ""; position: absolute; top: 50%; left: 50%; width: 26px; height: 26px; margin: -13px 0 0 -13px; border-radius: 50%; background: #fff; box-shadow: 0 2px 8px rgba(0, 0, 0, .4); }
.cp-tag { position: absolute; top: 8px; padding: 4px 6px; border-radius: 4px; background: rgba(0, 0, 0, .6); color: #fff; font: 600 10.5px/1 var(--f-mono); pointer-events: none; }
.cp-tag.l { left: 8px; } .cp-tag.r { right: 8px; }
.cp-busy { position: absolute; right: 8px; bottom: 8px; display: flex; align-items: center; gap: 6px; padding: 5px 9px; border-radius: 99px; background: rgba(0, 0, 0, .6); color: #fff; font-size: 12px; }
.cp-spin { width: 12px; height: 12px; border: 2px solid rgba(255, 255, 255, .3); border-top-color: #fff; border-radius: 50%; animation: spin .7s linear infinite; }
.cp-x { position: absolute; top: 6px; right: 6px; z-index: 2; }
.tile .badge b.err { background: var(--danger); color: #fff; }
.cp-go { width: 100%; }
`;
  const MARKUP = `
<div class="page-head"><div><h2>Compress</h2><p>Screenshots to JPEG or WebP at a target size or a quality. Results go to the Exporter.</p></div></div>
<div class="split">
  <div>
    <div class="card">
      <h3>Preview</h3>
      <div class="viewer cp-cmp" data-cmp hidden>
        <img data-orig alt="">
        <img class="cp-top" data-new alt="">
        <div class="cp-div"></div>
        <span class="cp-tag l">original</span><span class="cp-tag r">compressed</span>
        <div class="cp-busy" data-busy hidden><i class="cp-spin"></i>encoding</div>
      </div>
      <div class="empty" data-pv-empty>Select an image to preview its compression.</div>
      <div class="small num mt-3" data-sizes></div>
    </div>
    <div class="card">
      <div class="row"><h3 class="grow">Sources</h3><span class="small dim" data-count></span><button class="btn sm" data-all>All</button><button class="btn sm" data-none>None</button><button class="btn sm" data-add>Add images…</button></div>
      <div data-grid></div>
    </div>
  </div>
  <div>
    <div class="card">
      <h3>Settings</h3>
      <div class="field"><label class="lab">Format</label><div class="seg" data-fmt></div></div>
      <div class="field"><label class="lab">Mode</label><div class="seg" data-mode></div></div>
      <div class="field" data-target><label class="lab">Target size per image (MB)</label><input class="input num" type="number" min="0.1" step="0.1" data-mb></div>
      <div class="field" data-quality hidden><label class="lab">Quality</label><div class="slider"><input type="range" min="40" max="100" step="1" data-q><span class="auto num" data-qv></span></div></div>
      <div class="field"><label class="lab">Max long edge</label><div class="seg" data-res></div></div>
    </div>
    <div class="card">
      <button class="btn primary cp-go" data-export>Export</button>
      <p class="hint">Results go to the Exporter. <button class="btn ghost sm" data-goexp>Open Exporter</button></p>
    </div>
  </div>
</div>`;

  let root, sel, cur = null, loaded = Promise.resolve(), seq = 0, outUrl = null, pvT = 0, split = 50;
  const st = { ...DEF, ext: [] };
  const $r = (s) => $(s, root);
  const rid = (r) => (typeof r === 'string' ? r : r.ref);
  const imgs = () => [
    ...st.ext.filter((r) => r.kind === 'image'),
    ...(MS.lib.items || []).filter((i) => i.kind === 'image').map((i) => MS.src.fromLib(i)),
  ];
  const find = (id) => imgs().find((r) => r.ref === id);
  const busy = (on) => { $r('[data-busy]').hidden = !on; };
  const save = debounce(() => MS.db.set('compress.state', { ...st }).catch(() => {}), 300);

  /* encode one file with the settings s (fmt, mode, mb, q, res): resize, then JPEG/WebP at the target or quality */
  async function encode(file, s, ctx) {
    const bmp = await createImageBitmap(file);
    const long = Math.max(bmp.width, bmp.height), k = s.res && long > s.res ? s.res / long : 1;
    const tw = Math.round(bmp.width * k), th = Math.round(bmp.height * k);
    const jpeg = s.fmt !== 'webp', ext = jpeg ? 'jpg' : 'webp', mime = jpeg ? 'image/jpeg' : 'image/webp';
    const draw = (w, hh, src) => {
      const c = Object.assign(document.createElement('canvas'), { width: w, height: hh }), x = c.getContext('2d');
      x.imageSmoothingQuality = 'high';
      if (jpeg) { x.fillStyle = '#fff'; x.fillRect(0, 0, w, hh); }
      x.drawImage(src, 0, 0, w, hh);
      return c;
    };
    let src = bmp, sw = bmp.width, sh = bmp.height;
    while (sw > tw * 2 || sh > th * 2) { // halve step by step: one big drop aliases
      ctx.check();
      src = draw(Math.max(tw, Math.ceil(sw / 2)), Math.max(th, Math.ceil(sh / 2)), src);
      sw = src.width; sh = src.height;
    }
    const c = draw(tw, th, src);
    bmp.close();
    ctx.check(); ctx.progress(0.3, 'encoding');
    const enc = async (q) => {
      const b = await new Promise((res) => c.toBlob(res, mime, q));
      if (!b) throw new Error('encode failed');
      return b;
    };
    if (s.mode === 'quality') return { blob: await enc(s.q / 100), ext, label: `${tw}×${th} · q ${s.q}` };
    const target = Math.min(Math.round(s.mb * 1e6), file.size), out = (blob, q, over) => ({
      blob, ext, label: `${tw}×${th} · q ${Math.round(q * 100)}${over ? ' · over target' : ''}`,
    });
    let lo = 0.05, hi = 0.98, best = await enc(lo);
    if (best.size > target) return out(best, lo, true);
    const top = await enc(hi);
    if (top.size <= target) return out(top, hi, false);
    let bestQ = lo;
    for (let i = 0; i < 9; i++) { // largest quality whose blob fits the target
      ctx.check(); ctx.progress(0.3 + i * 0.07, `quality ${i + 1}/9`);
      const mid = (lo + hi) / 2, b = await enc(mid);
      if (b.size <= target) { lo = mid; best = b; bestQ = mid; } else hi = mid;
    }
    return out(best, bestQ, false);
  }

  MS.queue.runner('image', async (job, ctx) => {
    ctx.progress(0.02, 'loading');
    const r = await encode(await MS.src.file(job.params.ref), job.params, ctx);
    return { blob: r.blob, ext: r.ext, label: r.label };
  });

  const pvCtx = (my) => ({ check() { if (my !== seq) throw new Error('stale'); }, progress() {} });

  async function preview() {
    const my = ++seq, r = find(cur);
    $r('[data-pv-empty]').hidden = !!r;
    $r('[data-cmp]').hidden = !r;
    if (!r) return;
    busy(true); $r('[data-sizes]').textContent = 'encoding…';
    try {
      $r('[data-orig]').src = await MS.src.url(r);
      const res = await encode(await MS.src.file(r), st, pvCtx(my));
      if (my !== seq) return;
      if (outUrl) URL.revokeObjectURL(outUrl);
      outUrl = URL.createObjectURL(res.blob);
      $r('[data-new]').src = outUrl;
      $r('[data-sizes]').textContent = `${fmtBytes(r.size)} → ${fmtBytes(res.blob.size)} · ${res.label}`;
    } catch (e) {
      if (my === seq && e.message !== 'stale') $r('[data-sizes]').textContent = e.message;
    } finally { if (my === seq) busy(false); }
  }
  const schedulePreview = (ms = 250) => { clearTimeout(pvT); pvT = setTimeout(preview, ms); };

  function setCmp(p) {
    split = clamp(p, 0, 100);
    $r('[data-cmp]').style.setProperty('--p', split + '%');
  }
  function bindCmp() {
    const box = $r('[data-cmp]');
    let drag = false;
    const at = (e) => { const b = box.getBoundingClientRect(); setCmp((e.clientX - b.left) / b.width * 100); };
    box.onpointerdown = (e) => { drag = true; box.setPointerCapture(e.pointerId); at(e); };
    box.onpointermove = (e) => { if (drag) at(e); };
    box.onpointerup = box.onpointercancel = () => { drag = false; };
  }

  const seg = (s, opts, current, pick) => MS.ui.seg($r(s), opts, current, pick);
  function paintSettings() {
    seg('[data-fmt]', FMT, st.fmt, (v) => set('fmt', v));
    seg('[data-mode]', MODE, st.mode, (v) => set('mode', v));
    seg('[data-res]', RES, st.res, (v) => set('res', v));
    const mb = $r('[data-mb]');
    if (document.activeElement !== mb) mb.value = st.mb;
    const q = $r('[data-q]');
    q.value = st.q; q.style.setProperty('--rp', (st.q - 40) / 60);
    $r('[data-qv]').textContent = `q ${st.q}`;
    $r('[data-target]').hidden = st.mode !== 'target';
    $r('[data-quality]').hidden = st.mode !== 'quality';
    paintCount();
  }
  function set(k, v) { st[k] = v; save(); paintSettings(); schedulePreview(); }

  const tiles = () => $$('.tile', $r('[data-grid]'));
  function paintSel() {
    tiles().forEach((t) => t.classList.toggle('cur', t.dataset.id === cur));
    paintCount();
  }
  function paintCount() {
    const n = sel.size, b = $r('[data-export]');
    $r('[data-count]').textContent = `${n} selected`;
    b.disabled = !n;
    b.textContent = `Export ${n} image${n === 1 ? '' : 's'}`;
  }
  function paintJobs() {
    const last = new Map();
    for (const j of MS.queue.jobs()) if (j.type === 'image' && j.params?.ref) last.set(j.params.ref.ref, j);
    $$('.tile', $r('[data-grid]')).forEach((t) => {
      t.querySelectorAll('.cp-st').forEach((n) => n.remove());
      const j = last.get(t.dataset.id);
      if (!j) return;
      const txt = { queued: 'queued', running: `${Math.round((j.progress || 0) * 100)}%`, done: 'exported', error: 'error', cancelled: 'cancelled' }[j.status] || j.status;
      const cls = { running: 'mark', done: 'ok', error: 'err' }[j.status] || '';
      badge(t).append(h(`<b class="cp-st ${cls}">${txt}</b>`));
    });
  }
  function badge(t) {
    let b = t.querySelector('.badge');
    if (!b) { b = h('<div class="badge"></div>'); t.append(b); }
    return b;
  }

  function tileOf(r) {
    const t = MS.ui.tile(r, {});
    t.dataset.id = r.ref;
    if (r.ref.startsWith('ext:')) {
      badge(t).append(h('<b class="mark">external</b>'));
      const x = h(`<button class="btn icon-btn cp-x" title="Remove from list"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`);
      x.onclick = (e) => { e.stopPropagation(); removeExt(r); };
      t.append(x);
    }
    return t;
  }

  function drawGrid() {
    const g = $r('[data-grid]'), list = imgs();
    g.innerHTML = '';
    if (!list.length) {
      const hint = MS.lib.status === 'ready' ? 'No screenshots in the library yet.' : 'No library folder yet. Choose one in the Library tab.';
      g.append(h(`<div class="empty">${hint}<br><span class="small dim">Add images, or paste them with Ctrl+V.</span></div>`));
    } else {
      const grid = h('<div class="grid"></div>');
      for (const r of list) grid.append(tileOf(r));
      g.append(grid);
    }
    sel.prune(new Set(list.map((r) => r.ref)));
    const before = cur;
    ensureCur();
    if (cur !== before) schedulePreview(0);
    paintSel();
    paintJobs();
  }

  function ensureCur() {
    const list = imgs();
    if (list.some((r) => r.ref === cur)) return;
    const pick = list.find((r) => sel.has(r.ref)) || list[0];
    cur = pick ? pick.ref : null;
  }

  function setSel(ids) {
    sel.clear();
    for (const t of tiles()) if (ids.includes(t.dataset.id)) sel.click({ ctrlKey: true }, t);
    if (ids.length) cur = ids[0];
    paintSel();
  }

  function step(d) {
    const list = imgs();
    if (!list.length) return;
    const i = list.findIndex((r) => r.ref === cur);
    cur = list[clamp((i < 0 ? 0 : i + d), 0, list.length - 1)].ref;
    paintSel();
    const t = tiles().find((x) => x.dataset.id === cur);
    t?.scrollIntoView({ block: 'nearest' });
    schedulePreview(0);
  }

  function removeExt(r) {
    st.ext = st.ext.filter((x) => x.ref !== r.ref);
    MS.src.forget(r);
    save();
    if (cur === r.ref) cur = null;
    drawGrid();
    schedulePreview(0);
  }

  async function addRefs(refs, select = true) {
    const fresh = refs.filter((r) => r.kind === 'image' && r.ref.startsWith('ext:') && !st.ext.some((x) => x.ref === r.ref));
    st.ext = [...fresh.map((r) => ({ ...r })), ...st.ext];
    save();
    drawGrid();
    if (select) {
      const ids = refs.filter((r) => r.kind === 'image').map((r) => r.ref);
      if (ids.length) { setSel(ids); schedulePreview(0); }
    }
  }

  async function addImages() {
    const picked = await MS.src.choose({ title: 'Add images', kinds: ['image'], multiple: true });
    if (picked?.length) await addRefs(picked);
  }

  function exportSel() {
    const list = imgs().filter((r) => sel.has(r.ref));
    if (!list.length) return MS.ui.toast('Select images to export.', true);
    const label = `${st.fmt === 'webp' ? 'WebP' : 'JPEG'} · ${st.mode === 'target' ? '≤ ' + st.mb + ' MB' : 'q ' + st.q} · ${RES.find((x) => x[1] === st.res)[0]}`;
    for (const r of list) {
      const ref = { ...r }, name = stem(r.name);
      MS.queue.add({
        type: 'image', name, title: `${name} · ${label}`, ref,
        params: { ref, fmt: st.fmt, mode: st.mode, mb: st.mb, q: st.q, res: st.res },
      });
    }
    MS.ui.toast(`Queued ${list.length} image${list.length === 1 ? '' : 's'}. Results go to the Exporter.`);
  }

  async function load() {
    try { Object.assign(st, DEF, (await MS.db.get('compress.state')) || {}); } catch (e) { /* first run */ }
    paintSettings();
    drawGrid();
  }

  function selectEvents() {
    $r('[data-grid]').addEventListener('click', (e) => {
      const t = e.target.closest('.tile');
      if (!t || e.target.closest('.cp-x')) return;
      if (!sel.click(e, t)) { sel.clear(); sel.click({ ctrlKey: true }, t); } // plain click: this one only
      cur = t.dataset.id;
      paintSel();
      schedulePreview(0);
    });
  }

  function injectCss() {
    if (document.getElementById('cp-css')) return;
    document.head.append(Object.assign(document.createElement('style'), { id: 'cp-css', textContent: CSS }));
  }

  MS.tab({
    id: 'compress',
    label: 'Compress',
    order: 3,
    icon: ICON,
    mount(el) {
      root = el;
      injectCss();
      el.innerHTML = MARKUP;
      sel = MS.ui.selection($r('[data-grid]'), '.tile', { onChange: paintSel });
      $r('[data-mb]').onchange = (e) => set('mb', clamp(+e.target.value || DEF.mb, 0.1, 500));
      $r('[data-q]').oninput = (e) => set('q', +e.target.value);
      $r('[data-all]').onclick = () => sel.all();
      $r('[data-none]').onclick = () => sel.clear();
      $r('[data-add]').onclick = addImages;
      $r('[data-export]').onclick = exportSel;
      $r('[data-goexp]').onclick = () => MS.go('export');
      selectEvents();
      bindCmp();
      setCmp(split);
      loaded = load();
      MS.util.on('library', () => { if (root && sel) drawGrid(); });
      MS.util.on('queue', () => { if (root && sel) paintJobs(); });
    },
    async show(arg) {
      await loaded;
      const refs = arg?.refs || [];
      const ext = refs.filter((r) => typeof r !== 'string' && r.ref.startsWith('ext:'));
      if (ext.length) await addRefs(ext, false);
      drawGrid();
      if (refs.length) setSel(refs.map(rid).filter((id) => find(id)));
      schedulePreview(0);
    },
    hide() {},
    onKey(e) {
      if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); exportSel(); return; }
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.altKey || e.metaKey) return;
      const k = e.key.toLowerCase();
      if (e.ctrlKey && k === 'a') { e.preventDefault(); sel.all(); }
      else if (k === 'escape') sel.clear();
      else if (k === 'arrowleft') { e.preventDefault(); step(-1); }
      else if (k === 'arrowright') { e.preventDefault(); step(1); }
      else if (k === 'j' && !e.ctrlKey) set('fmt', 'jpeg');
      else if (k === 'w' && !e.ctrlKey) set('fmt', 'webp');
    },
    keys: [
      { k: 'Ctrl+A', d: 'Select all images' },
      { k: 'Esc', d: 'Clear selection' },
      { k: '← →', d: 'Previous / next image (preview)' },
      { k: 'J / W', d: 'JPEG / WebP' },
      { k: 'Ctrl+Enter', d: 'Export selection' },
    ],
    claims: ['a', 'Escape', 'ArrowLeft', 'ArrowRight', 'j', 'w'],
    hotkeys: [
      { sel: '[data-fmt] button:first-child', k: 'J' },
      { sel: '[data-fmt] button:last-child', k: 'W' },
      { sel: '[data-export]', k: 'Ctrl+Enter' },
    ],
    async onPaste(files) {
      const refs = await MS.src.fromFiles(files);
      const imagesOnly = refs.filter((r) => r.kind === 'image');
      refs.filter((r) => r.kind !== 'image').forEach((r) => MS.src.forget(r));
      if (!imagesOnly.length) return MS.ui.toast('No images in the paste.', true);
      await addRefs(imagesOnly);
    },
  });
})();
