/* MS.queue: the export queue. Every tool hands its work here as a job; one job runs at a time, in order. The queue is persisted
   in IDB ("queue"), so a reload keeps it (a job that was running goes back to queued). Tabs register runners:
   MS.queue.runner('gif', async (job, ctx) => ({ blob, ext, label })). A job whose runner is not registered yet waits. */
(() => {
  const { pref, setPref, emit, uid, stem } = MS.util;
  const runners = new Map();
  let list = [], cur = null, paused = !!pref('queue.paused', false), loaded = false, lastEmit = 0;
  const FINISHED = ['done', 'error', 'cancelled'];

  const save = MS.util.debounce(() => { MS.db.set('queue', list).catch(() => {}); }, 120);
  const change = (j, extra) => { save(); emit('queue', extra ? Object.assign({}, j, extra) : j); };
  async function init() {
    let saved = [];
    try { saved = (await MS.db.get('queue')) || []; } catch (e) { /* no IDB */ }
    list = saved.concat(list);
    for (const j of list) if (j.status === 'running') { j.status = 'queued'; j.progress = 0; j.text = ''; }
    list = list.slice(-300);
    loaded = true;
    emit('queue', null); pump();
  }
  addEventListener('pagehide', () => { if (loaded) MS.db.set('queue', list).catch(() => {}); });

  function runner(type, fn) { runners.set(type, fn); pump(); }
  function add({ type, name = '', title = '', params = {}, ref = null }) {
    const j = { id: uid(), type, name, title: title || name, params, ref, status: 'queued', progress: 0, text: '', out: null, error: '', at: Date.now(), ended: 0 };
    list.push(j); change(j); pump();
    return j;
  }
  const find = (id) => list.find((j) => j.id === id);
  function cancel(id) {
    const j = find(id); if (!j) return;
    if (j.status === 'queued') { j.status = 'cancelled'; j.ended = Date.now(); MS.sound('cancel'); change(j); }
    else if (j.status === 'running') { j._cancel = true; j.text = 'Cancelling…'; change(j); }
  }
  function retry(id) {
    const j = find(id); if (!j || !FINISHED.includes(j.status) || j.status === 'done') return;
    Object.assign(j, { status: 'queued', progress: 0, text: '', error: '', out: null, ended: 0 }); delete j._cancel;
    change(j); pump();
  }
  function remove(id) {
    const j = find(id); if (!j) return;
    if (j.status === 'running') { j._remove = true; cancel(id); return; }
    list = list.filter((x) => x !== j); change(j, { removed: true });
  }
  function clearDone() {
    const gone = list.filter((j) => FINISHED.includes(j.status));
    if (!gone.length) return;
    list = list.filter((j) => !FINISHED.includes(j.status)); save();
    for (const j of gone) emit('queue', Object.assign({}, j, { removed: true }));
  }
  function pause(p) { paused = !!p; setPref('queue.paused', paused); emit('queue', null); if (!paused) pump(); }

  /* "{name}-{date}" etc. -> a safe file stem */
  function fileStem(j) {
    const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
    const date = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`, time = `${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
    const tokens = { name: stem(j.name || '') || j.type, date, time, type: j.type };
    const s = String(pref('out.pattern', '{name}') || '{name}').replace(/\{(\w+)\}/g, (m, k) => tokens[k] ?? m)
      .replace(/[<>:"\/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 120);
    return s || tokens.name;
  }

  async function pump() {
    if (cur || paused || !loaded) return;
    const j = list.find((x) => x.status === 'queued' && runners.has(x.type));
    if (!j) return;
    cur = j;
    const sig = { cancelled: false };
    const check = () => { if (j._cancel) { sig.cancelled = true; throw new Error('cancelled'); } };
    const ctx = {
      signal: sig, check,
      progress(f, text) {
        j.progress = f == null ? null : Math.max(0, Math.min(1, f)); if (text !== undefined) j.text = text;
        const now = performance.now(); if (now - lastEmit > 60 || f >= 1) { lastEmit = now; emit('queue', j); }
      },
    };
    Object.assign(j, { status: 'running', progress: 0, text: '', error: '' }); delete j._cancel; change(j);
    try {
      const r = await runners.get(j.type)(j, ctx);
      check();
      if (!r || !r.blob) throw new Error('The export produced no file');
      j.text = 'Saving…'; emit('queue', j);
      const dir = await MS.lib.outDir(), w = await MS.lib.write(dir, fileStem(j) + '.' + r.ext, r.blob);
      j.out = { file: w.name, size: w.size, label: r.label || '', dir: MS.lib.outLabel, handle: w.handle };
      j.status = 'done'; j.progress = 1; j.text = '';
      MS.sound('complete');
    } catch (e) {
      if (j._cancel || e?.message === 'cancelled' || e === 'cancelled') { j.status = 'cancelled'; j.text = ''; MS.sound('cancel'); }
      else { j.status = 'error'; j.error = e?.message || String(e); j.text = ''; console.error('export job', j.type, e); MS.sound('error'); }
    }
    j.ended = Date.now(); delete j._cancel;
    cur = null;
    if (j._remove) { list = list.filter((x) => x !== j); change(j, { removed: true }); } else change(j);
    pump();
  }

  MS.queue = { init, runner, add, cancel, retry, remove, clearDone, pause, jobs: () => [...list], paused: () => paused, fileStem };
})();
