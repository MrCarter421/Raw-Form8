// ============================================================================
// YUCCA-BRIDGE — shared library for the Yuccabucca apps (RAW FORM + YUCCA-FX).
//
// Both apps are static, no-build pages served from the same origin, so they
// share one IndexedDB. Two stores live side by side:
//   • 'samples' — rendered audio Blobs (WAV/MP3). RAW FORM's sampler loads these
//                 and repitches them; YUCCA-FX writes its exports here.
//   • 'presets' — YUCCA-FX patch JSON (parametric, tiny, serializable). RAW FORM
//                 can render these live per note; YUCCA-FX mirrors its bank here.
//
// No build step. Plain ES module:  import { YuccaSamples, YuccaPresets } from './yucca-bridge.js';
// Also published on `window` for the zero-build inlined path (RAW FORM's
// generated index.html inlines this; YUCCA-FX inlines a synced copy).
//
// IndexedDB:  db 'yuccabucca' (v2)  ·  stores keyed on 'id'
//   sample record = { id, name, createdAt, mime:'audio/wav'|'audio/mpeg', blob:Blob }
//   preset record = { id, name, createdAt, patch:object }
//
// Every method is async and defensive: a missing/blocked IndexedDB degrades to
// a same-session in-memory Map per store instead of throwing.
// ============================================================================

const DB_NAME = 'yuccabucca';
const DB_VERSION = 2;            // v1 = samples only; v2 added presets
const STORES = ['samples', 'presets'];

const _mem = { samples: new Map(), presets: new Map() };
const _idb = (typeof indexedDB !== 'undefined') ? indexedDB : null;
const _uid = (pfx) => `${pfx}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// Open (creating/upgrading) the database. Resolves null if IndexedDB is absent
// or the open fails — callers then fall back to the in-memory map.
let _dbPromise = null;
function _openDB() {
  if (!_idb) return Promise.resolve(null);
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve) => {
    let req;
    try { req = _idb.open(DB_NAME, DB_VERSION); }
    catch (e) { resolve(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      // Create any missing store; a v1 db (samples only) gains 'presets' here
      // without dropping existing samples.
      STORES.forEach((s) => { if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' }); });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return _dbPromise;
}

// Run one transaction against a store; resolves the request result, or a
// { _fallback:true } sentinel when there's no usable IndexedDB.
function _tx(storeName, mode, fn) {
  return _openDB().then((db) => {
    if (!db) return { _fallback: true };
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(storeName, mode); }
      catch (e) { reject(e); return; }
      const store = tx.objectStore(storeName);
      let out;
      try { out = fn(store); }
      catch (e) { reject(e); return; }
      tx.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  });
}

// Build a CRUD adapter for one store. `buildRecord` turns put() input into a
// stored record (and assigns id/createdAt); `project` strips heavy fields from
// list() results.
function _makeStore(storeName, buildRecord, project) {
  const mem = _mem[storeName];
  return {
    async put(input = {}) {
      const rec = buildRecord(input);
      try {
        const r = await _tx(storeName, 'readwrite', (store) => { store.put(rec); return {}; });
        if (r && r._fallback) mem.set(rec.id, rec);
      } catch (e) { mem.set(rec.id, rec); }
      return rec.id;
    },
    async list() {
      try {
        const r = await _tx(storeName, 'readonly', (store) => store.getAll());
        if (r && r._fallback) return [...mem.values()].map(project).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        return (r || []).map(project).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      } catch (e) {
        return [...mem.values()].map(project).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      }
    },
    async get(id) {
      try {
        const r = await _tx(storeName, 'readonly', (store) => store.get(id));
        if (r && r._fallback) return mem.get(id) || null;
        return r || null;
      } catch (e) { return mem.get(id) || null; }
    },
    async remove(id) {
      try {
        const r = await _tx(storeName, 'readwrite', (store) => { store.delete(id); return {}; });
        if (r && r._fallback) mem.delete(id);
      } catch (e) { mem.delete(id); }
      mem.delete(id);
    },
  };
}

// --- samples: rendered audio Blobs --------------------------------------------
// put({ name, blob, mime }) -> id   ·   list() omits blobs (keep it light)
export const YuccaSamples = _makeStore(
  'samples',
  ({ name, blob, mime }) => ({
    id: _uid('s'),
    name: (name || 'sample').toString().slice(0, 48),
    createdAt: Date.now(),
    mime: mime || (blob && blob.type) || 'audio/wav',
    blob,
  }),
  ({ id, name, createdAt, mime }) => ({ id, name, createdAt, mime }),
);

// --- presets: YUCCA-FX patch JSON ---------------------------------------------
// put({ id?, name, patch }) -> id   ·   id optional so callers can upsert by a
// stable key (YUCCA-FX passes its own preset id, making save/sync idempotent).
// patch is tiny, so list() includes it.
export const YuccaPresets = _makeStore(
  'presets',
  ({ id, name, patch }) => ({
    id: id || _uid('p'),
    name: (name || 'PRESET').toString().slice(0, 48),
    createdAt: Date.now(),
    patch: patch || {},
  }),
  ({ id, name, createdAt, patch }) => ({ id, name, createdAt, patch }),
);

// Publish on window for the zero-build / inlined path (harmless when bundled).
if (typeof window !== 'undefined') {
  window.YuccaSamples = YuccaSamples;
  window.YuccaPresets = YuccaPresets;
}
