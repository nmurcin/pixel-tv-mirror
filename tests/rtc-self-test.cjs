"use strict";

var assert = require("assert");
var fs = require("fs");
var path = require("path");
var vm = require("vm");
var source = fs.readFileSync(path.join(__dirname, "..", "tv-rtc.js"), "utf8");

function thenable(value, error) {
  return {
    then: function (ok, bad) {
      if (error) {
        bad(error);
      } else {
        ok(value);
      }
    }
  };
}

function makeHarness(mode) {
  var reports = [];
  var completions = [];
  var timerCallback = null;
  var peers = [];
  var lateReject = null;
  var channelB = { label: "PIXEL_TV_TEST", readyState: "open" };
  var channelA = {
    label: "PIXEL_TV_TEST",
    readyState: "open",
    close: function () {},
    send: function (data) {
      if (channelB.onmessage) {
        channelB.onmessage({ data: data });
      }
    }
  };

  function PeerConnection(config) {
    this.index = peers.length;
    this.config = config;
    this.connectionState = "connected";
    this.iceConnectionState = "connected";
    this.iceGatheringState = "complete";
    peers.push(this);
  }

  PeerConnection.prototype.close = function () {};
  PeerConnection.prototype.createDataChannel = function () { return channelA; };

  if (mode === "callbacks") {
    PeerConnection.prototype.createOffer = function (ok, bad) {
      this.savedOfferFailure = bad;
      ok({ type: "offer", sdp: "offer" });
    };
    PeerConnection.prototype.createAnswer = function (ok, bad) {
      ok({ type: "answer", sdp: "answer" });
    };
    PeerConnection.prototype.setLocalDescription = function (description, ok, bad) { ok(); };
    PeerConnection.prototype.setRemoteDescription = function (description, ok, bad) {
      ok();
      if (this.index === 0) {
        peers[1].ondatachannel({ channel: channelB });
        channelA.onopen();
      }
    };
    PeerConnection.prototype.addIceCandidate = function (candidate, ok, bad) { ok(); };
  } else if (mode === "promise") {
    PeerConnection.prototype.createOffer = function () {
      return thenable({ type: "offer", sdp: "offer" });
    };
    PeerConnection.prototype.createAnswer = function () {
      return thenable({ type: "answer", sdp: "answer" });
    };
    PeerConnection.prototype.setLocalDescription = function (description) { return thenable(); };
    PeerConnection.prototype.setRemoteDescription = function (description) {
      var self = this;
      return {
        then: function (ok) {
          ok();
          if (self.index === 0) {
            peers[1].ondatachannel({ channel: channelB });
            channelA.onopen();
          }
        }
      };
    };
    PeerConnection.prototype.addIceCandidate = function (candidate) { return thenable(); };
  } else if (mode === "reject") {
    PeerConnection.prototype.createOffer = function () {
      return thenable(null, { name: "OperationError", message: "offer rejected" });
    };
  } else if (mode === "timeout") {
    PeerConnection.prototype.createOffer = function () {
      return {
        then: function (ok, bad) {
          lateReject = bad;
        }
      };
    };
  }

  var windowObject = {
    RTCPeerConnection: PeerConnection,
    Promise: undefined,
    setTimeout: function (callback) {
      timerCallback = callback;
      return 1;
    },
    clearTimeout: function () {}
  };
  vm.runInNewContext(source, { window: windowObject }, { filename: "tv-rtc.js" });

  return {
    peers: peers,
    reports: reports,
    completions: completions,
    run: function () {
      return windowObject.TVRTC.run(function (step, status, detail) {
        reports.push({ step: step, status: status, detail: detail });
      }, function (success) {
        completions.push(success);
      });
    },
    timeout: function () { timerCallback(); },
    rejectLate: function () {
      if (lateReject) {
        lateReject({ name: "LateError", message: "stale rejection" });
      }
    }
  };
}

function latest(reports, step) {
  var i;
  for (i = reports.length - 1; i >= 0; i -= 1) {
    if (reports[i].step === step) {
      return reports[i];
    }
  }
  return null;
}

(function callbackOnlyWithoutPromise() {
  var h = makeHarness("callbacks");
  h.run();
  assert.deepStrictEqual(h.completions, [true]);
  assert.strictEqual(latest(h.reports, "message").status, "PASS");
  assert.strictEqual(latest(h.reports, "dc").status, "PASS");
  assert.strictEqual(h.peers[0].config.iceServers.length, 0);
  assert.strictEqual(h.peers[1].config.iceServers.length, 0);
  var count = h.reports.length;
  h.peers[0].savedOfferFailure({ name: "LateError", message: "stale callback" });
  assert.strictEqual(h.reports.length, count);
  assert.deepStrictEqual(h.completions, [true]);
}());

(function promiseOnlyWithoutWindowPromise() {
  var h = makeHarness("promise");
  h.run();
  assert.deepStrictEqual(h.completions, [true]);
  assert.strictEqual(latest(h.reports, "offer").status, "PASS");
  assert.strictEqual(latest(h.reports, "answer").status, "PASS");
  assert.strictEqual(latest(h.reports, "message").status, "PASS");
}());

(function rejectedOfferReportsOperationAndSkips() {
  var h = makeHarness("reject");
  h.run();
  assert.deepStrictEqual(h.completions, [false]);
  assert.strictEqual(latest(h.reports, "offer").status, "FAIL");
  assert.match(latest(h.reports, "offer").detail, /createOffer on peer A - OperationError: offer rejected/);
  assert.strictEqual(latest(h.reports, "answer").status, "UNKNOWN");
  assert.strictEqual(latest(h.reports, "message").status, "UNKNOWN");
}());

(function timeoutAndStalePromiseCallback() {
  var h = makeHarness("timeout");
  h.run();
  h.timeout();
  assert.deepStrictEqual(h.completions, [false]);
  assert.strictEqual(latest(h.reports, "ice").status, "UNKNOWN");
  ["offer", "answer", "peer", "dc", "message"].forEach(function (step) {
    assert.strictEqual(latest(h.reports, step).status, "FAIL");
    assert.match(latest(h.reports, step).detail, /TimeoutError/);
  });
  var count = h.reports.length;
  h.rejectLate();
  assert.strictEqual(h.reports.length, count);
  assert.deepStrictEqual(h.completions, [false]);
}());

console.log("rtc-self-test: PASS");
