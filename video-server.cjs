/* Local-only signaling and static server for the isolated TV video test. */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const STATIC = new Set(['tv-video.html', 'video-test.css', 'video-ui.js', 'video-rtc.js', 'tv-test.html', 'tv-test.js', 'tv-test.css', 'tv-rtc.js']);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8' };
const PAIRING_MS = 15 * 60 * 1000;
const ACTIVE_MS = 60 * 60 * 1000;
const TOMBSTONE_MS = 60 * 1000;

function localAddresses() {
  const result = new Set(['127.0.0.1', '::1', 'localhost']);
  Object.keys(os.networkInterfaces()).forEach((name) => {
    (os.networkInterfaces()[name] || []).forEach((entry) => {
      if (entry && entry.family === 'IPv4' && !entry.internal) result.add(entry.address);
    });
  });
  return result;
}

function token() { return crypto.randomBytes(32).toString('base64url'); }
function pin() { return String(crypto.randomInt(0, 100000000)).padStart(8, '0'); }
function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}
function error(res, status, message) { json(res, status, { error: message }); }
function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (chunk) => { size += chunk.length; if (size > 65536) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => { try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid JSON object'); resolve(value); } catch (_) { reject(Object.assign(new Error('invalid JSON object'), { status: 400 })); } });
    req.on('error', () => reject(Object.assign(new Error('invalid request'), { status: 400 })));
  });
}

function createVideoServer(options) {
  options = options || {};
  const now = options.now || Date.now;
  const maxSessions = options.maxSessions || 8;
  const maxQueue = options.maxQueue || 256;
  const addresses = new Set(options.lanAddresses || Array.from(localAddresses()));
  addresses.add('127.0.0.1'); addresses.add('::1'); addresses.add('localhost');
  const sessions = new Map();
  const joinBuckets = new Map();

  function cleanup() {
    const at = now();
    sessions.forEach((session, code) => {
      if (session.state !== 'terminal' && at >= session.expiresAt) { session.state = 'terminal'; session.terminalUntil = at + TOMBSTONE_MS; }
      if (session.state === 'terminal' && at >= session.terminalUntil) sessions.delete(code);
    });
    joinBuckets.forEach((items, ip) => { const recent = items.filter((item) => item > at - 60000); if (recent.length) joinBuckets.set(ip, recent); else joinBuckets.delete(ip); });
  }
  function portFor(req) { const address = server.address(); return address && address.port ? String(address.port) : (req.headers.host || '').split(':').pop(); }
  function hostAllowed(req) {
    const rawHost = String(req.headers.host || ''); const portMatch = rawHost.match(/:(\d+)$/);
    const requestedPort = portMatch ? portMatch[1] : '';
    const host = rawHost.replace(/:(\d+)$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    return addresses.has(host) && (!requestedPort || requestedPort === portFor(req));
  }
  function originAllowed(req) {
    if (!req.headers.origin) return true;
    let parsed; try { parsed = new URL(req.headers.origin); } catch (_) { return false; }
    return parsed.protocol === 'http:' && parsed.host.toLowerCase() === String(req.headers.host || '').toLowerCase();
  }
  function loopback(req) {
    const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    return ip === '127.0.0.1' || ip === '::1';
  }
  function loopbackHost(req) {
    const rawHost = String(req.headers.host || '').replace(/:(\d+)$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    return rawHost === 'localhost' || rawHost === '127.0.0.1' || rawHost === '::1';
  }
  function requireJsonWrite(req, res) {
    if (req.headers['x-pixel-test'] !== '1') { error(res, 403, 'missing X-Pixel-Test header'); return false; }
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) { error(res, 415, 'application/json required'); return false; }
    if (!hostAllowed(req) || !originAllowed(req)) { error(res, 403, 'invalid host or origin'); return false; }
    return true;
  }
  function findToken(value) {
    let hit = null;
    sessions.forEach((session) => {
      if (hit) return;
      if (safeEqual(value, session.senderToken)) hit = { session: session, role: 'sender' };
      else if (session.receiverToken && safeEqual(value, session.receiverToken)) hit = { session: session, role: 'receiver' };
    });
    return hit;
  }
  function terminal(res, session) { if (session.state === 'terminal') { error(res, 410, 'session closed or expired'); return true; } return false; }
  function enqueue(session, role, type, data) {
    const mailbox = session.mailboxes[role];
    if (mailbox.events.length >= maxQueue) return false;
    session.sequence += 1;
    mailbox.events.push({ id: session.sequence, type: type, data: data });
    return true;
  }
  function endpointFor(req) {
    const host = String(req.headers.host || '');
    const port = portFor(req);
    const local = Array.from(addresses).filter((item) => /^\d+\.\d+\.\d+\.\d+$/.test(item) && item !== '127.0.0.1');
    return local.map((ip) => 'http://' + ip + ':' + port + '/tv-video.html');
  }

  const server = http.createServer(async (req, res) => {
    try {
    cleanup();
    const rawPath = String(req.url || '').split('?')[0];
    if (req.method === 'OPTIONS') return error(res, 405, 'OPTIONS not supported');
    if (!hostAllowed(req) || !originAllowed(req)) return error(res, 403, 'invalid host or origin');
    if (req.method === 'GET' && rawPath === '/healthz') return json(res, 200, { ok: true });
    if (req.method === 'GET' && (rawPath === '/' || rawPath === '/tv-video.html' || STATIC.has(rawPath.slice(1)))) {
      const file = rawPath === '/' ? 'tv-video.html' : rawPath.slice(1);
      if (!STATIC.has(file) || file.indexOf('/') !== -1 || file.indexOf('\\') !== -1) return error(res, 404, 'not found');
      const filePath = path.join(ROOT, file);
      return fs.readFile(filePath, (readError, data) => {
        if (readError) return error(res, 404, 'not found');
        res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'" });
        res.end(data);
      });
    }
    if (!rawPath.startsWith('/api/')) return error(res, 404, 'not found');
    if (req.method === 'POST' && rawPath === '/api/session') {
      if (!requireJsonWrite(req, res)) return;
      if (!loopback(req) || !loopbackHost(req)) return error(res, 403, 'session creation is local only');
      try { await readJson(req); } catch (e) { return error(res, e.status || 400, e.message); }
      if (sessions.size >= maxSessions) return error(res, 429, 'session limit reached');
      let code; do { code = pin(); } while (sessions.has(code));
      const at = now(); const session = { code: code, senderToken: token(), receiverToken: null, state: 'pairing', expiresAt: at + PAIRING_MS, terminalUntil: 0, sequence: 0, mailboxes: { sender: { events: [], acked: 0, delivered: 0 }, receiver: { events: [], acked: 0, delivered: 0 } } };
      sessions.set(code, session);
      return json(res, 201, { code: code, senderToken: session.senderToken, expiresAt: session.expiresAt, receiverUrls: endpointFor(req) });
    }
    if (req.method === 'POST' && rawPath === '/api/join') {
      if (!requireJsonWrite(req, res)) return;
      let body; try { body = await readJson(req); } catch (e) { return error(res, e.status || 400, e.message); }
      const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, ''); const at = now(); const bucket = (joinBuckets.get(ip) || []).filter((item) => item > at - 60000);
      if (bucket.length >= 10) return error(res, 429, 'join rate limit reached'); bucket.push(at); joinBuckets.set(ip, bucket);
      const session = sessions.get(String(body.code || ''));
      if (!session) return error(res, 404, 'session not found'); if (terminal(res, session)) return;
      if (session.state !== 'pairing' || session.receiverToken) return error(res, 409, 'session already paired');
      session.receiverToken = token(); session.state = 'active'; session.expiresAt = at + ACTIVE_MS;
      return json(res, 200, { token: session.receiverToken, expiresAt: session.expiresAt });
    }
    if (req.method === 'GET' && rawPath === '/api/poll') {
      const query = new URL(req.url, 'http://local').searchParams; const auth = findToken(query.get('token') || '');
      if (!auth) return error(res, 401, 'invalid token'); if (terminal(res, auth.session)) return;
      const afterText = query.get('after'); const after = /^\d+$/.test(String(afterText || '0')) ? Number(afterText || 0) : NaN;
      const mailbox = auth.session.mailboxes[auth.role];
      if (!Number.isSafeInteger(after) || after < mailbox.acked || after > mailbox.delivered) return error(res, 400, 'invalid polling cursor');
      mailbox.acked = after; mailbox.events = mailbox.events.filter((event) => event.id > after);
      const events = mailbox.events.slice(0, maxQueue); if (events.length) mailbox.delivered = events[events.length - 1].id;
      return json(res, 200, { events: events, peerPresent: !!auth.session.receiverToken, expiresAt: auth.session.expiresAt });
    }
    if (req.method === 'POST' && rawPath === '/api/send') {
      if (!requireJsonWrite(req, res)) return;
      let body; try { body = await readJson(req); } catch (e) { return error(res, e.status || 400, e.message); }
      const auth = findToken(body.token || ''); if (!auth) return error(res, 401, 'invalid token'); if (terminal(res, auth.session)) return;
      const type = String(body.type || ''); const allowed = auth.role === 'sender' ? ['offer', 'candidate'] : ['answer', 'candidate', 'report'];
      if (allowed.indexOf(type) === -1 || !body.data || typeof body.data !== 'object' || Array.isArray(body.data)) return error(res, 400, 'invalid message');
      const target = auth.role === 'sender' ? 'receiver' : 'sender';
      if (!auth.session.receiverToken && target === 'receiver') return error(res, 409, 'receiver not joined');
      if (!enqueue(auth.session, target, type, body.data)) return error(res, 429, 'peer queue full');
      return json(res, 202, { ok: true });
    }
    if (req.method === 'POST' && rawPath === '/api/leave') {
      if (!requireJsonWrite(req, res)) return;
      let body; try { body = await readJson(req); } catch (e) { return error(res, e.status || 400, e.message); }
      const auth = findToken(body.token || ''); if (!auth) return error(res, 401, 'invalid token'); if (terminal(res, auth.session)) return;
      auth.session.state = 'terminal'; auth.session.terminalUntil = now() + TOMBSTONE_MS;
      return json(res, 200, { ok: true });
    }
    return error(res, 404, 'not found');
    } catch (_) { if (!res.headersSent) return error(res, 500, 'internal server error'); res.destroy(); }
  });
  server.videoTest = { sessions: sessions, cleanup: cleanup };
  return server;
}

module.exports = { createVideoServer: createVideoServer };

if (require.main === module) {
  const port = Number(process.env.PORT || 8766);
  const server = createVideoServer();
  server.listen(port, '0.0.0.0', () => {
    const addresses = Array.from(localAddresses()).filter((item) => /^\d+\.\d+\.\d+\.\d+$/.test(item) && item !== '127.0.0.1');
    process.stdout.write('Sender: http://localhost:' + port + '/tv-video.html\n');
    addresses.forEach((ip) => process.stdout.write('TV: http://' + ip + ':' + port + '/tv-video.html\n'));
  });
}
