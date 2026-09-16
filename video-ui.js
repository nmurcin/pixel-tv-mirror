(function () {
  'use strict';

  var doc = document;
  var generation = 0, requests = [], pollTimer = null, engine = null, sessionToken = '';
  var cursor = 0, sendQueue = [], sending = false, pollFailures = 0, role = '', latestLocal = null, latestRemote = null;
  var errors = [], evidenceFrames = -1, evidenceVideoTime = -1;

  function el(id) { return doc.getElementById(id); }
  function text(id, value) { var node = el(id); if (node) { node.textContent = String(value); } }
  function show(id, visible) { var node = el(id); if (node) { node.hidden = !visible; } }
  function errorText(error) {
    if (error && (error.name || error.message)) { return (error.name ? String(error.name) + ': ' : '') + (error.message ? String(error.message) : ''); }
    return String(error || 'Unknown error');
  }
  function addError(context, error) { errors.push(context + ': ' + errorText(error)); if (errors.length > 50) { errors.shift(); } text('errorLog', errors.join('\n')); }
  function setStatus(value) { text('status', value); }
  function safe(context, operation) {
    try { return { ok: true, value: operation() }; }
    catch (error) { addError(context, error); return { ok: false, value: null }; }
  }
  window.onerror = function (message, source, line) { addError('ERROR', String(message) + ' (' + String(source || 'inline') + ':' + String(line || 0) + ')'); };
  if (window.addEventListener) { window.addEventListener('unhandledrejection', function (event) { addError('UNHANDLED REJECTION', event && event.reason); }); }

  function queryValue(name) {
    var search = String(window.location.search || '').replace(/^\?/, '').split('&'), i, pair;
    for (i = 0; i < search.length; i += 1) { pair = search[i].split('='); if (decodeURIComponent(pair[0] || '') === name) { return decodeURIComponent((pair[1] || '').replace(/\+/g, ' ')); } }
    return '';
  }
  function isLoopback(hostname) { return hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || /^127\./.test(hostname); }
  function isStaticLocation() { var hostname = String(window.location.hostname || '').toLowerCase(); return /(^|\.)github\.io$/.test(hostname) || window.location.protocol === 'file:'; }
  function removeRequest(xhr) { var i; for (i = requests.length - 1; i >= 0; i -= 1) { if (requests[i] === xhr) { requests.splice(i, 1); } } }
  function abortRequests() { var list = requests.slice(0), i; requests = []; for (i = 0; i < list.length; i += 1) { try { list[i].onreadystatechange = null; list[i].abort(); } catch (ignore) {} } }
  function parseResponse(xhr) {
    var result;
    try { result = xhr.responseText ? JSON.parse(xhr.responseText) : {}; }
    catch (error) { return { ok: false, error: { status: xhr.status, message: 'Invalid JSON response: ' + errorText(error) } }; }
    if (xhr.status < 200 || xhr.status >= 300) { return { ok: false, error: { status: xhr.status, message: result && result.error ? String(result.error) : 'HTTP ' + String(xhr.status) } }; }
    return { ok: true, value: result };
  }
  function request(method, url, body, run, callback) {
    var xhr = new XMLHttpRequest(), completed = false;
    function finish(error, value) { if (completed) { return; } completed = true; removeRequest(xhr); if (run === generation) { callback(error, value); } }
    requests.push(xhr); xhr.open(method, url, true); xhr.timeout = 12000;
    if (method === 'POST') { xhr.setRequestHeader('Content-Type', 'application/json'); xhr.setRequestHeader('X-Pixel-Test', '1'); }
    xhr.onreadystatechange = function () {
      var parsed;
      if (xhr.readyState !== 4) { return; }
      if (run !== generation) { removeRequest(xhr); return; }
      parsed = parseResponse(xhr); finish(parsed.ok ? null : parsed.error, parsed.value || null);
    };
    xhr.ontimeout = function () { finish({ status: 0, message: 'Request timed out.' }, null); };
    xhr.onerror = function () { finish({ status: 0, message: 'Network request failed.' }, null); };
    try { xhr.send(method === 'POST' ? JSON.stringify(body || {}) : null); }
    catch (error) { finish({ status: 0, message: errorText(error) }, null); }
    return xhr;
  }
  function leaveToken(token) {
    var xhr;
    if (!token || isStaticLocation()) { return; }
    try {
      xhr = new XMLHttpRequest(); xhr.open('POST', '/api/leave', true); xhr.timeout = 5000;
      xhr.setRequestHeader('Content-Type', 'application/json'); xhr.setRequestHeader('X-Pixel-Test', '1');
      xhr.send(JSON.stringify({ token: token }));
    } catch (error) { addError('Leave session', error); }
  }
  function cleanup(sendLeave) {
    var oldToken = sessionToken, oldEngine = engine;
    generation += 1; sessionToken = ''; engine = null; cursor = 0; sendQueue = []; sending = false; pollFailures = 0; evidenceFrames = -1; evidenceVideoTime = -1;
    if (el('mode')) { el('mode').disabled = false; }
    if (pollTimer !== null) { window.clearTimeout(pollTimer); pollTimer = null; }
    abortRequests();
    if (oldEngine && typeof oldEngine.stop === 'function') { safe('Stop video engine', function () { oldEngine.stop(); }); }
    if (sendLeave) { leaveToken(oldToken); }
  }

  function metric(snapshot, name) { var value = snapshot ? snapshot[name] : null; return value !== null && typeof value !== 'undefined' && value !== '' && !(typeof value === 'number' && isNaN(value)) ? String(value) : 'UNKNOWN'; }
  function snapshotText(snapshot) {
    return 'state: ' + metric(snapshot, 'state') +
      '\nice: ' + metric(snapshot, 'ice') +
      '\ncodec: ' + metric(snapshot, 'codec') +
      '\ncodecSource: ' + metric(snapshot, 'codecSource') +
      '\nresolution: ' + metric(snapshot, 'width') + ' x ' + metric(snapshot, 'height') +
      '\nframesDecoded: ' + metric(snapshot, 'framesDecoded') +
      '\nfps: ' + metric(snapshot, 'fps') +
      '\nbytesReceived: ' + metric(snapshot, 'bytesReceived') +
      '\nbitrateKbps: ' + metric(snapshot, 'bitrateKbps') +
      '\nrttMs: ' + metric(snapshot, 'rttMs') +
      '\nelapsedSeconds: ' + metric(snapshot, 'elapsedSeconds') +
      '\nplayback: ' + metric(snapshot, 'playback') +
      '\ndetail: ' + metric(snapshot, 'detail');
  }
  function updateCompact(snapshot) {
    text('compactSummary', 'ROLE=' + role.toUpperCase() + ' | STATE=' + metric(snapshot, 'state') + ' | ICE=' + metric(snapshot, 'ice') + ' | CODEC=' + metric(snapshot, 'codec') + ' | PLAYBACK=' + metric(snapshot, 'playback'));
  }
  function updateEvidenceStatus(snapshot) {
    var frames, video = el('remoteVideo'), videoTime = video && typeof video.currentTime === 'number' ? video.currentTime : -1;
    var ice = metric(snapshot, 'ice').toLowerCase(), state = metric(snapshot, 'state').toLowerCase();
    var playback = metric(snapshot, 'playback').toLowerCase(), detail = metric(snapshot, 'detail').toLowerCase(), advancing = false;
    frames = Number(snapshot && snapshot.framesDecoded);
    if (!isNaN(frames) && frames > 0 && frames > evidenceFrames) { advancing = true; evidenceFrames = frames; }
    if (role === 'receiver' && videoTime > 0 && videoTime > evidenceVideoTime) { advancing = true; evidenceVideoTime = videoTime; }
    if (advancing || /playing|advancing/.test(playback)) { setStatus('Live video is playing. Confirm the changing frame timer visually.'); }
    else if (ice === 'failed' || state === 'failed') { setStatus('ICE connection failed. Restart the test and check local-network access.'); }
    else if (/stall|no decoded|not advancing/.test(playback + ' ' + detail)) { setStatus('Video stalled or no decoded frames are advancing. Restart if this persists.'); }
    else if (ice === 'connected' || ice === 'completed' || state === 'connected') { setStatus('Peer connected; waiting for decoded video frame evidence.'); }
  }
  function report(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') { addError('Engine report', 'Invalid snapshot'); return; }
    if (snapshot.remote) { latestRemote = snapshot.remote; text('remoteMetrics', snapshotText(latestRemote)); show('remoteMetricsPanel', true); updateCompact(latestRemote); if (role === 'sender') { updateEvidenceStatus(latestRemote); } }
    if (!snapshot.remote || typeof snapshot.state !== 'undefined' || typeof snapshot.ice !== 'undefined') { latestLocal = snapshot; text('metrics', snapshotText(latestLocal)); if (!snapshot.remote) { updateCompact(role === 'sender' && latestRemote ? latestRemote : latestLocal); if (role === 'receiver') { updateEvidenceStatus(latestLocal); } } }
  }
  function engineError(step, error) {
    if (typeof error === 'undefined') { error = step; step = 'runtime'; }
    addError('Video engine ' + String(step || 'runtime'), error); setStatus('Video engine error. Stop and restart the test.');
  }

  function drainSendQueue(run) {
    var item;
    if (run !== generation || sending || !sendQueue.length || !sessionToken) { return; }
    sending = true; item = sendQueue[0];
    request('POST', '/api/send', { token: sessionToken, type: item.type, data: item.data }, run, function (error) {
      sending = false; if (run !== generation) { return; }
      if (error) { addError('Send signaling event', error); cleanup(true); show('sharedStopPanel', false); setStatus('Signaling send failed. Restart the test.'); return; }
      sendQueue.shift(); drainSendQueue(run);
    });
  }
  function queueSend(type, data, run) {
    if (run !== generation || !sessionToken) { return; }
    sendQueue.push({ type: String(type), data: data }); drainSendQueue(run);
  }
  function startEngine(run) {
    var api, options, result;
    if (run !== generation || engine) { return !!engine; }
    api = window.PixelVideoRTC;
    if (!api || typeof api.start !== 'function') { addError('Video engine', 'video-rtc.js is missing or did not expose window.PixelVideoRTC.start'); setStatus('Video engine unavailable. Check that video-rtc.js loaded.'); return false; }
    options = {
      role: role,
      mode: role === 'sender' ? el('mode').value : null,
      canvas: el('patternCanvas'),
      video: el('remoteVideo'),
      send: function (type, data) { queueSend(type, data, run); },
      report: function (snapshot) { if (run === generation) { report(snapshot); } },
      error: function (step, error) { if (run === generation) { engineError(step, error); } }
    };
    result = safe('Start video engine', function () { return api.start(options); });
    if (!result.ok || !result.value || typeof result.value.stop !== 'function' || typeof result.value.receive !== 'function') { if (result.ok) { addError('Video engine', 'start() did not return stop() and receive()'); } setStatus('Video engine failed to start.'); return false; }
    engine = result.value; setStatus(role === 'sender' ? 'TV paired. Starting video negotiation.' : 'Joined. Waiting for the computer video offer.'); return true;
  }

  function schedulePoll(run) { if (run === generation) { pollTimer = window.setTimeout(function () { poll(run); }, 750); } }
  function processEvents(events) {
    var i, event;
    if (!events || typeof events.length !== 'number') { return; }
    for (i = 0; i < events.length; i += 1) {
      event = events[i] || {};
      if (engine && typeof engine.receive === 'function') { safe('Receive signaling event ' + String(event.type || 'UNKNOWN'), function () { engine.receive(event.type, event.data); }); }
      if (typeof event.id === 'number' && event.id > cursor) { cursor = event.id; }
    }
  }
  function poll(run) {
    if (run !== generation || !sessionToken) { return; }
    request('GET', '/api/poll?token=' + encodeURIComponent(sessionToken) + '&after=' + encodeURIComponent(String(cursor)), null, run, function (error, data) {
      if (run !== generation) { return; }
      if (error) {
        addError('Poll signaling', error);
        if (error.status === 401 || error.status === 404 || error.status === 410) { cleanup(false); show('sharedStopPanel', false); setStatus('The peer stopped or the session expired. Restart the test.'); return; }
        pollFailures += 1;
        if (pollFailures >= 3) { cleanup(true); show('sharedStopPanel', false); setStatus('Signaling failed repeatedly. Restart the test.'); return; }
        setStatus('Signaling poll failed; retry ' + String(pollFailures) + ' of 3.'); schedulePoll(run); return;
      }
      pollFailures = 0;
      if (role === 'sender' && data.peerPresent && !engine) { startEngine(run); }
      processEvents(data.events);
      if (role === 'sender' && !data.peerPresent && !engine) { setStatus('Pairing code ready. Waiting for the TV to join.'); }
      schedulePoll(run);
    });
  }

  function resetDisplay() {
    latestLocal = null; latestRemote = null; text('metrics', 'No engine report yet.'); text('remoteMetrics', 'No receiver report yet.'); show('remoteMetricsPanel', false);
    text('compactSummary', 'ROLE=' + role.toUpperCase() + ' | STATE=? | ICE=? | CODEC=? | PLAYBACK=?');
  }
  function createTest() {
    var run, button = el('createButton');
    cleanup(true); run = generation; resetDisplay(); button.disabled = true; show('pairingPanel', false); show('sharedStopPanel', false); setStatus('Creating a local test session...');
    request('POST', '/api/session', {}, run, function (error, data) {
      button.disabled = false; if (error) { el('mode').disabled = false; addError('Create session', error); setStatus('Could not create the test. Fix the server error, then select CREATE TEST again.'); return; }
      if (!data || !/^\d{8}$/.test(String(data.code || '')) || !data.senderToken) { addError('Create session', 'Server response did not include a valid code and sender token'); setStatus('Invalid server response. Restart the local test server.'); return; }
      sessionToken = String(data.senderToken); el('mode').disabled = true; text('pairCode', data.code); text('receiverUrls', data.receiverUrls && data.receiverUrls.length ? data.receiverUrls.join('\n') : 'No LAN TV address was returned.');
      show('pairingPanel', true); show('sharedStopPanel', true); setStatus('Pairing code ready. Waiting for the TV to join. Expires: ' + String(data.expiresAt || 'UNKNOWN')); poll(run);
    });
  }
  function joinTest() {
    var code = String(el('roomCode').value || '').replace(/\D/g, '').slice(0, 8), run, button = el('joinButton');
    el('roomCode').value = code; if (!/^\d{8}$/.test(code)) { setStatus('Enter the complete 8-digit pairing code.'); el('roomCode').focus(); return; }
    cleanup(true); run = generation; resetDisplay(); button.disabled = true; show('sharedStopPanel', false); setStatus('Joining the local test session...');
    request('POST', '/api/join', { code: code }, run, function (error, data) {
      button.disabled = false; if (error) { addError('Join session', error); setStatus('Could not join the test. Check the code or create a new test on the computer.'); return; }
      if (!data || !data.token) { addError('Join session', 'Server response did not include a receiver token'); setStatus('Invalid server response. Restart the local test server.'); return; }
      sessionToken = String(data.token); if (!startEngine(run)) { leaveToken(sessionToken); sessionToken = ''; return; }
      show('sharedStopPanel', true); poll(run);
    });
  }
  function stopTest() { cleanup(true); show('sharedStopPanel', false); setStatus('Test stopped.'); resetDisplay(); }

  function playVideo() {
    var video = el('remoteVideo'), result;
    try { result = video.play(); }
    catch (error) { addError('Play video', error); setStatus('Playback was rejected. Select PLAY VIDEO again after interacting with the page.'); return; }
    if (result && typeof result.then === 'function') { result.then(function () { setStatus('Video playback requested successfully.'); }, function (error) { addError('Play video', error); setStatus('Playback was rejected. Select PLAY VIDEO again after interacting with the page.'); }); }
    else { setStatus('Video playback requested.'); }
  }
  function fullscreenVideo() {
    var video = el('remoteVideo'), method = video.requestFullscreen || video.webkitRequestFullscreen || video.webkitRequestFullScreen || video.mozRequestFullScreen || video.msRequestFullscreen, result;
    if (!method) { setStatus('Fullscreen is unavailable in this browser.'); return; }
    try {
      result = method.call(video);
      if (result && typeof result.then === 'function') { result.then(function () {}, function (error) { addError('Fullscreen', error); setStatus('Fullscreen request was rejected.'); }); }
    } catch (error) { addError('Fullscreen', error); setStatus('Fullscreen request failed.'); }
  }
  function bind() {
    el('createButton').onclick = createTest; el('joinButton').onclick = joinTest; el('stopButton').onclick = stopTest; el('playButton').onclick = playVideo; el('fullscreenButton').onclick = fullscreenVideo;
    el('roomCode').oninput = function () { this.value = String(this.value || '').replace(/\D/g, '').slice(0, 8); };
    el('roomCode').onkeydown = function (event) { event = event || window.event; if (event.keyCode === 13) { joinTest(); } };
  }
  function init() {
    var hostname = String(window.location.hostname || '').toLowerCase(), forcedRole = queryValue('role');
    bind();
    if (isStaticLocation()) { role = 'static'; show('staticPanel', true); show('senderPanel', false); show('receiverPanel', false); show('sharedStopPanel', false); text('compactSummary', 'ROLE=STATIC | STATE=LOCAL_SERVER_REQUIRED | ICE=? | CODEC=? | PLAYBACK=?'); setStatus('Run Start-Video-Test.cmd on your computer; TV uses local address shown there.'); text('jsStatus', 'PASS - JavaScript executed. Static guidance shown; no API request was made.'); return; }
    role = forcedRole === 'receiver' ? 'receiver' : (isLoopback(hostname) ? 'sender' : 'receiver');
    show('senderPanel', role === 'sender'); show('receiverPanel', role === 'receiver'); show('staticPanel', false); resetDisplay();
    setStatus(role === 'sender' ? 'Select codec mode, then CREATE TEST.' : 'Enter the computer pairing code, then JOIN TEST.');
    text('jsStatus', 'PASS - JavaScript executed. Role selected: ' + role.toUpperCase() + '.');
    if (!window.PixelVideoRTC || typeof window.PixelVideoRTC.start !== 'function') { addError('Video engine', 'video-rtc.js is missing or did not load'); setStatus('Video engine unavailable. Check that video-rtc.js loaded.'); }
    if (window.addEventListener) { window.addEventListener('beforeunload', function () { cleanup(true); }); }
  }
  init();
}());
