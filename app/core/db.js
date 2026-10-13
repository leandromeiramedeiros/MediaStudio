/* MS.db: IndexedDB "mediastudio". kv = handles, refs, queue, tab state (structured clone); thumbs = JPEG blobs by key. */
(() => {
  let dbp = null;
  const open = () => dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('mediastudio', 1);
    r.onupgradeneeded = () => { const d = r.result; d.createObjectStore('kv'); d.createObjectStore('thumbs'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => { dbp = null; rej(r.error); };
  });
  const tx = async (store, mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode), s = t.objectStore(store);
      let out; const rq = fn(s); if (rq) rq.onsuccess = () => { out = rq.result; };
      t.oncomplete = () => res(out); t.onerror = t.onabort = () => rej(t.error);
    });
  };
  const keysOf = (store, prefix = '') => tx(store, 'readonly', (s) => s.getAllKeys()).then((ks) => ks.filter((k) => String(k).startsWith(prefix)));

  MS.db = {
    get: (k) => tx('kv', 'readonly', (s) => s.get(k)),
    set: (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k)).then(() => {}),
    del: (k) => tx('kv', 'readwrite', (s) => s.delete(k)).then(() => {}),
    keys: (prefix) => keysOf('kv', prefix),
    thumbGet: (k) => tx('thumbs', 'readonly', (s) => s.get(k)),
    thumbSet: (k, blob) => tx('thumbs', 'readwrite', (s) => s.put(blob, k)).then(() => {}),
    thumbKeys: (prefix) => keysOf('thumbs', prefix),
    thumbDel: (k) => tx('thumbs', 'readwrite', (s) => s.delete(k)).then(() => {}),
    /* Reset app: wipe kv except the keys listed, and all thumbs */
    async clear(keep = []) {
      for (const k of await this.keys()) if (!keep.includes(k)) await this.del(k);
      await tx('thumbs', 'readwrite', (s) => s.clear());
    },
  };
})();
