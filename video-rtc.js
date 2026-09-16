(function (window) {
  "use strict";

  var STATS_INTERVAL_MS = 1000;
  var HEALTH_TIMEOUT_MS = 30000;

  function namedError(name, message) {
    var error = new Error(message);
    error.name = name;
    return error;
  }

  function errorText(error) {
    var name = error && error.name ? String(error.name) : "Error";
    var message = error && error.message ? String(error.message) : String(error || "Unknown error");
    return name + ": " + message;
  }

  function splitSdp(sdp) {
    return String(sdp || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  }

  function videoSections(lines) {
    var sections = [];
    var start = -1;
    var i;
    for (i = 0; i <= lines.length; i += 1) {
      if (i === lines.length || /^m=/i.test(lines[i])) {
        if (start >= 0) {
          sections.push({ start: start, end: i });
        }
        start = i < lines.length && /^m=video\s/i.test(lines[i]) ? i : -1;
      }
    }
    return sections;
  }

  function payloadMap(lines, section) {
    var map = {};
    var match;
    var i;
    for (i = section.start + 1; i < section.end; i += 1) {
      match = /^a=rtpmap:(\d+)\s+([^\s\/]+)/i.exec(lines[i]);
      if (match) {
        map[match[1]] = String(match[2]).toUpperCase();
      }
    }
    return map;
  }

  function filterH264Sdp(sdp) {
    var lines = splitSdp(sdp);
    var sections = videoSections(lines);
    var foundH264 = false;
    var offset = 0;
    var s;
    for (s = 0; s < sections.length; s += 1) {
      var section = { start: sections[s].start + offset, end: sections[s].end + offset };
      var mparts = lines[section.start].split(/\s+/);
      var offered = mparts.slice(3);
      var codecs = payloadMap(lines, section);
      var keep = {};
      var isOffered = {};
      var keptPayloads = [];
      var body = [];
      var i;
      var match;
      for (i = 0; i < offered.length; i += 1) {
        isOffered[offered[i]] = true;
        if (codecs[offered[i]] === "H264") {
          keep[offered[i]] = true;
          foundH264 = true;
        }
      }
      for (i = section.start + 1; i < section.end; i += 1) {
        match = /^a=fmtp:(\d+)\s+.*\bapt=(\d+)\b/i.exec(lines[i]);
        if (match && isOffered[match[1]] && codecs[match[1]] === "RTX" && keep[match[2]]) {
          keep[match[1]] = true;
        }
      }
      for (i = 0; i < offered.length; i += 1) {
        if (keep[offered[i]]) {
          keptPayloads.push(offered[i]);
        }
      }
      if (mparts[1] !== "0" && !keptPayloads.length) {
        throw namedError("NotSupportedError", "A video section contains no H.264 payload");
      }
      if (mparts[1] === "0") {
        continue;
      }
      for (i = section.start + 1; i < section.end; i += 1) {
        match = /^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)\b/i.exec(lines[i]);
        if (!match || keep[match[1]]) {
          body.push(lines[i]);
        }
      }
      var output = [mparts.slice(0, 3).concat(keptPayloads).join(" ")].concat(body);
      var removed = section.end - section.start;
      lines.splice.apply(lines, [section.start, removed].concat(output));
      offset += output.length - removed;
    }
    if (!foundH264) {
      throw namedError("NotSupportedError", "The offer contains no H.264 video payload");
    }
    return lines.join("\r\n");
  }

  function negotiatedCodec(sdp) {
    var lines = splitSdp(sdp);
    var sections = videoSections(lines);
    var i;
    var name;
    var found = [];
    var seen = {};
    if (!sections.length) {
      return "?";
    }
    var parts = lines[sections[0].start].split(/\s+/);
    var codecs = payloadMap(lines, sections[0]);
    if (parts[1] === "0" || parts.length < 4) {
      return "rejected";
    }
    for (i = 3; i < parts.length; i += 1) {
      name = codecs[parts[i]];
      if (name && name !== "RTX" && name !== "RED" && name !== "ULPFEC" &&
          name !== "FLEXFEC-03" && !seen[name]) {
        seen[name] = true;
        found.push(name);
      }
    }
    return found.length ? found.join(", ") : "?";
  }

  function callCreate(peer, method, success, failure) {
    var settled = false;
    var ok = function (value) {
      if (!settled) {
        settled = true;
        success(value);
      }
    };
    var bad = function (error) {
      if (!settled) {
        settled = true;
        failure(error);
      }
    };
    var result;
    try {
      if (peer[method].length >= 2) {
        result = peer[method](ok, bad);
      } else {
        result = peer[method]();
      }
      if (result && typeof result.then === "function") {
        result.then(ok, bad);
      }
    } catch (error) {
      bad(error);
    }
  }

  function callValue(target, method, value, success, failure) {
    var settled = false;
    var ok = function () {
      if (!settled) {
        settled = true;
        success();
      }
    };
    var bad = function (error) {
      if (!settled) {
        settled = true;
        failure(error);
      }
    };
    var result;
    try {
      if (target[method].length >= 2) {
        result = target[method](value, ok, bad);
      } else {
        result = target[method](value);
      }
      if (result && typeof result.then === "function") {
        result.then(ok, bad);
      }
    } catch (error) {
      bad(error);
    }
  }

  function description(value) {
    var Constructor = window.RTCSessionDescription || window.webkitRTCSessionDescription ||
      window.mozRTCSessionDescription;
    if (Constructor) {
      try {
        return new Constructor(value);
      } catch (ignore) {}
    }
    return value;
  }

  function candidate(value) {
    var Constructor = window.RTCIceCandidate || window.webkitRTCIceCandidate ||
      window.mozRTCIceCandidate;
    if (Constructor) {
      try {
        return new Constructor(value);
      } catch (ignore) {}
    }
    return value;
  }

  function statsArray(response) {
    var list = [];
    var legacy;
    var names;
    var item;
    var out;
    var i;
    var j;
    if (!response) {
      return list;
    }
    if (typeof response.forEach === "function") {
      response.forEach(function (value) { list.push(value); });
      return list;
    }
    if (typeof response.result === "function") {
      legacy = response.result();
      for (i = 0; i < legacy.length; i += 1) {
        item = legacy[i];
        out = { id: item.id, type: item.type, timestamp: item.timestamp };
        names = typeof item.names === "function" ? item.names() : [];
        for (j = 0; j < names.length; j += 1) {
          out[names[j]] = item.stat(names[j]);
        }
        list.push(out);
      }
    }
    return list;
  }

  function getStats(peer, success, failure) {
    var settled = false;
    var ok = function (value) {
      if (!settled) {
        settled = true;
        success(statsArray(value));
      }
    };
    var bad = function (error) {
      if (!settled) {
        settled = true;
        failure(error);
      }
    };
    var result;
    try {
      result = peer.getStats();
      if (result && typeof result.then === "function") {
        result.then(ok, bad);
        return;
      }
      if (result && (typeof result.forEach === "function" || typeof result.result === "function")) {
        ok(result);
        return;
      }
    } catch (modernError) {
      try {
        peer.getStats(ok, bad);
        return;
      } catch (legacyError) {
        bad(legacyError);
        return;
      }
    }
    try {
      peer.getStats(ok, bad);
    } catch (error) {
      bad(error);
    }
  }

  function number(value) {
    if (value === null || value === undefined || value === "") {
      return null;
    }
    var parsed = Number(value);
    return isFinite(parsed) ? parsed : null;
  }

  function start(options) {
    options = options || {};
    var role = options.role;
    var mode = options.mode || "h264";
    var PeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection ||
      window.mozRTCPeerConnection;
    var active = true;
    var peer = null;
    var localStream = null;
    var remoteStream = null;
    var remoteReady = false;
    var queuedCandidates = [];
    var animationTimer = null;
    var statsTimer = null;
    var healthTimer = null;
    var startedAt = new Date().getTime();
    var framesSeen = false;
    var trackAttached = false;
    var lastSample = null;
    var codec = "?";
    var codecSource = "?";
    var detail = "starting";
    var reportCount = 0;
    var lastSnapshot = null;
    var iceFailureReported = false;
    var statsFailureReported = false;
    var videoClockSeen = false;
    var lastVideoTime = null;
    var lastClockAdvanceAt = null;
    var counterAvailable = false;
    var lastFrameAdvanceAt = null;

    function emitError(step, error) {
      if (!active) {
        return;
      }
      try {
        if (typeof options.error === "function") {
          options.error(step, error);
        }
      } catch (ignore) {}
    }

    function send(type, data) {
      if (!active) {
        return;
      }
      try {
        options.send(type, data);
      } catch (error) {
        emitError("signaling send " + type, error);
      }
    }

    function report(snapshot) {
      lastSnapshot = snapshot;
      try {
        if (typeof options.report === "function") {
          options.report(snapshot);
        }
      } catch (ignore) {}
    }

    function baseSnapshot() {
      return {
        state: peer ? String(peer.connectionState || peer.signalingState || "?") : "?",
        ice: peer ? String(peer.iceConnectionState || "?") : "?",
        codec: codec,
        codecSource: codecSource,
        width: "?",
        height: "?",
        framesDecoded: "?",
        fps: "?",
        bytesReceived: "?",
        bitrateKbps: "?",
        rttMs: "?",
        elapsedSeconds: Math.round((new Date().getTime() - startedAt) / 100) / 10,
        playback: trackAttached ? "track only" : "?",
        detail: detail
      };
    }

    function drawCanvas() {
      var canvas = options.canvas;
      var context;
      var elapsed;
      var x;
      var colors = ["#ed1c24", "#ff7f27", "#fff200", "#22b14c", "#00a2e8", "#3f48cc", "#a349a4"];
      var i;
      if (!active || !canvas || typeof canvas.getContext !== "function") {
        return;
      }
      context = canvas.getContext("2d");
      if (!context) {
        return;
      }
      elapsed = new Date().getTime() - startedAt;
      for (i = 0; i < colors.length; i += 1) {
        context.fillStyle = colors[i];
        context.fillRect(Math.floor(i * canvas.width / colors.length), 0,
          Math.ceil(canvas.width / colors.length), canvas.height);
      }
      context.fillStyle = "rgba(0,0,0,0.75)";
      context.fillRect(0, 510, canvas.width, 210);
      x = Math.floor((elapsed / 8) % (canvas.width + 160)) - 160;
      context.fillStyle = "#ffffff";
      context.fillRect(x, 390, 160, 100);
      context.font = "bold 44px sans-serif";
      context.fillText("PIXEL TV VIDEO TEST", 42, 574);
      context.font = "32px monospace";
      context.fillText("elapsed " + String(elapsed) + " ms", 42, 628);
      context.fillText("frame " + String(Math.floor(elapsed / (1000 / 30))), 42, 674);
    }

    function startCanvas() {
      var canvas = options.canvas;
      var capture;
      if (!canvas) {
        throw namedError("TypeError", "Sender requires options.canvas");
      }
      canvas.width = 1280;
      canvas.height = 720;
      drawCanvas();
      animationTimer = window.setInterval(drawCanvas, 33);
      capture = canvas.captureStream || canvas.webkitCaptureStream;
      if (typeof capture !== "function") {
        throw namedError("NotSupportedError", "Canvas captureStream is unavailable");
      }
      localStream = capture.call(canvas, 30);
      if (!localStream || !localStream.getVideoTracks || !localStream.getVideoTracks().length) {
        throw namedError("NotSupportedError", "Canvas capture produced no video track");
      }
      if (typeof peer.addTrack === "function") {
        peer.addTrack(localStream.getVideoTracks()[0], localStream);
      } else if (typeof peer.addStream === "function") {
        peer.addStream(localStream);
      } else {
        throw namedError("NotSupportedError", "No WebRTC track or stream sender API is available");
      }
    }

    function attachStream(stream) {
      var video = options.video;
      var playResult;
      if (!active || !stream || remoteStream === stream) {
        return;
      }
      remoteStream = stream;
      trackAttached = true;
      detail = "remote video track attached";
      if (!video) {
        emitError("attach receiver video", namedError("TypeError", "Receiver requires options.video"));
        return;
      }
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      try {
        if ("srcObject" in video) {
          video.srcObject = stream;
        } else if (window.URL && window.URL.createObjectURL) {
          video.src = window.URL.createObjectURL(stream);
        } else {
          throw namedError("NotSupportedError", "No MediaStream attachment API is available");
        }
        playResult = video.play();
        if (playResult && typeof playResult.then === "function") {
          playResult.then(function () {}, function (error) {
            detail = "track attached; autoplay blocked - use Play";
            emitError("autoplay receiver video", error);
          });
        }
      } catch (error) {
        detail = "track attached; playback needs Play";
        emitError("attach receiver video", error);
      }
    }

    function addRemoteCandidate(value) {
      callValue(peer, "addIceCandidate", candidate(value), function () {}, function (error) {
        if (!active) { return; }
        emitError("add remote ICE candidate", error);
      });
    }

    function flushCandidates() {
      while (active && remoteReady && queuedCandidates.length) {
        addRemoteCandidate(queuedCandidates.shift());
      }
    }

    function setRemote(value, success, step) {
      callValue(peer, "setRemoteDescription", description(value), function () {
        if (!active) { return; }
        remoteReady = true;
        flushCandidates();
        success();
      }, function (error) {
        if (!active) { return; }
        emitError(step, error);
      });
    }

    function createSenderOffer() {
      callCreate(peer, "createOffer", function (offer) {
        if (!active) { return; }
        var local = { type: offer.type, sdp: offer.sdp };
        try {
          if (mode === "h264") {
            local.sdp = filterH264Sdp(local.sdp);
          }
        } catch (error) {
          emitError("restrict offer to H.264", error);
          stop(false);
          return;
        }
        callValue(peer, "setLocalDescription", description(local), function () {
          if (!active) { return; }
          detail = mode === "h264" ? "H.264-only offer sent" : "automatic-codec offer sent";
          send("offer", { type: peer.localDescription.type, sdp: peer.localDescription.sdp });
        }, function (error) {
          if (!active) { return; }
          emitError("set sender local offer", error);
        });
      }, function (error) {
        if (!active) { return; }
        emitError("create sender offer", error);
      });
    }

    function receiveOffer(value) {
      setRemote(value, function () {
        callCreate(peer, "createAnswer", function (answer) {
          if (!active) { return; }
          callValue(peer, "setLocalDescription", answer, function () {
            if (!active) { return; }
            codec = negotiatedCodec(peer.localDescription.sdp);
            codecSource = "SDP negotiated candidates";
            detail = "answer sent";
            send("answer", { type: peer.localDescription.type, sdp: peer.localDescription.sdp });
          }, function (error) {
            if (!active) { return; }
            emitError("set receiver local answer", error);
          });
        }, function (error) {
          if (!active) { return; }
          emitError("create receiver answer", error);
        });
      }, "set receiver remote offer");
    }

    function receiveAnswer(value) {
      codec = negotiatedCodec(value.sdp);
      codecSource = "SDP negotiated candidates";
      setRemote(value, function () {
        detail = "answer applied";
      }, "set sender remote answer");
    }

    function statValue(stats, names) {
      var i;
      var value;
      for (i = 0; i < names.length; i += 1) {
        value = stats[names[i]];
        if (value !== undefined && value !== null && value !== "") {
          return value;
        }
      }
      return null;
    }

    function makeStatsSnapshot(list) {
      var snapshot = baseSnapshot();
      var codecs = {};
      var inbound = null;
      var pair = null;
      var remoteInbound = null;
      var i;
      var item;
      var kind;
      var activePair;
      var now = new Date().getTime();
      var frames = null;
      var bytes = null;
      var width = null;
      var height = null;
      var rate = null;
      var rtt = null;
      for (i = 0; i < list.length; i += 1) {
        item = list[i];
        if (item.type === "codec") {
          codecs[item.id] = item;
        }
      }
      for (i = 0; i < list.length; i += 1) {
        item = list[i];
        kind = String(item.kind || item.mediaType || "").toLowerCase();
        if ((item.type === "inbound-rtp" && kind === "video" && !item.isRemote) ||
            (item.type === "ssrc" && kind === "video" && number(item.bytesReceived) !== null)) {
          inbound = item;
        }
        activePair = item.selected || item.nominated || String(item.googActiveConnection) === "true";
        if ((item.type === "candidate-pair" || item.type === "googCandidatePair") && activePair) {
          pair = item;
        }
        if (item.type === "remote-inbound-rtp" && kind === "video") {
          remoteInbound = item;
        }
      }
      if (inbound) {
        item = codecs[inbound.codecId];
        if (item && item.mimeType) {
          codec = String(item.mimeType).replace(/^video\//i, "").toUpperCase();
          codecSource = "RTP stats";
        } else if (statValue(inbound, ["googCodecName", "codecName", "codec"])) {
          codec = String(statValue(inbound, ["googCodecName", "codecName", "codec"])).toUpperCase();
          codecSource = "RTP stats";
        }
        snapshot.codec = codec;
        snapshot.codecSource = codecSource;
        frames = number(statValue(inbound, ["framesDecoded", "googDecodedFrameCount"]));
        bytes = number(inbound.bytesReceived);
        width = number(statValue(inbound, ["frameWidth", "googFrameWidthReceived"]));
        height = number(statValue(inbound, ["frameHeight", "googFrameHeightReceived"]));
        rate = number(statValue(inbound, ["framesPerSecond", "googFrameRateDecoded", "googFrameRateOutput"]));
      }
      if (role === "receiver" && options.video) {
        if (frames === null) {
          frames = number(options.video.webkitDecodedFrameCount);
        }
        if (width === null) {
          width = number(options.video.videoWidth);
        }
        if (height === null) {
          height = number(options.video.videoHeight);
        }
        if (width !== null && width > 0 && height !== null && height > 0) {
          var currentTime = number(options.video.currentTime);
          if (currentTime !== null && lastVideoTime !== null && currentTime > lastVideoTime) {
            videoClockSeen = true;
            lastClockAdvanceAt = now;
          }
          if (currentTime !== null) {
            lastVideoTime = currentTime;
          }
        }
      }
      if (frames !== null) {
        counterAvailable = true;
        snapshot.framesDecoded = Math.round(frames);
      }
      if (bytes !== null) {
        snapshot.bytesReceived = Math.round(bytes);
      }
      if (width !== null && width > 0) {
        snapshot.width = Math.round(width);
      }
      if (height !== null && height > 0) {
        snapshot.height = Math.round(height);
      }
      if (lastSample) {
        var seconds = (now - lastSample.time) / 1000;
        if (seconds > 0 && frames !== null && lastSample.frames !== null) {
          rate = (frames - lastSample.frames) / seconds;
          if (frames > lastSample.frames) {
            framesSeen = true;
            lastFrameAdvanceAt = now;
          }
        }
        if (seconds > 0 && bytes !== null && lastSample.bytes !== null) {
          snapshot.bitrateKbps = Math.max(0, Math.round((bytes - lastSample.bytes) * 8 / seconds / 100) / 10);
        }
      }
      if (rate !== null && rate >= 0) {
        snapshot.fps = Math.round(rate * 10) / 10;
      }
      lastSample = { time: now, frames: frames, bytes: bytes };
      if (!counterAvailable && !framesSeen && videoClockSeen) {
        framesSeen = true;
      }
      if (framesSeen && healthTimer !== null) {
        window.clearTimeout(healthTimer);
        healthTimer = null;
      }
      if (pair) {
        rtt = number(pair.currentRoundTripTime);
        if (rtt !== null) {
          rtt = rtt * 1000;
        } else {
          rtt = number(pair.googRtt);
        }
      }
      if (rtt === null && remoteInbound) {
        rtt = number(remoteInbound.roundTripTime);
        if (rtt !== null) {
          rtt = rtt * 1000;
        }
      }
      if (rtt !== null) {
        snapshot.rttMs = Math.round(rtt);
      }
      if (counterAvailable && lastFrameAdvanceAt !== null) {
        snapshot.playback = now - lastFrameAdvanceAt <= 5000 ? "frames advancing" : "frames stalled";
      } else if (!counterAvailable && videoClockSeen && lastClockAdvanceAt !== null) {
        if (now - lastClockAdvanceAt <= 5000) {
          snapshot.playback = "clock advancing (frame counter unavailable)";
          detail = "video dimensions and playback clock advance; decoded frame counter unavailable";
        } else {
          snapshot.playback = "clock stalled (frame counter unavailable)";
          detail = "video playback clock has not advanced for 5 seconds; decoded frame counter unavailable";
        }
      } else {
        snapshot.playback = trackAttached ? "track only" : "?";
      }
      if (framesSeen && detail.indexOf("timeout") >= 0) {
        detail = "video recovered; decoded frames are advancing";
      }
      snapshot.detail = detail;
      return snapshot;
    }

    function pollStats() {
      function publish(snapshot) {
        report(snapshot);
        reportCount += 1;
        if (role === "receiver" && reportCount % 2 === 0) {
          send("report", snapshot);
        }
      }
      if (!active || !peer) {
        return;
      }
      if (typeof peer.getStats !== "function") {
        detail = "statistics unavailable; playback monitoring continues";
        publish(makeStatsSnapshot([]));
        return;
      }
      getStats(peer, function (list) {
        var snapshot;
        if (!active) {
          return;
        }
        snapshot = makeStatsSnapshot(list);
        statsFailureReported = false;
        publish(snapshot);
      }, function (error) {
        var snapshot;
        if (!active) {
          return;
        }
        if (!statsFailureReported) {
          statsFailureReported = true;
          emitError("read WebRTC statistics", error);
        }
        snapshot = makeStatsSnapshot([]);
        snapshot.detail = "statistics unavailable; playback monitoring continues";
        publish(snapshot);
      });
    }

    function stop(notify) {
      var tracks;
      var i;
      if (!active) {
        return;
      }
      if (notify !== false) {
        send("bye", { reason: "stopped" });
      }
      active = false;
      if (animationTimer !== null) {
        window.clearInterval(animationTimer);
      }
      if (statsTimer !== null) {
        window.clearInterval(statsTimer);
      }
      if (healthTimer !== null) {
        window.clearTimeout(healthTimer);
      }
      if (localStream && localStream.getTracks) {
        tracks = localStream.getTracks();
        for (i = 0; i < tracks.length; i += 1) {
          try { tracks[i].stop(); } catch (ignoreTrack) {}
        }
      }
      if (peer) {
        peer.onicecandidate = null;
        peer.oniceconnectionstatechange = null;
        peer.onconnectionstatechange = null;
        peer.ontrack = null;
        peer.onaddstream = null;
        try { peer.close(); } catch (ignorePeer) {}
      }
      if (role === "receiver" && options.video) {
        try { options.video.pause(); } catch (ignorePause) {}
        try { options.video.srcObject = null; } catch (ignoreObject) {}
        try { options.video.removeAttribute("src"); } catch (ignoreSrc) {}
      }
      queuedCandidates = [];
    }

    function receive(type, data) {
      if (!active) {
        return;
      }
      if (type === "offer" && role === "receiver") {
        receiveOffer(data);
      } else if (type === "answer" && role === "sender") {
        receiveAnswer(data);
      } else if (type === "candidate") {
        if (remoteReady) {
          addRemoteCandidate(data);
        } else {
          queuedCandidates.push(data);
        }
      } else if (type === "report" && role === "sender") {
        var snapshot = lastSnapshot || baseSnapshot();
        var combined = {};
        var key;
        for (key in snapshot) {
          if (Object.prototype.hasOwnProperty.call(snapshot, key)) {
            combined[key] = snapshot[key];
          }
        }
        combined.remote = data;
        report(combined);
      } else if (type === "bye") {
        detail = "remote peer stopped";
        report(baseSnapshot());
        stop(false);
      }
    }

    if (role !== "sender" && role !== "receiver") {
      throw namedError("TypeError", "role must be sender or receiver");
    }
    if (mode !== "h264" && mode !== "auto") {
      throw namedError("TypeError", "mode must be h264 or auto");
    }
    if (typeof options.send !== "function") {
      throw namedError("TypeError", "send callback is required");
    }
    if (!PeerConnection) {
      throw namedError("NotSupportedError", "RTCPeerConnection is unavailable");
    }

    peer = new PeerConnection({ iceServers: [] });
    peer.onicecandidate = function (event) {
      var value;
      if (!active || !event.candidate) {
        return;
      }
      value = typeof event.candidate.toJSON === "function" ? event.candidate.toJSON() : {
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex
      };
      send("candidate", value);
    };
    peer.oniceconnectionstatechange = function () {
      var state = peer.iceConnectionState;
      if (state === "failed" && !iceFailureReported) {
        iceFailureReported = true;
        detail = "ICE failed; connection may recover after network change";
        emitError("ICE connection", namedError("ConnectionError", detail));
      } else if ((state === "connected" || state === "completed") && iceFailureReported) {
        iceFailureReported = false;
        detail = "ICE connection recovered";
        report(baseSnapshot());
      }
    };
    peer.onconnectionstatechange = function () {
      report(baseSnapshot());
    };
    peer.ontrack = function (event) {
      if (event.streams && event.streams[0]) {
        attachStream(event.streams[0]);
      } else if (window.MediaStream && event.track) {
        attachStream(new window.MediaStream([event.track]));
      }
    };
    peer.onaddstream = function (event) {
      attachStream(event.stream);
    };

    try {
      if (role === "sender") {
        startCanvas();
        createSenderOffer();
      } else if (!options.video) {
        throw namedError("TypeError", "Receiver requires options.video");
      }
    } catch (startError) {
      emitError("start " + role, startError);
      stop(false);
      throw startError;
    }

    statsTimer = window.setInterval(pollStats, STATS_INTERVAL_MS);
    healthTimer = window.setTimeout(function () {
      var state;
      if (!active) {
        return;
      }
      state = peer.iceConnectionState;
      if (state !== "connected" && state !== "completed") {
        detail = "30 second timeout waiting for ICE connectivity; still monitoring";
        emitError("ICE timeout", namedError("TimeoutError", detail));
      }
      if (role === "receiver" && !framesSeen) {
        detail = "30 second timeout with no decoded frame advance; still monitoring";
        emitError("video frames timeout", namedError("TimeoutError", detail));
      }
      report(baseSnapshot());
    }, HEALTH_TIMEOUT_MS);
    report(baseSnapshot());

    return {
      stop: function () { stop(true); },
      receive: receive
    };
  }

  window.PixelVideoRTC = {
    start: start,
    filterH264Sdp: filterH264Sdp,
    negotiatedCodec: negotiatedCodec
  };
}(window));
