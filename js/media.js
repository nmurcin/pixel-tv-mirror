// ===========================================================================
// media.js — getDisplayMedia / getUserMedia wrappers with real error handling.
//
// Every capture call here returns either { ok:true, ... } or { ok:false, ... }
// with a USER-FACING message — callers never have to interpret raw DOMException
// names. This is where the gnarly platform realities live:
//   - Permission denial (NotAllowedError) vs no device (NotFoundError) vs device
//     busy (NotReadableError) get distinct, actionable messages.
//   - getDisplayMedia audio is source-dependent on Windows/Chrome: a window
//     share often yields NO audio track. We detect that and tell the user to
//     share a Chrome TAB if they need sound.
//   - The browser's native "Stop sharing" bar ends the track from outside our
//     UI; we surface that via an onEnded callback so the app converges on one
//     teardown path.
// ===========================================================================

import { CONFIG } from "./config.js";

/**
 * Map a getUserMedia/getDisplayMedia rejection to a friendly message.
 */
function describeMediaError(err, kind /* 'screen' | 'camera' | 'microphone' */) {
  const name = err && err.name ? err.name : "Error";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      // User clicked "Block", dismissed the picker, or permission is denied.
      if (kind === "screen") {
        return "Screen share was cancelled or blocked. Click “Share content” and choose a screen, window, or tab.";
      }
      return `Permission to use your ${kind} was denied. Click the camera icon in the address bar to allow it, then try again.`;
    case "NotFoundError":
    case "OverconstrainedError":
      return `No ${kind} was found. Check that a ${kind} is connected and not disabled, then try again.`;
    case "NotReadableError":
      return `Your ${kind} is in use by another app (or a hardware error occurred). Close other apps using it and try again.`;
    case "AbortError":
      return `Starting your ${kind} was interrupted. Try again.`;
    default:
      return `Couldn't start your ${kind} (${name}). Try again.`;
  }
}

/**
 * Capture the screen/window/tab. Returns:
 *   { ok:true, stream, videoTrack, audioTrack|null, hasAudio, warning|null }
 *   { ok:false, cancelled:boolean, message }
 *
 * @param {() => void} onEnded called when the user stops the share from the
 *        browser's native bar (or the track otherwise ends).
 */
export async function captureScreen(onEnded) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia(CONFIG.SCREEN_CONSTRAINTS);
  } catch (err) {
    return {
      ok: false,
      cancelled: err && err.name === "NotAllowedError",
      message: describeMediaError(err, "screen"),
    };
  }

  const videoTrack = stream.getVideoTracks()[0] || null;
  const audioTrack = stream.getAudioTracks()[0] || null;

  if (!videoTrack) {
    // Extremely rare, but don't proceed with a video-less "screen share".
    stream.getTracks().forEach((t) => t.stop());
    return { ok: false, cancelled: false, message: "No screen video was captured. Try again." };
  }

  // Native "Stop sharing" bar (and any external end) ends the video track.
  videoTrack.addEventListener("ended", () => {
    if (typeof onEnded === "function") onEnded();
  });

  // Audio is source-dependent. Warn (don't fail) if there's no audio track.
  let warning = null;
  if (!audioTrack) {
    warning =
      "No audio is being shared. For sound, re-share and choose a Chrome tab (or tick “Share system/tab audio” in the picker). Window shares usually have no audio.";
  }

  return {
    ok: true,
    stream,
    videoTrack,
    audioTrack,
    hasAudio: !!audioTrack,
    warning,
  };
}

/**
 * Capture the webcam. Returns { ok:true, stream, videoTrack } or
 * { ok:false, message }. Optionally pin a specific deviceId (from Settings).
 */
export async function captureWebcam(deviceId) {
  const constraints = {
    video: { ...CONFIG.WEBCAM_CONSTRAINTS.video },
    audio: false,
  };
  if (deviceId) constraints.video.deviceId = { exact: deviceId };

  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const videoTrack = stream.getVideoTracks()[0] || null;
    if (!videoTrack) {
      stream.getTracks().forEach((t) => t.stop());
      return { ok: false, message: "No camera video was captured. Try again." };
    }
    return { ok: true, stream, videoTrack };
  } catch (err) {
    return { ok: false, message: describeMediaError(err, "camera") };
  }
}

/**
 * Capture the microphone. Echo cancellation etc. come from live settings (the
 * caller passes echoCancellation; we merge it over the config defaults).
 * Returns { ok:true, stream, audioTrack } or { ok:false, message }.
 */
export async function captureMic(deviceId, echoCancellation = true) {
  const audio = {
    echoCancellation,
    noiseSuppression: echoCancellation, // tie suppression to the same intent
    autoGainControl: echoCancellation,
  };
  if (deviceId) audio.deviceId = { exact: deviceId };

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    const audioTrack = stream.getAudioTracks()[0] || null;
    if (!audioTrack) {
      stream.getTracks().forEach((t) => t.stop());
      return { ok: false, message: "No microphone audio was captured. Try again." };
    }
    return { ok: true, stream, audioTrack };
  } catch (err) {
    return { ok: false, message: describeMediaError(err, "microphone") };
  }
}

/**
 * Enumerate cameras and microphones for the Settings device pickers.
 * Device LABELS are only populated after permission has been granted at least
 * once; before that, labels are empty strings (browser privacy). Returns
 * { cameras: [{deviceId,label}], mics: [{deviceId,label}] }.
 */
export async function listDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = [];
    const mics = [];
    devices.forEach((d) => {
      if (d.kind === "videoinput") {
        cameras.push({ deviceId: d.deviceId, label: d.label || "Camera" });
      } else if (d.kind === "audioinput") {
        mics.push({ deviceId: d.deviceId, label: d.label || "Microphone" });
      }
    });
    return { cameras, mics };
  } catch (_err) {
    return { cameras: [], mics: [] };
  }
}

/** Stop every track on a stream (safe on null). */
export function stopStream(stream) {
  if (!stream) return;
  try {
    stream.getTracks().forEach((t) => t.stop());
  } catch (_err) {
    /* ignore */
  }
}
