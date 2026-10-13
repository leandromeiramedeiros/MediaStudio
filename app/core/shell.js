/* Shell: header (tabs, library + queue pills, icon buttons), routing, keys, hotkey badges, paste/drop, settings, welcome screen.
   Loads LAST: tab scripts have registered with MS.tab by now. Boot: db -> lib.init -> queue.init -> first tab. */
(() => {
  const { $, $$, h, esc, pref, setPref, on, emit, debounce, kindOf } = MS.util;
  const play = (n) => MS.sound(n);
  const EASE = 'cubic-bezier(.22, 1, .36, 1)';
  const root = document.documentElement;
  const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { /* storage off */ } return null; };
  const svg = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const iconOf = (s) => svg(String(s || '').trim().startsWith('<') ? s : `<path d="${esc(s || '')}"/>`);

  /* ---------- theme / skin / motion / sound ---------- */
  function setTheme(t) { if (t) root.dataset.theme = t; else delete root.dataset.theme; store('ms.theme', t || ''); }
  setTheme(store('ms.theme') || '');
  $('#theme').title = 'Light / dark (T)';
  $('#theme').onclick = (e) => {
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    play(dark ? 'off' : 'on');
    if (!document.startViewTransition || MS.ui.reduced()) { setTheme(dark ? 'light' : 'dark'); return; }
    const x = e.clientX || innerWidth - 60, y = e.clientY || 30, r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    document.startViewTransition(() => setTheme(dark ? 'light' : 'dark')).ready.then(() => {
      root.animate({ clipPath: [`circle(0 at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] }, { duration: 650, easing: EASE, pseudoElement: '::view-transition-new(root)' });
    }).catch(() => {});
  };
  const SKINS = { neon: 'Neon', glass: 'Glass', classic: 'Classic' };
  function setSkin(s) { s = SKINS[s] ? s : 'neon'; root.dataset.skin = s; store('ms.skin', s); emit('skin', s); }
  setSkin(store('ms.skin') || 'neon');

  function setMotion(m) { if (m) root.dataset.motion = m; else delete root.dataset.motion; store('ms.motion', m || ''); }
  setMotion(store('ms.motion') || '');
  const MOTION = { '': 'system', on: 'on', off: 'off' }, NEXT = { '': 'on', on: 'off', off: '' };
  const drawMotion = () => {
    const m = root.dataset.motion || '', live = !MS.ui.reduced(), b = $('#motion');
    b.innerHTML = svg('<path d="M3 8c3-3 6 3 9 0s6 3 9 0M3 16c3-3 6 3 9 0s6 3 9 0"/>' + (live ? '' : '<path d="M4 4l16 16"/>'));
    b.title = `Motion: ${MOTION[m]}${m ? '' : ` (${live ? 'on' : 'off'})`}`;
    b.classList.toggle('auto', !m);
  };
  $('#motion').onclick = () => { setMotion(NEXT[root.dataset.motion || '']); drawMotion(); play(MS.ui.reduced() ? 'off' : 'on'); MS.ui.toast($('#motion').title); };
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', drawMotion);
  drawMotion();

  const drawMute = () => {
    const m = MS.sound.isMuted();
    $('#mute').innerHTML = svg('<path d="M11 5L6 9H2v6h4l5 4z"/>' + (m ? '<path d="M22 9l-6 6M16 9l6 6"/>' : '<path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>'));
    $('#mute').title = m ? 'Sounds off (M)' : 'Sounds on (M)';
  };
  $('#mute').onclick = () => { MS.sound.setMuted(!MS.sound.isMuted()); drawMute(); };
  drawMute();
  $('#hk').title = 'Show hotkeys on the interface (H)';
  $('#settings').title = 'Settings (,)';
  /* interface sounds for common controls, delegated so every tab gets them */
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('button'); if (!b || b.disabled) return;
    if (b.matches('.tab, .seg button, .preset')) play('tick');
    else if (b.matches('.btn.primary')) play('tap');
  }, true);
  document.addEventListener('change', (e) => { if (e.target.matches?.('input[type=checkbox]')) play(e.target.checked ? 'on' : 'off'); }, true);

  /* ---------- tabs + routing ---------- */
  const defs = () => MS.tabs.slice().sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  const orderedTabs = () => {
    const order = pref('tabOrder', []) || [], list = defs();
    const rank = (t) => { const i = order.indexOf(t.id); return i < 0 ? order.length + list.indexOf(t) : i; };
    return list.slice().sort((a, b) => rank(a) - rank(b));
  };
  const tabIds = () => orderedTabs().map((t) => t.id);
  const mounted = {};
  let current = null, engaged = false, booted = false;
  const ink = h('<i class="tab-ink" aria-hidden="true"></i>'); $('#tabs').prepend(ink);
  function placeInk() {
    const t = $(`.tab[data-id="${current}"]`); if (!t) return;
    ink.style.width = t.offsetWidth + 'px'; ink.style.transform = `translateX(${t.offsetLeft}px)`;
    if (!ink.classList.contains('ready')) setTimeout(() => ink.classList.add('ready'), 60);
  }
  function drawTabs() {
    $$('.tab').forEach((b) => b.remove());
    for (const t of orderedTabs()) {
      const b = h(`<button class="tab" role="tab" draggable="true" data-id="${esc(t.id)}" aria-selected="${t.id === current}">${iconOf(t.icon)}${esc(t.label || t.id)}</button>`);
      b.onclick = () => go(t.id); $('#tabs').append(b);
    }
    placeInk();
  }
  MS.ui.sortable($('#tabs'), '.tab', (ids) => { setPref('tabOrder', ids); placeInk(); });
  $('#tabs').addEventListener('reorder', placeInk);
  addEventListener('resize', placeInk);
  document.fonts?.ready.then(placeInk);

  const needsWelcome = (id) => MS.lib.status !== 'ready' && id !== 'export';
  function enter(el) {
    if (MS.ui.reduced()) return;
    $('#view').scrollTop = 0;
    el.animate([{ opacity: 0, transform: 'translateY(10px) scale(.995)' }, { opacity: 1, transform: 'none' }], { duration: 480, easing: EASE });
  }
  const loadingTabs = {};
  async function go(id, arg) {
    const list = defs();
    if (!list.length) return;
    if (!list.some((t) => t.id === id)) id = orderedTabs()[0].id;
    if (current === id && arg === undefined) return;
    if (current && mounted[current]) { mounted[current].el.hidden = true; try { mounted[current].def.hide?.(); } catch (e) { console.error(e); } }
    const switching = current !== id;
    if (switching) engaged = false;
    current = id;
    $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.id === id)));
    if (document.activeElement?.matches?.('.tab') && document.activeElement.dataset.id !== id) document.activeElement.blur();
    placeInk();
    if (location.hash !== '#' + id) history.replaceState(null, '', '#' + id);
    setPref('tab', id);
    drawWelcome();
    const def = list.find((t) => t.id === id);
    if (!mounted[id]) {
      loadingTabs[id] ||= (async () => {
        const el = h(`<section class="page" data-tab="${esc(id)}"></section>`); $('#view').append(el);
        mounted[id] = { el, def };
        try { await def.mount?.(el); }
        catch (e) { console.error('tab mount', id, e); el.innerHTML = `<div class="empty"><h3>This tab failed to load</h3><p class="dim mono">${esc(e.message || e)}</p></div>`; }
      })();
      await loadingTabs[id];
    }
    const m = mounted[id];
    if (current !== id) { m.el.hidden = true; return; }
    m.el.hidden = needsWelcome(id);
    if (switching && !m.el.hidden) enter(m.el);
    try { await def.show?.(arg); } catch (e) { console.error('tab show', id, e); }
    if (current !== id) m.el.hidden = true;
    hkSoon();
  }
  MS.go = go;
  addEventListener('hashchange', () => { const id = location.hash.slice(1); if (booted && id && id !== current) go(id); });

  /* ---------- pills ---------- */
  const libPill = $('#libpill'), qPill = $('#qpill');
  function drawLib() {
    const s = MS.lib.status;
    libPill.classList.toggle('on', s === 'ready'); libPill.classList.toggle('warn', s === 'denied');
    $('span:last-child', libPill).textContent = s === 'none' ? 'No library' : s === 'denied' ? `Reconnect ${MS.lib.name}` : MS.lib.name;
    libPill.title = s === 'ready' ? `Library: ${MS.lib.name} (${MS.lib.items.length} files). Click for settings` : s === 'denied' ? 'Click to settings to reconnect' : 'Choose your capture folder';
  }
  libPill.onclick = () => openSettings('library');
  function drawQueue() {
    const jobs = MS.queue.jobs(), run = jobs.find((j) => j.status === 'running'), n = jobs.filter((j) => j.status === 'queued' || j.status === 'running').length;
    qPill.classList.toggle('busy', !!run); qPill.classList.toggle('warn', MS.queue.paused() && n > 0);
    $('[data-qt]', qPill).textContent = MS.queue.paused() && n ? `${n} paused` : n ? `${n} export${n > 1 ? 's' : ''}` : 'Exports';
    const f = $('[data-qf]', qPill); f.style.width = run ? (run.progress == null ? 100 : Math.round(run.progress * 100)) + '%' : '0%';
    qPill.classList.toggle('active', !!run);
    qPill.title = n ? `${n} in the export queue. Click to open` : 'Export queue (empty)';
  }
  qPill.onclick = () => go('export');
  on('libstatus', () => { drawLib(); drawWelcome(); });
  on('library', drawLib);
  on('queue', drawQueue);

  /* ---------- welcome ---------- */
  const welcome = h('<section class="page welcome" hidden></section>'); $('#view').append(welcome);
  let welcomeKey = '';
  function drawWelcome() {
    const s = MS.lib.status, show = booted && needsWelcome(current);
    welcome.hidden = !show;
    if (mounted[current]) mounted[current].el.hidden = show;
    if (!show) { if (welcomeKey && mounted[current]) { try { mounted[current].def.show?.(); } catch (e) { console.error(e); } } welcomeKey = ''; return; }
    if (welcomeKey === s + MS.lib.name) return;
    welcomeKey = s + MS.lib.name;
    const denied = s === 'denied';
    welcome.innerHTML = `<div class="hero"><img src="app/icon.svg" alt="" width="64" height="64">
      <h1>${denied ? 'Reconnect ' + esc(MS.lib.name) : 'Choose your capture folder'}</h1>
      <p class="dim">${denied ? 'The browser needs your OK to open this folder again. Nothing was changed.' : 'The videos and screenshots in that folder are your library. Nothing is copied. GIFs, compressed images and videos you make are exported to an Exports folder inside it.'}</p>
      <div class="row"><button class="btn primary lg" data-go type="button"><span class="i i-folder"></span>${denied ? 'Reconnect' : 'Choose folder…'}</button>${denied ? '<button class="btn ghost lg" data-other type="button">Choose another folder</button>' : ''}</div>
      <p class="hint">You can change it any time in Settings (,)</p></div>`;
    $('[data-go]', welcome).onclick = async () => { const ok = denied ? await MS.lib.reconnect() : await MS.lib.pick(); if (ok === false) MS.ui.toast('No folder chosen'); };
    const o = $('[data-other]', welcome); if (o) o.onclick = () => MS.lib.pick();
  }

  /* ---------- settings ---------- */
  const setRow = (title, note, ctl, attr = '') => `<div class="set-row"${attr}><div class="grow"><div class="set-t">${title}</div>${note ? `<div class="small dim">${note}</div>` : ''}</div><div class="set-ctl">${ctl}</div></div>`;
  const toggle = (attr) => `<label class="check"><input type="checkbox" ${attr}></label>`;
  const SET = [
    { id: 'library', label: 'Library', icon: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', build(box) {
      box.append(h(`<div><h2 class="set-h">Library</h2>
        ${setRow('Capture folder', 'The videos and screenshots here are your library. Nothing is copied into it except exports.', '<span class="pill" data-name></span><button class="btn sm" data-change type="button">Change…</button><button class="btn sm primary" data-re type="button" hidden>Reconnect</button>')}
        ${setRow('Subfolders', 'How many folder levels below it are scanned.', '<span class="seg" data-depth></span>')}
        ${setRow('Rescan', 'New files show up by themselves; this forces a look.', '<span class="small dim" data-count></span><button class="btn sm" data-scan type="button">Rescan</button>')}</div>`));
      const draw = () => {
        $('[data-name]', box).textContent = MS.lib.status === 'none' ? 'No folder' : MS.lib.name;
        $('[data-re]', box).hidden = MS.lib.status !== 'denied';
        $('[data-count]', box).textContent = MS.lib.status === 'ready' ? `${MS.lib.items.length} files` : '';
        $('[data-scan]', box).disabled = MS.lib.status !== 'ready';
      };
      $('[data-change]', box).onclick = () => MS.lib.pick();
      $('[data-re]', box).onclick = () => MS.lib.reconnect();
      $('[data-scan]', box).onclick = () => MS.lib.rescan();
      MS.ui.seg($('[data-depth]', box), [['1', 1], ['2', 2], ['3', 3], ['5', 5], ['8', 8]], +pref('lib.depth', 3), (v) => { setPref('lib.depth', v); if (MS.lib.status === 'ready') MS.lib.rescan(); });
      const offs = [on('libstatus', draw), on('library', draw)];
      box._off = () => offs.forEach((f) => f());
      draw();
    } },
    { id: 'export', label: 'Export', icon: '<path d="M12 3v12M7 10l5 5 5-5M4 20h16"/>', build(box) {
      box.append(h('<h2 class="set-h">Export</h2>'));
      if (MS.exportConfig) MS.exportConfig(box);
    } },
    { id: 'appearance', label: 'Appearance', icon: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/>', build(box) {
      box.append(h(`<div><h2 class="set-h">Appearance</h2>
        ${setRow('Skin', 'Neon: gradients and glow. Glass: frosted panes on a soft color wash. Classic: flat.', '<span data-skin></span>')}
        ${setRow('Theme', 'System follows Windows. The theme button and T switch light and dark.', '<span data-theme></span>')}
        ${setRow('Motion', 'Animations and transitions. System follows Windows\' "Animation effects".', '<span data-motion></span>')}
        ${setRow('Sounds', 'Soft interface sounds (M).', toggle('data-sounds'))}
        ${setRow('Hotkey badges', 'A small key badge on every control that has a shortcut (H).', toggle('data-hk'))}</div>`));
      MS.ui.seg($('[data-skin]', box), Object.entries(SKINS).map(([k, v]) => [v, k]), root.dataset.skin, setSkin);
      MS.ui.seg($('[data-theme]', box), [['System', ''], ['Light', 'light'], ['Dark', 'dark']], root.dataset.theme || '', setTheme);
      MS.ui.seg($('[data-motion]', box), [['System', ''], ['On', 'on'], ['Off', 'off']], root.dataset.motion || '', (k) => { setMotion(k); drawMotion(); });
      const snd = $('[data-sounds]', box); snd.checked = !MS.sound.isMuted();
      snd.onchange = () => { MS.sound.setMuted(!snd.checked); drawMute(); };
      const hk = $('[data-hk]', box); hk.checked = hkOn;
      hk.onchange = () => { if (hkOn !== hk.checked) $('#hk').click(); };
    } },
    { id: 'reset', label: 'Reset app', icon: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>', build(box) {
      box.append(h(`<div><h2 class="set-h">Reset app</h2>
        ${setRow('Reset to defaults', 'Forgets tab order, skin, theme, remembered tab settings, projects and the export queue. Your library folder, your files and the exports stay.', '<button class="btn danger sm" data-reset type="button">Reset…</button>')}</div>`));
      $('[data-reset]', box).onclick = async () => {
        if (!(await MS.ui.confirmBox('Reset app', 'Put the app back to its first-run state? Your library folder and all files stay.', 'Reset', true))) return;
        try { Object.keys(localStorage).filter((k) => k.startsWith('ms.')).forEach((k) => localStorage.removeItem(k)); } catch (e) { /* storage off */ }
        try { await MS.db.clear(['lib.dir']); } catch (e) { /* ignore */ }
        location.reload();
      };
    } },
  ];
  async function openSettings(section) {
    if (!SET.some((s) => s.id === section)) section = pref('set.tab', 'library');
    if (!SET.some((s) => s.id === section)) section = 'library';
    const box = h(`<div class="settings"><nav class="set-nav" role="tablist" aria-label="Settings topics">${SET.map((s) =>
      `<button type="button" role="tab" data-k="${s.id}" aria-selected="false">${svg(s.icon)}<span>${esc(s.label)}</span></button>`).join('')}</nav><div class="set-pane" role="tabpanel"></div></div>`);
    const pane = $('.set-pane', box);
    let sec = null;
    const show = (id) => {
      setPref('set.tab', id);
      $$('.set-nav button', box).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.k === id)));
      sec?._off?.();
      sec = h('<div class="set-sec"></div>'); pane.replaceChildren(sec); box.closest('.body')?.scrollTo(0, 0);
      SET.find((s) => s.id === id).build(sec);
    };
    $$('.set-nav button', box).forEach((b) => { b.onclick = () => show(b.dataset.k); });
    $('.set-nav', box).onkeydown = (e) => {
      if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
      const bs = $$('.set-nav button', box), i = bs.indexOf(document.activeElement);
      const next = bs[(i + (e.key === 'ArrowDown' ? 1 : bs.length - 1)) % bs.length]; next.focus(); next.click(); e.preventDefault();
    };
    show(section);
    const p = MS.ui.modal('Settings', box, [{ label: 'Close', value: null, primary: true }]);
    requestAnimationFrame(() => { const m = box.closest('.modal'); if (m) m.style.width = 'min(860px, 100%)'; });
    await p; sec?._off?.();
  }
  $('#settings').onclick = () => openSettings();

  /* ---------- key sheet + jump palette ---------- */
  const GLOBAL_KEYS = [
    { k: '1-9', d: 'Go to tab 1 to 9, in the order shown (Alt+1-9 always)' }, { k: 'Ctrl K', d: 'Jump to a tab or action by name' },
    { k: '?', d: 'This sheet' }, { k: 'T', d: 'Light / dark' }, { k: 'M', d: 'Sounds on / off' }, { k: ',', d: 'Settings' },
    { k: 'H', d: 'Show / hide the hotkey badges on the interface' }, { k: 'Esc', d: 'Close a dialog, clear a selection' },
    { k: 'Ctrl V', d: 'Paste an image or video into the open tab' },
  ];
  const kbdRows = (list) => list.map(({ k, d }) => `<div class="krow"><span class="nw">${k.split(' ').map((x) => `<kbd>${esc(x)}</kbd>`).join(' ')}</span><span class="dim">${esc(d)}</span></div>`).join('');
  function keySheet() {
    const m = mounted[current];
    MS.ui.modal('Keyboard shortcuts', h(`<div><h3 class="mb-1">Everywhere</h3>${kbdRows(GLOBAL_KEYS)}${m?.def.keys?.length ? `<h3 class="mt-4 mb-1">${esc(m.def.label)}</h3>${kbdRows(m.def.keys)}` : ''}</div>`), [{ label: 'Close', value: null }]);
  }
  function jumpTo() {
    const acts = [...orderedTabs().map((t) => ({ label: t.label || t.id, hint: 'tab', fn: () => go(t.id) })),
      { label: 'Change library folder', hint: 'library', fn: () => MS.lib.pick() },
      { label: 'Export queue', hint: 'queue', fn: () => go('export') },
      { label: 'Settings', hint: ',', fn: () => openSettings() },
      ...SET.map((x) => ({ label: 'Settings: ' + x.label, hint: 'settings', fn: () => openSettings(x.id) })),
      { label: 'Toggle light / dark', hint: 'T', fn: () => $('#theme').click() }, { label: 'Toggle sounds', hint: 'M', fn: () => $('#mute').click() },
      { label: 'Keyboard shortcuts', hint: '?', fn: keySheet }, { label: 'Show / hide hotkey badges', hint: 'H', fn: () => $('#hk').click() }];
    const box = h('<div><input class="input" placeholder="Go to…" autocomplete="off"><div class="list mt-2" data-l></div></div>');
    let at = 0, shown = acts, p;
    const run = (a) => { p.close(); setTimeout(a.fn, 30); };
    const draw = () => {
      const q = $('input', box).value.trim().toLowerCase();
      shown = acts.filter((a) => !q || a.label.toLowerCase().includes(q)); at = Math.min(at, Math.max(0, shown.length - 1));
      const l = $('[data-l]', box); l.innerHTML = '';
      shown.forEach((a, i) => { const b = h(`<button class="item btn ghost${i === at ? ' active' : ''}" type="button" style="justify-content:flex-start"><span class="grow">${esc(a.label)}</span><span class="faint small">${esc(a.hint)}</span></button>`); b.onclick = () => run(a); l.append(b); });
    };
    $('input', box).oninput = () => { at = 0; draw(); };
    $('input', box).onkeydown = (e) => {
      if (e.key === 'ArrowDown') { at = Math.min(shown.length - 1, at + 1); draw(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { at = Math.max(0, at - 1); draw(); e.preventDefault(); }
      else if (e.key === 'Enter' && shown[at]) { run(shown[at]); e.preventDefault(); }
    };
    draw(); p = MS.ui.modal('Jump to', box, []);
  }
  $('#view').addEventListener('pointerdown', () => { engaged = true; }, true);
  $('#view').addEventListener('focusin', () => { engaged = true; });
  document.addEventListener('keydown', (e) => {
    const typing = e.target.closest?.('input, textarea, select, [contenteditable]'), m = mounted[current], mod = e.ctrlKey || e.metaKey;
    if (document.querySelector('.modal-back:not(.out)')) return;
    if (!booted) return;
    if (mod && e.key === 'Enter' && !e.shiftKey) { if (m?.def.onKey) m.def.onKey(e); return; }
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); jumpTo(); return; }
    if (e.altKey && !mod && /^[1-9]$/.test(e.key)) { const id = tabIds()[+e.key - 1]; if (id) { e.preventDefault(); go(id); } return; }
    if (typing) return;
    const claimed = engaged && m?.def.claims?.includes(e.key);
    if (!mod && !e.altKey && !claimed) {
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      let used = true;
      if (/^[1-9]$/.test(k)) { const id = tabIds()[+k - 1]; if (id) go(id); }
      else if (k === '?') keySheet();
      else if (k === 't') $('#theme').click();
      else if (k === 'm') $('#mute').click();
      else if (k === ',') openSettings();
      else if (k === 'h') $('#hk').click();
      else used = false;
      if (used) { e.preventDefault(); return; }
    }
    if (m && !m.el.hidden && m.def.onKey) m.def.onKey(e);
  });

  /* ---------- paste + drop: files go to the active tab's onPaste(files) ---------- */
  const activeDef = () => (!welcome.hidden ? null : mounted[current]?.def);
  document.addEventListener('paste', (e) => {
    if (document.querySelector('.modal-back:not(.out)')) return;
    const d = activeDef(); if (!d?.onPaste) return;
    const files = MS.src.filesOf(e.clipboardData);
    if (!files.length) return;  // text paste: leave it to the focused field
    e.preventDefault(); d.onPaste(files);
  });
  let dragN = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  document.addEventListener('dragenter', (e) => { if (hasFiles(e) && activeDef()?.onPaste) { dragN++; root.classList.add('drop-on'); } });
  document.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragN <= 0) { dragN = 0; root.classList.remove('drop-on'); } });
  document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('drop', async (e) => {
    dragN = 0; root.classList.remove('drop-on');
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (document.querySelector('.modal-back:not(.out)')) return;
    const d = activeDef(); if (!d?.onPaste) return;
    const items = [...e.dataTransfer.items].filter((i) => i.kind === 'file'), fallback = MS.src.filesOf(e.dataTransfer);
    let files = [];
    if (items.length && items[0].getAsFileSystemHandle) {
      try { files = (await Promise.all(items.map((i) => i.getAsFileSystemHandle()))).filter((x) => x && x.kind === 'file' && kindOf(x.name)); } catch (err) { files = []; }
    }
    if (!files.length) files = fallback;
    if (files.length) d.onPaste(files); else MS.ui.toast('Nothing usable in that drop', true);
  });

  /* ---------- hotkey badges ---------- */
  const HK_GLOBAL = [['#mute', 'M'], ['#theme', 'T'], ['#settings', ','], ['#hk', 'H']];
  let hkOn = pref('hk', false), hkLayer = null, hkQueued = 0;
  function hkTargets() {
    const out = tabIds().map((id, i) => [$(`.tab[data-id="${id}"]`), i < 9 ? String(i + 1) : '']);
    for (const [sel, k] of HK_GLOBAL) out.push([$(sel), k]);
    const m = mounted[current];
    if (m && !m.el.hidden) for (const { sel, k } of m.def.hotkeys || []) for (const el of $$(sel, m.el)) out.push([el, k]);
    return out.filter(([el, k]) => el && k);
  }
  const hkBadges = new Map();
  const hkRetire = (b) => { b.classList.add('out'); setTimeout(() => b.remove(), 240); };
  function hkDraw() {
    hkQueued = 0;
    if (!hkLayer) { hkLayer = h('<div class="hk-layer" aria-hidden="true"></div>'); document.body.append(hkLayer); }
    if (!hkOn) { for (const b of hkBadges.values()) hkRetire(b); hkBadges.clear(); return; }
    const seen = new Set(), live = new Set(), vw = innerWidth, vh = innerHeight; let fresh = 0;
    for (const [el, k] of hkTargets()) {
      const r = el.getBoundingClientRect();
      if (r.width < 14 || r.height < 14 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw || el.closest('[hidden]') || getComputedStyle(el).visibility === 'hidden') continue;
      const x = Math.round(Math.min(vw - 14, r.right)), y = Math.round(Math.min(vh - 14, r.bottom)), id = `${x},${y}`;
      if (seen.has(id)) continue; seen.add(id); live.add(el);
      let b = hkBadges.get(el);
      if (b && b.textContent !== k) { hkRetire(b); b = null; }
      if (!b) { b = document.createElement('kbd'); b.className = 'hk' + (k.length > 2 ? ' wide' : ''); b.textContent = k; b.style.animationDelay = fresh++ * 16 + 'ms'; hkBadges.set(el, b); hkLayer.append(b); }
      if (b.dataset.at !== id) { b.dataset.at = id; b.style.left = x + 'px'; b.style.top = y + 'px'; }
    }
    for (const [el, b] of hkBadges) if (!live.has(el)) { hkBadges.delete(el); hkRetire(b); }
  }
  function hkSoon() { if (hkOn && !hkQueued) hkQueued = requestAnimationFrame(hkDraw); }
  $('#hk').onclick = () => { hkOn = !hkOn; setPref('hk', hkOn); hkDraw(); $('#hk').setAttribute('aria-pressed', String(hkOn)); root.classList.toggle('hk-on', hkOn); };
  $('#hk').setAttribute('aria-pressed', String(hkOn)); root.classList.toggle('hk-on', hkOn);
  for (const ev of ['resize', 'scroll', 'transitionend', 'animationend', 'hashchange', 'click', 'input']) addEventListener(ev, hkSoon, true);
  setInterval(hkSoon, 700);

  /* ---------- boot ---------- */
  drawTabs(); drawLib(); drawQueue();
  (async () => {
    const step = async (name, fn) => { try { await fn(); } catch (e) { console.error('boot ' + name, e); } };
    await step('db', () => MS.db.get('lib.dir'));
    await step('lib', () => MS.lib.init());
    await step('queue', () => MS.queue.init());
    booted = true;
    drawLib(); drawQueue();
    const wanted = location.hash.slice(1) || pref('tab', '');
    await go(wanted || orderedTabs()[0]?.id);
    drawWelcome();
    document.body.classList.add('ready');
  })();
})();
