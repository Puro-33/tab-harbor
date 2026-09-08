import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, isSafeUrl, validateImport, validateMetadataPatch } from '../extension/lib/model.js';

const fixture = () => createSession({ id: 'session_1', title: 'Research', createdAt: '2026-09-07T12:00:00.000Z', tabs: [{ id: 'tab_1', url: 'https://example.com/search?q=a%20b#notes', title: 'Example', pinned: false, originalIndex: 0 }] });
const backup = (sessions) => ({ format: 'tab-harbor', version: 1, exportedAt: '2026-09-07T12:00:00.000Z', sessions });

test('safe URLs retain exact query strings and fragments', () => {
  const session = fixture();
  assert.equal(session.tabs[0].url, 'https://example.com/search?q=a%20b#notes');
  for (const url of ['http://localhost:8080/x', 'HTTPS://example.com/', 'https://例え.テスト/한글']) assert.equal(isSafeUrl(url), true, url);
});

test('active schemes, credentials, malformed and ambiguous URLs are rejected', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'chrome://settings', 'file:///tmp/a', '//example.com', 'https:example.com', 'https://user:pass@example.com/', 'https://example.com/\n', ' https://example.com', 'https://', null, {}]) assert.equal(isSafeUrl(url), false, String(url));
});

test('import whitelists fields and rejects executable URLs before storage', () => {
  const session = fixture();
  session.untrusted = '<script>alert(1)</script>';
  const result = validateImport(backup([session]));
  assert.equal(Object.hasOwn(result[0], 'untrusted'), false);
  session.tabs[0].url = 'javascript:alert(document.cookie)';
  assert.throws(() => validateImport(backup([session])), /URL/);
});

test('import rejects duplicate IDs, invalid dates, types, versions and excessive bytes', () => {
  assert.throws(() => validateImport(backup([fixture(), fixture()])), /중복/);
  const duplicateTabs = fixture();
  duplicateTabs.tabs.push({ ...duplicateTabs.tabs[0] });
  assert.throws(() => validateImport(backup([duplicateTabs])), /중복/);
  const badDate = fixture();
  badDate.createdAt = '2026-02-30T12:00:00.000Z';
  assert.throws(() => validateImport(backup([badDate])), /날짜/);
  const badType = fixture();
  badType.tabs[0].pinned = 'false';
  assert.throws(() => validateImport(backup([badType])), /탭 정보/);
  assert.throws(() => validateImport({ ...backup([]), version: 2 }), /지원하지/);
  assert.throws(() => validateImport({ ...backup([]), extra: 'x'.repeat(10 * 1024 * 1024) }), /10 MB/);
});

test('metadata edits cannot replace IDs or tab URLs', () => {
  assert.throws(() => validateMetadataPatch({ id: 'replacement' }), /변경할 수 없는/);
  assert.throws(() => validateMetadataPatch({ tabs: [] }), /변경할 수 없는/);
  assert.throws(() => validateMetadataPatch({ status: 'unknown' }), /상태/);
  assert.deepEqual(validateMetadataPatch({ title: '  New title ', tags: ['work', ' work '] }), { title: 'New title', tags: ['work'] });
});
