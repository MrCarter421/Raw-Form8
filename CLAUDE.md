# RAW FORM — Chiptune Workstation (NES-8)

You are taking over development of this project. This file is the architecture brief and the working conventions; read it fully before editing, then see **Immediate Next Task** at the bottom for where to pick up.

It's a browser-based NES-style chiptune sequencer and mini-DAW: four-channel synth (bass / drums / lead / pad) plus a sampler, a touch-first piano roll, a loop library, and a song-arrangement timeline. It runs entirely client-side with no backend. The owner (Carter / yuccabuccA) ships it on yuccabucca.com and GitHub Pages, and produces music under the Raw Form name. Aesthetic is Famicom-red + phosphor-green CRT, pixel type (Press Start 2P + VT323), per-channel color coding.

## Delivery model & hard constraints

- **No build pipeline.** The owner deploys static files by committing/uploading them — no npm install on the host, no bundler step required to run. The shipped artifact is a single `index.html` that loads React, ReactDOM, and Babel-standalone from CDNs and Tailwind from the Play CDN, then transpiles the JSX in-browser. This is intentional; keep it deployable by copy.
- **Source of truth is `ChiptuneWorkstation.jsx`** — the full React component. `index.html` is a thin generated wrapper around it (strips the ES `import`/`export`, injects inline SVG icons in place of `lucide-react`, mounts the component). If you change the component, regenerate the HTML body the same way rather than hand-editing the inlined copy.
- If you want dev ergonomics (HMR, JSX precompile), Vite is acceptable **only** if the production output stays a static bundle that deploys by copying files — never anything that needs a Node server at runtime. Default to preserving the zero-build path unless the owner asks otherwise.
- **No external audio libraries.** Everything is raw Web Audio API. Don't pull in Tone.js or similar.

## File layout

```
index.html                        # zero-build runnable page (CDN React+Babel+Tailwind) — for GitHub Pages
chiptune-workstation.jsx          # the entire app: engine + UI, one React component file (source of truth)
build-html.mjs                    # dev-only: regenerates index.html + syncs the bridge into the standalone pages
yucca-bridge.js                   # shared IndexedDB library (samples + presets) — one source of truth
RAWFORMLESS/raw-formless.html     # RAW FORMLESS — standalone 8-bit ambience/drone engine (self-contained, like YUCCA-FX)
YUCCAFX/yucca-fx-8bit_v1_5.html   # YUCCA-FX — standalone NES SFX synth (sister tool)
CLAUDE.md                         # this file
```

**Sibling tools & the menu.** RAW FORM links out to the standalone tools by relative href (e.g. `RAWFORMLESS/raw-formless.html?from=rawform`) from the sampler's Sound Design row — that *is* the "Raw Form menu". Each standalone page links back with `../index.html`. They are self-contained HTML (CDN React+Babel+Tailwind) with the shared `yucca-bridge.js` spliced in between `<!-- yucca-bridge:start -->`/`<!-- yucca-bridge:end -->` markers; `node build-html.mjs` keeps every inlined copy in sync from the one source. Cross-tool audio flows through the bridge: a tool renders a WAV and calls `YuccaSamples.put({name, blob, mime})`, and it appears in RAW FORM's sampler under "FROM YUCCA-FX".

### RAW FORMLESS (`RAWFORMLESS/raw-formless.html`)
8-bit ambience/drone engine. `buildGraph(ctx, patch, dest, t0, dur)` builds the whole signal path (chip voices → lowpass → tremolo/amp → dry + parallel delay/reverb sends → soft-sat drive → volume) and serves **both** realtime preview (`AudioContext`) and offline bounce (`OfflineAudioContext`) from one codepath, so preview matches the render. Modulation is **assignable LFO slots** (target = volume/cutoff/pitch, depth + rate + shape), patched as `OscillatorNode → depthGain → AudioParam` so they render natively offline. `renderLoop()` does the **pop-free loop**: render `preRoll + loopLen + crossfade`, discard the pre-roll (so the body is steady-state), then equal-power crossfade the natural continuation just past the loop end back over the loop head, so end→start wraps seamlessly. Output is 16-bit WAV (`bufferToWav`), either downloaded or pushed to RAW FORM via `YuccaSamples.put`. Roadmap below covers what's still stubbed.

Everything currently lives in one component file by deliberate single-file bias. If it grows, the clean split is `engine.js` (pure, no React) + `ui/` (components) + `app.jsx`, but only split when it actually helps.

## Architecture

### Audio engine — `class NESEngine`
Pure Web Audio, no React references; instantiated once and held in a ref. Lazy-inits on first user gesture (browsers require a gesture to start an `AudioContext`).

Signal topology:

```
voices ──► master(GainNode) ──► WaveShaper(tanh soft-sat) ──► destination
   │
   └─(per-voice send)─► auxInput ──► DelayNode ──► lowpass(BiquadFilter) ──► wetGain ──► master
                                        ▲                                        
                                        └────────── feedbackGain ◄──────────────┘
```

- The **echo aux bus** is the classic NES "fake reverb" (the Zelda dotted-8th delay). `setEcho({time,feedback,tone,wet})` updates it smoothly; `time` is computed BPM-synced from a note division (`ECHO_TIMES`). Per-voice sends are wired by `_tapSend(node, level, dur)`, which spins up a short-lived gain into `auxInput` and disconnects it after the voice's lifetime.
- **Pulse voices** use `OscillatorNode.setPeriodicWave` with Fourier-built `PeriodicWave`s at four duty cycles (0.125/0.25/0.5/0.75), cached in `this.pulseWaves`.
- **Bass** is a native `triangle` osc (+ optional sub an octave down).
- **Noise/drums** use two pre-rendered `AudioBuffer`s: white noise, and a 6-bit short-mode LFSR buffer for the metallic timbres. `playDrum(type,…)` shapes kick/snare/hat/perc with per-type filters + envelopes.
- Voice methods: `playBass / playDrum / playLead / playPad / playSample`. Each takes an absolute `time` (from the scheduler), a duration, and an opts object. Velocity is folded into the gain by the caller (channel `volume × note.velocity`), so the engine itself is velocity-agnostic.
- **`playSample(buffer, time, dur, {volume,pan,semitones})`** plays a decoded `AudioBuffer` repitched via `playbackRate = 2^(semitones/12)`.

### Musical / scale model
`SCALES` maps names to one-octave interval arrays. The piano roll is **scale-collapsed**: rows are scale degrees (plus the octave), not chromatic keys, so each row is a fat touch target and every note is in-key. `rowToMidiWith(scaleName, rootNote, pitch, octave)` is the pure converter from a row index to a MIDI number; the engine then converts MIDI→Hz with `NOTE_FREQ`.

### State shape (all React `useState`)

```js
// globals
bpm 60..220 · masterVol 0..1 · swing 0..0.5 · rootNote (MIDI int) · scaleName (key of SCALES)

// a piano-roll note
{ id:'n#', start:0..15, length:1..(16-start), pitch:0..rowCount-1, velocity:0.05..1 }

bass    { volume, pan:-1..1, decay, sub:bool, octave, notes:Note[] }
drums   { volume, pan, sendSnare, sendHat, pattern:{ kick:bool[16], snare:bool[16], hat:bool[16], perc:bool[16] } }  // STEP GRID, not piano roll
lead    { volume, pan, duty(.125/.25/.5/.75), decay, vibrato, vibSpeed, arpMode, arpSpeed, octave, send, notes:Note[] }
pad     { volume, pan, duty, detune, attack, release, chord('Single'|'Octave'|'Fifth'|'Triad'|'Minor'), octave, send, notes:Note[] }
samples { masterVol, activeSlot, slots:[ { name, loaded:bool, volume, pitch:-24..24(semitones), notes:Note[] } ] × 4 }
echo    { timeMode('1/16'|'1/8'|'1/8.'|'1/4'), feedback:0..0.85, tone:400..8000(Hz), wet:0..1 }

// song features
Loop  (saved)  { id, name, data: snapshot({ bass, drums, lead, pad, samples, echo, rootNote, scaleName }) }
Block (arrange){ id, loopId, repeats:1..8 }
```

Persisted keys: **`cw_library`** (`Loop[]`) and **`cw_arrangement`** (`Block[]`).

**Sampler buffers are the one thing not in serializable state:** decoded `AudioBuffer`s live in `sampleBuffersRef` (a `useRef([null,null,null,null])`) because they can't be JSON'd. Slot *metadata* (name/loaded/volume/pitch/notes) is in state and travels inside a saved loop, but the actual audio is **session-only** today — reloading the page drops the buffers and the slots show as empty until re-loaded. Fixing this is the next task.

### Scheduler (the timing core — preserve this pattern)
A lookahead scheduler, not a timer-per-note. A `setInterval` (~25 ms) walks `nextStepTime` forward while it's within a ~100 ms lookahead window, scheduling each 16th-note step at an absolute Web Audio time; a `requestAnimationFrame` loop drives the visual playhead/active-block separately. `stepIdx` cycles 0..15. **Swing** delays odd 16ths. Do not replace this with `setTimeout`-per-hit — it'll drift and stutter.

`resolveSource()` is what makes one scheduler serve both modes:
- **LOOP mode** → schedules from live editor state (`bass/drums/lead/pad/samples`).
- **SONG mode** → reads `songCursorRef` (`{block, bar}`), looks up the current arrangement block's loop in the library, and schedules from that loop's snapshot. At each bar wrap it advances `bar`, and after `repeats` bars advances to the next block (wrapping at the end → the song loops). Each block applies its own loop's key/scale/echo as it becomes active; **tempo and swing stay global** so the whole song stays coherent.

### UI atoms & interaction model
Touch-first is the whole point — there are **no rotary knobs**.
- **`Fader`** — horizontal fill bar. The critical detail: `touch-action: pan-y` plus Pointer Events. On first move it decides direction — horizontal drag = adjust value (and captures the pointer), vertical drag = let the browser scroll. Tap-to-set on a clean tap. This is what stopped controls fighting page scroll on mobile; keep `touch-action: pan-y` on any new draggable horizontal control.
- **`Stepper`** — big +/- for small integer ranges (octave, repeats).
- **`Toggle`** — segmented tap buttons (duty, arp, chord, scale, echo time).
- **`PianoRoll`** — scale-collapsed grid with three edit modes: **draw** (tap a cell = note at brush length; swipe right from the cell = drag its length in one gesture; tap an existing note = open inspector; vertical drag = scroll, via `touch-action: pan-y`), **velo** (drag across notes, finger height paints velocity — shown as the fill level inside each note block; `touch-action: none`), **erase** (tap/drag over notes to delete). One roll component serves bass/lead/pad and the sampler's active slot.
- **`NoteInspector`** — bottom-sheet for precise single-note edits (velocity fader + length/pitch steppers + delete).
- **`DrumSeq`** — the step grid is deliberately kept for drums (4 lanes × 16), since per-hit on/off is the right model for percussion. Sampler uses the piano roll, drums do not.

### Persistence adapter — `Store`
Three-tier, all async, each layer wrapped so a missing/blocked backend never throws:
`window.storage` (Claude artifact host) → `localStorage` (yuccabucca.com / GitHub Pages) → in-memory `Map`. Same code runs in all three contexts. Library + arrangement are loaded once on mount and written back on change.

### Loop library & song arrangement
`snapshot()` deep-clones the full musical state into a named `Loop`. `recallLoop()` loads one back into the editor (reconciling each slot's `loaded` flag against whatever buffers are actually present in `sampleBuffersRef`). Arrangement ops: `addBlock / moveBlock / setRepeats / removeBlock`.

### Design tokens
`COLORS` (bass `#ff5544`, drums `#ffaa22`, lead `#7fff7f`, pad `#66bbff`, echo `#ff66cc`, song `#c9a0ff`, samples `#34e0c4`, cream `#f5ecd3`). Fonts: `Press Start 2P` (labels) + `VT323` (values). CRT scanline overlay via the `.crt::before` rule. Keep this language for anything new.

## Working conventions (owner preferences)

- **Edit style:** this component file is large — make **surgical, targeted edits**, not wholesale rewrites. Full-file rewrites are fine for *small* files only. Justify any simplification before doing it; the owner is a senior dev and wants the reasoning, not silent dumbing-down.
- **Verify syntax with a real parser, not by eye.** A naive bracket counter desyncs on regex literals, JSX, and apostrophes-in-comments — it produced two false "mismatch" alarms during this build. Use Babel (`@babel/parser` with the `jsx` plugin) or actually load the page; don't trust hand-rolled scanners.
- **Keep the engine UI-agnostic.** `NESEngine` should stay free of React; route all state through the scheduler's `opts` objects.
- **Mobile is the primary target.** Any new control must coexist with page scroll (the `touch-action: pan-y` rule) and have finger-sized hit areas.
- No emojis in UI copy; pixel/uppercase label style.

## Current state & known limitations

- **Sampler audio is session-only** (buffers in a ref, not persisted) — the headline gap.
- **One 16-step bar per loop.** No variable pattern length or multiple patterns per channel yet.
- **No audio export.** There's no render-to-WAV/MP3 yet (the sister app YUCCA-FX already does offline render — mirror that approach when it's time).
- **Song echo is applied at block boundaries**, not crossfaded.
- Minimap/zoom for the roll was intentionally deferred (single bar fits the width; revisit with longer patterns).

## Roadmap (priority order)

1. **Persist sampler audio + wire the YUCCA-FX bridge** (next task, detailed below).
2. **Audio export** via `OfflineAudioContext`: render the current loop (or the whole song) to a WAV blob, download it. Reuse the scheduler's per-step logic against an offline context. (YUCCA-FX already implements WAV/MP3 offline render — match its workflow.)
3. **Variable pattern length / multiple patterns** per channel; then a roll minimap.
4. **Song export** (render the full arrangement) once #2 lands.

## YUCCA-FX integration — context

YUCCA-FX (`yuccabucca.com/yucca-fx`) is the sister app: an NES sound-effect synth that **exports WAV/MP3** (one-shots via its Export Queue, plus short sequencer-recorded loops) and stores **JSON presets**. Both apps are static pages on the same origin, so the clean, no-server path is a **shared IndexedDB sample library** (same-origin pages share IndexedDB; use IndexedDB not localStorage because audio is binary and >5MB-friendly). Longer term, the most elegant option is extracting YUCCA-FX's synth into a shared ES module both apps import, so this app could store tiny presets and re-render them live at any pitch — but start with the audio-blob library; it's smaller and also solves sampler persistence.

### Target interface — shared `yucca-bridge.js` (ES module, no build step)

```js
// IndexedDB: db 'yuccabucca', store 'samples', keyPath 'id'
// record: { id, name, createdAt, mime:'audio/wav'|'audio/mpeg', blob:Blob }
export const YuccaSamples = {
  put({ name, blob, mime }),   // -> id
  list(),                      // -> [{ id, name, createdAt, mime }]   (no blobs)
  get(id),                     // -> { id, name, createdAt, mime, blob }
  remove(id),                  // -> void
};
```

- In **YUCCA-FX**, after it renders a WAV blob, call `await YuccaSamples.put({ name: presetName, blob: wavBlob, mime: 'audio/wav' })`. (Hand the owner a drop-in snippet for their export code; don't refactor YUCCA-FX wholesale.)
- In **this app**, the slot `LOAD` button gets a "From YUCCA-FX" tab → `YuccaSamples.list()` → on pick, `YuccaSamples.get(id)` → `blob.arrayBuffer()` → `ctx.decodeAudioData()` → store in `sampleBuffersRef[slot]`.

## Immediate Next Task

Implement **sampler persistence via the shared IndexedDB library**, which also delivers step 1 of the YUCCA-FX integration:

1. Add `yucca-bridge.js` implementing the `YuccaSamples` interface above (plain IndexedDB, async, defensive).
2. Extend each sampler slot's state with the **library record id** it was loaded from (e.g. `srcId`). Include `srcId` in the loop snapshot (it already serializes; the `AudioBuffer` does not).
3. On app mount / on loop recall, for any slot with a `srcId`, re-fetch from IndexedDB and `decodeAudioData` to repopulate `sampleBuffersRef` — so reloading the page or loading a saved loop restores the actual sound, fixing the session-only limitation.
4. Add a "From YUCCA-FX" source in the slot `LOAD` flow that lists library records and loads the chosen one (set `srcId`, decode into the slot). Keep the existing local file-picker `LOAD` as the other source.
5. Produce a copy-paste `YuccaSamples.put(...)` snippet for the owner to wire into YUCCA-FX's existing export code.

Keep edits surgical against `ChiptuneWorkstation.jsx`, preserve the lookahead scheduler and the `touch-action: pan-y` interaction rules, and verify with a real JSX parser (or by loading `index.html`) before declaring done. After changing the component, regenerate `index.html`'s embedded body the same way it's produced now (strip imports/export, inline icons, mount).
