importScripts('shared.js');

const OFFSCREEN_URL = 'src/offscreen.html';
let creating = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  if (contexts.length) return;
  creating ??= chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Keeps the webcam open so expression checks start instantly.',
  }).finally(() => { creating = null; });
  await creating;
}

async function refreshBadge() {
  const { enabled, apiKey } = await autolikeSettings();
  const text = !apiKey ? 'KEY' : enabled ? '' : 'OFF';
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: apiKey ? '#536471' : '#f4212e' });
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome.html') });
  refreshBadge();
});
chrome.runtime.onStartup.addListener(refreshBadge);
chrome.storage.onChanged.addListener(refreshBadge);

chrome.action.onClicked.addListener(async () => {
  const { apiKey, enabled } = await autolikeSettings();
  if (!apiKey) return chrome.runtime.openOptionsPage();
  await chrome.storage.local.set({ enabled: !enabled });
});

// Only the service worker answers these two; everything else goes to the offscreen page.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.to !== 'background') return;
  if (msg.type === 'ensure-offscreen') {
    ensureOffscreen().then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'open-settings') chrome.runtime.openOptionsPage();
});
