/* Generate: one model at a time. Qwen (text and vision) or a ComfyUI model (image, video, voice, music, sfx).
   Every preset has the Faster <-> Better slider; Advanced shows the raw parameters it sets. */
import { $, $$, h, esc, get, post, toast, fileUrl, baseName, watchJob, cancelJob, effortSlider, pref, setPref, newSeed, imagePicker, store, on, go, jobCard } from '../app.js';

let root, P = null, sel = pref('gen.preset', 'image'), stopWatch = null, liveText = '', currentId = null;
const QWEN_ICON = { describe: '👁', svg: '✒', draft: '📝', digest: '🔎', raw: '💬' };
const COMFY_ICON = { image: '🖼', video: '🎬', voice: '🗣', music: '🎵', sfx: '🔊' };
const QWEN_HINT = { describe: 'image in, text out', svg: 'one SVG drawing', draft: 'ready-to-paste text', digest: 'summarize logs', raw: 'no system prompt' };
const isQwen = (k) => P && k in P.qwen;
const formState = (k) => pref('gen.form.' + k, {});
const saveForm = (k, v) => setPref('gen.form.' + k, v);

export async function mount(el) {
  root = el;
  P = await get('/api/presets');
  el.append(h(`<div class="page-head"><div><h2>Generate</h2><p>Run one model. Everything it makes lands in the Library with the settings that made it.</p></div></div>`));
  const split = h('<div class="split wide-side"><div data-left></div><div data-right></div></div>');
  el.append(split);
  const left = $('[data-left]', split);
  const pick = h('<div class="card"><h3>Text and vision <span class="small faint">Qwen3.8-27B</span></h3><div class="preset-grid" data-q></div><h3 style="margin-top:14px">Media <span class="small faint">ComfyUI</span></h3><div class="preset-grid" data-c></div></div>');
  for (const [k, v] of Object.entries(P.qwen)) $('[data-q]', pick).append(h(`<button class="preset" data-k="${k}"><b>${QWEN_ICON[k] || ''} ${esc(v.label)}</b><small>${QWEN_HINT[k] || ''}</small></button>`));
  for (const [k, v] of Object.entries(P.comfy)) $('[data-c]', pick).append(h(`<button class="preset" data-k="${k}"><b>${COMFY_ICON[k] || ''} ${esc(v.label)}</b><small>${esc(v.tag)}</small></button>`));
  pick.onclick = (e) => { const b = e.target.closest('.preset'); if (!b) return; sel = b.dataset.k; setPref('gen.preset', sel); drawForm(); };
  left.append(pick, h('<div class="card" data-form></div>'));
  $('[data-right]', split).append(h('<div class="card" data-out><div class="empty">Results show here.</div></div>'), h('<div class="card" data-recent><h3>Recent</h3><div></div></div>'));
  on('text', (m) => { if (m.id === currentId) { liveText += m.t; const a = $('.answer', root); if (a) { a.textContent = liveText; a.scrollTop = a.scrollHeight; } } });
  on('snapshot', drawRecent);
  if (!(sel in P.qwen) && !(sel in P.comfy)) sel = 'image';
  drawForm();
}

function field(f, val, onChange) {
  const wrap = h(`<div class="field"><label class="lab">${esc(f.label)}</label></div>`);
  let inp;
  if (f.type === 'select') { inp = h(`<select class="input">${f.options.map((o) => `<option${String(o) === String(val) ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`); }
  else if (f.type === 'textarea') inp = h('<textarea class="input" rows="4"></textarea>');
  else if (f.type === 'bool') { const l = h(`<label class="check"><input type="checkbox"${val && val !== 'false' ? ' checked' : ''}> ${esc(f.label)}</label>`); $('input', l).onchange = (e) => onChange(e.target.checked); return l; }
  else inp = h(`<input class="input ${f.type !== 'text' ? 'num' : ''}" ${f.type === 'int' || f.type === 'float' ? `type="number" min="${f.min}" max="${f.max}" step="${f.step || 1}"` : ''} placeholder="${esc(f.placeholder || '')}">`);
  if (f.type !== 'select') inp.value = val ?? '';
  inp.onchange = () => onChange(f.type === 'int' ? parseInt(inp.value, 10) : f.type === 'float' ? parseFloat(inp.value) : inp.value);
  wrap.append(inp);
  return wrap;
}

function drawForm() {
  $$('.preset', root).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.k === sel)));
  const form = $('[data-form]', root); form.innerHTML = '';
  const st = Object.assign({ effort: 3, seed: '', prompt: '' }, formState(sel));
  const save = () => saveForm(sel, st);
  const q = isQwen(sel), meta = q ? P.qwen[sel] : P.comfy[sel];
  form.append(h(`<h3>${esc(meta.label)}${q ? '' : ` <span class="small faint">${esc(meta.tag)}</span>`}</h3>`));
  if (meta.note) form.append(h(`<p class="small dim" style="margin:-4px 0 10px">${esc(meta.note)}</p>`));
  const prompt = h(`<div class="field"><label class="lab">${sel === 'voice' ? 'Line to speak' : sel === 'music' ? 'Idea (genre, mood, instruments)' : sel === 'video' ? 'Motion and camera' : 'Prompt'}</label><textarea class="input" rows="4"></textarea></div>`);
  const pt = $('textarea', prompt); pt.value = st.prompt || ''; pt.oninput = () => { st.prompt = pt.value; save(); };
  form.append(prompt);
  let imgs = null;
  const params = Object.assign({}, st.params || {});
  if (q) {
    const mat = h('<details class="field"><summary class="lab" style="cursor:pointer">Material (text, logs, notes)</summary><textarea class="input" rows="6" style="margin-top:6px"></textarea></details>');
    const mt = $('textarea', mat); mt.value = st.material || ''; mt.oninput = () => { st.material = mt.value; save(); };
    if (st.material) mat.open = true;
    form.append(mat);
    imgs = imagePicker(sel === 'describe' ? 'Images to look at' : 'Images (optional)');
    (st.images || []).forEach((p) => imgs.add(p));
    form.append(imgs.el);
    if (store.online) {
      const on2 = h(`<label class="check field"><input type="checkbox"${st.online ? ' checked' : ''}> Online: qwen may search the web and read pages</label>`);
      $('input', on2).onchange = (e) => { st.online = e.target.checked; save(); }; form.append(on2);
    }
    const E = P.qwenEffort, mt2 = P.qwen[sel].maxTokens;
    form.append(effortSlider(st.effort, (v) => { st.effort = v; save(); },
      (v) => { const [th, m] = E[v - 1]; return `${th ? 'thinking · ' : ''}up to ${m === null ? Math.round(P.maxCtx / 1000) + 'k (whole context)' : ((mt2 * m) / 1000).toFixed(1) + 'k'} tokens`; }));
    const adv = h(`<details class="field"><summary class="lab" style="cursor:pointer">Advanced</summary><div style="margin-top:8px" class="props"><label class="check field"><input type="checkbox" data-think${st.think ? ' checked' : ''}> Thinking (reasoning before answering)</label><div class="field"><label class="lab">Max tokens (empty = from effort)</label><input class="input num" type="number" min="64" max="${P.maxCtx}" data-max></div></div></details>`);
    $('[data-think]', adv).onchange = (e) => { st.think = e.target.checked; save(); };
    const mx = $('[data-max]', adv); mx.value = st.max_tokens || ''; mx.onchange = () => { st.max_tokens = mx.value ? +mx.value : null; save(); };
    form.append(adv);
  } else {
    if (meta.needsImage) {
      imgs = imagePicker('First frame (one image)');
      if (st.image) imgs.add(st.image);
      form.append(imgs.el);
    }
    for (const f of meta.fields.filter((f2) => !f2.advanced)) form.append(field(f, params[f.key] ?? meta.params[f.key], (v) => { params[f.key] = v; st.params = params; save(); }));
    form.append(effortSlider(st.effort, (v) => { st.effort = v; save(); drawLadder(); },
      (v) => Object.entries(meta.effort).map(([k, ladder]) => `${k} ${ladder[v - 1]}`).join(' · ') || 'fixed'));
    const adv = h('<details class="field"><summary class="lab" style="cursor:pointer">Advanced <span class="faint">(empty = from effort)</span></summary><div class="props" style="margin-top:8px"></div></details>');
    const drawLadder = () => {
      const box = $('.props', adv); box.innerHTML = '';
      for (const f of meta.fields.filter((f2) => f2.advanced)) {
        const fromEffort = meta.effort[f.key] ? meta.effort[f.key][st.effort - 1] : meta.params[f.key];
        const fe = field({ ...f, placeholder: String(fromEffort ?? '') }, params[f.key] ?? '', (v) => { params[f.key] = v === '' || Number.isNaN(v) ? undefined : v; st.params = params; save(); });
        if (f.type === 'select' && params[f.key] === undefined) { const s = $('select', fe); s.prepend(h(`<option value="" selected>from effort (${esc(fromEffort)})</option>`)); s.onchange = () => { params[f.key] = s.value || undefined; st.params = params; save(); }; }
        box.append(fe);
      }
    };
    drawLadder();
    form.append(adv);
  }
  const seedRow = h(`<div class="row field"><label class="lab" style="margin:0">Seed</label><input class="input num" style="width:140px" placeholder="${q ? '42' : 'random'}"><button class="btn sm" title="New seed">🎲</button><span class="small faint">${q ? 'same seed + input = same answer' : 'same seed + settings = same file'}</span></div>`);
  const si = $('input', seedRow); si.value = st.seed || ''; si.onchange = () => { st.seed = si.value; save(); };
  $('button', seedRow).onclick = () => { st.seed = String(newSeed()); si.value = st.seed; save(); };
  form.append(seedRow);
  const goRow = h('<div class="row"><button class="btn primary" data-run style="padding:9px 20px">Generate</button><label class="check small"><input type="checkbox" data-force> Run even if DD2 is open</label></div>');
  form.append(goRow);
  $('[data-run]', goRow).onclick = async () => {
    const force = $('[data-force]', goRow).checked;
    try {
      let r;
      if (q) {
        st.images = imgs ? [...imgs.list] : []; save();
        r = await post('/api/qwen', { preset: sel, prompt: pt.value, material: st.material || '', images: st.images, seed: st.seed || null, effort: st.effort, think: !!st.think, max_tokens: st.max_tokens || null, online: !!st.online, force });
      } else {
        const pp = { ...params };
        if (imgs) { if (!imgs.list[0]) return toast('Pick the first frame image.', true); pp.image = imgs.list[0]; st.image = pp.image; save(); }
        r = await post('/api/comfy', { preset: sel, prompt: pt.value, params: pp, seed: st.seed || null, effort: st.effort, force });
      }
      follow(r.id, q);
    } catch (e) { toast(e.message, true); }
  };
  drawRecent();
}

function follow(id, q) {
  if (stopWatch) stopWatch();
  currentId = id; liveText = '';
  const out = $('[data-out]', root);
  let lastStatus = '';
  stopWatch = watchJob(id, (j) => {
    if (j.status === lastStatus && ['loading', 'running', 'queued'].includes(j.status)) { const b = $('.bar i', out); if (b) b.style.width = Math.round((j.progress || 0) * 100) + '%'; return; }
    lastStatus = j.status;
    out.innerHTML = '';
    out.append(jobCard({ ...j, elapsedS: Math.round(((j.ended || Date.now() / 1000) - j.started)) }, { noOutput: true }));
    if (q) {
      const a = h('<div class="answer" style="margin-top:10px"></div>'); a.textContent = j.text || liveText || (j.status === 'loading' ? 'Loading qwen…' : ''); out.append(a);
    }
    if (j.status === 'done' && j.output) result(out, j, q);
  });
}

async function result(out, j, q) {
  const p = j.output, ext = p.split('.').pop().toLowerCase();
  const actions = h('<div class="row" style="margin-top:10px"></div>');
  const btn = (label, fn) => { const b = h(`<button class="btn sm">${label}</button>`); b.onclick = fn; actions.append(b); };
  if (q) {
    const text = j.text ?? (await get('/api/text?path=' + encodeURIComponent(p))).text;
    $('.answer', out).textContent = text;
    if (ext === 'svg') { const pv = h('<div style="margin-top:10px;background:var(--surface-2);border-radius:8px;padding:10px;text-align:center"><img style="max-width:100%;max-height:360px" alt=""></div>'); $('img', pv).src = fileUrl(p) + '&t=' + Date.now(); out.append(pv); btn('Open in Image editor', () => go('image', { path: p })); }
    btn('Copy', async () => { await navigator.clipboard.writeText(text); toast('Copied.'); });
  } else if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
    const v = h('<div class="viewer" style="margin-top:10px"><img alt=""></div>'); $('img', v).src = fileUrl(p); out.append(v);
    btn('Image editor', () => go('image', { path: p })); btn('Animate it', () => { const s = formState('video'); s.image = p; saveForm('video', s); sel = 'video'; setPref('gen.preset', sel); drawForm(); });
  } else if (['mp4', 'webm'].includes(ext)) {
    const v = h('<div class="viewer" style="margin-top:10px"><video controls autoplay loop></video></div>'); $('video', v).src = fileUrl(p); out.append(v);
    btn('Add to Video editor', () => go('editor', { add: p }));
  } else {
    const a = h('<audio controls autoplay style="width:100%;margin-top:10px"></audio>'); a.src = fileUrl(p); out.append(a);
    btn('Add to Video editor', () => go('editor', { add: p }));
  }
  btn('Open', () => post('/api/open', { path: p }));
  btn('Show file', () => post('/api/reveal', { path: p }));
  out.append(actions);
}

function drawRecent() {
  const box = $('[data-recent] > div', root); if (!box || !P) return;
  const jobs = (store.snap?.jobs || []).filter((j) => j.preset === sel).slice(0, 6);
  box.innerHTML = jobs.length ? '' : '<span class="small faint">nothing yet for this preset</span>';
  for (const j of jobs) { const c = jobCard(j); c.style.cursor = 'pointer'; c.onclick = (e) => { if (!e.target.closest('button')) follow(j.id, isQwen(sel)); }; box.append(c); }
}
export function show() { drawRecent(); }
