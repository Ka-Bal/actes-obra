// Emmagatzematge local (IndexedDB). Versió portàtil: totes les dades (obres, documentació i visites) viuen a la tauleta.
const DB_NAME = 'aventec-seguiment-obra-portatil';
const DB_VERSION = 2;
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = (ev) => {
        const d = r.result;
        const has = (n) => d.objectStoreNames.contains(n);
        if (ev.oldVersion < 1) {
          d.createObjectStore('kv');
          d.createObjectStore('obres', { keyPath: 'id' });
          d.createObjectStore('visites', { keyPath: 'id' }).createIndex('exp', 'exp');
          d.createObjectStore('items', { keyPath: 'id' }).createIndex('visitId', 'visitId');
          d.createObjectStore('blobs');
          d.createObjectStore('files', { keyPath: 'key' }).createIndex('exp', 'exp');
        }
        // v2: estat dels fitxers ja pujats a OneDrive (per visita)
        if (!has('remote')) d.createObjectStore('remote', { keyPath: 'visitId' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => console.warn('IndexedDB bloquejada per una altra pestanya');
    });
  }
  return dbPromise;
}

const p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

async function tx(store, mode, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    let out;
    Promise.resolve(fn(t.objectStore(store))).then((v) => { out = v; }, reject);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transacció avortada'));
  });
}

export const db = {
  get: (s, k) => tx(s, 'readonly', (st) => p(st.get(k))),
  put: (s, v, k) => tx(s, 'readwrite', (st) => p(k === undefined ? st.put(v) : st.put(v, k))),
  del: (s, k) => tx(s, 'readwrite', (st) => p(st.delete(k))),
  all: (s) => tx(s, 'readonly', (st) => p(st.getAll())),
  keys: (s) => tx(s, 'readonly', (st) => p(st.getAllKeys())),
  byIndex: (s, idx, v) => tx(s, 'readonly', (st) => p(st.index(idx).getAll(v))),
  keysByIndex: (s, idx, v) => tx(s, 'readonly', (st) => p(st.index(idx).getAllKeys(v))),
};

// ---- valors simples
export const kv = {
  get: (k, def = null) => db.get('kv', k).then((v) => (v === undefined ? def : v)),
  set: (k, v) => db.put('kv', v, k),
};

// ---- blobs (fotos, àudios, PDF anotats…)
export function uid() {
  const a = new Uint8Array(10); crypto.getRandomValues(a);
  return Date.now().toString(36) + Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 14);
}
export async function putBlob(blob, id = uid()) { await db.put('blobs', blob, id); return id; }
export const getBlob = (id) => (id ? db.get('blobs', id) : Promise.resolve(null));
export const delBlob = (id) => (id ? db.del('blobs', id) : Promise.resolve());

/** Hash ràpid (FNV-1a 53 bits) per detectar canvis de contingut en text. */
export function hash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch { /* no disponible */ }
  return false;
}
