// MS.mp4: MP4/MOV demuxer (reads only moov + the samples asked for, via File.slice) and a faststart MP4 muxer.
// Self-contained: classic script, no dependency besides the browser.
(() => {
  const MS = (window.MS = window.MS || {});
  const fourcc = (v, o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  const readBuf = async (file, a, b) => new Uint8Array(await file.slice(a, b).arrayBuffer());
  const hex = (n) => n.toString(16).padStart(2, '0');
  const toU8 = (d) => (d instanceof ArrayBuffer ? new Uint8Array(d.slice(0)) : new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)));

  // ---------------------------------------------------------------- demuxer

  // Child boxes of [s, e): { type, start, body, end } (body = after the 8/16 byte header).
  function* boxes(v, s, e) {
    while (s + 8 <= e) {
      let size = v.getUint32(s), hdr = 8;
      const type = fourcc(v, s + 4);
      if (size === 1) { size = Number(v.getBigUint64(s + 8)); hdr = 16; } else if (size === 0) size = e - s;
      if (size < hdr || s + size > e) return;
      yield { type, start: s, body: s + hdr, end: s + size };
      s += size;
    }
  }
  const find = (v, box, type) => { for (const b of boxes(v, box.body, box.end)) if (b.type === type) return b; return null; };
  const bytes = (v, a, b) => new Uint8Array(v.buffer, v.byteOffset + a, b - a).slice();

  function hevcCodec(type, d) { // d = hvcC payload; ISO 14496-15 annex E
    const sp = d[1] >> 6, tier = (d[1] >> 5) & 1, idc = d[1] & 31;
    let compat = ((d[2] << 24) | (d[3] << 16) | (d[4] << 8) | d[5]) >>> 0, rev = 0;
    for (let i = 0; i < 32; i++) { rev = ((rev << 1) | (compat & 1)) >>> 0; compat >>>= 1; }
    const cons = Array.from(d.subarray(6, 12));
    while (cons.length > 1 && cons[cons.length - 1] === 0) cons.pop();
    return `${type}.${['', 'A', 'B', 'C'][sp]}${idc}.${rev.toString(16)}.${tier ? 'H' : 'L'}${d[12]}.${cons.map((x) => x.toString(16).toUpperCase()).join('.')}`;
  }

  function parseEsds(d) { // d = esds payload after version/flags: nested descriptors
    let p = 0, oti = 0, asc = null;
    const len = () => { let n = 0, b; do { b = d[p++]; n = (n << 7) | (b & 127); } while (b & 128 && p < d.length); return n; };
    while (p < d.length) {
      const tag = d[p++], n = len(), end = p + n;
      if (tag === 3) { const fl = d[p + 2]; p += 3; if (fl & 0x80) p += 2; if (fl & 0x40) p += 1 + d[p]; if (fl & 0x20) p += 2; } // ES_Descr: descend
      else if (tag === 4) { oti = d[p]; p += 13; } // DecoderConfigDescr: descend after its fixed fields
      else if (tag === 5) { asc = d.slice(p, end); p = end; }
      else p = end;
    }
    return { oti, asc };
  }

  function parseStsd(v, stsd, handler) {
    const e = stsd.body + 8, size = v.getUint32(e), type = fourcc(v, e + 4), pl = e + 8, end = e + size;
    const r = { codec: type, description: null, width: 0, height: 0, sampleRate: 0, channels: 0 };
    if (handler === 'vide') {
      r.width = v.getUint16(pl + 24); r.height = v.getUint16(pl + 26);
      for (const b of boxes(v, pl + 78, end)) {
        const d = () => bytes(v, b.body, b.end);
        if (b.type === 'avcC') { r.description = d(); r.codec = 'avc1.' + hex(r.description[1]) + hex(r.description[2]) + hex(r.description[3]); }
        else if (b.type === 'hvcC') { r.description = d(); r.codec = hevcCodec(type === 'hev1' ? 'hev1' : 'hvc1', r.description); }
        else if (b.type === 'av1C') {
          r.description = d().subarray(4); const x = d();
          r.codec = `av01.${x[1] >> 5}.${String(x[1] & 31).padStart(2, '0')}${x[2] & 128 ? 'H' : 'M'}.${x[2] & 64 ? ((x[2] & 32) ? '12' : '10') : '08'}`;
        } else if (b.type === 'vpcC') { const x = d(); r.codec = `vp09.${String(x[4]).padStart(2, '0')}.${String(x[5]).padStart(2, '0')}.${String(x[6] >> 4).padStart(2, '0')}`; }
      }
    } else if (handler === 'soun') {
      const ver = v.getUint16(pl + 8);
      r.channels = v.getUint16(pl + 16); r.sampleRate = v.getUint32(pl + 24) >>> 16;
      let cs = pl + 28 + (ver === 1 ? 16 : ver === 2 ? 36 : 0);
      const scan = (s, e2) => {
        for (const b of boxes(v, s, e2)) {
          if (b.type === 'wave') scan(b.body, b.end);
          else if (b.type === 'esds') {
            const { oti, asc } = parseEsds(bytes(v, b.body + 4, b.end));
            r.description = asc;
            if (oti === 0x6b || oti === 0x69) r.codec = 'mp3';
            else if (asc && asc.length) {
              let aot = asc[0] >> 3; if (aot === 31) aot = 32 + (((asc[0] & 7) << 3) | (asc[1] >> 5));
              r.codec = 'mp4a.40.' + aot;
            } else r.codec = 'mp4a.' + oti.toString(16);
          } else if (b.type === 'dOps') {
            const o = bytes(v, b.body, b.end), ch = o[1], head = new Uint8Array(19 + (o[10] ? 2 + ch : 0));
            head.set([79, 112, 117, 115, 72, 101, 97, 100, 1, ch]); // "OpusHead", version 1, channels
            head[10] = o[3]; head[11] = o[2]; // pre-skip LE
            head[12] = o[7]; head[13] = o[6]; head[14] = o[5]; head[15] = o[4]; // input rate LE
            head[16] = o[9]; head[17] = o[8]; head[18] = o[10]; // gain LE, mapping family
            if (o[10]) head.set(o.subarray(11), 19);
            r.codec = 'opus'; r.description = head; r.channels = ch;
          }
        }
      };
      scan(cs, end);
    }
    return r;
  }

  function parseTrak(v, trak, movieTs) {
    const tkhd = find(v, trak, 'tkhd'), mdia = find(v, trak, 'mdia');
    if (!tkhd || !mdia) return null;
    const id = v.getUint32(tkhd.body + (v.getUint8(tkhd.body) ? 20 : 12));
    const mdhd = find(v, mdia, 'mdhd'), hdlr = find(v, mdia, 'hdlr');
    const timescale = v.getUint32(mdhd.body + (v.getUint8(mdhd.body) ? 20 : 12)) || 1;
    const handler = fourcc(v, hdlr.body + 8);
    if (handler !== 'vide' && handler !== 'soun') return null;
    const stbl = find(v, find(v, mdia, 'minf'), 'stbl');
    const t = {};
    for (const b of boxes(v, stbl.body, stbl.end)) t[b.type] = b;
    if (!t.stsd || !t.stsz && !t.stz2 || !t.stts || !t.stsc || !(t.stco || t.co64)) return null;
    const info = parseStsd(v, t.stsd, handler);

    // sizes
    let n, sizes;
    if (t.stsz) {
      const b = t.stsz.body, fixed = v.getUint32(b + 4); n = v.getUint32(b + 8);
      sizes = new Uint32Array(n);
      if (fixed) sizes.fill(fixed); else for (let i = 0; i < n; i++) sizes[i] = v.getUint32(b + 12 + i * 4);
    } else {
      const b = t.stz2.body, fs = v.getUint8(b + 7); n = v.getUint32(b + 8); sizes = new Uint32Array(n);
      for (let i = 0; i < n; i++) sizes[i] = fs === 16 ? v.getUint16(b + 12 + i * 2) : fs === 8 ? v.getUint8(b + 12 + i) : (v.getUint8(b + 12 + (i >> 1)) >> (i & 1 ? 0 : 4)) & 15;
    }
    // chunk offsets
    const co = t.co64 || t.stco, cn = v.getUint32(co.body + 4), big = !!t.co64, chunks = new Array(cn);
    for (let i = 0; i < cn; i++) chunks[i] = big ? Number(v.getBigUint64(co.body + 8 + i * 8)) : v.getUint32(co.body + 8 + i * 4);
    // sample -> chunk
    const sn = v.getUint32(t.stsc.body + 4), stsc = [];
    for (let i = 0; i < sn; i++) stsc.push([v.getUint32(t.stsc.body + 8 + i * 12), v.getUint32(t.stsc.body + 12 + i * 12)]);
    const offsets = new Array(n); let si = 0, e = 0;
    for (let c = 0; c < cn && si < n; c++) {
      while (e + 1 < sn && stsc[e + 1][0] <= c + 1) e++;
      let o = chunks[c];
      for (let k = 0; k < stsc[e][1] && si < n; k++, si++) { offsets[si] = o; o += sizes[si]; }
    }
    // times
    const dts = new Array(n), dur = new Array(n), cts = new Array(n);
    let i = 0, tt = 0;
    const tn = v.getUint32(t.stts.body + 4);
    for (let k = 0; k < tn; k++) {
      const cnt = v.getUint32(t.stts.body + 8 + k * 8), d = v.getUint32(t.stts.body + 12 + k * 8);
      for (let j = 0; j < cnt && i < n; j++, i++) { dts[i] = tt; dur[i] = d; tt += d; }
    }
    for (; i < n; i++) { dts[i] = tt; dur[i] = dur[i - 1] || 0; tt += dur[i]; }
    for (i = 0; i < n; i++) cts[i] = dts[i];
    if (t.ctts) {
      const cn2 = v.getUint32(t.ctts.body + 4); i = 0;
      for (let k = 0; k < cn2; k++) {
        const cnt = v.getUint32(t.ctts.body + 8 + k * 8), o = v.getInt32(t.ctts.body + 12 + k * 8);
        for (let j = 0; j < cnt && i < n; j++, i++) cts[i] += o;
      }
    }
    const key = new Uint8Array(n);
    if (t.stss && handler === 'vide') {
      const kn = v.getUint32(t.stss.body + 4);
      for (let k = 0; k < kn; k++) { const s = v.getUint32(t.stss.body + 8 + k * 4) - 1; if (s >= 0 && s < n) key[s] = 1; }
    } else key.fill(1);
    // edit list: initial empty edit delays, first real edit's media_time trims (B-frame / priming offset)
    let shift = 0;
    const edts = find(v, trak, 'edts'), elst = edts && find(v, edts, 'elst');
    if (elst) {
      const ver = v.getUint8(elst.body), en = v.getUint32(elst.body + 4), step = ver ? 20 : 12;
      for (let k = 0; k < en; k++) {
        const o = elst.body + 8 + k * step;
        const seg = ver ? Number(v.getBigUint64(o)) : v.getUint32(o), mt = ver ? Number(v.getBigInt64(o + 8)) : v.getInt32(o + 4);
        if (mt === -1) shift += seg / movieTs; else { shift -= mt / timescale; break; }
      }
    }
    const samples = new Array(n); let end = 0;
    for (i = 0; i < n; i++) {
      const s = { offset: offsets[i], size: sizes[i], dts: dts[i] / timescale + shift, cts: cts[i] / timescale + shift, dur: dur[i] / timescale, key: !!key[i] };
      samples[i] = s; end = Math.max(end, s.cts + s.dur);
    }
    return { id, type: handler === 'vide' ? 'video' : 'audio', codec: info.codec, description: info.description, width: info.width, height: info.height,
      sampleRate: info.sampleRate, channels: info.channels, timescale, duration: end, samples };
  }

  // Walk top-level boxes with small reads until moov is found (it may sit after a multi-GB mdat).
  async function open(file) {
    let pos = 0, moov = null, frag = false;
    while (pos + 8 <= file.size && !moov) {
      const h = await readBuf(file, pos, Math.min(pos + 16, file.size)), v = new DataView(h.buffer);
      let size = v.getUint32(0), hdr = 8; const type = fourcc(v, 4);
      if (size === 1) { size = Number(v.getBigUint64(8)); hdr = 16; } else if (size === 0) size = file.size - pos;
      if (size < hdr) break;
      if (type === 'moov') moov = { pos, size };
      else if (type === 'moof') frag = true;
      pos += size;
    }
    if (!moov) throw new Error(frag ? 'fragmented MP4 is not supported' : 'not an MP4: no moov box');
    const buf = await readBuf(file, moov.pos, moov.pos + moov.size), v = new DataView(buf.buffer);
    const root = { body: 8, end: buf.length };
    if (find(v, root, 'mvex')) throw new Error('fragmented MP4 is not supported');
    const mvhd = find(v, root, 'mvhd'), movieTs = mvhd ? v.getUint32(mvhd.body + (v.getUint8(mvhd.body) ? 20 : 12)) || 1000 : 1000;
    const tracks = [];
    for (const b of boxes(v, 8, buf.length)) if (b.type === 'trak') { const t = parseTrak(v, b, movieTs); if (t && t.samples.length) tracks.push(t); }
    return { duration: Math.max(0, ...tracks.map((t) => t.duration)), tracks };
  }

  const read = async (file, s) => readBuf(file, s.offset, s.offset + s.size);

  // Batched reader: coalesces samples that sit close together in the file into one slice. Order of `list` is kept.
  async function readMany(file, list, { gap = 131072, max = 8 << 20 } = {}) {
    const out = new Array(list.length);
    let i = 0;
    while (i < list.length) {
      let j = i; const a = list[i].offset; let b = a + list[i].size;
      while (j + 1 < list.length) {
        const nx = list[j + 1];
        if (nx.offset < a || nx.offset - b > gap || nx.offset + nx.size - a > max) break;
        b = Math.max(b, nx.offset + nx.size); j++;
      }
      const buf = await readBuf(file, a, b);
      for (let k = i; k <= j; k++) out[k] = buf.subarray(list[k].offset - a, list[k].offset - a + list[k].size);
      i = j + 1;
    }
    return out;
  }

  async function isMp4(file) {
    if (file.size < 12) return false;
    const h = await readBuf(file, 0, 12);
    return ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(String.fromCharCode(...h.subarray(4, 8)));
  }

  // ---------------------------------------------------------------- muxer

  const u8 = (...a) => Uint8Array.from(a);
  const u16 = (n) => u8((n >> 8) & 255, n & 255);
  const u32 = (n) => u8((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  const U32 = (arr) => { const o = new Uint8Array(arr.length * 4), v = new DataView(o.buffer); for (let i = 0; i < arr.length; i++) v.setUint32(i * 4, arr[i] >>> 0); return o; };
  const str = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
  const zeros = (n) => new Uint8Array(n);
  const cat = (parts) => { let n = 0; for (const p of parts) n += p.length; const o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
  const box = (type, ...parts) => { const body = cat(parts); return cat([u32(body.length + 8), str(type), body]); };
  const fbox = (type, ver, flags, ...parts) => box(type, u32(ver * 16777216 + flags), ...parts);
  const runs = (arr) => { const o = []; for (const x of arr) { const l = o[o.length - 1]; if (l && l[1] === x) l[0]++; else o.push([1, x]); } return o; }; // [count, value]
  const MATRIX = cat([u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000)]);
  const desc = (tag, ...parts) => { const b = cat(parts), n = b.length; return cat([u8(tag, 0x80 | ((n >> 21) & 127), 0x80 | ((n >> 14) & 127), 0x80 | ((n >> 7) & 127), n & 127), b]); };

  function muxer(opts) {
    const vo = opts.video, ao = opts.audio || null;
    const V = { chunks: [], pts: [], dur: [], key: [], desc: null };
    const A = ao ? { chunks: [], dur: [], desc: null } : null;
    let finished = false;

    function addVideo(chunk, meta) {
      const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d);
      V.chunks.push(d); V.pts.push(chunk.timestamp); V.dur.push(chunk.duration || 0); V.key.push(chunk.type === 'key');
      const dc = meta && meta.decoderConfig;
      if (dc && dc.description && !V.desc) V.desc = toU8(dc.description);
    }
    function addAudio(chunk, meta) {
      if (!A) throw new Error('muxer has no audio track');
      const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d);
      A.chunks.push(d); A.dur.push(chunk.duration || 0);
      const dc = meta && meta.decoderConfig;
      if (dc && dc.description && !A.desc) A.desc = toU8(dc.description);
    }

    // Track timing: { ts, dts[], deltas[], cts offsets (or null), shift, total }
    function videoTiming() {
      const ts = vo.timescale || 90000, n = V.chunks.length;
      const p = V.pts.map((x) => Math.round((x * ts) / 1e6));
      const sorted = p.slice().sort((a, b) => a - b), mono = p.every((x, i) => !i || x >= p[i - 1]);
      const base = sorted[0];
      const dts = (mono ? p : sorted).map((x) => x - base);
      let off = null, shift = 0;
      if (!mono) {
        off = p.map((x, i) => x - base - dts[i]);
        shift = Math.max(0, -Math.min(...off));
        if (shift) off = off.map((x) => x + shift);
      }
      const deltas = dts.map((x, i) => (i + 1 < n ? dts[i + 1] - x : Math.max(1, Math.round(((V.dur[i] || 1e6 / 30) * ts) / 1e6))));
      return { ts, dts, deltas, off, shift, total: dts[n - 1] + deltas[n - 1] };
    }
    function audioTiming() {
      const ts = ao.sampleRate, dflt = ao.codec === 'opus' ? 960 : 1024;
      const deltas = A.dur.map((d) => (d ? Math.round((d * ts) / 1e6) : dflt));
      const dts = []; let t = 0; for (const d of deltas) { dts.push(t); t += d; }
      return { ts, dts, deltas, off: null, shift: 0, total: t };
    }

    function stblFor(kind, tm, chunkInfo, offsets, use64) {
      const isV = kind === 'v', list = isV ? V : A, n = list.chunks.length;
      let entry;
      if (isV) {
        const name = str(vo.codec.startsWith('hvc') || vo.codec.startsWith('hev') ? 'hvc1' : vo.codec.startsWith('av01') ? 'av01' : 'avc1');
        const cfgType = vo.codec.startsWith('hvc') || vo.codec.startsWith('hev') ? 'hvcC' : vo.codec.startsWith('av01') ? 'av1C' : 'avcC';
        if (!V.desc) throw new Error('muxer: video decoderConfig.description missing (use avc: {format: "avc"})');
        entry = cat([u32(0), name, zeros(6), u16(1), zeros(16), u16(vo.width), u16(vo.height), u32(0x480000), u32(0x480000), u32(0), u16(1), zeros(32), u16(0x18), u16(0xffff), box(cfgType, V.desc)]);
      } else {
        const ch = ao.channels, sr = Math.min(ao.sampleRate, 65535) * 65536;
        const head = [zeros(6), u16(1), zeros(8), u16(ch), u16(16), u16(0), u16(0), u32(sr)];
        if (ao.codec === 'opus') {
          const pre = A.desc && A.desc.length >= 12 && String.fromCharCode(...A.desc.subarray(0, 8)) === 'OpusHead' ? A.desc[10] | (A.desc[11] << 8) : 312;
          entry = cat([u32(0), str('Opus'), ...head, box('dOps', u8(0, ch), u16(pre), u32(ao.sampleRate), u16(0), u8(0))]);
        } else {
          if (!A.desc) throw new Error('muxer: audio decoderConfig.description missing');
          const es = fbox('esds', 0, 0,
            desc(3, u16(1), u8(0), desc(4, u8(0x40, 0x15), zeros(3), u32(0), u32(0), desc(5, A.desc)), desc(6, u8(2))));
          entry = cat([u32(0), str('mp4a'), ...head, es]);
        }
      }
      new DataView(entry.buffer).setUint32(0, entry.length);
      const stsd = fbox('stsd', 0, 0, u32(1), entry);
      const stts = fbox('stts', 0, 0, u32(runs(tm.deltas).length), U32(runs(tm.deltas).flat()));
      const ctts = tm.off ? fbox('ctts', 1, 0, u32(runs(tm.off).length), U32(runs(tm.off).flat())) : new Uint8Array(0);
      const keys = []; if (isV) V.key.forEach((k, i) => k && keys.push(i + 1));
      const stss = isV && keys.length < n ? fbox('stss', 0, 0, u32(keys.length), U32(keys)) : new Uint8Array(0);
      // stsc: [first_chunk (1-based), samples_per_chunk, 1] per change of samples_per_chunk
      const spc = chunkInfo.map((c) => c.count), stscRows = []; spc.forEach((c, i) => { if (!i || spc[i - 1] !== c) stscRows.push(i + 1, c, 1); });
      const stsc = fbox('stsc', 0, 0, u32(stscRows.length / 3), U32(stscRows));
      const stsz = fbox('stsz', 0, 0, u32(0), u32(n), U32(list.chunks.map((c) => c.length)));
      let stco;
      if (use64) { const o = new Uint8Array(offsets.length * 8), dv = new DataView(o.buffer); offsets.forEach((x, i) => dv.setBigUint64(i * 8, BigInt(x))); stco = fbox('co64', 0, 0, u32(offsets.length), o); }
      else stco = fbox('stco', 0, 0, u32(offsets.length), U32(offsets));
      return box('stbl', stsd, stts, ctts, stss, stsc, stsz, stco);
    }

    function trakFor(kind, id, tm, stbl, movieDur) {
      const isV = kind === 'v', dur = Math.round((tm.total * 1000) / tm.ts);
      const tkhd = fbox('tkhd', 0, 3, u32(0), u32(0), u32(id), u32(0), u32(Math.max(0, dur - Math.round((tm.shift * 1000) / tm.ts))),
        zeros(8), u16(0), u16(0), u16(isV ? 0 : 0x100), u16(0), MATRIX, u32(isV ? vo.width * 65536 : 0), u32(isV ? vo.height * 65536 : 0));
      const edts = tm.shift ? box('edts', fbox('elst', 0, 0, u32(1), u32(dur - Math.round((tm.shift * 1000) / tm.ts)), u32(tm.shift), u32(0x10000))) : new Uint8Array(0);
      const mdhd = fbox('mdhd', 0, 0, u32(0), u32(0), u32(tm.ts), u32(tm.total), u16(0x55c4), u16(0));
      const hdlr = fbox('hdlr', 0, 0, u32(0), str(isV ? 'vide' : 'soun'), zeros(12), str(isV ? 'VideoHandler' : 'SoundHandler'), u8(0));
      const mhd = isV ? fbox('vmhd', 0, 1, zeros(8)) : fbox('smhd', 0, 0, zeros(4));
      const dinf = box('dinf', fbox('dref', 0, 0, u32(1), fbox('url ', 0, 1)));
      return box('trak', tkhd, edts, box('mdia', mdhd, hdlr, box('minf', mhd, dinf, stbl)));
    }

    function finish() {
      if (finished) throw new Error('muxer already finished');
      finished = true;
      if (!V.chunks.length) throw new Error('muxer: no video frames');
      const vt = videoTiming(), at = A && A.chunks.length ? audioTiming() : null;
      // Chunk layout: ~1 s groups, video group then audio group, in file order.
      const layout = []; // { k:'v'|'a', first, count, bytes }
      const groups = (tm, k, list) => { const out = []; let i = 0, b = 1; while (i < list.chunks.length) { const first = i; let bytes = 0; while (i < list.chunks.length && tm.dts[i] / tm.ts < b) bytes += list.chunks[i++].length; if (i > first) out.push({ k, first, count: i - first, bytes, b }); b++; } return out; };
      const vg = groups(vt, 'v', V), ag = at ? groups(at, 'a', A) : [];
      for (let vi = 0, ai = 0; vi < vg.length || ai < ag.length;) {
        if (ai >= ag.length || (vi < vg.length && vg[vi].b <= ag[ai].b)) layout.push(vg[vi++]); else layout.push(ag[ai++]);
      }
      const dataSize = layout.reduce((s, c) => s + c.bytes, 0);
      const use64 = dataSize > 4e9, mdatHdr = dataSize + 8 > 0xffffffff ? cat([u32(1), str('mdat'), u32(0), u32(dataSize + 16)]) : cat([u32(dataSize + 8), str('mdat')]);
      const ftyp = box('ftyp', str('isom'), u32(0x200), str('isom'), str('iso2'), str('avc1'), str('mp41'));
      const movieDur = Math.round(Math.max((vt.total * 1000) / vt.ts, at ? (at.total * 1000) / at.ts : 0));
      const build = (base) => {
        const off = { v: [], a: [] }; let p = base;
        for (const c of layout) { off[c.k].push(p); p += c.bytes; }
        const vInfo = layout.filter((c) => c.k === 'v'), aInfo = layout.filter((c) => c.k === 'a');
        const mvhd = fbox('mvhd', 0, 0, u32(Math.floor(Date.now() / 1000) + 2082844800), u32(Math.floor(Date.now() / 1000) + 2082844800), u32(1000), u32(movieDur),
          u32(0x10000), u16(0x100), zeros(10), MATRIX, zeros(24), u32(at ? 3 : 2));
        const traks = [trakFor('v', 1, vt, stblFor('v', vt, vInfo, off.v, use64), movieDur)];
        if (at) traks.push(trakFor('a', 2, at, stblFor('a', at, aInfo, off.a, use64), movieDur));
        return box('moov', mvhd, ...traks);
      };
      const moovLen = build(0).length; // offsets have a fixed width, so the length does not depend on their values
      const moov = build(ftyp.length + moovLen + mdatHdr.length);
      const parts = [ftyp, moov, mdatHdr];
      for (const c of layout) { const list = c.k === 'v' ? V : A; for (let i = c.first; i < c.first + c.count; i++) parts.push(list.chunks[i]); }
      V.chunks = []; if (A) A.chunks = [];
      return new Blob(parts, { type: 'video/mp4' });
    }

    return { addVideo, addAudio, finish, get frames() { return V.chunks.length; } };
  }

  MS.mp4 = { open, read, readMany, isMp4, muxer };
})();
