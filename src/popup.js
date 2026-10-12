const $ = (s) => document.querySelector(s);

(async () => {
  const settings = await lazyScrollSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = null;
  try {
    const u = new URL(tab?.url ?? '');
    if (u.protocol === 'http:' || u.protocol === 'https:') host = u.hostname;
  } catch {}

  $('#enabled').checked = settings.enabled;
  $('#enabled').addEventListener('change', (e) => chrome.storage.local.set({ enabled: e.target.checked }));

  if (host) {
    $('#site-label').textContent = `On ${host.replace(/^www\./, '')}`;
    $('#site').checked = !settings.disabledSites.includes(host);
    $('#site').addEventListener('change', async (e) => {
      const { disabledSites } = await lazyScrollSettings();
      const next = e.target.checked ? disabledSites.filter((h) => h !== host) : [...new Set([...disabledSites, host])];
      chrome.storage.local.set({ disabledSites: next });
    });
  } else {
    $('#site-row').hidden = true;
  }

  const notes = [];
  if (!host) notes.push('LazyScroll can\'t run on this page.');
  if (!settings.gazeModel) notes.push('Calibrate once to turn on eye scrolling.');
  if (host && /(^|\.)(x|twitter)\.com$/.test(host) && settings.likeOnSmile) notes.push('Smile to like the outlined post.');
  $('#note').textContent = notes.join(' ');
  $('#note').hidden = !notes.length;

  $('#settings').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
})();
