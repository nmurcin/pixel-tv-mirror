/* Run with: NODE_PATH=../.pixel-tv-tools/node_modules node tests/diagnostic-validation.cjs */
const fs = require('fs');
const http = require('http');
const path = require('path');
const assert = require('assert');
const acorn = require('acorn');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const chrome = process.env.CHROME_PATH;
const externalRequests = [];
let testUrl;
let localPrefix;

function serve(req, res) {
  const relative = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'tv-test.html';
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep) && file !== root) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (error, body) => {
    if (error) { res.writeHead(404); return res.end(); }
    const type = /\.html$/.test(file) ? 'text/html' : /\.js$/.test(file) ? 'application/javascript' : /\.css$/.test(file) ? 'text/css' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type }); res.end(body);
  });
}

function parseEs5() {
  ['tv-test.js', 'tv-rtc.js'].forEach((name) => acorn.parse(fs.readFileSync(path.join(root, name), 'utf8'), { ecmaVersion: 5 }));
  const html = fs.readFileSync(path.join(root, 'tv-test.html'), 'utf8');
  const scripts = html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi) || [];
  scripts.forEach((tag) => acorn.parse(tag.replace(/^.*?>|<\/script>$/gi, ''), { ecmaVersion: 5 }));
}

async function text(page, id) { return page.locator('#' + id).textContent(); }
async function runPass(page, label, expect, requireMessage) {
  await page.locator('#runButton').click();
  await page.waitForFunction(() => document.getElementById('runButton').disabled === false, null, { timeout: 30000 });
  const summary = await text(page, 'compactResult');
  const state = await text(page, 'runState');
  const steps = await text(page, 'rtcSteps');
  process.stdout.write(label + ': ' + summary + '\n' + steps + '\n');
  assert.match(state, /complete|passed|failed|unavailable/i, label + ': completion state missing');
  if (requireMessage && !/RTC_SELF=1/.test(summary)) {
    await page.screenshot({ path: path.resolve(root, '..', '.pixel-tv-tools', 'diagnostic-validation-failure-1280x720.png') });
    await page.screenshot({ path: path.resolve(root, '..', '.pixel-tv-tools', 'diagnostic-validation-failure.png'), fullPage: true });
  }
  expect(summary);
  if (requireMessage) assert.match(steps, /MESSAGE[\s\S]*PASS/, label + ': message step did not pass');
  return { summary, state };
}

async function scenario(browser, name, init, verify) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    if (!request.url().startsWith(localPrefix)) externalRequests.push(request.url());
  });
  if (init) await page.addInitScript(init);
  await page.goto(testUrl);
  await verify(page);
  assert.deepStrictEqual(pageErrors, [], name + ': unexpected page errors: ' + pageErrors.join('; '));
  await page.close();
  process.stdout.write('PASS ' + name + '\n');
}

(async () => {
  assert.ok(chrome, 'Set CHROME_PATH to an installed Chrome or Edge executable.');
  parseEs5();
  const server = http.createServer(serve);
  let ownsServer = !process.env.TEST_URL;
  if (ownsServer) await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  testUrl = process.env.TEST_URL || ('http://127.0.0.1:' + server.address().port + '/tv-test.html');
  localPrefix = new URL(testUrl).origin + '/';
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  try {
    await scenario(browser, 'actual RTC twice', null, async (page) => {
      await runPass(page, 'first RTC run', (summary) => { assert.match(summary, /RTC_SELF=1/); assert.match(summary, /DC=1/); }, true);
      await runPass(page, 'second RTC run', (summary) => { assert.match(summary, /RTC_SELF=1/); assert.match(summary, /DC=1/); }, true);
      await page.screenshot({ path: path.resolve(root, '..', '.pixel-tv-tools', 'diagnostic-validation-1280x720.png') });
      await page.screenshot({ path: path.resolve(root, '..', '.pixel-tv-tools', 'diagnostic-validation.png'), fullPage: true });
    });
    await scenario(browser, 'missing RTC aliases and MSE', () => {
      ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection', 'MediaSource', 'WebKitMediaSource'].forEach((key) => { try { Object.defineProperty(window, key, { value: undefined, configurable: true }); } catch (_) {} });
    }, async (page) => { assert.match(await text(page, 'compactResult'), /RTC=0[\s\S]*MSE=0/); await runPass(page, 'missing RTC', (s) => assert.match(s, /RTC_SELF=0/)); });
    await scenario(browser, 'storage getters throw', () => {
      ['localStorage', 'sessionStorage'].forEach((key) => { try { Object.defineProperty(window, key, { configurable: true, get: () => { throw new Error(key + ' blocked'); } }); } catch (_) {} });
    }, async (page) => { assert.match(await text(page, 'apiProbes'), /localStorage read\/write: UNKNOWN/); assert.match(await text(page, 'apiProbes'), /sessionStorage read\/write: UNKNOWN/); assert.match(await text(page, 'compactResult'), /JS=1[\s\S]*UA=Mozilla/); assert.notStrictEqual(await text(page, 'mediaProbes'), ''); });
    await scenario(browser, 'media and receiver getters throw', () => {
      ['MediaSource', 'WebKitMediaSource'].forEach((key) => { try { Object.defineProperty(window, key, { configurable: true, get: () => { throw new Error(key + ' blocked'); } }); } catch (_) {} });
      try { Object.defineProperty(window, 'RTCRtpReceiver', { configurable: true, get: () => { throw new Error('receiver blocked'); } }); } catch (_) {}
      try { Object.defineProperty(navigator, 'appVersion', { configurable: true, get: () => { throw new Error('appVersion blocked'); } }); } catch (_) {}
    }, async (page) => { const summary = await text(page, 'compactResult'); assert.match(summary, /H264_MSE=\?/); assert.notStrictEqual(await text(page, 'mediaProbes'), ''); assert.notStrictEqual(await text(page, 'rtcCapabilities'), ''); });
    await scenario(browser, 'RTC constructor throws', () => { Object.defineProperty(window, 'RTCPeerConnection', { configurable: true, value: function () { throw new Error('constructor blocked'); } }); }, async (page) => { await runPass(page, 'throwing constructor', (s) => assert.match(s, /RTC_SELF=0/)); });
    await scenario(browser, 'offer rejects', () => {
      function FakePC() { this.connectionState = 'new'; this.iceConnectionState = 'new'; }
      FakePC.prototype.createDataChannel = function () { return { readyState: 'connecting', close: function () {} }; };
      FakePC.prototype.createOffer = function () { return Promise.reject(new Error('offer rejected')); };
      FakePC.prototype.close = function () {};
      Object.defineProperty(window, 'RTCPeerConnection', { configurable: true, value: FakePC });
    }, async (page) => { await runPass(page, 'rejected offer', (s) => assert.match(s, /RTC_SELF=0/)); assert.match(await text(page, 'rtcSteps'), /OFFER[\s\S]*FAIL/); });
    await scenario(browser, 'reported runtime errors preserve summary', null, async (page) => {
      const before = await text(page, 'compactResult');
      await page.evaluate(() => { window.onerror('<img src=x onerror=alert(1)> forced error', 'test', 1); const e = new Event('unhandledrejection'); Object.defineProperty(e, 'reason', { value: new Error('forced rejection') }); window.dispatchEvent(e); });
      assert.strictEqual(await text(page, 'compactResult'), before);
      assert.match(await text(page, 'errorLog'), /<img src=x onerror=alert\(1\)> forced error[\s\S]*forced rejection/);
      assert.strictEqual(await page.locator('#errorLog img').count(), 0, 'error text was parsed as markup');
    });
    assert.deepStrictEqual(externalRequests, [], 'external browser requests occurred: ' + externalRequests.join(', '));
    process.stdout.write('PASS only local assets requested; ES5 parsing passed\n');
  } finally { await browser.close(); if (ownsServer) await new Promise((resolve) => server.close(resolve)); }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
