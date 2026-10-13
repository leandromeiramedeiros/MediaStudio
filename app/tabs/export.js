/* Tab "export": the Exporter. GIF, Compress and Editor hand their work to MS.queue; this tab shows the queue, the finished
   history (preview, copy, save a copy, retry) and where files go. MS.exportConfig(box) draws the destination + file-name rows
   (also used by Settings > Export). */
(() => {
  const { $, $$, h, esc, fmtBytes, kindOf, pref, setPref, on, baseName } = MS.util;
  const ic = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICON = {
    eye: ic('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
    copy: ic('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>'),
    save: ic('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
    retry: ic('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
    x: ic('<path d="M6 6l12 12M18 6L6 18"/>'),
    stop: ic('<rect x="6" y="6" width="12" height="12" rx="2"/>'),
    gif: ic('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 10v4M11 10v4M14 10h3M14 12h2"/>'),
    image: ic('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/>'),
    video: ic('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9.5v5l4-2.5z"/>'),
    pause: ic('<path d="M8 5v14M16 5v14"/>'),
    play: ic('<path d="M7 5l12 7-12 7z"/>'),
  };
  const TYPE = { gif: 'GIF', image: 'Image', video: 'Video' };
  const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : new Date(t).toLocaleDateString(); };

  /* ---------- destination + file-name rows (Export tab and Settings) ---------- */
  function exportConfig(box) {
    const el = h(`<div class="xcfg">
      <div class="set-row"><div class="grow"><div class="set-t">Destination</div><div class="small dim" data-dnote></div></div>
        <div class="set-ctl"><span class="pill" data-dest><span class="i i-folder"></span><span data-dl></span></span><button class="btn sm" data-change type="button">Change…</button><button class="btn ghost sm" data-lib type="button">Use library Exports</button></div></div>
      <div class="set-row"><div class="grow"><div class="set-t">File name</div><div class="small dim">Tokens <span class="mono">{name}</span> <span class="mono">{date}</span> <span class="mono">{time}</span> <span class="mono">{type}</span>. Never overwrites: a number is added. Example: <span class="mono" data-ex></span></div></div>
        <div class="set-ctl"><input class="input mono" data-pat style="width:230px" spellcheck="false" autocomplete="off"></div></div></div>`);
    const draw = () => {
      const custom = pref('out.mode', 'sub') === 'custom';
      $('[data-dl]', el).textContent = MS.lib.outLabel || 'Exports';
      $('[data-dnote]', el).textContent = custom ? 'A folder you chose. The library does not list it.' : MS.lib.status === 'ready' ? 'An Exports folder inside your library (created on first export), so exports show up in the Library too.' : 'Choose a library folder first, or pick any folder with Change…';
      $('[data-lib]', el).hidden = !custom;
      $('[data-ex]', el).textContent = MS.queue.fileStem({ name: 'clip.mp4', type: 'gif' }) + '.gif';
    };
    $('[data-pat]', el).value = pref('out.pattern', '{name}');
    $('[data-pat]', el).oninput = (e) => { setPref('out.pattern', e.target.value || '{name}'); draw(); };
    $('[data-change]', el).onclick = () => MS.lib.pickOut();
    $('[data-lib]', el).onclick = () => MS.lib.useLibraryOut();
    const offs = [on('outdir', draw), on('libstatus', draw)];
    const watch = new MutationObserver(() => { if (!el.isConnected) { offs.forEach((f) => f()); watch.disconnect(); } });
    watch.observe(document.body, { childList: true, subtree: true });
    draw(); box.append(el);
    return el;
  }
  MS.exportConfig = exportConfig;

  /* ---------- tab ---------- */
  let root, qBox, dBox, empty, sel, active = false, dirty = true;
  const thumbs = new Map();  // job id -> blob url (or '' when the file is gone)

  async function outFile(j) { return j.out?.handle ? j.out.handle.getFile() : null; }
  async function loadThumb(j, img, row) {
    if (thumbs.has(j.id)) { if (thumbs.get(j.id)) img.src = thumbs.get(j.id); else row.classList.add('gone'); return; }
    try {
      const f = await outFile(j);
      if (!f) throw new Error('no file');
      const b = await MS.lib.limit(() => MS.lib.thumbBlob(f, kindOf(j.out.file)));
      const u = b ? URL.createObjectURL(b) : '';
      thumbs.set(j.id, u); if (u) img.src = u;
    } catch (e) { thumbs.set(j.id, ''); row.classList.add('gone'); }
  }

  async function preview(j) {
    let f;
    try { f = await outFile(j); } catch (e) { return MS.ui.toast('That file is gone', true); }
    if (!f) return;
    const u = URL.createObjectURL(f), box = h('<div class="xprev"></div>');
    box.append(MS.ui.mediaViewer(u, kindOf(j.out.file) || 'image'));
    await MS.ui.modal(j.out.file, box, [{ label: 'Save a copy…', value: 'save' }, { label: 'Close', value: null, primary: true }]).then((v) => { if (v === 'save') saveCopy(j); });
    URL.revokeObjectURL(u);
  }
  async function copy(j) {
    try {
      const f = await outFile(j);
      if (kindOf(j.out.file) === 'image') {
        const bm = await createImageBitmap(f), c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height; c.getContext('2d').drawImage(bm, 0, 0); bm.close();
        const png = await new Promise((res) => c.toBlob(res, 'image/png'));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
        MS.ui.toast('Image copied');
      } else { await navigator.clipboard.writeText(j.out.file); MS.ui.toast('File name copied'); }
    } catch (e) { MS.ui.toast('Could not copy: ' + (e.message || e), true); }
  }
  async function saveCopy(j) {
    try {
      const f = await outFile(j), ext = j.out.file.split('.').pop();
      const h2 = await showSaveFilePicker({ suggestedName: j.out.file, types: [{ description: ext.toUpperCase(), accept: { [f.type || 'application/octet-stream']: ['.' + ext] } }] });
      const w = await h2.createWritable(); await w.write(f); await w.close();
      MS.ui.toast('Saved ' + h2.name);
    } catch (e) { if (e.name !== 'AbortError') MS.ui.toast('Could not save: ' + (e.message || e), true); }
  }

  const btn = (act, title, icon, cls = '') => `<button class="btn ghost icon-btn ${cls}" data-act="${act}" title="${esc(title)}" type="button">${icon}</button>`;
  function queueRow(j) {
    const row = h(`<div class="item xrow" data-id="${j.id}"><div class="xthumb">${ICON[j.type] || ICON.image}</div>
      <div class="grow xmeta"><div class="xt">${esc(j.title || j.name)}</div><div data-s></div></div>${btn('cancel', 'Cancel', ICON.stop)}</div>`);
    if (j.status === 'running') { const pb = MS.ui.progressBar(); row._pb = pb; $('[data-s]', row).append(pb); paintBar(j, pb); row.classList.add('running'); }
    else $('[data-s]', row).append(h('<div class="small dim">' + (MS.queue.paused() ? 'Paused' : 'Waiting') + '</div>'));
    return row;
  }
  const paintBar = (j, pb) => pb.set(j.progress, j.text || (j.progress != null ? Math.round(j.progress * 100) + '%' : 'Working…'));
  function doneRow(j) {
    const failed = j.status !== 'done', o = j.out;
    const meta = failed ? '' : [TYPE[j.type] || j.type, fmtBytes(o.size), o.label, ago(j.ended || j.at)].filter(Boolean).join(' · ');
    const row = h(`<div class="item xrow xdone ${failed ? 'failed' : ''}" data-id="${j.id}" tabindex="0">
      <div class="xthumb">${failed ? ICON[j.type] || ICON.image : '<img alt="" draggable="false">'}</div>
      <div class="grow xmeta"><div class="xt">${esc(failed ? (j.title || j.name) : o.file)}</div>
        <div class="small dim">${failed ? (j.status === 'cancelled' ? 'Cancelled' : `<span class="xerr">${esc(j.error || 'Failed')}</span>`) : esc(meta)}</div></div>
      <div class="xacts">${failed ? btn('retry', 'Retry', ICON.retry) : btn('preview', 'Preview (Enter)', ICON.eye) + btn('copy', kindOf(o.file) === 'image' ? 'Copy image' : 'Copy file name', ICON.copy) + btn('save', 'Save a copy…', ICON.save)}${btn('remove', 'Remove from list (Del)', ICON.x)}</div></div>`);
    if (!failed) loadThumb(j, $('img', row), row);
    return row;
  }

  function render() {
    dirty = false;
    const jobs = MS.queue.jobs(), pending = jobs.filter((j) => j.status === 'queued' || j.status === 'running');
    const done = jobs.filter((j) => !pending.includes(j)).sort((a, b) => (b.ended || b.at) - (a.ended || a.at));
    qBox.replaceChildren(...pending.map(queueRow));
    $('[data-qn]', root).textContent = pending.length ? String(pending.length) : '';
    $('[data-qs]', root).hidden = !pending.length;
    dBox.replaceChildren(...done.map(doneRow));
    $('[data-ds]', root).hidden = !done.length;
    $('[data-clear]', root).disabled = !done.length;
    empty.hidden = !!jobs.length;
    const p = MS.queue.paused();
    const pb = $('[data-pause]', root); pb.innerHTML = (p ? ICON.play : ICON.pause) + (p ? 'Resume queue' : 'Pause queue'); pb.classList.toggle('active', p);
    sel.repaint();
  }
  function onQueue(j) {
    if (!root) return;
    if (!active) { dirty = true; return; }
    const row = j && !j.removed && j.status === 'running' ? qBox.querySelector(`[data-id="${j.id}"]`) : null;
    if (row?._pb) paintBar(j, row._pb); else render();
  }

  function act(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const row = b.closest('[data-id]'), j = MS.queue.jobs().find((x) => x.id === row.dataset.id); if (!j) return;
    e.stopPropagation();
    ({ cancel: () => MS.queue.cancel(j.id), preview: () => preview(j), copy: () => copy(j), save: () => saveCopy(j), retry: () => MS.queue.retry(j.id),
      remove: () => { const u = thumbs.get(j.id); if (u) URL.revokeObjectURL(u); thumbs.delete(j.id); MS.queue.remove(j.id); } })[b.dataset.act]?.();
  }
  const doneJob = (el) => MS.queue.jobs().find((x) => x.id === el?.dataset.id);
  const removeSelected = () => {
    const ids = sel.keys; if (!ids.length) return;
    MS.sound('trash'); sel.clear(); for (const id of ids) MS.queue.remove(id);
  };

  MS.tab({
    id: 'export', label: 'Export', order: 5,
    icon: '<path d="M12 3v12M7 10l5 5 5-5M4 20h16"/>',
    mount(el) {
      root = el;
      el.innerHTML = `<div class="page-head"><div><h2>Export</h2><p>GIF, Compress and Editor send their work here. One job runs at a time, even after a reload.</p></div>
        <div class="row"><button class="btn" data-pause type="button"></button></div></div>
        <div class="card mb-3" data-cfg></div>
        <section data-qs hidden><div class="row xh"><h3>Queue</h3><span class="pill" data-qn></span></div><div class="list" data-q></div></section>
        <section data-ds hidden><div class="row xh"><h3 class="grow">Finished</h3><button class="btn ghost sm" data-clear type="button"><span class="i i-broom"></span>Clear finished</button></div><div class="list" data-d></div></section>
        <div class="empty" data-empty><h3 class="mb-2">Nothing exported yet</h3><p class="dim" style="margin:0 auto;max-width:460px">Use <b>Export</b> in the GIF, Compress or Editor tab. Jobs queue up here, run one at a time and land in the destination above.</p></div>`;
      MS.exportConfig($('[data-cfg]', el));
      qBox = $('[data-q]', el); dBox = $('[data-d]', el); empty = $('[data-empty]', el);
      sel = MS.ui.selection(dBox, '.xdone', { onChange: () => {} });
      $('[data-pause]', el).onclick = () => { MS.queue.pause(!MS.queue.paused()); MS.sound(MS.queue.paused() ? 'off' : 'on'); render(); };
      $('[data-clear]', el).onclick = () => { MS.queue.clearDone(); MS.sound('trash'); render(); };
      el.addEventListener('click', act);
      dBox.addEventListener('click', (e) => { const r = e.target.closest('.xdone'); if (r && !e.target.closest('[data-act]')) sel.click(e, r); });
      dBox.addEventListener('dblclick', (e) => { const r = e.target.closest('.xdone:not(.failed)'); if (r && !e.target.closest('[data-act]')) preview(doneJob(r)); });
      on('queue', onQueue);
      render();
    },
    show() { active = true; if (dirty || true) render(); },
    hide() { active = false; },
    onKey(e) {
      if (e.key === 'p' && !e.ctrlKey && !e.metaKey) { $('[data-pause]', root).click(); e.preventDefault(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { removeSelected(); e.preventDefault(); }
      else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) { sel.all(); e.preventDefault(); }
      else if (e.key === 'Escape') sel.clear();
      else if (e.key === 'Enter') { const j = doneJob(dBox.querySelector('.xdone.msel') || document.activeElement.closest?.('.xdone')); if (j?.out) { preview(j); e.preventDefault(); } }
    },
    keys: [{ k: 'P', d: 'Pause / resume the queue' }, { k: 'Del', d: 'Remove the selected finished jobs from the list' }, { k: 'Ctrl A', d: 'Select all finished jobs' }, { k: 'Enter', d: 'Preview the selected file' }, { k: 'Ctrl click', d: 'Select several (Shift for a range)' }],
    hotkeys: [{ sel: '[data-pause]', k: 'P' }],
  });
})();
