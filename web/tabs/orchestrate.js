/* Orchestrate: describe a scene, qwen plans the shots, the media models make them, ffmpeg cuts the draft. */
import { $, h, esc, post, get, toast, fileUrl, baseName, watchJob, cancelJob, effortSlider, pref, setPref, newSeed, imagePicker, store, on, go, secs } from '../app.js';

let root, stopWatch = null, currentId = null;
const S = { aspect: pref('orc.aspect', '16:9'), animate: pref('orc.animate', false), music: pref('orc.music', true), effort: pref('orc.effort', 2), seed: pref('orc.seed', 42) };
const EFFORT_TEXT = ['quick sketch', 'draft', 'balanced', 'detailed', 'best'];
const EXAMPLES = [
  'A knight enters a rainy tavern at night; a drunk companion waves at him from the bar and they share a laugh.',
  'A 20-second trailer for a fantasy mod: a griffin flies over cliffs at dawn, a warrior raises a glowing sword, title card "Skyward".',
  'Cozy lo-fi loop: a cat sleeping on a windowsill while rain falls on a city at dusk.',
];

function estimate() {
  // rough seconds: plan + per-shot stills (+ clips) + audio + render, from measured speeds
  const shots = 4;
  const per = [6, 8, 10, 14, 18][S.effort - 1];
  return 35 + shots * per + (S.animate ? shots * [45, 55, 70, 90, 110][S.effort - 1] : 0) + shots * 20 + (S.music ? 40 : 0) + 15;
}

export function mount(el) {
  root = el;
  el.append(h(`<div class="page-head"><div><h2>Orchestrate</h2><p>Describe a scene. Qwen plans the shots; images, clips, voice, sound and music are made locally and cut into a draft you can edit.</p></div></div>`));
  const hero = h('<div class="hero"></div>');
  const left = h(`<div class="card">
    <div class="field"><label class="lab">Scene</label><textarea class="input prompt-big" placeholder="What should happen? Who, where, mood, length…"></textarea></div>
    <div class="row small" data-ex style="margin:-4px 0 12px"></div>
    <div data-imgs></div>
    <div class="row" style="gap:16px;margin-bottom:12px">
      <div><label class="lab">Shape</label><div class="seg" data-aspect><button data-v="16:9">16:9</button><button data-v="9:16">9:16</button><button data-v="1:1">1:1</button></div></div>
      <label class="check"><input type="checkbox" data-anim> Animate shots <span class="faint small">(LTX video, slower)</span></label>
      <label class="check"><input type="checkbox" data-music> Music</label>
    </div>
    <div data-effort></div>
    <div class="row" style="margin-top:4px"><label class="lab" style="margin:0">Seed</label><input class="input num" data-seed style="width:130px"><button class="btn sm" data-reroll title="New seed">🎲</button><span class="grow"></span><span class="small dim" data-est></span></div>
    <div class="row" style="margin-top:14px"><button class="btn primary" data-go style="padding:10px 22px;font-size:15px">✨ Orchestrate</button><button class="btn" data-cancel hidden>Cancel</button><span class="small dim" data-warn></span></div>
  </div>`);
  const right = h(`<div><div class="card" data-out><div class="empty">Your draft appears here: the shot list first, then each piece as it is made, then the cut.</div></div><div class="card" data-hist><h3>Recent scenes</h3><div class="list"></div></div></div>`);
  hero.append(left, right);
  el.append(hero);

  const ta = $('textarea', left);
  ta.value = pref('orc.request', '');
  ta.oninput = () => setPref('orc.request', ta.value);
  for (const ex of EXAMPLES) { const b = h(`<button class="btn ghost sm" title="${esc(ex)}">${esc(ex.slice(0, 38))}…</button>`); b.onclick = () => { ta.value = ex; setPref('orc.request', ex); }; $('[data-ex]', left).append(b); }
  const imgs = imagePicker('Reference images (optional: qwen looks at them while planning)');
  $('[data-imgs]', left).append(imgs.el);
  const seg = $('[data-aspect]', left);
  const drawSeg = () => seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === S.aspect)));
  seg.onclick = (e) => { const b = e.target.closest('button'); if (!b) return; S.aspect = b.dataset.v; setPref('orc.aspect', S.aspect); drawSeg(); };
  drawSeg();
  const anim = $('[data-anim]', left), mus = $('[data-music]', left), seed = $('[data-seed]', left), est = $('[data-est]', left);
  const upd = () => { est.textContent = `≈ ${Math.round(estimate() / 60)} min`; };
  anim.checked = S.animate; mus.checked = S.music; seed.value = S.seed;
  anim.onchange = () => { S.animate = anim.checked; setPref('orc.animate', S.animate); upd(); };
  mus.onchange = () => { S.music = mus.checked; setPref('orc.music', S.music); upd(); };
  seed.onchange = () => { S.seed = +seed.value || 42; setPref('orc.seed', S.seed); };
  $('[data-reroll]', left).onclick = () => { S.seed = newSeed(); seed.value = S.seed; setPref('orc.seed', S.seed); };
  $('[data-effort]', left).append(effortSlider(S.effort, (v) => { S.effort = v; setPref('orc.effort', v); upd(); },
    (v) => `${EFFORT_TEXT[v - 1]} · image steps ${[4, 6, 8, 12, 16][v - 1]}${S.animate ? ` · video ${['512x320', '640x416', '768x512', '896x576', '1024x640'][v - 1]}` : ''}`));
  upd();

  $('[data-go]', left).onclick = async () => {
    if (!ta.value.trim()) return toast('Describe the scene first.', true);
    try {
      const r = await post('/api/orchestrate', { request: ta.value, images: imgs.list, seed: S.seed, animate: S.animate, aspect: S.aspect, music: S.music, effort: S.effort });
      follow(r.id);
    } catch (e) { toast(e.message, true); }
  };
  $('[data-cancel]', left).onclick = () => currentId && cancelJob(currentId);
  on('snapshot', (s) => { $('[data-warn]', left).textContent = s.dd2 ? 'DD2 is running: jobs are refused.' : ''; drawHistory(); });
  drawHistory();
  // resume a scene that is still running
  const running = [...store.jobs.values()].find((j) => j.preset === 'orchestrate' && ['loading', 'running', 'queued'].includes(j.status));
  if (running) follow(running.id);
}

function drawHistory() {
  const list = $('[data-hist] .list', root); if (!list) return;
  const jobs = (store.snap?.jobs || []).filter((j) => j.preset === 'orchestrate').slice(0, 8);
  list.innerHTML = jobs.length ? '' : '<span class="small faint">none yet</span>';
  for (const j of jobs) {
    const it = h(`<button class="item btn ghost" style="justify-content:flex-start;text-align:left"><span class="st ${j.status}">${j.status}</span><span class="grow">${esc(j.task)}</span><span class="num small dim">${secs(j.elapsedS)}</span></button>`);
    it.onclick = () => follow(j.id); list.append(it);
  }
}

function follow(id) {
  if (stopWatch) stopWatch();
  currentId = id;
  const out = $('[data-out]', root);
  stopWatch = watchJob(id, (j) => render(out, j), 1000);
}

let lastKey = '';
function render(out, j) {
  const key = `${j.id}|${j.status}|${j.progress}|${(j.steps || []).length}|${j.plan ? 1 : 0}`;
  if (key === lastKey) return;
  lastKey = key;
  const active = ['loading', 'running', 'queued'].includes(j.status);
  $('[data-go]', root).disabled = active;
  $('[data-cancel]', root).hidden = !active;
  out.innerHTML = '';
  out.append(h(`<div class="row" style="margin-bottom:8px"><h3 class="grow">${esc(j.plan?.title || 'Planning…')}</h3><span class="st ${j.status}">${j.status}</span></div>`));
  if (active) out.append(h(`<div class="bar" style="margin-bottom:10px"><i style="width:${Math.round((j.progress || 0) * 100)}%"></i></div>`));
  if (j.error) out.append(h(`<p style="color:var(--danger)">${esc(j.error)}</p>`));
  if (j.output && j.status === 'done') {
    const v = h('<div class="viewer" style="margin-bottom:10px"><video controls autoplay></video></div>'); $('video', v).src = fileUrl(j.output); out.append(v);
    const row = h('<div class="row" style="margin-bottom:12px"></div>');
    const ed = h('<button class="btn primary">Open in Video editor</button>'); ed.onclick = () => go('editor', { project: j.project });
    const sh = h('<button class="btn">Show file</button>'); sh.onclick = () => post('/api/reveal', { path: j.output });
    const gif = h('<button class="btn">Make Nexus GIF</button>'); gif.onclick = async () => { await post('/api/gif', { src: j.output }); toast('GIF job started: see the job tray.'); };
    row.append(ed, sh, gif); out.append(row);
  }
  if (j.plan) {
    const shots = h('<div style="margin-bottom:10px"></div>');
    j.plan.shots.forEach((s, i) => shots.append(h(`<div class="shot"><span class="n">${i + 1}</span><div><div>${esc(s.image)}</div><div class="small dim">${s.motion ? '🎬 ' + esc(s.motion) + ' · ' : ''}${s.seconds}s${s.voice ? ' · 🗣 “' + esc(s.voice) + '”' : ''}${s.sfx ? ' · 🔊 ' + esc(s.sfx) : ''}${s.caption ? ' · 🅣 ' + esc(s.caption) : ''}</div></div></div>`)));
    if (j.plan.music) shots.append(h(`<div class="small dim" style="margin-top:6px">🎵 ${esc(j.plan.music)}</div>`));
    out.append(shots);
  }
  if (j.steps?.length) {
    const ul = h('<ul class="steps"></ul>');
    for (const s of j.steps) ul.append(h(`<li><span class="num">${s.at}s</span><span>${esc(s.text)}</span></li>`));
    out.append(ul);
  }
}

export function show() { drawHistory(); }
