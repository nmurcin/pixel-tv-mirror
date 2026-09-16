"use strict";

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var vm = require("vm");
var source = fs.readFileSync(path.join(__dirname, "..", "video-rtc.js"), "utf8");

function load(extra) {
  var nextTimer = 1;
  var intervals = {};
  var timeouts = {};
  var windowObject = {
    setInterval: function (fn) { var id = nextTimer; nextTimer += 1; intervals[id] = fn; return id; },
    clearInterval: function (id) { delete intervals[id]; },
    setTimeout: function (fn) { var id = nextTimer; nextTimer += 1; timeouts[id] = fn; return id; },
    clearTimeout: function (id) { delete timeouts[id]; }
  };
  Object.keys(extra || {}).forEach(function (key) { windowObject[key] = extra[key]; });
  vm.runInNewContext(source, { window: windowObject, Error: Error, Date: extra && extra.Date ? extra.Date : Date, Math: Math,
    Number: Number, String: String, Object: Object, isFinite: isFinite }, { filename: "video-rtc.js" });
  return { window: windowObject, intervals: intervals, timeouts: timeouts };
}

var sampleSdp = [
  "v=0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=rtpmap:111 opus/48000/2",
  "m=video 9 UDP/TLS/RTP/SAVPF 96 97 102 121 127 116",
  "a=mid:video",
  "a=extmap:2 urn:test",
  "a=rtpmap:96 VP8/90000",
  "a=rtcp-fb:96 nack",
  "a=rtpmap:97 rtx/90000",
  "a=fmtp:97 apt=96",
  "a=rtpmap:102 H264/90000",
  "a=fmtp:102 packetization-mode=1;profile-level-id=42e01f",
  "a=rtcp-fb:102 nack pli",
  "a=rtpmap:121 rtx/90000",
  "a=fmtp:121 apt=102",
  "a=rtpmap:127 H264/90000",
  "a=fmtp:127 packetization-mode=0;profile-level-id=42e01f",
  "a=rtpmap:116 red/90000",
  "a=rtcp-fb:* transport-cc",
  "a=ssrc:1 cname:test",
  ""
].join("\r\n");

(function filterKeepsH264AndMatchingRtx() {
  var api = load().window.PixelVideoRTC;
  var filtered = api.filterH264Sdp(sampleSdp);
  assert.match(filtered, /m=audio 9 UDP\/TLS\/RTP\/SAVPF 111/);
  assert.match(filtered, /m=video 9 UDP\/TLS\/RTP\/SAVPF 102 121 127/);
  assert.match(filtered, /a=rtpmap:102 H264\/90000/);
  assert.match(filtered, /a=fmtp:121 apt=102/);
  assert.match(filtered, /a=rtcp-fb:102 nack pli/);
  assert.match(filtered, /a=rtcp-fb:\* transport-cc/);
  assert.match(filtered, /a=extmap:2 urn:test/);
  assert.doesNotMatch(filtered, /a=rtpmap:96 VP8/);
  assert.doesNotMatch(filtered, /a=fmtp:97 apt=96/);
  assert.doesNotMatch(filtered, /a=rtpmap:116 red/);
  assert.strictEqual(api.negotiatedCodec(filtered), "H264");
  assert.throws(function () {
    api.filterH264Sdp(sampleSdp.replace(/H264/g, "VP9"));
  }, /no H\.264/);
}());

function legacyStat(values) {
  return {
    id: "inbound",
    type: "ssrc",
    timestamp: 1,
    names: function () { return Object.keys(values); },
    stat: function (name) { return values[name]; }
  };
}

(function receiverQueuesIceAndReportsLegacyFrames() {
  var instances = [];
  function Peer() {
    this.connectionState = "connected";
    this.iceConnectionState = "connected";
    this.signalingState = "stable";
    this.added = [];
    instances.push(this);
  }
  Peer.prototype.setRemoteDescription = function (value, ok) { this.remoteDescription = value; ok(); };
  Peer.prototype.createAnswer = function (ok, bad) {
    ok({ type: "answer", sdp: sampleSdp.replace("96 97 102 121 127 116", "102") });
  };
  Peer.prototype.setLocalDescription = function (value, ok) { this.localDescription = value; ok(); };
  Peer.prototype.addIceCandidate = function (value, ok) { this.added.push(value); ok(); };
  Peer.prototype.getStats = function (ok) {
    ok({ result: function () { return [legacyStat({ mediaType: "video", bytesReceived: "4096",
      framesDecoded: "4", googCodecName: "H264", googFrameWidthReceived: "1280",
      googFrameHeightReceived: "720", googFrameRateDecoded: "30" })]; } });
  };
  Peer.prototype.close = function () { this.closed = true; };
  var env = load({ RTCPeerConnection: Peer, RTCSessionDescription: function (v) { return v; },
    RTCIceCandidate: function (v) { return v; } });
  var sent = [];
  var reports = [];
  var video = { muted: false, autoplay: false, playsInline: false, currentTime: 0,
    videoWidth: 1280, videoHeight: 720, play: function () {}, pause: function () {},
    removeAttribute: function () {}, srcObject: null };
  var session = env.window.PixelVideoRTC.start({ role: "receiver", video: video,
    send: function (type, data) { sent.push({ type: type, data: data }); },
    report: function (value) { reports.push(value); }, error: function (step, error) {
      throw new Error(step + ": " + error.message);
    } });
  session.receive("candidate", { candidate: "candidate:1" });
  assert.strictEqual(instances[0].added.length, 0);
  session.receive("offer", { type: "offer", sdp: sampleSdp });
  assert.strictEqual(instances[0].added.length, 1);
  assert.strictEqual(sent[0].type, "answer");
  instances[0].onaddstream({ stream: { id: "remote" } });
  Object.keys(env.intervals).forEach(function (id) { env.intervals[id](); });
  assert.strictEqual(reports[reports.length - 1].codec, "H264");
  assert.strictEqual(reports[reports.length - 1].codecSource, "RTP stats");
  assert.strictEqual(reports[reports.length - 1].framesDecoded, 4);
  assert.strictEqual(reports[reports.length - 1].width, 1280);
  session.stop();
  assert.strictEqual(instances[0].closed, true);
}());

(function senderFiltersOfferAndStopsTrack() {
  var stopped = false;
  function resolved(value) { return { then: function (ok) { ok(value); } }; }
  function Peer() { this.connectionState = "new"; this.iceConnectionState = "new"; }
  Peer.prototype.addTrack = function () {};
  Peer.prototype.createOffer = function () { return resolved({ type: "offer", sdp: sampleSdp }); };
  Peer.prototype.setLocalDescription = function (value) { this.localDescription = value; return resolved(); };
  Peer.prototype.getStats = function () { return resolved({ forEach: function () {} }); };
  Peer.prototype.close = function () { this.closed = true; };
  var context = { fillStyle: "", font: "", fillRect: function () {}, fillText: function () {} };
  var stream = { getVideoTracks: function () { return [{ stop: function () { stopped = true; } }]; },
    getTracks: function () { return this.getVideoTracks(); } };
  var canvas = { width: 0, height: 0, getContext: function () { return context; },
    captureStream: function (fps) { assert.strictEqual(fps, 30); return stream; } };
  var env = load({ RTCPeerConnection: Peer });
  var sent = [];
  var session = env.window.PixelVideoRTC.start({ role: "sender", mode: "h264", canvas: canvas,
    send: function (type, data) { sent.push({ type: type, data: data }); },
    report: function () {}, error: function (step, error) { throw new Error(step + ": " + error.message); } });
  assert.strictEqual(sent[0].type, "offer");
  assert.match(sent[0].data.sdp, /m=video 9 UDP\/TLS\/RTP\/SAVPF 102 121 127/);
  assert.doesNotMatch(sent[0].data.sdp, /a=rtpmap:96 VP8/);
  session.stop();
  assert.strictEqual(stopped, true);
}());

(function missingStatsUsesExplicitClockFallbackAndTelemetry() {
  var clock = 1000;
  function FakeDate() { this.getTime = function () { return clock; }; }
  function Peer() { this.connectionState = "connected"; this.iceConnectionState = "connected"; }
  Peer.prototype.close = function () {};
  var env = load({ RTCPeerConnection: Peer, Date: FakeDate });
  var reports = [];
  var sent = [];
  var video = { muted: true, autoplay: true, playsInline: true, currentTime: 1,
    videoWidth: 640, videoHeight: 360, play: function () {}, pause: function () {},
    removeAttribute: function () {}, srcObject: null };
  var session = env.window.PixelVideoRTC.start({ role: "receiver", video: video,
    send: function (type, data) { sent.push({ type: type, data: data }); },
    report: function (value) { reports.push(value); }, error: function () {} });
  env.window.setInterval;
  session.receive("candidate", { candidate: "queued" });
  var peer = null;
  Object.keys(env.intervals).forEach(function (id) {
    clock += 1000;
    video.currentTime += 1;
    env.intervals[id]();
  });
  Object.keys(env.intervals).forEach(function (id) {
    clock += 1000;
    video.currentTime += 1;
    env.intervals[id]();
  });
  assert.strictEqual(reports[reports.length - 1].framesDecoded, "?");
  assert.strictEqual(reports[reports.length - 1].bytesReceived, "?");
  assert.strictEqual(reports[reports.length - 1].playback, "clock advancing (frame counter unavailable)");
  clock += 6000;
  Object.keys(env.intervals).forEach(function (id) { env.intervals[id](); });
  assert.strictEqual(reports[reports.length - 1].playback, "clock stalled (frame counter unavailable)");
  assert.match(reports[reports.length - 1].detail, /has not advanced for 5 seconds/);
  clock += 1000;
  video.currentTime += 1;
  Object.keys(env.intervals).forEach(function (id) { env.intervals[id](); });
  assert.strictEqual(reports[reports.length - 1].playback, "clock advancing (frame counter unavailable)");
  assert.match(reports[reports.length - 1].detail, /playback clock advance/);
  assert.ok(sent.some(function (item) { return item.type === "report"; }));
  session.stop();
  void peer;
}());

(function decodedCounterReportsStallAndRecovery() {
  var clock = 1000;
  var frames = 1;
  function FakeDate() { this.getTime = function () { return clock; }; }
  function Peer() { this.connectionState = "connected"; this.iceConnectionState = "connected"; }
  Peer.prototype.close = function () {};
  Peer.prototype.getStats = function () {
    return { then: function (ok) { ok({ forEach: function (visit) {
      visit({ id: "v", type: "inbound-rtp", kind: "video", framesDecoded: frames,
        bytesReceived: frames * 1000, frameWidth: 1280, frameHeight: 720 });
    } }); } };
  };
  var env = load({ RTCPeerConnection: Peer, Date: FakeDate });
  var reports = [];
  var video = { muted: true, autoplay: true, playsInline: true, currentTime: 0,
    videoWidth: 1280, videoHeight: 720, play: function () {}, pause: function () {},
    removeAttribute: function () {}, srcObject: null };
  var session = env.window.PixelVideoRTC.start({ role: "receiver", video: video,
    send: function () {}, report: function (value) { reports.push(value); }, error: function () {} });
  var interval = env.intervals[Object.keys(env.intervals)[0]];
  interval();
  clock += 1000; frames = 2; interval();
  assert.strictEqual(reports[reports.length - 1].playback, "frames advancing");
  assert.strictEqual(Object.keys(env.timeouts).length, 0, "health timeout clears after frame advance");
  clock += 6000; interval();
  assert.strictEqual(reports[reports.length - 1].playback, "frames stalled");
  clock += 1000; frames = 3; interval();
  assert.strictEqual(reports[reports.length - 1].playback, "frames advancing");
  session.stop();
}());

console.log("video-rtc-unit: PASS");
