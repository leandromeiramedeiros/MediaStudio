/* System: resources and the local AI runtimes, live. The cockpit's LOCAL AI panel, rebuilt for the web:
   gauges with drill-down (per thread, per process, disk by group), 5-minute sparklines, runtime cards with
   start/stop, live job cards, and the job feed by day with per-model rollups and job details. */
import { $, h, esc, on, post, store, secs, toast, jobCard, jobLinks, clearJobs } from '../app.js';

let root, open = new Set(), openJobs = new Set(), openDays = new Set(['TODAY']), moreDays = new Set();
try { open = new Set(JSON.parse(localStorage.getItem('ms.sys.open') || '[]')); } catch (e) { /* storage off */ }
const saveOpen = () => { try { localStorage.setItem('ms.sys.open', JSON.stringify([...open])); } catch (e) { /* storage off */ } };

const load = (pct) => (pct < 60 ? 'var(--ok)' : pct < 85 ? 'var(--mark)' : 'var(--danger)');
const size = (mb) => (mb < 1024 ? `${mb} MB` : mb < 102400 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb / 1024)} GB`);
const kTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const span = (s) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.floor(s / 3600)}h${String(Math.round((s % 3600) / 60)).padStart(2, '0')}`);
const PRESET_ICON = { digest: '🔎', describe: '👁', svg: '✒', draft: '📝', raw: '💬', plan: '🧭', image: '🖼', video: '🎬', voice: '🗣', music: '🎵', sfx: '🔊', render: '🎞', gif: '🌀', orchestrate: '✨', start: '⏻' };
const MODEL_COLOR = { qwen: 'var(--accent)', krea2: 'var(--mark)', 'ltx2.3': 'var(--orange)', 'qwen-tts': 'var(--cyan)', music3: 'var(--ok)', 'sa3-sfx': '#9da5b4', ffmpeg: 'var(--purple)', director: 'var(--danger)' };
const MEDIA_UNIT = { image: 'image', video: 'clip', voice: 'line', music: 'track', sfx: 'sound', render: 'render', gif: 'GIF', orchestrate: 'scene' };
const DISK_COLOR = { agents: 'var(--cyan)', repo: 'var(--accent)', models: 'var(--purple)', setup: 'var(--orange)' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ACTIVE = ['loading', 'running', 'queued'];

function spark(hist, idx, max, color) {
  if (!hist || hist.length < 2) return '';
  const t0 = hist[0][0], t1 = hist[hist.length - 1][0], W = 300, H = 34;
  const pts = hist.map((r) => `${((r[0] - t0) / Math.max(1, t1 - t0) * W).toFixed(1)},${(H - 2 - (r[idx] / Math.max(1, max)) * (H - 4)).toFixed(1)}`);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="0,${H} ${pts.join(' ')} ${W},${H}" fill="${color}" fill-opacity=".12" stroke="none"/><polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
}
function holderRows(rows, max, fmt) {
  return rows.map((p) => {
    const color = p.name === 'DD2' ? 'var(--mark)' : p.isAgent ? 'var(--cyan)' : 'var(--ink-3)';
    return `<div class="hrow"><span style="color:${p.isAgent || p.name === 'DD2' ? color : 'inherit'}">${p.isAgent ? '🤖 ' : p.name === 'DD2' ? '🎮 ' : ''}${esc(p.name)}${p.count > 1 ? ` ×${p.count}` : ''}</span><div class="bar"><i style="width:${Math.min(100, p.v / Math.max(1e-9, max) * 100)}%;background:${color}"></i></div><span class="n">${fmt(p.v)}</span></div>`;
  }).join('');
}
function gauge(key, name, value, max, val, sub, sparkHtml, detail) {
  const pct = Math.min(100, value / Math.max(1e-9, max) * 100), isOpen = open.has(key);
  const g = h(`<div class="gauge ${isOpen ? 'open' : ''}" data-key="${key}"><div class="g-top"><span class="g-name">${name} ${detail ? (isOpen ? '▾' : '▸') : ''}</span><span class="small dim">${sub[1] || ''}</span></div><div class="g-val num">${val}</div><div class="g-sub">${sub[0]}</div><div class="bar"><i style="width:${pct}%;background:${load(pct)}"></i></div>${sparkHtml}${isOpen && detail ? `<div class="detail">${detail}</div>` : ''}</div>`);
  if (detail) g.onclick = (e) => { if (e.target.closest('.detail')) return; isOpen ? open.delete(key) : open.add(key); saveOpen(); render(); };
  return g;
}

function render() {
  const L = store.snap;
  if (!root) return;
  const body = $('[data-body]', root);
  if (!L) { body.innerHTML = '<div class="empty">Reading resources…</div>'; return; }
  body.innerHTML = '';
  if (L.dd2) body.append(h('<div class="warnbar">🎮 <b>DD2 is running.</b> The GPU is kept for the game: new jobs are refused unless forced, and idle runtimes stop.</div>'));

  // gauges
  const gs = h('<div class="gauges"></div>'), hist = L.history || [], g = L.gpu;
  const per = L.cpu.perThread || [], busiest = per.reduce((b, v, i) => (v > per[b] ? i : b), 0);
  gs.append(gauge('cpu', 'CPU', L.cpu.pct, 100, `${Math.round(L.cpu.pct)}%`,
    [`${L.cpu.mhz ? (L.cpu.mhz / 1000).toFixed(1) + ' GHz · ' : ''}${L.cpu.cores} cores / ${L.cpu.threads} threads`, per.length ? `T${busiest} ${Math.round(per[busiest])}%` : ''],
    spark(hist, 1, 100, 'var(--accent)'),
    `<div class="threads">${per.map((v, i) => `<div class="hrow"><span class="dim mono">T${i}</span><div class="bar"><i style="width:${v}%;background:${load(v)}"></i></div><span class="n">${Math.round(v)}%</span></div>`).join('')}</div>`));
  const agentRam = L.ram.top.filter((p) => p.isAgent).reduce((a, p) => a + p.gb, 0);
  gs.append(gauge('ram', 'RAM', L.ram.used, L.ram.total, `${L.ram.used} <span class="small dim">/ ${Math.round(L.ram.total)} GB</span>`,
    [`agents ${agentRam.toFixed(1)} GB`], spark(hist, 4, L.ram.total, 'var(--cyan)'),
    holderRows(L.ram.top.map((p) => ({ ...p, v: p.gb })), L.ram.total, (v) => `${v} GB`)));
  if (g) {
    const gp = g.procs || [], gpuBusy = gp.filter((p) => p.util >= 0.5).sort((a, b) => b.util - a.util);
    gs.append(gauge('gpu', 'GPU', g.util ?? 0, 100, `${g.util ?? '?'}%`,
      [`${esc(g.name)}`, `${g.temp !== null ? g.temp + '°C' : ''}${g.power !== null ? ' · ' + Math.round(g.power) + ' W' : ''}`],
      spark(hist, 2, 100, 'var(--ok)'),
      gpuBusy.length ? holderRows(gpuBusy.map((p) => ({ ...p, v: p.util })), 100, (v) => `${Math.round(v)}%`) : '<span class="dim small">Nothing is using the GPU right now.</span>'));
    const procVram = gp.reduce((a, p) => a + p.vramGB, 0), agentVram = gp.filter((p) => p.isAgent).reduce((a, p) => a + p.vramGB, 0);
    const other = g.vramUsed - procVram;
    gs.append(gauge('vram', 'VRAM', g.vramUsed, g.vramTotal, `${g.vramUsed} <span class="small dim">/ ${Math.round(g.vramTotal)} GB</span>`,
      [`agents ${agentVram.toFixed(1)} GB`], spark(hist, 3, g.vramTotal, 'var(--purple)'),
      holderRows(gp.filter((p) => p.vramGB >= 0.05).map((p) => ({ ...p, v: p.vramGB })), g.vramTotal, (v) => `${v.toFixed(1)} GB`)
      + (other >= 0.2 ? `<div class="hrow"><span class="dim">Windows and driver</span><div class="bar"><i style="width:${other / g.vramTotal * 100}%;background:var(--ink-3)"></i></div><span class="n">${other.toFixed(1)} GB</span></div>` : '')));
  } else gs.append(h('<div class="gauge"><div class="g-name">GPU</div><div class="dim">nvidia-smi unavailable</div></div>'));
  const setupMB = L.disk.rows.reduce((a, r) => a + r.mb, 0), biggest = Math.max(1, ...L.disk.rows.map((r) => r.mb));
  gs.append(gauge('disk', 'DISK', L.disk.total - L.disk.free, L.disk.total, `${L.disk.free} <span class="small dim">GB free</span>`,
    [`setup ${size(setupMB)} of ${L.disk.total} GB`], '',
    L.disk.rows.map((r) => `<div class="hrow"><span style="color:${DISK_COLOR[r.group]}">${esc(r.label)}</span><div class="bar"><i style="width:${r.mb / biggest * 100}%;background:${DISK_COLOR[r.group]}"></i></div><span class="n">${size(r.mb)}</span></div>`).join('')));
  body.append(gs);

  // runtimes
  const rt = h('<div class="card" style="margin-top:12px"><h3>Runtimes</h3><div class="runtimes"></div></div>');
  const Q = L.qwen, C = L.comfy;
  const qp = (L.procs || []).filter((p) => p.kind === 'qwen').reduce((a, p) => ({ cpu: a.cpu + p.cpu, ram: a.ram + p.ramGB }), { cpu: 0, ram: 0 });
  const cp = (L.procs || []).filter((p) => p.kind === 'comfy').reduce((a, p) => ({ cpu: a.cpu + p.cpu, ram: a.ram + p.ramGB }), { cpu: 0, ram: 0 });
  const runtime = (name, key, icon, up, state, extra) => {
    const el = h(`<div class="runtime ${up ? 'up' : ''}"><div class="ic">${icon}</div><div class="grow"><b>${name}</b><div class="small dim">${state}</div>${extra ? `<div class="small faint">${extra}</div>` : ''}</div></div>`);
    const b = h(`<button class="btn sm">${up ? 'Stop' : 'Start'}</button>`);
    b.onclick = async () => { b.disabled = true; try { await post('/api/runtime', { name: key, action: up ? 'stop' : 'start' }); toast(up ? `${name} stopped.` : `Starting ${name}…`); } catch (e) { toast(e.message, true); } };
    el.append(b); return el;
  };
  const qm = Q.models?.[0];
  $('.runtimes', rt).append(
    runtime('Qwen3.8-27B', 'qwen', '🧠', Q.up, !Q.up ? 'stopped · starts on the next job' : Q.busy ? `${Q.busy} of 2 slots working` : 'loaded · stops after 10 idle min',
      Q.up ? `${qm ? qm.vramGB + ' GB VRAM · ctx ' + kTok(qm.ctx || 0) + ' · ' : ''}${qp.ram.toFixed(1)} GB RAM · ${qp.cpu}% CPU` : 'llama.cpp · 53 tok/s · vision'),
    runtime('ComfyUI', 'comfy', '🎨', C.up, !C.up ? 'stopped · starts on the next media job' : C.running + C.pending ? `${C.running} running · ${C.pending} queued` : 'idle · stops after 10 idle min',
      C.up ? `${cp.ram.toFixed(1)} GB RAM · ${cp.cpu}% CPU` : 'Krea 2 · LTX-2.3 · Qwen3-TTS · MiniMax-Music-3 · Stable Audio 3'),
  );
  rt.append(h('<p class="small faint" style="margin:10px 0 0">One GPU: starting one runtime stops the other. Qwen needs 15.4 of 16 GB.</p>'));
  body.append(rt);

  // agents: live cards, then the feed by day
  const jobs = L.jobs || [];
  const live = jobs.filter((j) => ACTIVE.includes(j.status));
  const card = h(`<div class="card" style="margin-top:12px"><div class="row"><h3 class="grow">Agents</h3><span class="small dim">${live.length ? live.length + ' working' : 'idle'}</span></div></div>`);
  if (jobs.length > live.length) { const c = h('<button class="btn ghost sm" title="Remove every finished job from the history">Clear history</button>'); c.onclick = () => clearJobs(); $('.row', card).append(c); }
  for (const j of live) card.append(jobCard(j));
  const done = jobs.filter((j) => !ACTIVE.includes(j.status));
  const now = new Date(), today = now.toDateString(), yest = new Date(now - 864e5).toDateString();
  const dayOf = (j) => { const d = new Date((j.started || 0) * 1000).toDateString(); return d === today ? 'TODAY' : d === yest ? 'YESTERDAY' : 'EARLIER'; };
  const groups = ['TODAY', 'YESTERDAY', 'EARLIER'].map((k) => ({ k, list: done.filter((j) => dayOf(j) === k) })).filter((g2) => g2.list.length);
  if (!jobs.length) card.append(h('<div class="empty">No jobs yet. Everything Generate, Orchestrate and the editors run shows up here.</div>'));
  if (groups.length && !openDays.size) openDays.add(groups[0].k);
  for (const { k, list } of groups) {
    const isOpen = openDays.has(k);
    const ok = list.filter((j) => j.status === 'done').length, err = list.filter((j) => j.status === 'error').length;
    const busy = list.reduce((a, j) => a + (j.elapsedS || 0), 0);
    const day = h(`<div class="day"><div class="day-head"><h3>${isOpen ? '▾' : '▸'} ${k}</h3><span class="small dim">${list.length} jobs · ${ok} done${err ? ` · <span style="color:var(--danger)">${err} failed</span>` : ''} · busy ${span(busy)}</span></div></div>`);
    $('.day-head', day).onclick = () => { isOpen ? openDays.delete(k) : openDays.add(k); render(); };
    if (isOpen) {
      // who did the work: busy time per model, tokens and speed or media made
      const by = new Map();
      for (const j of list) { if (!by.has(j.model)) by.set(j.model, []); by.get(j.model).push(j); }
      const maxBusy = Math.max(1, ...[...by.values()].map((js) => js.reduce((a, j) => a + j.elapsedS, 0)));
      const models = h('<div class="models"></div>');
      for (const [m, js] of [...by.entries()].sort((a, b) => b[1].reduce((x, j) => x + j.elapsedS, 0) - a[1].reduce((x, j) => x + j.elapsedS, 0))) {
        const t = js.reduce((a, j) => a + j.elapsedS, 0), tok = js.reduce((a, j) => a + (j.tokens || 0), 0);
        const tps = js.filter((j) => j.tokPerS); const avg = tps.length ? (tps.reduce((a, j) => a + j.tokPerS, 0) / tps.length).toFixed(1) : null;
        const made = js.filter((j) => j.status === 'done' && MEDIA_UNIT[j.preset]).length;
        const unit = MEDIA_UNIT[js[0].preset];
        models.append(h(`<div class="model" style="--mc:${MODEL_COLOR[m] || 'var(--ink-3)'}"><div class="row"><b class="grow" style="color:${MODEL_COLOR[m] || 'inherit'}">${esc(m)}</b><span class="num dim">${span(t)}</span></div><div class="bar" style="margin:5px 0"><i style="width:${t / maxBusy * 100}%"></i></div><div class="small dim">${js.length} job${js.length > 1 ? 's' : ''}${tok ? ` · ${kTok(tok)} tokens${avg ? ` · ${avg} t/s` : ''}` : ''}${made && unit && !tok ? ` · ${made} ${unit}${made > 1 ? 's' : ''}` : ''}</div></div>`));
      }
      day.append(models);
      const feed = h('<div class="feed"></div>');
      const shown = moreDays.has(k) ? list : list.slice(0, 8);
      for (const j of shown) {
        const d = new Date((j.started || 0) * 1000);
        const when = k === 'EARLIER' ? `${MONTHS[d.getMonth()]} ${d.getDate()}` : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const row = h(`<div class="frow"><span class="num dim">${when}</span><span><span class="st ${j.status}">${j.status}</span></span><span>${PRESET_ICON[j.preset] || '•'}</span><span class="num dim">${secs(j.elapsedS)}</span><span class="grow"><b style="color:${MODEL_COLOR[j.model] || 'inherit'}">${esc(j.model)}</b> <span class="dim">${esc(j.preset)} · ${esc(j.task || '')}</span></span><button class="btn ghost sm" title="Remove from history">✕</button></div>`);
        $('button', row).onclick = (e) => { e.stopPropagation(); clearJobs(j.id); };
        row.onclick = () => { openJobs.has(j.id) ? openJobs.delete(j.id) : openJobs.add(j.id); render(); };
        feed.append(row);
        if (openJobs.has(j.id)) feed.append(detail(j));
      }
      if (list.length > shown.length) { const m = h(`<button class="btn ghost sm">+${list.length - shown.length} more</button>`); m.onclick = () => { moreDays.add(k); render(); }; feed.append(m); }
      day.append(feed);
    }
    card.append(day);
  }
  body.append(card);
}

function detail(j) {
  const cells = [
    `⏱ ${secs(j.elapsedS)}${j.loadS ? ` (load ${j.loadS}s)` : ''}`,
    j.tokens ? `${j.inTokens ? j.inTokens + ' in · ' : ''}${j.tokens} out${j.tokPerS ? ` · ${j.tokPerS} t/s` : ''}${j.truncated ? ' · cut' : ''}` : '',
    j.peakVramGB ? `peak VRAM ${j.peakVramGB} GB` : '', j.ramGB ? `runtime RAM ${j.ramGB} GB` : '', j.seed ? `seed ${j.seed}` : '',
  ].filter(Boolean);
  const el = h(`<div class="jdetail">${cells.map((c) => `<span>${c}</span>`).join('')}<span style="grid-column:1/-1" class="dim">${esc(j.task || '')}</span></div>`);
  if (j.error) el.append(h(`<span style="grid-column:1/-1;color:var(--danger)">${esc(j.error)}</span>`));
  const links = jobLinks(j);
  if (links) { links.style.gridColumn = '1/-1'; el.append(links); }
  return el;
}

export function mount(el) {
  root = el;
  el.append(h(`<div class="page-head"><div><h2>System</h2><p>Resources and local AI runtimes, live. Click a gauge for who holds it.</p></div></div>`), h('<div data-body class="live"></div>'));
  // snapshots come every 0.6 s while busy: redrawing under a held button would swallow its click
  let held = false, stale = false;
  el.addEventListener('pointerdown', () => { held = true; });
  addEventListener('pointerup', () => { held = false; if (stale) { stale = false; setTimeout(() => { if (!root.hidden) render(); }, 60); } }, true);
  on('snapshot', () => { if (root.hidden) return; if (held) stale = true; else render(); });
  on('jobs-cleared', () => { if (!root.hidden) render(); });
  render();
}
export function show() { render(); }
