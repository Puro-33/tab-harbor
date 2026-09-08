import { api, announce, captureMessage, dateLabel, isDemo, node, requestPersistence, safeUrl, showDemoBanner, STATUSES } from './ui.js';

const $ = (selector) => document.querySelector(selector);
const list = $('#session-list');
const feedback = $('#dashboard-feedback');
const detailFeedback = $('#detail-feedback');
const dialog = $('#session-dialog');
const viewCopy = {
  waiting: ['다음에 이어갈 곳.', '잠시 내려놓은 탭을 여기에서 다시 만나세요.'],
  restored: ['다시 이어 본 페이지.', '한 번 다시 연 묶음도 그대로 남아 있어요.'],
  archived: ['잘 보관해 둔 기록.', '지금은 쓰지 않는 묶음도 필요할 때 찾을 수 있어요.'],
};
let sessions = [];
let filter = 'waiting';
let selected = null;
let busy = false;
let loaded = false;
let previousFocus = null;
showDemoBanner();
if (isDemo) $('.brand-link').href = 'dashboard.html?demo=1';

function setBusy(value) {
  busy = value;
  document.querySelectorAll('button, input, select, textarea').forEach((element) => {
    if (element.id !== 'close-detail') element.disabled = value;
  });
  list.setAttribute('aria-busy', String(value));
  dialog.setAttribute('aria-busy', String(value));
}

async function perform(operation, { detail = false, pending = '' } = {}) {
  if (busy) return;
  setBusy(true);
  const destination = detail && dialog.open ? detailFeedback : feedback;
  if (pending) announce(destination, pending, 'pending');
  try {
    await operation();
  } catch (error) {
    announce(dialog.open && detail ? detailFeedback : feedback, error.message || '요청을 처리하지 못했습니다.', 'error');
  } finally {
    setBusy(false);
  }
}

function matches(session, search) {
  if (!search) return true;
  const text = [session.title, session.note, ...(session.tags || []), ...session.tabs.flatMap((tab) => [tab.title, tab.url])].join(' ').toLocaleLowerCase();
  return search.split(/\s+/).every((term) => text.includes(term));
}

function visibleSessions() {
  const search = $('#search').value.trim().toLocaleLowerCase();
  const result = sessions.filter((session) => session.status === filter && matches(session, search));
  const sort = $('#sort').value;
  result.sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title, 'ko') : (new Date(a.createdAt) - new Date(b.createdAt)) * (sort === 'oldest' ? 1 : -1));
  return result;
}

function siteMark(tab) {
  const url = safeUrl(tab.url);
  const mark = node('span', 'site-mark', url ? url.hostname.replace(/^www\./, '').slice(0, 1).toUpperCase() : '?');
  mark.setAttribute('aria-hidden', 'true');
  return mark;
}

function renderCard(session) {
  const article = node('article', 'session-card');
  const header = node('div', 'card-meta');
  header.append(node('span', 'tab-count', `탭 ${session.tabs.length}개`), node('span', 'saved-date', dateLabel(session.createdAt)));
  const heading = node('h2', 'card-heading');
  const title = node('button', 'card-title', session.title);
  title.type = 'button';
  title.dataset.sessionId = session.id;
  title.addEventListener('click', () => openDetail(session.id));
  heading.append(title);
  const preview = node('ul', 'card-tabs');
  session.tabs.slice(0, 3).forEach((tab) => {
    const row = node('li');
    const text = node('span', 'card-tab-title', tab.title || tab.url);
    text.title = tab.url;
    row.append(siteMark(tab), text);
    preview.append(row);
  });
  if (session.tabs.length > 3) preview.append(node('li', 'more-tabs', `외 ${session.tabs.length - 3}개의 탭`));
  const tags = node('div', 'card-tags');
  (session.tags || []).slice(0, 3).forEach((tag) => tags.append(node('span', 'tag', `#${tag}`)));
  if ((session.tags || []).length > 3) tags.append(node('span', 'tag tag-muted', `+${session.tags.length - 3}`));
  const footer = node('div', 'card-footer');
  const detailButton = node('button', 'text-button', '묶음 살펴보기');
  detailButton.type = 'button';
  detailButton.addEventListener('click', () => openDetail(session.id));
  const restoreButton = node('button', 'button button-secondary button-small', '새 창에서 열기');
  restoreButton.type = 'button';
  restoreButton.setAttribute('aria-label', `${session.title}의 탭 ${session.tabs.length}개를 새 창에서 열기`);
  restoreButton.addEventListener('click', () => restoreSession(session));
  footer.append(detailButton, restoreButton);
  article.append(header, heading, preview, tags, footer);
  return article;
}

function render() {
  document.querySelectorAll('[data-count]').forEach((count) => {
    count.textContent = String(sessions.filter((session) => session.status === count.dataset.count).length);
  });
  document.querySelectorAll('[data-filter]').forEach((button) => {
    const active = button.dataset.filter === filter;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $('#view-title').textContent = viewCopy[filter][0];
  $('#view-description').textContent = viewCopy[filter][1];
  const visible = visibleSessions();
  list.replaceChildren(...visible.map(renderCard));
  const count = visible.reduce((total, session) => total + session.tabs.length, 0);
  $('#result-summary').textContent = `${STATUSES[filter]} ${visible.length}묶음 / ${count}개 탭${$('#search').value.trim() ? ' · 검색 결과' : ''}`;
  $('#empty-state').hidden = !loaded || visible.length !== 0;
  const hasQuery = Boolean($('#search').value.trim());
  if (hasQuery) {
    $('#empty-title').textContent = '이 검색어로 찾은 묶음이 없어요.';
    $('#empty-description').textContent = '다른 제목이나 사이트, 태그로 검색하거나 왼쪽의 다른 보관함을 살펴보세요.';
  } else if (filter === 'waiting') {
    $('#empty-title').textContent = '열어 둔 탭에 잠깐의 쉼을.';
    $('#empty-description').textContent = 'Chrome 도구 모음에서 Tab Harbor를 열고 현재 탭이나 이 창의 탭을 저장해 보세요.';
  } else {
    $('#empty-title').textContent = filter === 'restored' ? '다시 연 묶음이 아직 없어요.' : '보관 처리한 묶음이 아직 없어요.';
    $('#empty-description').textContent = filter === 'restored' ? '대기 중인 묶음을 다시 열면 여기에 기록이 남습니다.' : '묶음의 상세 화면에서 보관 처리하면 이곳으로 옮겨집니다.';
  }
  $('#empty-capture').hidden = hasQuery || filter !== 'waiting';
}

async function refresh() {
  const result = await api({ type: 'list' });
  sessions = result.sessions;
  loaded = true;
  render();
}

function applySession(session) {
  sessions = [session, ...sessions.filter((item) => item.id !== session.id)];
  render();
}

function currentTags() {
  return [...new Set($('#edit-tags').value.split(',').map((value) => value.trim()).filter(Boolean))];
}

function hasUnsavedChanges() {
  return selected && ($('#edit-title').value !== selected.title || $('#edit-note').value !== (selected.note || '') || JSON.stringify(currentTags()) !== JSON.stringify(selected.tags || []));
}

function closeDetail() {
  if (hasUnsavedChanges() && !window.confirm('저장하지 않은 변경이 있습니다. 변경 내용을 버리고 닫을까요?')) return;
  dialog.close();
  if (previousFocus?.isConnected) previousFocus.focus();
  else $('#search').focus();
}

function renderDetail(session, preserveEdits = false) {
  selected = session;
  $('#detail-heading').textContent = session.title;
  $('#detail-meta').textContent = `${STATUSES[session.status]} · ${dateLabel(session.createdAt)} 저장`;
  if (!preserveEdits) {
    $('#edit-title').value = session.title;
    $('#edit-note').value = session.note || '';
    $('#edit-tags').value = (session.tags || []).join(', ');
  }
  $('#detail-tab-count').textContent = `저장한 탭 ${session.tabs.length}개`;
  $('#move-waiting').hidden = session.status === 'waiting';
  $('#move-archived').hidden = session.status === 'archived';
  const rows = session.tabs.map((tab) => {
    const row = node('li', 'detail-tab');
    const text = node('div', 'detail-tab-text');
    text.append(node('span', 'detail-tab-title', tab.title || tab.url));
    const address = node('span', 'detail-tab-url', tab.url);
    address.title = tab.url;
    text.append(address);
    if (tab.pinned) text.append(node('span', 'pinned-label', '고정된 탭'));
    if (tab.lastOpenedAt) text.append(node('span', 'opened-label', `${dateLabel(tab.lastOpenedAt)} 다시 열었음`));
    const button = node('button', 'button button-secondary button-small', '열기');
    button.type = 'button';
    button.setAttribute('aria-label', `${tab.title || tab.url} 새 창에서 열기`);
    button.addEventListener('click', () => restoreSession(selected, [tab.id]));
    row.append(siteMark(tab), text, button);
    return row;
  });
  $('#detail-tabs').replaceChildren(...rows);
}

function openDetail(id) {
  previousFocus = document.activeElement;
  return perform(async () => {
    const { session } = await api({ type: 'get', id });
    renderDetail(session);
    announce(detailFeedback, '');
    dialog.showModal();
    $('#close-detail').focus();
  });
}

async function restoreSession(session, entryIds) {
  const tabCount = entryIds?.length || session.tabs.length;
  if (tabCount > 30 && !window.confirm(`탭 ${tabCount}개를 새 창에서 엽니다. 모두 열까요?`)) return;
  const inDetail = dialog.open;
  return perform(async () => {
    const result = await api({ type: 'restore', id: session.id, entryIds, newWindow: true });
    if (dialog.open && selected?.id === session.id) renderDetail(result.session, true);
    applySession(result.session);
    const remaining = result.session.status === 'waiting' ? ' 아직 열지 않은 탭이 있어 묶음은 대기 중에 남아 있습니다.' : ' 저장한 묶음은 다시 연 기록에 남아 있습니다.';
    const message = `${isDemo ? '예시 동작: ' : ''}${result.opened}개 탭을 새 창에서 열었습니다.${result.failed?.length ? ` ${result.failed.length}개는 열지 못했습니다. 저장된 URL은 보관함에 남아 있습니다.` : remaining}`;
    announce(dialog.open && inDetail ? detailFeedback : feedback, message, result.failed?.length ? 'warning' : 'success');
  }, { detail: inDetail, pending: '탭을 새 창에서 열고 있습니다…' });
}

async function captureWindow() {
  return perform(async () => {
    const persistenceNote = await requestPersistence();
    const result = await api({ type: 'capture', scope: 'window', closeAfterSave: false });
    filter = 'waiting';
    $('#search').value = '';
    applySession(result.session);
    announce(feedback, `${isDemo ? '예시 동작: ' : ''}${captureMessage(result)}${persistenceNote ? ` ${persistenceNote}` : ''}`, result.skipped?.length || persistenceNote ? 'warning' : 'success');
  }, { pending: '현재 창의 탭을 저장하고 있습니다…' });
}

document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => { filter = button.dataset.filter; render(); }));
$('#search').addEventListener('input', render);
$('#sort').addEventListener('change', render);
$('#capture-window').addEventListener('click', captureWindow);
$('#empty-capture').addEventListener('click', captureWindow);
$('#refresh-library').addEventListener('click', () => perform(async () => { await refresh(); announce(feedback, '보관함을 새로 불러왔습니다.'); }, { pending: '보관함을 불러오고 있습니다…' }));
$('#close-detail').addEventListener('click', closeDetail);
dialog.addEventListener('cancel', (event) => { event.preventDefault(); closeDetail(); });
$('#restore-all').addEventListener('click', () => selected && restoreSession(selected));

$('#edit-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!selected) return;
  const title = $('#edit-title').value.trim();
  if (!title) { announce(detailFeedback, '묶음 이름을 입력해 주세요.', 'error'); $('#edit-title').focus(); return; }
  const changes = { title, note: $('#edit-note').value, tags: currentTags() };
  if (changes.tags.length > 20 || changes.tags.some((tag) => tag.length > 60)) { announce(detailFeedback, '태그는 최대 20개, 각 60자까지 입력해 주세요.', 'error'); $('#edit-tags').focus(); return; }
  perform(async () => {
    const { session } = await api({ type: 'update', id: selected.id, changes });
    renderDetail(session);
    applySession(session);
    announce(dialog.open ? detailFeedback : feedback, '묶음의 변경 내용을 저장했습니다.');
  }, { detail: true, pending: '변경 내용을 저장하고 있습니다…' });
});

for (const [buttonId, status] of [['#move-waiting', 'waiting'], ['#move-archived', 'archived']]) {
  $(buttonId).addEventListener('click', () => {
    if (!selected) return;
    perform(async () => {
      const { session } = await api({ type: 'update', id: selected.id, changes: { status } });
      renderDetail(session, true);
      applySession(session);
      announce(dialog.open ? detailFeedback : feedback, status === 'waiting' ? '대기 중으로 되돌렸습니다.' : '묶음을 보관 처리했습니다.');
    }, { detail: true, pending: '묶음을 옮기고 있습니다…' });
  });
}

$('#delete-session').addEventListener('click', () => {
  if (!selected || !window.confirm(`“${selected.title}” 묶음과 저장한 URL ${selected.tabs.length}개를 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return;
  perform(async () => {
    const id = selected.id;
    await api({ type: 'delete', id });
    sessions = sessions.filter((session) => session.id !== id);
    selected = null;
    dialog.close();
    render();
    announce(feedback, '묶음을 삭제했습니다.');
    $('#search').focus();
  }, { detail: true, pending: '묶음을 삭제하고 있습니다…' });
});

$('#export-backup').addEventListener('click', () => perform(async () => {
  const { data } = await api({ type: 'export' });
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  const anchor = node('a');
  anchor.href = url;
  anchor.download = `tab-harbor-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  announce(feedback, `${isDemo ? '예시 데이터의 ' : ''}백업 파일 다운로드를 요청했습니다. URL이 포함된 파일을 안전하게 보관해 주세요.`);
}, { pending: '백업 파일을 준비하고 있습니다…' }));

$('#import-backup').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { announce(feedback, '10MB 이하의 Tab Harbor JSON 백업 파일을 선택해 주세요.', 'error'); return; }
  perform(async () => {
    let data;
    try { data = JSON.parse(await file.text()); }
    catch { throw new Error('JSON 파일을 읽을 수 없습니다. Tab Harbor에서 내보낸 백업 파일인지 확인해 주세요.'); }
    const persistenceNote = await requestPersistence();
    const result = await api({ type: 'import', data });
    const message = `${result.imported}개의 묶음을 가져왔습니다. 대기 중, 다시 연 기록, 보관 처리에서 확인할 수 있습니다.${persistenceNote ? ` ${persistenceNote}` : ''}`;
    try {
      await refresh();
      announce(feedback, message, persistenceNote ? 'warning' : 'success');
    } catch {
      announce(feedback, `${result.imported}개의 묶음을 가져왔지만 목록을 새로 불러오지 못했습니다. 새로고침을 눌러 확인해 주세요.${persistenceNote ? ` ${persistenceNote}` : ''}`, 'warning');
    }
  }, { pending: '백업 파일을 확인하고 가져오는 중입니다…' });
});

perform(async () => { await refresh(); }, { pending: '' }).then(() => {
  if (!loaded) $('#result-summary').textContent = '보관함을 불러오지 못했습니다. 새로고침으로 다시 시도해 주세요.';
});
