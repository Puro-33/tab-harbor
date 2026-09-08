import { validateSession, validateImport, validateCollectionCapacity } from './model.js';

export function createRepository({ indexedDB = globalThis.indexedDB, dbName = 'tab-harbor' } = {}) {
  let connection;
  function open() {
    if (connection) return connection;
    connection = new Promise((resolve, reject) => {
      if (!indexedDB) { reject(new Error('이 환경에서는 데이터베이스를 사용할 수 없습니다.')); return; }
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('sessions', { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); connection = undefined; };
        resolve(db);
      };
      request.onerror = () => { connection = undefined; reject(request.error || new Error('데이터베이스를 열 수 없습니다.')); };
    }).catch((error) => { connection = undefined; throw error; });
    return connection;
  }

  async function transaction(mode, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
      // Captured tabs may be closed after commit, so request a disk flush before completion.
      const tx = mode === 'readwrite'
        ? db.transaction('sessions', mode, { durability: 'strict' })
        : db.transaction('sessions', mode);
      let result;
      let failure;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure || tx.error || new Error('데이터베이스 저장이 취소되었습니다.'));
      tx.onerror = () => {};
      const setResult = (value) => { result = value; };
      const abort = (error) => { failure = error; try { tx.abort(); } catch { reject(error); } };
      try { work(tx.objectStore('sessions'), setResult, abort); } catch (error) { abort(error); }
    });
  }

  return {
    async list() {
      return transaction('readonly', (store, done) => {
        const request = store.getAll();
        request.onsuccess = () => done(request.result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)));
      });
    },
    async get(id) {
      return transaction('readonly', (store, done) => {
        const request = store.get(id);
        request.onsuccess = () => done(request.result ?? null);
      });
    },
    async save(value) {
      const session = validateSession(value);
      return transaction('readwrite', (store, done, abort) => {
        const request = store.getAll();
        request.onsuccess = () => {
          try {
            validateCollectionCapacity([...request.result.filter((item) => item.id !== session.id), session]);
            store.put(session);
            done(session);
          } catch (error) { abort(error); }
        };
      });
    },
    async patch(id, changes) {
      return transaction('readwrite', (store, done, abort) => {
        const request = store.getAll();
        request.onsuccess = () => {
          try {
            const current = request.result.find((item) => item.id === id);
            if (!current) throw new Error('기록을 찾을 수 없습니다.');
            const patch = typeof changes === 'function' ? changes(current) : changes;
            const session = validateSession({ ...current, ...patch, id: current.id });
            validateCollectionCapacity(request.result.map((item) => item.id === id ? session : item));
            store.put(session);
            done(session);
          } catch (error) { abort(error); }
        };
      });
    },
    async remove(id) {
      return transaction('readwrite', (store, done) => { store.delete(id); done(true); });
    },
    async importData(data) {
      const sessions = validateImport(data);
      return transaction('readwrite', (store, done, abort) => {
        const request = store.getAll();
        request.onsuccess = () => {
          try {
            const ids = new Set(request.result.map((session) => session.id));
            const additions = sessions.filter((session) => !ids.has(session.id));
            validateCollectionCapacity([...request.result, ...additions]);
            for (const session of additions) store.add(session);
            done(additions.length);
          } catch (error) { abort(error); }
        };
      });
    },
    async close() {
      if (connection) (await connection).close();
      connection = undefined;
    },
  };
}
