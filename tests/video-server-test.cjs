const assert = require('assert');
const http = require('http');
const { createVideoServer } = require('../video-server.cjs');

let clock = 1000;
const server = createVideoServer({ now: () => clock, lanAddresses: ['192.168.1.77'], maxQueue: 2 });
function request(method, pathname, body, headers) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? null : JSON.stringify(body);
    const finalHeaders = Object.assign({}, text ? { 'content-type': 'application/json', 'x-pixel-test': '1', 'content-length': Buffer.byteLength(text) } : {}, headers || {});
    Object.keys(finalHeaders).forEach((key) => { if (finalHeaders[key] === undefined) delete finalHeaders[key]; });
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method: method, path: pathname, headers: finalHeaders }, (res) => { let data = ''; res.on('data', (part) => { data += part; }); res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null })); });
    req.on('error', reject); if (text) req.write(text); req.end();
  });
}
(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    let r = await request('GET', '/healthz'); assert.strictEqual(r.status, 200);
    r = await request('GET', '/..%2fvideo-server.cjs'); assert.strictEqual(r.status, 404);
    for (const invalid of [null, [], 'text', 7]) { r = await request('POST', '/api/session', invalid); assert.strictEqual(r.status, 400); r = await request('GET', '/healthz'); assert.strictEqual(r.status, 200); }
    r = await request('POST', '/api/session', {}, { host: '192.168.1.77:' + server.address().port }); assert.strictEqual(r.status, 403);
    r = await request('POST', '/api/session', {}); assert.strictEqual(r.status, 201); const session = r.body;
    assert.match(session.code, /^\d{8}$/); assert.strictEqual(session.senderToken.length > 30, true); assert.strictEqual(session.receiverUrls[0], 'http://192.168.1.77:' + server.address().port + '/tv-video.html');
    r = await request('POST', '/api/join', { code: session.code }); assert.strictEqual(r.status, 200); const receiver = r.body;
    r = await request('POST', '/api/join', { code: session.code }); assert.strictEqual(r.status, 409);
    r = await request('POST', '/api/send', { token: session.senderToken, type: 'answer', data: {} }); assert.strictEqual(r.status, 400);
    r = await request('POST', '/api/send', { token: session.senderToken, type: 'offer', data: { sdp: 'x' } }); assert.strictEqual(r.status, 202);
    r = await request('GET', '/api/poll?token=' + encodeURIComponent(receiver.token) + '&after=99'); assert.strictEqual(r.status, 400);
    r = await request('GET', '/api/poll?token=' + encodeURIComponent(receiver.token) + '&after=0'); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.events.length, 1); const delivered = r.body.events[0].id;
    r = await request('GET', '/api/poll?token=' + encodeURIComponent(receiver.token) + '&after=' + delivered); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.events.length, 0);
    r = await request('POST', '/api/send', { token: session.senderToken, type: 'candidate', data: { c: 1 } }); assert.strictEqual(r.status, 202);
    r = await request('POST', '/api/send', { token: session.senderToken, type: 'candidate', data: { c: 2 } }); assert.strictEqual(r.status, 202);
    r = await request('POST', '/api/send', { token: session.senderToken, type: 'candidate', data: { c: 3 } }); assert.strictEqual(r.status, 429);
    r = await request('POST', '/api/leave', { token: session.senderToken }); assert.strictEqual(r.status, 200);
    r = await request('GET', '/api/poll?token=' + encodeURIComponent(receiver.token) + '&after=0'); assert.strictEqual(r.status, 410);
    r = await request('POST', '/api/session', {}); assert.strictEqual(r.status, 201); const expiring = r.body;
    clock += 15 * 60 * 1000 + 1;
    r = await request('GET', '/api/poll?token=' + encodeURIComponent(expiring.senderToken) + '&after=0'); assert.strictEqual(r.status, 410);
    r = await request('POST', '/api/session', {}, { origin: 'http://evil.test' }); assert.strictEqual(r.status, 403);
    r = await request('POST', '/api/session', {}, { 'x-pixel-test': undefined }); assert.strictEqual(r.status, 403);
    console.log('video-server-test: PASS');
  } finally { await new Promise((resolve) => server.close(resolve)); }
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
