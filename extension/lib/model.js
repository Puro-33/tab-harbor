export const FORMAT = 'tab-harbor';
export const VERSION = 1;
export const LIMITS = Object.freeze({ sessions: 1000, tabs: 1000, totalTabs: 10000, bytes: 10 * 1024 * 1024 });

const statuses = new Set(['waiting', 'restored', 'archived']);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function fail(message) { throw new Error(message); }
function string(value, name, max, { empty = true } = {}) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) fail(`${name} 형식 또는 길이가 올바르지 않습니다.`);
  return value;
}
function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail('기록 ID가 올바르지 않습니다.');
  return value;
}
function date(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(`${name} 날짜가 올바르지 않습니다.`);
  return value;
}
function tags(value) {
  if (!Array.isArray(value) || value.length > 20) fail('태그는 최대 20개까지 저장할 수 있습니다.');
  return [...new Set(value.map((tag) => string(tag, '태그', 60, { empty: false }).trim()))];
}
function status(value) {
  if (!statuses.has(value)) fail('기록 상태가 올바르지 않습니다.');
  return value;
}

export function isSafeUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 16384 || /[\u0000-\u0020\u007f]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return /^(https?):\/\//i.test(value) && ['http:', 'https:'].includes(parsed.protocol) && !!parsed.hostname && !parsed.username && !parsed.password;
  } catch { return false; }
}

export function validateSession(value) {
  if (!plain(value)) fail('기록 형식이 올바르지 않습니다.');
  if (!Array.isArray(value.tabs) || !value.tabs.length || value.tabs.length > LIMITS.tabs) fail(`기록당 탭은 1~${LIMITS.tabs}개여야 합니다.`);
  const seen = new Set();
  const tabs = value.tabs.map((tab) => {
    if (!plain(tab) || !isSafeUrl(tab.url)) fail('저장 가능한 HTTP/HTTPS URL이 아닙니다.');
    const tabId = id(tab.id);
    if (seen.has(tabId)) fail('중복된 탭 ID가 있습니다.');
    seen.add(tabId);
    if (typeof tab.pinned !== 'boolean' || !Number.isSafeInteger(tab.originalIndex) || tab.originalIndex < 0 || tab.originalIndex > 100000) fail('탭 정보가 올바르지 않습니다.');
    const result = { id: tabId, url: tab.url, title: string(tab.title, '탭 제목', 1000), pinned: tab.pinned, originalIndex: tab.originalIndex };
    if (own(tab, 'lastOpenedAt')) result.lastOpenedAt = date(tab.lastOpenedAt, '최근 열기');
    return result;
  });
  const result = {
    id: id(value.id), title: string(value.title, '제목', 240, { empty: false }).trim(),
    note: string(value.note, '메모', 10000), tags: tags(value.tags), status: status(value.status),
    createdAt: date(value.createdAt, '생성'), updatedAt: date(value.updatedAt, '수정'), tabs,
  };
  if (own(value, 'lastRestoredAt')) result.lastRestoredAt = date(value.lastRestoredAt, '최근 복원');
  return result;
}

export function createSession(value) {
  return validateSession({ note: '', tags: [], status: 'waiting', ...value, updatedAt: value.updatedAt ?? value.createdAt });
}

export function validateMetadataPatch(value) {
  if (!plain(value)) fail('변경 내용이 올바르지 않습니다.');
  const output = {};
  for (const key of Object.keys(value)) {
    if (!['title', 'note', 'tags', 'status'].includes(key)) fail('변경할 수 없는 기록 속성입니다.');
    if (key === 'title') output.title = string(value.title, '제목', 240, { empty: false }).trim();
    if (key === 'note') output.note = string(value.note, '메모', 10000);
    if (key === 'tags') output.tags = tags(value.tags);
    if (key === 'status') output.status = status(value.status);
  }
  return output;
}

export function validateCollectionCapacity(sessions) {
  if (sessions.length > LIMITS.sessions) fail(`최대 ${LIMITS.sessions}개 기록까지 저장할 수 있습니다. 기존 기록을 백업하고 정리해 주세요.`);
  if (sessions.reduce((sum, session) => sum + session.tabs.length, 0) > LIMITS.totalTabs) fail(`전체 저장 탭은 최대 ${LIMITS.totalTabs}개입니다. 기존 기록을 백업하고 정리해 주세요.`);
  const data = { format: FORMAT, version: VERSION, exportedAt: '2000-01-01T00:00:00.000Z', sessions };
  if (new TextEncoder().encode(JSON.stringify(data)).byteLength > LIMITS.bytes) fail('전체 기록은 10 MB까지 저장할 수 있습니다. 기존 기록을 백업하고 정리해 주세요.');
}

export function validateImport(value) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { fail('백업 파일을 읽을 수 없습니다.'); }
  if (!serialized || new TextEncoder().encode(serialized).byteLength > LIMITS.bytes) fail('백업 파일은 10 MB 이하여야 합니다.');
  if (!plain(value) || value.format !== FORMAT || value.version !== VERSION || !Array.isArray(value.sessions) || value.sessions.length > LIMITS.sessions) fail('지원하지 않거나 너무 큰 Tab Harbor 백업 파일입니다.');
  date(value.exportedAt, '백업');
  const sessions = value.sessions.map(validateSession);
  const ids = new Set();
  for (const session of sessions) {
    if (ids.has(session.id)) fail('백업에 중복된 기록 ID가 있습니다.');
    ids.add(session.id);
  }
  validateCollectionCapacity(sessions);
  return sessions;
}
