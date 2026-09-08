export const STATUSES = {
  waiting: '대기 중',
  restored: '다시 연 기록',
  archived: '보관 처리',
};

export const isDemo = !globalThis.chrome?.runtime?.id && new URL(location.href).searchParams.get('demo') === '1';

export function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function safeUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

export function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '날짜 없음' : new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

export function announce(element, message, kind = 'success') {
  element.textContent = message;
  element.dataset.kind = kind;
  element.hidden = !message;
}

export function showDemoBanner() {
  if (!isDemo) return;
  const banner = node('div', 'demo-banner', '미리보기 모드 · 예시 데이터입니다. Chrome 탭과 실제 보관함은 변경되지 않으며, 새로고침하면 초기화됩니다.');
  banner.setAttribute('role', 'note');
  document.body.prepend(banner);
}

const demoNow = new Date().toISOString();
let demoSessions = [
  {
    id: 'demo-design', title: '다음 주에 이어볼 디자인 자료', note: '탭은 잠시 닫고, 아이디어는 여기에. 레이아웃과 접근성 자료를 함께 살펴보기.', tags: ['디자인', '읽을거리'], status: 'waiting', createdAt: demoNow, updatedAt: demoNow,
    tabs: [
      { id: 'demo-tab-1', title: 'Designing for the web', url: 'https://web.dev/learn/design', pinned: false, originalIndex: 0 },
      { id: 'demo-tab-2', title: '접근성 가이드 살펴보기', url: 'https://developer.mozilla.org/en-US/docs/Web/Accessibility', pinned: false, originalIndex: 1 },
      { id: 'demo-tab-3', title: '색상 대비와 읽기 쉬운 화면', url: 'https://www.w3.org/WAI/tutorials/', pinned: false, originalIndex: 2 },
    ],
  },
  { id: 'demo-weekend', title: '주말의 작은 계획', note: '', tags: ['나중에'], status: 'waiting', createdAt: demoNow, updatedAt: demoNow, tabs: [{ id: 'demo-tab-4', title: '지도로 둘러보기', url: 'https://www.openstreetmap.org/', pinned: false, originalIndex: 0 }] },
  { id: 'demo-docs', title: '개발 문서 모음', note: '', tags: ['개발'], status: 'restored', createdAt: demoNow, updatedAt: demoNow, lastRestoredAt: demoNow, tabs: [{ id: 'demo-tab-5', title: 'Chrome Extensions', url: 'https://developer.chrome.com/docs/extensions', pinned: false, originalIndex: 0 }] },
];

function demoApi(message) {
  const session = demoSessions.find((item) => item.id === message.id);
  switch (message.type) {
    case 'list': return { sessions: structuredClone(demoSessions) };
    case 'get':
      if (!session) throw new Error('묶음을 찾을 수 없습니다.');
      return { session: structuredClone(session) };
    case 'capture': {
      const captured = {};
      captured.id = crypto.randomUUID();
      captured.title = message.title?.trim() || '미리보기에서 저장한 묶음';
      captured.status = 'waiting';
      captured.tabs = [{ id: crypto.randomUUID(), title: '예시 페이지', url: 'https://example.com/', pinned: false, originalIndex: 0 }];
      captured.note = '';
      captured.tags = [];
      captured.createdAt = captured.updatedAt = new Date().toISOString();
      demoSessions.unshift(captured);
      return { session: captured, skipped: [], closed: 0, closeFailed: [] };
    }
    case 'update':
      if (!session) throw new Error('묶음을 찾을 수 없습니다.');
      Object.assign(session, message.changes, { updatedAt: new Date().toISOString() });
      return { session: structuredClone(session) };
    case 'delete': demoSessions = demoSessions.filter((item) => item.id !== message.id); return { deleted: true };
    case 'restore':
      if (!session) throw new Error('묶음을 찾을 수 없습니다.');
      session.lastRestoredAt = new Date().toISOString();
      for (const tab of session.tabs) if (!message.entryIds || message.entryIds.includes(tab.id)) tab.lastOpenedAt = session.lastRestoredAt;
      session.status = session.tabs.every((tab) => tab.lastOpenedAt) ? 'restored' : 'waiting';
      return { session: structuredClone(session), opened: message.entryIds?.length || session.tabs.length, failed: [] };
    case 'export': return { data: { format: 'tab-harbor', version: 1, exportedAt: new Date().toISOString(), sessions: structuredClone(demoSessions) } };
    case 'import': throw new Error('미리보기에서는 파일을 가져올 수 없습니다. Chrome 확장 프로그램에서 사용해 주세요.');
    default: throw new Error('지원하지 않는 요청입니다.');
  }
}

export async function api(message) {
  if (isDemo) return demoApi(message);
  if (!globalThis.chrome?.runtime?.id) throw new Error('Chrome 확장 프로그램에서 이 화면을 열어 주세요. 화면만 살펴보려면 주소 끝에 ?demo=1을 붙여 주세요.');
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  return response;
}

export function captureMessage(result) {
  const parts = [`탭 ${result.session.tabs.length}개를 대기 중에 저장했습니다.`];
  if (result.skipped?.length) parts.push(`저장할 수 없는 탭 ${result.skipped.length}개는 건너뛰었습니다.`);
  if (result.closed) parts.push(`${result.closed}개 탭을 닫았습니다.`);
  if (result.closeFailed?.length) parts.push(`${result.closeFailed.length}개 탭은 닫지 못했지만 저장되어 있습니다.`);
  return parts.join(' ');
}

export async function requestPersistence() {
  if (isDemo || !globalThis.chrome?.runtime?.id || globalThis.location?.protocol !== 'chrome-extension:') return '';
  const storage = globalThis.navigator?.storage;
  try {
    if (typeof storage?.persisted === 'function' && await storage.persisted()) return '';
    if (typeof storage?.persist === 'function' && await storage.persist()) return '';
  } catch {
    // Storage still works when the browser cannot grant eviction protection.
  }
  return '저장 공간 부족에 대비해 JSON 백업을 보관하세요.';
}
