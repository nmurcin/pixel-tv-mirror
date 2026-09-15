(function () {
  'use strict';
  var doc = document, errors = [], statuses = {}, currentCancel = null;
  var stepNames = ['constructor', 'offer', 'answer', 'ice', 'peer', 'dc', 'message'];
  var compact = { JS: 'UNKNOWN', WS: 'UNKNOWN', RTC: 'UNKNOWN', RTC_SELF: 'UNKNOWN', DC: 'UNKNOWN', MSE: 'UNKNOWN', H264_MP4: 'UNKNOWN', H264_MSE: 'UNKNOWN', FULLSCREEN: 'UNKNOWN', UA: 'UNKNOWN' };
  function el(id) { return doc.getElementById(id); }
  function text(id, value) { var node = el(id); if (node) { node.textContent = String(value); } }
  function errorText(error) { return error && (error.name || error.message) ? (error.name ? String(error.name) + ': ' : '') + (error.message ? String(error.message) : '') : String(error); }
  function addError(value) { errors.push(String(value)); text('errorLog', errors.join('\n')); }
  window.onerror = function (message, source, line) { addError('ERROR: ' + String(message) + ' (' + String(source || 'inline') + ':' + String(line || 0) + ')'); };
  if (window.addEventListener) { window.addEventListener('unhandledrejection', function (event) { addError('UNHANDLED REJECTION: ' + errorText(event && event.reason)); }); }
  function safe(name, operation) { try { return { ok: true, value: operation() }; } catch (error) { addError(name + ': ' + errorText(error)); return { ok: false, value: null }; } }
  function availability(name, operation) { var result = safe(name, operation); return result.ok ? (result.value ? 'AVAILABLE' : 'UNAVAILABLE') : 'UNKNOWN'; }
  function compactValue(value) { if (value === 'PASS' || value === 'AVAILABLE') { return '1'; } if (value === 'FAIL' || value === 'UNAVAILABLE') { return '0'; } if (value === 'UNKNOWN') { return '?'; } return String(value); }
  function compactText() { return 'JS=' + compactValue(compact.JS) + ' | WS=' + compactValue(compact.WS) + ' | RTC=' + compactValue(compact.RTC) + ' | RTC_SELF=' + compactValue(compact.RTC_SELF) + ' | DC=' + compactValue(compact.DC) + ' | MSE=' + compactValue(compact.MSE) + ' | H264_MP4=' + compactValue(compact.H264_MP4) + ' | H264_MSE=' + compactValue(compact.H264_MSE) + ' | FULLSCREEN=' + compactValue(compact.FULLSCREEN) + ' | UA=' + compactValue(compact.UA); }
  function setCompact(key, value) { compact[key] = value; text('compactResult', compactText()); }
  function appendProbe(lines, name, operation) { lines.push(name + ': ' + availability(name, operation)); }
  function storageProbe(globalName) {
    var access = safe(globalName + ' getter', function () { return window[globalName]; });
    var storage, key = '__pixel_mirror_probe__', oldValue = null, hadValue = false, snapshot = false, passed = false, failure = null;
    if (!access.ok) { return 'UNKNOWN (getter threw; see error log)'; }
    storage = access.value; if (!storage) { return 'UNAVAILABLE'; }
    try { oldValue = storage.getItem(key); hadValue = oldValue !== null; snapshot = true; storage.setItem(key, 'pixel-mirror-ok'); passed = storage.getItem(key) === 'pixel-mirror-ok'; }
    catch (error) { failure = error; addError(globalName + ' read/write: ' + errorText(error)); }
    finally { if (snapshot) { try { if (hadValue) { storage.setItem(key, oldValue); } else { storage.removeItem(key); } } catch (restoreError) { passed = false; failure = restoreError; addError(globalName + ' restore: ' + errorText(restoreError)); } } }
    if (failure) { return 'UNKNOWN (' + errorText(failure) + ')'; }
    return passed ? 'PASS' : 'FAIL';
  }
  function canPlay(video, mime) {
    var result = safe('canPlayType ' + mime, function () { return video.canPlayType(mime); }), value;
    if (!result.ok) { return 'UNKNOWN'; }
    value = result.value === null || typeof result.value === 'undefined' ? '' : String(result.value);
    if (value === '') { return 'empty (unsupported)'; }
    return value;
  }
  function mseType(mediaSource, mime) {
    var result;
    if (!mediaSource) { return compact.MSE === 'UNKNOWN' ? 'UNKNOWN' : 'UNAVAILABLE'; }
    result = safe('MediaSource.isTypeSupported getter', function () { return mediaSource.isTypeSupported; });
    if (!result.ok || typeof result.value !== 'function') { return 'UNKNOWN'; }
    result = safe('MediaSource.isTypeSupported ' + mime, function () { return mediaSource.isTypeSupported(mime); });
    return result.ok ? (result.value ? 'true' : 'false') : 'UNKNOWN';
  }
  function initSteps() {
    var container = el('rtcSteps'), i, row, label, state, detail;
    while (container.firstChild) { container.removeChild(container.firstChild); }
    for (i = 0; i < stepNames.length; i += 1) {
      statuses[stepNames[i]] = 'UNKNOWN'; row = doc.createElement('div'); row.className = 'step'; row.id = 'step-' + stepNames[i];
      label = doc.createElement('b'); label.textContent = stepNames[i].toUpperCase(); state = doc.createElement('span'); state.className = 'status-UNKNOWN'; state.textContent = 'UNKNOWN'; detail = doc.createElement('span'); detail.className = 'detail'; detail.textContent = ' Not run.';
      row.appendChild(label); row.appendChild(state); row.appendChild(detail); container.appendChild(row);
    }
  }
  function report(step, status, detailValue) {
    var target = el('step-' + step), safeStatus, parts;
    if (!statuses.hasOwnProperty(step)) { addError('RTC report: unknown step ' + String(step)); return; }
    safeStatus = status === 'PASS' || status === 'FAIL' ? status : 'UNKNOWN'; statuses[step] = safeStatus;
    if (target) { parts = target.getElementsByTagName('span'); if (parts[0]) { parts[0].className = 'status-' + safeStatus; parts[0].textContent = safeStatus; } if (parts[1]) { parts[1].textContent = detailValue ? ' ' + String(detailValue) : ''; } }
    if (safeStatus === 'FAIL') { addError('RTC ' + step + ': ' + String(detailValue || 'failed without detail')); }
    if (step === 'dc') { setCompact('DC', safeStatus); }
    if (step === 'message') { setCompact('RTC_SELF', safeStatus); }
  }
  function recommendation() {
    if (compact.RTC_SELF === 'PASS') { text('recommendation', 'LIKELY BEST TRANSPORT: WebRTC (promising; video untested)'); }
    else if ((compact.RTC_SELF === 'FAIL' || compact.RTC === 'UNAVAILABLE') && compact.MSE === 'AVAILABLE' && compact.H264_MSE === 'PASS') { text('recommendation', 'LIKELY BEST TRANSPORT: MSE + H.264 (promising; playback untested)'); }
    else if (compact.RTC === 'UNAVAILABLE' && compact.MSE === 'UNAVAILABLE') { text('recommendation', 'LIKELY BEST TRANSPORT: Basic HTTP/MJPEG (investigate fallback)'); }
    else { text('recommendation', 'LIKELY BEST TRANSPORT: Further testing required'); }
  }
  function initApis() {
    var lines = [], pc = [], ms = [], fs = [], names, i;
    appendProbe(lines, 'WebSocket', function () { return window.WebSocket; });
    names = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection', 'RTCSessionDescription', 'webkitRTCSessionDescription', 'mozRTCSessionDescription', 'RTCIceCandidate', 'webkitRTCIceCandidate', 'mozRTCIceCandidate', 'RTCRtpReceiver'];
    for (i = 0; i < names.length; i += 1) { (function (name) { var state = availability(name, function () { return window[name]; }); lines.push(name + ': ' + state); if (i < 3) { pc.push(state); } }(names[i])); }
    names = ['MediaSource', 'WebKitMediaSource'];
    for (i = 0; i < names.length; i += 1) { (function (name) { var state = availability(name, function () { return window[name]; }); lines.push(name + ': ' + state); ms.push(state); }(names[i])); }
    appendProbe(lines, 'SourceBuffer', function () { return window.SourceBuffer; }); appendProbe(lines, 'HTMLVideoElement', function () { return window.HTMLVideoElement; }); appendProbe(lines, 'HTMLMediaElement', function () { return window.HTMLMediaElement; });
    names = ['fullscreenEnabled', 'webkitFullscreenEnabled', 'mozFullScreenEnabled', 'msFullscreenEnabled'];
    for (i = 0; i < names.length; i += 1) { (function (name) { var state = availability('document.' + name, function () { return doc[name]; }); lines.push('document.' + name + ': ' + state); fs.push(state); }(names[i])); }
    names = ['requestFullscreen', 'webkitRequestFullscreen', 'webkitRequestFullScreen', 'mozRequestFullScreen', 'msRequestFullscreen'];
    for (i = 0; i < names.length; i += 1) { (function (name) { var state = availability('element.' + name, function () { return doc.documentElement[name]; }); lines.push('element.' + name + ': ' + state); fs.push(state); }(names[i])); }
    appendProbe(lines, 'fetch', function () { return window.fetch; }); appendProbe(lines, 'XMLHttpRequest', function () { return window.XMLHttpRequest; }); appendProbe(lines, 'Promise', function () { return window.Promise; }); appendProbe(lines, 'WebAssembly', function () { return window.WebAssembly; });
    lines.push('localStorage read/write: ' + storageProbe('localStorage')); lines.push('sessionStorage read/write: ' + storageProbe('sessionStorage'));
    appendProbe(lines, 'URL', function () { return window.URL; }); appendProbe(lines, 'Blob', function () { return window.Blob; }); appendProbe(lines, 'ArrayBuffer', function () { return window.ArrayBuffer; }); appendProbe(lines, 'Uint8Array', function () { return window.Uint8Array; }); text('apiProbes', lines.join('\n'));
    setCompact('WS', availability('WebSocket compact', function () { return window.WebSocket; }));
    setCompact('RTC', pc.indexOf('AVAILABLE') >= 0 ? 'AVAILABLE' : (pc.indexOf('UNKNOWN') >= 0 ? 'UNKNOWN' : 'UNAVAILABLE'));
    setCompact('MSE', ms.indexOf('AVAILABLE') >= 0 ? 'AVAILABLE' : (ms.indexOf('UNKNOWN') >= 0 ? 'UNKNOWN' : 'UNAVAILABLE'));
    setCompact('FULLSCREEN', fs.indexOf('AVAILABLE') >= 0 ? 'AVAILABLE' : (fs.indexOf('UNKNOWN') >= 0 ? 'UNKNOWN' : 'UNAVAILABLE'));
    var standard = safe('MediaSource getter', function () { return window.MediaSource; }); if (standard.ok && standard.value) { return standard.value; }
    var webkit = safe('WebKitMediaSource getter', function () { return window.WebKitMediaSource; }); return webkit.ok ? webkit.value : null;
  }
  function initMedia(mediaSource) {
    var made = safe('video element', function () { return doc.createElement('video'); }), video = made.ok ? made.value : null, lines = [], h264Play = [], h264Mse = [], i, value, any = false, unknown = false;
    var videoTypes = ['video/mp4', 'video/mp4; codecs="avc1.42E01E"', 'video/mp4; codecs="avc1.4D401F"', 'video/mp4; codecs="avc1.640028"', 'video/webm; codecs="vp8"', 'video/webm; codecs="vp9"', 'video/webm; codecs="av01.0.05M.08"', 'video/mp4; codecs="av01.0.05M.08"'];
    var mseTypes = ['video/mp4; codecs="avc1.42E01E"', 'video/mp4; codecs="avc1.4D401F"', 'video/mp4; codecs="avc1.640028"', 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"', 'video/mp4; codecs="avc1.4D401F, mp4a.40.2"', 'video/mp4; codecs="avc1.640028, mp4a.40.2"', 'video/webm; codecs="vp8, vorbis"', 'video/webm; codecs="vp9, opus"', 'video/webm; codecs="av01.0.05M.08, opus"', 'video/mp4; codecs="av01.0.05M.08, mp4a.40.2"'];
    lines.push('canPlayType raw advertised results:');
    if (!video) { lines.push('video element: UNKNOWN'); } else { for (i = 0; i < videoTypes.length; i += 1) { value = canPlay(video, videoTypes[i]); lines.push(videoTypes[i] + ': ' + value); if (i >= 1 && i <= 3) { h264Play.push(value); } } }
    lines.push('', 'MediaSource.isTypeSupported exact results:');
    for (i = 0; i < mseTypes.length; i += 1) { value = mseType(mediaSource, mseTypes[i]); lines.push(mseTypes[i] + ': ' + value); if (i <= 2) { h264Mse.push(value); } }
    text('mediaProbes', lines.join('\n'));
    if (!video) { setCompact('H264_MP4', 'UNKNOWN'); } else { for (i = 0; i < h264Play.length; i += 1) { if (h264Play[i] === 'probably' || h264Play[i] === 'maybe') { any = true; } if (h264Play[i] === 'UNKNOWN') { unknown = true; } } setCompact('H264_MP4', any ? 'PASS' : (unknown ? 'UNKNOWN' : 'FAIL')); }
    any = false; unknown = false; for (i = 0; i < h264Mse.length; i += 1) { if (h264Mse[i] === 'true') { any = true; } if (h264Mse[i] === 'UNKNOWN') { unknown = true; } }
    setCompact('H264_MSE', any ? 'PASS' : (unknown || compact.MSE === 'UNKNOWN' ? 'UNKNOWN' : (compact.MSE === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'FAIL')));
  }
  function initRtcCapabilities() {
    var receiver = safe('RTCRtpReceiver getter', function () { return window.RTCRtpReceiver; }), method, caps, list = [], i;
    if (!receiver.ok) { text('rtcCapabilities', 'Advertised video codecs: UNKNOWN\n\nWebRTC H.264 receive capability: UNKNOWN (unverified; no remote media test).'); return; }
    if (!receiver.value) { text('rtcCapabilities', 'Advertised video codecs: UNAVAILABLE\n\nWebRTC H.264 receive capability: UNKNOWN (unverified; no remote media test).'); return; }
    method = safe('RTCRtpReceiver.getCapabilities getter', function () { return receiver.value.getCapabilities; });
    if (!method.ok || typeof method.value !== 'function') { text('rtcCapabilities', 'Advertised video codecs: UNKNOWN (getCapabilities not exposed)\n\nWebRTC H.264 receive capability: UNKNOWN (unverified; no remote media test).'); return; }
    caps = safe('RTCRtpReceiver.getCapabilities(video)', function () { return receiver.value.getCapabilities('video'); });
    if (!caps.ok) { text('rtcCapabilities', 'Advertised video codecs: UNKNOWN\n\nWebRTC H.264 receive capability: UNKNOWN (unverified; no remote media test).'); return; }
    if (caps.value && caps.value.codecs) { for (i = 0; i < caps.value.codecs.length; i += 1) { list.push((caps.value.codecs[i].mimeType || 'unknown') + (caps.value.codecs[i].sdpFmtpLine ? ' (' + caps.value.codecs[i].sdpFmtpLine + ')' : '')); } }
    text('rtcCapabilities', 'Advertised video codecs only:\n' + (list.length ? list.join('\n') : 'No codecs returned.') + '\n\nWebRTC H.264 receive capability: UNKNOWN (unverified; no remote media test).');
  }
  function init() {
    var navResult = safe('navigator getter', function () { return window.navigator; }), nav = navResult.ok && navResult.value ? navResult.value : {}, uaResult = safe('navigator.userAgent getter', function () { return nav.userAgent; }), ua = uaResult.ok ? String(uaResult.value || '') : 'UNKNOWN', token = [], match, apiResult;
    function field(name, operation) { var result = safe(name, operation); return result.ok && result.value !== null && typeof result.value !== 'undefined' ? String(result.value) : 'UNKNOWN'; }
    setCompact('JS', 'PASS'); text('jsStatus', 'PASS - JavaScript executed. Capability probes are running.'); setCompact('UA', ua);
    match = /Tizen[ \/]([\d.]+)/i.exec(ua); if (match) { token.push('Tizen ' + match[1]); } match = /Chrom(?:e|ium)\/([\d.]+)/i.exec(ua); if (match) { token.push('Chromium ' + match[1]); }
    text('environment', 'userAgent: ' + ua + '\nappVersion: ' + field('navigator.appVersion', function () { return nav.appVersion; }) + '\nplatform: ' + field('navigator.platform', function () { return nav.platform; }) + '\nvendor: ' + field('navigator.vendor', function () { return nav.vendor; }) + '\nexplicit tokens: ' + (token.length ? token.join('; ') : 'none') + '\nscreen: ' + field('screen dimensions', function () { return window.screen ? window.screen.width + ' x ' + window.screen.height : 'UNKNOWN'; }) + '\ninner: ' + field('inner dimensions', function () { return window.innerWidth + ' x ' + window.innerHeight; }) + '\nDPR: ' + field('devicePixelRatio', function () { return window.devicePixelRatio; }) + '\nprotocol: ' + field('location.protocol', function () { return location.protocol; }) + '\nhostname: ' + field('location.hostname', function () { return location.hostname; }));
    apiResult = safe('API probe section', initApis);
    safe('media probe section', function () { initMedia(apiResult.ok ? apiResult.value : null); });
    safe('RTC capability section', initRtcCapabilities);
    recommendation(); text('jsStatus', 'PASS - JavaScript executed. Capability probes finished; see UNKNOWN values and the error log for blocked checks.');
  }
  function run() {
    var button = el('runButton'), result;
    if (currentCancel) { safe('cancel previous RTC self-test', currentCancel); currentCancel = null; }
    setCompact('RTC_SELF', 'UNKNOWN'); setCompact('DC', 'UNKNOWN'); initSteps(); recommendation(); button.disabled = true; text('runState', 'Running local WebRTC self-test...');
    if (!window.TVRTC || typeof window.TVRTC.run !== 'function') { report('constructor', 'UNKNOWN', 'tv-rtc.js is unavailable.'); text('runState', 'Self-test worker unavailable.'); button.disabled = false; recommendation(); return; }
    result = safe('TVRTC.run', function () { return window.TVRTC.run(report, function (success) { currentCancel = null; if (!success) { setCompact('RTC_SELF', 'FAIL'); } button.disabled = false; text('runState', success ? 'Self-test passed.' : 'Self-test failed.'); recommendation(); }); });
    if (result.ok && typeof result.value === 'function') { currentCancel = result.value; } else { if (result.ok) { addError('TVRTC.run: did not return a cancel function'); } setCompact('RTC_SELF', result.ok ? 'UNKNOWN' : 'FAIL'); button.disabled = false; recommendation(); }
  }
  function rtcStepsText() {
    var lines = [], i, row, parts;
    for (i = 0; i < stepNames.length; i += 1) {
      row = el('step-' + stepNames[i]); parts = row ? row.getElementsByTagName('span') : [];
      lines.push(stepNames[i].toUpperCase() + '=' + (parts[0] ? parts[0].textContent : 'UNKNOWN') + (parts[1] ? ' ' + parts[1].textContent.replace(/^\s+/, '') : ''));
    }
    return lines.join('\n');
  }
  function copy() {
    var value = el('compactResult').textContent + '\n\n' + rtcStepsText() + '\n\n' + el('environment').textContent + '\n\n' + el('apiProbes').textContent + '\n\n' + el('mediaProbes').textContent + '\n\n' + el('rtcCapabilities').textContent + '\n\n' + el('errorLog').textContent, area, ok = false, access;
    function fallback() { area = doc.createElement('textarea'); area.value = value; doc.body.appendChild(area); area.select(); try { ok = !!(doc.execCommand && doc.execCommand('copy')); } catch (error) { addError('clipboard fallback: ' + errorText(error)); } doc.body.removeChild(area); text('runState', ok ? 'Results copied to clipboard.' : 'Could not copy results. The full report remains visible.'); }
    access = safe('clipboard access', function () { return navigator.clipboard; });
    if (access.ok && access.value && typeof access.value.writeText === 'function') { try { access.value.writeText(value).then(function () { text('runState', 'Results copied to clipboard.'); }, function (error) { addError('clipboard write: ' + errorText(error)); fallback(); }); } catch (error) { addError('clipboard write: ' + errorText(error)); fallback(); } } else { fallback(); }
  }
  initSteps(); safe('initialization', init); el('runButton').onclick = run; el('copyButton').onclick = copy;
}());
