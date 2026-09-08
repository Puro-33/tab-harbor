import { createSession, isSafeUrl, validateMetadataPatch, validateImport, FORMAT, VERSION, LIMITS } from './model.js';

export function createService({ repository, browser = globalThis.chrome, now = () => new Date(), uuid = () => crypto.randomUUID() }) {
  const timestamp = () => new Date(now()).toISOString();
  const reason = (error) => error instanceof Error ? error.message : String(error);

  async function requireSession(id) {
    if (typeof id !== 'string' || !id) throw new Error('기록 ID가 필요합니다.');
    const session = await repository.get(id);
    if (!session) throw new Error('기록을 찾을 수 없습니다.');
    return session;
  }

  async function capture(message) {
    if (!['tab', 'window'].includes(message.scope)) throw new Error('저장할 탭 범위가 올바르지 않습니다.');
    if (message.closeAfterSave !== undefined && typeof message.closeAfterSave !== 'boolean') throw new Error('저장 후 닫기 설정이 올바르지 않습니다.');
    const window = await browser.windows.getLastFocused({ windowTypes: ['normal'] });
    if (!Number.isInteger(window?.id)) throw new Error('저장할 Chrome 창을 찾을 수 없습니다.');
    const query = { windowId: window.id };
    if (message.scope === 'tab') query.active = true;
    const candidates = (await browser.tabs.query(query)).sort((a, b) => a.index - b.index);
    const skipped = [];
    const sources = [];
    for (const tab of candidates) {
      if (!isSafeUrl(tab.url)) { skipped.push({ url: typeof tab.url === 'string' ? tab.url : '', reason: 'HTTP/HTTPS 웹페이지만 저장할 수 있습니다.' }); continue; }
      sources.push(tab);
    }
    if (!sources.length) throw new Error('저장할 HTTP/HTTPS 웹페이지가 없습니다.');
    if (sources.length > LIMITS.tabs) throw new Error(`한 번에 최대 ${LIMITS.tabs}개 탭을 저장할 수 있습니다.`);
    const savedAt = timestamp();
    const tabs = sources.map((tab) => ({ id: uuid(), url: tab.url, title: String(tab.title || tab.url).slice(0, 1000), pinned: !!tab.pinned, originalIndex: tab.index }));
    const title = message.title === undefined ? (message.scope === 'tab' ? tabs[0].title : `탭 ${tabs.length}개 · ${savedAt.slice(0, 10)}`).slice(0, 240) : message.title;
    const session = await repository.save(createSession({ id: uuid(), title, createdAt: savedAt, tabs }));
    let closed = 0;
    const closeFailed = [];
    if (message.closeAfterSave) {
      for (const tab of sources) {
        try {
          const current = await browser.tabs.get(tab.id);
          if (current.url !== tab.url || (current.pendingUrl && current.pendingUrl !== tab.url)) {
            closeFailed.push({ url: tab.url, reason: '저장 후 주소가 바뀐 탭은 열어 두었습니다.' });
            continue;
          }
          await browser.tabs.remove(tab.id);
          closed += 1;
        } catch (error) { closeFailed.push({ url: tab.url, reason: reason(error) }); }
      }
    }
    return { session, skipped, closed, closeFailed };
  }

  async function restore(message) {
    const original = await requireSession(message.id);
    if (message.newWindow !== undefined && typeof message.newWindow !== 'boolean') throw new Error('복원 창 설정이 올바르지 않습니다.');
    let selected = original.tabs;
    if (message.entryIds !== undefined) {
      if (!Array.isArray(message.entryIds) || !message.entryIds.length || message.entryIds.some((id) => typeof id !== 'string')) throw new Error('복원할 탭을 선택해 주세요.');
      const wanted = new Set(message.entryIds);
      selected = original.tabs.filter((tab) => wanted.has(tab.id));
      if (selected.length !== wanted.size) throw new Error('복원할 탭을 찾을 수 없습니다.');
    }
    selected = [...selected].sort((a, b) => a.originalIndex - b.originalIndex);
    const failed = [];
    const openedIds = new Set();
    let targetWindow;
    if (!message.newWindow) {
      const window = await browser.windows.getLastFocused({ windowTypes: ['normal'] });
      if (!Number.isInteger(window?.id)) throw new Error('복원할 Chrome 창을 찾을 수 없습니다.');
      targetWindow = window.id;
    }
    for (const tab of selected) {
      if (!isSafeUrl(tab.url)) { failed.push({ url: tab.url, reason: '복원할 수 없는 URL입니다.' }); continue; }
      try {
        if (message.newWindow && targetWindow === undefined) {
          const created = await browser.windows.create({ url: tab.url, focused: true, type: 'normal' });
          if (!Number.isInteger(created?.id)) throw new Error('새 창 정보를 확인하지 못했습니다.');
          targetWindow = created.id;
          openedIds.add(tab.id);
          if (tab.pinned && Number.isInteger(created.tabs?.[0]?.id)) {
            try { await browser.tabs.update(created.tabs[0].id, { pinned: true }); } catch { /* Opening succeeded; the saved pin preference remains intact. */ }
          }
        } else {
          const options = { url: tab.url, pinned: tab.pinned, active: openedIds.size === 0 };
          if (targetWindow !== undefined) options.windowId = targetWindow;
          await browser.tabs.create(options);
          openedIds.add(tab.id);
        }
      } catch (error) { failed.push({ url: tab.url, reason: reason(error) }); }
    }
    let session = original;
    if (openedIds.size) {
      const restoredAt = timestamp();
      try {
        session = await repository.patch(original.id, (current) => {
          const tabs = current.tabs.map((tab) => openedIds.has(tab.id) ? { ...tab, lastOpenedAt: restoredAt } : tab);
          return { tabs, status: tabs.every((tab) => tab.lastOpenedAt) ? 'restored' : 'waiting', updatedAt: restoredAt, lastRestoredAt: restoredAt };
        });
      } catch (error) { throw new Error(`탭 ${openedIds.size}개를 열었지만 복원 기록을 저장하지 못했습니다: ${reason(error)}`); }
    }
    return { session, opened: openedIds.size, failed };
  }

  async function handleMessage(message) {
    if (!message || typeof message !== 'object') throw new Error('요청 형식이 올바르지 않습니다.');
    switch (message.type) {
      case 'list': return { sessions: await repository.list() };
      case 'get': return { session: await requireSession(message.id) };
      case 'capture': return capture(message);
      case 'update': {
        await requireSession(message.id);
        const changes = validateMetadataPatch(message.changes);
        return { session: await repository.patch(message.id, { ...changes, updatedAt: timestamp() }) };
      }
      case 'delete': {
        await requireSession(message.id);
        await repository.remove(message.id);
        return { deleted: true };
      }
      case 'restore': return restore(message);
      case 'export': {
        const data = { format: FORMAT, version: VERSION, exportedAt: timestamp(), sessions: await repository.list() };
        validateImport(data);
        return { data };
      }
      case 'import': return { imported: await repository.importData(message.data) };
      default: throw new Error('지원하지 않는 요청입니다.');
    }
  }
  return { handleMessage };
}
