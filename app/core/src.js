/* MS.src: media refs, what a tool works on. A ref is a plain cloneable { ref, name, kind, size }:
   ref = 'lib:<item id>' (a library file) or 'ext:<id>' (a file picked from disk or pasted; its handle / Blob lives in IDB src.<id>). */
(() => {
  const { $, h, esc, kindOf, ext: extOf, uid } = MS.util;
  const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/avif': 'avif',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg' };
  const ACCEPT = {
    video: { 'video/*': ['.mp4', '.mkv', '.mov', '.webm', '.m4v', '.avi'] },
    image: { 'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.avif'] },
    gif: { 'image/gif': ['.gif'] },
    audio: { 'audio/*': ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.opus'] },
  };
  const urls = new Map(), thumbs = new Map(), metas = new Map();

  const isLib = (r) => r.ref.startsWith('lib:');
  const item = (r) => MS.lib.items.find((i) => i.id === r.ref.slice(4));
  const fromLib = (it) => ({ ref: 'lib:' + it.id, name: it.name, kind: it.kind, size: it.size });

  /* files from a paste / drop DataTransfer: clipboard files, else dropped files (media only) */
  function filesOf(dt) {
    const out = [...(dt?.files || [])];
    return out.filter((f) => kindOf(f.name) || MIME_EXT[f.type]);
  }
  const stamp = () => new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  async function fromFiles(list) {
    const refs = [];
    for (const x of list) {
      try {
        let name, size, rec;
        if (x.kind === 'file' && x.getFile) { const f = await x.getFile(); name = f.name; size = f.size; rec = { handle: x, name }; }
        else {
          name = x.name || '';
          if (!kindOf(name)) { const e = MIME_EXT[x.type]; if (!e) continue; name = `pasted-${stamp()}.${e}`; }
          size = x.size; rec = { blob: x, name };
        }
        const kind = kindOf(name);
        if (!kind) continue;
        const id = uid();
        await MS.db.set('src.' + id, rec);
        refs.push({ ref: 'ext:' + id, name, kind, size });
      } catch (e) { console.warn('src.fromFiles', e); }
    }
    return refs;
  }
  async function pick({ kinds = ['video', 'image', 'gif'], multiple = false } = {}) {
    const accept = Object.assign({}, ...kinds.map((k) => ACCEPT[k]));
    let hs;
    try { hs = await showOpenFilePicker({ multiple, id: 'ms-src', types: [{ description: kinds.join(', '), accept }] }); } catch (e) { return []; }
    return fromFiles(hs);
  }

  async function file(r) {
    if (isLib(r)) {
      const it = item(r);
      if (!it) throw new Error(`${r.name} is no longer in the library`);
      return MS.lib.file(it);
    }
    const rec = await MS.db.get('src.' + r.ref.slice(4));
    if (!rec) throw new Error(`${r.name} is gone, choose it again`);
    if (rec.blob) return rec.blob instanceof File ? rec.blob : new File([rec.blob], rec.name, { type: rec.blob.type });
    try { return await rec.handle.getFile(); } catch (e) {
      try { if ((await rec.handle.requestPermission({ mode: 'read' })) === 'granted') return await rec.handle.getFile(); } catch (e2) { /* needs a click */ }
      throw new Error(`Allow access to ${r.name} (choose it again)`);
    }
  }
  async function url(r) {
    if (isLib(r)) { const it = item(r); if (!it) throw new Error(`${r.name} is no longer in the library`); return MS.lib.url(it); }
    if (urls.has(r.ref)) return urls.get(r.ref);
    const u = URL.createObjectURL(await file(r)); urls.set(r.ref, u); return u;
  }
  async function thumb(r) {
    if (isLib(r)) { const it = item(r); return it ? MS.lib.thumb(it) : null; }
    if (r.kind === 'audio') return null;
    if (thumbs.has(r.ref)) return thumbs.get(r.ref);
    return MS.lib.limit(async () => {
      try { const b = await MS.lib.thumbBlob(await file(r), r.kind), u = b ? URL.createObjectURL(b) : null; if (u) thumbs.set(r.ref, u); return u; } catch (e) { return null; }
    });
  }
  function meta(r) {
    if (isLib(r)) { const it = item(r); return it ? MS.lib.meta(it) : Promise.resolve(null); }
    if (!metas.has(r.ref)) metas.set(r.ref, MS.lib.limit(async () => MS.lib.metaOf(await file(r), r.kind)).catch(() => null));
    return metas.get(r.ref);
  }
  function forget(r) {
    if (isLib(r)) return;
    for (const m of [urls, thumbs]) { if (m.has(r.ref)) { URL.revokeObjectURL(m.get(r.ref)); m.delete(r.ref); } }
    metas.delete(r.ref);
    MS.db.del('src.' + r.ref.slice(4)).catch(() => {});
  }

  /* THE picker every tool uses: the library grid (filtered by kinds), "From disk…", and Ctrl+V / drop inside the modal */
  function choose({ title = 'Choose media', kinds = ['video', 'image', 'gif'], multiple = false } = {}) {
    const items = MS.lib.items.filter((i) => kinds.includes(i.kind));
    const body = h(`<div><div class="row mb-3"><button class="btn" data-disk type="button">From disk…</button><span class="hint grow" style="margin:0">or paste a file here with Ctrl+V, or drop it</span></div><div class="grid small" data-g></div></div>`);
    const g = $('[data-g]', body), chosen = new Map();
    let p, useBtn;
    const done = (refs) => p.close(refs.length ? refs : null);
    const paintCount = () => { if (useBtn) { useBtn.textContent = chosen.size ? `Use ${chosen.size} selected` : 'Use selected'; useBtn.disabled = !chosen.size; } };
    if (!items.length) g.replaceWith(h(`<div class="empty small">${MS.lib.status === 'ready' ? 'No matching files in the library yet.' : 'No library folder yet.'} Use From disk…</div>`));
    for (const it of items) {
      const r = fromLib(it);
      const t = MS.ui.tile(it, { onClick: () => {
        if (!multiple) return done([r]);
        if (chosen.has(r.ref)) { chosen.delete(r.ref); t.classList.remove('sel'); } else { chosen.set(r.ref, r); t.classList.add('sel'); }
        paintCount();
      } });
      g.append(t);
    }
    const buttons = [{ label: 'Cancel', value: null }];
    if (multiple) buttons.push({ label: 'Use selected', primary: true, get: () => [...chosen.values()] });
    p = MS.ui.modal(title, body, buttons);
    if (multiple) { useBtn = $('footer .btn.primary', p.el); paintCount(); }
    $('[data-disk]', body).onclick = async () => { const refs = await pick({ kinds, multiple }); if (refs.length) done(refs); };
    const addFiles = async (files) => { const refs = await fromFiles(files.filter((f) => kinds.includes(kindOf(f.name) || kindOf('x.' + MIME_EXT[f.type])))); if (refs.length) done(multiple ? refs : refs.slice(0, 1)); else MS.ui.toast('Nothing usable in that paste', true); };
    const onPaste = (e) => { const fs = filesOf(e.clipboardData); if (!fs.length) return; e.preventDefault(); e.stopPropagation(); addFiles(fs); };
    document.addEventListener('paste', onPaste, true);
    p.el.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
    p.el.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); const fs = filesOf(e.dataTransfer); if (fs.length) addFiles(fs); });
    const out = p.then((v) => { document.removeEventListener('paste', onPaste, true); return v; });
    return out;
  }

  MS.src = { fromLib, fromFiles, pick, choose, file, url, thumb, meta, forget, item, isLib, filesOf };
})();
