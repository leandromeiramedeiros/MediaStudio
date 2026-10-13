/* MS.lib: the library = the folder the user chose. Nothing is copied into it except exports (Exports subfolder).
   The handle lives in IDB (lib.dir); a scan lists media files recursively (depth pref lib.depth), kept fresh by
   FileSystemObserver (else a 4 s poll while visible) and a rescan on focus. */
(() => {
  const { $, esc, kindOf, ext: extOf, stem, pref, setPref, emit, debounce } = MS.util;
  const EXPORTS = 'Exports';
  const lib = { status: 'none', name: '', dir: null, items: [], outLabel: '' };
  let baseline = null;            // ids seen when the app last looked (persisted); fresh = not in it
  let scanning = false, again = false, first = true, observer = null, poll = 0;
  const urls = new Map();         // item id -> { key, url }
  const keyOf = (it) => `${it.id}|${it.size}|${it.mtime}`;

  /* ---------- status ---------- */
  function setStatus(s) { if (lib.status === s) return; lib.status = s; emit('libstatus', s); }
  const perm = async (h, ask) => {
    const o = { mode: 'readwrite' };
    try { let p = await h.queryPermission(o); if (p === 'prompt' && ask) p = await h.requestPermission(o); return p === 'granted'; } catch (e) { return false; }
  };
  /* boot: restore the stored handle. Granted -> ready; otherwise 'denied' until a click reconnects it */
  async function init() {
    let h = null;
    try { h = await MS.db.get('lib.dir'); } catch (e) { /* no IDB */ }
    if (!h) { setStatus('none'); return; }
    lib.dir = h; lib.name = h.name;
    if (await perm(h, false)) await start(); else setStatus('denied');
    refreshOutLabel();
  }
  async function pick() {
    let h;
    try { h = await showDirectoryPicker({ mode: 'readwrite', id: 'ms-lib' }); } catch (e) { return false; }  // cancelled
    return useHandle(h);
  }
  async function reconnect() {
    if (!lib.dir) return pick();
    if (await perm(lib.dir, true)) { await start(); return true; }
    MS.ui.toast('Permission not granted', true); return false;
  }
  async function useHandle(h) {
    if (lib.dir && lib.dir !== h) {
      let same = false; try { same = await lib.dir.isSameEntry(h); } catch (e) { /* different */ }
      if (!same) { baseline = null; try { await MS.db.del('lib.seen'); } catch (e) { /* ignore */ } }
    }
    lib.dir = h; lib.name = h.name;
    try { await MS.db.set('lib.dir', h); } catch (e) { /* keep in memory */ }
    refreshOutLabel();
    await start();
    return true;
  }
  async function start() {
    stop();
    if (baseline === null) {
      try { const s = await MS.db.get('lib.seen'); baseline = s && s.name === lib.name ? new Set(s.ids) : false; } catch (e) { baseline = false; }
    }
    first = true;
    setStatus('ready');
    await scan();
    watch();
  }
  function stop() { try { observer?.disconnect(); } catch (e) { /* ignore */ } observer = null; clearInterval(poll); poll = 0; }

  /* ---------- scan ---------- */
  async function walk(dir, prefix, level, depth, out, pend) {
    for await (const [name, h] of dir.entries()) {
      if (name.startsWith('.')) continue;
      if (h.kind === 'directory') { if (level < depth) await walk(h, prefix + name + '/', level + 1, depth, out, pend); continue; }
      const kind = kindOf(name);
      if (!kind) continue;
      const path = prefix + name;
      pend.push((async () => {
        try {
          const f = await h.getFile();
          out.push({ id: path, name, path, kind, ext: extOf(name), size: f.size, mtime: f.lastModified, handle: h, fresh: false, exported: path.startsWith(EXPORTS + '/') });
        } catch (e) { /* vanished */ }
      })());
      if (pend.length >= 32) await Promise.all(pend.splice(0));
    }
  }
  async function scan() {
    if (lib.status !== 'ready') return;
    if (scanning) { again = true; return; }
    scanning = true;
    try {
      const out = [], pend = [];
      await walk(lib.dir, '', 0, +pref('lib.depth', 3) || 0, out, pend);
      await Promise.all(pend);
      out.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
      const old = new Map(lib.items.map((i) => [i.id, i])), next = new Map(out.map((i) => [i.id, i]));
      const added = [], removed = [], changed = [];
      for (const it of out) {
        const o = old.get(it.id);
        if (!o) added.push(it);
        else if (o.size !== it.size || o.mtime !== it.mtime) changed.push(it);
        else { o.handle = it.handle; next.set(it.id, o); }  // unchanged: keep the object identity
      }
      for (const [id, o] of old) if (!next.has(id)) removed.push(o);
      for (const it of [...removed, ...changed]) dropCaches(it.id);
      const items = out.map((i) => next.get(i.id));
      if (first && baseline === false) baseline = new Set(items.map((i) => i.id));  // first look at this folder: nothing is fresh
      for (const it of items) it.fresh = !it.exported && !baseline.has(it.id);
      const moved = added.length || removed.length || changed.length || items.some((it, i) => lib.items[i] !== it);
      lib.items = items;
      if (first) saveSeen();
      if (moved || first) emit('library', { items, added, removed, changed });
      const caps = added.filter((i) => !i.exported && i.kind !== 'audio');
      if (!first && caps.length) {
        MS.sound('notify');
        MS.ui.toast(caps.length === 1 ? `New capture: ${caps[0].name}` : `${caps.length} new captures`, false, MS.go ? { label: 'Open', fn: () => MS.go('library') } : undefined);
      }
      first = false;
    } catch (e) {
      console.error('library scan', e);
      if (e?.name === 'NotAllowedError' || e?.name === 'NotFoundError') { setStatus('denied'); stop(); }
    } finally {
      scanning = false;
      if (again) { again = false; scan(); }
    }
  }
  const rescan = debounce(scan, 250);
  function watch() {
    if (typeof FileSystemObserver === 'function') {
      try { observer = new FileSystemObserver(() => rescan()); observer.observe(lib.dir, { recursive: true }).catch(() => { observer = null; poller(); }); return; } catch (e) { observer = null; }
    }
    poller();
  }
  function poller() { poll = setInterval(() => { if (document.visibilityState === 'visible') scan(); }, 4000); }
  addEventListener('focus', () => { if (lib.status === 'ready') rescan(); });
  function saveSeen() {
    if (lib.status !== 'ready') return;
    MS.db.set('lib.seen', { name: lib.name, ids: lib.items.map((i) => i.id) }).catch(() => {});
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveSeen(); });
  addEventListener('pagehide', saveSeen);

  /* ---------- files, urls, thumbnails, meta ---------- */
  function dropCaches(id) {
    const u = urls.get(id); if (u) { URL.revokeObjectURL(u.url); urls.delete(id); }
  }
  const file = (it) => it.handle.getFile();
  async function url(it) {
    const f = await file(it), key = `${f.size}|${f.lastModified}`, u = urls.get(it.id);
    if (u && u.key === key) return u.url;
    if (u) URL.revokeObjectURL(u.url);
    const nu = URL.createObjectURL(f); urls.set(it.id, { key, url: nu }); return nu;
  }

  /* at most 2 thumbnail jobs at once; everything that renders a thumbnail goes through here */
  const q = []; let busy = 0;
  const limit = (fn) => new Promise((res, rej) => { q.push({ fn, res, rej }); pump(); });
  function pump() {
    while (busy < 2 && q.length) {
      const j = q.shift(); busy++;
      j.fn().then(j.res, j.rej).finally(() => { busy--; pump(); });
    }
  }
  const TW = 320;
  function videoEl(f) {
    const u = URL.createObjectURL(f), v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = u;
    return { v, free: () => { v.removeAttribute('src'); v.load(); URL.revokeObjectURL(u); } };
  }
  const once = (el, ev, ms = 8000) => new Promise((res, rej) => {
    const t = setTimeout(() => { el.removeEventListener(ev, ok); rej(new Error('timeout ' + ev)); }, ms);
    const ok = () => { clearTimeout(t); res(); };
    el.addEventListener(ev, ok, { once: true });
    el.addEventListener('error', () => { clearTimeout(t); rej(new Error('media error')); }, { once: true });
  });
  const toJpeg = (src, w, h) => {
    const s = Math.min(1, TW / Math.max(w, h)), c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
    const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height); g.drawImage(src, 0, 0, c.width, c.height);
    return new Promise((res) => c.toBlob(res, 'image/jpeg', 0.8));
  };
  /* 320 px JPEG Blob of a File (image: decoded; video: a frame at 10 %); null when it cannot be decoded */
  async function thumbBlob(f, kind) {
    if (kind === 'audio') return null;
    if (kind !== 'video') {
      const bm = await createImageBitmap(f); try { return await toJpeg(bm, bm.width, bm.height); } finally { bm.close(); }
    }
    const { v, free } = videoEl(f);
    try {
      await once(v, 'loadeddata');
      const seeked = once(v, 'seeked'); v.currentTime = (v.duration || 0) * 0.1; await seeked;
      return await toJpeg(v, v.videoWidth, v.videoHeight);
    } finally { free(); }
  }
  const thumbs = new Map();   // cache key -> blob url
  async function thumb(it) {
    if (it.kind === 'audio') return null;
    const key = keyOf(it);
    if (thumbs.has(key)) return thumbs.get(key);
    return limit(async () => {
      if (thumbs.has(key)) return thumbs.get(key);
      let b = null;
      try { b = await MS.db.thumbGet(key); } catch (e) { /* no cache */ }
      if (!b) {
        try { b = await thumbBlob(await file(it), it.kind); } catch (e) { return null; }
        if (b) MS.db.thumbSet(key, b).catch(() => {});
      }
      const u = b ? URL.createObjectURL(b) : null;
      if (u) thumbs.set(key, u);
      return u;
    });
  }
  /* { w, h, dur } of a File */
  async function metaOf(f, kind) {
    if (kind === 'audio') return { w: 0, h: 0, dur: 0 };
    if (kind !== 'video') { const bm = await createImageBitmap(f); const m = { w: bm.width, h: bm.height, dur: 0 }; bm.close(); return m; }
    const { v, free } = videoEl(f);
    try { v.preload = 'metadata'; await once(v, 'loadedmetadata'); return { w: v.videoWidth, h: v.videoHeight, dur: v.duration || 0 }; } finally { free(); }
  }
  const metas = new Map();
  function meta(it) {
    const key = keyOf(it);
    if (!metas.has(key)) metas.set(key, limit(async () => metaOf(await file(it), it.kind)).catch(() => null));
    return metas.get(key);
  }

  /* ---------- export folder ---------- */
  async function outDir() {
    if (pref('out.mode', 'sub') === 'custom') {
      const h = await MS.db.get('out.dir');
      if (h) {
        if (!(await perm(h, true))) throw new Error('The export folder needs permission: choose it again in Settings > Export');
        return h;
      }
    }
    if (!lib.dir || lib.status !== 'ready') throw new Error('Choose a library folder first');
    return lib.dir.getDirectoryHandle(EXPORTS, { create: true });
  }
  async function pickOut() {
    let h;
    try { h = await showDirectoryPicker({ mode: 'readwrite', id: 'ms-out' }); } catch (e) { return null; }
    await MS.db.set('out.dir', h); setPref('out.mode', 'custom'); refreshOutLabel(); emit('outdir', h);
    return h;
  }
  function useLibraryOut() { setPref('out.mode', 'sub'); refreshOutLabel(); emit('outdir', null); }
  async function refreshOutLabel() {
    let l = lib.name ? `${lib.name}/${EXPORTS}` : EXPORTS;
    if (pref('out.mode', 'sub') === 'custom') { try { const h = await MS.db.get('out.dir'); if (h) l = h.name; } catch (e) { /* keep default */ } }
    if (l !== lib.outLabel) { lib.outLabel = l; emit('outdir', null); }
  }
  /* write a Blob into dir; never overwrites: "name.gif", "name (2).gif", ... */
  async function write(dir, fileName, blob) {
    const s = stem(fileName), e = extOf(fileName) ? '.' + extOf(fileName) : '';
    let name = fileName;
    for (let n = 2; ; n++) {
      try { await dir.getFileHandle(name); } catch (err) { if (err.name === 'NotFoundError') break; throw err; }
      name = `${s} (${n})${e}`;
    }
    const handle = await dir.getFileHandle(name, { create: true }), w = await handle.createWritable();
    try { await w.write(blob); await w.close(); } catch (err) { try { await w.abort(); } catch (e2) { /* ignore */ } throw err; }
    rescan();
    return { name, size: blob.size, handle };
  }

  Object.assign(lib, { init, pick, reconnect, useHandle, rescan: scan, file, url, thumb, meta, outDir, pickOut, useLibraryOut, write,
    // shared by MS.src and the export tab
    thumbBlob, metaOf, limit, saveSeen, EXPORTS });
  MS.lib = lib;
})();
