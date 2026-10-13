/* MS.ui: toast, modal, selection, zoom/pan viewer, sortable, segmented control, progress bar, media tile. */
(() => {
  const { $, $$, h, esc, clamp, fmtTime, fmtBytes } = MS.util;
  const play = MS.sound;
  const EASE = 'cubic-bezier(.32, .72, 0, 1)';

  /* ---------- sliders ---------- */
  /* every range input keeps --rp (0..1) for its glass track fill (style.css): on input, on a value set from code, and when added.
     A stepped one (24 steps or fewer) glides: the thumb jumps to its new spot shifted back by --dx, then --dx eases to 0. */
  function fillRange(r) {
    const min = +r.min || 0, max = r.max === '' ? 100 : +r.max, p = max > min ? Math.max(0, Math.min(1, (+r.value - min) / (max - min))) : 0;
    const stepped = r.step !== 'any' && max > min && (max - min) / (+r.step || 1) <= 24;
    r.classList.toggle('stepped', stepped);
    if (stepped && r._rp !== undefined && r._rp !== p && r.isConnected) {
      const tw = parseFloat(getComputedStyle(r).getPropertyValue('--tw')) || 30;
      r.classList.add('snap'); r.style.setProperty('--dx', `${(r._rp - p) * (r.clientWidth - tw)}px`);
      void r.offsetWidth;
      r.classList.remove('snap'); r.style.setProperty('--dx', '0px');
    }
    r._rp = p;
    r.style.setProperty('--rp', p);
  }
  {
    const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    Object.defineProperty(HTMLInputElement.prototype, 'value', { ...d, set(v) { d.set.call(this, v); if (this.type === 'range') fillRange(this); } });
    for (const ev of ['input', 'change']) document.addEventListener(ev, (e) => { if (e.target.type === 'range') fillRange(e.target); }, true);
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) (n.type === 'range' ? [n] : n.querySelectorAll('input[type=range]')).forEach(fillRange); })
      .observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ---------- motion ---------- */
  const osReduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const reduced = () => { const m = document.documentElement.dataset.motion; return m ? m === 'off' : osReduced(); };
  /* shrink an element away (height, fade, scale), then remove it */
  function collapse(el) {
    if (reduced()) { el.remove(); return Promise.resolve(); }
    const cs = getComputedStyle(el);
    el.style.overflow = 'hidden';
    const a = el.animate([
      { height: el.offsetHeight + 'px', opacity: 1, transform: 'none', paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom },
      { height: '0px', opacity: 0, transform: 'scale(.94)', paddingTop: '0px', paddingBottom: '0px', marginTop: '-6px' },
    ], { duration: 340, easing: EASE });
    return a.finished.then(() => el.remove(), () => el.remove());
  }
  /* scroll an element into view and flash it: where a jump from elsewhere landed */
  function flash(el) {
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1700);
  }

  /* ---------- toast, modal ---------- */
  let toastTimer;
  function toast(msg, err, action) {
    const t = $('#toast'), was = t.classList.contains('show');
    t.innerHTML = `<span class="ti">${err ? '!' : '✓'}</span><span></span>`; t.lastChild.textContent = msg;
    if (action) {
      const b = h(`<button class="btn sm toast-act" type="button">${esc(action.label)}</button>`);
      b.onclick = () => { t.classList.remove('show'); action.fn(); };
      t.append(b);
    }
    t.className = 'toast show' + (err ? ' err' : '');
    if (was && !reduced()) t.animate([{ scale: 1 }, { scale: 1.05 }, { scale: 1 }], { duration: 320, easing: 'ease-out' });
    play(err ? 'error' : 'pop');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), err ? 6000 : action ? 8000 : 2800);
  }
  /* modal(title, bodyElOrHtml, buttons) -> Promise of the clicked button's value (null on Esc / close). The promise also has
     .close(v) and .el (the backdrop), for dialogs that close themselves. */
  function modal(title, body, buttons = []) {
    let closeFn, backEl;
    const p = new Promise((resolve) => {
      const back = backEl = h(`<div class="modal-back"><div class="modal" role="dialog" aria-modal="true"><header><h3 class="grow">${esc(title)}</h3><button class="btn ghost sm" data-x type="button" aria-label="Close">✕</button></header><div class="body"></div><footer></footer></div></div>`);
      let closed = false, main = null;
      const prev = document.activeElement;
      const close = closeFn = (v) => {
        if (closed) return; closed = true;
        document.removeEventListener('keydown', key, true); resolve(v === undefined ? null : v);
        back.classList.add('out'); setTimeout(() => back.remove(), reduced() ? 0 : 220);
        if (prev && prev.isConnected) prev.focus({ preventScroll: true });
      };
      // keys never reach the page behind: Enter on a button left focused there would open a second dialog
      const key = (e) => {
        if (back !== [...document.querySelectorAll('.modal-back:not(.out)')].pop()) return;  // the top dialog owns the keys
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); return; }
        if (back.contains(e.target) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v')) return;  // typing, and paste for dialogs that take it
        e.preventDefault(); e.stopPropagation();
        if (e.key === 'Enter' && main) main.click();
      };
      $('.body', back).append(typeof body === 'string' ? h(`<div>${body}</div>`) : body);
      for (const b of buttons) {
        const el = h(`<button class="btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}" type="button">${esc(b.label)}</button>`);
        el.onclick = () => { if (b.danger) play('trash'); close(b.value !== undefined ? b.value : (b.get ? b.get() : b.label)); }; $('footer', back).append(el);
        if (b.primary || b.danger) main = el;
      }
      if (!buttons.length) $('footer', back).remove();
      $('[data-x]', back).onclick = () => close(null);
      back.addEventListener('mousedown', (e) => { if (e.target === back) close(null); });
      document.addEventListener('keydown', key, true);
      document.body.append(back);
      ($('.body input:not([type=checkbox]):not([type=radio]):not([type=range]), .body textarea', back) || main || $('[data-x]', back)).focus({ preventScroll: true });
      play('open');
    });
    p.close = (v) => closeFn?.(v); p.el = backEl;
    return p;
  }
  const confirmBox = (title, text, okLabel = 'OK', danger) =>
    modal(title, `<p>${esc(text)}</p>`, [{ label: 'Cancel', value: false }, { label: okLabel, value: true, primary: !danger, danger }]);
  async function promptBox(title, label, value = '') {
    const box = h(`<div class="field"><label class="lab">${esc(label)}</label><input class="input" type="text" autocomplete="off"></div>`);
    const inp = $('input', box); inp.value = value;
    const r = await modal(title, box, [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, get: () => inp.value.trim() }]);
    return r === null || r === '' ? null : r;
  }

  /* Multi-select for a list of elements (data-id, data-path or key()): Ctrl/Cmd+click toggles, Shift+click selects a range from the anchor,
     all() is for Ctrl+A, clear() for Esc. click(e, el) is true when the click was a select gesture (the caller then skips its own). */
  function selection(container, itemSel, { onChange, key = (el) => el.dataset.id ?? el.dataset.path ?? el.dataset.k } = {}) {
    const sel = new Set(); let anchor = null;
    const items = () => $$(itemSel, container);
    const paint = () => { for (const el of items()) el.classList.toggle('msel', sel.has(key(el))); onChange?.(sel); };
    return {
      get keys() { return [...sel]; },
      get size() { return sel.size; },
      has: (k) => sel.has(k),
      clear() { if (!sel.size) return; sel.clear(); anchor = null; paint(); },
      setAnchor(k) { anchor = k; },
      all() { for (const el of items()) sel.add(key(el)); paint(); },
      repaint: paint,
      prune(valid) { for (const k of [...sel]) if (!valid.has(k)) sel.delete(k); paint(); },
      click(e, el) {
        const k = key(el);
        if (e.shiftKey && anchor != null) {
          const list = items(), a = list.findIndex((x) => key(x) === anchor), b = list.indexOf(el);
          if (a < 0 || b < 0) return false;
          if (!(e.ctrlKey || e.metaKey)) sel.clear();
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) sel.add(key(list[i]));
        } else if (e.ctrlKey || e.metaKey) { sel.has(k) ? sel.delete(k) : sel.add(k); anchor = k; }
        else { anchor = k; if (sel.size) { sel.clear(); paint(); } return false; }
        paint(); return true;
      },
    };
  }

  /* ---------- zoom and pan ---------- */
  const ICON_FIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
  const ICON_FS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/></svg>';
  /* Wheel zoom (around the cursor), drag to pan, double-click toggles fit / 2x; a small overlay shows the zoom with a Fit
     button and, optionally, Fullscreen. target is scaled inside frame, so getBoundingClientRect() hit tests stay exact.
     pan: 'left' = left drag pans once zoomed in; 'space' = hold Space (or the middle button) to pan, left drag stays the tool's. */
  function zoomable(frame, target, { fullscreen = false, pan = 'left' } = {}) {
    let k = 1, x = 0, y = 0, space = false, drag = null;
    frame.classList.add('zoomable'); target.classList.add('zoom-target');
    const zui = h(`<div class="zoom-ui"><span class="num" data-z>100%</span><button class="zb" data-fit type="button" title="Fit (double-click)">${ICON_FIT}</button>${fullscreen ? `<button class="zb" data-fs type="button" title="Fullscreen">${ICON_FS}</button>` : ''}</div>`);
    frame.append(zui);
    const set = () => { target.style.transform = k === 1 ? '' : `translate(${x}px, ${y}px) scale(${k})`; };
    const apply = () => {
      if (k <= 1.001) { k = 1; x = 0; y = 0; }
      set();
      if (k !== 1) {
        // keep the picture over the frame's center: it can never be panned out of sight
        const f = frame.getBoundingClientRect(), r = target.getBoundingClientRect(), bx = r.left - x, by = r.top - y;
        const cx = f.left + f.width / 2, cy = f.top + f.height / 2;
        x = clamp(x, cx - bx - r.width, cx - bx); y = clamp(y, cy - by - r.height, cy - by); set();
      }
      $('[data-z]', zui).textContent = Math.round(k * 100) + '%';
      frame.classList.toggle('zoomed', k > 1);
    };
    const zoomAt = (k2, cx, cy) => {
      k2 = clamp(k2, 1, 16);
      const r = target.getBoundingClientRect(), u = (cx - r.left) / k, v = (cy - r.top) / k;
      x += u * (k - k2); y += v * (k - k2); k = k2; apply();
    };
    const reset = () => { k = 1; apply(); };
    frame.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(k * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY); }, { passive: false });
    frame.addEventListener('dblclick', (e) => { if (e.target.closest('.zoom-ui, .vbar')) return; if (k > 1) reset(); else zoomAt(2, e.clientX, e.clientY); });
    frame.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.zoom-ui, .vbar')) return;
      const ok = e.button === 1 || (e.button === 0 && (pan === 'left' ? k > 1 : space));
      if (!ok) return;
      e.preventDefault(); e.stopPropagation();  // no mousedown follows: the tool under it does not start a stroke
      drag = { px: e.clientX, py: e.clientY, x, y, moved: false }; frame.setPointerCapture(e.pointerId); frame.classList.add('panning');
    }, true);
    frame.addEventListener('pointermove', (e) => {
      if (!drag) return;
      x = drag.x + e.clientX - drag.px; y = drag.y + e.clientY - drag.py;
      drag.moved ||= Math.abs(e.clientX - drag.px) + Math.abs(e.clientY - drag.py) > 3; apply();
    });
    const end = () => { if (drag) frame._dragged = drag.moved; drag = null; frame.classList.remove('panning'); };
    frame.addEventListener('pointerup', end); frame.addEventListener('pointercancel', end);
    if (pan === 'space') {
      // Space pans while the pointer is over the picture (and nothing is being typed)
      let over = false;
      frame.addEventListener('pointerenter', () => { over = true; }); frame.addEventListener('pointerleave', () => { over = false; });
      addEventListener('keydown', (e) => { if (e.key === ' ' && over && frame.isConnected && !e.target.closest('input, textarea, select')) { e.preventDefault(); space = true; frame.classList.add('can-pan'); } });
      addEventListener('keyup', (e) => { if (e.key === ' ') { space = false; frame.classList.remove('can-pan'); } });
    }
    $('[data-fit]', zui).onclick = reset;
    if (fullscreen) {
      $('[data-fs]', zui).onclick = () => (document.fullscreenElement ? document.exitFullscreen() : frame.requestFullscreen()).catch(() => {});
      frame.addEventListener('fullscreenchange', () => { reset(); $('[data-fs]', zui).title = document.fullscreenElement === frame ? 'Exit fullscreen' : 'Fullscreen'; });
    }
    apply();
    return { reset, zoom: () => k };
  }

  /* An image, GIF or video to look at: zoom, pan, fullscreen. Videos get their own control bar outside the zoomed layer, so the
     controls never scale. kind: 'image' | 'gif' | 'video'. url: a blob: or file URL. */
  function mediaViewer(url, kind, { autoplay = true, loop = true, muted = false } = {}) {
    const v = h('<div class="viewer"><div class="zoom-layer"></div></div>'), layer = $('.zoom-layer', v);
    if (kind !== 'video') {
      const img = h('<img alt="" draggable="false">'); img.src = url; layer.append(img);
      zoomable(v, layer, { fullscreen: true });
      return v;
    }
    const vid = document.createElement('video');
    Object.assign(vid, { src: url, loop, autoplay, muted, playsInline: true, preload: 'metadata' });
    layer.append(vid);
    zoomable(v, layer, { fullscreen: true });
    const bar = h(`<div class="vbar"><button class="zb" data-pp type="button" title="Play / pause (or click the video)"></button><input type="range" min="0" max="1000" value="0" data-seek><span class="num" data-t></span>
      <button class="zb" data-loop type="button" title="Loop">⟳</button><button class="zb" data-mute type="button" title="Sound"></button></div>`);
    v.append(bar);
    const pp = $('[data-pp]', bar), seek = $('[data-seek]', bar), tt = $('[data-t]', bar), mu = $('[data-mute]', bar), lp = $('[data-loop]', bar);
    const mmss = (t) => { t = Math.floor(t || 0); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
    const draw = () => {
      pp.textContent = vid.paused ? '▶' : '❚❚'; mu.textContent = vid.muted ? '🔇' : '🔊'; lp.classList.toggle('on', vid.loop);
      v.classList.toggle('paused', vid.paused);
      if (!seek._held && vid.duration) seek.value = Math.round(vid.currentTime / vid.duration * 1000);
      tt.textContent = `${mmss(vid.currentTime)} / ${mmss(vid.duration)}`;
    };
    ['play', 'pause', 'timeupdate', 'loadedmetadata', 'volumechange'].forEach((ev) => vid.addEventListener(ev, draw));
    const toggle = () => (vid.paused ? vid.play().catch(() => {}) : vid.pause());
    pp.onclick = toggle;
    mu.onclick = () => { vid.muted = !vid.muted; };
    lp.onclick = () => { vid.loop = !vid.loop; draw(); };
    seek.onpointerdown = () => { seek._held = true; };
    seek.oninput = () => { if (vid.duration) vid.currentTime = seek.value / 1000 * vid.duration; };
    seek.onchange = () => { seek._held = false; };
    // a click plays or pauses; a drag that panned the zoomed video does not
    layer.addEventListener('click', () => { if (!v._dragged) toggle(); v._dragged = false; });
    draw();
    return v;
  }

  /* drag items of a container into a new order; onOrder(keys) when a drag ends (key = data-k or data-id). The container also
     gets a 'reorder' event while dragging, so the owner can follow along (the tab ink). */
  function sortable(container, itemSel, onOrder) {
    let dragged = null;
    const keyOf = (el) => el.dataset.k ?? el.dataset.id;
    container.addEventListener('dragstart', (e) => { dragged = e.target.closest?.(itemSel); if (!dragged) return; dragged.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', keyOf(dragged)); });
    container.addEventListener('dragover', (e) => {
      if (!dragged) return;
      e.preventDefault();
      const over = e.target.closest?.(itemSel);
      if (!over || over === dragged) return;
      const r = over.getBoundingClientRect();
      over.parentNode.insertBefore(dragged, e.clientX < r.left + r.width / 2 ? over : over.nextSibling);
      container.dispatchEvent(new CustomEvent('reorder'));
    });
    container.addEventListener('dragend', () => {
      if (!dragged) return;
      dragged.classList.remove('dragging'); dragged = null;
      onOrder($$(itemSel, container).map(keyOf));
    });
  }

  /* segmented control: fills el with buttons [[label, value]]; aria-pressed marks the current one; onPick(value) on a click */
  function seg(el, options, current, onPick) {
    el.classList.add('seg'); el.replaceChildren();
    const btns = options.map(([label, value]) => {
      const b = h(`<button type="button" aria-pressed="false">${esc(label)}</button>`);
      b.onclick = () => { set(value); onPick?.(value); }; el.append(b); return [b, value];
    });
    const set = (v) => { for (const [b, val] of btns) b.setAttribute('aria-pressed', String(val === v)); };
    set(current);
    return { set };
  }

  /* progress bar with a caption: el.set(fraction 0..1 | null = busy, text) */
  function progressBar() {
    const el = h('<div class="pbar"><div class="bar"><i style="width:0%"></i></div><span class="small dim num"></span></div>');
    const bar = $('.bar', el), fill = $('i', el), txt = $('span', el);
    el.set = (f, text) => {
      if (f == null) { bar.dataset.job = ''; fill.style.width = '100%'; }
      else { delete bar.dataset.job; fill.style.width = Math.round(clamp(f, 0, 1) * 100) + '%'; }
      if (text !== undefined) txt.textContent = text;
    };
    return el;
  }

  /* media tile for a library item or a media ref; the thumbnail fills in async */
  const AUDIO_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
  function tile(ref, { onClick, caption, selected = false } = {}) {
    const isItem = !!ref.handle, name = caption ?? ref.name;
    const t = h(`<div class="tile${ref.kind === 'audio' ? ' audio-tile' : ''}" title="${esc(ref.name)}">${ref.kind === 'audio' ? AUDIO_ICON : '<img alt="" loading="lazy">'}<div class="badge"><b>${esc(ref.kind === 'gif' ? 'gif' : ref.kind || '?')}</b></div><div class="cap"><span>${esc(name)}</span></div></div>`);
    t.classList.toggle('sel', selected);
    if (ref.kind !== 'audio') {
      const img = $('img', t);
      (isItem ? MS.lib.thumb(ref) : MS.src.thumb(ref)).then((u) => { if (u) img.src = u; }, () => {});
    }
    const badge = $('.badge', t);
    if (ref.kind === 'video') (isItem ? MS.lib.meta(ref) : MS.src.meta(ref)).then((m) => { if (m?.dur) badge.append(h(`<b>${esc(fmtTime(m.dur).replace(/\.\d+$/, ''))}</b>`)); }, () => {});
    else if (ref.size) badge.append(h(`<b>${esc(fmtBytes(ref.size))}</b>`));
    if (onClick) t.onclick = (e) => onClick(e, t);
    return t;
  }

  MS.ui = { toast, modal, confirmBox, promptBox, reduced, collapse, flash, selection, zoomable, mediaViewer, sortable, seg, progressBar, tile };
})();
