/* Agent: chat with qwen, which thinks out loud (Thinking box), runs Media Studio's tools (terminal log) and proposes
   files you accept or reject. One turn runs as a job; events stream over SSE ("agent"). */
import { $, $$, h, esc, get, post, toast, fileUrl, thumbUrl, baseName, on, store, cancelJob, effortSlider, pref, setPref, imagePicker, saveBlob, pickFolder, confirmBox, sound, collapse, flash } from '../app.js';

let root, sid = null, S = null, jobId = null, liveReason = null, liveText = null;
const opt = { think: pref('agent.think', false), online: pref('agent.online', true), effort: pref('agent.effort', 3) };
const ICON = { generate_image: '🖼', generate_video: '🎬', generate_voice: '🗣', generate_music: '🎵', generate_sfx: '🔊', orchestrate_scene: '✨', look_at_image: '👁', list_library: '📚', read_file: '📄', write_file: '✍', web_search: '🔎', fetch_url: '🌐' };

/* tiny markdown: code blocks, inline code, bold, line breaks */
function md(t) {
  const parts = String(t).split(/```(\w*)\n?([\s\S]*?)(?:```|$)/g);
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 3 === 0) out += esc(parts[i]).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
    else if (i % 3 === 2) out += `<pre class="code">${esc(parts[i])}</pre>`;
  }
  return out;
}
function mediaPreview(p) {
  const ext = p.split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) { const i = h(`<img class="ag-media" alt="" title="${esc(p)}">`); i.src = fileUrl(p); i.onclick = () => post('/api/open', { path: p }); return i; }
  if (['mp4', 'webm'].includes(ext)) { const v = h('<video class="ag-media" controls></video>'); v.src = fileUrl(p); return v; }
  if (['mp3', 'flac', 'wav', 'ogg', 'opus'].includes(ext)) { const a = h('<audio controls style="width:100%"></audio>'); a.src = fileUrl(p); return a; }
  return h(`<span class="mono small">${esc(p)}</span>`);
}

function addEvent(ev, live) {
  const log = $('[data-log]', root);
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80, n0 = log.children.length;
  if (ev.type === 'user') {
    liveReason = liveText = null;
    const el = h(`<div class="ag-user"><div>${md(ev.t)}</div></div>`);
    if (ev.images?.length) { const th = h('<div class="thumbs" style="margin-top:6px"></div>'); ev.images.forEach((p) => { const t = h('<div class="t"><img alt=""></div>'); $('img', t).src = thumbUrl(p); th.append(t); }); el.append(th); }
    if (ev.files?.length) el.append(h(`<div class="small dim">📎 ${ev.files.map((f) => esc(baseName(f))).join(', ')}</div>`));
    log.append(el);
  } else if (ev.type === 'reasoning') {
    if (!liveReason) { liveReason = h('<details class="ag-think" open><summary>Thinking…</summary><div class="mono"></div></details>'); log.append(liveReason); liveText = null; }
    $('div', liveReason).textContent += ev.t;
  } else if (ev.type === 'text') {
    if (liveReason) { $('summary', liveReason).textContent = 'Thought'; if (live) liveReason.open = false; liveReason = null; }
    if (!liveText) { liveText = h('<div class="ag-bot"></div>'); liveText._raw = ''; log.append(liveText); }
    liveText._raw += ev.t; liveText.innerHTML = md(liveText._raw);
  } else if (ev.type === 'tool') {
    if (liveReason) { $('summary', liveReason).textContent = 'Thought'; liveReason.open = false; liveReason = null; }
    liveText = null;
    const args = Object.entries(ev.args || {}).map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 160)}`).join(' ');
    log.append(h(`<div class="ag-term"><span class="pr">❯</span> ${ICON[ev.name] || '⚙'} <b>${esc(ev.name)}</b> <span class="dim">${esc(args)}</span>${live ? ' <span class="spin">…</span>' : ''}</div>`));
  } else if (ev.type === 'result') {
    const last = [...$$('.ag-term', log)].pop(); last?.querySelector('.spin')?.remove();
    const el = h(`<div class="ag-term out"><span class="dim">${ev.secs != null ? ev.secs + ' s · ' : ''}</span>${esc(ev.t.length > 400 ? ev.t.slice(0, 400) + '…' : ev.t)}</div>`);
    if (ev.t.length > 400) { el.style.cursor = 'pointer'; el.title = 'Click for the full result'; el.onclick = () => { el.textContent = ev.t; }; }
    log.append(el);
    for (const p of ev.files || []) log.append(mediaPreview(p));
  } else if (ev.type === 'file') {
    log.append(fileCard(ev));
  } else if (ev.type === 'file_decision') {
    const card = $(`.ag-file[data-pid="${ev.pid}"]`, log);
    if (card) setFileState(card, ev.status, ev.path);
  } else if (ev.type === 'stats') {
    log.append(h(`<div class="ag-stats">${esc(ev.t)}</div>`));
  } else if (ev.type === 'status') {
    log.append(h(`<div class="ag-stats">${esc(ev.t)}</div>`));
  } else if (ev.type === 'done') {
    liveReason = liveText = null;
  }
  if (live) {
    for (const c of [...log.children].slice(n0)) c.classList.add('pop');
    if (ev.type === 'file') sound('notify');
    else if (ev.type === 'file_decision' && ev.status === 'accepted') sound('success');
    else if (ev.type === 'done') sound('receive');
  }
  if (atBottom || live) log.scrollTop = log.scrollHeight;
}

function fileCard(ev) {
  const card = h(`<div class="ag-file" data-pid="${ev.pid}"><div class="row"><b class="grow">✍ ${esc(ev.name)}</b><span class="small dim">${ev.size} chars</span></div><pre class="code">${esc(ev.preview)}${ev.size > 4000 ? '\n…' : ''}</pre><div class="row" data-acts></div></div>`);
  const acts = $('[data-acts]', card);
  const b = (label, cls, fn) => { const x = h(`<button class="btn sm ${cls}">${label}</button>`); x.onclick = fn; acts.append(x); };
  b('Accept → Library', 'primary', () => decide(ev.pid, 'library'));
  b('Save to folder…', '', async () => { const d = await pickFolder('Save the file into'); if (d) decide(ev.pid, 'folder', d); });
  b('Reject', 'danger', () => decide(ev.pid, 'reject'));
  const f = S?.files?.[ev.pid];
  if (f && f.status !== 'proposed') setFileState(card, f.status, f.path);
  return card;
}
function setFileState(card, status, path) {
  const acts = $('[data-acts]', card); acts.innerHTML = '';
  if (status === 'accepted') {
    acts.append(h(`<span class="small" style="color:var(--ok)">✓ saved: <span class="mono">${esc(path)}</span></span>`));
    const o = h('<button class="btn ghost sm">Open</button>'); o.onclick = () => post('/api/open', { path }); acts.append(o);
  } else acts.append(h('<span class="small dim">✕ rejected</span>'));
}
async function decide(pid, action, folder) {
  try { await post('/api/agent/file', { sid, pid, action, folder }); } catch (e) { toast(e.message, true); }
}

async function openSession(id) {
  sid = id; setPref('agent.sid', id);
  S = await get('/api/agent/session?id=' + encodeURIComponent(id));
  const log = $('[data-log]', root); log.innerHTML = '';
  liveReason = liveText = null;
  if (!S.log.length) log.append(h(HELLO));
  for (const ev of S.log) addEvent(ev, false);
  $$('.ag-think', log).forEach((d) => { d.open = false; $('summary', d).textContent = 'Thought'; });
  drawSessions();
  log.scrollTop = log.scrollHeight;
}
/* no session yet: the first Send creates one */
function blankChat() {
  sid = null; S = null; setPref('agent.sid', null);
  liveReason = liveText = null;
  const log = $('[data-log]', root); log.innerHTML = ''; log.append(h(HELLO));
}
const HELLO = '<div class="empty" data-hello>Ask for anything: "make a moody tavern image and a matching ambience sound", "write a changelog from these notes", "what is in this screenshot?"</div>';

async function drawSessions() {
  const { sessions } = await get('/api/agent/sessions');
  const box = $('[data-sessions]', root); box.innerHTML = '';
  for (const s of sessions) {
    const it = h(`<div class="item ${s.id === sid ? 'active' : ''}" style="cursor:pointer"><span class="grow" title="${esc(s.title)}">${esc(s.title)}</span><span class="small faint">${s.turns}</span></div>`);
    const del = h('<button class="btn ghost sm" title="Delete chat">✕</button>');
    del.onclick = async (e) => {
      e.stopPropagation();
      if (!(await confirmBox('Delete chat', `Move "${s.title}" to the Recycle Bin?`, 'Delete', true))) return;
      if (s.id === sid) { const next = sessions.find((x) => x.id !== s.id); if (next) openSession(next.id); else blankChat(); }
      await Promise.all([collapse(it), post('/api/agent/delete', { sid: s.id }).catch((err) => toast(err.message, true))]);
      drawSessions();
    };
    it.append(del); it.onclick = () => openSession(s.id);
    box.append(it);
  }
}
async function newChat() { const s = await post('/api/agent/new'); await openSession(s.id); $('textarea', root).focus(); }

function setBusy(on2) {
  $('[data-send]', root).hidden = on2; $('[data-stop]', root).hidden = !on2;
}

export async function mount(el, arg) {
  root = el;
  el.append(h(`<div class="page-head"><div><h2>Agent</h2><p>Chat with qwen. It thinks out loud, uses Media Studio's tools, and asks before it saves a file.</p></div></div>`));
  el.append(h(`<div class="ag-wrap"><div class="ag-side card"><button class="btn primary" data-new style="width:100%;margin-bottom:10px">+ New chat</button><div class="list" data-sessions></div></div>
    <div class="ag-main"><div class="ag-log" data-log></div>
      <div class="ag-compose card"><div data-att></div><textarea class="input" rows="3" placeholder="Message qwen…  (Enter sends, Shift+Enter new line)"></textarea>
        <div class="row" style="margin-top:8px"><label class="check small"><input type="checkbox" data-think> Think</label><label class="check small" data-onl><input type="checkbox" data-online> Online tools</label>
          <button class="btn sm" data-attach>📎 File…</button><input type="file" hidden data-fi><span class="small dim" data-files></span><span class="grow"></span><div data-eff style="width:260px"></div>
          <button class="btn primary" data-send>Send</button><button class="btn danger" data-stop hidden>Stop</button></div></div></div></div>`));
  const imgs = imagePicker('Images');
  $('[data-att]', el).append(imgs.el);
  imgs.el.classList.add('ag-imgs');
  let files = [];
  const fi = $('[data-fi]', el);
  $('[data-attach]', el).onclick = () => fi.click();
  fi.onchange = async () => { for (const f of fi.files) files.push((await saveBlob(f, f.name, 'text', 'import')).path); fi.value = ''; $('[data-files]', el).textContent = files.map(baseName).join(', '); };
  const th = $('[data-think]', el), onl = $('[data-online]', el);
  th.checked = opt.think; onl.checked = opt.online;
  th.onchange = () => { opt.think = th.checked; setPref('agent.think', opt.think); };
  onl.onchange = () => { opt.online = onl.checked; setPref('agent.online', opt.online); };
  const drawOnline = () => { $('[data-onl]', el).title = store.online ? 'Internet is up: qwen may search the web and read pages' : 'Offline: web tools are not offered'; $('[data-onl]', el).style.opacity = store.online ? 1 : 0.5; };
  on('online', drawOnline); drawOnline();
  $('[data-eff]', el).append(effortSlider(opt.effort, (v) => { opt.effort = v; setPref('agent.effort', v); }, (v) => ['quick', 'short', 'balanced', 'thinks', 'thinks long'][v - 1]));
  const ta = $('textarea', el);
  const send = async () => {
    const text = ta.value.trim();
    if (!text && !imgs.list.length) return;
    if (!sid) await newChat();
    $('[data-hello]', root)?.remove();
    try {
      const r = await post('/api/agent/send', { sid, text, images: [...imgs.list], files, think: opt.think, online: opt.online, effort: opt.effort });
      jobId = r.id; setBusy(true); sound('send');
      ta.value = ''; imgs.clear(); files = []; $('[data-files]', el).textContent = '';
    } catch (e) { toast(e.message, true); }
  };
  $('[data-send]', el).onclick = send;
  $('[data-stop]', el).onclick = () => jobId && cancelJob(jobId);
  ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
  $('[data-new]', el).onclick = newChat;
  on('agent', (ev) => { if (ev.sid !== sid) return; if (ev.type === 'file' && S) S.files[ev.pid] = { status: 'proposed' }; addEvent(ev, true); if (ev.type === 'done') { setBusy(false); drawSessions(); } });
  on('job', (j) => { if (j.id === jobId && !['loading', 'running', 'queued'].includes(j.status)) { setBusy(false); if (j.status === 'error') { toast(j.error || 'Agent failed', true); addEvent({ type: 'status', t: '✖ ' + (j.error || 'failed') }, true); } if (j.status === 'cancelled') addEvent({ type: 'status', t: '■ stopped' }, true); } });
  const last = pref('agent.sid', null);
  const { sessions } = await get('/api/agent/sessions');
  if (arg?.sid || arg?.task) await jumpTo(arg, sessions);
  else if (last && sessions.some((s) => s.id === last)) await openSession(last);
  else if (sessions.length) await openSession(sessions[0].id);
  else blankChat();
  const running = [...store.jobs.values()].find((j) => j.preset === 'agent' && ['loading', 'running', 'queued'].includes(j.status));
  if (running) { jobId = running.id; setBusy(true); }
}
export async function show(arg) {
  if (arg?.sid || arg?.task) await jumpTo(arg);
  else drawSessions();
}

/* open the chat a job belongs to and flash the turn it ran (a jump from System or the job tray).
   Jobs from before the session id was recorded are found by their task text. */
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
async function jumpTo({ sid: id, task }, sessions) {
  const want = flat(task).slice(0, 60);
  sessions ||= (await get('/api/agent/sessions')).sessions;
  if (!id || !sessions.some((s) => s.id === id)) {
    id = null;
    for (const s of sessions) {
      const full = await get('/api/agent/session?id=' + encodeURIComponent(s.id)).catch(() => null);
      if (full?.log.some((ev) => ev.type === 'user' && flat(ev.t).startsWith(want))) { id = s.id; break; }
    }
  }
  if (!id) { toast('That chat was deleted.', true); if (!sid) blankChat(); drawSessions(); return; }
  await openSession(id);
  const turns = $$('.ag-user', root);
  flash(turns.filter((u) => flat(u.textContent).startsWith(want)).pop() || turns.pop());
}
