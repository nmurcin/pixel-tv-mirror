// ===========================================================================
// signaling.js — WebSocket client for the signaling relay.
//
// Responsibilities:
//   - Connect to CONFIG.SIGNALING_URL, surviving Render free-tier cold starts
//     (retry with backoff, emit "waking" so the UI can say "waking server…").
//   - Perform the join handshake and tell the app its role:
//       "joined"      → you are first; wait for a peer.
//       "ready"       → you are second; you are the WebRTC initiator (make offer).
//       "peer-joined" → (to the first peer) your partner arrived.
//       "peer-left"   → your partner disconnected.
//       "room-full"   → a third device tried to join your room.
//   - Relay opaque client↔client payloads (SDP/ICE/control) via `signal`.
//   - Auto-reconnect the WS INDEPENDENTLY of the media PC. A signaling blip must
//     never tear down a healthy peer connection — they live and die separately.
//
// It is a thin event emitter; rtc.js and ui.js subscribe via .on(event, fn).
// ===========================================================================

import { CONFIG } from "./config.js";

export class Signaling {
  constructor(roomCode, peerId) {
    this.roomCode = roomCode;
    // Stable per-tab identity repeated on every (re)join so the server can tell
    // a returning peer apart from a third device and reap our own stale ghost
    // (see server/index.js join handler). Null is fine (server just skips reclaim).
    this.peerId = peerId || null;
    this.ws = null;
    this.listeners = new Map(); // event name -> Set<fn>
    this.intentionalClose = false; // true when WE chose to close (don't reconnect)
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.firstConnectStarted = 0; // timestamp of the first connect attempt (cold-start grace)
    this.hasEverOpened = false; // distinguishes "cold start" from "lost an established link"
  }

  // --- tiny event emitter --------------------------------------------------
  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return this;
  }
  off(event, fn) {
    this.listeners.get(event)?.delete(fn);
    return this;
  }
  _emit(event, payload) {
    this.listeners.get(event)?.forEach((fn) => {
      try {
        fn(payload);
      } catch (err) {
        // A listener throwing must not kill the socket pump.
        console.error(`signaling listener for "${event}" threw:`, err);
      }
    });
  }

  // --- connection lifecycle ------------------------------------------------
  connect() {
    this.intentionalClose = false;
    if (!this.firstConnectStarted) this.firstConnectStarted = Date.now();
    this._open();
    return this;
  }

  _open() {
    let ws;
    try {
      ws = new WebSocket(CONFIG.SIGNALING_URL);
    } catch (err) {
      // Malformed URL (e.g. config not filled in) — surface clearly, don't loop.
      this._emit("error", {
        fatal: true,
        message:
          "Could not open the signaling connection. Check SIGNALING_URL in js/config.js — it should look like wss://your-service.onrender.com",
        detail: String(err),
      });
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.hasEverOpened = true;
      this.reconnectAttempts = 0;
      this.firstConnectStarted = 0;
      this._emit("open");
      // (Re)join our room as soon as the socket is up. On a reconnect this is a
      // brand-new socket, so the server re-pairs us and (via peerId) reaps our
      // old ghost. A true same-socket duplicate join would get an "already-joined"
      // reply, which the client simply ignores (no handler → default case).
      this.send({ type: "join", room: this.roomCode, peerId: this.peerId });
    };

    ws.onmessage = (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch (_err) {
        return;
      }
      if (!msg || typeof msg.type !== "string") return;

      switch (msg.type) {
        case "joined":
          this._emit("joined"); // first occupant → wait
          break;
        case "ready":
          this._emit("ready"); // second occupant → you initiate
          break;
        case "peer-joined":
          this._emit("peer-joined"); // your partner arrived
          break;
        case "peer-left":
          this._emit("peer-left"); // your partner disconnected
          break;
        case "room-full":
          // Don't reconnect into a full room — that would just bounce.
          this.intentionalClose = true;
          this._emit("room-full");
          break;
        case "signal":
          this._emit("signal", msg.data); // opaque client↔client payload
          break;
        default:
          break;
      }
    };

    ws.onerror = () => {
      // onerror is always followed by onclose; do the real handling there.
    };

    ws.onclose = () => {
      this.ws = null;
      if (this.intentionalClose) return;
      this._scheduleReconnect();
    };
  }

  _scheduleReconnect() {
    const { BASE_DELAY_MS, MAX_DELAY_MS, COLD_START_GRACE_MS } = CONFIG.RECONNECT;

    // If we've NEVER opened and we're still inside the cold-start grace window,
    // this is almost certainly Render waking up. Tell the UI to say "waking
    // server…" rather than "connection failed".
    const withinColdStartGrace =
      !this.hasEverOpened &&
      this.firstConnectStarted &&
      Date.now() - this.firstConnectStarted < COLD_START_GRACE_MS;

    if (!this.hasEverOpened && !withinColdStartGrace) {
      // Cold-start grace exhausted without ever connecting → genuine failure.
      this._emit("error", {
        fatal: true,
        message:
          "Couldn't reach the signaling server. If you just opened the app, the free Render server may still be waking up — wait a moment and reload. Otherwise check SIGNALING_URL in js/config.js.",
      });
      return;
    }

    const delay = Math.min(
      BASE_DELAY_MS * 2 ** this.reconnectAttempts,
      MAX_DELAY_MS
    );
    this.reconnectAttempts += 1;

    // Emit a status so the UI can show the right message. "waking" = cold start
    // (never connected yet); "reconnecting" = we had a link and lost it.
    this._emit("reconnecting", {
      phase: this.hasEverOpened ? "reconnecting" : "waking",
      attempt: this.reconnectAttempts,
      delay,
    });

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this._open(), delay);
  }

  /** Send a raw message object to the server. Returns true if it went out. */
  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  /** Relay an opaque payload to the other peer via the server. */
  signal(data) {
    return this.send({ type: "signal", room: this.roomCode, data });
  }

  /** Cleanly leave: tell the server, stop reconnecting, close the socket. */
  close() {
    this.intentionalClose = true;
    clearTimeout(this.reconnectTimer);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({ type: "bye", room: this.roomCode });
    }
    try {
      this.ws?.close();
    } catch (_err) {
      /* ignore */
    }
    this.ws = null;
  }
}
