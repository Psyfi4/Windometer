'use client';

/**
 * The run library.
 *
 * IndexedDB, in the visitor's browser. There is no server behind this site —
 * that is what lets a 333,000-row record train at all, and what makes the
 * claim on the landing page true — so a saved run lives on the machine that
 * produced it.
 *
 * What that means in practice, and it is worth being plain about it:
 *
 *   - Runs are per-browser. Chrome will not see what Firefox saved.
 *   - Clearing site data removes them, like any other browser storage.
 *   - Nothing is shared between people or devices.
 *
 * exportAll and importAll close that gap: a library is a plain JSON file that
 * can be moved, archived or handed to someone else. That is deliberately the
 * only way runs travel, rather than a hosted database, which would need
 * credentials and would break the promise that nothing leaves the machine.
 *
 * Written against the raw IDB API rather than a wrapper, to keep the bundle
 * free of a dependency for what amounts to four operations.
 */

const DB_NAME = 'windlab';
const DB_VERSION = 2;
const STORE = 'runs';
const SESSION = 'session';

let dbPromise = null;

function open() {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('This browser has no IndexedDB, so runs cannot be saved.'));
  }
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          store.createIndex('savedAt', 'savedAt');
          store.createIndex('station', 'station');
        }
        if (!db.objectStoreNames.contains(SESSION)) {
          db.createObjectStore(SESSION);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(mode, fn, storeName = STORE) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let result;
    try {
      result = fn(store);
    } catch (err) {
      reject(err);
      return;
    }
    t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const wrap = (req) => ({ __req: req });

/** Store a record. Returns its assigned id. */
export function saveRun(record) {
  return tx('readwrite', (store) => wrap(store.add({ ...record, savedAt: record.savedAt ?? Date.now() })));
}

/** Every saved run, newest first. */
export function listRuns() {
  return tx('readonly', (store) => wrap(store.getAll()))
    .then((rows) => (rows ?? []).sort((a, b) => b.savedAt - a.savedAt));
}

export function getRun(id) {
  return tx('readonly', (store) => wrap(store.get(id)));
}

export function deleteRun(id) {
  return tx('readwrite', (store) => wrap(store.delete(id)));
}

export function clearAll() {
  return tx('readwrite', (store) => wrap(store.clear()));
}

/** Rename a saved run without disturbing anything else in it. */
export function renameRun(id, label) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    const store = t.objectStore(STORE);
    const req = store.get(id);
    req.onsuccess = () => {
      const rec = req.result;
      if (!rec) { reject(new Error('No run with that id.')); return; }
      rec.label = label;
      store.put(rec);
    };
    t.oncomplete = () => resolve(true);
    t.onerror = () => reject(t.error);
  }));
}

/* ------------------------------------------------------------------ *
 * Moving a library between machines
 * ------------------------------------------------------------------ */

export async function exportAll() {
  const runs = await listRuns();
  return JSON.stringify({
    format: 'windlab-run-library',
    version: 1,
    exportedAt: new Date().toISOString(),
    runs,
  }, null, 2);
}

/**
 * Merge a library file into this one.
 *
 * Ids are dropped on the way in so an imported run cannot overwrite a local
 * one that happens to share a number, and records already present — matched on
 * label and save time — are skipped rather than duplicated on repeat imports.
 */
export async function importAll(json) {
  let parsed;
  try {
    parsed = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!parsed || parsed.format !== 'windlab-run-library' || !Array.isArray(parsed.runs)) {
    throw new Error('That does not look like a Windlab run library.');
  }

  const existing = await listRuns();
  const seen = new Set(existing.map((r) => `${r.label}|${r.savedAt}`));
  let added = 0;
  let skipped = 0;

  for (const run of parsed.runs) {
    const key = `${run.label}|${run.savedAt}`;
    if (seen.has(key)) { skipped++; continue; }
    const { id, ...rest } = run;   // eslint-disable-line no-unused-vars
    await saveRun(rest);
    seen.add(key);
    added++;
  }
  return { added, skipped };
}

/** Rough size of the library, for the interface to report. */
export async function libraryStats() {
  const runs = await listRuns();
  const bytes = new Blob([JSON.stringify(runs)]).size;
  return { count: runs.length, bytes };
}


/* ------------------------------------------------------------------ *
 * The working session
 *
 * A run takes minutes. Losing it to a reload — a stray refresh, a crash, a
 * closed tab — meant doing it again, which is a poor trade for the storage it
 * saved. So the finished run is kept whole: the hourly series, the test block,
 * every model's predictions and everything derived from them.
 *
 * Typed arrays go in as typed arrays. IndexedDB stores by structured clone, so
 * a Float64Array is written as binary rather than expanded into a JSON list of
 * numbers, which is the difference between a few megabytes and tens of them.
 *
 * One slot, overwritten by each run. This is the last thing you were doing, not
 * an archive — the library beside it is the archive.
 * ------------------------------------------------------------------ */

const SESSION_KEY = 'latest';

export function saveSession(payload) {
  return tx('readwrite', (store) => wrap(store.put(
    { ...payload, savedAt: Date.now() },
    SESSION_KEY,
  )), SESSION);
}

export function loadSession() {
  return tx('readonly', (store) => wrap(store.get(SESSION_KEY)), SESSION);
}

export function clearSession() {
  return tx('readwrite', (store) => wrap(store.delete(SESSION_KEY)), SESSION);
}

/** Rough footprint of the stored session, for the interface to report. */
export async function sessionSize() {
  const s = await loadSession();
  if (!s) return 0;
  let bytes = 0;
  const walk = (v) => {
    if (!v) return;
    if (ArrayBuffer.isView(v)) { bytes += v.byteLength; return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') { Object.values(v).forEach(walk); return; }
    if (typeof v === 'string') bytes += v.length * 2;
    else if (typeof v === 'number') bytes += 8;
  };
  walk(s);
  return bytes;
}
