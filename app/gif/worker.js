/* GIF encoder worker body (GIF Cutter encoder). A function, not a file: file:// cannot load a Worker script, so nexus.js stringifies it into a Blob URL.
   Pipeline: fine RGB histogram -> Wu quantizer -> k-means refinement -> palette map with Floyd-Steinberg (serpentine) or ordered Bayer
   dithering -> inter-frame transparency + changed-rectangle crop -> LZW -> GIF89a. Runs inside the worker: no access to MS or the DOM. */
(window.MS = window.MS || {}).gifWorker = function () {
'use strict';

/* ---------- byte writer ---------- */
class ByteWriter {
  constructor(cap) { this.buf = new Uint8Array(cap || 1 << 20); this.len = 0; }
  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let c = this.buf.length * 2;
    while (c < this.len + n) c *= 2;
    const nb = new Uint8Array(c); nb.set(this.buf.subarray(0, this.len)); this.buf = nb;
  }
  u8(v) { this.ensure(1); this.buf[this.len++] = v & 255; }
  u16(v) { this.ensure(2); this.buf[this.len++] = v & 255; this.buf[this.len++] = (v >> 8) & 255; }
  bytes(a) { this.ensure(a.length); this.buf.set(a, this.len); this.len += a.length; }
  str(s) { for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i)); }
  result() { return this.buf.slice(0, this.len); }
}

/* ---------- fine histogram: 6 bits per channel, exact sums per bin ---------- */
const FINE = 1 << 18;
class FineHist {
  constructor() {
    this.count = new Float64Array(FINE);
    this.sr = new Float64Array(FINE); this.sg = new Float64Array(FINE); this.sb = new Float64Array(FINE);
    this.list = new Int32Array(FINE); this.n = 0;
  }
  reset() {
    for (let i = 0; i < this.n; i++) { const k = this.list[i]; this.count[k] = 0; this.sr[k] = 0; this.sg[k] = 0; this.sb[k] = 0; }
    this.n = 0;
  }
  add(px, weight) {
    const w = weight || 1, c = this.count, sr = this.sr, sg = this.sg, sb = this.sb, list = this.list;
    for (let p = 0, L = px.length; p < L; p += 4) {
      const r = px[p], g = px[p + 1], b = px[p + 2];
      const k = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
      if (c[k] === 0) list[this.n++] = k;
      c[k] += w; sr[k] += r * w; sg[k] += g * w; sb[k] += b * w;
    }
  }
}

/* ---------- perceptual-ish weighted distance (shared by quantizer + mapper) ---------- */
const WR = 2, WG = 4, WB = 3;
function nearest(r, g, b, P, K) {
  let best = 0, bd = Infinity;
  for (let k = 0, j = 0; k < K; k++, j += 3) {
    const dr = r - P[j], dg = g - P[j + 1], db = b - P[j + 2];
    const d = WR * dr * dr + WG * dg * dg + WB * db * db;
    if (d < bd) { bd = d; best = k; if (d === 0) break; }
  }
  return best;
}

/* ---------- Wu's color quantizer (Graphics Gems II), fed from the fine histogram ---------- */
const S33 = 33, N33 = 33 * 33 * 33;
const I3 = (r, g, b) => (r * S33 + g) * S33 + b;
function wuQuantize(hist, K) {
  const wt = new Float64Array(N33), mr = new Float64Array(N33), mg = new Float64Array(N33), mb = new Float64Array(N33), m2 = new Float64Array(N33);
  for (let i = 0; i < hist.n; i++) {
    const k = hist.list[i], c = hist.count[k];
    const fr = k >> 12, fg = (k >> 6) & 63, fb = k & 63;
    const ind = I3((fr >> 1) + 1, (fg >> 1) + 1, (fb >> 1) + 1);
    const R = hist.sr[k], G = hist.sg[k], B = hist.sb[k];
    wt[ind] += c; mr[ind] += R; mg[ind] += G; mb[ind] += B; m2[ind] += (R * R + G * G + B * B) / c;
  }
  // cumulative moments
  const area = new Float64Array(S33), aR = new Float64Array(S33), aG = new Float64Array(S33), aB = new Float64Array(S33), a2 = new Float64Array(S33);
  for (let r = 1; r <= 32; r++) {
    area.fill(0); aR.fill(0); aG.fill(0); aB.fill(0); a2.fill(0);
    for (let g = 1; g <= 32; g++) {
      let line = 0, lR = 0, lG = 0, lB = 0, l2 = 0;
      for (let b = 1; b <= 32; b++) {
        const ind = I3(r, g, b), ai = b, prev = I3(r - 1, g, b);
        line += wt[ind]; lR += mr[ind]; lG += mg[ind]; lB += mb[ind]; l2 += m2[ind];
        area[ai] += line; aR[ai] += lR; aG[ai] += lG; aB[ai] += lB; a2[ai] += l2;
        wt[ind] = wt[prev] + area[ai]; mr[ind] = mr[prev] + aR[ai]; mg[ind] = mg[prev] + aG[ai]; mb[ind] = mb[prev] + aB[ai]; m2[ind] = m2[prev] + a2[ai];
      }
    }
  }
  const vol = (c, m) => m[I3(c.r1, c.g1, c.b1)] - m[I3(c.r1, c.g1, c.b0)] - m[I3(c.r1, c.g0, c.b1)] + m[I3(c.r1, c.g0, c.b0)]
    - m[I3(c.r0, c.g1, c.b1)] + m[I3(c.r0, c.g1, c.b0)] + m[I3(c.r0, c.g0, c.b1)] - m[I3(c.r0, c.g0, c.b0)];
  const bottom = (c, d, m) => d === 0
    ? -m[I3(c.r0, c.g1, c.b1)] + m[I3(c.r0, c.g1, c.b0)] + m[I3(c.r0, c.g0, c.b1)] - m[I3(c.r0, c.g0, c.b0)]
    : d === 1
      ? -m[I3(c.r1, c.g0, c.b1)] + m[I3(c.r1, c.g0, c.b0)] + m[I3(c.r0, c.g0, c.b1)] - m[I3(c.r0, c.g0, c.b0)]
      : -m[I3(c.r1, c.g1, c.b0)] + m[I3(c.r1, c.g0, c.b0)] + m[I3(c.r0, c.g1, c.b0)] - m[I3(c.r0, c.g0, c.b0)];
  const top = (c, d, p, m) => d === 0
    ? m[I3(p, c.g1, c.b1)] - m[I3(p, c.g1, c.b0)] - m[I3(p, c.g0, c.b1)] + m[I3(p, c.g0, c.b0)]
    : d === 1
      ? m[I3(c.r1, p, c.b1)] - m[I3(c.r1, p, c.b0)] - m[I3(c.r0, p, c.b1)] + m[I3(c.r0, p, c.b0)]
      : m[I3(c.r1, c.g1, p)] - m[I3(c.r1, c.g0, p)] - m[I3(c.r0, c.g1, p)] + m[I3(c.r0, c.g0, p)];
  const variance = (c) => {
    const dr = vol(c, mr), dg = vol(c, mg), db = vol(c, mb);
    return vol(c, m2) - (dr * dr + dg * dg + db * db) / vol(c, wt);
  };
  const maximize = (c, d, first, last, wR, wG, wB, wW) => {
    const bR = bottom(c, d, mr), bG = bottom(c, d, mg), bB = bottom(c, d, mb), bW = bottom(c, d, wt);
    let max = 0, cut = -1;
    for (let i = first; i < last; i++) {
      let hR = bR + top(c, d, i, mr), hG = bG + top(c, d, i, mg), hB = bB + top(c, d, i, mb), hW = bW + top(c, d, i, wt);
      if (hW === 0) continue;
      let t = (hR * hR + hG * hG + hB * hB) / hW;
      hR = wR - hR; hG = wG - hG; hB = wB - hB; hW = wW - hW;
      if (hW === 0) continue;
      t += (hR * hR + hG * hG + hB * hB) / hW;
      if (t > max) { max = t; cut = i; }
    }
    return [max, cut];
  };
  const cut = (a, b) => {
    const wR = vol(a, mr), wG = vol(a, mg), wB = vol(a, mb), wW = vol(a, wt);
    const [maxr, cutr] = maximize(a, 0, a.r0 + 1, a.r1, wR, wG, wB, wW);
    const [maxg, cutg] = maximize(a, 1, a.g0 + 1, a.g1, wR, wG, wB, wW);
    const [maxb, cutb] = maximize(a, 2, a.b0 + 1, a.b1, wR, wG, wB, wW);
    let dir;
    if (maxr >= maxg && maxr >= maxb) { dir = 0; if (cutr < 0) return false; }
    else if (maxg >= maxr && maxg >= maxb) dir = 1; else dir = 2;
    b.r1 = a.r1; b.g1 = a.g1; b.b1 = a.b1;
    if (dir === 0) { b.r0 = a.r1 = cutr; b.g0 = a.g0; b.b0 = a.b0; }
    else if (dir === 1) { b.g0 = a.g1 = cutg; b.r0 = a.r0; b.b0 = a.b0; }
    else { b.b0 = a.b1 = cutb; b.r0 = a.r0; b.g0 = a.g0; }
    a.vol = (a.r1 - a.r0) * (a.g1 - a.g0) * (a.b1 - a.b0);
    b.vol = (b.r1 - b.r0) * (b.g1 - b.g0) * (b.b1 - b.b0);
    return true;
  };
  const cubes = [];
  for (let i = 0; i < K; i++) cubes.push({ r0: 0, g0: 0, b0: 0, r1: 0, g1: 0, b1: 0, vol: 0 });
  Object.assign(cubes[0], { r1: 32, g1: 32, b1: 32 });
  const vv = new Float64Array(K);
  let next = 0, n = K;
  for (let i = 1; i < K; i++) {
    if (cut(cubes[next], cubes[i])) {
      vv[next] = cubes[next].vol > 1 ? variance(cubes[next]) : 0;
      vv[i] = cubes[i].vol > 1 ? variance(cubes[i]) : 0;
    } else { vv[next] = 0; i--; }
    next = 0; let t = vv[0];
    for (let k = 1; k <= i; k++) if (vv[k] > t) { t = vv[k]; next = k; }
    if (t <= 0) { n = i + 1; break; }
  }
  const P = [];
  for (let k = 0; k < n; k++) {
    const w = vol(cubes[k], wt);
    if (w > 0) P.push(Math.round(vol(cubes[k], mr) / w), Math.round(vol(cubes[k], mg) / w), Math.round(vol(cubes[k], mb) / w));
  }
  return new Uint8Array(P);
}

/* k-means (Lloyd) refinement over histogram bins: pulls Wu's box means onto real clusters */
function refine(P, hist, iters) {
  const K = P.length / 3, sums = new Float64Array(K * 4);
  for (let it = 0; it < iters; it++) {
    sums.fill(0);
    for (let i = 0; i < hist.n; i++) {
      const k = hist.list[i], c = hist.count[k];
      const r = hist.sr[k] / c, g = hist.sg[k] / c, b = hist.sb[k] / c;
      const j = nearest(r, g, b, P, K) * 4;
      sums[j] += c; sums[j + 1] += hist.sr[k]; sums[j + 2] += hist.sg[k]; sums[j + 3] += hist.sb[k];
    }
    let moved = 0;
    for (let k = 0; k < K; k++) {
      const c = sums[k * 4]; if (!c) continue;
      const r = Math.round(sums[k * 4 + 1] / c), g = Math.round(sums[k * 4 + 2] / c), b = Math.round(sums[k * 4 + 3] / c);
      moved += Math.abs(r - P[k * 3]) + Math.abs(g - P[k * 3 + 1]) + Math.abs(b - P[k * 3 + 2]);
      P[k * 3] = r; P[k * 3 + 1] = g; P[k * 3 + 2] = b;
    }
    if (moved === 0) break;
  }
  return P;
}

function buildPalette(hist, K, iters) {
  if (hist.n === 0) return new Uint8Array([0, 0, 0]);
  if (hist.n <= K) { // few colors: exact
    const P = new Uint8Array(hist.n * 3);
    for (let i = 0; i < hist.n; i++) { const k = hist.list[i], c = hist.count[k]; P[i * 3] = Math.round(hist.sr[k] / c); P[i * 3 + 1] = Math.round(hist.sg[k] / c); P[i * 3 + 2] = Math.round(hist.sb[k] / c); }
    return P;
  }
  return refine(wuQuantize(hist, K), hist, iters);
}

/* ---------- LZW (port of the classic compress/gif.js encoder) ---------- */
const HSIZE = 5003, BITS = 12, MAXMAX = 4096;
const htab = new Int32Array(HSIZE), codetab = new Int32Array(HSIZE);
const MASKS = []; for (let i = 0; i <= 16; i++) MASKS.push((1 << i) - 1);
/* Lossy LZW (in the spirit of gifsicle --lossy): when the next pixel would end the current string,
   try palette colors close to it (within the tolerance) that continue a string already in the
   dictionary. Longer strings mean fewer codes and a smaller file, at the cost of small color shifts. */
const NEAR = 10;
function buildNear(P, K, tol) {
  if (!tol) return null;
  const near = new Int16Array(K * NEAR).fill(-1), cand = [];
  for (let a = 0; a < K; a++) {
    cand.length = 0;
    for (let b = 0; b < K; b++) {
      if (a === b) continue;
      const dr = P[a * 3] - P[b * 3], dg = P[a * 3 + 1] - P[b * 3 + 1], db = P[a * 3 + 2] - P[b * 3 + 2];
      const d = WR * dr * dr + WG * dg * dg + WB * db * db;
      if (d <= tol) cand.push(d * 256 + b);
    }
    cand.sort((x, y) => x - y);
    for (let j = 0; j < Math.min(NEAR, cand.length); j++) near[a * NEAR + j] = cand[j] & 255;
  }
  return near;
}
function lzw(ix, minCode, w, near, T, dsub, P, tol) {
  w.u8(minCode);
  const initBits = minCode + 1, clearCode = 1 << minCode, eof = clearCode + 1;
  let nBits = initBits, maxcode = (1 << nBits) - 1, freeEnt = clearCode + 2, clearFlg = false;
  let acc = 0, accBits = 0;
  const blk = new Uint8Array(256); let bl = 0;
  const flushBlk = () => { if (bl > 0) { w.u8(bl); w.bytes(blk.subarray(0, bl)); bl = 0; } };
  const charOut = (c) => { blk[bl++] = c; if (bl >= 254) flushBlk(); };
  const output = (code) => {
    acc &= MASKS[accBits];
    acc = accBits > 0 ? acc | (code << accBits) : code;
    accBits += nBits;
    while (accBits >= 8) { charOut(acc & 255); acc >>= 8; accBits -= 8; }
    if (freeEnt > maxcode || clearFlg) {
      if (clearFlg) { nBits = initBits; maxcode = (1 << nBits) - 1; clearFlg = false; }
      else { ++nBits; maxcode = nBits === BITS ? MAXMAX : (1 << nBits) - 1; }
    }
    if (code === eof) { while (accBits > 0) { charOut(acc & 255); acc >>= 8; accBits -= 8; } flushBlk(); }
  };
  htab.fill(-1);
  let ent = ix[0];
  output(clearCode);
  outer: for (let p = 1, L = ix.length; p < L; p++) {
    const c = ix[p], fcode = (c << BITS) + ent;
    let i = (c << 4) ^ ent;
    if (htab[i] === fcode) { ent = codetab[i]; continue; }
    if (htab[i] >= 0) {
      let disp = HSIZE - i; if (i === 0) disp = 1;
      do { if ((i -= disp) < 0) i += HSIZE; if (htab[i] === fcode) { ent = codetab[i]; continue outer; } } while (htab[i] >= 0);
    }
    if (near) {
      // candidates: for a "keep" pixel, the color already on screen and colors near it;
      // for a changed pixel, colors near it, then "keep" if what's on screen is close enough
      const dc = dsub ? dsub[p] : -1;
      const base = c === T ? dc : c;
      for (let j = -1; j <= NEAR; j++) {
        let c2;
        if (j === -1) { if (c !== T || dc < 0) continue; c2 = dc; }
        else if (j === NEAR) {
          if (c === T || dc < 0) break;
          const dr = P[c * 3] - P[dc * 3], dg = P[c * 3 + 1] - P[dc * 3 + 1], db = P[c * 3 + 2] - P[dc * 3 + 2];
          if (WR * dr * dr + WG * dg * dg + WB * db * db > tol) break;
          c2 = T;
        } else { if (base < 0) break; c2 = near[base * NEAR + j]; if (c2 < 0) { j = NEAR - 1; continue; } }
        const f2 = (c2 << BITS) + ent; let k = (c2 << 4) ^ ent;
        let hit = htab[k] === f2;
        if (!hit && htab[k] >= 0) {
          let disp = HSIZE - k; if (k === 0) disp = 1;
          do { if ((k -= disp) < 0) k += HSIZE; if (htab[k] === f2) { hit = true; break; } } while (htab[k] >= 0);
        }
        if (hit) { ent = codetab[k]; ix[p] = c2; continue outer; }
      }
    }
    output(ent); ent = c;
    if (freeEnt < MAXMAX) { codetab[i] = freeEnt++; htab[i] = fcode; }
    else { htab.fill(-1); freeEnt = clearCode + 2; clearFlg = true; output(clearCode); }
  }
  output(ent); output(eof);
  w.u8(0);
}

/* ---------- encoder state ---------- */
const BAYER8 = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21];
let E = null;

function init(o) {
  const tableSize = o.colors;               // 32..256, power of two
  const bits = Math.round(Math.log2(tableSize));
  E = {
    W: o.width, H: o.height, o,
    K: tableSize - 1, T: tableSize - 1,      // last slot is the transparent index
    bits, minCode: Math.max(2, bits), tableSize,
    hist: new FineHist(), pal: null,
    cache: new Int16Array(FINE),
    ref: new Uint8Array(o.width * o.height * 3),
    idx: new Uint8Array(o.width * o.height),
    errA: new Float32Array((o.width + 2) * 3), errB: new Float32Array((o.width + 2) * 3),
    out: new ByteWriter(Math.max(1 << 20, o.width * o.height * 4)),
    first: true, headerDone: false, pending: null,
    frames: 0, written: 0, merged: 0,
    thr: o.threshold,
    lossy: o.lossy || 0, near: null,
    disp: new Uint8Array(o.width * o.height),   // palette index currently on screen (global palette only)
    bayerAmp: 14 * Math.cbrt(256 / tableSize),
  };
  return true;
}

function table(P) { // padded color table
  const t = new Uint8Array(E.tableSize * 3); t.set(P.subarray(0, Math.min(P.length, E.K * 3))); return t;
}

function writeHeader() {
  const w = E.out, global = E.o.palette === 'global';
  w.str('GIF89a'); w.u16(E.W); w.u16(E.H);
  w.u8(global ? (0x80 | 0x70 | (E.bits - 1)) : 0x70);
  w.u8(0); w.u8(0);
  if (global) w.bytes(table(E.pal));
  if (E.o.loop !== 'once') { w.u8(0x21); w.u8(0xff); w.u8(11); w.str('NETSCAPE2.0'); w.u8(3); w.u8(1); w.u16(0); w.u8(0); }
  E.headerDone = true;
}

function flushPending() {
  const p = E.pending; if (!p) return;
  const w = E.out;
  w.u8(0x21); w.u8(0xf9); w.u8(4);
  w.u8((1 << 2) | 1);                 // disposal: leave in place, transparency on
  w.u16(Math.min(65535, p.delay)); w.u8(E.T); w.u8(0);
  w.bytes(p.body);
  E.pending = null; E.written++;
}

function mapFrame(px, P, K) {
  const { W, H, ref, idx, cache } = E, T = E.T, first = E.first, thr = E.thr;
  const dither = E.o.dither, strength = 0.85, amp = E.bayerAmp;
  let minX = W, minY = H, maxX = -1, maxY = -1;
  let cur = E.errA, nxt = E.errB;
  cur.fill(0);
  for (let y = 0; y < H; y++) {
    nxt.fill(0);
    const rtl = dither === 'fs' && (y & 1) === 1;
    const x0 = rtl ? W - 1 : 0, x1 = rtl ? -1 : W, dx = rtl ? -1 : 1;
    for (let x = x0; x !== x1; x += dx) {
      const i = y * W + x, p = i * 4, q = i * 3;
      const r = px[p], g = px[p + 1], b = px[p + 2];
      if (!first) {
        const dr = r - ref[q], dg = g - ref[q + 1], db = b - ref[q + 2];
        if (WR * dr * dr + WG * dg * dg + WB * db * db <= thr) { idx[i] = T; continue; }
      }
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      let rr = r, gg = g, bb = b;
      const e = (x + 1) * 3;
      if (dither === 'fs') { rr += cur[e]; gg += cur[e + 1]; bb += cur[e + 2]; }
      else if (dither === 'bayer') { const t = (BAYER8[((y & 7) << 3) | (x & 7)] / 64 - 0.4921875) * amp; rr += t; gg += t; bb += t; }
      rr = rr < 0 ? 0 : rr > 255 ? 255 : rr; gg = gg < 0 ? 0 : gg > 255 ? 255 : gg; bb = bb < 0 ? 0 : bb > 255 ? 255 : bb;
      const key = ((rr >> 2) << 12) | ((gg >> 2) << 6) | (bb >> 2);
      let k = cache[key];
      if (k < 0) { k = nearest((rr & 252) + 2, (gg & 252) + 2, (bb & 252) + 2, P, K); cache[key] = k; }
      idx[i] = k;
      ref[q] = r; ref[q + 1] = g; ref[q + 2] = b;
      if (dither === 'fs') {
        const j = k * 3;
        const er = (rr - P[j]) * strength, eg = (gg - P[j + 1]) * strength, eb = (bb - P[j + 2]) * strength;
        const f = e + 3 * dx, bk = e - 3 * dx;
        cur[f] += er * 0.4375; cur[f + 1] += eg * 0.4375; cur[f + 2] += eb * 0.4375;
        nxt[bk] += er * 0.1875; nxt[bk + 1] += eg * 0.1875; nxt[bk + 2] += eb * 0.1875;
        nxt[e] += er * 0.3125; nxt[e + 1] += eg * 0.3125; nxt[e + 2] += eb * 0.3125;
        nxt[f] += er * 0.0625; nxt[f + 1] += eg * 0.0625; nxt[f + 2] += eb * 0.0625;
      }
    }
    const t = cur; cur = nxt; nxt = t;
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function frame(m) {
  const px = new Uint8Array(m.buf);
  let P = E.pal;
  if (E.o.palette === 'frame') {
    E.hist.reset(); E.hist.add(px);
    P = buildPalette(E.hist, E.K, 2);
    E.cache.fill(-1);
  }
  if (!E.headerDone) writeHeader();
  const K = P.length / 3;
  const box = mapFrame(px, P, K);
  E.frames++;
  if (!box) { // nothing changed: stretch the previous frame instead of storing a new one
    if (E.pending) E.pending.delay += m.delay;
    E.merged++;
    return { frames: E.frames, body: 0 };
  }
  flushPending();
  const w = new ByteWriter(box.w * box.h + 1024);
  w.u8(0x2c); w.u16(box.x); w.u16(box.y); w.u16(box.w); w.u16(box.h);
  if (E.o.palette === 'frame') { w.u8(0x80 | (E.bits - 1)); w.bytes(table(P)); } else w.u8(0);
  let sub = E.idx;
  if (box.w !== E.W || box.h !== E.H) {
    sub = new Uint8Array(box.w * box.h);
    for (let y = 0; y < box.h; y++) sub.set(E.idx.subarray((box.y + y) * E.W + box.x, (box.y + y) * E.W + box.x + box.w), y * box.w);
  }
  if (E.o.palette === 'frame') E.near = buildNear(P, K, E.lossy);
  const global = E.o.palette !== 'frame';
  let dsub = null;
  if (E.near && global && !E.first) {
    dsub = new Uint8Array(box.w * box.h);
    for (let y = 0; y < box.h; y++) dsub.set(E.disp.subarray((box.y + y) * E.W + box.x, (box.y + y) * E.W + box.x + box.w), y * box.w);
  }
  const orig = dsub ? sub.slice() : null;
  lzw(sub, E.minCode, w, E.near, E.T, dsub, P, E.lossy);
  if (global) { // what the viewer now shows
    const ref = E.ref;
    for (let y = 0; y < box.h; y++) {
      const row = (box.y + y) * E.W + box.x;
      for (let x = 0; x < box.w; x++) {
        const j = y * box.w + x, v = sub[j];
        if (v !== E.T) E.disp[row + x] = v;
        else if (orig && orig[j] !== E.T) { // a change was dropped: compare future frames with what is really on screen
          const q = (row + x) * 3, d = E.disp[row + x] * 3;
          ref[q] = P[d]; ref[q + 1] = P[d + 1]; ref[q + 2] = P[d + 2];
        }
      }
    }
  }
  E.pending = { delay: m.delay, body: w.result() };
  E.first = false;
  E.lastPal = P;
  return { frames: E.frames, size: E.out.len, body: E.pending.body.length + 8 };
}

const handlers = {
  init,
  sample(m) { E.hist.add(new Uint8Array(m.buf)); return true; },
  palette() {
    E.pal = buildPalette(E.hist, E.K, 4);
    E.cache.fill(-1);
    E.near = buildNear(E.pal, E.pal.length / 3, E.lossy);
    return E.pal.slice();
  },
  frame,
  restart() { E.first = true; E.pending = null; return true; }, // size probes: next frame is a full keyframe again
  finish() {
    if (!E.headerDone) writeHeader();
    flushPending();
    E.out.u8(0x3b);
    const bytes = E.out.result();
    return { bytes, frames: E.frames, written: E.written, merged: E.merged, palette: (E.pal || E.lastPal || new Uint8Array(0)).slice() };
  },
};

self.onmessage = (e) => {
  const m = e.data;
  try {
    const result = handlers[m.type](m);
    const transfer = result && result.bytes instanceof Uint8Array ? [result.bytes.buffer] : [];
    self.postMessage({ id: m.id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: String((err && err.stack) || err) });
  }
};
};
