import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const date = '2026-09-07T12:00:00.000Z';
const fixture = () => [
  {
    id: 'session-one', title: '디자인 자료 <img src=x onerror=alert(1)>', note: '나중에 이어서', tags: ['디자인', '접근성'], status: 'waiting', createdAt: date, updatedAt: date,
    tabs: [
      { id: 'tab-one', title: '<script>window.attacked=true</script>', url: 'https://example.com/guide', pinned: true, originalIndex: 0 },
      { id: 'tab-two', title: '안전하게 텍스트로만 표시', url: 'javascript:alert(1)', pinned: false, originalIndex: 1 },
    ],
  },
  { id: 'session-two', title: '이미 읽은 문서', note: '', tags: ['개발'], status: 'restored', createdAt: date, updatedAt: date, tabs: [{ id: 'tab-three', title: '문서', url: 'https://developer.chrome.com/', pinned: false, originalIndex: 0, lastOpenedAt: date }] },
];

let importCounter = 0;
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function mount(t, page, { initial = fixture(), handle, storage } = {}) {
  const markup = await readFile(new URL(`../extension/${page}.html`, import.meta.url), 'utf8');
  const dom = new JSDOM(markup, { url: `chrome-extension://test-extension/${page}.html`, runScripts: 'outside-only' });
  const previous = new Map();
  const calls = [];
  const prompts = [];
  let saved = structuredClone(initial);
  const runtime = {
    id: 'test-extension',
    getURL: (path) => `chrome-extension://test-extension/${path}`,
    async sendMessage(message) {
      calls.push(structuredClone(message));
      if (handle) {
        const custom = await handle(message, { saved, setSaved: (next) => { saved = next; } });
        if (custom !== undefined) return custom;
      }
      if (message.type === 'list') return { ok: true, sessions: structuredClone(saved) };
      if (message.type === 'get') return { ok: true, session: structuredClone(saved.find((session) => session.id === message.id)) };
      if (message.type === 'capture') {
        const captured = { ...structuredClone(fixture()[0]), id: 'captured-session', title: message.title || '새 묶음' };
        saved.push(captured);
        return { ok: true, session: captured, skipped: [], closed: 0, closeFailed: [] };
      }
      if (message.type === 'update') {
        const session = saved.find((item) => item.id === message.id);
        Object.assign(session, message.changes);
        return { ok: true, session: structuredClone(session) };
      }
      if (message.type === 'delete') { saved = saved.filter((session) => session.id !== message.id); return { ok: true, deleted: true }; }
      if (message.type === 'import') return { ok: true, imported: message.data.sessions.length };
      throw new Error(`Unexpected test API message: ${message.type}`);
    },
  };
  dom.window.confirm = (message) => { prompts.push(message); return true; };
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  Object.defineProperty(dom.window.navigator, 'storage', { value: storage ?? { persisted: async () => true, persist: async () => true }, configurable: true });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, location: dom.window.location, chrome: { runtime, tabs: { create: async () => ({ id: 1 }) } } };
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  t.after(() => {
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  await import(`${new URL(`../extension/${page}.js`, import.meta.url).href}?ui-test=${++importCounter}`);
  await tick();
  const query = (selector) => dom.window.document.querySelector(selector);
  const change = (selector, value) => {
    query(selector).value = value;
    query(selector).dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  const click = async (selector) => { query(selector).click(); await tick(); };
  const submit = async (selector, submitter) => {
    query(selector).dispatchEvent(new dom.window.SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: submitter ? query(submitter) : undefined }));
    await tick();
  };
  return { dom, query, change, click, submit, calls, prompts };
}

test('dashboard safely renders untrusted titles and URLs and searches across domain, title, and tags', async (t) => {
  const { dom, query, change, click } = await mount(t, 'dashboard');
  assert.equal(query('[data-count="waiting"]').textContent, '1');
  assert.equal(query('[data-count="restored"]').textContent, '1');
  assert.match(query('.card-title').textContent, /<img/);
  assert.equal(query('#session-list img'), null);
  assert.equal(query('#session-list script'), null);
  assert.equal(query('[href^="javascript:"]'), null);
  change('#search', 'EXAMPLE.COM 접근성');
  assert.equal(dom.window.document.querySelectorAll('.session-card').length, 1);
  change('#search', '없는검색어');
  assert.equal(query('#empty-state').hidden, false);
  assert.equal(query('#empty-capture').hidden, true);
  change('#search', '');
  await click('[data-filter="restored"]');
  assert.equal(query('.card-title').textContent, '이미 읽은 문서');
  assert.equal(query('[data-filter="restored"]').getAttribute('aria-current'), 'page');
});

test('opening one tab preserves unsaved metadata and reports the remaining waiting state', async (t) => {
  const { query, change, click, calls } = await mount(t, 'dashboard', {
    handle(message, { saved }) {
      if (message.type !== 'restore') return undefined;
      const session = structuredClone(saved[0]);
      session.tabs[0].lastOpenedAt = date;
      return { ok: true, session, opened: 1, failed: [] };
    },
  });
  await click('.card-title');
  assert.equal(query('#session-dialog').open, true);
  assert.equal(query('#detail-tabs script'), null);
  assert.equal(query('#detail-tabs [href]'), null);
  change('#edit-note', '아직 저장하지 않은 메모');
  await click('#detail-tabs button');
  assert.deepEqual(calls.find((message) => message.type === 'restore').entryIds, ['tab-one']);
  assert.equal(query('#edit-note').value, '아직 저장하지 않은 메모');
  assert.match(query('#detail-feedback').textContent, /대기 중에 남아/);
  assert.equal(query('[data-count="waiting"]').textContent, '1');
});

test('API failure leaves edits intact, reports the exact error safely, and re-enables controls', async (t) => {
  const { query, change, click, submit, calls } = await mount(t, 'dashboard', {
    handle(message) { if (message.type === 'update') return { ok: false, error: '저장 공간 부족 <img src=x>' }; },
  });
  await click('.card-title');
  change('#edit-title', '변경한 제목');
  change('#edit-tags', '업무, 업무, 읽을거리');
  await submit('#edit-form');
  assert.equal(query('#edit-title').value, '변경한 제목');
  assert.equal(query('#detail-feedback').dataset.kind, 'error');
  assert.equal(query('#detail-feedback').textContent, '저장 공간 부족 <img src=x>');
  assert.equal(query('#detail-feedback img'), null);
  assert.equal(query('#edit-title').disabled, false);
  assert.deepEqual(calls.find((message) => message.type === 'update').changes.tags, ['업무', '읽을거리']);
});

test('oversize import is rejected before file reading, parsing, or messaging the backend', async (t) => {
  const { query, dom, calls } = await mount(t, 'dashboard');
  let readCount = 0;
  Object.defineProperty(query('#import-file'), 'files', { value: [{ size: 10 * 1024 * 1024 + 1, text: async () => { readCount++; return '{}'; } }] });
  query('#import-file').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await tick();
  assert.equal(readCount, 0);
  assert.equal(calls.some((message) => message.type === 'import'), false);
  assert.match(query('#dashboard-feedback').textContent, /10MB/);
  assert.equal(query('#dashboard-feedback').dataset.kind, 'error');
});

test('popup close-after-save starts off and denied persistence does not block a successful capture', async (t) => {
  const persistence = [];
  const { query, change, submit, calls } = await mount(t, 'popup', {
    storage: { persisted: async () => { persistence.push('check'); return false; }, persist: async () => { persistence.push('request'); return false; } },
  });
  assert.equal(query('#close-after-save').checked, false);
  assert.match(query('.field-hint').textContent, /주소 매개변수/);
  change('#capture-title', '내일 읽을 것');
  await submit('#capture-form', '[value="tab"]');
  assert.deepEqual(persistence, ['check', 'request']);
  assert.deepEqual(calls.find((message) => message.type === 'capture'), { type: 'capture', scope: 'tab', title: '내일 읽을 것', closeAfterSave: false });
  assert.match(query('#popup-feedback').textContent, /저장했습니다/);
  assert.match(query('#popup-feedback').textContent, /JSON 백업/);
  assert.equal(query('#popup-feedback').dataset.kind, 'warning');
  assert.equal(query('#capture-title').disabled, false);
});

test('large restore and deletion both honor cancellation before any API mutation', async (t) => {
  const large = fixture()[0];
  large.tabs = Array.from({ length: 31 }, (_, index) => ({ ...large.tabs[0], id: `tab-${index}`, originalIndex: index }));
  const { dom, query, click, calls, prompts } = await mount(t, 'dashboard', { initial: [large] });
  dom.window.confirm = (message) => { prompts.push(message); return false; };
  await click('.card-footer .button');
  assert.match(prompts[0], /31/);
  assert.equal(calls.some((message) => message.type === 'restore'), false);
  await click('.card-title');
  await click('#delete-session');
  assert.match(prompts[1], /삭제/);
  assert.equal(calls.some((message) => message.type === 'delete'), false);
  assert.equal(query('#session-dialog').open, true);
});

test('partial restore failure retains the session and reports opened and failed counts', async (t) => {
  const { query, click } = await mount(t, 'dashboard', {
    handle(message, { saved }) {
      if (message.type === 'restore') return { ok: true, session: structuredClone(saved[0]), opened: 1, failed: [{ url: saved[0].tabs[1].url, reason: '실패' }] };
    },
  });
  await click('.card-footer .button');
  assert.equal(query('#dashboard-feedback').dataset.kind, 'warning');
  assert.match(query('#dashboard-feedback').textContent, /1개 탭을 새 창에서 열었습니다/);
  assert.match(query('#dashboard-feedback').textContent, /1개는 열지 못했습니다/);
  assert.equal(query('[data-count="waiting"]').textContent, '1');
});

test('import requests supported persistence and a refusal still permits importing', async (t) => {
  let persistenceRequests = 0;
  const { query, dom, calls } = await mount(t, 'dashboard', { storage: { persisted: async () => false, persist: async () => { persistenceRequests++; throw new Error('denied'); } } });
  const data = { format: 'tab-harbor', version: 1, exportedAt: date, sessions: [] };
  Object.defineProperty(query('#import-file'), 'files', { value: [{ size: 100, text: async () => JSON.stringify(data) }] });
  query('#import-file').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await tick();
  assert.equal(persistenceRequests, 1);
  assert.deepEqual(calls.find((message) => message.type === 'import').data, data);
  assert.match(query('#dashboard-feedback').textContent, /0개의 묶음을 가져왔습니다/);
  assert.match(query('#dashboard-feedback').textContent, /JSON 백업/);
});
