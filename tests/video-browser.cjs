/* Stage 2 real-browser tests. NODE_PATH must resolve playwright and acorn. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const acorn = require('acorn');
const { createVideoServer } = require('../video-server.cjs');
const root = path.resolve(__dirname, '..');
const seconds = Number(process.env.VIDEO_TEST_SECONDS || 15);

async function instrument(page) {
  await page.addInitScript(() => {
    window.__testPeers = [];
    const Original = window.RTCPeerConnection;
    function Wrapped(config, constraints) {
      const pc = new Original(config, constraints);
      window.__testPeers.push(pc);
      return pc;
    }
    Wrapped.prototype = Original.prototype;
    Object.setPrototypeOf(Wrapped, Original);
    window.RTCPeerConnection = Wrapped;
  });
}
async function captureReports(page) {
  await page.evaluate(() => {
    window.__videoReports = [];
    const original = window.PixelVideoRTC.start;
    window.PixelVideoRTC.start = function (options) {
      const report = options.report;
      options.report = function (snapshot) {
        window.__videoReports.push(snapshot);
        if (window.__videoReports.length > 300) window.__videoReports.shift();
        report(snapshot);
      };
      return original(options);
    };
  });
}
async function runPair(browser, base, mode, receiverBase) {
  const senderContext = await browser.newContext();
  const receiverContext = await browser.newContext();
  const sender = await senderContext.newPage();
  const receiver = await receiverContext.newPage();
  const faults = [], unexpected = [];
  for (const page of [sender, receiver]) {
    await instrument(page);
    page.on('pageerror', err => faults.push(err.message));
    page.on('request', req => { if (!req.url().startsWith(base) && !req.url().startsWith(receiverBase)) unexpected.push(req.url()); });
  }
  try {
    await sender.goto(base + '/tv-video.html');
    await receiver.goto(receiverBase + '/tv-video.html?role=receiver');
    console.log(mode + ' receiver secure context:', await receiver.evaluate(() => window.isSecureContext));
    await captureReports(sender);
    await captureReports(receiver);
    await sender.locator('#mode').selectOption(mode);
    await sender.locator('#createButton').click();
    await sender.waitForFunction(() => /\d{8}/.test(document.getElementById('pairCode').textContent));
    const code = (await sender.locator('#pairCode').textContent()).match(/\d{8}/)[0];
    await receiver.locator('#roomCode').fill(code);
    await receiver.locator('#joinButton').click();
    await receiver.waitForFunction(() => {
      const video = document.getElementById('remoteVideo');
      return video.videoWidth > 0 && video.currentTime > 1;
    }, null, { timeout: 45000 });
    const initial = await receiver.evaluate(() => {
      const v = document.getElementById('remoteVideo');
      return {time:v.currentTime, frames:v.getVideoPlaybackQuality().totalVideoFrames, width:v.videoWidth, height:v.videoHeight};
    });
    assert.ok(initial.width > 0 && initial.width <= 1280, 'Receiver must report actual adaptive video width');
    assert.ok(initial.height > 0 && initial.height <= 720);
    assert.ok(Math.abs(initial.width / initial.height - 16 / 9) < 0.02);
    assert.deepEqual(await sender.locator('#patternCanvas').evaluate(c => [c.width, c.height]), [1280, 720]);
    let lastFrames = initial.frames;
    let stalled = 0;
    for (let elapsed = 0; elapsed < seconds; elapsed += 5) {
      await new Promise(resolve => setTimeout(resolve, 5000));
      const current = await receiver.evaluate(() => document.getElementById('remoteVideo').getVideoPlaybackQuality().totalVideoFrames);
      if (current <= lastFrames) stalled += 5; else stalled = 0;
      assert.ok(stalled < 10, 'Video stalled for 10 seconds');
      lastFrames = current;
      if ((elapsed + 5) % 30 === 0) console.log(mode + ': ' + (elapsed + 5) + ' seconds, displayed frames=' + current);
    }
    const reports = await receiver.evaluate(() => window.__videoReports);
    console.log(mode + ' receiver report:', JSON.stringify(reports[reports.length - 1]));
    assert.ok(lastFrames > initial.frames + 30, 'Decoded/displayed frames must actually increase');
    if (mode === 'h264') {
      assert.ok(reports.some(report => /h264/i.test(String(report.codec)) && /RTP stats/i.test(String(report.codecSource))), 'H264 must be confirmed by RTP stats');
    }
    assert.deepEqual(faults, [], 'Unexpected runtime exceptions');
    assert.deepEqual(unexpected, [], 'No external requests permitted');
    const evidenceDir = path.resolve(root, '..', '.pixel-tv-tools');
    fs.mkdirSync(evidenceDir, {recursive:true});
    await receiver.screenshot({ path:path.join(evidenceDir, 'stage2-' + mode + '-receiver.png'), fullPage:true });
    await sender.screenshot({ path:path.join(evidenceDir, 'stage2-' + mode + '-sender.png'), fullPage:true });
    await sender.locator('#stopButton').click();
    await receiver.waitForFunction(() => window.__testPeers.length > 0 && window.__testPeers.every(pc => pc.signalingState === 'closed'), null, {timeout:10000});
    assert.ok(await sender.evaluate(() => window.__testPeers.every(pc => pc.signalingState === 'closed')));
    console.log('PASS ' + mode + ': real video, dimensions, advancing frames, cleanup, no external requests');
  } catch (error) {
    console.error('SENDER:', await sender.locator('body').innerText().catch(() => 'unavailable'));
    console.error('RECEIVER:', await receiver.locator('body').innerText().catch(() => 'unavailable'));
    throw error;
  } finally {
    await senderContext.close();
    await receiverContext.close();
  }
}
(async () => {
  for (const name of ['video-rtc.js', 'video-ui.js']) acorn.parse(fs.readFileSync(path.join(root,name),'utf8'), {ecmaVersion:5});
  const html = fs.readFileSync(path.join(root,'tv-video.html'),'utf8');
  assert.ok(!/type\s*=\s*["']module/.test(html));
  const server = createVideoServer();
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const receiverBase = process.env.TV_TEST_HOST ? 'http://' + process.env.TV_TEST_HOST + ':' + server.address().port : base;
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',headless:true});
  try {
    await runPair(browser,base,'h264',receiverBase);
    await runPair(browser,base,'auto',receiverBase);
    console.log('PASS Stage 2 ES5 and browser integration');
  } finally {
    await browser.close();
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode=1; });
