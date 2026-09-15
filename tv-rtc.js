(function (window) {
  "use strict";

  var TEST_LABEL = "PIXEL_TV_TEST";
  var TIMEOUT_MS = 20000;
  var STEP_KEYS = ["constructor", "offer", "answer", "ice", "peer", "dc", "message"];

  function errorDetail(error) {
    var name = error && error.name ? String(error.name) : "Error";
    var message = error && error.message ? String(error.message) : String(error || "Unknown error");
    return name + ": " + message;
  }

  window.TVRTC = {
    run: function (report, done) {
      var PeerConnection = window.RTCPeerConnection ||
        window.webkitRTCPeerConnection || window.mozRTCPeerConnection;
      var active = true;
      var finished = false;
      var timer = null;
      var peerA = null;
      var peerB = null;
      var channelA = null;
      var channelB = null;
      var remoteReadyA = false;
      var remoteReadyB = false;
      var queuedForA = [];
      var queuedForB = [];
      var iceCompleteA = false;
      var iceCompleteB = false;
      var pendingIceAdds = 0;
      var sent = false;
      var received = false;
      var token = TEST_LABEL + ":" + String(new Date().getTime()) + ":" +
        String(Math.random());
      var reported = {};

      report = typeof report === "function" ? report : function () {};
      done = typeof done === "function" ? done : function () {};

      function emit(step, status, detail) {
        var previous;
        if (!active) {
          return;
        }
        previous = reported[step];
        if (previous === "FAIL" || previous === status ||
            (previous === "PASS" && status === "UNKNOWN")) {
          return;
        }
        reported[step] = status;
        try {
          report(step, status, detail || "");
        } catch (ignore) {}
      }

      function skipUnreported(failedStep, detail) {
        var i;
        for (i = 0; i < STEP_KEYS.length; i += 1) {
          if (!reported[STEP_KEYS[i]]) {
            emit(STEP_KEYS[i], "UNKNOWN", "Skipped after " + failedStep +
              " failed: " + detail);
          }
        }
      }

      function clearHandlers(peer) {
        if (!peer) {
          return;
        }
        peer.onicecandidate = null;
        peer.onicegatheringstatechange = null;
        peer.oniceconnectionstatechange = null;
        peer.onconnectionstatechange = null;
        peer.ondatachannel = null;
      }

      function cleanup() {
        active = false;
        if (timer !== null) {
          window.clearTimeout(timer);
          timer = null;
        }
        clearHandlers(peerA);
        clearHandlers(peerB);
        if (channelA) {
          channelA.onopen = null;
          channelA.onerror = null;
          channelA.onclose = null;
        }
        if (channelB) {
          channelB.onopen = null;
          channelB.onmessage = null;
          channelB.onerror = null;
          channelB.onclose = null;
        }
        try {
          if (channelA) {
            channelA.close();
          }
        } catch (ignoreA) {}
        try {
          if (channelB) {
            channelB.close();
          }
        } catch (ignoreB) {}
        try {
          if (peerA) {
            peerA.close();
          }
        } catch (ignorePeerA) {}
        try {
          if (peerB) {
            peerB.close();
          }
        } catch (ignorePeerB) {}
        queuedForA = [];
        queuedForB = [];
      }

      function finish(success) {
        if (finished) {
          return;
        }
        if (success && !reported.ice) {
          if (iceCompleteA && iceCompleteB) {
            emit("ice", "PASS", "ICE gathering completed for both local peers");
          } else {
            emit("ice", "UNKNOWN", "Data arrived before ICE gathering completed for both peers");
          }
        }
        finished = true;
        cleanup();
        try {
          done(!!success);
        } catch (ignore) {}
      }

      function fail(step, operation, error) {
        var detail;
        if (!active || finished) {
          return;
        }
        detail = operation + " - " + errorDetail(error);
        emit(step, "FAIL", detail);
        skipUnreported(step, detail);
        finish(false);
      }

      function callCreate(peer, methodName, success, failure) {
        var settled = false;
        var ok = function (value) {
          if (settled) {
            return;
          }
          settled = true;
          if (active) {
            success(value);
          }
        };
        var bad = function (error) {
          if (settled) {
            return;
          }
          settled = true;
          if (active) {
            failure(error);
          }
        };
        var result;
        try {
          if (peer[methodName].length >= 2) {
            result = peer[methodName](ok, bad);
          } else {
            result = peer[methodName]();
          }
          if (result && typeof result.then === "function") {
            result.then(ok, bad);
          }
        } catch (error) {
          bad(error);
        }
      }

      function callWithValue(target, methodName, value, success, failure) {
        var settled = false;
        var ok = function () {
          if (settled) {
            return;
          }
          settled = true;
          if (active) {
            success();
          }
        };
        var bad = function (error) {
          if (settled) {
            return;
          }
          settled = true;
          if (active) {
            failure(error);
          }
        };
        var result;
        try {
          if (target[methodName].length >= 2) {
            result = target[methodName](value, ok, bad);
          } else {
            result = target[methodName](value);
          }
          if (result && typeof result.then === "function") {
            result.then(ok, bad);
          }
        } catch (error) {
          bad(error);
        }
      }

      function describe(description) {
        var SessionDescription = window.RTCSessionDescription ||
          window.webkitRTCSessionDescription || window.mozRTCSessionDescription;
        if (!SessionDescription) {
          return description;
        }
        try {
          return new SessionDescription(description);
        } catch (ignore) {
          return description;
        }
      }

      function addCandidate(peer, candidate, operation) {
        pendingIceAdds += 1;
        callWithValue(peer, "addIceCandidate", candidate, function () {
          pendingIceAdds -= 1;
          checkIceComplete();
        }, function (error) {
          pendingIceAdds -= 1;
          fail("ice", operation, error);
        });
      }

      function flushCandidates(peer, queue, operation) {
        var candidate;
        while (active && queue.length) {
          candidate = queue.shift();
          addCandidate(peer, candidate, operation);
        }
      }

      function deliverCandidate(peer, queue, remoteReady, candidate, operation) {
        if (!active) {
          return;
        }
        if (remoteReady()) {
          addCandidate(peer, candidate, operation);
        } else {
          queue.push(candidate);
        }
      }

      function checkIceComplete() {
        if (active && iceCompleteA && iceCompleteB) {
          emit("ice", "PASS", "ICE gathering completed for both local peers");
        }
      }

      function markIceComplete(which) {
        if (!active) {
          return;
        }
        if (which === "A") {
          iceCompleteA = true;
        } else {
          iceCompleteB = true;
        }
        checkIceComplete();
      }

      function watchPeerFailure(peer) {
        var connectionState;
        var iceState;
        if (!active) {
          return;
        }
        connectionState = peer.connectionState;
        iceState = peer.iceConnectionState;
        if (connectionState === "failed" || iceState === "failed") {
          fail("peer", "monitor peer connection states", {
            name: "ConnectionError",
            message: "connectionState=" + String(connectionState || "unavailable") +
              ", iceConnectionState=" + String(iceState || "unavailable")
          });
        }
      }

      function sendTestMessage() {
        if (!active || sent || !channelA || channelA.readyState !== "open") {
          return;
        }
        sent = true;
        try {
          channelA.send(token);
        } catch (error) {
          fail("message", "send test payload from peer A", error);
        }
      }

      function configureReceivedChannel(event) {
        if (!active) {
          return;
        }
        channelB = event && event.channel;
        if (!channelB || channelB.label !== TEST_LABEL) {
          fail("dc", "receive data channel on peer B", {
            name: "DataChannelError",
            message: "Peer B received an unexpected data channel"
          });
          return;
        }
        channelB.onerror = function (eventError) {
          fail("dc", "peer B data channel error",
            eventError && eventError.error ? eventError.error : eventError);
        };
        channelB.onmessage = function (messageEvent) {
          if (!active || received) {
            return;
          }
          if (messageEvent.data !== token) {
            fail("message", "validate payload received by peer B", {
              name: "DataError",
              message: "Peer B received an unexpected payload"
            });
            return;
          }
          received = true;
          if (channelB.readyState === "open") {
            emit("dc", "PASS", "Data channel was open when peer B received the payload");
          } else {
            fail("dc", "verify peer B data channel state", {
              name: "InvalidStateError",
              message: "Payload arrived while readyState=" + String(channelB.readyState)
            });
            return;
          }
          emit("peer", "PASS", "Local peer connection carried data from A to B");
          emit("message", "PASS", "Peer B received the test payload");
          finish(true);
        };
      }

      function negotiate() {
        callCreate(peerA, "createOffer", function (offer) {
          callWithValue(peerA, "setLocalDescription", offer, function () {
            callWithValue(peerB, "setRemoteDescription", describe(offer), function () {
              remoteReadyB = true;
              flushCandidates(peerB, queuedForB, "add peer A ICE candidate to peer B");
              emit("offer", "PASS", "Peer B accepted peer A's offer");
              callCreate(peerB, "createAnswer", function (answer) {
                callWithValue(peerB, "setLocalDescription", answer, function () {
                  callWithValue(peerA, "setRemoteDescription", describe(answer), function () {
                    remoteReadyA = true;
                    flushCandidates(peerA, queuedForA, "add peer B ICE candidate to peer A");
                    emit("answer", "PASS", "Peer A accepted peer B's answer");
                  }, function (error) {
                    fail("answer", "setRemoteDescription on peer A", error);
                  });
                }, function (error) {
                  fail("answer", "setLocalDescription on peer B", error);
                });
              }, function (error) {
                fail("answer", "createAnswer on peer B", error);
              });
            }, function (error) {
              fail("offer", "setRemoteDescription on peer B", error);
            });
          }, function (error) {
            fail("offer", "setLocalDescription on peer A", error);
          });
        }, function (error) {
          fail("offer", "createOffer on peer A", error);
        });
      }

      if (!PeerConnection) {
        fail("constructor", "locate RTCPeerConnection constructor", {
          name: "NotSupportedError",
          message: "RTCPeerConnection is unavailable"
        });
        return function () {};
      }

      try {
        peerA = new PeerConnection({ iceServers: [] });
        peerB = new PeerConnection({ iceServers: [] });
        emit("constructor", "PASS", "Created two local peer connections with no ICE servers");
      } catch (error) {
        fail("constructor", "construct local peer connections", error);
        return function () {};
      }

      peerA.onicecandidate = function (event) {
        if (!active) {
          return;
        }
        if (event.candidate) {
          deliverCandidate(peerB, queuedForB, function () { return remoteReadyB; },
            event.candidate, "add peer A ICE candidate to peer B");
        } else {
          markIceComplete("A");
        }
      };
      peerB.onicecandidate = function (event) {
        if (!active) {
          return;
        }
        if (event.candidate) {
          deliverCandidate(peerA, queuedForA, function () { return remoteReadyA; },
            event.candidate, "add peer B ICE candidate to peer A");
        } else {
          markIceComplete("B");
        }
      };
      peerA.onicegatheringstatechange = function () {
        if (peerA.iceGatheringState === "complete") {
          markIceComplete("A");
        }
      };
      peerB.onicegatheringstatechange = function () {
        if (peerB.iceGatheringState === "complete") {
          markIceComplete("B");
        }
      };
      peerA.onconnectionstatechange = function () { watchPeerFailure(peerA); };
      peerB.onconnectionstatechange = function () { watchPeerFailure(peerB); };
      peerA.oniceconnectionstatechange = function () { watchPeerFailure(peerA); };
      peerB.oniceconnectionstatechange = function () { watchPeerFailure(peerB); };
      peerB.ondatachannel = configureReceivedChannel;

      try {
        channelA = peerA.createDataChannel(TEST_LABEL);
        channelA.onopen = function () {
          emit("dc", "PASS", "Peer A data channel opened");
          sendTestMessage();
        };
        channelA.onerror = function (event) {
          fail("dc", "peer A data channel error",
            event && event.error ? event.error : event);
        };
      } catch (error) {
        fail("dc", "createDataChannel on peer A", error);
        return function () {};
      }

      timer = window.setTimeout(function () {
        var timedSteps = ["offer", "answer", "peer", "dc", "message"];
        var timedOperations = {
          offer: "offer creation and application",
          answer: "answer creation and application",
          peer: "peer connectivity",
          dc: "data channel open",
          message: "test payload delivery to peer B"
        };
        var i;
        if (!active || finished) {
          return;
        }
        if (!reported.ice) {
          emit("ice", "UNKNOWN", "ICE gathering did not complete for both peers before timeout");
        }
        for (i = 0; i < timedSteps.length; i += 1) {
          if (!reported[timedSteps[i]]) {
            emit(timedSteps[i], "FAIL", "TimeoutError - " +
              timedOperations[timedSteps[i]] + " did not complete within 20000 ms");
          }
        }
        finish(false);
      }, TIMEOUT_MS);

      negotiate();

      return function () {
        if (!finished) {
          finished = true;
          cleanup();
        }
      };
    }
  };
}(window));
