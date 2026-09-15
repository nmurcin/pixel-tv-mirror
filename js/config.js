// ===========================================================================
// config.js — THE one place you edit to wire up the app.
//
// After you deploy the signaling server (see README), paste its wss:// URL into
// SIGNALING_URL below. Everything else has sane defaults you can leave alone.
// ===========================================================================

export const CONFIG = {
  // -------------------------------------------------------------------------
  // 1) SIGNALING SERVER URL  ◀── THE MAIN THING YOU MUST SET
  // -------------------------------------------------------------------------
  // After deploying server/ to Render, you get a URL like:
  //     https://watch-together-xxxx.onrender.com
  // Use it here with the wss:// scheme (secure WebSocket), NOT https://:
  //     SIGNALING_URL: "wss://watch-together-xxxx.onrender.com"
  //
  // Leave the localhost default only if you're running the Node server yourself
  // (you need Node installed for that — see README "Running the server locally").
  SIGNALING_URL: "wss://watch-together-signal.onrender.com",

  // -------------------------------------------------------------------------
  // 2) ICE SERVERS — how peers find a path to each other across NATs.
  // -------------------------------------------------------------------------
  ICE_SERVERS: [
    // Google's free public STUN server. STUN just tells each peer its own
    // public IP:port so they can try a direct connection. No account needed.
    { urls: "stun:stun.l.google.com:19302" },

    // ----- TURN (OPTIONAL — fill in LATER only if a connection ever FAILS) ---
    // TURN relays the media through a server when a direct P2P path can't be
    // punched through (happens for ~10-20% of network pairs, e.g. both behind
    // strict/symmetric NATs or corporate firewalls). It is NOT needed for the
    // MVP and costs money/bandwidth, so it's left empty. If your cross-network
    // test (README test B) won't connect and chrome://webrtc-internals shows
    // ICE stuck at "checking", add a TURN entry here. See README "Adding TURN".
    //
    // Example (Open Relay / Metered free tier or your own coturn):
    // {
    //   urls: ["turn:your-turn-host:3478?transport=udp",
    //          "turn:your-turn-host:3478?transport=tcp"],
    //   username: "YOUR_TURN_USERNAME",
    //   credential: "YOUR_TURN_CREDENTIAL",
    // },
  ],

  // -------------------------------------------------------------------------
  // 3) MEDIA TUNING — reasonable 1080p defaults. Most people never touch these.
  // -------------------------------------------------------------------------

  // Screen capture request. frameRate is a ceiling; the encoder spends bitrate
  // differently depending on the per-share content mode (motion vs detail).
  SCREEN_CONSTRAINTS: {
    video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } },
    audio: true, // requested; may yield no track for window/full-screen shares (see README)
  },

  // Per-share content modes (chosen at share time). 'detail' keeps text crisp
  // by holding resolution and dropping frames; 'motion' keeps video smooth.
  SCREEN_MODES: {
    detail: { contentHint: "detail", degradationPreference: "maintain-resolution", maxBitrate: 8_000_000 },
    motion: { contentHint: "motion", degradationPreference: "maintain-framerate", maxBitrate: 10_000_000 },
  },
  DEFAULT_SCREEN_MODE: "detail",

  // Webcam capture. Kept modest — it's a small PiP, not the main event.
  WEBCAM_CONSTRAINTS: {
    video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } },
    audio: false, // mic is captured separately so you can talk without showing your face
  },
  WEBCAM_MAX_BITRATE: 800_000,

  // Microphone capture. Echo cancellation default-on is overridable in Settings
  // (see DEFAULT_SETTINGS.echoCancellation); ui.js merges the live setting in.
  MIC_CONSTRAINTS: {
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  },

  // Resolution/bitrate cap options exposed in Settings (dial down on weak links).
  QUALITY_CAPS: {
    "1080p": { maxHeight: 1080, maxBitrate: 10_000_000 },
    "720p": { maxHeight: 720, maxBitrate: 4_000_000 },
    "480p": { maxHeight: 480, maxBitrate: 1_500_000 },
  },
  DEFAULT_QUALITY_CAP: "1080p",

  // -------------------------------------------------------------------------
  // 4) SIGNALING RECONNECT — handles Render free-tier cold starts gracefully.
  // -------------------------------------------------------------------------
  // Render spins the server down after ~15 min idle; the next connect cold-starts
  // for ~30-60s, so the FIRST WebSocket attempt after idle often times out. We
  // retry with backoff and show "waking server…" instead of erroring. Don't
  // lower COLD_START_GRACE_MS below ~60s or you'll give up before it wakes.
  RECONNECT: {
    BASE_DELAY_MS: 1000, // first retry after 1s
    MAX_DELAY_MS: 8000, // cap backoff at 8s between tries
    COLD_START_GRACE_MS: 75_000, // keep trying this long before declaring failure
  },

  // -------------------------------------------------------------------------
  // 5) DEFAULT SETTINGS — initial values for the in-app Settings menu. These are
  // overridden by whatever the user saves to localStorage; they're just the
  // first-run defaults.
  // -------------------------------------------------------------------------
  DEFAULT_SETTINGS: {
    chatFadeSeconds: 8, // fullscreen corner chat: fade a line this long after it arrives
    chatPinnedCount: 0, // permanently keep last N messages bottom-right (0 = none, pure fade)
    chatTextSize: 15, // px
    accentColor: "#5b9dff", // theme accent
    mirrorSelfView: true, // your own PiP shows mirrored (peer always sees you un-mirrored)
    qualityCap: "1080p", // see QUALITY_CAPS
    echoCancellation: true, // mic processing; turn off for hi-fi audio + headphones
    peerJoinSound: false, // soft sound when peer connects/disconnects
    showStatsOverlay: false, // detailed getStats panel on top of the simple status dot
    idleHideMs: 3000, // ms of no mouse movement before control bar + cursor hide
  },
};

// localStorage keys (centralized so nothing else hardcodes string keys).
export const STORAGE_KEYS = {
  ROOM_CODE: "wt.roomCode", // your fixed personal room code
  DISPLAY_NAME: "wt.displayName", // name set on join
  SETTINGS: "wt.settings", // JSON blob of the Settings menu state
  CHAT_HISTORY: "wt.chat", // per-room chat persistence (keyed with room code suffix)
  PIP_LAYOUT: "wt.pip", // remembered drag/resize position+size of each PiP
  // sessionStorage (per-tab, survives reload): stable identity so the server can
  // tell a reconnecting peer apart from a third device and reap its own ghost.
  PEER_ID: "wt.peerId",
};

// The only emoji that float as reactions. A closed set keeps received reactions
// safe/bounded (we ignore anything not in here) and the picker tidy.
export const REACTIONS = ["❤️", "😂", "😮", "👏", "🔥"];
