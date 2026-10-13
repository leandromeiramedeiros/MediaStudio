/* Nexus GIF: fit inside 640×360, 15 fps, file under 8 MB. Ported from the GIF Cutter.
   The quality steps down a ladder (colors, dithering, skip threshold, lossy LZW) and the frame rate down to 10 fps
   until the measured size fits. Sizes are estimated from short bursts first, then the full encode is checked. */
(() => {
  const NEXUS = { limit: 8000000, w: 640, h: 360, fps: 15, aim: 0.92 };
  const QUALS = [
    { colors: 256, dither: 'fs', thr: 180, lossy: 0, label: 'best quality' },
    { colors: 256, dither: 'fs', thr: 576, lossy: 0, label: 'light compression' },
    { colors: 256, dither: 'fs', thr: 576, lossy: 400, label: 'lossy compression' },
    { colors: 256, dither: 'fs', thr: 576, lossy: 1200, label: 'stronger lossy compression' },
    { colors: 128, dither: 'fs', thr: 576, lossy: 1200, label: '128 colors, lossy' },
    { colors: 128, dither: 'fs', thr: 576, lossy: 2500, label: '128 colors, heavy lossy' },
    { colors: 64, dither: 'fs', thr: 576, lossy: 2500, label: '64 colors, heavy lossy' },
    { colors: 64, dither: 'none', thr: 576, lossy: 2500, label: '64 colors, no dithering' },
    { colors: 32, dither: 'none', thr: 576, lossy: 2500, label: '32 colors, no dithering' },
    { colors: 16, dither: 'none', thr: 576, lossy: 2500, label: '16 colors, no dithering' },
  ];
  const QPEN = [0, 1, 2, 3, 4, 5, 6, 8, 12, 16]; // very few colors look much worse than a lower frame rate
  const NX_FPS = [15, 14, 13, 12, 11, 10];
  const COMBOS = [];
  QUALS.forEach((_, q) => NX_FPS.forEach((f) => COMBOS.push({ q, f, pen: QPEN[q] + (15 - f) * 1.2 })));
  COMBOS.sort((x, y) => x.pen - y.pen || y.f - x.f || x.q - y.q);
  const comboLabel = (c) => `${QUALS[c.q].label}${c.f < 15 ? `, ${c.f} fps` : ''}`;
  const HEADER_EST = 1700;
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const estSize = (st, n) => HEADER_EST + st.full + Math.max(0, n - 1) * st.delta;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const delayAt = (i, fps) => Math.round((i + 1) * 100 / fps) - Math.round(i * 100 / fps);
  /* file:// cannot load a Worker script: the body (MS.gifWorker) goes through a Blob URL, made once */
  let workerUrl = null;
  const WORKER_URL = () => workerUrl || (workerUrl = URL.createObjectURL(new Blob(['(' + MS.gifWorker + ')()'], { type: 'text/javascript' })));

  class Encoder {
    constructor() {
      this.w = new Worker(WORKER_URL()); this.seq = 0; this.cb = new Map(); this.dead = false;
      this.w.onmessage = (e) => { const m = e.data, c = this.cb.get(m.id); if (!c) return; this.cb.delete(m.id); m.ok ? c.res(m.result) : c.rej(new Error(m.error)); };
      this.w.onerror = (e) => this.fail(new Error(e.message || 'The encoder stopped unexpectedly.'));
    }
    call(type, data, transfer) {
      if (this.dead) return Promise.reject(new Error('cancelled'));
      const id = ++this.seq;
      return new Promise((res, rej) => { this.cb.set(id, { res, rej }); this.w.postMessage({ id, type, ...data }, transfer || []); });
    }
    fail(err) { for (const c of this.cb.values()) c.rej(err); this.cb.clear(); }
    kill() { if (this.dead) return; this.dead = true; this.w.terminate(); this.fail(new Error('cancelled')); }
  }

  /* Frames come from a hidden <video> seeked to each time, drawn to a canvas (two-step downscale for big sources). */
  class Source {
    constructor(url) {
      this.v = document.createElement('video');
      this.v.muted = true; this.v.preload = 'auto'; this.v.src = url;
      this.mid = document.createElement('canvas'); this.out = document.createElement('canvas');
      this.xm = this.mid.getContext('2d'); this.xo = this.out.getContext('2d', { willReadFrequently: true });
    }
    ready() {
      const v = this.v;
      if (v.readyState >= 2) return Promise.resolve();
      return new Promise((res, rej) => {
        const ok = () => { off(); res(); }, bad = () => { off(); rej(new Error('The video could not be decoded for frame capture.')); };
        const off = () => { clearTimeout(to); v.removeEventListener('loadeddata', ok); v.removeEventListener('error', bad); };
        const to = setTimeout(bad, 20000);
        v.addEventListener('loadeddata', ok); v.addEventListener('error', bad);
      });
    }
    get dur() { return this.v.duration || 0; }
    seek(t) {
      const v = this.v;
      t = clamp(t, 0, Math.max(0, this.dur - 0.001));
      return new Promise((res) => {
        let done = false;
        const fin = () => { if (done) return; done = true; v.removeEventListener('seeked', fin); clearTimeout(to); res(); };
        const to = setTimeout(fin, 2500);
        v.addEventListener('seeked', fin);
        if (Math.abs(v.currentTime - t) < 1e-6) t += 1e-4;
        v.currentTime = t;
      });
    }
    dims() {
      const vw = this.v.videoWidth || 1920, vh = this.v.videoHeight || 1080;
      const k = Math.min(NEXUS.w / vw, NEXUS.h / vh, 1);
      return { w: Math.max(2, Math.round(vw * k)), h: Math.max(2, Math.round(vh * k)) };
    }
    grab(w, h) {
      const v = this.v, vw = v.videoWidth;
      if (this.out.width !== w || this.out.height !== h) { this.out.width = w; this.out.height = h; }
      this.xo.imageSmoothingEnabled = true; this.xo.imageSmoothingQuality = 'high';
      if (vw >= w * 2.5) {
        if (this.mid.width !== w * 2 || this.mid.height !== h * 2) { this.mid.width = w * 2; this.mid.height = h * 2; }
        this.xm.imageSmoothingEnabled = true; this.xm.imageSmoothingQuality = 'high';
        this.xm.drawImage(v, 0, 0, w * 2, h * 2);
        this.xo.drawImage(this.mid, 0, 0, w, h);
      } else this.xo.drawImage(v, 0, 0, w, h);
      return this.xo.getImageData(0, 0, w, h);
    }
    close() { this.v.removeAttribute('src'); this.v.load(); }
  }

  /* Make one Nexus GIF of [start, end] of the video at url.
     onProgress(frac, text); signal: { cancelled } checked between frames.
     Returns { bytes, w, h, fps, label, fits, frames }. */
  async function makeNexusGif(url, start, end, onProgress, signal) {
    const src = new Source(url);
    const encs = [];
    const check = () => { if (signal && signal.cancelled) throw new Error('cancelled'); };
    const progress = (f, t) => onProgress && onProgress(clamp(f, 0, 1), t);
    try {
      await src.ready();
      end = Math.min(end, src.dur); start = clamp(start, 0, end - 0.05);
      const d = src.dims();
      const frameTimes = (fps) => { const n = Math.max(1, Math.round((end - start) * fps)); return Array.from({ length: n }, (_, i) => start + i / fps); };

      // size probing: bursts of 14 frames give the cost of a full frame and of a typical changed frame
      const bursts = {};
      const grabBursts = async (fps) => {
        const L = 14, B = clamp(Math.round((end - start) / 3), 3, 8);
        const total = Math.max(1, Math.round((end - start) * fps));
        const groups = [];
        if (total <= B * L) groups.push(Array.from({ length: total }, (_, i) => start + i / fps));
        else for (let b = 0; b < B; b++) {
          const t0 = start + (end - start - L / fps) * (b + 0.5) / B;
          groups.push(Array.from({ length: L }, (_, i) => t0 + i / fps));
        }
        const out = [];
        for (const g of groups) { const imgs = []; for (const t of g) { check(); await src.seek(t + 0.001); imgs.push(src.grab(d.w, d.h)); } out.push(imgs); }
        return out;
      };
      const stats = new Map();
      const est = new Encoder(); encs.push(est);
      const estimateQual = async (bs, ql) => {
        await est.call('init', { width: d.w, height: d.h, colors: ql.colors, dither: ql.dither, palette: 'global', threshold: ql.thr, lossy: ql.lossy, loop: 'forever' });
        for (const g of bs) for (const img of g) await est.call('sample', { buf: img.data.buffer });
        await est.call('palette', {});
        const fulls = [], deltas = [];
        for (const g of bs) {
          await est.call('restart', {});
          const skip = g.length >= 10 ? 6 : 1;
          for (let i = 0; i < g.length; i++) {
            const r = await est.call('frame', { buf: g[i].data.buffer, delay: 7 });
            if (i === 0) fulls.push(r.body); else if (i >= skip) deltas.push(r.body);
          }
        }
        return { full: mean(fulls), delta: mean(deltas) * (ql.lossy ? 1.1 : 1) };
      };
      const stat = async (q, fps) => {
        const key = q + '@' + fps;
        if (stats.has(key)) return stats.get(key);
        if (!bursts[fps]) bursts[fps] = await grabBursts(fps);
        check();
        const st = await estimateQual(bursts[fps], QUALS[q]);
        stats.set(key, st);
        return st;
      };
      const comboStatSync = (c) => {
        const a = stats.get(c.q + '@15'); if (c.f === 15) return a || null;
        const b = stats.get(c.q + '@10'); if (c.f === 10) return b || null;
        if (!a || !b) return null;
        const k = (1 / c.f - 1 / 15) / (1 / 10 - 1 / 15);
        return { full: a.full + (b.full - a.full) * k, delta: a.delta + (b.delta - a.delta) * k };
      };
      const comboStat = async (c) => {
        if (c.f !== 10) await stat(c.q, 15);
        if (c.f !== 15) await stat(c.q, 10);
        return comboStatSync(c);
      };

      // one full encode
      const encodeGif = async (cfg, times, label, store) => {
        const enc = new Encoder(); encs.push(enc);
        const { w, h, fps } = cfg;
        const fromCache = store && store.frames;
        const keep = store && !store.frames && times.length * w * h * 4 <= 400e6 ? new Map() : null;
        const tkey = (t) => t.toFixed(4);
        const getFrame = async (t) => {
          if (fromCache) { const img = store.frames.get(tkey(t)); return new ImageData(img.data.slice(), w, h); }
          await src.seek(t + 0.001);
          const img = src.grab(w, h);
          if (keep) { keep.set(tkey(t), img); return new ImageData(img.data.slice(), w, h); }
          return img;
        };
        try {
          await enc.call('init', { width: w, height: h, colors: cfg.colors, dither: cfg.dither, palette: 'global', threshold: cfg.thr, lossy: cfg.lossy || 0, loop: 'forever' });
          const sampleCount = Math.min(times.length, 48);
          const wSample = fromCache ? 0.05 : 0.18;
          for (let i = 0; i < sampleCount; i++) {
            check();
            const k = sampleCount === 1 ? 0 : Math.round((i * (times.length - 1)) / (sampleCount - 1));
            const img = fromCache ? await getFrame(times[k]) : await (async () => { await src.seek(times[k] + 0.001); return src.grab(w, h); })();
            await enc.call('sample', { buf: img.data.buffer }, [img.data.buffer]);
            progress(wSample * (i + 1) / sampleCount, `${label}reading colors`);
          }
          await enc.call('palette', {});
          const inflight = [];
          for (let i = 0; i < times.length; i++) {
            check();
            const img = await getFrame(times[i]);
            const pr = enc.call('frame', { buf: img.data.buffer, delay: delayAt(i, fps) }, [img.data.buffer]); pr.catch(() => {}); inflight.push(pr);
            if (inflight.length >= 3) await inflight.shift();
            progress(wSample + (1 - wSample) * (i + 1) / times.length, `${label}frame ${i + 1}/${times.length}`);
          }
          await Promise.all(inflight);
          check();
          if (keep) store.frames = keep;
          return await enc.call('finish', {});
        } finally { enc.kill(); }
      };

      // pick the gentlest setting the estimate says fits, encode, check, step down if it did not
      const aim = NEXUS.limit * NEXUS.aim, frameStores = {};
      let corr = 1, attempt = 0, smallest = null, idx = 0;
      const tried = new Set();
      while (idx < COMBOS.length && attempt < 4) {
        let pick = -1;
        for (let i = idx; i < COMBOS.length; i++) {
          progress(0.02, `measuring settings (${i + 1})`);
          const st = await comboStat(COMBOS[i]);
          if (estSize(st, frameTimes(COMBOS[i].f).length) * corr <= aim) { pick = i; break; }
        }
        if (pick < 0) pick = COMBOS.length - 1;
        if (tried.has(pick)) break;
        tried.add(pick); attempt++;
        const c = COMBOS[pick], ql = QUALS[c.q], times = frameTimes(c.f);
        const cfg = { w: d.w, h: d.h, fps: c.f, colors: ql.colors, dither: ql.dither, thr: ql.thr, lossy: ql.lossy };
        const label = `${attempt > 1 ? `try ${attempt}, ` : ''}${comboLabel(c)}: `;
        const r = await encodeGif(cfg, times, label, frameStores[c.f] || (frameStores[c.f] = {}));
        const item = { bytes: r.bytes, w: d.w, h: d.h, fps: c.f, label: comboLabel(c), frames: times.length, fits: r.bytes.length <= NEXUS.limit };
        if (item.fits) return item;
        if (!smallest || r.bytes.length < smallest.bytes.length) smallest = item;
        corr = Math.max(corr, r.bytes.length / estSize(comboStatSync(c), times.length));
        idx = pick + 1;
      }
      return smallest;
    } finally {
      for (const e of encs) e.kill();
      src.close();
    }
  }

  MS.nexus = { NEXUS, makeNexusGif, comboLabel };
})();
