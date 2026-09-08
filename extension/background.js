import { createRepository } from './lib/db.js';
import { createService } from './lib/service.js';

const service = createService({ repository: createRepository(), browser: chrome });
const extensionOrigin = chrome.runtime.getURL('');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(extensionOrigin)) return false;
  Promise.resolve()
    .then(() => service.handleMessage(message))
    .then((payload) => sendResponse({ ok: true, ...payload }))
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : '작업을 완료하지 못했습니다. 다시 시도해 주세요.' }));
  return true;
});
