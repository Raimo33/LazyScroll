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
  await page.waitForFunction(() => /No face/.test(document.querySelector('html > div')?.shadowRoot?.querySelector('.label')?.textContent), null, { timeout: 15000 });
  console.log('status pill:', await page.evaluate(() => document.querySelector('html > div').shadowRoot.querySelector('.label').textContent));

  // Scrolling moves the highlight; an already-liked tweet shows as liked.
  await page.evaluate(() => scrollTo(0, 3 * 261 - innerHeight / 2 + 130));
  await page.waitForFunction(() => document.querySelectorAll('article')[3].dataset.lazyscroll === 'liked', null, { timeout: 5000 });
  console.log('after scroll, focused tweet:', await focusedIndex(), '(already liked → green)');
  assert.equal(await page.locator('article[data-lazyscroll]').count(), 1);

  // Toolbar toggle turns it off and removes the highlight.
  await sw.evaluate(() => chrome.storage.local.set({ enabled: false }));
  await page.waitForFunction(() => !document.querySelector('article[data-lazyscroll]'), null, { timeout: 5000 });
  console.log('disabled: highlight removed');

  assert.deepEqual(errors, []);
  console.log('E2E OK');
} finally {
  await ctx.close();
}
