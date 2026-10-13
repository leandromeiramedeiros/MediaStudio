// MS.render: editor project -> MP4 (H.264 + AAC) with WebCodecs. Needs MS.mp4 (demuxer + muxer) loaded first.
// Self-contained otherwise. Frames are pulled in output order, so every source only moves forward in time.
(() => {
  const MS = (window.MS = window.MS || {});
  const SR = 48000;
  const BIG_FILE = 300e6; // decodeAudioData reads the whole file: refuse above this
  const FONT = '"Bricolage Grotesque", "IBM Plex Sans", system-ui, sans-serif';
  const hex = (n) => n.toString(16).padStart(2, '0');
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  const cancelled = (sig) => { if (sig && sig.cancelled) throw new Error('cancelled'); };
  const once = (el, ok, timeout = 15000) => new Promise((res, rej) => {
    const t = setTimeout(() => { done(); rej(new Error('media timeout')); }, timeout);
    const done = () => { clearTimeout(t); el.removeEventListener(ok, onOk); el.removeEventListener('error', onErr); };
    const onOk = () => { done(); res(); }, onErr = () => { done(); rej(new Error('media error')); };
    el.addEventListener(ok, onOk); el.addEventListener('error', onErr);
  });
  const mc = new MessageChannel();
  const yieldTask = () => new Promise((r) => { mc.port1.onmessage = () => r(); mc.port2.postMessage(0); }); // setTimeout is throttled in background tabs
  // Resolves once the encoder queue is <= max (or the encoder died).
  const drain = (enc, max) => new Promise((res) => {
    const ok = () => enc.state === 'closed' || enc.encodeQueueSize <= max;
    if (ok()) return res();
    const f = () => { if (ok()) { enc.removeEventListener('dequeue', f); clearInterval(iv); res(); } };
    const iv = setInterval(f, 500);
    enc.addEventListener('dequeue', f);
  });

  // ------------------------------------------------------------ timeline

  const clipDur = (c) => (c.kind === 'video' ? Math.max(0, num(c.out, 0) - num(c.in, 0)) || num(c.dur, 0) : num(c.dur, 3));

  // Clips play back-to-back; clip i>0 starts xf seconds before the previous one ends (crossfade over xf).
  function layout(p) {
    const clips = [];
    let end = 0;
    (p.v1 || []).forEach((c, i) => {
      const d = clipDur(c), prev = clips[i - 1];
      const xf = prev ? Math.max(0, Math.min(num(prev.c.xfade, 0), d / 2, prev.d / 2)) : 0;
      const start = prev ? prev.start + prev.d - xf : 0;
      clips.push({ c, start, d, xf });
      end = Math.max(end, start + d);
    });
    let total = end;
    for (const t of p.text || []) total = Math.max(total, num(t.end, 0));
    for (const o of p.overlays || []) total = Math.max(total, num(o.end, 0));
    for (const a of p.audio || []) total = Math.max(total, num(a.start, 0) + Math.max(0, num(a.out, 0) - num(a.in, 0)));
    return { clips, total };
  }

  // ------------------------------------------------------------ video sources: { frameAt(t), close(), w, h }

  // MP4/MOV: demuxer + VideoDecoder. frameAt(s) = latest frame with timestamp <= s; s never goes backwards.
  async function mp4VideoSource(file, mux, inT, outT) {
    const tr = mux && mux.tracks.find((t) => t.type === 'video');
    if (!tr || !window.VideoDecoder) return null;
    const cfg = { codec: tr.codec, codedWidth: tr.width, codedHeight: tr.height };
    if (tr.description) cfg.description = tr.description;
    const sup = await VideoDecoder.isConfigSupported(cfg).catch(() => null);
    if (!sup || !sup.supported) return null;
    const S = tr.samples, n = S.length, tol = 0.0005;
    // target = frame shown at inT; start decoding at the keyframe before it (decode order), stop a little after outT
    let best = -1;
    for (let i = 0; i < n; i++) if (S[i].cts <= inT + tol && (best < 0 || S[i].cts > S[best].cts)) best = i;
    if (best < 0) { best = 0; for (let i = 1; i < n; i++) if (S[i].cts < S[best].cts) best = i; }
    let first = best; while (first > 0 && !S[first].key) first--;
    let last = best;
    for (let i = best + 1; i < n && i - last <= 32; i++) if (S[i].cts <= outT + tol) last = i;

    const q = []; let cur = null, wake = null, err = null, done = false, flushed = false, closed = false, next = first;
    const poke = () => { if (wake) { const w = wake; wake = null; w(); } };
    const waitWake = () => new Promise((res) => {
      const t = setTimeout(() => { err = err || new Error('video decoder stalled'); poke(); }, 20000);
      wake = () => { clearTimeout(t); res(); };
    });
    const dec = new VideoDecoder({ output: (f) => { if (closed) f.close(); else { q.push(f); poke(); } }, error: (e) => { err = e; poke(); } });
    dec.configure(cfg);

    async function feed() {
      const take = Math.min(next + 24, last + 1), batch = S.slice(next, take);
      const bufs = await MS.mp4.readMany(file, batch);
      if (closed) return;
      batch.forEach((s, i) => dec.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: Math.round(s.cts * 1e6), duration: Math.round(s.dur * 1e6), data: bufs[i] })));
      next = take;
    }
    return {
      w: tr.width, h: tr.height,
      async frameAt(s) {
        const lim = (s + tol) * 1e6;
        for (;;) {
          if (err) throw err;
          while (q.length && q[0].timestamp <= lim) { if (cur) cur.close(); cur = q.shift(); }
          if (q.length || done) return cur || q[0] || null; // output is in presentation order: a later frame has appeared, so cur is the answer
          if (next <= last) { if (dec.decodeQueueSize < 12) { await feed(); continue; } }
          else if (!flushed) { flushed = true; dec.flush().then(() => { done = true; poke(); }, (e) => { err = e; poke(); }); }
          await waitWake();
        }
      },
      close() {
        closed = true;
        for (const f of q) f.close(); q.length = 0;
        if (cur) { cur.close(); cur = null; }
        if (dec.state !== 'closed') dec.close();
      },
    };
  }

  // Any container the browser plays: a hidden <video> seeked per frame.
  async function htmlVideoSource(file) {
    const v = document.createElement('video'), url = URL.createObjectURL(file);
    v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = url;
    try { await once(v, 'loadeddata'); } catch (e) { URL.revokeObjectURL(url); throw new Error('cannot decode ' + (file.name || 'video')); }
    let at = -1;
    return {
      w: v.videoWidth, h: v.videoHeight,
      async frameAt(s) {
        if (Math.abs(s - at) > 1e-4) {
          const p = once(v, 'seeked', 8000).catch(() => {});
          v.currentTime = s; await p; at = s;
        }
        return v;
      },
      close() { v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); },
    };
  }

  // Images, and GIFs (every frame via ImageDecoder when present, looping; else the first frame).
  async function imageSource(file, anim) {
    if (anim && window.ImageDecoder) {
      try {
        const dec = new ImageDecoder({ data: await file.arrayBuffer(), type: file.type || 'image/gif' });
        await dec.tracks.ready;
        const nf = dec.tracks.selectedTrack.frameCount, frames = []; let total = 0, bytes = 0;
        if (nf > 1) {
          for (let i = 0; i < nf && bytes < 600e6; i++) {
            const f = (await dec.decode({ frameIndex: i })).image;
            const ms = f.duration / 1000, d = ms <= 10 ? 100 : ms; // browsers treat tiny GIF delays as 100 ms
            bytes += f.displayWidth * f.displayHeight * 4;
            frames.push({ bmp: await createImageBitmap(f), d }); total += d; f.close();
          }
          dec.close();
          return {
            w: frames[0].bmp.width, h: frames[0].bmp.height,
            async frameAt(t) { let m = (t * 1000) % total; for (const f of frames) { if (m < f.d) return f.bmp; m -= f.d; } return frames[frames.length - 1].bmp; },
            close() { frames.forEach((f) => f.bmp.close()); },
          };
        }
        dec.close();
      } catch (e) { /* fall back to a still */ }
    }
    const bmp = await createImageBitmap(file);
    return { w: bmp.width, h: bmp.height, async frameAt() { return bmp; }, close() { bmp.close(); } };
  }

  const dims = (s) => (s.displayWidth ? [s.displayWidth, s.displayHeight] : s.videoWidth ? [s.videoWidth, s.videoHeight] : [s.width, s.height]);

  // ------------------------------------------------------------ audio

  async function decodeWhole(file, inT, outT) { // decodeAudioData path (webm, mkv, mp3, wav...): returns 48 kHz stereo segment
    const buf = await new OfflineAudioContext(2, 1, SR).decodeAudioData(await file.arrayBuffer());
    const a = Math.max(0, Math.floor(inT * SR)), b = Math.min(buf.length, outT == null ? buf.length : Math.ceil(outT * SR));
    if (b <= a) return null;
    const ch = (i) => buf.getChannelData(Math.min(i, buf.numberOfChannels - 1)).slice(a, b);
    return { chans: [ch(0), ch(1)], rate: SR };
  }

  // Segment [inT, outT] of a file's audio as { chans: [L, R], rate }, or null (no audio). Throws only 'cancelled'.
  async function audioSegment(file, mux, inT, outT, warns, signal) {
    const name = file.name || 'file';
    const tr = mux && mux.tracks.find((t) => t.type === 'audio');
    if (mux && !tr) return null;
    if (tr && window.AudioDecoder) {
      const cfg = { codec: tr.codec, sampleRate: tr.sampleRate, numberOfChannels: tr.channels };
      if (tr.description) cfg.description = tr.description;
      const sup = await AudioDecoder.isConfigSupported(cfg).catch(() => null);
      if (sup && sup.supported) {
        const S = tr.samples, end = outT == null ? tr.duration : outT, rate = tr.sampleRate, len = Math.max(1, Math.ceil((end - inT) * rate));
        let a = S.findIndex((s) => s.cts + s.dur > inT);
        if (a < 0) return null;
        a = Math.max(0, a - 2); // priming
        let b = a; while (b < S.length && S[b].cts < end) b++;
        const chans = [new Float32Array(len), new Float32Array(len)]; let err = null;
        const dec = new AudioDecoder({
          output: (ad) => {
            try {
              const pos = Math.round((ad.timestamp / 1e6 - inT) * rate), nf = ad.numberOfFrames, i0 = Math.max(0, -pos), i1 = Math.min(nf, len - pos);
              if (i1 > i0) for (let c = 0; c < 2; c++) {
                const tmp = new Float32Array(nf);
                ad.copyTo(tmp, { planeIndex: Math.min(c, ad.numberOfChannels - 1), format: 'f32-planar' });
                chans[c].set(tmp.subarray(i0, i1), pos + i0);
              }
            } finally { ad.close(); }
          },
          error: (e) => { err = e; },
        });
        try {
          dec.configure(cfg);
          for (let i = a; i < b; i += 64) {
            cancelled(signal);
            const batch = S.slice(i, Math.min(b, i + 64)), bufs = await MS.mp4.readMany(file, batch);
            batch.forEach((s, k) => dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(s.cts * 1e6), duration: Math.round(s.dur * 1e6), data: bufs[k] })));
            if (err) throw err;
          }
          await dec.flush();
          if (err) throw err;
          return { chans, rate };
        } catch (e) {
          if (e && e.message === 'cancelled') throw e;
          warns.push(name + ': audio decode failed');
          return null;
        } finally { if (dec.state !== 'closed') dec.close(); }
      }
    }
    if (file.size > BIG_FILE) { warns.push(name + ': audio skipped (file too large)'); return null; }
    try { return await decodeWhole(file, inT, outT); } catch (e) { warns.push(name + ': no audio'); return null; }
  }

  // ------------------------------------------------------------ project -> MP4

  const QUALITY = { high: [0.19, 192000], medium: [0.1, 128000], small: [0.05, 96000] }; // bits per pixel (x fps), AAC bps

  async function pickVideoConfig(w, h, fps, bitrate) {
    const mbs = Math.ceil(w / 16) * Math.ceil(h / 16), mbps = mbs * fps;
    const levels = [[0x1e, 1620, 40500], [0x1f, 3600, 108000], [0x20, 5120, 216000], [0x28, 8192, 245760], [0x2a, 8704, 522240], [0x32, 22080, 589824], [0x33, 36864, 983040], [0x34, 36864, 2073600]];
    const cand = [];
    for (const prof of ['64', '4d', '42']) for (const [lv, fs, mp] of levels) if (fs >= mbs && mp >= mbps) cand.push(`avc1.${prof}00${hex(lv)}`);
    cand.push('avc1.640033', 'avc1.640028');
    for (const codec of cand) {
      const cfg = { codec, width: w, height: h, bitrate, framerate: fps, avc: { format: 'avc' }, latencyMode: 'quality', hardwareAcceleration: 'no-preference' };
      const s = await VideoEncoder.isConfigSupported(cfg).catch(() => null);
      if (s && s.supported) return cfg;
    }
    throw new Error('H.264 encoding is not supported in this browser');
  }

  async function project(p, opts = {}) {
    const { files, signal } = opts, onProgress = opts.onProgress || (() => {});
    if (!window.VideoEncoder || !MS.mp4) throw new Error('WebCodecs is not available');
    const q = QUALITY[opts.quality || p.quality] || QUALITY.high;
    const w = Math.max(2, Math.floor(num(p.w, 1920) / 2) * 2), h = Math.max(2, Math.floor(num(p.h, 1080) / 2) * 2), fps = num(p.fps, 30);
    const L = layout(p);
    if (!(L.total > 0)) throw new Error('empty project');
    const nFrames = Math.max(1, Math.round(L.total * fps));
    const warns = [];

    const fileCache = new Map(), muxCache = new Map();
    const getFile = (ref) => { if (!fileCache.has(ref)) fileCache.set(ref, Promise.resolve(files(ref))); return fileCache.get(ref); };
    const demux = (ref) => {
      if (!muxCache.has(ref)) muxCache.set(ref, getFile(ref).then(async (f) => ((await MS.mp4.isMp4(f)) ? MS.mp4.open(f).catch(() => null) : null)));
      return muxCache.get(ref);
    };

    const sources = new Map(), overlays = [];
    let venc = null, aenc = null, frame = null;
    try {
      cancelled(signal);
      // ---- audio mix (first ~8 %)
      let acfg = null;
      if (window.AudioEncoder) {
        for (const codec of ['mp4a.40.2', 'opus']) {
          const c = { codec, sampleRate: SR, numberOfChannels: 2, bitrate: q[1] };
          const s = await AudioEncoder.isConfigSupported(c).catch(() => null);
          if (s && s.supported) { acfg = c; break; }
        }
      }
      if (!acfg) warns.push('no audio encoder');
      let mix = null, audioName = '';
      const hasAudioSources = (p.v1 || []).some((c) => c.kind === 'video' && !c.muted) || (p.audio || []).length;
      if (acfg && hasAudioSources) {
        onProgress(0, 'audio');
        const off = new OfflineAudioContext(2, Math.max(1, Math.ceil(L.total * SR)), SR);
        let any = false;
        const add = (seg, when, events) => {
          const ab = off.createBuffer(2, seg.chans[0].length, seg.rate);
          ab.copyToChannel(seg.chans[0], 0); ab.copyToChannel(seg.chans[1], 1);
          const src = off.createBufferSource(), g = off.createGain();
          src.buffer = ab; src.connect(g); g.connect(off.destination);
          events(g.gain, ab.duration);
          src.start(Math.max(0, when)); any = true;
        };
        for (let i = 0; i < L.clips.length; i++) {
          const { c, start, d, xf } = L.clips[i];
          if (c.kind !== 'video' || c.muted) continue;
          const f = await getFile(c.ref), seg = await audioSegment(f, await demux(c.ref), num(c.in, 0), num(c.in, 0) + d, warns, signal);
          if (!seg) continue;
          const vol = Math.max(0, Math.min(2, num(c.vol, 1))), nx = L.clips[i + 1] ? L.clips[i + 1].xf : 0;
          add(seg, start, (g, dur) => {
            g.setValueAtTime(xf > 0 ? 0 : vol, start);
            if (xf > 0) g.linearRampToValueAtTime(vol, start + xf);
            if (nx > 0) { g.setValueAtTime(vol, start + d - nx); g.linearRampToValueAtTime(0, start + d); }
          });
        }
        for (const a of p.audio || []) {
          cancelled(signal);
          const st = Math.max(0, num(a.start, 0)), inT = num(a.in, 0);
          let outT = a.out == null ? null : num(a.out, 0);
          const room = L.total - st; // never longer than the project
          outT = Math.min(outT == null ? inT + room : outT, inT + room);
          if (outT <= inT) continue;
          const f = await getFile(a.ref), seg = await audioSegment(f, await demux(a.ref), inT, outT, warns, signal);
          if (!seg) continue;
          const vol = Math.max(0, Math.min(2, num(a.vol, 1)));
          add(seg, st, (g, dur) => {
            let fi = Math.max(0, num(a.fadein, 0)), fo = Math.max(0, num(a.fadeout, 0));
            if (fi + fo > dur) { const k = dur / (fi + fo); fi *= k; fo *= k; }
            g.setValueAtTime(fi > 0 ? 0 : vol, st);
            if (fi > 0) g.linearRampToValueAtTime(vol, st + fi);
            if (fo > 0) { g.setValueAtTime(vol, st + dur - fo); g.linearRampToValueAtTime(0, st + dur); }
          });
        }
        if (any) { cancelled(signal); mix = await off.startRendering(); }
      }

      const vcfg = await pickVideoConfig(w, h, fps, Math.round(Math.min(40e6, Math.max(1.5e6, w * h * fps * q[0]))));
      const mux = MS.mp4.muxer({ video: { codec: vcfg.codec, width: w, height: h }, audio: mix ? { codec: acfg.codec, sampleRate: SR, channels: 2 } : undefined });
      if (mix) {
        let aerr = null;
        aenc = new AudioEncoder({ output: (c, m) => mux.addAudio(c, m), error: (e) => { aerr = e; } });
        aenc.configure(acfg);
        const Lc = mix.getChannelData(0), Rc = mix.getChannelData(1), N = mix.length;
        for (let i = 0; i < N; i += 1024) {
          cancelled(signal); if (aerr) throw aerr;
          const data = new Float32Array(2048), cnt = Math.min(1024, N - i);
          data.set(Lc.subarray(i, i + cnt), 0); data.set(Rc.subarray(i, i + cnt), 1024);
          const ad = new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: 1024, numberOfChannels: 2, timestamp: Math.round((i * 1e6) / SR), data });
          aenc.encode(ad); ad.close();
          if (aenc.encodeQueueSize > 16) await drain(aenc, 4);
          if ((i / 1024) % 64 === 0) await yieldTask();
        }
        await aenc.flush(); if (aerr) throw aerr;
        aenc.close(); aenc = null;
        audioName = acfg.codec === 'opus' ? 'Opus' : 'AAC';
        mix = null;
      }

      // ---- picture
      const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.imageSmoothingQuality = 'high';
      if (document.fonts && document.fonts.load) {
        const weights = new Set((p.text || []).map((t) => t.weight || 700));
        await Promise.all([...weights].map((wt) => document.fonts.load(`${wt} 32px "Bricolage Grotesque"`).catch(() => {})));
      }
      for (const o of p.overlays || []) {
        cancelled(signal);
        const f = await getFile(o.ref);
        overlays.push({ o, src: await imageSource(f, true) });
      }
      let verr = null;
      venc = new VideoEncoder({ output: (c, m) => mux.addVideo(c, m), error: (e) => { verr = e; } });
      venc.configure(vcfg);

      const openClip = async (info) => {
        const c = info.c, f = await getFile(c.ref);
        if (c.kind === 'video') {
          let s = null;
          if (await MS.mp4.isMp4(f)) s = await mp4VideoSource(f, await demux(c.ref), num(c.in, 0), num(c.in, 0) + info.d).catch(() => null);
          return s || htmlVideoSource(f);
        }
        return imageSource(f, c.kind === 'gif');
      };
      const closed = new Set();
      const fit = (src, fitMode, zoom, alpha) => {
        const [sw, sh] = dims(src);
        if (!sw || !sh) return;
        const k = (fitMode === 'cover' ? Math.max : Math.min)(w / sw, h / sh) * zoom, dw = sw * k, dh = sh * k;
        ctx.globalAlpha = alpha; ctx.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
      };
      const lines = (txt, maxW) => { // wrap on spaces, keep explicit newlines
        const out = [];
        for (const para of String(txt).split('\n')) {
          let line = '';
          for (const word of para.split(' ')) {
            const t = line ? line + ' ' + word : word;
            if (line && ctx.measureText(t).width > maxW) { out.push(line); line = word; } else line = t;
          }
          out.push(line);
        }
        return out;
      };

      const t0 = performance.now(); let lastYield = t0;
      for (let k = 0; k < nFrames; k++) {
        cancelled(signal); if (verr) throw verr;
        const T = k / fps, Te = T + 1e-6;
        ctx.globalAlpha = 1; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
        for (let i = 0; i < L.clips.length; i++) {
          const info = L.clips[i], end = info.start + info.d;
          if (Te < info.start) break;
          if (Te >= end) {
            if (sources.has(i) && !closed.has(i)) { closed.add(i); (await sources.get(i)).close(); sources.delete(i); }
            continue;
          }
          if (closed.has(i)) continue;
          if (!sources.has(i)) sources.set(i, openClip(info));
          const src = await sources.get(i), c = info.c, local = Math.max(0, T - info.start);
          const fr = await src.frameAt(c.kind === 'video' ? num(c.in, 0) + local : local);
          if (!fr) continue;
          const alpha = info.xf > 0 && local < info.xf ? local / info.xf : 1;
          const zoom = c.kind === 'image' && c.zoom ? 1 + 0.08 * (local / info.d) : 1;
          fit(fr, c.fit, zoom, alpha);
        }
        for (const { o, src } of overlays) {
          if (Te < num(o.start, 0) || Te >= num(o.end, 0)) continue;
          const fr = await src.frameAt(T - num(o.start, 0)), [sw, sh] = dims(fr), dw = w * num(o.scale, 0.2), dh = (dw * sh) / sw;
          ctx.globalAlpha = Math.max(0, Math.min(1, num(o.opacity, 1)));
          ctx.drawImage(fr, num(o.x, 0.5) * w - dw / 2, num(o.y, 0.5) * h - dh / 2, dw, dh);
        }
        for (const t of p.text || []) {
          const s = num(t.start, 0), e = num(t.end, 0);
          if (Te < s || Te >= e || !t.text) continue;
          const fd = num(t.fade, 0), a = fd > 0 ? Math.max(0, Math.min(1, (T - s) / fd, (e - T) / fd)) : 1;
          const px = num(t.size, 48) * (h / num(p.h, h)); // size is in px at project height
          ctx.globalAlpha = a; ctx.font = `${t.weight || 700} ${px}px ${FONT}`;
          ctx.fillStyle = t.color || '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          if (t.shadow) { ctx.shadowColor = 'rgba(0,0,0,.75)'; ctx.shadowBlur = px * 0.12; ctx.shadowOffsetY = px * 0.04; }
          const ls = lines(t.text, w * 0.92), lh = px * 1.25, cy = num(t.y, 0.5) * h - ((ls.length - 1) * lh) / 2;
          ls.forEach((ln, i) => ctx.fillText(ln, num(t.x, 0.5) * w, cy + i * lh));
          ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
        }
        ctx.globalAlpha = 1;
        const ts = Math.round((k * 1e6) / fps);
        frame = new VideoFrame(canvas, { timestamp: ts, duration: Math.round(((k + 1) * 1e6) / fps) - ts });
        venc.encode(frame, { keyFrame: k % Math.round(fps * 2) === 0 });
        frame.close(); frame = null;
        if (venc.encodeQueueSize > 8) await drain(venc, 4);
        const now = performance.now();
        if (now - lastYield > 40) { lastYield = now; await yieldTask(); }
        onProgress(0.08 + (0.9 * (k + 1)) / nFrames, `frame ${k + 1}/${nFrames}`);
      }
      await venc.flush(); if (verr) throw verr;
      venc.close(); venc = null;
      onProgress(0.99, 'writing');
      const blob = mux.finish();
      const secs = (performance.now() - t0) / 1000;
      const label = `H.264${audioName ? ' + ' + audioName : ' (no audio)'} · ${w}×${h} · ${fps} fps` + (warns.length ? ' · ' + warns.join('; ') : '');
      onProgress(1, 'done');
      return { blob, label, fps: nFrames / secs };
    } finally {
      for (const pr of sources.values()) Promise.resolve(pr).then((s) => s && s.close(), () => {});
      for (const { src } of overlays) src.close();
      if (frame) frame.close();
      if (venc && venc.state !== 'closed') venc.close();
      if (aenc && aenc.state !== 'closed') aenc.close();
    }
  }

  // ------------------------------------------------------------ probe

  async function probe(file) {
    const mime = file.type || '';
    if (mime.startsWith('image/') || /\.(png|jpe?g|webp|bmp|avif|gif)$/i.test(file.name || '')) {
      const b = await createImageBitmap(file), r = { dur: 0, w: b.width, h: b.height, hasAudio: false }; b.close(); return r;
    }
    if (MS.mp4 && (await MS.mp4.isMp4(file))) {
      try {
        const m = await MS.mp4.open(file), v = m.tracks.find((t) => t.type === 'video'), a = m.tracks.find((t) => t.type === 'audio');
        return { dur: m.duration, w: v ? v.width : 0, h: v ? v.height : 0, hasAudio: !!a };
      } catch (e) { /* fall through to the element */ }
    }
    const el = document.createElement(mime.startsWith('audio/') ? 'audio' : 'video'), url = URL.createObjectURL(file);
    el.preload = 'metadata'; el.muted = true; el.src = url;
    try {
      await once(el, 'loadedmetadata');
      if (!isFinite(el.duration)) { el.currentTime = 1e101; await once(el, 'seeked').catch(() => {}); } // MediaRecorder webm has no duration
      const hasAudio = el.audioTracks ? el.audioTracks.length > 0 : el.mozHasAudio !== false;
      return { dur: isFinite(el.duration) ? el.duration : 0, w: el.videoWidth || 0, h: el.videoHeight || 0, hasAudio };
    } finally { el.removeAttribute('src'); el.load(); URL.revokeObjectURL(url); }
  }

  MS.render = { project, layout, probe };
})();
