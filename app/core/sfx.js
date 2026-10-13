/* MS.sound(name): interface sounds synthesized with Web Audio (no files). tap tick on off open pop send receive notify success complete error cancel trash. */
(() => {
  let ctx = null, master = null;
  let muted = (() => { try { return localStorage.getItem('ms.mute') === '1'; } catch (e) { return false; } })();
  const last = {};
  function audio() {
    if (!ctx) {
      ctx = new AudioContext();
      const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -18; comp.ratio.value = 4;
      master = ctx.createGain(); master.gain.value = 0.5;
      master.connect(comp).connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  // the browser only lets audio start after a gesture: open the context on the first one
  addEventListener('pointerdown', () => { if (!muted) audio(); }, { once: true, capture: true });
  /* one voice: oscillator with an attack/decay envelope and an optional pitch glide */
  function tone(freq, { at = 0, dur = 0.3, gain = 0.2, type = 'sine', to = null, attack = 0.004 } = {}) {
    const t = ctx.currentTime + at, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur * 0.8);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(master); o.start(t); o.stop(t + dur + 0.02);
  }
  /* a bell: fundamental plus a quiet inharmonic partial, like glass */
  const bell = (f, at, dur = 0.9, gain = 0.16) => { tone(f, { at, dur, gain }); tone(f * 2.76, { at, dur: dur * 0.45, gain: gain * 0.18 }); };
  /* filtered noise sweep (whoosh) */
  function whoosh(from, to, { at = 0, dur = 0.25, gain = 0.08 } = {}) {
    const t = ctx.currentTime + at, len = Math.ceil(ctx.sampleRate * dur), buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = buf; bp.type = 'bandpass'; bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(from, t); bp.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + dur * 0.35); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp).connect(g).connect(master); src.start(t); src.stop(t + dur + 0.02);
  }
  const SOUNDS = {
    tap: () => tone(1900, { dur: 0.035, gain: 0.035, type: 'triangle' }),
    tick: () => tone(1250, { dur: 0.03, gain: 0.03, type: 'triangle' }),
    on: () => { tone(880, { dur: 0.06, gain: 0.05 }); tone(1320, { at: 0.045, dur: 0.08, gain: 0.05 }); },
    off: () => { tone(1100, { dur: 0.06, gain: 0.045 }); tone(740, { at: 0.045, dur: 0.08, gain: 0.04 }); },
    open: () => tone(620, { dur: 0.12, gain: 0.035, to: 940 }),
    pop: () => tone(1180, { dur: 0.14, gain: 0.07, to: 900 }),
    send: () => { whoosh(500, 3200, { dur: 0.22, gain: 0.06 }); tone(560, { dur: 0.16, gain: 0.05, to: 1050 }); },
    receive: () => { bell(1046.5, 0, 0.5, 0.08); bell(1568, 0.07, 0.6, 0.06); },
    notify: () => { bell(987.8, 0, 0.6, 0.1); bell(1318.5, 0.11, 0.8, 0.1); },
    success: () => { bell(880, 0, 0.6, 0.12); bell(1318.5, 0.09, 0.9, 0.12); },
    complete: () => { bell(1046.5, 0, 0.7, 0.11); bell(1318.5, 0.08, 0.8, 0.11); bell(1568, 0.16, 1.1, 0.13); },
    error: () => { tone(392, { dur: 0.16, gain: 0.09, type: 'triangle' }); tone(277, { at: 0.13, dur: 0.24, gain: 0.09, type: 'triangle' }); },
    cancel: () => tone(700, { dur: 0.2, gain: 0.06, to: 420 }),
    trash: () => { whoosh(2800, 380, { dur: 0.3, gain: 0.07 }); tone(180, { at: 0.2, dur: 0.14, gain: 0.08, to: 110 }); },
  };
  const play = (name) => {
    if (muted || !SOUNDS[name]) return;
    const now = performance.now();
    if (now - (last[name] || 0) < 120) return; // the same sound twice in a burst plays once
    last[name] = now;
    try { audio(); SOUNDS[name](); } catch (e) { /* audio unavailable */ }
  };
  play.isMuted = () => muted;
  play.setMuted = (m) => {
    muted = m;
    try { localStorage.setItem('ms.mute', m ? '1' : '0'); } catch (e) { /* storage off */ }
    if (!m) play('on');
  };
  MS.sound = play;
})();
