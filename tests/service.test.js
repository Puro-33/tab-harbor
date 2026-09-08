import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createRepository } from '../extension/lib/db.js';
import { createService } from '../extension/lib/service.js';
import { createSession } from '../extension/lib/model.js';

const date = '2026-09-07T12:00:00.000Z';
function setup(overrides = {}) {
  const calls = { remove: [], create: [], query: [], windows: [], update: [] };
  const candidates = [
    { id: 1, index: 0, url: 'https://example.com/?q=1#part', title: 'First', pinned: true },
    { id: 2, index: 1, url: 'https://example.org/second', title: 'Second', pinned: false },
    { id: 3, index: 2, url: 'chrome://extensions', title: 'Extensions', pinned: false },
  ];
  const repository = createRepository({ indexedDB: new IDBFactory() });
  const browser = {
    windows: {
      getLastFocused: async () => ({ id: 7, type: 'normal' }),
      create: async (options) => { calls.windows.push(options); return { id: 9, tabs: [{ id: 91 }] }; },
    },
    tabs: {
      query: async (options) => { calls.query.push(options); return options.active ? [candidates[0]] : candidates; },
      get: async (id) => ({ ...candidates.find((tab) => tab.id === id) }),
      remove: async (id) => { calls.remove.push(id); },
      create: async (options) => { calls.create.push(options); return { id: 100 + calls.create.length }; },
      update: async (id, changes) => { calls.update.push({ id, changes }); },
    },
  };
  Object.assign(browser.tabs, overrides.tabs);
  Object.assign(browser.windows, overrides.windows);
  let sequence = 0;
  const service = createService({ repository, browser, now: () => date, uuid: () => `id_${++sequence}` });
  return { repository, browser, calls, candidates, send: service.handleMessage };
}

test('capture commits safe URLs, exact query/hash and pin/order before closing tabs', async () => {
  const app = setup();
  app.browser.tabs.remove = async (id) => {
    assert.equal((await app.repository.list()).length, 1, 'record is committed before first close');
    app.calls.remove.push(id);
  };
  const result = await app.send({ type: 'capture', scope: 'window', closeAfterSave: true });
  assert.equal(result.session.status, 'waiting');
  assert.equal(result.session.tabs.length, 2);
  assert.equal(result.session.tabs[0].url, 'https://example.com/?q=1#part');
  assert.equal(result.session.tabs[0].pinned, true);
  assert.equal(result.closed, 2);
  assert.deepEqual(app.calls.remove, [1, 2]);
  assert.equal(result.skipped.length, 1);
  assert.deepEqual(result.closeFailed, []);
  await app.repository.close();
});

test('capture active tab uses the last focused normal window and leaves it open by default', async () => {
  const app = setup({ windows: { getLastFocused: async (options) => { assert.deepEqual(options, { windowTypes: ['normal'] }); return { id: 7 }; } } });
  const result = await app.send({ type: 'capture', scope: 'tab' });
  assert.deepEqual(app.calls.query, [{ windowId: 7, active: true }]);
  assert.equal(result.session.tabs.length, 1);
  assert.equal(result.closed, 0);
  await app.repository.close();
});

test('failed database save never closes any original tab', async () => {
  const app = setup();
  app.repository.save = async () => { throw new Error('QuotaExceededError'); };
  await assert.rejects(app.send({ type: 'capture', scope: 'window', closeAfterSave: true }), /QuotaExceededError/);
  assert.deepEqual(app.calls.remove, []);
  await app.repository.close();
});

test('changed URL and pending navigation are kept open after saving', async () => {
  const app = setup();
  app.browser.tabs.get = async (id) => id === 1 ? { url: 'https://example.com/new' } : { url: app.candidates[1].url, pendingUrl: 'https://example.org/new' };
  const result = await app.send({ type: 'capture', scope: 'window', closeAfterSave: true });
  assert.equal(result.closed, 0);
  assert.equal(result.closeFailed.length, 2);
  assert.deepEqual(app.calls.remove, []);
  assert.equal((await app.repository.get(result.session.id)).tabs.length, 2);
  await app.repository.close();
});

test('a vanished tab is reported without losing the saved record or blocking other closes', async () => {
  const app = setup();
  app.browser.tabs.get = async (id) => { if (id === 1) throw new Error('No tab with id 1'); return app.candidates[1]; };
  const result = await app.send({ type: 'capture', scope: 'window', closeAfterSave: true });
  assert.equal(result.closed, 1);
  assert.equal(result.closeFailed.length, 1);
  assert.equal((await app.repository.get(result.session.id)).tabs.length, 2);
  await app.repository.close();
});

test('partial restore records only successful tabs and preserves all saved URLs', async () => {
  const app = setup();
  const { session } = await app.send({ type: 'capture', scope: 'window' });
  app.browser.tabs.create = async (options) => { if (options.url.includes('example.org')) throw new Error('Tab creation blocked'); return { id: 99 }; };
  const result = await app.send({ type: 'restore', id: session.id });
  assert.equal(result.opened, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.session.status, 'waiting');
  assert.equal(result.session.tabs[0].lastOpenedAt, date);
  assert.equal(result.session.tabs[1].lastOpenedAt, undefined);
  assert.deepEqual(result.session.tabs.map((tab) => tab.url), session.tabs.map((tab) => tab.url));
  await app.repository.close();
});

test('selective restore changes only selected entries and complete restore reaches restored status', async () => {
  const app = setup();
  const { session } = await app.send({ type: 'capture', scope: 'window' });
  const first = await app.send({ type: 'restore', id: session.id, entryIds: [session.tabs[0].id] });
  assert.equal(first.opened, 1);
  assert.equal(first.session.status, 'waiting');
  assert.equal(first.session.tabs[1].lastOpenedAt, undefined);
  const second = await app.send({ type: 'restore', id: session.id, entryIds: [session.tabs[1].id] });
  assert.equal(second.session.status, 'restored');
  await assert.rejects(app.send({ type: 'restore', id: session.id, entryIds: ['unknown'] }), /찾을 수/);
  await app.repository.close();
});

test('new-window restore opens one window and subsequent tabs in that same window', async () => {
  const app = setup();
  const { session } = await app.send({ type: 'capture', scope: 'window' });
  const result = await app.send({ type: 'restore', id: session.id, newWindow: true });
  assert.equal(result.opened, 2);
  assert.equal(app.calls.windows.length, 1);
  assert.equal(app.calls.windows[0].url, session.tabs[0].url);
  assert.equal(app.calls.create[0].windowId, 9);
  assert.deepEqual(app.calls.update, [{ id: 91, changes: { pinned: true } }]);
  await app.repository.close();
});

test('current-window restore keeps a fixed normal window when focus changes during the operation', async () => {
  const app = setup();
  const { session } = await app.send({ type: 'capture', scope: 'window' });
  let lookups = 0;
  app.browser.windows.getLastFocused = async (options) => {
    assert.deepEqual(options, { windowTypes: ['normal'] });
    lookups += 1;
    return { id: lookups === 1 ? 7 : 8 };
  };
  await app.send({ type: 'restore', id: session.id });
  assert.equal(lookups, 1);
  assert.deepEqual(app.calls.create.map((options) => options.windowId), [7, 7]);
  await app.repository.close();
});

test('complete browser failure preserves the original database state', async () => {
  const app = setup({ tabs: { create: async () => { throw new Error('Browser unavailable'); } } });
  const { session } = await app.send({ type: 'capture', scope: 'window' });
  const result = await app.send({ type: 'restore', id: session.id });
  assert.equal(result.opened, 0);
  assert.equal(result.failed.length, 2);
  assert.deepEqual(await app.repository.get(session.id), session);
  await app.repository.close();
});

test('a tracking failure reports already opened tabs explicitly', async () => {
  const app = setup();
  const { session } = await app.send({ type: 'capture', scope: 'window' });
  app.repository.patch = async () => { throw new Error('Disk full'); };
  await assert.rejects(app.send({ type: 'restore', id: session.id }), /탭 2개를 열었지만 복원 기록을 저장하지 못했습니다: Disk full/);
  assert.deepEqual(await app.repository.get(session.id), session);
  await app.repository.close();
});

test('export/import and metadata edits round trip through the public service', async () => {
  const app = setup();
  const { session } = await app.send({ type: 'capture', scope: 'tab' });
  const updated = await app.send({ type: 'update', id: session.id, changes: { title: 'Saved reading', note: '<b>Literal text</b>', tags: ['study'], status: 'archived' } });
  const exported = await app.send({ type: 'export' });
  assert.equal(exported.data.sessions[0].note, '<b>Literal text</b>');
  await app.send({ type: 'delete', id: session.id });
  assert.equal((await app.send({ type: 'list' })).sessions.length, 0);
  assert.equal((await app.send({ type: 'import', data: exported.data })).imported, 1);
  assert.deepEqual((await app.send({ type: 'get', id: session.id })).session, updated.session);
  await app.repository.close();
});

test('unsafe legacy URL is rejected at restore even if a repository contains it', async () => {
  const app = setup();
  const corrupt = createSession({ id: 'old', title: 'Legacy', createdAt: date, tabs: [{ id: 'oldtab', url: 'https://example.com', title: 'Legacy', pinned: false, originalIndex: 0 }] });
  corrupt.tabs[0].url = 'javascript:alert(1)';
  app.repository.get = async () => corrupt;
  const result = await app.send({ type: 'restore', id: 'old' });
  assert.equal(result.opened, 0);
  assert.equal(result.failed.length, 1);
  assert.deepEqual(app.calls.create, []);
  await app.repository.close();
});
