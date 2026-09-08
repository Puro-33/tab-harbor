import { api, announce, captureMessage, isDemo, requestPersistence, showDemoBanner } from './ui.js';

const form = document.querySelector('#capture-form');
const feedback = document.querySelector('#popup-feedback');
const count = document.querySelector('#waiting-count');
showDemoBanner();

async function loadCount() {
  const { sessions } = await api({ type: 'list' });
  count.textContent = `대기 중인 묶음 ${sessions.filter((session) => session.status === 'waiting').length}개`;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (form.getAttribute('aria-busy') === 'true') return;
  const scope = event.submitter?.value === 'tab' ? 'tab' : 'window';
  const title = document.querySelector('#capture-title').value.trim();
  const closeAfterSave = document.querySelector('#close-after-save').checked;
  const buttons = [...form.querySelectorAll('button, input')];
  form.setAttribute('aria-busy', 'true');
  buttons.forEach((button) => { button.disabled = true; });
  announce(feedback, '탭을 저장하고 있습니다…', 'pending');
  try {
    const persistenceNote = await requestPersistence();
    const result = await api({ type: 'capture', scope, title: title || undefined, closeAfterSave });
    announce(feedback, `${isDemo ? '예시 동작: ' : ''}${captureMessage(result)}${persistenceNote ? ` ${persistenceNote}` : ''}`, result.closeFailed?.length || result.skipped?.length || persistenceNote ? 'warning' : 'success');
    form.reset();
    try { await loadCount(); }
    catch { count.textContent = '저장 완료 · 보관함에서 확인'; }
  } catch (error) {
    announce(feedback, error.message, 'error');
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
    form.removeAttribute('aria-busy');
  }
});

document.querySelector('#open-library').addEventListener('click', async () => {
  try {
    if (isDemo) window.open('dashboard.html?demo=1', '_blank', 'noopener');
    else await chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  } catch (error) {
    announce(feedback, error.message, 'error');
  }
});

loadCount().catch((error) => announce(feedback, error.message, 'error'));
