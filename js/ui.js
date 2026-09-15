// ===========================================================================
// ui.js — the orchestrator. Wires signaling ↔ rtc ↔ media ↔ chat ↔ pip and owns
// all DOM/state. This is the only module with knowledge of the whole app; the
// others are deliberately dumb and reusable.
//
// Big pieces, in order:
//   1. Room code + settings (localStorage)
//   2. Lobby → enter room
//   3. Signaling/RTC bring-up (deterministic initiator from server roles)
//   4. Data-channel app protocol (profile / share / cam / chat)
//   5. Local media toggles (share / camera / mic / shared-audio) with permission
//   6. Remote media routing (by transceiver role)
//   7. Stage state machine: screen > video-call > share-prompt
//   8. Fullscreen + fading corner chat, auto-hide cursor/bar, wake lock
//   9. Status dot + optional stats overlay, keyboard shortcuts
// ===========================================================================

import { CONFIG, STORAGE_KEYS, REACTIONS } from "./config.js";
import { Signaling } from "./signaling.js";
import { RTC, ROLE_ORDER } from "./rtc.js";
import { Chat } from "./chat.js";
import { PipOverlay } from "./pip.js";
import {
  captureScreen,
  captureWebcam,
  captureMic,
  listDevices,
  stopStream,
} from "./media.js";

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// App-level singleton state
// ---------------------------------------------------------------------------
const state = {
  roomCode: null,
  peerId: null,
  displayName: "",
  peerName: "Peer",
  settings: { ...CONFIG.DEFAULT_SETTINGS },

  signaling: null,
  rtc: null,
  connected: false,

  // local media (each null when off)
  localScreen: null, // { stream, videoTrack, audioTrack, hasAudio, mode }
  localWebcam: null, // MediaStream
  localMic: null, // MediaStream

  // peer published state (from data channel)
  peerSharing: false,
  peerHasShareAudio: false,
  peerCam: false,

  // remote tracks by role (filled from rtc 'remote-track')
  remote: { "screen-video": null, "screen-audio": null, webcam: null, mic: null },

  hideSelf: false,
  shareAudioMuted: false,
  chatOutbox: [], // chat lines typed before the data channel was open; flushed on open
  chatVisible: true,
  isFullscreen: false,
  wakeLock: null,
  idleTimer: null,
  statsTimer: null,
  audioCtx: null,
};

let selfPip = null;
let peerPip = null;
let chat = null;
let remoteMicAudio = null; // hidden <audio> for peer's voice
let countdownTimer = null; // drives the visual 3-2-1 overlay
let countdownInviteActive = false; // we've SENT a countdown invite, awaiting accept
let countdownInviteTimer = null; // expiry for an unanswered invite we sent
let countdownPromptTimer = null; // auto-dismiss for an invite we RECEIVED (the card)
let countdownBeeps = []; // oscillators scheduled for the current countdown (so we can stop them)
const COUNTDOWN_INVITE_TTL_MS = 15000; // sender: give up on an ignored invite after this
// Invitee: auto-dismiss the received "ready?" card SOONER than the sender gives up.
// The invitee's timer starts when the invite ARRIVES (one-way latency after the
// sender armed its own), so a shorter window guarantees the card closes before the
// sender's invite expires — closing the race where a late "Ready!" click (after the
// sender already gave up) would start a one-sided countdown. The 3s margin dwarfs any
// usable connection's latency.
const COUNTDOWN_PROMPT_TTL_MS = 12000;

// ===========================================================================
// 1. Room code + settings
// ===========================================================================
function genRoomCode() {
  // 18 random url-safe chars (~107 bits) — effectively unguessable, which is the
  // access control for a public URL + dumb relay.
  const bytes = new Uint8Array(14);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/[+/=]/g, "")
    .slice(0, 18);
}

function resolvePeerId() {
  // Stable per-tab identity (survives reload + WS reconnects within this tab,
  // but differs across tabs). The server uses it to recognise us reconnecting
  // and reap our own stale ghost socket, while a genuine second tab/3rd device
  // gets a different id and is correctly told the room is full.
  let id = sessionStorage.getItem(STORAGE_KEYS.PEER_ID);
  if (!id) {
    id = genRoomCode() + genRoomCode(); // ~214 bits, plenty
    try {
      sessionStorage.setItem(STORAGE_KEYS.PEER_ID, id);
    } catch (_err) {
      /* sessionStorage disabled — id stays in-memory for this page load */
    }
  }
  return id;
}

function resolveRoomCode() {
  // Precedence: URL hash (invitee opened a shared link) > stored personal room >
  // freshly generated. Whatever we land on is written back to the hash so the
  // invite link is always shareable from the address bar.
  const hash = new URLSearchParams(location.hash.slice(1));
  let code = hash.get("room");
  if (!code) {
    code = localStorage.getItem(STORAGE_KEYS.ROOM_CODE) || genRoomCode();
  }
  localStorage.setItem(STORAGE_KEYS.ROOM_CODE, code);
  // Reflect into the hash without adding a history entry.
  const url = `${location.origin}${location.pathname}#room=${code}`;
  history.replaceState(null, "", url);
  return code;
}

function inviteLink() {
  return `${location.origin}${location.pathname}#room=${state.roomCode}`;
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEYS.SETTINGS));
    state.settings = { ...CONFIG.DEFAULT_SETTINGS, ...(saved || {}) };
  } catch (_err) {
    state.settings = { ...CONFIG.DEFAULT_SETTINGS };
  }
}
function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(state.settings));
  } catch (_err) {
    /* ignore */
  }
}
function applySettings() {
  const s = state.settings;
  document.documentElement.style.setProperty("--accent", s.accentColor);
  document.documentElement.style.setProperty("--idle-fade", "0.35s");
  if (selfPip) selfPip.setMirrored(s.mirrorSelfView);
  $("callVideoSelf").classList.toggle("mirrored", s.mirrorSelfView);
  if (chat) chat.applySettings();
  // stats overlay visibility
  $("statsOverlay").classList.toggle("hidden", !s.showStatsOverlay);
  // re-apply quality cap / echo to live media
  if (state.rtc) state.rtc.setQualityCap(s.qualityCap);
}

// ===========================================================================
// 2. Lobby → enter room
// ===========================================================================
function initLobby() {
  state.roomCode = resolveRoomCode();
  state.peerId = resolvePeerId();
  loadSettings();

  const storedName = localStorage.getItem(STORAGE_KEYS.DISPLAY_NAME) || "";
  $("nameInput").value = storedName;
  $("inviteLink").value = inviteLink();

  $("copyInviteBtn").addEventListener("click", () => copyText(inviteLink(), $("copyInviteBtn")));
  $("joinBtn").addEventListener("click", enterRoom);
  $("nameInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") enterRoom();
  });
}

function enterRoom() {
  const name = $("nameInput").value.trim() || "Guest";
  state.displayName = name;
  localStorage.setItem(STORAGE_KEYS.DISPLAY_NAME, name);

  // Create the AudioContext now, on a user gesture, so notification beeps and
  // remote-audio autoplay are unblocked for the rest of the session.
  try {
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (_err) {
    /* no audio context — beeps just won't play */
  }

  $("lobby").classList.add("hidden");
  $("app").classList.remove("hidden");

  initAppDom();
  applySettings();
  connectSignaling();
}

// ===========================================================================
// 3. Signaling / RTC bring-up
// ===========================================================================
function connectSignaling() {
  const sig = new Signaling(state.roomCode, state.peerId);
  state.signaling = sig;

  sig.on("joined", () => setStatusBanner("Waiting for your peer to join… share the invite link.", true));
  sig.on("reconnecting", ({ phase }) => {
    setStatusBanner(
      phase === "waking"
        ? "Waking up the server (free tier sleeps when idle)… this can take up to a minute."
        : "Reconnecting to the server…",
      true
    );
  });
  sig.on("room-full", () => {
    setStatusBanner("This room already has two people. Only two can connect at once.", true);
    showToast("Room is full — two people are already connected.", "error", 6000);
  });
  sig.on("error", ({ message }) => {
    setStatusBanner(message, true);
    showToast(message, "error", 8000);
  });

  // Role assignment → who creates the offer.
  sig.on("ready", () => startRtc(true)); // we're 2nd → initiator
  sig.on("peer-joined", () => startRtc(false)); // we're 1st, peer arrived → answerer
  sig.on("peer-left", onPeerLeft);

  sig.connect();
}

function startRtc(isInitiator) {
  // Fresh PC each time (covers first connect and full rejoin after peer-left).
  if (state.rtc) state.rtc.close();
  setStatusBanner("Connecting…", true);

  const rtc = new RTC(state.signaling);
  state.rtc = rtc;
  rtc.setQualityCap(state.settings.qualityCap);

  rtc.on("connection-state", onConnectionState);
  rtc.on("datachannel-open", onDataChannelOpen);
  rtc.on("data", onPeerData);
  rtc.on("remote-track", onRemoteTrack);
  rtc.on("remote-track-unmuted", () => updateStage());
  rtc.on("remote-track-muted", () => updateStage());

  rtc.start(isInitiator);

  // Re-attach any locally-active media to the new PC (after a rejoin the senders
  // are empty again). For the INITIATOR the 4 transceivers exist synchronously
  // after start(), so we can reattach now. For the ANSWERER they don't exist
  // until the offer is processed — so the authoritative reattach happens in
  // onConnectionState('connected'), by which point transceivers exist on both
  // sides. replaceTrack needs no renegotiation and is idempotent, so doing it
  // in both places is safe.
  if (isInitiator) reattachLocalMedia();
}

async function reattachLocalMedia() {
  if (!state.rtc) return;
  if (state.localScreen) {
    state.rtc.setScreenMode(state.localScreen.mode); // set mode before track → one tuning pass
    await state.rtc.setLocalTrack("screen-video", state.localScreen.videoTrack);
    if (state.localScreen.audioTrack)
      await state.rtc.setLocalTrack("screen-audio", state.localScreen.audioTrack);
  }
  if (state.localWebcam) await state.rtc.setLocalTrack("webcam", state.localWebcam.getVideoTracks()[0]);
  if (state.localMic) await state.rtc.setLocalTrack("mic", state.localMic.getAudioTracks()[0]);
}

function onConnectionState(cs) {
  if (cs === "connected") {
    state.connected = true;
    setStatusBanner("", false);
    setStatusDot("ok", "Connected");
    acquireWakeLock();
    startStatsLoop();
    // Authoritative media reattach: transceivers exist on both peers by now, so
    // this restores any locally-active screen/cam/mic onto the (possibly fresh)
    // peer connection — covers the answerer-rejoin case where the synchronous
    // reattach in startRtc() was skipped. Idempotent (replaceTrack).
    reattachLocalMedia();
    // NOTE: profile/share/cam are published by onDataChannelOpen (the single
    // owner), NOT here — publishing in both places double-sent every control
    // message on connect (and a duplicate "is sharing" toast). The data channel
    // is open by the time we're 'connected', so onDataChannelOpen has fired.
  } else if (cs === "connecting" || cs === "new") {
    setStatusDot("warn", "Connecting…");
  } else if (cs === "disconnected") {
    setStatusDot("warn", "Network hiccup — trying to recover…");
    setStatusBanner("Connection interrupted — trying to recover…", true);
  } else if (cs === "failed") {
    setStatusDot("bad", "Connection failed");
    setStatusBanner("Connection failed — attempting to reconnect…", true);
  } else if (cs === "closed") {
    state.connected = false;
    setStatusDot("", "Disconnected");
  }
}

// Clear everything we know about the peer and the media they were sending, and
// refresh the stage. Shared by peer-left and regenerate-room so the two paths
// can't drift. Resets peerName to the "Peer" sentinel so the next profile
// message is treated as a fresh connection (re-emits the "connected" line and
// avoids briefly showing the previous person's name).
function resetPeerState() {
  state.peerSharing = false;
  state.peerHasShareAudio = false;
  state.peerCam = false;
  state.peerName = "Peer";
  state.remote = { "screen-video": null, "screen-audio": null, webcam: null, mic: null };
  if (peerPip) {
    peerPip.setStream(null);
    peerPip.setLabel("Peer");
  }
  if (remoteMicAudio) remoteMicAudio.srcObject = null;
  $("callNamePeer").textContent = "Peer";
  // Cancel any in-flight countdown / invite (the other side is gone).
  clearCountdownInvite();
  hideCountdownPrompt();
  clearTimeout(countdownTimer);
  countdownTimer = null;
  stopCountdownBeeps();
  $("countdownOverlay")?.classList.add("hidden");
  updateStage();
}

function onPeerLeft() {
  showToast(`${state.peerName} left.`, "warn", 4000); // reads peerName BEFORE reset
  if (state.settings.peerJoinSound) beep(330);
  if (state.rtc) {
    state.rtc.close();
    state.rtc = null;
  }
  state.connected = false;
  const leftName = state.peerName;
  setStatusDot("", "Peer left");
  setStatusBanner("Your peer left. Waiting for them to rejoin…", true);
  releaseWakeLock();
  stopStatsLoop();
  chat?.addSystem(`${leftName} left.`); // uses captured name before reset
  resetPeerState();
}

// ===========================================================================
// 4. Data-channel app protocol
// ===========================================================================
function onDataChannelOpen() {
  if (state.settings.peerJoinSound) beep(660);
  publishProfile();
  publishShareState();
  publishCamState();
  flushChatOutbox(); // deliver anything typed before the channel was open
}

function publishProfile() {
  state.rtc?.sendData({ t: "profile", name: state.displayName });
}
function publishShareState() {
  state.rtc?.sendData({
    t: "share",
    on: !!state.localScreen,
    hasAudio: state.localScreen ? state.localScreen.hasAudio && !state.shareAudioMuted : false,
    mode: state.localScreen ? state.localScreen.mode : null,
  });
}
function publishCamState() {
  state.rtc?.sendData({ t: "cam", on: !!state.localWebcam });
}

function onPeerData(msg) {
  switch (msg.t) {
    case "profile": {
      const prev = state.peerName;
      state.peerName = msg.name || "Peer";
      $("callNamePeer").textContent = state.peerName;
      if (peerPip) peerPip.setLabel(state.peerName);
      if (prev === "Peer") chat?.addSystem(`${state.peerName} connected.`);
      break;
    }
    case "share":
      state.peerSharing = !!msg.on;
      state.peerHasShareAudio = !!msg.hasAudio;
      updateStage();
      if (msg.on) showToast(`${state.peerName} is sharing their screen.`, "", 2500);
      break;
    case "cam":
      state.peerCam = !!msg.on;
      updateStage();
      break;
    case "chat":
      chat?.addRemote(msg.text, state.peerName);
      // Tab-title unread is driven by Chat's 'chat-unread' event (fired from
      // addRemote when the panel isn't visible) → updateTabTitle. No extra call
      // needed here.
      break;
    case "reaction":
      showReaction(msg.emoji, /*fromPeer*/ true);
      break;
    case "countdown":
      onPeerCountdown(msg);
      break;
    default:
      break;
  }
}

// ===========================================================================
// 5. Local media toggles
// ===========================================================================

// --- screen share (with block-until-they-stop conflict policy) -------------
function onShareClick() {
  if (state.localScreen) {
    stopScreenShare();
    return;
  }
  // Conflict policy: if the peer is already sharing, block and tell the user.
  if (state.peerSharing) {
    showToast(`${state.peerName} is already sharing — ask them to stop first.`, "warn", 4000);
    return;
  }
  // Ask which content mode (motion vs detail), then capture.
  openShareModeModal();
}

async function beginShare(mode) {
  closeShareModeModal();
  const res = await captureScreen(() => stopScreenShare()); // onEnded = native "Stop sharing"
  if (!res.ok) {
    if (!res.cancelled) showToast(res.message, "error", 6000);
    return;
  }
  state.localScreen = {
    stream: res.stream,
    videoTrack: res.videoTrack,
    audioTrack: res.audioTrack,
    hasAudio: res.hasAudio,
    mode,
  };
  state.shareAudioMuted = false;

  // Set the mode FIRST (it just stores the mode while there's no track yet), so
  // the single tuning pass triggered by setLocalTrack already uses the right
  // mode/degradation-preference — instead of tuning for the default and then
  // re-tuning, which double-churned setParameters and briefly encoded wrong.
  state.rtc?.setScreenMode(mode);
  await state.rtc?.setLocalTrack("screen-video", res.videoTrack);
  if (res.audioTrack) await state.rtc?.setLocalTrack("screen-audio", res.audioTrack);

  if (res.warning) showToast(res.warning, "warn", 7000);
  setCtrlActive("shareBtn", true, "Stop");
  $("shareAudioBtn").classList.toggle("hidden", !res.hasAudio);
  publishShareState();
  updateStage();
}

function stopScreenShare() {
  if (!state.localScreen) return;
  stopStream(state.localScreen.stream);
  state.rtc?.setLocalTrack("screen-video", null);
  state.rtc?.setLocalTrack("screen-audio", null);
  state.localScreen = null;
  setCtrlActive("shareBtn", false, "Share");
  $("shareAudioBtn").classList.add("hidden");
  publishShareState();
  updateStage();
}

function toggleShareAudio() {
  if (!state.localScreen || !state.localScreen.audioTrack) return;
  state.shareAudioMuted = !state.shareAudioMuted;
  state.localScreen.audioTrack.enabled = !state.shareAudioMuted;
  setCtrlActive("shareAudioBtn", !state.shareAudioMuted, state.shareAudioMuted ? "Muted" : "Audio");
  $("shareAudioBtn").classList.toggle("danger-active", state.shareAudioMuted);
  publishShareState();
}

// --- camera ----------------------------------------------------------------
// Single camera-off teardown so every path (manual toggle AND a failed device
// switch) converges on the same clean state: device released, sender cleared,
// "Hide me" hidden, peer told, stage refreshed.
function teardownCamera() {
  stopStream(state.localWebcam); // safe on null
  state.localWebcam = null;
  state.rtc?.setLocalTrack("webcam", null);
  attachSelfStreams();
  setCtrlActive("camBtn", false, "Camera");
  $("hideSelfBtn").classList.add("hidden");
  publishCamState();
  updateStage();
}

// silent: suppress the internal error toast (used during a programmatic device
// switch so only the caller's contextual message shows — no double toast).
async function onCamClick(silent = false) {
  if (state.localWebcam) {
    teardownCamera();
    return;
  }
  const res = await captureWebcam(state.settings.cameraDeviceId);
  if (!res.ok) {
    if (!silent) showToast(res.message, "error", 6000);
    return;
  }
  state.localWebcam = res.stream;
  await state.rtc?.setLocalTrack("webcam", res.videoTrack);
  attachSelfStreams();
  setCtrlActive("camBtn", true, "Camera");
  $("hideSelfBtn").classList.remove("hidden");
  publishCamState();
  updateStage();
}

// --- microphone ------------------------------------------------------------
function teardownMic() {
  stopStream(state.localMic); // safe on null
  state.localMic = null;
  state.rtc?.setLocalTrack("mic", null);
  setCtrlActive("micBtn", false, "Mic");
}

async function onMicClick(silent = false) {
  if (state.localMic) {
    teardownMic();
    return;
  }
  const res = await captureMic(state.settings.micDeviceId, state.settings.echoCancellation);
  if (!res.ok) {
    if (!silent) showToast(res.message, "error", 6000);
    return;
  }
  state.localMic = res.stream;
  await state.rtc?.setLocalTrack("mic", res.audioTrack);
  setCtrlActive("micBtn", true, "Mic");
}

// --- hide own camera tile/PiP ----------------------------------------------
function toggleHideSelf() {
  state.hideSelf = !state.hideSelf;
  setCtrlActive("hideSelfBtn", state.hideSelf, state.hideSelf ? "Show me" : "Hide me");
  updateStage();
}

// ===========================================================================
// 6. Remote media routing (by role)
// ===========================================================================
function onRemoteTrack({ role, track }) {
  state.remote[role] = track;

  if (role === "mic") {
    // Peer's voice → dedicated hidden audio sink so it's always audible.
    if (!remoteMicAudio) {
      remoteMicAudio = document.createElement("audio");
      remoteMicAudio.autoplay = true;
      document.body.appendChild(remoteMicAudio);
    }
    // Guard the wrap: never do `new MediaStream([null])` if a track is missing.
    remoteMicAudio.srcObject = track ? new MediaStream([track]) : null;
    if (track) remoteMicAudio.play().catch(() => {});
  }
  // screen-video / screen-audio / webcam are wired in updateStage() which builds
  // the right MediaStream for the active layout.
  updateStage();
}

// ===========================================================================
// 7. Stage state machine: screen > video-call > share-prompt
// ===========================================================================
function someoneSharing() {
  return !!state.localScreen || state.peerSharing;
}
function anyWebcam() {
  return !!state.localWebcam || state.peerCam;
}

function attachSelfStreams() {
  // Self webcam shown in BOTH the PiP overlay and the call-mode tile; visibility
  // is decided by updateStage. Attaching the same stream to two elements is fine.
  const s = state.localWebcam || null;
  if (selfPip) selfPip.setStream(s);
  $("callVideoSelf").srcObject = s;
  if (s) $("callVideoSelf").play().catch(() => {});
}

function attachPeerWebcam() {
  const t = state.remote.webcam;
  const stream = t ? new MediaStream([t]) : null;
  if (peerPip) peerPip.setStream(stream);
  $("callVideoPeer").srcObject = stream;
  if (stream) {
    $("callVideoPeer").classList.remove("hidden-until-stream");
    $("callVideoPeer").play().catch(() => {});
  }
}

function attachScreen() {
  const screenEl = $("screenVideo");
  if (state.localScreen) {
    // I'm sharing → watch my OWN screen on-site, muted so I don't echo my audio.
    screenEl.srcObject = state.localScreen.stream;
    screenEl.muted = true;
  } else if (state.peerSharing && state.remote["screen-video"]) {
    // Peer sharing → their screen + screen-audio (audible).
    const tracks = [state.remote["screen-video"]];
    if (state.remote["screen-audio"]) tracks.push(state.remote["screen-audio"]);
    screenEl.srcObject = new MediaStream(tracks);
    screenEl.muted = false;
  } else {
    screenEl.srcObject = null;
  }
  if (screenEl.srcObject) screenEl.play().catch(() => {});
}

function updateStage() {
  // Keep the actual media attached to the right elements first.
  attachSelfStreams();
  attachPeerWebcam();
  attachScreen();

  const screenMode = someoneSharing();
  const callMode = !screenMode && anyWebcam();
  const promptMode = !screenMode && !callMode;

  $("screenVideo").classList.toggle("hidden", !screenMode);
  $("callMode").classList.toggle("hidden", !callMode);
  $("sharePrompt").classList.toggle("hidden", !promptMode);

  // PiP overlays: visible only in screen mode (in call mode the big tiles show).
  const showSelfPip = screenMode && !!state.localWebcam && !state.hideSelf;
  const showPeerPip = screenMode && state.peerCam && !!state.remote.webcam;
  if (selfPip) selfPip.setHidden(!showSelfPip);
  if (peerPip) peerPip.setHidden(!showPeerPip);

  // Call-mode tiles: hide self tile if "hide me" is on.
  const selfTile = $("callVideoSelf").parentElement;
  const peerTile = $("callVideoPeer").parentElement;
  selfTile.classList.toggle("hidden", !(callMode && state.localWebcam && !state.hideSelf));
  peerTile.classList.toggle("hidden", !(callMode && state.peerCam && state.remote.webcam));
}

// ===========================================================================
// 8. Fullscreen, fading chat, auto-hide, wake lock
// ===========================================================================
async function toggleFullscreen() {
  // Fullscreen #app (not #stage): the control bar, chat panel, settings/share
  // modals, and stats overlay all live inside #app, so they stay painted in
  // fullscreen. Fullscreening #stage alone left them outside the top layer and
  // they vanished. CSS (.app:fullscreen …) expands the stage and floats the bar.
  const appEl = $("app");
  if (!document.fullscreenElement) {
    try {
      await appEl.requestFullscreen();
    } catch (_err) {
      /* user denied / unsupported */
    }
  } else {
    try {
      await document.exitFullscreen();
    } catch (_err) {
      /* ignore */
    }
  }
}

function onFullscreenChange() {
  state.isFullscreen = !!document.fullscreenElement;
  setCtrlActive("fullscreenBtn", state.isFullscreen, "Full");
  // Show the fading corner chat overlay only in fullscreen; hide the side panel.
  $("stage").classList.toggle("show-overlay-chat", state.isFullscreen);
  // The side panel is not visible in fullscreen (the stage fills the screen and
  // we use the corner overlay instead), so tell Chat it's "not visible" — that's
  // what makes incoming peer messages accrue an unread count and badge the tab
  // title while you're in fullscreen (and possibly tabbed away). Exiting restores
  // visibility, which clears the badge and scrolls to newest.
  chat?.setPanelVisible(!state.isFullscreen && state.chatVisible);
}

// idle → hide control bar + cursor
function bumpIdle() {
  const app = $("app");
  app.classList.remove("idle");
  clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    // Don't hide while a modal is open.
    if (!$("settingsModal").classList.contains("hidden")) return;
    if (!$("shareModeModal").classList.contains("hidden")) return;
    app.classList.add("idle");
  }, state.settings.idleHideMs);
}

async function acquireWakeLock() {
  if (!("wakeLock" in navigator) || state.wakeLock) return;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => {
      state.wakeLock = null;
    });
  } catch (_err) {
    /* not critical */
  }
}
function releaseWakeLock() {
  try {
    state.wakeLock?.release();
  } catch (_err) {
    /* ignore */
  }
  state.wakeLock = null;
}

// ===========================================================================
// 9. Status dot + stats overlay; keyboard shortcuts
// ===========================================================================
function setStatusDot(cls, title) {
  const dot = $("statusDot");
  dot.className = "status-dot" + (cls ? " " + cls : "");
  dot.title = title || "";
}

function startStatsLoop() {
  stopStatsLoop();
  state.statsTimer = setInterval(async () => {
    if (!state.rtc) return;
    const s = await state.rtc.getStatsSummary();
    if (!s) return;
    // Quality dot heuristic (only downgrade from the green "connected" baseline).
    if (state.connected) {
      if (s.packetLossPct != null && s.packetLossPct > 5) setStatusDot("warn", `Packet loss ${s.packetLossPct.toFixed(1)}%`);
      else if (s.rtt != null && s.rtt > 400) setStatusDot("warn", `High latency ${s.rtt} ms`);
      else setStatusDot("ok", "Connected — good");
    }
    if (state.settings.showStatsOverlay) {
      $("statsOverlay").textContent = formatStats(s);
    }
  }, 2000);
}
function stopStatsLoop() {
  clearInterval(state.statsTimer);
  state.statsTimer = null;
}
function formatStats(s) {
  const kbps = (b) => (b == null ? "—" : `${Math.round(b / 1000)} kbps`);
  return [
    `send: ${kbps(s.sendBitrate)}`,
    `recv: ${kbps(s.recvBitrate)}`,
    `fps:  ${s.fps ?? "—"}`,
    `res:  ${s.width && s.height ? s.width + "×" + s.height : "—"}`,
    `rtt:  ${s.rtt != null ? s.rtt + " ms" : "—"}`,
    `loss: ${s.packetLossPct != null ? s.packetLossPct.toFixed(1) + "%" : "—"}`,
  ].join("\n");
}

function onKeydown(e) {
  // While a modal is open, let Escape close it (handled below) but don't run the
  // Enter→focus-chat / F→fullscreen shortcuts (they'd steal focus from the dialog).
  if (trappedModal && e.key !== "Escape") return;
  // Don't hijack typing in inputs/selects.
  const tag = (e.target.tagName || "").toLowerCase();
  const typing = tag === "input" || tag === "select" || tag === "textarea";
  if (e.key === "Enter" && !typing) {
    // In fullscreen, focus the overlay input (the side panel is hidden then);
    // otherwise focus the panel input if the panel is showing.
    if (state.isFullscreen) {
      bumpIdle(); // un-fade the overlay input before focusing it
      $("overlayChatInput").focus();
      e.preventDefault();
    } else if (state.chatVisible) {
      $("chatInput").focus();
      e.preventDefault();
    }
  } else if ((e.key === "f" || e.key === "F") && !typing) {
    toggleFullscreen();
  } else if (e.key === "Escape") {
    // Close modals (browser already handles exiting fullscreen on Esc).
    closeSettings();
    closeShareModeModal();
  }
}

// ===========================================================================
// Helpers: toast, banner, ctrl state, copy, beep, tab unread
// ===========================================================================
function showToast(text, kind = "", ms = 3000) {
  const t = $("toast");
  t.textContent = text;
  t.className = "toast show" + (kind ? " " + kind : "");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove("show"), ms);
}
function setStatusBanner(text, show) {
  const b = $("statusBanner");
  b.textContent = text;
  b.classList.toggle("show", !!show && !!text);
}
function setCtrlActive(id, active, label) {
  const el = $(id);
  if (!el) return;
  el.classList.toggle("active", !!active);
  el.setAttribute("aria-pressed", active ? "true" : "false");
  if (label) {
    const lbl = el.querySelector(".ctrl-label");
    if (lbl) lbl.textContent = label;
  }
}
async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const prev = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => (btn.textContent = prev), 1500);
    }
  } catch (_err) {
    showToast("Couldn't copy automatically — select the link and copy manually.", "warn", 4000);
  }
}
function beep(freq) {
  if (!state.audioCtx) return;
  try {
    const o = state.audioCtx.createOscillator();
    const g = state.audioCtx.createGain();
    o.frequency.value = freq;
    o.connect(g);
    g.connect(state.audioCtx.destination);
    g.gain.setValueAtTime(0.0001, state.audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.15, state.audioCtx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, state.audioCtx.currentTime + 0.25);
    o.start();
    o.stop(state.audioCtx.currentTime + 0.26);
  } catch (_err) {
    /* ignore */
  }
}
function updateTabTitle(unread) {
  document.title = unread > 0 ? `(${unread}) watch-together` : "watch-together";
}

// Single send path for chat — used by both the side-panel form (passed into the
// Chat constructor) and the fullscreen overlay input. Sends to the peer over the
// data channel and echoes locally.
function sendChatText(text) {
  const ok = state.rtc?.sendData({ t: "chat", text });
  chat?.addLocal(text, state.displayName);
  if (!ok) {
    // Not deliverable yet (connecting / reconnect blip / peer away). Queue it so
    // it actually reaches the peer once the channel opens, instead of silently
    // diverging the two transcripts.
    state.chatOutbox.push(text);
    showToast("Not connected yet — will deliver when your peer is back.", "warn", 3500);
  }
}

// Flush queued chat once the data channel opens. The channel is ordered+reliable,
// so a plain replay in order is enough — no acks needed. If a send still fails
// (channel closed again mid-flush), the unsent tail is kept for the next open.
function flushChatOutbox() {
  if (!state.chatOutbox.length) return;
  const pending = state.chatOutbox;
  state.chatOutbox = [];
  for (let i = 0; i < pending.length; i++) {
    const ok = state.rtc?.sendData({ t: "chat", text: pending[i] });
    if (!ok) {
      state.chatOutbox = pending.slice(i); // keep the rest for next time
      break;
    }
  }
}

// ===========================================================================
// QOL: floating emoji reactions + synced "3·2·1" audio-first countdown
// ===========================================================================

// Schedule a short beep on the Web Audio clock at absolute time `when`. Using
// the audio clock (not setTimeout) keeps the chimes ON-BEAT even when this tab
// is in the background — e.g. you've switched to your Netflix tab to hit play.
// Backgrounded setTimeout is throttled; scheduled audio is not.
function scheduleBeep(when, freq, duration = 0.15, gain = 0.2) {
  if (!state.audioCtx) return null;
  try {
    const o = state.audioCtx.createOscillator();
    const g = state.audioCtx.createGain();
    o.frequency.value = freq;
    o.connect(g);
    g.connect(state.audioCtx.destination);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(gain, when + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    o.start(when);
    o.stop(when + duration + 0.05);
    return o;
  } catch (_err) {
    /* ignore */
    return null;
  }
}

// Float one emoji up the stage and fade it. When WE tapped it, also tell the
// peer so the same emoji floats on their screen.
function showReaction(emoji, fromPeer) {
  if (!REACTIONS.includes(emoji)) return; // only the known set (bounds peer input)
  const layer = $("reactionLayer");
  if (layer) {
    const el = document.createElement("div");
    el.className = "reaction-float";
    el.textContent = emoji;
    // Cosmetic horizontal jitter so repeated taps don't perfectly overlap.
    el.style.left = `${15 + Math.random() * 55}%`;
    layer.appendChild(el);
    el.addEventListener("animationend", () => el.remove());
    setTimeout(() => el.remove(), 3000); // belt-and-suspenders cleanup
  }
  if (!fromPeer) state.rtc?.sendData({ t: "reaction", emoji });
}

// The visual 3·2·1·GO overlay + matching scheduled chimes. Runs identically on
// both peers; skew is one-way data-channel latency (tens of ms) — imperceptible
// for "hit play together".
function startCountdown() {
  if (countdownTimer) return; // already counting
  clearCountdownInvite(); // resolve any pending invite WE sent (flag + timer)
  hideCountdownPrompt(); // and any "ready?" card WE received — every start path clears it
  const overlay = $("countdownOverlay");
  const num = $("countdownNumber");

  const t0 = state.audioCtx ? state.audioCtx.currentTime + 0.15 : 0;
  // Track the scheduled oscillators so a mid-countdown teardown (peer-left /
  // regenerate) can silence them — otherwise the chimes keep playing ~3s after
  // the visual overlay is already gone.
  stopCountdownBeeps();
  countdownBeeps = [
    scheduleBeep(t0 + 0, 660),
    scheduleBeep(t0 + 1, 660),
    scheduleBeep(t0 + 2, 660),
    scheduleBeep(t0 + 3, 990, 0.4, 0.25), // higher, longer "GO" tone
  ].filter(Boolean);

  overlay.classList.remove("hidden");
  const steps = ["3", "2", "1", "GO!"];
  let i = 0;
  const tick = () => {
    num.textContent = steps[i];
    num.classList.remove("pulse");
    void num.offsetWidth; // reflow to restart the CSS pulse
    num.classList.add("pulse");
    i += 1;
    if (i < steps.length) {
      countdownTimer = setTimeout(tick, 1000);
    } else {
      countdownTimer = setTimeout(() => {
        overlay.classList.add("hidden");
        countdownTimer = null;
      }, 800);
    }
  };
  tick();
}

// Clear a pending invite WE sent (flag + its expiry timer). Safe to call anytime.
function clearCountdownInvite() {
  countdownInviteActive = false;
  clearTimeout(countdownInviteTimer);
  countdownInviteTimer = null;
}

// Hide + forget a "ready?" card WE received (card + its auto-dismiss timer).
function hideCountdownPrompt() {
  clearTimeout(countdownPromptTimer);
  countdownPromptTimer = null;
  $("countdownInvite")?.classList.add("hidden");
}

// Silence any chimes still scheduled on the audio clock (used when a countdown is
// torn down mid-flight). A normally-completing countdown just lets them finish.
function stopCountdownBeeps() {
  for (const o of countdownBeeps) {
    try {
      o.stop();
      o.disconnect();
    } catch (_err) {
      /* already stopped/ended */
    }
  }
  countdownBeeps = [];
}

function onCountdownClick() {
  if (!state.connected) {
    showToast("You can count down once your peer is connected.", "warn", 3000);
    return;
  }
  if (countdownTimer || countdownInviteActive) return;
  // Invite the peer; the countdown fires only when THEY accept (mutual, no
  // surprise mid-bite). We start ours when their accept arrives.
  countdownInviteActive = true;
  const ok = state.rtc?.sendData({ t: "countdown", phase: "invite", name: state.displayName });
  if (ok) {
    showToast(`Asked ${state.peerName} to count down 3·2·1…`, "", 4000);
    // Don't wait forever if they ignore the prompt. On expiry we also tell THEM
    // to drop their card (phase:"cancel") so the invite times out on BOTH sides
    // — otherwise their "ready?" card would linger and a late accept would start
    // a one-sided countdown.
    clearTimeout(countdownInviteTimer);
    countdownInviteTimer = setTimeout(() => {
      if (countdownInviteActive) {
        clearCountdownInvite();
        state.rtc?.sendData({ t: "countdown", phase: "cancel" });
        showToast(`${state.peerName} didn’t respond — try again.`, "warn", 3000);
      }
    }, COUNTDOWN_INVITE_TTL_MS);
  } else {
    clearCountdownInvite();
    showToast("Couldn't send the countdown — not connected.", "warn", 3000);
  }
}

function onPeerCountdown(msg) {
  if (msg.phase === "invite") {
    if (countdownTimer) return; // mid-countdown; ignore a new invite
    $("countdownInviteText").textContent = `${msg.name || state.peerName} wants to count down 3·2·1 — ready?`;
    $("countdownInvite").classList.remove("hidden");
    // Auto-dismiss the card a bit BEFORE the sender's invite expires (see
    // COUNTDOWN_PROMPT_TTL_MS), so an ignored invite can't leave a stale card AND
    // can't be accepted after the sender already gave up.
    clearTimeout(countdownPromptTimer);
    countdownPromptTimer = setTimeout(() => hideCountdownPrompt(), COUNTDOWN_PROMPT_TTL_MS);
  } else if (msg.phase === "accept") {
    if (countdownInviteActive) startCountdown(); // peer accepted OUR invite (clears invite)
  } else if (msg.phase === "decline") {
    clearCountdownInvite();
    showToast(`${state.peerName} isn’t ready yet.`, "", 3000);
  } else if (msg.phase === "cancel") {
    // Sender's invite expired/was withdrawn — drop the card if we still have it up.
    hideCountdownPrompt();
  }
}

function acceptCountdown() {
  hideCountdownPrompt();
  state.rtc?.sendData({ t: "countdown", phase: "accept" });
  startCountdown();
}

function declineCountdown() {
  hideCountdownPrompt();
  state.rtc?.sendData({ t: "countdown", phase: "decline" });
}

// ===========================================================================
// App DOM wiring (called once on enterRoom)
// ===========================================================================
function initAppDom() {
  const stage = $("stage");

  // PiP overlays (self bottom-right, peer bottom-left by default).
  selfPip = new PipOverlay("self", stage, {
    defaultCorner: "bottom-right",
    defaultSize: { w: 240, h: 180 },
    mirrored: state.settings.mirrorSelfView,
    label: state.displayName,
  });
  peerPip = new PipOverlay("peer", stage, {
    defaultCorner: "bottom-left",
    defaultSize: { w: 240, h: 180 },
    mirrored: false,
    label: state.peerName,
  });
  selfPip.setHidden(true);
  peerPip.setHidden(true);

  $("callNameSelf").textContent = state.displayName;

  // Chat
  chat = new Chat(
    {
      panel: $("chatPanel"),
      panelList: $("chatList"),
      overlay: $("chatOverlay"),
      input: $("chatInput"),
      form: $("chatForm"),
      clearBtn: $("chatClearBtn"),
      unreadBadge: null,
    },
    state.roomCode,
    () => state.settings,
    sendChatText // shared by the side panel AND the fullscreen overlay input
  );
  $("chatPanel").addEventListener("chat-unread", (e) => updateTabTitle(e.detail.unread));

  // Fullscreen overlay chat input: send via the same path, then keep focus so
  // you can fire off several messages without leaving fullscreen.
  $("overlayChatForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("overlayChatInput");
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    sendChatText(text);
    bumpIdle(); // refresh the idle timer so the box doesn't fade right after sending
  });

  // Control bar
  $("shareBtn").addEventListener("click", onShareClick);
  // Wrap so the click Event isn't passed as the `silent` arg (it'd be truthy and
  // suppress the error toast on a normal manual click).
  $("camBtn").addEventListener("click", () => onCamClick());
  $("micBtn").addEventListener("click", () => onMicClick());
  $("shareAudioBtn").addEventListener("click", toggleShareAudio);
  $("hideSelfBtn").addEventListener("click", toggleHideSelf);
  $("chatBtn").addEventListener("click", toggleChatPanel);
  $("settingsBtn").addEventListener("click", openSettings);
  $("fullscreenBtn").addEventListener("click", toggleFullscreen);
  $("shareCenterBtn").addEventListener("click", onShareClick);

  // QOL: emoji reaction buttons (built from the fixed REACTIONS set).
  const reactionBar = $("reactionBar");
  if (reactionBar) {
    for (const emoji of REACTIONS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "reaction-btn";
      b.textContent = emoji;
      b.title = `React ${emoji}`;
      b.addEventListener("click", () => showReaction(emoji, /*fromPeer*/ false));
      reactionBar.appendChild(b);
    }
  }

  // QOL: synced countdown (invite → accept).
  $("countdownBtn").addEventListener("click", onCountdownClick);
  $("countdownAccept").addEventListener("click", acceptCountdown);
  $("countdownDecline").addEventListener("click", declineCountdown);

  // Share-mode modal
  $("shareModeMotion").addEventListener("click", () => beginShare("motion"));
  $("shareModeDetail").addEventListener("click", () => beginShare("detail"));
  $("shareModeCancel").addEventListener("click", closeShareModeModal);
  $("shareModeModal").addEventListener("click", (e) => {
    if (e.target === $("shareModeModal")) closeShareModeModal(); // click backdrop to close
  });

  // Settings modal
  wireSettingsModal();

  // Fullscreen + idle + keyboard
  document.addEventListener("fullscreenchange", onFullscreenChange);
  stage.addEventListener("pointermove", bumpIdle);
  $("controlBar").addEventListener("pointerenter", () => {
    $("app").classList.remove("idle");
    clearTimeout(state.idleTimer);
  });
  $("controlBar").addEventListener("pointerleave", bumpIdle);
  document.addEventListener("keydown", onKeydown);
  document.addEventListener("keydown", onModalKeydown); // Tab-trap inside open modals
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.connected) acquireWakeLock();
  });
  window.addEventListener("beforeunload", () => {
    state.signaling?.close();
  });

  bumpIdle();
  updateStage();
}

function toggleChatPanel() {
  state.chatVisible = !state.chatVisible;
  $("app").classList.toggle("chat-hidden", !state.chatVisible);
  setCtrlActive("chatBtn", state.chatVisible, "Chat");
  chat?.setPanelVisible(state.chatVisible);
  if (state.chatVisible) updateTabTitle(0);
}

// ===========================================================================
// Settings modal wiring
// ===========================================================================
// --- modal focus management (accessibility) --------------------------------
// Track the element to restore focus to when a modal closes, and trap Tab inside
// the open dialog so keyboard focus can't wander into the hidden background.
let modalReturnFocus = null;
let trappedModal = null;

function focusableIn(el) {
  return Array.from(
    el.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((n) => n.offsetParent !== null); // visible only
}

// The interactive surfaces BEHIND a modal. We can't just aria-hide #app because
// the modals live inside it (so they can show in fullscreen); instead we make
// these specific siblings inert — removing them from tab order and the a11y tree
// — while a dialog is open.
const BG_CONTAINER_IDS = ["stage", "chatPanel", "controlBar"];

function setBackgroundInert(inert) {
  for (const id of BG_CONTAINER_IDS) {
    const el = $(id);
    if (!el) continue;
    el.inert = inert; // supported in desktop Chromium (our only target)
    if (inert) el.setAttribute("aria-hidden", "true");
    else el.removeAttribute("aria-hidden");
  }
}

function openModal(modalEl) {
  modalReturnFocus = document.activeElement;
  trappedModal = modalEl;
  modalEl.classList.remove("hidden");
  setBackgroundInert(true);
  const focusables = focusableIn(modalEl);
  if (focusables.length) focusables[0].focus();
}

function closeModal(modalEl) {
  modalEl.classList.add("hidden");
  if (trappedModal === modalEl) trappedModal = null;
  setBackgroundInert(false);
  // Restore focus to whatever opened the modal.
  try {
    modalReturnFocus?.focus();
  } catch (_err) {
    /* element gone — ignore */
  }
  modalReturnFocus = null;
}

function onModalKeydown(e) {
  if (!trappedModal || e.key !== "Tab") return;
  const focusables = focusableIn(trappedModal);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    last.focus();
    e.preventDefault();
  } else if (!e.shiftKey && document.activeElement === last) {
    first.focus();
    e.preventDefault();
  }
}

function openSettings() {
  const s = state.settings;
  $("settingsRoomLink").value = inviteLink();
  $("settingsName").value = state.displayName;
  $("echoCancelToggle").checked = s.echoCancellation;
  $("qualitySelect").value = s.qualityCap;
  $("mirrorToggle").checked = s.mirrorSelfView;
  $("statsToggle").checked = s.showStatsOverlay;
  $("fadeRange").value = s.chatFadeSeconds;
  $("fadeOut").value = s.chatFadeSeconds;
  $("pinRange").value = s.chatPinnedCount;
  $("pinOut").value = s.chatPinnedCount;
  $("textSizeRange").value = s.chatTextSize;
  $("textSizeOut").value = s.chatTextSize;
  $("accentColor").value = s.accentColor;
  $("peerSoundToggle").checked = s.peerJoinSound;
  $("idleRange").value = Math.round(s.idleHideMs / 1000);
  $("idleOut").value = Math.round(s.idleHideMs / 1000);
  populateDevicePickers();
  openModal($("settingsModal"));
}
function closeSettings() {
  if ($("settingsModal").classList.contains("hidden")) return;
  closeModal($("settingsModal"));
}

async function populateDevicePickers() {
  const { cameras, mics } = await listDevices();
  const camSel = $("cameraSelect");
  const micSel = $("micSelect");
  camSel.innerHTML = "";
  micSel.innerHTML = "";
  const addOpt = (sel, dev, fallback) => {
    const o = document.createElement("option");
    o.value = dev.deviceId;
    o.textContent = dev.label || fallback;
    sel.appendChild(o);
  };
  if (!cameras.length) addOpt(camSel, { deviceId: "" }, "Default camera");
  cameras.forEach((c, i) => addOpt(camSel, c, `Camera ${i + 1}`));
  if (!mics.length) addOpt(micSel, { deviceId: "" }, "Default microphone");
  mics.forEach((m, i) => addOpt(micSel, m, `Microphone ${i + 1}`));
  if (state.settings.cameraDeviceId) camSel.value = state.settings.cameraDeviceId;
  if (state.settings.micDeviceId) micSel.value = state.settings.micDeviceId;
}

function wireSettingsModal() {
  $("settingsCloseBtn").addEventListener("click", closeSettings);
  $("settingsModal").addEventListener("click", (e) => {
    if (e.target === $("settingsModal")) closeSettings(); // click backdrop to close
  });

  $("settingsCopyBtn").addEventListener("click", () => copyText(inviteLink(), $("settingsCopyBtn")));
  $("regenRoomBtn").addEventListener("click", regenerateRoom);

  $("settingsName").addEventListener("change", (e) => {
    state.displayName = e.target.value.trim() || "Guest";
    localStorage.setItem(STORAGE_KEYS.DISPLAY_NAME, state.displayName);
    $("callNameSelf").textContent = state.displayName;
    if (selfPip) selfPip.setLabel(state.displayName);
    publishProfile();
  });

  $("echoCancelToggle").addEventListener("change", (e) => {
    state.settings.echoCancellation = e.target.checked;
    saveSettings();
    showToast("Echo cancellation changes apply next time you turn the mic on.", "", 3500);
  });
  $("qualitySelect").addEventListener("change", (e) => {
    state.settings.qualityCap = e.target.value;
    saveSettings();
    state.rtc?.setQualityCap(e.target.value);
  });
  $("mirrorToggle").addEventListener("change", (e) => {
    state.settings.mirrorSelfView = e.target.checked;
    saveSettings();
    applySettings();
  });
  $("statsToggle").addEventListener("change", (e) => {
    state.settings.showStatsOverlay = e.target.checked;
    saveSettings();
    $("statsOverlay").classList.toggle("hidden", !e.target.checked);
  });
  $("fadeRange").addEventListener("input", (e) => {
    state.settings.chatFadeSeconds = +e.target.value;
    $("fadeOut").value = e.target.value;
    saveSettings();
    chat?.applySettings();
  });
  $("pinRange").addEventListener("input", (e) => {
    state.settings.chatPinnedCount = +e.target.value;
    $("pinOut").value = e.target.value;
    saveSettings();
    chat?.applySettings();
  });
  $("textSizeRange").addEventListener("input", (e) => {
    state.settings.chatTextSize = +e.target.value;
    $("textSizeOut").value = e.target.value;
    saveSettings();
    chat?.applySettings();
  });
  $("accentColor").addEventListener("input", (e) => {
    state.settings.accentColor = e.target.value;
    saveSettings();
    applySettings();
  });
  $("peerSoundToggle").addEventListener("change", (e) => {
    state.settings.peerJoinSound = e.target.checked;
    saveSettings();
  });
  $("idleRange").addEventListener("input", (e) => {
    state.settings.idleHideMs = +e.target.value * 1000;
    $("idleOut").value = e.target.value;
    saveSettings();
  });
  $("cameraSelect").addEventListener("change", async (e) => {
    const oldId = state.settings.cameraDeviceId;
    state.settings.cameraDeviceId = e.target.value;
    saveSettings();
    // If the camera is live, switch it to the new device — but if that device is
    // busy/unavailable, fall back to the one that was working instead of silently
    // dropping to no-camera with a stale "on" button. silent=true so a failed
    // attempt doesn't flash its own raw error toast over our contextual message.
    if (state.localWebcam) {
      teardownCamera();
      await onCamClick(/*silent*/ true); // turn-on path with the new deviceId
      if (!state.localWebcam) {
        // New device failed. Revert the setting and try the previous one.
        state.settings.cameraDeviceId = oldId;
        saveSettings();
        $("cameraSelect").value = oldId || "";
        await onCamClick(/*silent*/ true);
        if (!state.localWebcam) {
          teardownCamera(); // both failed → fully converge on camera-off
          showToast("Couldn’t start either camera — turned the camera off.", "error", 5000);
        } else {
          showToast("That camera wasn’t available — kept your previous one.", "warn", 4000);
        }
      }
    }
  });
  $("micSelect").addEventListener("change", async (e) => {
    const oldId = state.settings.micDeviceId;
    state.settings.micDeviceId = e.target.value;
    saveSettings();
    if (state.localMic) {
      teardownMic();
      await onMicClick(/*silent*/ true);
      if (!state.localMic) {
        state.settings.micDeviceId = oldId;
        saveSettings();
        $("micSelect").value = oldId || "";
        await onMicClick(/*silent*/ true);
        if (!state.localMic) {
          teardownMic(); // both failed → fully converge on mic-off
          showToast("Couldn’t start either microphone — turned the mic off.", "error", 5000);
        } else {
          showToast("That microphone wasn’t available — kept your previous one.", "warn", 4000);
        }
      }
    }
  });
}

function regenerateRoom() {
  const code = genRoomCode();
  localStorage.setItem(STORAGE_KEYS.ROOM_CODE, code);
  state.roomCode = code;
  history.replaceState(null, "", inviteLink());
  showToast("New room link generated — share the new link. The old one is dead.", "", 5000);
  // Tear down the old connection.
  state.signaling?.close();
  if (state.rtc) {
    state.rtc.close();
    state.rtc = null;
  }
  state.connected = false;
  // Clear OUR OWN view of the old peer (their media/flags) so we don't sit
  // staring at their frozen last frame in the very flow meant to give a clean
  // slate. (signaling.close() does send a 'bye' so the OTHER peer gets peer-left;
  // this reset is about our local state, which that notification doesn't touch.)
  resetPeerState();
  // Rebind chat persistence to the new room (otherwise it keeps showing the old
  // scrollback and saving under the dead room's key).
  chat?.setRoom(code);
  setStatusBanner("Waiting for your peer to join… share the invite link.", true);
  $("settingsRoomLink").value = inviteLink();
  connectSignaling();
}

// --- share-mode modal ------------------------------------------------------
function openShareModeModal() {
  openModal($("shareModeModal"));
}
function closeShareModeModal() {
  if ($("shareModeModal").classList.contains("hidden")) return;
  closeModal($("shareModeModal"));
}

// ===========================================================================
// boot
// ===========================================================================
initLobby();
