#!/usr/bin/env node
// ============================================================================
// build-html.mjs — regenerate the zero-build index.html from source.
//
// This is a DEV-ONLY convenience, not a runtime build: the output index.html
// still deploys by copy (CDN React + Babel-standalone + Tailwind Play), exactly
// as the delivery model requires. Run it after editing the component:
//
//     node build-html.mjs
//
// What it does (the "same way it's produced now"):
//   1. Inlines yucca-bridge.js as a classic <script> (export stripped) so
//      `window.YuccaSamples` exists before the component runs.
//   2. Strips the ES imports + `export default` from ChiptuneWorkstation.jsx
//      and emits the body inside a <script type="text/babel">.
//   3. Injects inline SVG icon components in place of the lucide-react imports.
//   4. Mounts the component into #root.
// ============================================================================
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPONENT_SRC = 'chiptune-workstation.jsx';
const BRIDGE_SRC = 'yucca-bridge.js';
const OUT = 'index.html';

// --- lucide-react icons used by the component, as inline 24x24 stroke SVGs ----
// Paths trace the lucide originals; rendered via a tiny factory below.
const ICONS = {
  Play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  Square: '<rect width="18" height="18" x="3" y="3" rx="2"/>',
  Power: '<path d="M12 2v10"/><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/>',
  Waves: '<path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 12c.6.5 1.2 1 2.5 1C7 13 7 11 9.5 11c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M2 18c.6.5 1.2 1 2.5 1C7 19 7 17 9.5 17c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/>',
  Pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
  Sliders: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
  Eraser: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
  Trash2: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  X: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  Music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  Save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
  Repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  ListMusic: '<path d="M21 15V6"/><path d="M18.5 18a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"/><path d="M12 12H3"/><path d="M16 6H3"/><path d="M12 18H3"/>',
  ChevronUp: '<path d="m18 15-6-6-6 6"/>',
  ChevronDown: '<path d="m6 9 6 6 6-6"/>',
  Plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  FolderOpen: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"/>',
  Undo2: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
  Redo2: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13"/>',
  FilePlus: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 15h6"/><path d="M12 18v-6"/>',
  Zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  Layers: '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
};

const iconDefs = `
// --- inline SVG icons (drop-in for lucide-react) ---
const _Icon = (inner) => ({ size = 24, fill = 'none', strokeWidth = 2, style, className }) =>
  React.createElement('svg', {
    xmlns: 'http://www.w3.org/2000/svg', width: size, height: size, viewBox: '0 0 24 24',
    fill, stroke: 'currentColor', strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round',
    style, className, dangerouslySetInnerHTML: { __html: inner },
  });
${Object.entries(ICONS).map(([name, inner]) => `const ${name} = _Icon(${JSON.stringify(inner)});`).join('\n')}
`;

// --- read + transform sources ----------------------------------------------
const component = readFileSync(join(HERE, COMPONENT_SRC), 'utf8')
  // strip the three ES imports
  .replace(/^import React[^\n]*\n/m, '')
  .replace(/^import\s*\{[^}]*\}\s*from\s*'lucide-react';\n/m, '')
  .replace(/^import\s*\{[^}]*\}\s*from\s*'\.\/yucca-bridge\.js';\n/m, '')
  // make the default export a plain function declaration
  .replace(/export default function ChiptuneWorkstation/, 'function ChiptuneWorkstation');

// bridge: strip the `export` keywords so it becomes a classic-script global
const bridge = readFileSync(join(HERE, BRIDGE_SRC), 'utf8')
  .replace(/\bexport const /g, 'const ');

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
  <meta name="theme-color" content="#8a1a1c" />
  <title>RAW FORM — Chiptune Workstation</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&family=VT323&display=swap" rel="stylesheet" />
  <script src="https://cdn.tailwindcss.com"></script>
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <script>
    // Force the CLASSIC JSX runtime (React.createElement). Recent @babel/standalone
    // builds default the react preset to the AUTOMATIC runtime, which prepends
    // \`import { jsx } from "react/jsx-runtime"\` to the output — illegal in this
    // classic (non-module) inline script and a hard SyntaxError in Safari. The
    // text/babel script below uses data-presets="react-classic".
    if (window.Babel && Babel.registerPreset) {
      Babel.registerPreset('react-classic', { presets: [[Babel.availablePresets.react, { runtime: 'classic' }]] });
    }
  </script>
  <style>
    html, body { margin: 0; padding: 0; background: #050505; -webkit-text-size-adjust: 100%; }
    #root { min-height: 100vh; }
  </style>
</head>
<body>
  <div id="root"></div>

  <!-- Startup guard: shows LOADING, and turns a would-be black screen into a
       readable on-screen message if a CDN library fails to load or the app
       throws while mounting. Classic script so it runs even if Babel never does. -->
  <script>
(function(){
  var root=document.getElementById('root');
  if(root) root.innerHTML='<div style="color:#7fff7f;font:13px monospace;padding:24px">LOADING...</div>';
  window.__rfErr=function(m){ if(root) root.innerHTML='<div style="color:#ff5544;font:13px/1.6 monospace;padding:24px;white-space:pre-wrap;word-break:break-word">STARTUP ERROR\\n\\n'+String(m)+'\\n\\nThis page loads React, Babel and Tailwind from a CDN. If a script failed to load, check your connection (or an ad-blocker), then reload.</div>'; };
  window.addEventListener('error',function(e){ if(e&&e.target&&e.target.tagName==='SCRIPT'&&e.target.src) window.__rfErr('Failed to load:\\n'+e.target.src); else if(e&&e.message) window.__rfErr(e.message); },true);
  setTimeout(function(){ var m=[]; if(!window.React)m.push('React'); if(!window.ReactDOM)m.push('ReactDOM'); if(!window.Babel)m.push('Babel'); if(m.length) window.__rfErr('Libraries did not load: '+m.join(', ')); },8000);
})();
  </script>

  <!-- shared sample library (yucca-bridge.js, export stripped) -->
  <script>
${bridge}
  </script>

  <!-- the workstation component, transpiled in-browser. Wrapped in an IIFE so
       its top-level declarations stay isolated from the bridge script's globals
       (both define a private _mem fallback, for one). React, ReactDOM and
       YuccaSamples are reached as globals from inside. -->
  <script type="text/babel" data-presets="react-classic">
(function () {
const { useState, useEffect, useRef, useCallback } = React;
${iconDefs}
${component}

try {
  ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(ChiptuneWorkstation));
} catch (e) { if (window.__rfErr) window.__rfErr((e && e.stack) || e); else throw e; }
})();
  </script>
</body>
</html>
`;

writeFileSync(join(HERE, OUT), html);
console.log(`Wrote ${OUT} (${html.length} bytes) from ${COMPONENT_SRC} + ${BRIDGE_SRC}`);

// --- keep the other standalone pages' inlined bridge synced to source -------
// YUCCA-FX and RAW FORMLESS both run the shared bridge as a classic <script>
// before their main script (so window.YuccaSamples/Presets exist). We splice the
// export-stripped bridge between their markers so there's one source of truth.
const STANDALONE_PAGES = ['YUCCAFX/yucca-fx-8bit_v1_5.html', 'RAWFORMLESS/raw-formless.html'];
for (const page of STANDALONE_PAGES) {
  try {
    const pPath = join(HERE, page);
    const src = readFileSync(pPath, 'utf8');
    const block = `<!-- yucca-bridge:start -->
<script>
/* Shared Yuccabucca library — generated from /yucca-bridge.js by build-html.mjs.
   Do not edit here; edit yucca-bridge.js and re-run \`node build-html.mjs\`. */
${bridge}
</script>
<!-- yucca-bridge:end -->`;
    const next = src.replace(/<!-- yucca-bridge:start -->[\s\S]*?<!-- yucca-bridge:end -->/, block);
    if (next !== src) {
      writeFileSync(pPath, next);
      console.log(`Synced bridge into ${page}`);
    } else if (!/yucca-bridge:start/.test(src)) {
      console.warn(`No yucca-bridge markers found in ${page} — skipped.`);
    }
  } catch (e) {
    console.warn(`Could not sync bridge into ${page}: ${e.message}`);
  }
}
