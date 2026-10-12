// End-to-end smoke test: loads the unpacked extension in Chromium with a fake webcam and a mock x.com timeline.
// The fake camera has no face in it, so this covers plumbing (MediaPipe loads, frames flow, tweet highlight,
// status pill), not tracking accuracy; the detectors themselves are covered by shared.test.mjs.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tweets = Array.from({ length: 12 }, (_, i) => `
  <article data-testid="tweet" style="height:260px;border-bottom:1px solid #ccc;padding:12px">
    Tweet ${i} <button data-testid="${i === 3 ? 'unlike' : 'like'}">♥</button>
  </article>`).join('');
const timeline = `<!doctype html><html><body style="margin:0"><main style="width:600px;margin:auto">${tweets}</main></body></html>`;

const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  args: [
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
  ],
});

try {
  let [sw] = ctx.serviceWorkers();
  sw ??= await ctx.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;

  // Install opens the welcome page.
  const welcome = ctx.pages().find((p) => p.url().includes('welcome.html')) ??
    await ctx.waitForEvent('page', { predicate: (p) => p.url().includes('welcome.html'), timeout: 10000 });
  await welcome.waitForLoadState();
  const errors = [];
  welcome.on('pageerror', (e) => errors.push(e.message));

  // Grant camera from the welcome page, then wait for the offscreen sensor to report frames.
  if (await welcome.isVisible('#camera-btn')) await welcome.click('#camera-btn');
  await welcome.waitForFunction(() => /No face detected|Tracking/.test(document.querySelector('#live-status').textContent), null, { timeout: 30000 });
  console.log('sensor:', await welcome.textContent('#live-status'));

  // Settings round-trip through storage.
  await welcome.check('input[name="debugGaze"]');
  const stored = await sw.evaluate(() => chrome.storage.local.get('debugGaze'));
  assert.equal(stored.debugGaze, true);

  // Mock x.com.
  await ctx.route('https://x.com/**', (route) => route.fulfill({ contentType: 'text/html', body: timeline }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('https://x.com/home');
  await page.waitForSelector('article[data-lazyscroll]', { timeout: 10000 });
  const focusedIndex = () => page.evaluate(() =>
    [...document.querySelectorAll('article')].findIndex((a) => a.dataset.lazyscroll));
  console.log('focused tweet:', await focusedIndex(), await page.getAttribute('article[data-lazyscroll]', 'data-lazyscroll'));

  // The content script is connected to the sensor: its status pill reports the (faceless) camera feed.
  await page.waitForFunction(() => /No face/.test(document.querySelector('#lazyscroll-hud')?.shadowRoot?.querySelector('.label')?.textContent), null, { timeout: 15000 });
  console.log('status pill:', await page.evaluate(() => document.querySelector('#lazyscroll-hud').shadowRoot.querySelector('.label').textContent));

  // Scrolling moves the highlight; an already-liked tweet shows as liked.
  await page.evaluate(() => scrollTo(0, 3 * 261 - innerHeight / 2 + 130));
  await page.waitForFunction(() => document.querySelectorAll('article')[3].dataset.lazyscroll === 'liked', null, { timeout: 5000 });
  console.log('after scroll, focused tweet:', await focusedIndex(), '(already liked → green)');
  assert.equal(await page.locator('article[data-lazyscroll]').count(), 1);

  // Any other site: scrolling runs (status pill connected to the sensor), but no post highlight.
  await ctx.route('https://example.com/**', (route) => route.fulfill({ contentType: 'text/html',
    body: '<!doctype html><div id="pane" style="height:300px;overflow:auto"><div style="height:3000px">long</div></div>' }));
  const other = await ctx.newPage();
  other.on('pageerror', (e) => errors.push(e.message));
  await other.goto('https://example.com/');
  await other.waitForFunction(() => /No face/.test(document.querySelector('#lazyscroll-hud')?.shadowRoot?.querySelector('.label')?.textContent), null, { timeout: 15000 });
  assert.equal(await other.locator('[data-lazyscroll]').count(), 0);
  console.log('other site: status pill connected, no like highlight');

  // Switching a single site off removes LazyScroll there only.
  await sw.evaluate(() => chrome.storage.local.set({ disabledSites: ['example.com'] }));
  await other.waitForFunction(() => !document.querySelector('#lazyscroll-hud'), null, { timeout: 5000 });
  assert.ok(await page.locator('#lazyscroll-hud').count() === 1, 'x.com should be unaffected');
  console.log('site disabled: pill gone on example.com, still on x.com');

  // The toolbar popup renders.
  const popup = await ctx.newPage();
  popup.on('pageerror', (e) => errors.push(e.message));
  await popup.goto(`chrome-extension://${id}/src/popup.html`);
  await popup.waitForSelector('#enabled');
  console.log('popup:', (await popup.textContent('main')).replace(/\s+/g, ' ').trim());

  // Toolbar toggle turns it off and removes the highlight.
  await sw.evaluate(() => chrome.storage.local.set({ enabled: false }));
  await page.waitForFunction(() => !document.querySelector('article[data-lazyscroll]'), null, { timeout: 5000 });
  console.log('disabled: highlight removed');

  assert.deepEqual(errors, []);
  console.log('E2E OK');
} finally {
  await ctx.close();
}
