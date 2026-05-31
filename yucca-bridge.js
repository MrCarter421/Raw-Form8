// ============================================================================
// YUCCA-BRIDGE — shared sample library for the Yuccabucca apps.
//
// Both RAW FORM (this chiptune workstation) and YUCCA-FX (the sister sound-FX
// synth) are static pages on the same origin, so they can share one IndexedDB.
// Audio is stored as Blobs (binary, no 5 MB localStorage ceiling). RAW FORM
// reads samples back to repitch them; YUCCA-FX writes rendered WAV/MP3 blobs in.
//
// No build step. This is a plain ES module — import it directly:
//     import { YuccaSamples } from './yucca-bridge.js';
// In the zero-build index.html (Babel-standalone strips the `import`/`export`),
// the body below is inlined and `YuccaSamples` is also published on `window`,
// so the same code works whether bundled, imported, or inlined.
//
// IndexedDB layout:  db 'yuccabucca'  ·  store 'samples'  ·  keyPath 'id'
//   record = { id, name, createdAt, mime:'audio/wav'|'audio/mpeg', blob:Blob }
//
// Every method is async and defensive: if IndexedDB is missing or blocked
// (private mode, locked-down WebView) it degrades to a same-session in-memory
// Map instead of throwing, mirroring the app's Store adapter philosophy.
// ============================================================================

const DB_NAME = 'yuccabucca';
const STORE = 'samples';
const DB_VERSION = 1;

// In-memory fallback so a blocked/absent IndexedDB never throws.
const _mem = new Map();
const _idb = (typeof indexedDB !== 'undefined') ? indexedDB : null;

const _uid = () =>
  `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// Open (and lazily create) the database. Resolves null if IndexedDB is absent
// or the open fails, signalling callers to use the in-memory fallback.
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
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return _dbPromise;
}

// Run one transaction against the store; resolves the request result, or
// rejects so the caller's try/catch can fall back.
function _tx(mode, fn) {
  return _openDB().then((db) => {
    if (!db) return { _fallback: true };
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(STORE, mode); }
      catch (e) { reject(e); return; }
      const store = tx.objectStore(STORE);
      let out;
      try { out = fn(store); }
      catch (e) { reject(e); return; }
      tx.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  });
}

export const YuccaSamples = {
  // put({ name, blob, mime }) -> id   (createdAt + id are assigned here)
  async put({ name, blob, mime } = {}) {
    const rec = {
      id: _uid(),
      name: (name || 'sample').toString().slice(0, 48),
      createdAt: Date.now(),
      mime: mime || (blob && blob.type) || 'audio/wav',
      blob,
    };
    try {
      const r = await _tx('readwrite', (store) => { store.put(rec); return {}; });
      if (r && r._fallback) _mem.set(rec.id, rec);
    } catch (e) { _mem.set(rec.id, rec); }
    return rec.id;
  },

  // list() -> [{ id, name, createdAt, mime }]   (no blobs — keep it light)
  async list() {
    try {
      const r = await _tx('readonly', (store) => store.getAll());
      if (r && r._fallback) {
        return [..._mem.values()].map(({ id, name, createdAt, mime }) => ({ id, name, createdAt, mime }));
      }
      return (r || [])
        .map(({ id, name, createdAt, mime }) => ({ id, name, createdAt, mime }))
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch (e) {
      return [..._mem.values()].map(({ id, name, createdAt, mime }) => ({ id, name, createdAt, mime }));
    }
  },

  // get(id) -> { id, name, createdAt, mime, blob } | null
  async get(id) {
    try {
      const r = await _tx('readonly', (store) => store.get(id));
      if (r && r._fallback) return _mem.get(id) || null;
      return r || null;
    } catch (e) {
      return _mem.get(id) || null;
    }
  },

  // remove(id) -> void
  async remove(id) {
    try {
      const r = await _tx('readwrite', (store) => { store.delete(id); return {}; });
      if (r && r._fallback) _mem.delete(id);
    } catch (e) { _mem.delete(id); }
    _mem.delete(id);
  },
};

// Publish on window for the zero-build / inlined path (harmless when bundled).
if (typeof window !== 'undefined') window.YuccaSamples = YuccaSamples;
