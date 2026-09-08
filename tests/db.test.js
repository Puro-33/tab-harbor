import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore, IDBDatabase } from 'fake-indexeddb';
import { createRepository } from '../extension/lib/db.js';
import { createSession } from '../extension/lib/model.js';

const fixture = (id = 'session_1') => createSession({ id, title: `Session ${id}`, createdAt: '2026-09-07T12:00:00.000Z', tabs: [{ id: `tab_${id}`, url: 'https://example.com/?a=1#section', title: 'Example', pinned: false, originalIndex: 0 }] });
const backup = (sessions) => ({ format: 'tab-harbor', version: 1, exportedAt: '2026-09-07T12:00:00.000Z', sessions });

test('committed records survive closing and reopening the repository', async () => {
  const indexedDB = new IDBFactory();
  const first = createRepository({ indexedDB, dbName: 'persistent' });
  const saved = await first.save(fixture());
  await first.close();
  const reopened = createRepository({ indexedDB, dbName: 'persistent' });
  assert.deepEqual(await reopened.get(saved.id), saved);
  assert.deepEqual(await reopened.list(), [saved]);
  await reopened.close();
});

test('patches read the latest committed state and never change the primary ID', async () => {
  const repo = createRepository({ indexedDB: new IDBFactory() });
  await repo.save(fixture());
  await Promise.all([
    repo.patch('session_1', (current) => ({ note: current.note + 'A' })),
    repo.patch('session_1', (current) => ({ note: current.note + 'B' })),
  ]);
  assert.equal((await repo.get('session_1')).note, 'AB');
  assert.equal((await repo.patch('session_1', { id: 'different' })).id, 'session_1');
  await assert.rejects(repo.patch('missing', { title: 'Gone' }), /찾을 수/);
  await repo.close();
});

test('import adds new records atomically and preserves existing IDs', async () => {
  const repo = createRepository({ indexedDB: new IDBFactory() });
  await repo.save(fixture('existing'));
  const changed = { ...fixture('existing'), title: 'Overwrite attempt' };
  assert.equal(await repo.importData(backup([changed, fixture('new')])), 1);
  assert.equal((await repo.get('existing')).title, 'Session existing');
  assert.equal(await repo.importData(backup([changed, fixture('new')])), 0);
  const invalid = fixture('unsafe');
  invalid.tabs[0].url = 'data:text/html,unsafe';
  await assert.rejects(repo.importData(backup([fixture('must_not_commit'), invalid])), /URL/);
  assert.equal(await repo.get('must_not_commit'), null);
  assert.equal((await repo.list()).length, 2);
  await repo.close();
});

test('invalid patches abort without replacing the original and deletion persists', async () => {
  const repo = createRepository({ indexedDB: new IDBFactory() });
  const original = await repo.save(fixture());
  await assert.rejects(repo.patch(original.id, { tabs: [] }), /탭은/);
  assert.deepEqual(await repo.get(original.id), original);
  await repo.remove(original.id);
  assert.deepEqual(await repo.list(), []);
  await repo.close();
});

test('unavailable database reports a useful failure', async () => {
  const repo = createRepository({ indexedDB: null });
  await assert.rejects(repo.save(fixture()), /데이터베이스/);
});

test('a write request failure rolls back every record in an import transaction', async () => {
  const repo = createRepository({ indexedDB: new IDBFactory() });
  await repo.save(fixture('existing'));
  const originalAdd = IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add = function (value, ...args) {
    return originalAdd.call(this, value.id === 'second' ? { ...value, id: 'first' } : value, ...args);
  };
  try {
    await assert.rejects(repo.importData(backup([fixture('first'), fixture('second')])), /constraint/i);
    assert.equal(await repo.get('first'), null);
    assert.equal(await repo.get('second'), null);
    assert.deepEqual((await repo.list()).map((session) => session.id), ['existing']);
  } finally {
    IDBObjectStore.prototype.add = originalAdd;
    await repo.close();
  }
});

test('aggregate capacity is enforced atomically so every stored collection can be reimported', async () => {
  const repo = createRepository({ indexedDB: new IDBFactory() });
  await repo.importData(backup(Array.from({ length: 999 }, (_, index) => fixture(`record_${index}`))));
  await assert.rejects(repo.importData(backup([fixture('extra_1'), fixture('extra_2')])), /1000/);
  assert.equal(await repo.get('extra_1'), null);
  assert.equal((await repo.list()).length, 999);
  await repo.save(fixture('last'));
  await assert.rejects(repo.save(fixture('overflow')), /1000/);
  assert.equal((await repo.list()).length, 1000);
  await repo.close();
});

test('all persistent mutations request strict durability while reads keep default durability', async () => {
  const repo = createRepository({ indexedDB: new IDBFactory() });
  const originalTransaction = IDBDatabase.prototype.transaction;
  const observations = [];
  IDBDatabase.prototype.transaction = function (stores, mode, options) {
    const tx = originalTransaction.call(this, stores, mode, options);
    if (mode !== 'versionchange') observations.push({ mode, options, durability: tx.durability });
    return tx;
  };
  try {
    await repo.save(fixture());
    await repo.patch('session_1', { title: 'Updated' });
    await repo.importData(backup([fixture('imported')]));
    await repo.remove('imported');
    await repo.get('session_1');
    await repo.list();
    const writes = observations.filter((entry) => entry.mode === 'readwrite');
    assert.equal(writes.length, 4, 'save, patch, import and remove each use a durable transaction');
    for (const entry of writes) {
      assert.deepEqual(entry.options, { durability: 'strict' });
      assert.equal(entry.durability, 'strict');
    }
    const reads = observations.filter((entry) => entry.mode === 'readonly');
    assert.equal(reads.length, 2);
    for (const entry of reads) assert.equal(entry.options, undefined);
  } finally {
    IDBDatabase.prototype.transaction = originalTransaction;
    await repo.close();
  }
});
