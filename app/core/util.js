/* MS.util: small helpers every file uses. Loads first; creates window.MS. */
window.MS = window.MS || {};
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const baseName = (p) => String(p || '').split(/[\/]/).pop();
  const ext = (n) => { const m = /\.([A-Za-z0-9]+)$/.exec(baseName(n)); return m ? m[1].toLowerCase() : ''; };
  const stem = (n) => baseName(n).replace(/\.[A-Za-z0-9]+$/, '');
  function fmtTime(t) {
    if (!isFinite(t)) t = 0;
    const cs = Math.round(t * 100), m = Math.floor(cs / 6000), s = Math.floor((cs % 6000) / 100), c = cs % 100;
    return `${m}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
  }
  function fmtBytes(n) {
    n = +n || 0;
    if (n < 1000) return n + ' B';
    if (n < 1e6) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + ' KB';
    if (n < 1e9) return (n / 1e6).toFixed(2) + ' MB';
    return (n / 1e9).toFixed(2) + ' GB';
  }
  /* remembered choices (localStorage; the app works without it) */
  const pref = (key, fallback) => { try { const v = localStorage.getItem('ms.' + key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; } };
  const setPref = (key, v) => { try { localStorage.setItem('ms.' + key, JSON.stringify(v)); } catch (e) { /* storage off */ } };
  /* events */
  const listeners = {};
  const on = (kind, fn) => { (listeners[kind] ||= new Set()).add(fn); return () => listeners[kind].delete(fn); };
  const emit = (kind, data) => { for (const fn of [...(listeners[kind] || [])]) { try { fn(data); } catch (e) { console.error(e); } } };
  const debounce = (fn, ms = 200) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const KINDS = {
    video: 'mp4 mkv mov webm m4v avi', image: 'png jpg jpeg webp bmp avif', gif: 'gif', audio: 'mp3 wav flac ogg m4a aac opus',
  };
  const KIND_OF = {};
  for (const [k, v] of Object.entries(KINDS)) for (const e of v.split(' ')) KIND_OF[e] = k;
  const kindOf = (name) => KIND_OF[ext(name)] || null;
  /* tab registry: tab scripts load before shell.js, which reads MS.tabs and defines MS.go */
  MS.tabs = [];
  MS.tab = (def) => { MS.tabs.push(def); };
  MS.util = { $, $$, h, esc, clamp, fmtTime, fmtBytes, baseName, stem, ext, pref, setPref, on, emit, debounce, sleep, uid, kindOf };
})();
