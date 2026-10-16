// Persistent storage: IndexedDB for the library (games, folders, cached homebrew,
// save-state thumbnails) and localStorage for small settings.

const DB_NAME = 'play-tower';
const DB_VERSION = 1;
const STORES = ['games', 'dirs', 'blobs', 'thumbs', 'sources'];

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run(storeName, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const req = fn(store);
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const db = {
  get: (store, id) => run(store, 'readonly', (s) => s.get(id)).catch(() => undefined),
  all: (store) => run(store, 'readonly', (s) => s.getAll()).catch(() => []),
  put: (store, value) => run(store, 'readwrite', (s) => s.put(value)),
  putMany: (store, values) => run(store, 'readwrite', (s) => { for (const v of values) s.put(v); return null; }),
  del: (store, id) => run(store, 'readwrite', (s) => s.delete(id)),
  clear: (store) => run(store, 'readwrite', (s) => s.clear()),
};

// Settings ----------------------------------------------------------------

const SETTINGS_KEY = 'play-tower.settings';

export const DEFAULT_SETTINGS = {
  lang: 'ar',
  resolution: 2,
  aspect: '4:3',
  smooth: true,
  frameLimit: true,
  showFps: true,
  volume: 0.8,
  touch: 'auto',
  touchOpacity: 0.55,
  keys: null,
  filter: 'all',
  sort: 'recent',
  focusId: null,
};

let settings = { ...DEFAULT_SETTINGS };

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  return settings;
}

export function getSettings() {
  return settings;
}

export function saveSettings(patch) {
  settings = { ...settings, ...patch };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage can be unavailable (private mode); settings then last for this visit only.
  }
  return settings;
}

export async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    // Best effort only.
  }
}
