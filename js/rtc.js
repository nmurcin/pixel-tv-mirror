// ===========================================================================
// rtc.js — the WebRTC core. The highest-risk file; read this header first.
//
// SYMMETRIC MEDIA MODEL
// ---------------------
// Either peer can share. We achieve that with FOUR pre-allocated `sendrecv`
// transceivers, created ONCE by the initiator, in a FIXED ORDER:
//
//     index 0 → "screen-video"   (video)
//     index 1 → "screen-audio"   (audio)
//     index 2 → "webcam"         (video)
//     index 3 → "mic"            (audio)
//
// Because m-line order is preserved through offer/answer, BOTH peers see the
// same four transceivers in the same order. So a track's ROLE is simply its
// transceiver index — no fragile reliance on track.id, and no `track-meta`
// message needed. ROLE_ORDER below is the single source of truth.
//
// Each transceiver is `sendrecv`, so transceiver i carries role i in BOTH
// directions at once (A's screen → B, and B's screen → A, on the same m-line).
// To start/stop sending a given role, a peer just `replaceTrack()`s into that
// transceiver's sender — which does NOT trigger renegotiation. Nothing is sent
// on connect (all senders start empty); media lights up as each side opts in.
//
// NEGOTIATION
// -----------
// Deterministic initiator (the 2nd peer to join — see signaling.js) creates the
// only initial offer, so there's no glare on connect. A minimal perfect-
// negotiation guard (polite/impolite) is kept purely as a safety net for the
// one real collision case: simultaneous ICE restart after a network blip.
//
// RECONNECT
// ---------
// connectionState drives the UI. 'disconnected' → grace timer (often self-heals).
// 'failed' → the initiator (impolite) calls restartIce(); the polite peer asks
// the initiator to, via a {kind:'please-restart'} signaling message.
//
// DATA CHANNEL
// ------------
// One channel "app" created by the initiator BEFORE the first offer (so its
// m-line is in the initial SDP — no extra renegotiation). Carries chat + small
// app control messages (profile name, share-state, screen/cam-stopped). rtc.js
// stays generic: it ships/receives JSON and emits a "data" event; the app layer
// interprets message types.
// ===========================================================================

import { CONFIG } from "./config.js";

// The fixed role↔index convention. DO NOT REORDER — both peers depend on it.
export const ROLE_ORDER = ["screen-video", "screen-audio", "webcam", "mic"];
const KIND_FOR_ROLE = {
  "screen-video": "video",
  "screen-audio": "audio",
  webcam: "video",
  mic: "audio",
};

export class RTC {
  /**
   * @param {import('./signaling.js').Signaling} signaling
   */
  constructor(signaling) {
    this.signaling = signaling;
    this.pc = null;
    this.dc = null;
    this.isInitiator = false;

    // perfect-negotiation flags
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.polite = true;

    // Remote ICE candidates that arrived before we had a remoteDescription to
    // attach them to. The relay preserves send order, but offer and the first
    // candidates arrive back-to-back while our setRemoteDescription(offer) is
    // still awaiting — addIceCandidate() with no remoteDescription throws and
    // the candidate would be lost (can stall ICE on a fast path). We buffer here
    // and drain after each successful setRemoteDescription.
    this._pendingCandidates = [];

    // reconnect bookkeeping
    this.disconnectTimer = null;
    this.closed = false;

    // current screen tuning (so a quality-cap change can re-apply correctly)
    this.screenMode = CONFIG.DEFAULT_SCREEN_MODE;
    this.qualityCap = CONFIG.DEFAULT_QUALITY_CAP;

    this.listeners = new Map();

    // Subscribe to relayed client↔client payloads. Keep a STABLE reference to
    // the handler so close() can unsubscribe it — otherwise each reconnect
    // (which builds a fresh RTC) would leave a dead listener on the shared
    // Signaling instance, accumulating one per rejoin.
    this._onSignal = (data) => this._handleSignal(data);
    this.signaling.on("signal", this._onSignal);
  }

  // --- tiny event emitter (mirrors signaling.js) ---------------------------
  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return this;
  }
  _emit(event, payload) {
    this.listeners.get(event)?.forEach((fn) => {
      try {
        fn(payload);
      } catch (err) {
        console.error(`rtc listener "${event}" threw:`, err);
      }
    });
  }

  // --- lifecycle -----------------------------------------------------------
  /**
   * Create the RTCPeerConnection and wire it up.
   * @param {boolean} isInitiator true for the 2nd peer (got "ready"); it creates
   *        the transceivers, the data channel, and the first offer.
   */
  start(isInitiator) {
    this.isInitiator = isInitiator;
    this.polite = !isInitiator; // initiator is impolite; first peer is polite
    this.closed = false;

    const pc = new RTCPeerConnection({ iceServers: CONFIG.ICE_SERVERS });
    this.pc = pc;

    // Relay our ICE candidates (and end-of-candidates, candidate === null).
    pc.onicecandidate = ({ candidate }) => {
      this.signaling.signal({ kind: "ice", candidate });
    };

    // Implicit (re)negotiation entry point. setLocalDescription() with no args
    // creates the right SDP (offer or answer) for the current signalingState.
    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        this.signaling.signal({ kind: "offer", sdp: pc.localDescription });
      } catch (err) {
        console.error("onnegotiationneeded:", err);
      } finally {
        this.makingOffer = false;
      }
    };

    // Remote media arrives here. With 4 pre-allocated transceivers, ontrack
    // fires ~4 times at connect (tracks initially muted). We route by role =
    // transceiver index. The app attaches the track to the right element and
    // watches mute/unmute as a secondary signal to the explicit control msgs.
    pc.ontrack = (event) => {
      const role = this._roleOfTransceiver(event.transceiver);
      if (!role) return;
      const track = event.track;
      this._emit("remote-track", {
        role,
        track,
        stream: event.streams[0] || null,
      });
      track.addEventListener("mute", () =>
        this._emit("remote-track-muted", { role, track })
      );
      track.addEventListener("unmute", () =>
        this._emit("remote-track-unmuted", { role, track })
      );
    };

    pc.onconnectionstatechange = () => this._onConnectionStateChange();

    if (isInitiator) {
      // Data channel BEFORE transceivers/offer so its m-line is in the first SDP.
      this._setupDataChannel(pc.createDataChannel("app", { ordered: true }));

      // Pre-allocate all four transceivers synchronously in ONE tick so only a
      // single negotiation results (onnegotiationneeded coalesces).
      for (const role of ROLE_ORDER) {
        pc.addTransceiver(KIND_FOR_ROLE[role], { direction: "sendrecv" });
      }
      // onnegotiationneeded now fires → creates and sends the offer.
    } else {
      // Answerer receives the data channel.
      pc.ondatachannel = (e) => this._setupDataChannel(e.channel);
    }

    return this;
  }

  _roleOfTransceiver(transceiver) {
    // A queued ontrack can fire after close() nulls pc — guard against it.
    if (!this.pc) return null;
    const idx = this.pc.getTransceivers().indexOf(transceiver);
    return idx >= 0 && idx < ROLE_ORDER.length ? ROLE_ORDER[idx] : null;
  }

  _transceiverForRole(role) {
    const idx = ROLE_ORDER.indexOf(role);
    const transceivers = this.pc?.getTransceivers() || [];
    return idx >= 0 && idx < transceivers.length ? transceivers[idx] : null;
  }

  // --- signaling (perfect-negotiation guard) -------------------------------
  async _handleSignal(data) {
    if (!this.pc || this.closed) return;
    const pc = this.pc;
    try {
      if (data.kind === "offer" || data.kind === "answer") {
        const offerCollision =
          data.kind === "offer" &&
          (this.makingOffer || pc.signalingState !== "stable");

        this.ignoreOffer = !this.polite && offerCollision;
        if (this.ignoreOffer) return; // impolite peer wins; drop their offer

        await pc.setRemoteDescription(data.sdp);
        // remoteDescription now exists → flush any candidates that raced ahead.
        await this._drainPendingCandidates();

        if (data.kind === "offer") {
          // Symmetric media: make sure every transceiver can SEND, so our answer
          // is sendrecv and the peer knows we may share too. Set before creating
          // the answer so it's reflected in this same negotiation (no extra round).
          this._ensureSendrecv();
          await pc.setLocalDescription(); // implicit createAnswer
          this.signaling.signal({ kind: "answer", sdp: pc.localDescription });
        }
      } else if (data.kind === "ice") {
        // Until remoteDescription is set, addIceCandidate() throws and the
        // candidate is lost. Buffer early candidates and drain them once the
        // description lands (see _drainPendingCandidates above).
        if (!pc.remoteDescription || !pc.remoteDescription.type) {
          if (data.candidate) this._pendingCandidates.push(data.candidate);
          return;
        }
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (err) {
          // A candidate can fail if we discarded a colliding offer — that's
          // expected; only surface real errors.
          if (!this.ignoreOffer) console.warn("addIceCandidate:", err);
        }
      } else if (data.kind === "please-restart") {
        // Only the initiator actually performs the restart (avoids both peers
        // restarting at once).
        if (this.isInitiator) this.restartIce();
      }
    } catch (err) {
      console.error("_handleSignal:", err);
    }
  }

  _ensureSendrecv() {
    for (const t of this.pc.getTransceivers()) {
      if (t.direction !== "sendrecv") {
        try {
          t.direction = "sendrecv";
        } catch (_err) {
          /* transceiver may be stopped; ignore */
        }
      }
    }
  }

  /** Apply (and clear) any ICE candidates buffered before remoteDescription. */
  async _drainPendingCandidates() {
    if (!this.pc || !this._pendingCandidates.length) return;
    const queued = this._pendingCandidates.splice(0);
    for (const candidate of queued) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (err) {
        if (!this.ignoreOffer) console.warn("addIceCandidate (drained):", err);
      }
    }
  }

  // --- connection state / reconnect ----------------------------------------
  _onConnectionStateChange() {
    const state = this.pc.connectionState;
    this._emit("connection-state", state);

    if (state === "connected") {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    } else if (state === "disconnected") {
      // Often transient (Wi-Fi roam). Give it a few seconds to self-heal before
      // forcing a restart.
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = setTimeout(() => {
        if (this.pc && this.pc.connectionState === "disconnected") {
          this._recover();
        }
      }, 5000);
    } else if (state === "failed") {
      this._recover();
    }
  }

  _recover() {
    if (this.closed || !this.pc) return;
    if (this.isInitiator) {
      this.restartIce();
    } else {
      // Ask the initiator to drive the restart.
      this.signaling.signal({ kind: "please-restart" });
    }
  }

  restartIce() {
    if (this.closed || !this.pc) return;
    try {
      this.pc.restartIce(); // marks negotiation-needed with an ICE restart
    } catch (err) {
      console.warn("restartIce:", err);
    }
  }

  // --- local track management (replaceTrack — no renegotiation) ------------
  /**
   * Attach (or clear, if track is null) a local track for a role.
   * @param {string} role one of ROLE_ORDER
   * @param {MediaStreamTrack|null} track
   */
  async setLocalTrack(role, track) {
    const transceiver = this._transceiverForRole(role);
    if (!transceiver) return;
    try {
      await transceiver.sender.replaceTrack(track);
    } catch (err) {
      console.error(`replaceTrack(${role}):`, err);
      return;
    }
    if (track && role === "screen-video") {
      this._applyScreenTuning();
    } else if (track && role === "webcam") {
      this._applySenderBitrate(transceiver.sender, CONFIG.WEBCAM_MAX_BITRATE);
    }
  }

  /** Set the per-share content mode ('detail' | 'motion') and re-tune. */
  setScreenMode(mode) {
    if (CONFIG.SCREEN_MODES[mode]) {
      this.screenMode = mode;
      this._applyScreenTuning();
    }
  }

  /** Set the quality cap key ('1080p' | '720p' | '480p') and re-tune. */
  setQualityCap(cap) {
    if (CONFIG.QUALITY_CAPS[cap]) {
      this.qualityCap = cap;
      this._applyScreenTuning();
    }
  }

  async _applyScreenTuning() {
    const transceiver = this._transceiverForRole("screen-video");
    const sender = transceiver?.sender;
    const track = sender?.track;
    if (!sender || !track) return;

    const mode = CONFIG.SCREEN_MODES[this.screenMode] || CONFIG.SCREEN_MODES.detail;
    const cap = CONFIG.QUALITY_CAPS[this.qualityCap] || CONFIG.QUALITY_CAPS["1080p"];

    // contentHint lives on the TRACK. 'detail' = sharp text (hold resolution);
    // 'motion' = smooth video (hold framerate).
    try {
      track.contentHint = mode.contentHint;
    } catch (_err) {
      /* older browsers may not support; ignore */
    }

    // Cap resolution height via the live track constraints when possible.
    try {
      await track.applyConstraints({ height: { max: cap.maxHeight } });
    } catch (_err) {
      /* some sources reject applyConstraints; bitrate cap still applies */
    }

    // Bitrate + degradation preference via read-modify-write of sender params.
    const bitrate = Math.min(mode.maxBitrate, cap.maxBitrate);
    await this._applySenderBitrate(sender, bitrate, mode.degradationPreference);
  }

  /**
   * Read-modify-write sender params to set maxBitrate (and optionally
   * degradationPreference). Must be done AFTER a track exists, and we must NOT
   * fabricate the encodings array from scratch — read what's there first.
   */
  async _applySenderBitrate(sender, maxBitrate, degradationPreference) {
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.encodings[0].maxBitrate = maxBitrate;
      if (degradationPreference) {
        params.degradationPreference = degradationPreference;
      }
      await sender.setParameters(params);
    } catch (err) {
      console.warn("setParameters (bitrate):", err);
    }
  }

  // --- data channel --------------------------------------------------------
  _setupDataChannel(channel) {
    this.dc = channel;
    channel.onopen = () => this._emit("datachannel-open");
    channel.onclose = () => this._emit("datachannel-close");
    channel.onmessage = (e) => {
      let obj;
      try {
        obj = JSON.parse(e.data);
      } catch (_err) {
        return;
      }
      this._emit("data", obj);
    };
  }

  /** Send a small JSON app message to the peer. Returns true if it went out. */
  sendData(obj) {
    if (this.dc && this.dc.readyState === "open") {
      try {
        this.dc.send(JSON.stringify(obj));
        return true;
      } catch (err) {
        console.warn("dc.send:", err);
      }
    }
    return false;
  }

  // --- stats (for the quality dot + optional stats overlay) ----------------
  /**
   * Summarize live stats from the screen-video sender + the inbound that's
   * currently flowing. Returns {rtt, sendBitrate, recvBitrate, fps, width,
   * height, packetLossPct} — fields may be null if unavailable.
   */
  async getStatsSummary() {
    if (!this.pc) return null;
    const now = performance.now();
    let report;
    try {
      report = await this.pc.getStats();
    } catch (_err) {
      return null;
    }

    const out = {
      rtt: null,
      sendBitrate: null,
      recvBitrate: null,
      fps: null,
      width: null,
      height: null,
      packetLossPct: null,
    };

    // There can be TWO video streams in each direction (screen + webcam), so we
    // must SUM bytes/packets across them — overwriting with whichever stat
    // iterates last would compare different streams tick-to-tick and corrupt the
    // bitrate/loss math. For fps/resolution we keep the largest-area video
    // (the shared screen, not the small webcam) since that's the headline figure.
    let outBytes = null;
    let inBytes = null;
    let pktRecv = 0;
    let pktLost = 0;
    let havePkt = false;
    let bestArea = -1;
    report.forEach((s) => {
      if (s.type === "candidate-pair" && s.state === "succeeded" && s.nominated) {
        if (typeof s.currentRoundTripTime === "number") {
          out.rtt = Math.round(s.currentRoundTripTime * 1000); // ms
        }
      } else if (s.type === "outbound-rtp" && s.kind === "video") {
        if (typeof s.bytesSent === "number") outBytes = (outBytes || 0) + s.bytesSent;
        if (typeof s.framesPerSecond === "number") out.fps = Math.max(out.fps ?? 0, s.framesPerSecond);
      } else if (s.type === "inbound-rtp" && s.kind === "video") {
        if (typeof s.bytesReceived === "number") inBytes = (inBytes || 0) + s.bytesReceived;
        if (s.packetsReceived != null && s.packetsLost != null) {
          pktRecv += s.packetsReceived;
          pktLost += s.packetsLost;
          havePkt = true;
        }
      } else if (s.type === "track" && s.kind === "video" && s.frameWidth) {
        const area = s.frameWidth * (s.frameHeight || 1);
        if (area > bestArea) {
          bestArea = area;
          out.width = s.frameWidth;
          out.height = s.frameHeight;
        }
      }
    });
    out._outBytes = outBytes;
    out._inBytes = inBytes;
    if (havePkt) {
      const total = pktRecv + pktLost;
      out.packetLossPct = total ? (pktLost / total) * 100 : 0;
    }

    // Compute bitrate deltas against the previous sample.
    if (this._lastStats) {
      const dt = (now - this._lastStats.t) / 1000;
      if (dt > 0) {
        if (out._outBytes != null && this._lastStats.outBytes != null) {
          out.sendBitrate = Math.max(
            0,
            Math.round(((out._outBytes - this._lastStats.outBytes) * 8) / dt)
          );
        }
        if (out._inBytes != null && this._lastStats.inBytes != null) {
          out.recvBitrate = Math.max(
            0,
            Math.round(((out._inBytes - this._lastStats.inBytes) * 8) / dt)
          );
        }
      }
    }
    this._lastStats = {
      t: now,
      outBytes: out._outBytes,
      inBytes: out._inBytes,
    };
    delete out._outBytes;
    delete out._outTs;
    delete out._inBytes;
    delete out._inTs;
    return out;
  }

  // --- teardown ------------------------------------------------------------
  close() {
    this.closed = true;
    this._pendingCandidates = [];
    clearTimeout(this.disconnectTimer);
    // Unsubscribe from the shared Signaling instance (see constructor) so a
    // closed RTC stops receiving relayed payloads and doesn't leak.
    if (this._onSignal) {
      this.signaling.off("signal", this._onSignal);
      this._onSignal = null;
    }
    try {
      this.dc?.close();
    } catch (_err) {
      /* ignore */
    }
    try {
      this.pc?.close();
    } catch (_err) {
      /* ignore */
    }
    this.dc = null;
    this.pc = null;
  }
}
