import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Play, Square, Power, Waves, Pencil, Sliders, Eraser, Trash2, X, Music,
         Save, Repeat, ListMusic, ChevronUp, ChevronDown, Plus, FolderOpen,
         Undo2, Redo2, FilePlus, Zap, Layers } from 'lucide-react';
import { YuccaSamples, YuccaPresets } from './yucca-bridge.js';

// ============================================================================
// NES SYNTH ENGINE  (Pulse via Fourier, Triangle, LFSR noise + echo aux bus)
// Unchanged from the prior build.
// ============================================================================

const NOTE_FREQ = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const SCALES = {
  'Minor Pent':    [0, 3, 5, 7, 10],
  'Major Pent':    [0, 2, 4, 7, 9],
  'Nat Minor':     [0, 2, 3, 5, 7, 8, 10],
  'Major':         [0, 2, 4, 5, 7, 9, 11],
  'Dorian':        [0, 2, 3, 5, 7, 9, 10],
  'Phrygian':      [0, 1, 3, 5, 7, 8, 10],
  'Chromatic':     [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

// Pure: scale-degree row index -> MIDI, given a scale + root + octave offset.
const rowToMidiWith = (scaleName, rootNote, pitch, octave) => {
  const iv = SCALES[scaleName] || SCALES['Minor Pent'];
  const len = iv.length;
  const p = Math.max(0, Math.min(len, pitch));
  const semis = p < len ? iv[p] : 12;
  return rootNote + octave * 12 + semis;
};

class NESEngine {
  constructor() {
    this.ctx = null; this.master = null; this.auxInput = null;
    this.delay = null; this.delayFeedback = null; this.delayTone = null; this.delayWet = null;
    this.pulseWaves = {}; this.noiseBuffer = null; this.metalBuffer = null;
  }

  init() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.7;
    const shaper = this.ctx.createWaveShaper();
    const curve = new Float32Array(2048);
    for (let i = 0; i < 2048; i++) { const x = (i / 1024) - 1; curve[i] = Math.tanh(x * 1.4); }
    shaper.curve = curve;
    this.master.connect(shaper);
    shaper.connect(this.ctx.destination);

    this.auxInput = this.ctx.createGain();
    this.auxInput.gain.value = 1;
    this.delay = this.ctx.createDelay(2.0);
    this.delay.delayTime.value = 0.27;
    this.delayFeedback = this.ctx.createGain();
    this.delayFeedback.gain.value = 0.4;
    this.delayTone = this.ctx.createBiquadFilter();
    this.delayTone.type = 'lowpass';
    this.delayTone.frequency.value = 2200;
    this.delayTone.Q.value = 0.6;
    this.delayWet = this.ctx.createGain();
    this.delayWet.gain.value = 0.55;
    this.auxInput.connect(this.delay);
    this.delay.connect(this.delayTone);
    this.delayTone.connect(this.delayWet);
    this.delayWet.connect(this.master);
    this.delay.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delay);

    [0.125, 0.25, 0.5, 0.75].forEach((d) => { this.pulseWaves[d] = this._makePulseWave(d); });

    const sr = this.ctx.sampleRate;
    this.noiseBuffer = this.ctx.createBuffer(1, sr, sr);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < sr; i++) data[i] = Math.random() * 2 - 1;

    this.metalBuffer = this.ctx.createBuffer(1, sr, sr);
    const mdata = this.metalBuffer.getChannelData(0);
    let lfsr = 1;
    for (let i = 0; i < sr; i++) {
      const b = ((lfsr >> 0) ^ (lfsr >> 6)) & 1;
      lfsr = (lfsr >> 1) | (b << 14);
      mdata[i] = ((lfsr & 1) ? 1 : -1) * 0.6;
    }
  }

  _makePulseWave(duty) {
    const harmonics = 64;
    const real = new Float32Array(harmonics + 1);
    const imag = new Float32Array(harmonics + 1);
    for (let n = 1; n <= harmonics; n++) imag[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty);
    return this.ctx.createPeriodicWave(real, imag);
  }

  // One oscillator of the requested timbre. 'pulse' uses our Fourier waves at a
  // duty; triangle/sawtooth/square use the native (band-limited) types. All are
  // alias-free, so swapping waveform never dirties the mix on its own.
  _makeOsc(wave, duty) {
    const osc = this.ctx.createOscillator();
    if (wave === 'pulse') osc.setPeriodicWave(this.pulseWaves[duty] || this.pulseWaves[0.5]);
    else osc.type = (wave === 'sawtooth' || wave === 'square' || wave === 'triangle') ? wave : 'triangle';
    return osc;
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  setEcho({ time, feedback, tone, wet }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, tau = 0.03;
    if (time !== undefined)     this.delay.delayTime.setTargetAtTime(time, t, tau);
    if (feedback !== undefined) this.delayFeedback.gain.setTargetAtTime(feedback, t, tau);
    if (tone !== undefined)     this.delayTone.frequency.setTargetAtTime(tone, t, tau);
    if (wet !== undefined)      this.delayWet.gain.setTargetAtTime(wet, t, tau);
  }

  _tapSend(node, sendLevel, dur) {
    if (!sendLevel || sendLevel <= 0) return;
    const sg = this.ctx.createGain();
    sg.gain.value = sendLevel;
    node.connect(sg);
    sg.connect(this.auxInput);
    setTimeout(() => { try { sg.disconnect(); } catch (e) {} }, (dur + 4) * 1000);
  }

  playBass(freq, time, dur, opts) {
    const { volume, pan, decay, sub, wave = 'triangle', tone = 0.4 } = opts; const t = time;
    const osc = this._makeOsc(wave, 0.5);
    osc.frequency.setValueAtTime(freq, t);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(volume, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.05, decay * dur));
    // BASS LANE — lowpass keeps the bottom end in its register; brighter
    // waveforms (saw/square) gain harmonics but never bleed up into the lead.
    // Tone sweeps cutoff 220..2600 Hz; mild Q adds a touch of body.
    const lane = this.ctx.createBiquadFilter();
    lane.type = 'lowpass';
    lane.frequency.value = 220 + tone * tone * 2380;
    lane.Q.value = 0.7;
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = pan;
    osc.connect(gain).connect(lane).connect(panner).connect(this.master);
    osc.start(t); osc.stop(t + dur + 0.1);
    if (sub) {
      const s2 = this.ctx.createOscillator();
      s2.type = 'triangle';
      s2.frequency.setValueAtTime(freq / 2, t);
      const sg = this.ctx.createGain();
      sg.gain.setValueAtTime(0, t);
      sg.gain.linearRampToValueAtTime(volume * 0.4, t + 0.01);
      sg.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.05, decay * dur));
      s2.connect(sg).connect(panner);
      s2.start(t); s2.stop(t + dur + 0.1);
    }
  }

  playDrum(type, time, opts) {
    const { volume, pan, send } = opts; const t = time;
    const isMetal = type === 'hat' || type === 'perc';
    const src = this.ctx.createBufferSource();
    src.buffer = isMetal ? this.metalBuffer : this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = pan;
    let voiceDur = 0.3;
    if (type === 'kick') {
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(180, t);
      filter.frequency.exponentialRampToValueAtTime(60, t + 0.15);
      gain.gain.setValueAtTime(volume * 0.8, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      const thump = this.ctx.createOscillator();
      thump.type = 'triangle';
      thump.frequency.setValueAtTime(140, t);
      thump.frequency.exponentialRampToValueAtTime(40, t + 0.12);
      const tg = this.ctx.createGain();
      tg.gain.setValueAtTime(volume * 1.2, t);
      tg.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      thump.connect(tg).connect(panner);
      thump.start(t); thump.stop(t + 0.2);
      voiceDur = 0.2;
    } else if (type === 'snare') {
      filter.type = 'bandpass'; filter.frequency.value = 1800; filter.Q.value = 0.6;
      gain.gain.setValueAtTime(volume, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
      voiceDur = 0.18;
    } else if (type === 'hat') {
      filter.type = 'highpass'; filter.frequency.value = 6000;
      gain.gain.setValueAtTime(volume * 0.6, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      voiceDur = 0.08;
    } else {
      filter.type = 'bandpass'; filter.frequency.value = 3500; filter.Q.value = 1.5;
      gain.gain.setValueAtTime(volume * 0.7, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      voiceDur = 0.12;
    }
    src.connect(filter).connect(gain).connect(panner).connect(this.master);
    src.start(t); src.stop(t + 0.3);
    this._tapSend(panner, send, voiceDur);
  }

  playLead(freq, time, dur, opts) {
    const { volume, pan, duty, attack, decay, vibrato, vibSpeed, arpNotes, arpSpeed, send, wave = 'pulse', tone = 0.55 } = opts;
    const t = time;
    const osc = this._makeOsc(wave, duty);
    if (arpNotes && arpNotes.length > 1) {
      const step = 1 / arpSpeed;
      for (let i = 0; i < Math.floor(dur / step) + 1; i++) {
        const semi = arpNotes[i % arpNotes.length];
        osc.frequency.setValueAtTime(freq * Math.pow(2, semi / 12), t + i * step);
      }
    } else osc.frequency.setValueAtTime(freq, t);
    if (vibrato > 0) {
      const lfo = this.ctx.createOscillator();
      const lg = this.ctx.createGain();
      lfo.frequency.value = vibSpeed;
      lg.gain.value = vibrato * freq * 0.05;
      lfo.connect(lg).connect(osc.frequency);
      lfo.start(t); lfo.stop(t + dur + 0.05);
    }
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(volume, t + Math.max(0.001, attack));
    gain.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.02, attack + decay * dur));
    // LEAD LANE — highpass clears the bass register so the lead never muds up
    // the low end; a tone-swept lowpass tames the very top. Lead cuts through
    // in the mids/highs no matter which waveform is chosen.
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 300; hp.Q.value = 0.5;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 1800 + tone * tone * 9200; lp.Q.value = 0.6;
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = pan;
    osc.connect(gain).connect(hp).connect(lp).connect(panner).connect(this.master);
    osc.start(t); osc.stop(t + dur + 0.1);
    this._tapSend(panner, send, dur + 0.5);
  }

  playPad(freq, time, dur, opts) {
    const { volume, pan, duty, detune, attack, release, chord, send, wave = 'pulse', tone = 0.5 } = opts;
    const t = time;
    const chordOffsets = {
      'Single': [0], 'Octave': [0, 12], 'Fifth': [0, 7], 'Triad': [0, 4, 7], 'Minor': [0, 3, 7],
    }[chord] || [0];
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = pan;
    // PAD LANE — a gentle mid band (highpass off the sub, tone-swept lowpass off
    // the highs) parks the pad as a cushion behind bass and lead. Softer Q than
    // the lead so chords stay smooth rather than resonant.
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 200; hp.Q.value = 0.4;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 1200 + tone * tone * 5000; lp.Q.value = 0.5;
    panner.connect(hp); hp.connect(lp); lp.connect(this.master);
    chordOffsets.forEach((semi) => {
      [-1, 1].forEach((sign) => {
        const osc = this._makeOsc(wave, duty);
        osc.frequency.setValueAtTime(freq * Math.pow(2, semi / 12), t);
        osc.detune.value = sign * detune * 12;
        const gain = this.ctx.createGain();
        const v = volume / Math.max(1, chordOffsets.length) * 0.7;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(v, t + Math.max(0.005, attack));
        gain.gain.setValueAtTime(v, t + Math.max(0.005, attack) + dur * 0.4);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + dur + release);
        osc.connect(gain).connect(panner);
        osc.start(t); osc.stop(t + dur + release + 0.05);
      });
    });
    this._tapSend(panner, send, dur + release + 0.5);
  }

  // ----- SAMPLER (pitched one-shot via playbackRate) -----
  playSample(buffer, time, dur, opts) {
    if (!buffer) return;
    const { volume, pan, semitones } = opts; const t = time;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = Math.pow(2, (semitones || 0) / 12);
    const gain = this.ctx.createGain();
    const end = t + Math.max(0.05, dur);
    gain.gain.setValueAtTime(volume, t);
    gain.gain.setValueAtTime(volume, end);
    gain.gain.linearRampToValueAtTime(0.0001, end + 0.02);
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = pan || 0;
    src.connect(gain).connect(panner).connect(this.master);
    src.start(t);
    src.stop(end + 0.05);
  }

  // ----- YUCCA-FX PRESET VOICE -----
  // A trimmed port of YUCCA-FX's buildSound: renders a patch (osc + ADSR +
  // filter + LFO + drive + delay/reverb) live at a target MIDI note, so a
  // sampler slot can hold a parametric preset instead of a fixed buffer. The
  // sequencer drives note pitch via `note`; the patch's own duration/envelope
  // shape each hit. FX tails are capped so dense patterns stay mobile-friendly.
  playPatch(patch, note, time, dur, opts) {
    if (!patch || !patch.osc) return;
    const ctx = this.ctx;
    const { volume = 0.8, pan = 0, send = 0 } = opts || {};
    const now = time;
    const cl = (v, a, b) => Math.max(a, Math.min(b, v));
    const amp = patch.amp || { attack: 0.005, decay: 0.1, sustain: 0.6, release: 0.15 };
    const a = Math.max(0.001, amp.attack);
    const d = Math.max(0.001, amp.decay);
    const r = Math.max(0.001, amp.release);
    const sus = Math.max(0.0001, amp.sustain);
    // play for at least the note length; patches with short duration still ring their release
    const playDur = Math.max(0.02, Math.max(dur, patch.duration || 0.2));
    const dl = patch.delay || { mix: 0, time: 0.12, feedback: 0.3 };
    const rv = patch.reverb || { mix: 0, size: 0.3 };
    const reverbTail = rv.mix > 0.001 ? Math.min(2.2, 1.2 + rv.size * 1.4) : 0;
    const delayTail = dl.mix > 0.001 ? Math.min(2.5, dl.time * 8) : 0;
    const totalLen = playDur + r + Math.max(reverbTail, delayTail) + 0.1;

    const ampGain = ctx.createGain();
    ampGain.gain.setValueAtTime(0.0001, now);
    ampGain.gain.linearRampToValueAtTime(volume, now + a);
    ampGain.gain.linearRampToValueAtTime(sus * volume, now + a + d);
    const relStart = Math.max(now + a + d, now + playDur);
    ampGain.gain.setValueAtTime(sus * volume, relStart);
    ampGain.gain.exponentialRampToValueAtTime(0.0001, relStart + r);

    const pf = patch.filter || { type: 'lowpass', cutoff: 8000, resonance: 1, envAmount: 0 };
    const filter = ctx.createBiquadFilter();
    filter.type = pf.type || 'lowpass';
    const baseCut = pf.cutoff || 8000;
    filter.frequency.value = baseCut;
    filter.Q.value = pf.resonance || 1;
    if (Math.abs(pf.envAmount || 0) > 0.001) {
      const peak = cl(baseCut * Math.pow(2, pf.envAmount * 4), 40, 18000);
      filter.frequency.setValueAtTime(peak, now);
      filter.frequency.exponentialRampToValueAtTime(Math.max(40, baseCut), now + a + d);
    }

    const baseFreq = NOTE_FREQ(note);
    const pit = patch.pitch || { pitchEnvAmount: 0, pitchEnvTime: 0.1 };
    let osc, freqParam;
    if (patch.osc.type === 'noise') {
      const bufSize = Math.ceil(ctx.sampleRate * totalLen);
      const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
      const data = buf.getChannelData(0);
      let lfsr = 1;
      const period = Math.max(2, Math.floor(ctx.sampleRate / Math.max(40, baseFreq * 4)));
      let counter = 0, bit = 0;
      const tapShort = (patch.osc.duty || 0.5) < 0.3;
      for (let i = 0; i < bufSize; i++) {
        if (counter <= 0) { const tap = tapShort ? 6 : 1; const fb = (lfsr & 1) ^ ((lfsr >> tap) & 1); lfsr = (lfsr >> 1) | (fb << 14); bit = (lfsr & 1) ? 0.7 : -0.7; counter = period; }
        counter--; data[i] = bit;
      }
      osc = ctx.createBufferSource(); osc.buffer = buf; freqParam = osc.playbackRate;
      if (Math.abs(pit.pitchEnvAmount || 0) > 0.01) {
        osc.playbackRate.setValueAtTime(Math.max(0.1, Math.pow(2, pit.pitchEnvAmount / 12)), now);
        osc.playbackRate.exponentialRampToValueAtTime(1, now + Math.max(0.01, pit.pitchEnvTime || 0.1));
      }
    } else {
      osc = ctx.createOscillator();
      if (patch.osc.type === 'pulse') osc.setPeriodicWave(this.pulseWaves[patch.osc.duty] || this._makePulseWave(patch.osc.duty || 0.5));
      else if (patch.osc.type === 'triangle') osc.type = 'triangle';
      else osc.type = 'sawtooth';
      osc.frequency.value = baseFreq; freqParam = osc.frequency;
      if (Math.abs(pit.pitchEnvAmount || 0) > 0.01) {
        osc.frequency.setValueAtTime(cl(baseFreq * Math.pow(2, pit.pitchEnvAmount / 12), 20, 20000), now);
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, baseFreq), now + Math.max(0.01, pit.pitchEnvTime || 0.1));
      }
    }

    const lfo = patch.lfo;
    if (lfo && lfo.depth > 0.001) {
      const l = ctx.createOscillator(); l.type = lfo.waveform || 'sine'; l.frequency.value = Math.max(0.05, lfo.rate || 5);
      const lg = ctx.createGain();
      if (lfo.target === 'pitch') { if (patch.osc.type === 'noise') lg.gain.value = lfo.depth * 0.6; else lg.gain.value = baseFreq * (Math.pow(2, (lfo.depth * 1200) / 1200) - 1); l.connect(lg).connect(freqParam); }
      else if (lfo.target === 'filter') { lg.gain.value = lfo.depth * baseCut * 0.85; l.connect(lg).connect(filter.frequency); }
      else { lg.gain.value = lfo.depth * 0.45; l.connect(lg).connect(ampGain.gain); }
      l.start(now); l.stop(now + totalLen);
    }

    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    // out gain with a hard ceiling (drive can't break the volume guard)
    const out = ctx.createGain();
    out.gain.value = 0.7;
    let preFilter = ampGain;
    // optional drive
    const drive = patch.drive || 0;
    if (drive > 0.001) {
      const shaper = ctx.createWaveShaper();
      const k = drive * 60, n = 2048, curve = new Float32Array(n);
      for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = (1 + k) * x / (1 + k * Math.abs(x)); }
      shaper.curve = curve; shaper.oversample = '2x';
      preFilter.connect(filter); filter.connect(shaper); shaper.connect(out);
    } else {
      preFilter.connect(filter); filter.connect(out);
    }
    out.connect(panner); panner.connect(this.master);

    // patch's own delay/reverb (dry by default for tight sequencing)
    if (dl.mix > 0.001) {
      const dnode = ctx.createDelay(2); dnode.delayTime.value = Math.max(0.005, dl.time);
      const fb = ctx.createGain(); fb.gain.value = Math.min(0.85, dl.feedback || 0.3);
      const wet = ctx.createGain(); wet.gain.value = dl.mix;
      out.connect(dnode); dnode.connect(fb); fb.connect(dnode); dnode.connect(wet); wet.connect(panner);
    }
    if (rv.mix > 0.001) {
      const conv = ctx.createConvolver(); conv.buffer = this._patchIR(rv.size || 0.3);
      const wet = ctx.createGain(); wet.gain.value = rv.mix * 0.6;
      out.connect(conv); conv.connect(wet); wet.connect(panner);
    }

    // Wire the source into the amp envelope (osc was built above but not yet
    // connected). Without this the whole patch voice is silent.
    osc.connect(ampGain);
    osc.start(now); osc.stop(now + totalLen);
    this._tapSend(panner, send, totalLen + 0.2);
  }

  // Short impulse response cache for patch reverb.
  _patchIR(size) {
    const key = Math.round(size * 10);
    this._irCache = this._irCache || {};
    if (this._irCache[key]) return this._irCache[key];
    const ctx = this.ctx;
    const len = Math.max(2048, Math.floor(ctx.sampleRate * (0.05 + size * 1.2)));
    const decay = 1.5 + (1 - size) * 4;
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const dd = buf.getChannelData(ch); for (let i = 0; i < len; i++) { const t = i / len, env = Math.pow(1 - t, decay); dd[i] = Math.round((Math.random() * 2 - 1) * env * 7) / 7 * env; } }
    this._irCache[key] = buf;
    return buf;
  }
}

// ============================================================================
// STORAGE ADAPTER — window.storage (Claude artifacts) -> localStorage (your
// own site) -> in-memory. All async; every layer is wrapped so a missing or
// blocked backend never throws.
// ============================================================================
const _mem = new Map();
const Store = {
  async get(key) {
    if (typeof window !== 'undefined' && window.storage) {
      try { const r = await window.storage.get(key); if (r && r.value != null) return r.value; } catch (e) {}
    }
    try { if (typeof localStorage !== 'undefined') { const v = localStorage.getItem(key); if (v != null) return v; } } catch (e) {}
    return _mem.has(key) ? _mem.get(key) : null;
  },
  async set(key, value) {
    let ok = false;
    if (typeof window !== 'undefined' && window.storage) {
      try { await window.storage.set(key, value); ok = true; } catch (e) {}
    }
    if (!ok) { try { if (typeof localStorage !== 'undefined') { localStorage.setItem(key, value); ok = true; } } catch (e) {} }
    _mem.set(key, value);
  },
};

const clone = (o) => JSON.parse(JSON.stringify(o));

// ============================================================================
// CHANNEL MASKING — used by SONG (per-block mutes) and GROOVE (live mute/solo).
// Returns a scheduler source with muted channels emptied out; never mutates the
// stored loop data. `mutes` is { bass,drums,lead,pad,samples } of booleans
// (true = silenced); `solo` is the same shape but inverted (true = the only
// channels that sound). Solo wins over mutes when present.
// ============================================================================
const EMPTY_PATTERN = { kick: [], snare: [], hat: [], perc: [] };
const applyMask = (src, mutes, solo) => {
  if (!mutes && !solo) return src;
  const on = (ch) => (solo ? !!solo[ch] : !mutes[ch]);
  return {
    scaleName: src.scaleName, rootNote: src.rootNote,
    bass: on('bass') ? src.bass : { ...src.bass, notes: [] },
    drums: on('drums') ? src.drums : { ...src.drums, pattern: EMPTY_PATTERN },
    lead: on('lead') ? src.lead : { ...src.lead, notes: [] },
    pad: on('pad') ? src.pad : { ...src.pad, notes: [] },
    samples: !src.samples ? src.samples : (on('samples') ? src.samples : { ...src.samples, slots: src.samples.slots.map((s) => ({ ...s, notes: [] })) }),
  };
};
// Which channels of a loop snapshot actually carry playable content — drives
// which mute/solo chips a GROOVE scene row shows.
const channelsWithContent = (d) => ({
  bass: !!d.bass?.notes?.length,
  drums: !!d.drums?.pattern && Object.values(d.drums.pattern).some((row) => row.some(Boolean)),
  lead: !!d.lead?.notes?.length,
  pad: !!d.pad?.notes?.length,
  samples: !!d.samples?.slots?.some((s) => s.notes?.length),
});
const maskHasAny = (m) => !!m && Object.values(m).some(Boolean);

// ============================================================================
// COLORS
// ============================================================================
const COLORS = {
  bass: '#ff5544', drums: '#ffaa22', lead: '#7fff7f', pad: '#66bbff',
  echo: '#ff66cc', song: '#c9a0ff', samples: '#34e0c4', cream: '#f5ecd3',
};
const PS = '"Press Start 2P", monospace';

// ============================================================================
// FADER  — horizontal fill bar. touch-action: pan-y lets the page scroll on
// vertical drags while horizontal drags adjust the value. Tap to jump.
// ============================================================================
const Fader = ({ label, value, min, max, step = 0.01, onChange, color = COLORS.cream, unit = '', bipolar = false }) => {
  const trackRef = useRef(null);
  const drag = useRef(null);
  const range = max - min;
  const valFromX = (clientX) => {
    const r = trackRef.current.getBoundingClientRect();
    let n = (clientX - r.left) / r.width;
    n = Math.max(0, Math.min(1, n));
    let v = min + n * range;
    v = step >= 1 ? Math.round(v) : Math.round(v / step) * step;
    return Math.max(min, Math.min(max, v));
  };
  const onPointerDown = (e) => { drag.current = { startX: e.clientX, startY: e.clientY, decided: false, id: e.pointerId }; };
  const onPointerMove = (e) => {
    const d = drag.current; if (!d) return;
    if (!d.decided) {
      const dx = Math.abs(e.clientX - d.startX), dy = Math.abs(e.clientY - d.startY);
      if (dx > 4 && dx >= dy) { d.decided = 'adj'; try { e.currentTarget.setPointerCapture(d.id); } catch (err) {} }
      else if (dy > 4) { d.decided = 'scroll'; return; }
      else return;
    }
    if (d.decided === 'adj') onChange(valFromX(e.clientX));
  };
  const onPointerUp = (e) => { const d = drag.current; if (d && !d.decided) onChange(valFromX(e.clientX)); drag.current = null; };
  const norm = (value - min) / range;
  const display = step >= 1 ? Math.round(value).toString() : value.toFixed(2);
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <div className="flex items-center justify-between">
        <span className="text-[8px] uppercase tracking-wider text-stone-400" style={{ fontFamily: PS }}>{label}</span>
        <span className="text-[12px] tabular-nums leading-none" style={{ fontFamily: 'VT323, monospace', color }}>{display}{unit}</span>
      </div>
      <div ref={trackRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
        onPointerCancel={() => { drag.current = null; }}
        className="relative h-7 rounded-md overflow-hidden cursor-pointer"
        style={{ touchAction: 'pan-y', background: '#0a0a0f', border: '1px solid #2a2a35', boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.6)' }}>
        {bipolar ? (
          <>
            <div className="absolute top-0 bottom-0" style={{ left: '50%', width: '1px', background: '#3a3a45' }} />
            <div className="absolute top-0 bottom-0" style={{ left: norm >= 0.5 ? '50%' : `${norm * 100}%`, width: `${Math.abs(norm - 0.5) * 100}%`, background: `linear-gradient(90deg, ${color}aa, ${color})`, boxShadow: `0 0 8px ${color}66` }} />
          </>
        ) : (
          <div className="absolute top-0 bottom-0 left-0" style={{ width: `${norm * 100}%`, background: `linear-gradient(90deg, ${color}88, ${color})`, boxShadow: `0 0 8px ${color}66` }} />
        )}
        <div className="absolute inset-0 flex justify-between px-1 pointer-events-none opacity-30">
          {Array.from({ length: 5 }).map((_, i) => (<div key={i} style={{ width: '1px', background: '#fff' }} />))}
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// STEPPER  — big +/- for small integer ranges
// ============================================================================
const Stepper = ({ label, value, min, max, onChange, color = COLORS.cream, fmt = (v) => v }) => (
  <div className="flex flex-col gap-1">
    <span className="text-[8px] uppercase tracking-wider text-stone-400 text-center" style={{ fontFamily: PS }}>{label}</span>
    <div className="flex items-stretch h-7 rounded-md overflow-hidden" style={{ border: '1px solid #2a2a35', background: '#0a0a0f' }}>
      <button onClick={() => onChange(Math.max(min, value - 1))} className="w-7 flex items-center justify-center active:opacity-60" style={{ color, fontFamily: PS, fontSize: '12px', touchAction: 'manipulation' }}>−</button>
      <div className="flex-1 flex items-center justify-center px-2 tabular-nums" style={{ fontFamily: 'VT323, monospace', color, fontSize: '14px', borderLeft: '1px solid #1a1a22', borderRight: '1px solid #1a1a22' }}>{fmt(value)}</div>
      <button onClick={() => onChange(Math.min(max, value + 1))} className="w-7 flex items-center justify-center active:opacity-60" style={{ color, fontFamily: PS, fontSize: '12px', touchAction: 'manipulation' }}>+</button>
    </div>
  </div>
);

// ============================================================================
// CHANNEL CHIP — GROOVE per-instrument mute/solo button. Tap = mute, hold =
// solo (long-press ~450ms). touch-action: manipulation so a tap doesn't get
// eaten by the page; the press timer distinguishes the two gestures.
// ============================================================================
const ChannelChip = ({ label, color, soloed, dim, onMute, onSolo }) => {
  const timer = useRef(null);
  const longed = useRef(false);
  const down = () => { longed.current = false; if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => { longed.current = true; onSolo(); }, 450); };
  const up = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } if (!longed.current) onMute(); };
  const cancel = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  return (
    <button onPointerDown={down} onPointerUp={up} onPointerLeave={cancel} onContextMenu={(e) => e.preventDefault()}
      className="flex-1 py-1.5 rounded-[3px] active:translate-y-px select-none"
      style={{ fontFamily: PS, fontSize: '8px', letterSpacing: '0.05em',
        background: soloed ? color : dim ? '#0a0a0f' : `${color}22`,
        color: soloed ? '#0a0a0f' : dim ? '#555' : color,
        border: `1px solid ${soloed ? color : dim ? '#2a2a35' : color + '66'}`,
        boxShadow: soloed ? `0 0 8px ${color}80` : 'none',
        opacity: dim ? 0.55 : 1, touchAction: 'manipulation' }}
      title={`${label} — tap mute · hold solo`}>
      {label}
    </button>
  );
};

// ============================================================================
// TOGGLE  — segmented button group
// ============================================================================
const Toggle = ({ label, value, options, onChange, color = COLORS.cream }) => (
  <div className="flex flex-col gap-1 min-w-0">
    {label && <span className="text-[8px] uppercase tracking-wider text-stone-400" style={{ fontFamily: PS }}>{label}</span>}
    <div className="flex gap-0.5 bg-black/40 p-0.5 border border-stone-800 rounded-md">
      {options.map((opt) => {
        const v = opt.value ?? opt; const active = v === value;
        return (
          <button key={v} onClick={() => onChange(v)} className="flex-1 px-1.5 py-1.5 text-[9px] uppercase transition-all rounded-[3px]"
            style={{ fontFamily: PS, background: active ? color : 'transparent', color: active ? '#0a0a0f' : '#999', boxShadow: active ? `0 0 8px ${color}80` : 'none', touchAction: 'manipulation' }}>
            {opt.label ?? opt}
          </button>
        );
      })}
    </div>
  </div>
);

// ============================================================================
// PIANO ROLL  — scale-collapsed rows, one-swipe entry, velocity smear, inspect
// ============================================================================
let _id = 0;
const uid = () => `n${++_id}`;
const STEPS = 16;
const ROW_H = 30;

const PianoRoll = ({ notes, onChange, rowCount, rowLabel, isRoot, color, currentStep, mode, brush, onSelect, selectedId }) => {
  const gridRef = useRef(null);
  const drag = useRef(null);
  const colFromX = (x) => { const r = gridRef.current.getBoundingClientRect(); return Math.max(0, Math.min(STEPS - 1, Math.floor((x - r.left) / (r.width / STEPS)))); };
  const rowFromY = (y) => { const r = gridRef.current.getBoundingClientRect(); const fromTop = Math.floor((y - r.top) / (r.height / rowCount)); return Math.max(0, Math.min(rowCount - 1, (rowCount - 1) - fromTop)); };
  const veloFromY = (y) => { const r = gridRef.current.getBoundingClientRect(); let n = 1 - (y - r.top) / r.height; return Math.max(0.05, Math.min(1, n)); };
  const noteAt = (col, row) => notes.find((n) => n.pitch === row && col >= n.start && col < n.start + n.length);

  const onPointerDown = (e) => {
    const col = colFromX(e.clientX), row = rowFromY(e.clientY), id = e.pointerId;
    if (mode === 'erase') {
      try { e.currentTarget.setPointerCapture(id); } catch (err) {}
      const hit = noteAt(col, row);
      if (hit) onChange((ns) => ns.filter((n) => n.id !== hit.id));
      drag.current = { kind: 'erase', id }; return;
    }
    if (mode === 'velo') {
      try { e.currentTarget.setPointerCapture(id); } catch (err) {}
      const v = veloFromY(e.clientY);
      onChange((ns) => ns.map((n) => (col >= n.start && col < n.start + n.length) ? { ...n, velocity: v } : n));
      drag.current = { kind: 'velo', id }; return;
    }
    const hit = noteAt(col, row);
    drag.current = { kind: hit ? 'note' : 'new', id, startX: e.clientX, startY: e.clientY, col, row, decided: false, target: hit ? hit.id : null, created: null };
  };

  const onPointerMove = (e) => {
    const d = drag.current; if (!d) return;
    if (d.kind === 'erase') { const hit = noteAt(colFromX(e.clientX), rowFromY(e.clientY)); if (hit) onChange((ns) => ns.filter((n) => n.id !== hit.id)); return; }
    if (d.kind === 'velo') { const col = colFromX(e.clientX); const v = veloFromY(e.clientY); onChange((ns) => ns.map((n) => (col >= n.start && col < n.start + n.length) ? { ...n, velocity: v } : n)); return; }
    if (!d.decided) {
      const dx = Math.abs(e.clientX - d.startX), dy = Math.abs(e.clientY - d.startY);
      if (dx > 8 && dx >= dy) {
        d.decided = 'draw';
        try { e.currentTarget.setPointerCapture(d.id); } catch (err) {}
        if (d.kind === 'new') { const newId = uid(); d.created = newId; const note = { id: newId, start: d.col, length: 1, pitch: d.row, velocity: brush.velocity }; onChange((ns) => [...ns, note]); }
      } else if (dy > 8) { d.decided = 'scroll'; return; } else return;
    }
    if (d.decided === 'draw') {
      const col = colFromX(e.clientX);
      if (d.kind === 'new' && d.created) { const len = Math.max(1, Math.min(STEPS - d.col, col - d.col + 1)); onChange((ns) => ns.map((n) => n.id === d.created ? { ...n, length: len } : n)); }
      else if (d.kind === 'note' && d.target) { onChange((ns) => ns.map((n) => { if (n.id !== d.target) return n; const len = Math.max(1, Math.min(STEPS - n.start, col - n.start + 1)); return { ...n, length: len }; })); }
    }
  };

  const onPointerUp = (e) => {
    const d = drag.current; if (!d) return;
    if ((d.kind === 'new' || d.kind === 'note') && !d.decided) {
      if (d.kind === 'new') { const len = Math.max(1, Math.min(STEPS - d.col, brush.length)); const note = { id: uid(), start: d.col, length: len, pitch: d.row, velocity: brush.velocity }; onChange((ns) => [...ns, note]); }
      else if (d.target) onSelect(d.target);
    }
    drag.current = null;
  };

  const touchAction = mode === 'draw' ? 'pan-y' : 'none';
  return (
    <div className="flex select-none" style={{ touchAction }}>
      <div className="flex flex-col" style={{ width: 34 }}>
        {Array.from({ length: rowCount }).map((_, i) => {
          const rowIndex = (rowCount - 1) - i; const root = isRoot(rowIndex);
          return (
            <div key={i} className="flex items-center justify-end pr-1.5" style={{ height: ROW_H, fontFamily: 'VT323, monospace', fontSize: '11px', color: root ? color : '#666', borderTop: '1px solid #15151c', background: root ? `${color}12` : 'transparent' }}>{rowLabel(rowIndex)}</div>
          );
        })}
      </div>
      <div ref={gridRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => { drag.current = null; }}
        className="relative flex-1 rounded-r-md overflow-hidden" style={{ height: rowCount * ROW_H, background: '#0b0b10', border: '1px solid #1f1f29', touchAction }}>
        {Array.from({ length: rowCount }).map((_, i) => { const rowIndex = (rowCount - 1) - i; return (<div key={i} className="absolute left-0 right-0" style={{ top: i * ROW_H, height: ROW_H, borderTop: '1px solid #15151c', background: isRoot(rowIndex) ? `${color}0a` : 'transparent' }} />); })}
        {Array.from({ length: STEPS }).map((_, i) => (<div key={i} className="absolute top-0 bottom-0" style={{ left: `${(i / STEPS) * 100}%`, width: '1px', background: i % 4 === 0 ? '#2a2a35' : '#16161d' }} />))}
        {currentStep >= 0 && (<div className="absolute top-0 bottom-0 pointer-events-none" style={{ left: `${(currentStep / STEPS) * 100}%`, width: `${(1 / STEPS) * 100}%`, background: 'rgba(255,255,255,0.08)', borderLeft: '1px solid rgba(255,255,255,0.3)' }} />)}
        {notes.map((n) => {
          const fromTop = (rowCount - 1) - n.pitch; const selected = n.id === selectedId;
          return (
            <div key={n.id} className="absolute rounded-[3px] overflow-hidden" style={{ left: `${(n.start / STEPS) * 100}%`, width: `${(n.length / STEPS) * 100}%`, top: fromTop * ROW_H + 2, height: ROW_H - 4, background: `${color}33`, border: `1.5px solid ${selected ? '#fff' : color}`, boxShadow: selected ? `0 0 10px ${color}` : `0 0 4px ${color}55`, pointerEvents: 'none' }}>
              <div className="absolute left-0 right-0 bottom-0" style={{ height: `${n.velocity * 100}%`, background: color, opacity: 0.55 }} />
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ============================================================================
// NOTE INSPECTOR
// ============================================================================
const NoteInspector = ({ note, color, rowCount, pitchLabel, onChange, onDelete, onClose }) => {
  if (!note) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 p-3" style={{ animation: 'slideUp 160ms ease-out' }}>
      <div className="max-w-[1400px] mx-auto rounded-xl p-4" style={{ background: 'linear-gradient(180deg, #1a1418, #0d0a0f)', border: `2px solid ${color}55`, boxShadow: `0 -10px 40px rgba(0,0,0,0.6), 0 0 24px ${color}22` }}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Music size={14} style={{ color }} />
            <span className="text-[11px] tracking-widest" style={{ fontFamily: PS, color }}>NOTE</span>
            <span className="text-[16px]" style={{ fontFamily: 'VT323, monospace', color: COLORS.cream }}>{pitchLabel(note.pitch)}</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onDelete} className="flex items-center gap-1 px-3 py-1.5 rounded-md active:opacity-60" style={{ background: '#3a1a1a', border: '1px solid #ff554455', color: '#ff8877', fontFamily: PS, fontSize: '9px', touchAction: 'manipulation' }}><Trash2 size={11} /> DEL</button>
            <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-md active:opacity-60" style={{ background: '#1a1a22', border: '1px solid #3a3a45', color: COLORS.cream, touchAction: 'manipulation' }}><X size={14} /></button>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <Fader label="Velocity" value={note.velocity} min={0.05} max={1} onChange={(v) => onChange({ ...note, velocity: v })} color={color} />
          <Stepper label="Length" value={note.length} min={1} max={STEPS - note.start} onChange={(v) => onChange({ ...note, length: v })} color={color} fmt={(v) => `${v} st`} />
          <Stepper label="Pitch" value={note.pitch} min={0} max={rowCount - 1} onChange={(v) => onChange({ ...note, pitch: v })} color={color} fmt={(v) => pitchLabel(v)} />
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// DRUM SEQUENCER
// ============================================================================
const DrumSeq = ({ pattern, currentStep, onCellChange, color }) => {
  const rows = [{ key: 'kick', label: 'KCK' }, { key: 'snare', label: 'SNR' }, { key: 'hat', label: 'HAT' }, { key: 'perc', label: 'PRC' }];
  return (
    <div className="bg-black/60 p-1.5 border border-stone-800 rounded-md space-y-1">
      {rows.map((row) => (
        <div key={row.key} className="grid items-center gap-0.5" style={{ gridTemplateColumns: '34px repeat(16, minmax(0, 1fr))' }}>
          <div className="text-[8px] text-stone-400 px-1" style={{ fontFamily: PS }}>{row.label}</div>
          {pattern[row.key].map((on, i) => {
            const isBeat = i % 4 === 0, isCur = i === currentStep;
            return (<button key={i} onClick={() => onCellChange(row.key, i, !on)} className="h-8 rounded-[3px] transition-all" style={{ background: on ? color : (isBeat ? '#1a1a22' : '#0d0d12'), border: `1px solid ${isCur ? color : isBeat ? '#2a2a35' : '#1a1a22'}`, boxShadow: on ? `0 0 6px ${color}80, inset 0 1px 0 ${color}` : (isCur ? `0 0 8px ${color}` : 'none'), touchAction: 'manipulation' }} />);
          })}
        </div>
      ))}
    </div>
  );
};

// ============================================================================
// DEFAULT PATTERNS
// ============================================================================
const defBass = [
  { id: uid(), start: 0, length: 2, pitch: 0, velocity: 0.85 },
  { id: uid(), start: 4, length: 2, pitch: 0, velocity: 0.8 },
  { id: uid(), start: 8, length: 2, pitch: 2, velocity: 0.85 },
  { id: uid(), start: 12, length: 1, pitch: 0, velocity: 0.8 },
  { id: uid(), start: 14, length: 2, pitch: 4, velocity: 0.75 },
];
const defLead = [
  { id: uid(), start: 0, length: 1, pitch: 3, velocity: 0.8 },
  { id: uid(), start: 2, length: 1, pitch: 4, velocity: 0.7 },
  { id: uid(), start: 4, length: 2, pitch: 5, velocity: 0.95 },
  { id: uid(), start: 6, length: 1, pitch: 3, velocity: 0.7 },
  { id: uid(), start: 8, length: 1, pitch: 4, velocity: 0.8 },
  { id: uid(), start: 10, length: 1, pitch: 5, velocity: 0.85 },
  { id: uid(), start: 12, length: 2, pitch: 4, velocity: 0.8 },
  { id: uid(), start: 14, length: 1, pitch: 5, velocity: 0.75 },
];
const defPad = [
  { id: uid(), start: 0, length: 8, pitch: 0, velocity: 0.6 },
  { id: uid(), start: 8, length: 8, pitch: 2, velocity: 0.6 },
];
const defDrums = {
  kick:  [1,0,0,0, 0,0,1,0, 0,0,0,0, 1,0,0,0].map(Boolean),
  snare: [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0].map(Boolean),
  hat:   [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,1].map(Boolean),
  perc:  [0,0,0,0, 0,0,0,0, 0,0,0,1, 0,0,0,0].map(Boolean),
};

const ECHO_TIMES = { '1/16': 1/16, '1/8': 1/8, '1/8.': 3/16, '1/4': 1/4 };

// Waveform palette shared by bass / lead / pad. Each voice still filters into
// its own frequency lane, so picking any of these only changes timbre — not the
// instrument's register. PULSE additionally respects the Duty toggle.
const WAVE_OPTS = [
  { value: 'triangle', label: 'TRI' },
  { value: 'sawtooth', label: 'SAW' },
  { value: 'square', label: 'SQR' },
  { value: 'pulse', label: 'PUL' },
];

// ============================================================================
// MAIN
// ============================================================================
export default function ChiptuneWorkstation() {
  const engineRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [bpm, setBpm] = useState(132);
  const [masterVol, setMasterVol] = useState(0.7);
  const [swing, setSwing] = useState(0);
  const [rootNote, setRootNote] = useState(45);
  const [scaleName, setScaleName] = useState('Minor Pent');
  const [currentStep, setCurrentStep] = useState(-1);

  const [mode, setMode] = useState('loop');          // 'loop' | 'song'
  const [tab, setTab] = useState('lead');
  const [editMode, setEditMode] = useState('draw');
  const [brush, setBrush] = useState({ length: 1, velocity: 0.8 });
  const [selected, setSelected] = useState(null);

  const [echo, setEcho] = useState({ timeMode: '1/8.', feedback: 0.4, tone: 2200, wet: 0.55 });

  const [bass, setBass] = useState({ volume: 0.6, pan: 0, decay: 0.7, sub: false, octave: -1, wave: 'triangle', tone: 0.4, notes: defBass });
  const [drums, setDrums] = useState({ volume: 0.7, pan: 0, sendSnare: 0.35, sendHat: 0.15, pattern: defDrums });
  const [lead, setLead] = useState({ volume: 0.5, pan: 0.15, duty: 0.25, decay: 0.6, vibrato: 0, vibSpeed: 6, arpMode: 'Off', arpSpeed: 16, octave: 1, send: 0.5, wave: 'pulse', tone: 0.55, notes: defLead });
  const [pad, setPad] = useState({ volume: 0.4, pan: -0.15, duty: 0.5, detune: 8, attack: 0.08, release: 0.6, chord: 'Fifth', octave: 0, send: 0.3, wave: 'pulse', tone: 0.5, notes: defPad });

  // Sampler: 4 slots. Buffers live in a ref (AudioBuffers aren't serializable);
  // state holds only metadata + per-slot notes so loops can be snapshotted.
  const sampleBuffersRef = useRef([null, null, null, null]);
  // srcId currently decoded into each buffer slot — lets us skip redundant
  // re-decodes when a loop recall / rehydrate points at the same library record.
  const sampleSrcRef = useRef([null, null, null, null]);
  // A slot is either a PCM buffer (kind:'buffer', audio in sampleBuffersRef +
  // srcId in the shared library) or a YUCCA-FX preset (kind:'patch', patch JSON
  // rendered live per note). Patch slots are fully serializable, so they need no
  // IndexedDB rehydration — they travel inside the saved project as-is.
  const [samples, setSamples] = useState(() => ({ masterVol: 0.8, activeSlot: 0, slots: [0, 1, 2, 3].map(() => ({ name: '', loaded: false, kind: 'buffer', volume: 0.8, pitch: 0, srcId: null, patch: null, notes: [] })) }));

  // "From YUCCA-FX" library browser: which slot it targets, + the listed records.
  const [fxBrowser, setFxBrowser] = useState(null); // slot index | null
  const [fxTab, setFxTab] = useState('samples');    // 'samples' | 'presets'
  const [fxList, setFxList] = useState([]);          // YuccaSamples (blobs)
  const [fxPresets, setFxPresets] = useState([]);    // YuccaPresets (patch JSON)

  // ---- Song / library state ----
  const [library, setLibrary] = useState([]);        // [{ id, name, data }]
  const [arrangement, setArrangement] = useState([]); // [{ id, loopId, repeats }]
  const [activeBlock, setActiveBlock] = useState(-1);
  const [activeBar, setActiveBar] = useState(0);

  // ---- GROOVE (live scene launcher) ----
  // launchMode: when a queued scene fires ('1/4'|'1/2'|'bar'|'end').
  // phaseLock: keep the global step counter running across scene swaps so
  // everything stays phase-aligned (the seamless mode); off = restart pattern.
  const [groove, setGroove] = useState({ launchMode: 'bar', phaseLock: true });
  const [grooveActive, setGrooveActive] = useState(null);  // sounding loopId (mirrors cursor)
  const [grooveQueued, setGrooveQueued] = useState(null);  // armed loopId (mirrors cursor)
  const [grooveMutes, setGrooveMutes] = useState({});      // { [loopId]: {bass,drums,lead,pad,samples} }
  const [grooveSolo, setGrooveSolo] = useState(null);      // live global solo mask | null
  const [captureBars, setCaptureBars] = useState(8);
  const [naming, setNaming] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [storageReady, setStorageReady] = useState(false);

  // ---- Projects + undo/redo ----
  const [projects, setProjects] = useState([]);            // [{ id, name, savedAt, data }]
  const [currentProject, setCurrentProject] = useState({ id: null, name: 'UNTITLED' });
  const [projOpen, setProjOpen] = useState(false);         // project panel sheet
  const [projDraft, setProjDraft] = useState('');
  const [histVer, setHistVer] = useState(0);               // bump to re-render undo/redo buttons
  const histRef = useRef({ stack: [], idx: -1, applying: false, timer: null });
  const autosaveTimer = useRef(null);

  // ---- Confirm dialog + toast feedback ----
  const [confirmCfg, setConfirmCfg] = useState(null);      // { title, message, confirmLabel, accent, onConfirm }
  const [toast, setToast] = useState(null);                // { msg, color }
  const toastTimer = useRef(null);
  // Brief on-screen confirmation that an action ran. Mirrors YUCCA-FX's flash().
  const flash = useCallback((msg, color = COLORS.lead) => {
    setToast({ msg, color });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1600);
  }, []);
  // Gate a destructive action behind a confirm sheet. Pass `skip` to run it
  // directly (e.g. when there's nothing to lose).
  const requestConfirm = useCallback((cfg) => {
    if (cfg.skip) { cfg.onConfirm && cfg.onConfirm(); return; }
    setConfirmCfg(cfg);
  }, []);

  // ---- Unsaved-changes tracking ----
  // We compare the live project against the last-saved baseline so load/new only
  // prompt when there's actually work to lose.
  const savedBaseline = useRef(null);                      // JSON string of last saved/loaded project
  const [dirty, setDirty] = useState(false);

  const noteSetters = { bass: setBass, lead: setLead, pad: setPad };
  const updateNotes = (key, fn) => noteSetters[key]((prev) => ({ ...prev, notes: fn(prev.notes) }));
  const updateSampleNotes = (fn) => setSamples((s) => ({ ...s, slots: s.slots.map((sl, i) => i === s.activeSlot ? { ...sl, notes: fn(sl.notes) } : sl) }));
  // Route a note edit to the right updater — the sampler keeps its notes inside
  // the active slot, not in a top-level channel object, so it needs its own path.
  const updateChannelNotes = (channel, fn) => (channel === 'samples' ? updateSampleNotes(fn) : updateNotes(channel, fn));

  const initEngine = useCallback(() => {
    if (!engineRef.current) { engineRef.current = new NESEngine(); engineRef.current.init(); setReady(true); }
    else engineRef.current.resume();
  }, []);

  useEffect(() => { if (engineRef.current?.master) engineRef.current.master.gain.setValueAtTime(masterVol, engineRef.current.ctx.currentTime); }, [masterVol]);

  // Loop-mode echo -> engine
  useEffect(() => {
    if (!engineRef.current?.auxInput || mode !== 'loop') return;
    const fr = ECHO_TIMES[echo.timeMode] ?? 3/16;
    engineRef.current.setEcho({ time: (60 / bpm) * 4 * fr, feedback: echo.feedback, tone: echo.tone, wet: echo.wet });
  }, [echo, bpm, ready, mode]);

  // Song-mode echo -> engine, applied when the active block changes
  useEffect(() => {
    if (mode !== 'song' || activeBlock < 0 || !engineRef.current) return;
    const block = arrangement[activeBlock]; if (!block) return;
    const loop = library.find((l) => l.id === block.loopId)?.data; if (!loop?.echo) return;
    const fr = ECHO_TIMES[loop.echo.timeMode] ?? 3/16;
    engineRef.current.setEcho({ time: (60 / bpm) * 4 * fr, feedback: loop.echo.feedback, tone: loop.echo.tone, wet: loop.echo.wet });
  }, [activeBlock, mode, bpm]); // eslint-disable-line

  // A full project snapshot — everything needed to reopen exactly where you
  // left off. Sampler AudioBuffers aren't serializable, but buffer slots carry a
  // srcId (rehydrated from the shared library) and patch slots are pure JSON, so
  // the whole working state round-trips.
  const projectData = () => clone({
    bpm, masterVol, swing, rootNote, scaleName, mode, tab,
    bass, drums, lead, pad, samples, echo,
    library, arrangement, groove, grooveMutes,
  });
  // Apply a project snapshot into all the editor state (used by restore + load).
  const applyProject = (d) => {
    if (!d) return;
    if (typeof d.bpm === 'number') setBpm(d.bpm);
    if (typeof d.masterVol === 'number') setMasterVol(d.masterVol);
    if (typeof d.swing === 'number') setSwing(d.swing);
    if (typeof d.rootNote === 'number') setRootNote(d.rootNote);
    if (d.scaleName) setScaleName(d.scaleName);
    if (d.mode) setMode(d.mode);
    if (d.tab) setTab(d.tab);
    if (d.bass) setBass(d.bass);
    if (d.drums) setDrums(d.drums);
    if (d.lead) setLead(d.lead);
    if (d.pad) setPad(d.pad);
    if (d.echo) setEcho(d.echo);
    if (Array.isArray(d.library)) setLibrary(d.library);
    if (Array.isArray(d.arrangement)) setArrangement(d.arrangement);
    if (d.groove) setGroove(d.groove);
    if (d.grooveMutes) setGrooveMutes(d.grooveMutes);
    if (d.samples && Array.isArray(d.samples.slots)) {
      const sm = clone(d.samples);
      sm.slots = sm.slots.map((sl, i) => ({ ...sl, loaded: sl.kind === 'patch' ? !!sl.patch : (!!sampleBuffersRef.current[i] || !!sl.srcId) }));
      setSamples(sm);
      sm.slots.forEach((sl, i) => { if (sl.kind !== 'patch' && sl.srcId) rehydrateSlot(i, sl.srcId); });
    }
    setSelected(null);
  };

  // Restore on mount: full autosaved project first, falling back to the legacy
  // per-key data (library/arrangement/samples) for sessions saved before this.
  useEffect(() => {
    (async () => {
      let restored = false;
      const proj = await Store.get('cw_project');     // autosaved working project
      if (proj) {
        try { const p = JSON.parse(proj); if (p && p.data) { applyProject(p.data); if (p.meta) setCurrentProject(p.meta); restored = true; } } catch (e) {}
      }
      if (!restored) {
        const lib = await Store.get('cw_library');
        const arr = await Store.get('cw_arrangement');
        const smp = await Store.get('cw_samples');
        if (lib) { try { const p = JSON.parse(lib); if (Array.isArray(p)) setLibrary(p); } catch (e) {} }
        if (arr) { try { const p = JSON.parse(arr); if (Array.isArray(p)) setArrangement(p); } catch (e) {} }
        if (smp) { try { const p = JSON.parse(smp); if (p && Array.isArray(p.slots)) { setSamples(p); p.slots.forEach((sl, i) => { if (sl.srcId) rehydrateSlot(i, sl.srcId); }); } } catch (e) {} }
      }
      const pj = await Store.get('cw_projects');       // saved-project bank
      if (pj) { try { const p = JSON.parse(pj); if (Array.isArray(p)) setProjects(p); } catch (e) {} }
      setStorageReady(true);
    })();
  }, []);

  // Content signature for dirty tracking — the musical/structural payload only
  // (which tab is open doesn't count as "unsaved work").
  const contentSig = () => JSON.stringify({ bpm, masterVol, swing, rootNote, scaleName, bass, drums, lead, pad, samples, echo, library, arrangement, groove, grooveMutes });

  // Debounced full-project autosave — fires on any musical/library change so the
  // app reopens exactly as left. Also recomputes the unsaved-changes flag.
  useEffect(() => {
    if (!storageReady) return;
    if (savedBaseline.current === null) savedBaseline.current = contentSig();
    setDirty(contentSig() !== savedBaseline.current);
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      Store.set('cw_project', JSON.stringify({ meta: currentProject, data: projectData() }));
    }, 400);
    return () => { if (autosaveTimer.current) clearTimeout(autosaveTimer.current); };
  }, [bass, drums, lead, pad, samples, echo, library, arrangement, bpm, masterVol, swing, rootNote, scaleName, mode, tab, groove, grooveMutes, currentProject, storageReady]);

  // Persist the saved-project bank.
  useEffect(() => { if (storageReady) Store.set('cw_projects', JSON.stringify(projects)); }, [projects, storageReady]);

  // Stop playback whenever the mode flips, to keep the playhead sane.
  useEffect(() => { setIsPlaying(false); }, [mode]);

  // row math (loop-mode editor)
  const intervals = SCALES[scaleName];
  const rowCount = intervals.length + 1;
  const makeRowLabel = (octave) => (rowIndex) => { const midi = rowToMidiWith(scaleName, rootNote, rowIndex, octave); return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`; };
  const makeIsRoot = (rowIndex) => { const len = intervals.length; const semis = rowIndex < len ? intervals[rowIndex] : 12; return semis % 12 === 0; };

  const stateRef = useRef({});
  stateRef.current = { bass, drums, lead, pad, samples, bpm, swing, scaleName, rootNote, mode, arrangement, library, groove, grooveMutes, grooveSolo };
  const songCursorRef = useRef({ block: 0, bar: 0 });
  // GROOVE playback truth (the scheduler owns these; the rAF loop mirrors
  // active/queued back into state for rendering). globalBar/startBar drive the
  // capture log of what actually played.
  const grooveCursorRef = useRef({ active: null, queued: null, globalBar: 0, startBar: 0 });
  const grooveLogRef = useRef([]); // [{ loopId, bars, mutes }] — fired scene spans

  // ---- Unified scheduler (handles both LOOP and SONG) ----
  useEffect(() => {
    if (!isPlaying || !engineRef.current?.ctx) return;
    const eng = engineRef.current;
    let nextStepTime = eng.ctx.currentTime + 0.05;
    let stepIdx = 0;
    songCursorRef.current = { block: 0, bar: 0 };
    grooveCursorRef.current = { active: grooveActive, queued: grooveQueued, globalBar: 0, startBar: 0 };
    grooveLogRef.current = [];

    const scheduleFrom = (src, idx, t) => {
      const stepDur = 60 / stateRef.current.bpm / 4;
      src.bass.notes.filter((n) => n.start === idx).forEach((n) => {
        eng.playBass(NOTE_FREQ(rowToMidiWith(src.scaleName, src.rootNote, n.pitch, src.bass.octave)), t, stepDur * n.length * 0.95, { volume: src.bass.volume * n.velocity, pan: src.bass.pan, decay: src.bass.decay, sub: src.bass.sub, wave: src.bass.wave, tone: src.bass.tone });
      });
      Object.keys(src.drums.pattern).forEach((row) => {
        if (src.drums.pattern[row][idx]) {
          let send = 0;
          if (row === 'snare') send = src.drums.sendSnare;
          else if (row === 'hat') send = src.drums.sendHat;
          eng.playDrum(row, t, { volume: src.drums.volume, pan: src.drums.pan, send });
        }
      });
      const arpMap = { 'Off': null, 'Up': [0, 4, 7], 'Down': [0, 7, 4], 'Oct': [0, 12], '5th': [0, 7] };
      src.lead.notes.filter((n) => n.start === idx).forEach((n) => {
        eng.playLead(NOTE_FREQ(rowToMidiWith(src.scaleName, src.rootNote, n.pitch, src.lead.octave)), t, stepDur * n.length * 0.9, { volume: src.lead.volume * n.velocity, pan: src.lead.pan, duty: src.lead.duty, attack: 0.005, decay: src.lead.decay, vibrato: src.lead.vibrato, vibSpeed: src.lead.vibSpeed, arpNotes: arpMap[src.lead.arpMode], arpSpeed: src.lead.arpSpeed, send: src.lead.send, wave: src.lead.wave, tone: src.lead.tone });
      });
      src.pad.notes.filter((n) => n.start === idx).forEach((n) => {
        eng.playPad(NOTE_FREQ(rowToMidiWith(src.scaleName, src.rootNote, n.pitch, src.pad.octave)), t, stepDur * n.length, { volume: src.pad.volume * n.velocity, pan: src.pad.pan, duty: src.pad.duty, detune: src.pad.detune, attack: src.pad.attack, release: src.pad.release, chord: src.pad.chord, send: src.pad.send, wave: src.pad.wave, tone: src.pad.tone });
      });
      if (src.samples) {
        src.samples.slots.forEach((slot, si) => {
          if (slot.kind === 'patch') {
            if (!slot.patch) return;
            slot.notes.filter((n) => n.start === idx).forEach((n) => {
              const note = rowToMidiWith(src.scaleName, src.rootNote, n.pitch, 0) + (slot.pitch || 0);
              eng.playPatch(slot.patch, note, t, stepDur * n.length, { volume: src.samples.masterVol * slot.volume * n.velocity, pan: 0 });
            });
            return;
          }
          const buf = sampleBuffersRef.current[si]; if (!buf) return;
          slot.notes.filter((n) => n.start === idx).forEach((n) => {
            const semis = (rowToMidiWith(src.scaleName, src.rootNote, n.pitch, 0) - src.rootNote) + slot.pitch;
            eng.playSample(buf, t, stepDur * n.length, { volume: src.samples.masterVol * slot.volume * n.velocity, pan: 0, semitones: semis });
          });
        });
      }
    };

    // GROOVE launch boundary: which 16th-note steps a queued scene may fire on.
    const grooveBoundary = (idx, m) => m === '1/4' ? (idx % 4 === 0) : m === '1/2' ? (idx % 8 === 0) : (idx === 0);

    const resolveSource = () => {
      const S = stateRef.current;
      if (S.mode === 'song') {
        if (!S.arrangement.length) return null;
        const c = songCursorRef.current;
        const block = S.arrangement[Math.min(c.block, S.arrangement.length - 1)];
        const data = S.library.find((l) => l.id === block.loopId)?.data;
        if (!data) return null;
        return applyMask({ bass: data.bass, drums: data.drums, lead: data.lead, pad: data.pad, samples: data.samples, scaleName: data.scaleName, rootNote: data.rootNote }, block.mutes || null, null);
      }
      if (S.mode === 'groove') {
        const g = grooveCursorRef.current;
        if (g.active == null) return null;
        const data = S.library.find((l) => l.id === g.active)?.data;
        if (!data) return null;
        const mutes = (S.grooveMutes && S.grooveMutes[g.active]) || null;
        return applyMask({ bass: data.bass, drums: data.drums, lead: data.lead, pad: data.pad, samples: data.samples, scaleName: data.scaleName, rootNote: data.rootNote }, mutes, S.grooveSolo || null);
      }
      return { bass: S.bass, drums: S.drums, lead: S.lead, pad: S.pad, samples: S.samples, scaleName: S.scaleName, rootNote: S.rootNote };
    };

    const interval = setInterval(() => {
      const lookAhead = 0.1;
      while (nextStepTime < eng.ctx.currentTime + lookAhead) {
        const S = stateRef.current;
        // GROOVE: promote a queued scene at the launch boundary. Phase-locked by
        // default — we just repoint the source and let the running step counter
        // carry on, so the swap stays in phase. Phase-lock off restarts the bar.
        if (S.mode === 'groove') {
          const g = grooveCursorRef.current;
          if (g.queued != null && grooveBoundary(stepIdx, S.groove.launchMode)) {
            if (g.active != null && g.globalBar > g.startBar) {
              grooveLogRef.current.push({ loopId: g.active, bars: g.globalBar - g.startBar, mutes: (S.grooveMutes && S.grooveMutes[g.active]) ? clone(S.grooveMutes[g.active]) : null });
            }
            g.active = g.queued; g.queued = null; g.startBar = g.globalBar;
            if (!S.groove.phaseLock) stepIdx = 0;
          }
        }
        const src = resolveSource();
        if (src) scheduleFrom(src, stepIdx, nextStepTime);
        const stepDur = 60 / S.bpm / 4;
        const swingAmt = (stepIdx % 2 === 1) ? S.swing * stepDur * 0.5 : 0;
        nextStepTime += stepDur + swingAmt;
        stepIdx = (stepIdx + 1) % 16;
        if (stepIdx === 0) {
          if (S.mode === 'song' && S.arrangement.length) {
            const c = songCursorRef.current;
            const block = S.arrangement[Math.min(c.block, S.arrangement.length - 1)];
            c.bar += 1;
            if (c.bar >= (block.repeats || 1)) { c.bar = 0; c.block = (c.block + 1) % S.arrangement.length; }
          } else if (S.mode === 'groove') {
            grooveCursorRef.current.globalBar += 1;
          }
        }
      }
    }, 25);

    let raf;
    const tick = () => {
      setCurrentStep(((stepIdx - 1) + 16) % 16);
      if (stateRef.current.mode === 'song') { setActiveBlock(songCursorRef.current.block); setActiveBar(songCursorRef.current.bar); }
      else {
        setActiveBlock(-1);
        if (stateRef.current.mode === 'groove') { const g = grooveCursorRef.current; setGrooveActive(g.active); setGrooveQueued(g.queued); }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => { clearInterval(interval); cancelAnimationFrame(raf); setCurrentStep(-1); setActiveBlock(-1); };
  }, [isPlaying]);

  const togglePlay = () => {
    if (!ready) initEngine();
    setIsPlaying((p) => { const n = !p; if (n && engineRef.current) engineRef.current.resume(); return n; });
  };

  const setDrumCell = (row, i, val) => setDrums((d) => { const r = [...d.pattern[row]]; r[i] = val; return { ...d, pattern: { ...d.pattern, [row]: r } }; });

  // ---- Sampler actions ----
  const ensureEngine = () => {
    if (!engineRef.current) { engineRef.current = new NESEngine(); engineRef.current.init(); setReady(true); }
    return engineRef.current;
  };

  const loadSample = async (slotIndex, file) => {
    if (!file) return;
    const eng = ensureEngine(); eng.resume();
    try {
      const arr = await file.arrayBuffer();
      const buf = await eng.ctx.decodeAudioData(arr);
      sampleBuffersRef.current[slotIndex] = buf;
      const name = file.name.replace(/\.[^.]+$/, '').slice(0, 18);
      // Persist the audio into the shared library so it survives a reload (and
      // becomes available to YUCCA-FX). The decoded buffer plays this session;
      // the stored blob is what rehydrateSlot re-decodes next time.
      let srcId = null;
      try { srcId = await YuccaSamples.put({ name, blob: file, mime: file.type || 'audio/wav' }); } catch (e) {}
      if (srcId) sampleSrcRef.current[slotIndex] = srcId;
      setSamples((s) => { const slots = [...s.slots]; slots[slotIndex] = { ...slots[slotIndex], name, loaded: true, srcId }; return { ...s, slots }; });
    } catch (e) { /* decode failed — unsupported file */ }
  };

  // Re-fetch a slot's audio from the shared IndexedDB library and decode it
  // back into sampleBuffersRef. Used on mount and on loop recall.
  const rehydrateSlot = async (slotIndex, srcId) => {
    if (!srcId) return; // patch slots and empty slots carry no srcId — nothing to fetch
    if (sampleSrcRef.current[slotIndex] === srcId && sampleBuffersRef.current[slotIndex]) return;
    try {
      const rec = await YuccaSamples.get(srcId);
      if (!rec || !rec.blob) {
        // record was deleted from the library — mark the slot empty.
        setSamples((s) => { const slots = [...s.slots]; if (slots[slotIndex] && slots[slotIndex].srcId === srcId) slots[slotIndex] = { ...slots[slotIndex], loaded: false, srcId: null }; return { ...s, slots }; });
        return;
      }
      const eng = ensureEngine();
      const arr = await rec.blob.arrayBuffer();
      const buf = await eng.ctx.decodeAudioData(arr);
      sampleBuffersRef.current[slotIndex] = buf;
      sampleSrcRef.current[slotIndex] = srcId;
      setSamples((s) => { const slots = [...s.slots]; slots[slotIndex] = { ...slots[slotIndex], loaded: true, srcId, name: slots[slotIndex].name || rec.name.slice(0, 18) }; return { ...s, slots }; });
    } catch (e) { /* decode/IDB failed — leave slot as-is */ }
  };

  // Load a chosen YUCCA-FX library record straight into a slot.
  const loadFromLibrary = async (slotIndex, id) => {
    const eng = ensureEngine(); eng.resume();
    try {
      const rec = await YuccaSamples.get(id);
      if (!rec || !rec.blob) return;
      const arr = await rec.blob.arrayBuffer();
      const buf = await eng.ctx.decodeAudioData(arr);
      sampleBuffersRef.current[slotIndex] = buf;
      sampleSrcRef.current[slotIndex] = id;
      setSamples((s) => { const slots = [...s.slots]; slots[slotIndex] = { ...slots[slotIndex], name: rec.name.slice(0, 18), loaded: true, kind: 'buffer', patch: null, srcId: id }; return { ...s, slots }; });
      setFxBrowser(null);
    } catch (e) {}
  };

  // Load a YUCCA-FX preset (patch JSON) into a slot as a live parametric voice.
  const loadPresetIntoSlot = (slotIndex, rec) => {
    if (!rec || !rec.patch) return;
    ensureEngine();
    sampleBuffersRef.current[slotIndex] = null;   // drop any prior buffer
    sampleSrcRef.current[slotIndex] = null;
    setSamples((s) => { const slots = [...s.slots]; slots[slotIndex] = { ...slots[slotIndex], name: (rec.name || 'PRESET').slice(0, 18), loaded: true, kind: 'patch', patch: rec.patch, srcId: null }; return { ...s, slots }; });
    setFxBrowser(null);
  };

  const openFxBrowser = async (slotIndex) => {
    setFxBrowser(slotIndex);
    setFxTab('samples');
    try { setFxList(await YuccaSamples.list()); } catch (e) { setFxList([]); }
    try { setFxPresets(await YuccaPresets.list()); } catch (e) { setFxPresets([]); }
  };

  const doClearSample = (slotIndex) => {
    sampleBuffersRef.current[slotIndex] = null;
    sampleSrcRef.current[slotIndex] = null;
    setSamples((s) => { const slots = [...s.slots]; slots[slotIndex] = { ...slots[slotIndex], name: '', loaded: false, kind: 'buffer', patch: null, notes: [], srcId: null }; return { ...s, slots }; });
    flash(`SLOT ${slotIndex + 1} CLEARED`, COLORS.bass);
  };
  const clearSample = (slotIndex) => {
    const sl = samples.slots[slotIndex];
    const hasNotes = sl && sl.notes && sl.notes.length > 0;
    requestConfirm({
      skip: !hasNotes,   // empty-note slot: just clear it, nothing to lose
      title: 'CLEAR SLOT?',
      message: `Clear slot ${slotIndex + 1}${sl && sl.name ? ` (${sl.name})` : ''}? Its ${hasNotes ? sl.notes.length + ' note' + (sl.notes.length > 1 ? 's' : '') + ' and ' : ''}sound assignment will be removed.`,
      confirmLabel: 'CLEAR', accent: COLORS.bass,
      onConfirm: () => doClearSample(slotIndex),
    });
  };
  const auditionSample = (slotIndex) => {
    const eng = engineRef.current; if (!eng) return;
    eng.resume();
    const sl = samples.slots[slotIndex];
    if (sl.kind === 'patch') {
      if (!sl.patch) return;
      const note = rootNote + (sl.pitch || 0);
      eng.playPatch(sl.patch, note, eng.ctx.currentTime + 0.02, 0.4, { volume: samples.masterVol * sl.volume, pan: 0 });
      return;
    }
    const buf = sampleBuffersRef.current[slotIndex]; if (!buf) return;
    eng.playSample(buf, eng.ctx.currentTime + 0.02, 0.6, { volume: samples.masterVol * sl.volume, pan: 0, semitones: sl.pitch });
  };

  // ---- Undo / redo ----
  // The editor's musical state is captured as compact JSON snapshots. A debounced
  // push coalesces rapid edits (drawing, fader drags) into one history entry.
  const HIST_MAX = 60;
  const editorSnap = () => JSON.stringify({ bass, drums, lead, pad, samples, echo, rootNote, scaleName, bpm, swing });
  const applyEditorSnap = (str) => {
    let d; try { d = JSON.parse(str); } catch (e) { return; }
    const h = histRef.current; h.applying = true;
    setBass(d.bass); setDrums(d.drums); setLead(d.lead); setPad(d.pad);
    setEcho(d.echo); setRootNote(d.rootNote); setScaleName(d.scaleName);
    if (typeof d.bpm === 'number') setBpm(d.bpm);
    if (typeof d.swing === 'number') setSwing(d.swing);
    if (d.samples && Array.isArray(d.samples.slots)) {
      const sm = clone(d.samples);
      sm.slots = sm.slots.map((sl, i) => ({ ...sl, loaded: sl.kind === 'patch' ? !!sl.patch : (!!sampleBuffersRef.current[i] || !!sl.srcId) }));
      setSamples(sm);
      sm.slots.forEach((sl, i) => { if (sl.kind !== 'patch' && sl.srcId) rehydrateSlot(i, sl.srcId); });
    }
    setSelected(null);
    // release the applying guard after the state settles
    setTimeout(() => { h.applying = false; }, 0);
  };
  // Capture history on musical-state change (debounced, skips programmatic applies).
  useEffect(() => {
    if (!storageReady) return;
    const h = histRef.current;
    if (h.applying) return;
    if (h.timer) clearTimeout(h.timer);
    h.timer = setTimeout(() => {
      const snap = editorSnap();
      if (h.stack[h.idx] === snap) return;
      // drop any redo branch, push, cap
      h.stack = h.stack.slice(0, h.idx + 1);
      h.stack.push(snap);
      if (h.stack.length > HIST_MAX) h.stack.shift();
      h.idx = h.stack.length - 1;
      setHistVer((v) => v + 1);
    }, 350);
    return () => { if (h.timer) clearTimeout(h.timer); };
  }, [bass, drums, lead, pad, samples, echo, rootNote, scaleName, bpm, swing, storageReady]);

  const undo = () => {
    const h = histRef.current;
    if (h.idx <= 0) { flash('NOTHING TO UNDO', '#888'); return; }
    if (h.timer) { clearTimeout(h.timer); h.timer = null; }
    h.idx -= 1; applyEditorSnap(h.stack[h.idx]); setHistVer((v) => v + 1);
    flash('UNDO', COLORS.cream);
  };
  const redo = () => {
    const h = histRef.current;
    if (h.idx >= h.stack.length - 1) { flash('NOTHING TO REDO', '#888'); return; }
    if (h.timer) { clearTimeout(h.timer); h.timer = null; }
    h.idx += 1; applyEditorSnap(h.stack[h.idx]); setHistVer((v) => v + 1);
    flash('REDO', COLORS.cream);
  };
  const canUndo = histRef.current.idx > 0;
  const canRedo = histRef.current.idx < histRef.current.stack.length - 1;

  // ---- Projects ----
  const saveProject = (asNew) => {
    const name = (projDraft.trim() || currentProject.name || `Project ${projects.length + 1}`).slice(0, 28);
    const id = (asNew || !currentProject.id) ? `P${Date.now()}` : currentProject.id;
    const entry = { id, name, savedAt: Date.now(), data: projectData() };
    setProjects((prev) => { const i = prev.findIndex((p) => p.id === id); if (i >= 0) { const copy = [...prev]; copy[i] = entry; return copy; } return [...prev, entry]; });
    setCurrentProject({ id, name });
    setProjDraft('');
    // this is now the clean baseline
    savedBaseline.current = contentSig(); setDirty(false);
    flash(`SAVED · ${name.toUpperCase()}`, COLORS.song);
  };
  const doLoadProject = (id) => {
    const p = projects.find((x) => x.id === id); if (!p) return;
    setIsPlaying(false);
    applyProject(clone(p.data));
    setCurrentProject({ id: p.id, name: p.name });
    savedBaseline.current = JSON.stringify({ bpm: p.data.bpm, masterVol: p.data.masterVol, swing: p.data.swing, rootNote: p.data.rootNote, scaleName: p.data.scaleName, bass: p.data.bass, drums: p.data.drums, lead: p.data.lead, pad: p.data.pad, samples: p.data.samples, echo: p.data.echo, library: p.data.library, arrangement: p.data.arrangement });
    setDirty(false);
    const h = histRef.current; h.stack = []; h.idx = -1; setHistVer((v) => v + 1);
    setProjOpen(false);
    flash(`LOADED · ${(p.name || '').toUpperCase()}`, COLORS.lead);
  };
  // Gate load behind an unsaved-changes prompt.
  const loadProject = (id) => {
    requestConfirm({
      skip: !dirty,
      title: 'LOAD PROJECT?',
      message: `You have unsaved changes in "${currentProject.name}". Loading another project will discard them. Save first, or load anyway.`,
      confirmLabel: 'DISCARD & LOAD', accent: COLORS.bass,
      onConfirm: () => doLoadProject(id),
    });
  };
  const deleteProject = (id) => {
    const p = projects.find((x) => x.id === id);
    requestConfirm({
      title: 'DELETE PROJECT?',
      message: `Permanently delete "${p ? p.name : 'this project'}"? This cannot be undone.`,
      confirmLabel: 'DELETE', accent: COLORS.bass,
      onConfirm: () => { setProjects((prev) => prev.filter((x) => x.id !== id)); flash('PROJECT DELETED', COLORS.bass); },
    });
  };
  const doNewProject = () => {
    setIsPlaying(false);
    setBpm(132); setMasterVol(0.7); setSwing(0); setRootNote(45); setScaleName('Minor Pent'); setMode('loop'); setTab('lead');
    setBass({ volume: 0.6, pan: 0, decay: 0.7, sub: false, octave: -1, wave: 'triangle', tone: 0.4, notes: clone(defBass) });
    setDrums({ volume: 0.7, pan: 0, sendSnare: 0.35, sendHat: 0.15, pattern: clone(defDrums) });
    setLead({ volume: 0.5, pan: 0.15, duty: 0.25, decay: 0.6, vibrato: 0, vibSpeed: 6, arpMode: 'Off', arpSpeed: 16, octave: 1, send: 0.5, wave: 'pulse', tone: 0.55, notes: clone(defLead) });
    setPad({ volume: 0.4, pan: -0.15, duty: 0.5, detune: 8, attack: 0.08, release: 0.6, chord: 'Fifth', octave: 0, send: 0.3, wave: 'pulse', tone: 0.5, notes: clone(defPad) });
    setEcho({ timeMode: '1/8.', feedback: 0.4, tone: 2200, wet: 0.55 });
    setLibrary([]); setArrangement([]);
    sampleBuffersRef.current = [null, null, null, null];
    sampleSrcRef.current = [null, null, null, null];
    setSamples({ masterVol: 0.8, activeSlot: 0, slots: [0, 1, 2, 3].map(() => ({ name: '', loaded: false, kind: 'buffer', volume: 0.8, pitch: 0, srcId: null, patch: null, notes: [] })) });
    setCurrentProject({ id: null, name: 'UNTITLED' });
    savedBaseline.current = null; setDirty(false);   // recomputed against the fresh INIT on next tick
    const h = histRef.current; h.stack = []; h.idx = -1; setHistVer((v) => v + 1);
    setProjOpen(false);
    flash('NEW PROJECT', COLORS.song);
  };
  const newProject = () => {
    requestConfirm({
      skip: !dirty,
      title: 'NEW PROJECT?',
      message: `You have unsaved changes in "${currentProject.name}". Starting a new project will discard them. Save first, or start fresh anyway.`,
      confirmLabel: 'DISCARD & NEW', accent: COLORS.bass,
      onConfirm: doNewProject,
    });
  };

  // ---- Loop library actions ----
  const snapshot = () => clone({ bass, drums, lead, pad, samples, echo, rootNote, scaleName });
  const commitSave = () => {
    const name = draftName.trim() || `Loop ${library.length + 1}`;
    setLibrary((prev) => [...prev, { id: `L${Date.now()}`, name, data: snapshot() }]);
    setNaming(false); setDraftName('');
    flash(`LOOP SAVED · ${name.toUpperCase()}`, COLORS.song);
  };
  const recallLoop = (id) => {
    const l = library.find((x) => x.id === id); if (!l) return;
    const d = clone(l.data);
    setBass(d.bass); setDrums(d.drums); setLead(d.lead); setPad(d.pad);
    setEcho(d.echo); setRootNote(d.rootNote); setScaleName(d.scaleName);
    if (d.samples) {
      const sm = clone(d.samples);
      // A slot is "loaded" if its buffer is already present, or if it carries a
      // srcId we can rehydrate from the shared library (kicked off below).
      sm.slots = sm.slots.map((sl, i) => ({ ...sl, loaded: !!sampleBuffersRef.current[i] || !!sl.srcId }));
      setSamples(sm);
      sm.slots.forEach((sl, i) => { if (sl.srcId) rehydrateSlot(i, sl.srcId); });
    }
    setSelected(null); setMode('loop');
    flash(`LOADED · ${(l.name || '').toUpperCase()}`, COLORS.lead);
  };
  const deleteLoop = (id) => {
    const l = library.find((x) => x.id === id);
    const usedBy = arrangement.filter((b) => b.loopId === id).length;
    requestConfirm({
      title: 'DELETE LOOP?',
      message: `Delete "${l ? l.name : 'this loop'}"?` + (usedBy ? ` It's used by ${usedBy} block${usedBy > 1 ? 's' : ''} in the arrangement, which will also be removed.` : ' This cannot be undone.'),
      confirmLabel: 'DELETE', accent: COLORS.bass,
      onConfirm: () => {
        setLibrary((prev) => prev.filter((x) => x.id !== id));
        setArrangement((prev) => prev.filter((b) => b.loopId !== id));
        flash('LOOP DELETED', COLORS.bass);
      },
    });
  };

  // ---- Arrangement actions ----
  const addBlock = (loopId) => { setArrangement((prev) => [...prev, { id: `B${Date.now()}_${prev.length}`, loopId, repeats: 2 }]); flash('ADDED TO SONG', COLORS.song); };
  const setRepeats = (id, r) => setArrangement((prev) => prev.map((b) => b.id === id ? { ...b, repeats: r } : b));
  const moveBlock = (id, dir) => setArrangement((prev) => {
    const i = prev.findIndex((b) => b.id === id); if (i < 0) return prev;
    const j = i + dir; if (j < 0 || j >= prev.length) return prev;
    const copy = [...prev]; [copy[i], copy[j]] = [copy[j], copy[i]]; return copy;
  });
  const removeBlock = (id) => { setArrangement((prev) => prev.filter((b) => b.id !== id)); flash('BLOCK REMOVED', COLORS.bass); };

  // ---- GROOVE actions ----
  // Arm a scene; it swaps in at the next launch boundary. Firing also starts
  // playback if stopped (it's a performance gesture).
  const fireScene = (loopId) => {
    grooveCursorRef.current.queued = loopId;
    setGrooveQueued(loopId);
    if (!isPlaying) { if (!ready) initEngine(); if (engineRef.current) engineRef.current.resume(); setIsPlaying(true); }
  };
  const toggleSceneMute = (loopId, ch) => setGrooveMutes((prev) => {
    const cur = prev[loopId] || {};
    return { ...prev, [loopId]: { ...cur, [ch]: !cur[ch] } };
  });
  const toggleSolo = (ch) => setGrooveSolo((prev) => {
    const next = { ...(prev || {}), [ch]: !(prev && prev[ch]) };
    return Object.values(next).some(Boolean) ? next : null;
  });
  // Turn the last N bars of the live performance into editable SONG blocks,
  // carrying each span's mutes through. Runs longer than 8 bars split into
  // multiple blocks so the repeats stepper stays usable.
  const captureToSong = () => {
    const entries = grooveLogRef.current.slice();
    const cur = grooveCursorRef.current;
    if (cur.active != null && cur.globalBar > cur.startBar) {
      entries.push({ loopId: cur.active, bars: cur.globalBar - cur.startBar, mutes: grooveMutes[cur.active] ? clone(grooveMutes[cur.active]) : null });
    }
    if (!entries.length) { flash('NOTHING TO CAPTURE — FIRE A SCENE FIRST', COLORS.bass); return; }
    let need = captureBars;
    const picked = [];
    for (let i = entries.length - 1; i >= 0 && need > 0; i--) {
      const e = entries[i];
      const take = Math.min(e.bars, need);
      if (take > 0) picked.unshift({ loopId: e.loopId, bars: take, mutes: e.mutes });
      need -= take;
    }
    const blocks = [];
    picked.forEach((e) => {
      let rem = e.bars;
      while (rem > 0) { const r = Math.min(8, rem); blocks.push({ id: `B${Date.now()}_${blocks.length}`, loopId: e.loopId, repeats: r, mutes: maskHasAny(e.mutes) ? e.mutes : null }); rem -= r; }
    });
    setArrangement((prev) => [...prev, ...blocks]);
    flash(`CAPTURED ${captureBars} BARS -> SONG`, COLORS.song);
    setMode('song');
  };

  const tabs = [
    { key: 'bass', label: 'BASS', sub: 'TRI', color: COLORS.bass },
    { key: 'drums', label: 'DRUM', sub: 'NSE', color: COLORS.drums },
    { key: 'lead', label: 'LEAD', sub: 'PUL', color: COLORS.lead },
    { key: 'pad', label: 'PAD', sub: '2PUL', color: COLORS.pad },
    { key: 'samples', label: 'SMPL', sub: 'PCM', color: COLORS.samples },
  ];
  const activeColor = tabs.find((t) => t.key === tab).color;
  const ch = { bass, drums, lead, pad, samples }[tab];

  // Editor routing — the SMPL tab edits the active slot's notes through the same roll.
  const isSampleTab = tab === 'samples';
  const rollNotes = isSampleTab ? samples.slots[samples.activeSlot].notes : ch.notes;
  const rollOnChange = isSampleTab ? updateSampleNotes : ((fn) => updateNotes(tab, fn));
  const rollOctave = isSampleTab ? 0 : ch.octave;
  const doRollClear = isSampleTab ? (() => updateSampleNotes(() => [])) : (() => updateNotes(tab, () => []));
  const rollClear = () => {
    const n = rollNotes.length;
    requestConfirm({
      skip: n === 0,
      title: 'CLEAR NOTES?',
      message: `Clear all ${n} note${n > 1 ? 's' : ''} on the ${tab.toUpperCase()} roll? You can undo this.`,
      confirmLabel: 'CLEAR', accent: COLORS.bass,
      onConfirm: () => { doRollClear(); flash('NOTES CLEARED', COLORS.bass); },
    });
  };

  const selNote = selected
    ? (selected.channel === 'samples'
        ? samples.slots[samples.activeSlot].notes.find((n) => n.id === selected.id)
        : ({ bass, lead, pad }[selected.channel]?.notes.find((n) => n.id === selected.id)))
    : null;
  const selOctave = selected ? (selected.channel === 'samples' ? 0 : ({ bass, lead, pad }[selected.channel]?.octave ?? 0)) : 0;

  const channelActive = (key) => {
    if (currentStep < 0 || mode !== 'loop') return false;
    if (key === 'drums') return Object.values(drums.pattern).some((r) => r[currentStep]);
    if (key === 'samples') return samples.slots.some((sl) => sl.notes.some((x) => currentStep >= x.start && currentStep < x.start + x.length));
    return { bass, lead, pad }[key].notes.some((x) => currentStep >= x.start && currentStep < x.start + x.length);
  };

  const libName = (id) => library.find((l) => l.id === id)?.name ?? '— deleted —';
  const totalBars = arrangement.reduce((s, b) => s + (b.repeats || 1), 0);

  return (
    <div className="min-h-screen w-full relative" style={{ background: 'radial-gradient(ellipse at top, #1a1015 0%, #0a0a0f 50%, #050505 100%)', fontFamily: 'VT323, monospace' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Press+Start+2P&family=VT323&display=swap');
        @keyframes pwr { 0%,100%{opacity:1} 50%{opacity:.7} }
        @keyframes echoPulse { 0%,100%{opacity:.6} 50%{opacity:1} }
        @keyframes slideUp { from{transform:translateY(100%)} to{transform:translateY(0)} }
        @keyframes grooveQueue { 0%,100%{opacity:.35} 50%{opacity:1} }
        .crt::before { content:''; position:absolute; inset:0; background: repeating-linear-gradient(0deg, rgba(255,255,255,0.02) 0px, rgba(255,255,255,0.02) 1px, transparent 1px, transparent 3px); pointer-events:none; mix-blend-mode:overlay; }
        .led { text-shadow: 0 0 6px currentColor; }
        input.namefield { font-family: 'VT323', monospace; }
      `}</style>

      <div className="max-w-[1400px] mx-auto crt relative">
        {/* ===== STICKY TRANSPORT ===== */}
        <div className="sticky top-0 z-40" style={{ background: 'linear-gradient(180deg, #d5292b 0%, #8a1a1c 100%)', boxShadow: 'inset 0 -2px 4px rgba(0,0,0,0.4), 0 4px 12px rgba(0,0,0,0.5)' }}>
          <div className="px-3 sm:px-5 py-2.5 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-2.5 h-2.5 rounded-full border-2 shrink-0" style={{ background: ready ? '#7fff7f' : '#3a3a3a', borderColor: '#1a0a0a', boxShadow: ready ? '0 0 8px #7fff7f' : 'none', animation: ready ? 'pwr 2s ease-in-out infinite' : 'none' }} />
              <div className="min-w-0">
                <div className="text-[10px] tracking-[0.25em] text-stone-100 truncate" style={{ fontFamily: PS }}>RAW FORM</div>
                <button onClick={() => { setProjDraft(currentProject.name === 'UNTITLED' ? '' : currentProject.name); setProjOpen(true); }} className="flex items-center gap-1 text-[7px] tracking-[0.15em] text-stone-200/80 mt-0.5 truncate active:opacity-60" style={{ fontFamily: PS, touchAction: 'manipulation' }} title={dirty ? 'Projects · unsaved changes' : 'Projects'}><FolderOpen size={9} />{currentProject.name}{dirty && <span style={{ width: 5, height: 5, borderRadius: 999, background: COLORS.drums, boxShadow: `0 0 5px ${COLORS.drums}`, marginLeft: 2 }} />}</button>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button onClick={undo} disabled={!canUndo} className="w-8 h-8 flex items-center justify-center rounded-md active:translate-y-px" style={{ background: '#1a1a22', border: '1px solid #3a3a45', color: canUndo ? COLORS.cream : '#555', opacity: canUndo ? 1 : 0.5, touchAction: 'manipulation' }} title="Undo"><Undo2 size={14} /></button>
              <button onClick={redo} disabled={!canRedo} className="w-8 h-8 flex items-center justify-center rounded-md active:translate-y-px" style={{ background: '#1a1a22', border: '1px solid #3a3a45', color: canRedo ? COLORS.cream : '#555', opacity: canRedo ? 1 : 0.5, touchAction: 'manipulation' }} title="Redo"><Redo2 size={14} /></button>
              <div className="px-2.5 py-1 rounded-sm border" style={{ background: '#0a0a0f', borderColor: '#3a2a25', boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.6)' }}>
                <div className="text-[6px] uppercase tracking-widest text-stone-500" style={{ fontFamily: PS }}>BPM</div>
                <div className="text-xl led tabular-nums leading-none" style={{ fontFamily: 'VT323, monospace', color: '#7fff7f' }}>{bpm.toString().padStart(3, '0')}</div>
              </div>
              <button onClick={togglePlay} className="px-4 py-2.5 border-2 rounded-md flex items-center gap-2 active:translate-y-px" style={{ background: isPlaying ? '#7fff7f' : '#1a1a22', borderColor: isPlaying ? '#5acc5a' : '#3a3a45', color: isPlaying ? '#0a0a0f' : COLORS.cream, boxShadow: isPlaying ? '0 0 16px #7fff7f80' : 'none', fontFamily: PS, fontSize: '10px', touchAction: 'manipulation' }}>
                {isPlaying ? <Square size={12} fill="currentColor" /> : <Play size={12} fill="currentColor" />}{isPlaying ? 'STOP' : 'PLAY'}
              </button>
            </div>
          </div>

          {/* ===== MODE SWITCH ===== */}
          <div className="px-2 sm:px-4 pb-2 grid grid-cols-3 gap-1.5">
            {[{ k: 'loop', label: 'LOOP', icon: <Repeat size={12} /> }, { k: 'song', label: 'SONG', icon: <ListMusic size={12} /> }, { k: 'groove', label: 'GROOVE', icon: <Zap size={12} /> }].map((m) => {
              const active = mode === m.k;
              return (
                <button key={m.k} onClick={() => setMode(m.k)} className="py-2 rounded-md flex items-center justify-center gap-1.5 active:translate-y-px" style={{ background: active ? `${COLORS.song}22` : '#0a0a0f', border: `1.5px solid ${active ? COLORS.song : '#2a2a35'}`, color: active ? COLORS.song : '#888', boxShadow: active ? `0 0 12px ${COLORS.song}44` : 'none', fontFamily: PS, fontSize: '9px', touchAction: 'manipulation' }}>
                  {m.icon}{m.label}
                </button>
              );
            })}
          </div>

          {/* ===== CHANNEL TABS (loop mode only) ===== */}
          {mode === 'loop' && (
            <div className="px-2 sm:px-4 pb-2 grid grid-cols-5 gap-1">
              {tabs.map((t) => {
                const active = t.key === tab; const playing = channelActive(t.key);
                return (
                  <button key={t.key} onClick={() => { setTab(t.key); setSelected(null); }} className="relative py-2 rounded-md flex flex-col items-center gap-0.5 transition-all active:translate-y-px" style={{ background: active ? `${t.color}1f` : '#0a0a0f', border: `1.5px solid ${active ? t.color : '#2a2a35'}`, boxShadow: active ? `0 0 12px ${t.color}55, inset 0 0 12px ${t.color}11` : 'none', touchAction: 'manipulation' }}>
                    <div className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full" style={{ background: playing ? t.color : `${t.color}33`, boxShadow: playing ? `0 0 6px ${t.color}` : 'none', transition: 'all 60ms' }} />
                    <span className="text-[9px] tracking-wider" style={{ fontFamily: PS, color: active ? t.color : '#888' }}>{t.label}</span>
                    <span className="text-[6px] tracking-widest" style={{ fontFamily: PS, color: active ? `${t.color}aa` : '#555' }}>{t.sub}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* ================= LOOP MODE ================= */}
        {mode === 'loop' && (
        <div className="p-3 sm:p-5 space-y-4" style={{ paddingBottom: selNote ? 200 : 24 }}>
          {/* channel controls */}
          <div className="rounded-lg p-3" style={{ background: 'linear-gradient(180deg, rgba(40,35,40,0.5), rgba(20,18,22,0.5))', border: `1.5px solid ${activeColor}25` }}>
            {tab === 'bass' && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
                  <Fader label="Volume" value={bass.volume} min={0} max={1} onChange={(v) => setBass({ ...bass, volume: v })} color={COLORS.bass} />
                  <Fader label="Pan" value={bass.pan} min={-1} max={1} onChange={(v) => setBass({ ...bass, pan: v })} color={COLORS.bass} bipolar />
                  <Fader label="Decay" value={bass.decay} min={0.05} max={1.5} onChange={(v) => setBass({ ...bass, decay: v })} color={COLORS.bass} />
                  <Stepper label="Octave" value={bass.octave} min={-3} max={1} onChange={(v) => setBass({ ...bass, octave: v })} color={COLORS.bass} />
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
                  <Toggle label="Wave" value={bass.wave} options={WAVE_OPTS} onChange={(v) => setBass({ ...bass, wave: v })} color={COLORS.bass} />
                  <Fader label="Tone" value={bass.tone} min={0} max={1} onChange={(v) => setBass({ ...bass, tone: v })} color={COLORS.bass} />
                  <Toggle label="Sub" value={bass.sub} options={[{ value: false, label: 'OFF' }, { value: true, label: 'ON' }]} onChange={(v) => setBass({ ...bass, sub: v })} color={COLORS.bass} />
                </div>
              </div>
            )}
            {tab === 'drums' && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
                <Fader label="Volume" value={drums.volume} min={0} max={1} onChange={(v) => setDrums({ ...drums, volume: v })} color={COLORS.drums} />
                <Fader label="Pan" value={drums.pan} min={-1} max={1} onChange={(v) => setDrums({ ...drums, pan: v })} color={COLORS.drums} bipolar />
                <Fader label="Snare→Echo" value={drums.sendSnare} min={0} max={1} onChange={(v) => setDrums({ ...drums, sendSnare: v })} color={COLORS.echo} />
                <Fader label="Hat→Echo" value={drums.sendHat} min={0} max={1} onChange={(v) => setDrums({ ...drums, sendHat: v })} color={COLORS.echo} />
              </div>
            )}
            {tab === 'lead' && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
                  <Fader label="Volume" value={lead.volume} min={0} max={1} onChange={(v) => setLead({ ...lead, volume: v })} color={COLORS.lead} />
                  <Fader label="Pan" value={lead.pan} min={-1} max={1} onChange={(v) => setLead({ ...lead, pan: v })} color={COLORS.lead} bipolar />
                  <Fader label="Decay" value={lead.decay} min={0.1} max={1.2} onChange={(v) => setLead({ ...lead, decay: v })} color={COLORS.lead} />
                  <Fader label="Vibrato" value={lead.vibrato} min={0} max={1} onChange={(v) => setLead({ ...lead, vibrato: v })} color={COLORS.lead} />
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
                  <Toggle label="Wave" value={lead.wave} options={WAVE_OPTS} onChange={(v) => setLead({ ...lead, wave: v })} color={COLORS.lead} />
                  <Fader label="Tone" value={lead.tone} min={0} max={1} onChange={(v) => setLead({ ...lead, tone: v })} color={COLORS.lead} />
                  <Toggle label="Duty" value={lead.duty} options={[{ value: 0.125, label: '12' }, { value: 0.25, label: '25' }, { value: 0.5, label: '50' }, { value: 0.75, label: '75' }]} onChange={(v) => setLead({ ...lead, duty: v })} color={COLORS.lead} />
                  <Toggle label="Arp" value={lead.arpMode} options={['Off', 'Up', 'Down', 'Oct', '5th']} onChange={(v) => setLead({ ...lead, arpMode: v })} color={COLORS.lead} />
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
                  <Stepper label="Octave" value={lead.octave} min={-1} max={3} onChange={(v) => setLead({ ...lead, octave: v })} color={COLORS.lead} />
                  <Fader label="Send→Echo" value={lead.send} min={0} max={1} onChange={(v) => setLead({ ...lead, send: v })} color={COLORS.echo} />
                </div>
              </div>
            )}
            {tab === 'pad' && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
                  <Fader label="Volume" value={pad.volume} min={0} max={1} onChange={(v) => setPad({ ...pad, volume: v })} color={COLORS.pad} />
                  <Fader label="Pan" value={pad.pan} min={-1} max={1} onChange={(v) => setPad({ ...pad, pan: v })} color={COLORS.pad} bipolar />
                  <Fader label="Detune" value={pad.detune} min={0} max={30} onChange={(v) => setPad({ ...pad, detune: v })} color={COLORS.pad} unit="¢" />
                  <Fader label="Attack" value={pad.attack} min={0.005} max={0.5} onChange={(v) => setPad({ ...pad, attack: v })} color={COLORS.pad} />
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
                  <Fader label="Release" value={pad.release} min={0.05} max={2} onChange={(v) => setPad({ ...pad, release: v })} color={COLORS.pad} />
                  <Toggle label="Duty" value={pad.duty} options={[{ value: 0.125, label: '12' }, { value: 0.25, label: '25' }, { value: 0.5, label: '50' }]} onChange={(v) => setPad({ ...pad, duty: v })} color={COLORS.pad} />
                  <Toggle label="Chord" value={pad.chord} options={['Single', 'Octave', 'Fifth', 'Triad', 'Minor']} onChange={(v) => setPad({ ...pad, chord: v })} color={COLORS.pad} />
                  <Stepper label="Octave" value={pad.octave} min={-2} max={2} onChange={(v) => setPad({ ...pad, octave: v })} color={COLORS.pad} />
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
                  <Toggle label="Wave" value={pad.wave} options={WAVE_OPTS} onChange={(v) => setPad({ ...pad, wave: v })} color={COLORS.pad} />
                  <Fader label="Tone" value={pad.tone} min={0} max={1} onChange={(v) => setPad({ ...pad, tone: v })} color={COLORS.pad} />
                  <Fader label="Send→Echo" value={pad.send} min={0} max={1} onChange={(v) => setPad({ ...pad, send: v })} color={COLORS.echo} />
                </div>
              </div>
            )}
            {tab === 'samples' && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
                  <Fader label="Channel Vol" value={samples.masterVol} min={0} max={1} onChange={(v) => setSamples({ ...samples, masterVol: v })} color={COLORS.samples} />
                  <div className="flex flex-col gap-1 sm:col-span-3">
                    <span className="text-[8px] uppercase tracking-wider text-stone-400" style={{ fontFamily: PS }}>Sound Design</span>
                    <div className="grid grid-cols-2 gap-2">
                      <a href="YUCCAFX/yucca-fx-8bit_v1_5.html?from=rawform" className="flex items-center justify-center gap-2 h-7 rounded-md active:translate-y-px" style={{ background: `${COLORS.samples}1a`, border: `1.5px solid ${COLORS.samples}`, color: COLORS.samples, fontFamily: PS, fontSize: '9px', boxShadow: `0 0 10px ${COLORS.samples}44`, touchAction: 'manipulation', textDecoration: 'none' }}>
                        <Waves size={12} /> YUCCA-FX
                      </a>
                      <a href="RAWFORMLESS/raw-formless.html?from=rawform" className="flex items-center justify-center gap-2 h-7 rounded-md active:translate-y-px" style={{ background: `${COLORS.lead}1a`, border: `1.5px solid ${COLORS.lead}`, color: COLORS.lead, fontFamily: PS, fontSize: '9px', boxShadow: `0 0 10px ${COLORS.lead}44`, touchAction: 'manipulation', textDecoration: 'none' }}>
                        <Waves size={12} /> RAW FORMLESS
                      </a>
                    </div>
                  </div>
                </div>
                <div className="text-[7px] tracking-wider text-stone-500 leading-relaxed" style={{ fontFamily: PS }}>◇ DESIGN SOUNDS IN YUCCA-FX OR DRONES IN RAW FORMLESS · EXPORT · THEN TAP A SLOT'S FX BUTTON, "FROM YUCCA-FX", TO LOAD HERE</div>
                <div className="space-y-2">
                  {samples.slots.map((sl, si) => {
                    const active = samples.activeSlot === si;
                    return (
                      <div key={si} className="rounded-md p-2" style={{ background: active ? `${COLORS.samples}1a` : '#0c0c12', border: `1.5px solid ${active ? COLORS.samples : '#1f1f29'}` }}>
                        <div className="flex items-center gap-2">
                          <button onClick={() => setSamples({ ...samples, activeSlot: si })} className="w-8 h-8 rounded-md flex items-center justify-center shrink-0" style={{ background: active ? COLORS.samples : '#15151c', color: active ? '#0a0a0f' : COLORS.samples, border: `1px solid ${COLORS.samples}55`, fontFamily: PS, fontSize: '10px', touchAction: 'manipulation' }}>{si + 1}</button>
                          <div className="flex-1 min-w-0">
                            {sl.loaded
                              ? <span className="truncate block text-[14px]" style={{ fontFamily: 'VT323, monospace', color: COLORS.cream }}>{sl.name}</span>
                              : <span className="text-[9px] tracking-wider text-stone-500" style={{ fontFamily: PS }}>EMPTY SLOT</span>}
                          </div>
                          <label className="px-2.5 py-1.5 rounded-md active:opacity-60 cursor-pointer" style={{ background: '#15151c', border: `1px solid ${COLORS.samples}55`, color: COLORS.samples, fontFamily: PS, fontSize: '8px', touchAction: 'manipulation' }}>
                            {sl.loaded ? 'REPLACE' : 'LOAD'}
                            <input type="file" accept="audio/*" className="hidden" onChange={(e) => { loadSample(si, e.target.files[0]); e.target.value = ''; }} />
                          </label>
                          <button onClick={() => openFxBrowser(si)} className="px-2.5 py-1.5 rounded-md active:opacity-60" style={{ background: '#15151c', border: `1px solid ${COLORS.samples}55`, color: COLORS.samples, fontFamily: PS, fontSize: '8px', touchAction: 'manipulation' }}>FX</button>
                          {sl.loaded && <button onClick={() => auditionSample(si)} className="w-9 h-9 flex items-center justify-center rounded-md active:opacity-60" style={{ background: '#15151c', border: `1px solid ${COLORS.samples}55`, color: COLORS.samples, touchAction: 'manipulation' }}><Play size={12} fill="currentColor" /></button>}
                          {sl.loaded && <button onClick={() => clearSample(si)} className="w-9 h-9 flex items-center justify-center rounded-md active:opacity-60" style={{ background: '#1a1010', border: '1px solid #3a1a1a', color: '#ff8877', touchAction: 'manipulation' }}><Trash2 size={12} /></button>}
                        </div>
                        {sl.loaded && (
                          <div className="grid grid-cols-2 gap-3 items-end mt-2">
                            <Fader label="Volume" value={sl.volume} min={0} max={1} onChange={(v) => setSamples((s) => { const slots = [...s.slots]; slots[si] = { ...slots[si], volume: v }; return { ...s, slots }; })} color={COLORS.samples} />
                            <Fader label="Pitch" value={sl.pitch} min={-24} max={24} step={1} onChange={(v) => setSamples((s) => { const slots = [...s.slots]; slots[si] = { ...slots[si], pitch: v }; return { ...s, slots }; })} color={COLORS.samples} unit="st" bipolar />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* editor */}
          {tab === 'drums' ? (
            <DrumSeq pattern={drums.pattern} currentStep={currentStep} onCellChange={setDrumCell} color={COLORS.drums} />
          ) : (
            <div className="space-y-2">
              {isSampleTab && (
                <div className="flex items-center gap-2 text-[8px] tracking-wider" style={{ fontFamily: PS, color: COLORS.samples }}>
                  EDITING SLOT {samples.activeSlot + 1}{samples.slots[samples.activeSlot].loaded ? ` · ${samples.slots[samples.activeSlot].name}` : ' · EMPTY'}
                </div>
              )}
              {isSampleTab && !samples.slots[samples.activeSlot].loaded && (
                <div className="text-[8px] tracking-wider text-stone-500" style={{ fontFamily: PS }}>LOAD A SAMPLE INTO THIS SLOT (ABOVE) TO HEAR IT PLAY.</div>
              )}
              <div className="flex flex-wrap items-end gap-3 justify-between">
                <div className="flex gap-1.5">
                  {[{ m: 'draw', icon: <Pencil size={13} />, label: 'DRAW' }, { m: 'velo', icon: <Sliders size={13} />, label: 'VELO' }, { m: 'erase', icon: <Eraser size={13} />, label: 'ERASE' }].map(({ m, icon, label }) => {
                    const active = editMode === m;
                    return (<button key={m} onClick={() => setEditMode(m)} className="flex items-center gap-1.5 px-3 py-2 rounded-md active:translate-y-px" style={{ background: active ? activeColor : '#0a0a0f', color: active ? '#0a0a0f' : '#999', border: `1.5px solid ${active ? activeColor : '#2a2a35'}`, boxShadow: active ? `0 0 10px ${activeColor}66` : 'none', fontFamily: PS, fontSize: '8px', touchAction: 'manipulation' }}>{icon}{label}</button>);
                  })}
                </div>
                {editMode === 'draw' && (
                  <div className="flex items-end gap-3">
                    <Toggle label="Tap Length" value={brush.length} options={[{ value: 1, label: '1' }, { value: 2, label: '2' }, { value: 4, label: '4' }]} onChange={(v) => setBrush({ ...brush, length: v })} color={activeColor} />
                    <div style={{ width: 110 }}><Fader label="Tap Velocity" value={brush.velocity} min={0.05} max={1} onChange={(v) => setBrush({ ...brush, velocity: v })} color={activeColor} /></div>
                  </div>
                )}
              </div>
              <PianoRoll notes={rollNotes} onChange={rollOnChange} rowCount={rowCount} rowLabel={makeRowLabel(rollOctave)} isRoot={makeIsRoot} color={activeColor} currentStep={currentStep} mode={editMode} brush={brush} onSelect={(id) => setSelected({ channel: tab, id })} selectedId={selected?.channel === tab ? selected.id : null} />
              <div className="flex items-center justify-between">
                <div className="text-[7px] tracking-wider text-stone-500 leading-relaxed" style={{ fontFamily: PS }}>
                  {editMode === 'draw' && '◇ TAP=NOTE · SWIPE RIGHT=LENGTH · TAP NOTE=EDIT · DRAG VERT=SCROLL'}
                  {editMode === 'velo' && '◇ DRAG ACROSS NOTES — FINGER HEIGHT SETS VELOCITY'}
                  {editMode === 'erase' && '◇ TAP OR DRAG OVER NOTES TO DELETE'}
                </div>
                <button onClick={rollClear} className="flex items-center gap-1 px-2.5 py-1.5 rounded-md active:opacity-60 shrink-0" style={{ background: '#1a1a22', border: '1px solid #3a3a45', color: '#aaa', fontFamily: PS, fontSize: '8px', touchAction: 'manipulation' }}><Trash2 size={10} /> CLEAR</button>
              </div>
            </div>
          )}

          {/* ===== LOOP LIBRARY ===== */}
          <div className="rounded-lg p-3" style={{ background: `linear-gradient(180deg, ${COLORS.song}10, transparent)`, border: `1px solid ${COLORS.song}30` }}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <FolderOpen size={12} style={{ color: COLORS.song }} />
                <span className="text-[10px] tracking-[0.2em]" style={{ fontFamily: PS, color: COLORS.song }}>LOOP LIBRARY</span>
                <span className="text-[8px] text-stone-500" style={{ fontFamily: 'VT323, monospace' }}>({library.length})</span>
              </div>
              {!naming && (
                <button onClick={() => { setDraftName(`Loop ${library.length + 1}`); setNaming(true); }} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md active:translate-y-px" style={{ background: COLORS.song, color: '#0a0a0f', fontFamily: PS, fontSize: '9px', boxShadow: `0 0 10px ${COLORS.song}66`, touchAction: 'manipulation' }}><Save size={11} /> SAVE LOOP</button>
              )}
            </div>

            {naming && (
              <div className="flex items-center gap-2 mb-3">
                <input className="namefield flex-1 px-3 py-2 rounded-md outline-none" autoFocus value={draftName} onChange={(e) => setDraftName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') commitSave(); if (e.key === 'Escape') { setNaming(false); setDraftName(''); } }} maxLength={28} placeholder="loop name…" style={{ background: '#0a0a0f', border: `1.5px solid ${COLORS.song}`, color: COLORS.cream, fontSize: '16px' }} />
                <button onClick={commitSave} className="px-3 py-2 rounded-md active:opacity-60" style={{ background: COLORS.song, color: '#0a0a0f', fontFamily: PS, fontSize: '9px', touchAction: 'manipulation' }}>SAVE</button>
                <button onClick={() => { setNaming(false); setDraftName(''); }} className="w-9 h-9 flex items-center justify-center rounded-md active:opacity-60" style={{ background: '#1a1a22', border: '1px solid #3a3a45', color: COLORS.cream, touchAction: 'manipulation' }}><X size={14} /></button>
              </div>
            )}

            {library.length === 0 ? (
              <div className="text-[8px] tracking-wider text-stone-500 py-3 text-center leading-relaxed" style={{ fontFamily: PS }}>NO SAVED LOOPS YET — BUILD A PATTERN, THEN SAVE IT.<br />SAVED LOOPS BECOME THE BUILDING BLOCKS FOR SONG MODE.</div>
            ) : (
              <div className="space-y-1.5">
                {library.map((l) => (
                  <div key={l.id} className="flex items-center gap-2 rounded-md px-2.5 py-2" style={{ background: '#0c0c12', border: '1px solid #1f1f29' }}>
                    <Music size={11} style={{ color: COLORS.song }} className="shrink-0" />
                    <span className="flex-1 truncate text-[14px]" style={{ fontFamily: 'VT323, monospace', color: COLORS.cream }}>{l.name}</span>
                    <button onClick={() => recallLoop(l.id)} className="px-2.5 py-1.5 rounded-md active:opacity-60" style={{ background: '#15151c', border: `1px solid ${COLORS.lead}55`, color: COLORS.lead, fontFamily: PS, fontSize: '8px', touchAction: 'manipulation' }}>LOAD</button>
                    <button onClick={() => addBlock(l.id)} className="px-2.5 py-1.5 rounded-md active:opacity-60 flex items-center gap-1" style={{ background: '#15151c', border: `1px solid ${COLORS.song}55`, color: COLORS.song, fontFamily: PS, fontSize: '8px', touchAction: 'manipulation' }}><Plus size={10} /> SONG</button>
                    <button onClick={() => deleteLoop(l.id)} className="w-8 h-8 flex items-center justify-center rounded-md active:opacity-60 shrink-0" style={{ background: '#1a1010', border: '1px solid #3a1a1a', color: '#ff8877', touchAction: 'manipulation' }}><Trash2 size={12} /></button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* GLOBAL */}
          <div className="rounded-lg p-3" style={{ background: 'linear-gradient(180deg, #1a1418, #15101a)', border: '1px solid #2a2025' }}>
            <div className="flex items-center gap-1.5 mb-3"><Power size={10} className="text-stone-500" /><span className="text-[8px] uppercase tracking-widest text-stone-400" style={{ fontFamily: PS }}>GLOBAL</span></div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 items-end">
              <Fader label="Tempo" value={bpm} min={60} max={220} step={1} onChange={setBpm} color={COLORS.cream} unit=" bpm" />
              <Fader label="Master" value={masterVol} min={0} max={1} onChange={setMasterVol} color={COLORS.cream} />
              <Fader label="Swing" value={swing} min={0} max={0.5} onChange={setSwing} color={COLORS.cream} />
              <Toggle label="Key" value={rootNote} options={[{ value: 33, label: 'A1' }, { value: 38, label: 'D2' }, { value: 40, label: 'E2' }, { value: 43, label: 'G2' }, { value: 45, label: 'A2' }, { value: 48, label: 'C3' }]} onChange={setRootNote} color={COLORS.cream} />
              <div className="col-span-1 sm:col-span-2"><Toggle label="Scale" value={scaleName} options={Object.keys(SCALES).map((s) => ({ value: s, label: s.split(' ')[0].slice(0, 4).toUpperCase() }))} onChange={setScaleName} color={COLORS.cream} /></div>
            </div>
          </div>

          {/* ECHO */}
          <div className="rounded-lg p-3" style={{ background: `linear-gradient(180deg, ${COLORS.echo}12, transparent)`, border: `1px solid ${COLORS.echo}25` }}>
            <div className="flex items-center gap-2 mb-3"><Waves size={12} style={{ color: COLORS.echo, animation: 'echoPulse 2.4s ease-in-out infinite' }} /><span className="text-[10px] tracking-[0.2em]" style={{ fontFamily: PS, color: COLORS.echo }}>ECHO</span><span className="text-[7px] tracking-[0.15em] text-stone-500" style={{ fontFamily: PS }}>／ FAKE-VERB · BPM-SYNCED</span></div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
              <Toggle label="Time" value={echo.timeMode} options={Object.keys(ECHO_TIMES).map((k) => ({ value: k, label: k }))} onChange={(v) => setEcho({ ...echo, timeMode: v })} color={COLORS.echo} />
              <Fader label="Feedback" value={echo.feedback} min={0} max={0.85} onChange={(v) => setEcho({ ...echo, feedback: v })} color={COLORS.echo} />
              <Fader label="Tone" value={echo.tone} min={400} max={8000} step={50} onChange={(v) => setEcho({ ...echo, tone: v })} color={COLORS.echo} unit="hz" />
              <Fader label="Output" value={echo.wet} min={0} max={1} onChange={(v) => setEcho({ ...echo, wet: v })} color={COLORS.echo} />
            </div>
          </div>

          <div className="text-center text-[7px] tracking-widest text-stone-600 pt-1" style={{ fontFamily: PS }}>© yuccabuccA</div>
        </div>
        )}

        {/* ================= SONG MODE ================= */}
        {mode === 'song' && (
        <div className="p-3 sm:p-5 space-y-4">
          {/* transport extras */}
          <div className="rounded-lg p-3" style={{ background: 'linear-gradient(180deg, #1a1418, #15101a)', border: '1px solid #2a2025' }}>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 items-end">
              <Fader label="Tempo" value={bpm} min={60} max={220} step={1} onChange={setBpm} color={COLORS.cream} unit=" bpm" />
              <Fader label="Master" value={masterVol} min={0} max={1} onChange={setMasterVol} color={COLORS.cream} />
              <Fader label="Swing" value={swing} min={0} max={0.5} onChange={setSwing} color={COLORS.cream} />
            </div>
          </div>

          {/* arrangement timeline */}
          <div className="rounded-lg p-3" style={{ background: `linear-gradient(180deg, ${COLORS.song}10, transparent)`, border: `1px solid ${COLORS.song}30` }}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2"><ListMusic size={12} style={{ color: COLORS.song }} /><span className="text-[10px] tracking-[0.2em]" style={{ fontFamily: PS, color: COLORS.song }}>ARRANGEMENT</span></div>
              <span className="text-[8px] tracking-wider text-stone-500" style={{ fontFamily: PS }}>{arrangement.length} BLOCKS · {totalBars} BARS</span>
            </div>

            {arrangement.length === 0 ? (
              <div className="text-[8px] tracking-wider text-stone-500 py-4 text-center leading-relaxed" style={{ fontFamily: PS }}>EMPTY ARRANGEMENT.<br />ADD SAVED LOOPS FROM THE LIBRARY BELOW TO BUILD A SONG.</div>
            ) : (
              <div className="space-y-1.5">
                {arrangement.map((b, i) => {
                  const active = i === activeBlock && isPlaying;
                  return (
                    <div key={b.id} className="flex items-center gap-2 rounded-md px-2 py-2" style={{ background: active ? `${COLORS.song}22` : '#0c0c12', border: `1.5px solid ${active ? COLORS.song : '#1f1f29'}`, boxShadow: active ? `0 0 12px ${COLORS.song}55` : 'none', transition: 'all 80ms' }}>
                      <span className="w-5 text-center text-[10px] tabular-nums" style={{ fontFamily: PS, color: active ? COLORS.song : '#666' }}>{i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <div className="truncate text-[14px] leading-tight" style={{ fontFamily: 'VT323, monospace', color: COLORS.cream }}>{libName(b.loopId)}</div>
                        {maskHasAny(b.mutes) && <div className="flex items-center gap-1 mt-0.5">{tabs.filter((t) => b.mutes[t.key]).map((t) => (<span key={t.key} className="text-[6px] tracking-wider px-1 rounded-[2px]" style={{ fontFamily: PS, color: t.color, border: `1px solid ${t.color}55`, opacity: 0.7 }}>{t.label}</span>))}<span className="text-[6px] tracking-wider text-stone-500" style={{ fontFamily: PS }}>MUTED</span></div>}
                        {active && <div className="text-[7px] tracking-wider" style={{ fontFamily: PS, color: COLORS.song }}>BAR {activeBar + 1}/{b.repeats}</div>}
                      </div>
                      <div style={{ width: 88 }}><Stepper label="" value={b.repeats} min={1} max={8} onChange={(v) => setRepeats(b.id, v)} color={COLORS.song} fmt={(v) => `×${v}`} /></div>
                      <div className="flex flex-col gap-0.5">
                        <button onClick={() => moveBlock(b.id, -1)} className="w-7 h-4 flex items-center justify-center rounded active:opacity-60" style={{ background: '#15151c', border: '1px solid #2a2a35', color: '#aaa', touchAction: 'manipulation' }}><ChevronUp size={11} /></button>
                        <button onClick={() => moveBlock(b.id, 1)} className="w-7 h-4 flex items-center justify-center rounded active:opacity-60" style={{ background: '#15151c', border: '1px solid #2a2a35', color: '#aaa', touchAction: 'manipulation' }}><ChevronDown size={11} /></button>
                      </div>
                      <button onClick={() => removeBlock(b.id)} className="w-8 h-8 flex items-center justify-center rounded-md active:opacity-60 shrink-0" style={{ background: '#1a1010', border: '1px solid #3a1a1a', color: '#ff8877', touchAction: 'manipulation' }}><X size={13} /></button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* library palette to add from */}
          <div className="rounded-lg p-3" style={{ background: 'linear-gradient(180deg, rgba(40,35,40,0.5), rgba(20,18,22,0.5))', border: '1px solid #2a2a35' }}>
            <div className="flex items-center gap-2 mb-3"><FolderOpen size={12} className="text-stone-400" /><span className="text-[9px] tracking-[0.2em] text-stone-300" style={{ fontFamily: PS }}>ADD FROM LIBRARY</span></div>
            {library.length === 0 ? (
              <div className="text-[8px] tracking-wider text-stone-500 py-2 text-center" style={{ fontFamily: PS }}>SAVE A LOOP IN LOOP MODE FIRST.</div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                {library.map((l) => (
                  <button key={l.id} onClick={() => addBlock(l.id)} className="flex items-center gap-1.5 px-2.5 py-2 rounded-md active:translate-y-px text-left" style={{ background: '#0c0c12', border: `1px solid ${COLORS.song}40`, touchAction: 'manipulation' }}>
                    <Plus size={11} style={{ color: COLORS.song }} className="shrink-0" />
                    <span className="flex-1 truncate text-[13px]" style={{ fontFamily: 'VT323, monospace', color: COLORS.cream }}>{l.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="text-center text-[7px] tracking-widest text-stone-600 pt-1" style={{ fontFamily: PS }}>© yuccabuccA</div>
        </div>
        )}

        {/* ================= GROOVE MODE ================= */}
        {mode === 'groove' && (
        <div className="p-3 sm:p-5 space-y-4">
          {/* transport extras + launch settings */}
          <div className="rounded-lg p-3 space-y-3" style={{ background: 'linear-gradient(180deg, #1a1418, #15101a)', border: '1px solid #2a2025' }}>
            <div className="grid grid-cols-3 gap-3 items-end">
              <Fader label="Tempo" value={bpm} min={60} max={220} step={1} onChange={setBpm} color={COLORS.cream} unit=" bpm" />
              <Fader label="Master" value={masterVol} min={0} max={1} onChange={setMasterVol} color={COLORS.cream} />
              <Fader label="Swing" value={swing} min={0} max={0.5} onChange={setSwing} color={COLORS.cream} />
            </div>
            <div className="grid grid-cols-2 gap-3 items-end">
              <Toggle label="Launch Quantize" value={groove.launchMode} options={[{ value: '1/4', label: '1/4' }, { value: '1/2', label: '1/2' }, { value: 'bar', label: 'BAR' }, { value: 'end', label: 'END' }]} onChange={(v) => setGroove((g) => ({ ...g, launchMode: v }))} color={COLORS.song} />
              <Toggle label="Phase Lock" value={groove.phaseLock ? 'on' : 'off'} options={[{ value: 'on', label: 'SYNC' }, { value: 'off', label: 'RESTART' }]} onChange={(v) => setGroove((g) => ({ ...g, phaseLock: v === 'on' }))} color={COLORS.song} />
            </div>
          </div>

          {/* scene grid */}
          <div className="rounded-lg p-3" style={{ background: `linear-gradient(180deg, ${COLORS.song}10, transparent)`, border: `1px solid ${COLORS.song}30` }}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2"><Zap size={12} style={{ color: COLORS.song }} /><span className="text-[10px] tracking-[0.2em]" style={{ fontFamily: PS, color: COLORS.song }}>SCENES</span></div>
              <span className="text-[8px] tracking-wider text-stone-500" style={{ fontFamily: PS }}>TAP FIRE · TAP MUTE · HOLD SOLO</span>
            </div>

            {library.length === 0 ? (
              <div className="text-[8px] tracking-wider text-stone-500 py-4 text-center leading-relaxed" style={{ fontFamily: PS }}>NO SCENES YET.<br />SAVE LOOPS IN LOOP MODE — EACH BECOMES A SCENE.</div>
            ) : (
              <div className="space-y-2">
                {library.map((l) => {
                  const content = channelsWithContent(l.data);
                  const isActive = grooveActive === l.id;
                  const isQueued = grooveQueued === l.id;
                  const mutes = grooveMutes[l.id] || {};
                  return (
                    <div key={l.id} className="rounded-md overflow-hidden" style={{ background: '#0c0c12', border: `1.5px solid ${isActive ? COLORS.song : isQueued ? `${COLORS.song}88` : '#1f1f29'}`, boxShadow: isActive && isPlaying ? `0 0 14px ${COLORS.song}66` : 'none', transition: 'border-color 80ms, box-shadow 80ms' }}>
                      <button onClick={() => fireScene(l.id)} className="w-full flex items-center gap-2.5 px-3 py-2.5 active:translate-y-px text-left" style={{ background: isActive ? `${COLORS.song}1f` : 'transparent', touchAction: 'manipulation' }}>
                        <div className="w-8 h-8 flex items-center justify-center rounded-md shrink-0" style={{ background: isActive ? COLORS.song : '#15151c', border: `1px solid ${isActive ? COLORS.song : COLORS.song + '55'}`, color: isActive ? '#0a0a0f' : COLORS.song, animation: isQueued ? 'grooveQueue 0.6s ease-in-out infinite' : 'none' }}>
                          <Play size={13} fill="currentColor" />
                        </div>
                        <span className="flex-1 truncate text-[15px] leading-tight" style={{ fontFamily: 'VT323, monospace', color: COLORS.cream }}>{l.name}</span>
                        {isQueued ? (
                          <span className="text-[7px] tracking-widest shrink-0" style={{ fontFamily: PS, color: COLORS.song, animation: 'grooveQueue 0.6s ease-in-out infinite' }}>QUEUED</span>
                        ) : isActive && isPlaying ? (
                          <span className="text-[7px] tracking-widest shrink-0" style={{ fontFamily: PS, color: COLORS.song }}>LIVE</span>
                        ) : null}
                      </button>
                      <div className="flex gap-1 px-2 pb-2">
                        {tabs.filter((t) => content[t.key]).map((t) => (
                          <ChannelChip key={t.key} label={t.label} color={t.color}
                            soloed={!!(grooveSolo && grooveSolo[t.key])}
                            dim={grooveSolo ? !grooveSolo[t.key] : !!mutes[t.key]}
                            onMute={() => toggleSceneMute(l.id, t.key)} onSolo={() => toggleSolo(t.key)} />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* capture to SONG */}
          <div className="rounded-lg p-3" style={{ background: 'linear-gradient(180deg, rgba(40,35,40,0.5), rgba(20,18,22,0.5))', border: '1px solid #2a2a35' }}>
            <div className="flex items-center gap-2 mb-3"><Layers size={12} style={{ color: COLORS.song }} /><span className="text-[9px] tracking-[0.2em] text-stone-300" style={{ fontFamily: PS }}>CAPTURE PERFORMANCE</span></div>
            <div className="flex items-end gap-3">
              <div style={{ width: 120 }}><Stepper label="Last bars" value={captureBars} min={1} max={64} onChange={setCaptureBars} color={COLORS.song} /></div>
              <button onClick={captureToSong} className="flex-1 h-7 rounded-md flex items-center justify-center gap-1.5 active:translate-y-px" style={{ background: `${COLORS.song}22`, border: `1.5px solid ${COLORS.song}`, color: COLORS.song, fontFamily: PS, fontSize: '9px', touchAction: 'manipulation' }}><Layers size={11} />CAPTURE → SONG</button>
            </div>
            {grooveSolo && <div className="text-[7px] tracking-wider text-stone-500 mt-2" style={{ fontFamily: PS }}>SOLO ACTIVE — HOLD A LIT CHIP AGAIN TO CLEAR. CAPTURE RECORDS MUTES, NOT SOLO.</div>}
          </div>

          <div className="text-center text-[7px] tracking-widest text-stone-600 pt-1" style={{ fontFamily: PS }}>© yuccabuccA</div>
        </div>
        )}
      </div>

      <NoteInspector note={selNote} color={activeColor} rowCount={rowCount} pitchLabel={makeRowLabel(selOctave)} onChange={(updated) => updateChannelNotes(selected.channel, (ns) => ns.map((n) => n.id === updated.id ? updated : n))} onDelete={() => { updateChannelNotes(selected.channel, (ns) => ns.filter((n) => n.id !== selected.id)); setSelected(null); }} onClose={() => setSelected(null)} />

      {/* ===== YUCCA-FX SAMPLE BROWSER ===== */}
      {fxBrowser !== null && (
        <div className="fixed inset-0 z-50 flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={() => setFxBrowser(null)}>
          <div className="w-full max-w-[1400px] rounded-t-xl p-4" style={{ background: 'linear-gradient(180deg, #12181a, #0a0d0f)', border: `2px solid ${COLORS.samples}55`, boxShadow: `0 -10px 40px rgba(0,0,0,0.6), 0 0 24px ${COLORS.samples}22`, animation: 'slideUp 160ms ease-out', maxHeight: '70vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <FolderOpen size={14} style={{ color: COLORS.samples }} />
                <span className="text-[11px] tracking-widest" style={{ fontFamily: PS, color: COLORS.samples }}>FROM YUCCA-FX</span>
                <span className="text-[8px] text-stone-500" style={{ fontFamily: 'VT323, monospace' }}>→ SLOT {fxBrowser + 1}</span>
              </div>
              <button onClick={() => setFxBrowser(null)} className="w-8 h-8 flex items-center justify-center rounded-md active:opacity-60" style={{ background: '#1a1a22', border: '1px solid #3a3a45', color: COLORS.cream, touchAction: 'manipulation' }}><X size={14} /></button>
            </div>
            {/* SAMPLES (rendered blobs) | PRESETS (live patch voices) */}
            <div className="grid grid-cols-2 gap-1.5 mb-3">
              {[{ k: 'samples', label: `SAMPLES (${fxList.length})` }, { k: 'presets', label: `PRESETS (${fxPresets.length})` }].map((tb) => {
                const on = fxTab === tb.k;
                return (<button key={tb.k} onClick={() => setFxTab(tb.k)} className="py-2 rounded-md active:translate-y-px" style={{ background: on ? `${COLORS.samples}22` : '#0c0c12', border: `1.5px solid ${on ? COLORS.samples : '#1f1f29'}`, color: on ? COLORS.samples : '#888', fontFamily: PS, fontSize: '9px', touchAction: 'manipulation' }}>{tb.label}</button>);
              })}
            </div>
            {fxTab === 'samples' ? (
              fxList.length === 0 ? (
                <div className="text-[8px] tracking-wider text-stone-500 py-6 text-center leading-relaxed" style={{ fontFamily: PS }}>NO SHARED SAMPLES YET.<br />EXPORT A SOUND FROM YUCCA-FX, OR LOAD A LOCAL FILE — BOTH LAND HERE.</div>
              ) : (
                <div className="space-y-1.5">
                  {fxList.map((r) => (
                    <div key={r.id} className="flex items-center gap-2 rounded-md px-2.5 py-2" style={{ background: '#0c0c12', border: '1px solid #1f1f29' }}>
                      <Music size={11} style={{ color: COLORS.samples }} className="shrink-0" />
                      <span className="flex-1 truncate text-[14px]" style={{ fontFamily: 'VT323, monospace', color: COLORS.cream }}>{r.name}</span>
                      <span className="text-[7px] tracking-wider text-stone-500 shrink-0" style={{ fontFamily: PS }}>{r.mime === 'audio/mpeg' ? 'MP3' : 'WAV'}</span>
                      <button onClick={() => loadFromLibrary(fxBrowser, r.id)} className="px-2.5 py-1.5 rounded-md active:opacity-60" style={{ background: '#15151c', border: `1px solid ${COLORS.lead}55`, color: COLORS.lead, fontFamily: PS, fontSize: '8px', touchAction: 'manipulation' }}>LOAD</button>
                      <button onClick={async () => { await YuccaSamples.remove(r.id); setFxList((xs) => xs.filter((x) => x.id !== r.id)); }} className="w-8 h-8 flex items-center justify-center rounded-md active:opacity-60 shrink-0" style={{ background: '#1a1010', border: '1px solid #3a1a1a', color: '#ff8877', touchAction: 'manipulation' }}><Trash2 size={12} /></button>
                    </div>
                  ))}
                </div>
              )
            ) : (
              fxPresets.length === 0 ? (
                <div className="text-[8px] tracking-wider text-stone-500 py-6 text-center leading-relaxed" style={{ fontFamily: PS }}>NO SHARED PRESETS YET.<br />SAVE A PRESET IN YUCCA-FX — IT BECOMES A PLAYABLE VOICE HERE.</div>
              ) : (
                <div className="space-y-1.5">
                  {fxPresets.map((r) => (
                    <div key={r.id} className="flex items-center gap-2 rounded-md px-2.5 py-2" style={{ background: '#0c0c12', border: '1px solid #1f1f29' }}>
                      <Waves size={11} style={{ color: COLORS.samples }} className="shrink-0" />
                      <span className="flex-1 truncate text-[14px]" style={{ fontFamily: 'VT323, monospace', color: COLORS.cream }}>{r.name}</span>
                      <span className="text-[7px] tracking-wider text-stone-500 shrink-0" style={{ fontFamily: PS }}>{(r.patch && r.patch.osc && r.patch.osc.type ? r.patch.osc.type.slice(0, 3) : 'SYN').toUpperCase()}</span>
                      <button onClick={() => loadPresetIntoSlot(fxBrowser, r)} className="px-2.5 py-1.5 rounded-md active:opacity-60" style={{ background: '#15151c', border: `1px solid ${COLORS.lead}55`, color: COLORS.lead, fontFamily: PS, fontSize: '8px', touchAction: 'manipulation' }}>LOAD</button>
                    </div>
                  ))}
                </div>
              )
            )}
          </div>
        </div>
      )}

      {/* ===== PROJECTS ===== */}
      {projOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={() => setProjOpen(false)}>
          <div className="w-full max-w-[1400px] rounded-t-xl p-4" style={{ background: 'linear-gradient(180deg, #18141c, #0c0a10)', border: `2px solid ${COLORS.song}55`, boxShadow: `0 -10px 40px rgba(0,0,0,0.6), 0 0 24px ${COLORS.song}22`, animation: 'slideUp 160ms ease-out', maxHeight: '78vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <FolderOpen size={14} style={{ color: COLORS.song }} />
                <span className="text-[11px] tracking-widest" style={{ fontFamily: PS, color: COLORS.song }}>PROJECTS</span>
                <span className="text-[8px] text-stone-500" style={{ fontFamily: 'VT323, monospace' }}>({projects.length})</span>
              </div>
              <button onClick={() => setProjOpen(false)} className="w-8 h-8 flex items-center justify-center rounded-md active:opacity-60" style={{ background: '#1a1a22', border: '1px solid #3a3a45', color: COLORS.cream, touchAction: 'manipulation' }}><X size={14} /></button>
            </div>
            {/* save row */}
            <div className="flex items-center gap-2 mb-3">
              <input className="namefield flex-1 px-3 py-2 rounded-md outline-none" value={projDraft} onChange={(e) => setProjDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveProject(false); }} maxLength={28} placeholder="project name…" style={{ background: '#0a0a0f', border: `1.5px solid ${COLORS.song}`, color: COLORS.cream, fontSize: '16px' }} />
              <button onClick={() => saveProject(false)} className="flex items-center gap-1 px-3 py-2 rounded-md active:opacity-60" style={{ background: COLORS.song, color: '#0a0a0f', fontFamily: PS, fontSize: '9px', touchAction: 'manipulation' }}><Save size={11} /> SAVE</button>
              {currentProject.id && <button onClick={() => saveProject(true)} className="px-3 py-2 rounded-md active:opacity-60" style={{ background: '#15151c', border: `1px solid ${COLORS.song}55`, color: COLORS.song, fontFamily: PS, fontSize: '8px', touchAction: 'manipulation' }}>SAVE AS</button>}
            </div>
            <button onClick={newProject} className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-md active:translate-y-px mb-3" style={{ background: '#0c0c12', border: `1.5px dashed ${COLORS.song}66`, color: COLORS.song, fontFamily: PS, fontSize: '9px', touchAction: 'manipulation' }}><FilePlus size={12} /> NEW PROJECT</button>
            {projects.length === 0 ? (
              <div className="text-[8px] tracking-wider text-stone-500 py-6 text-center leading-relaxed" style={{ fontFamily: PS }}>NO SAVED PROJECTS YET.<br />NAME ONE ABOVE AND SAVE — IT KEEPS ALL LOOPS, SONGS, SOUNDS AND SETTINGS.</div>
            ) : (
              <div className="space-y-1.5">
                {projects.slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)).map((p) => {
                  const cur = p.id === currentProject.id;
                  return (
                    <div key={p.id} className="flex items-center gap-2 rounded-md px-2.5 py-2" style={{ background: cur ? `${COLORS.song}1a` : '#0c0c12', border: `1px solid ${cur ? COLORS.song : '#1f1f29'}` }}>
                      <Music size={11} style={{ color: COLORS.song }} className="shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="truncate text-[14px] leading-tight" style={{ fontFamily: 'VT323, monospace', color: COLORS.cream }}>{p.name}{cur ? ' ·' : ''}</div>
                        <div className="text-[7px] tracking-wider text-stone-500" style={{ fontFamily: PS }}>{new Date(p.savedAt).toLocaleDateString()} {new Date(p.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                      </div>
                      <button onClick={() => loadProject(p.id)} className="px-2.5 py-1.5 rounded-md active:opacity-60" style={{ background: '#15151c', border: `1px solid ${COLORS.lead}55`, color: COLORS.lead, fontFamily: PS, fontSize: '8px', touchAction: 'manipulation' }}>LOAD</button>
                      <button onClick={() => deleteProject(p.id)} className="w-8 h-8 flex items-center justify-center rounded-md active:opacity-60 shrink-0" style={{ background: '#1a1010', border: '1px solid #3a1a1a', color: '#ff8877', touchAction: 'manipulation' }}><Trash2 size={12} /></button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===== CONFIRM DIALOG ===== */}
      {confirmCfg && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)' }} onClick={() => setConfirmCfg(null)}>
          <div className="w-full max-w-md rounded-xl p-4" style={{ background: 'linear-gradient(180deg, #1a1418, #0d0a0f)', border: `2px solid ${(confirmCfg.accent || COLORS.bass)}66`, boxShadow: `0 10px 40px rgba(0,0,0,0.7), 0 0 24px ${(confirmCfg.accent || COLORS.bass)}22`, animation: 'slideUp 140ms ease-out' }} onClick={(e) => e.stopPropagation()}>
            <div className="text-[11px] tracking-widest mb-2" style={{ fontFamily: PS, color: confirmCfg.accent || COLORS.bass }}>{confirmCfg.title}</div>
            <div className="text-[13px] leading-relaxed mb-4" style={{ fontFamily: 'VT323, monospace', color: COLORS.cream }}>{confirmCfg.message}</div>
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setConfirmCfg(null)} className="px-4 py-2 rounded-md active:translate-y-px" style={{ background: '#1a1a22', border: '1px solid #3a3a45', color: COLORS.cream, fontFamily: PS, fontSize: '9px', touchAction: 'manipulation' }}>{confirmCfg.cancelLabel || 'CANCEL'}</button>
              <button onClick={() => { const fn = confirmCfg.onConfirm; setConfirmCfg(null); if (fn) fn(); }} className="px-4 py-2 rounded-md active:translate-y-px" style={{ background: confirmCfg.accent || COLORS.bass, color: '#0a0a0f', fontFamily: PS, fontSize: '9px', boxShadow: `0 0 12px ${(confirmCfg.accent || COLORS.bass)}66`, touchAction: 'manipulation' }}>{confirmCfg.confirmLabel || 'CONFIRM'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== TOAST (action feedback) ===== */}
      {toast && (
        <div className="fixed left-1/2 z-[70] pointer-events-none" style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 24px)', transform: 'translateX(-50%)', animation: 'slideUp 140ms ease-out' }}>
          <div className="px-4 py-2 rounded-md flex items-center gap-2" style={{ background: '#0a0a0f', border: `1.5px solid ${toast.color}`, boxShadow: `0 4px 16px rgba(0,0,0,0.6), 0 0 14px ${toast.color}55`, fontFamily: PS, fontSize: '9px', color: toast.color, whiteSpace: 'nowrap' }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: toast.color, boxShadow: `0 0 6px ${toast.color}` }} />
            {toast.msg}
          </div>
        </div>
      )}
    </div>
  );
}
