# Pixel TV Mirror

Current stage: **Samsung Smart TV browser capability characterization**.

TV test: **https://nmurcin.github.io/pixel-tv-mirror/tv-test.html**

This independent repository began as a source-only copy of my own [watch-together](https://github.com/nmurcin/watch-together) project at commit `48c74bf51fac56bd479c9c6f21e96ba3aa8d9c13`. It has fresh Git history and only the `nmurcin/pixel-tv-mirror` remote. The original source application is preserved as reference; its documentation is in [WATCH_TOGETHER_README.md](WATCH_TOGETHER_README.md). The original repository and its deployment are not changed.

## Test on the TV

1. Open the URL above in the Samsung TV browser.
2. Select **RUN WEBRTC SELF TEST** and wait up to 20 seconds.
3. Photograph the summary and any failures; send the photo back to ChatGPT. The full user agent and detailed results are farther down the page.
4. **COPY RESULTS**, where supported, is optional. Results always remain visible as text.

The diagnostic uses ordinary ES5 JavaScript and minimal CSS, independently of the copied application's modern scripts. Use the exact `tv-test.html` URL; the root page is the preserved watch-together application, not the diagnostic.

## Interpret the results

- **AVAILABLE** means an API exists, not that video transmission works.
- **PASS** means the particular test succeeded; **FAIL** includes the failing step and error where available. **UNKNOWN** means untested or inconclusive.
- `canPlayType()` results are shown verbatim. `probably` and `maybe` are browser declarations; an empty result means no support was reported for that exact MIME string. No sample video has been decoded.
- MediaSource `isTypeSupported()` true means a format is advertised. Actual appending, decoding, latency, and sustained playback need a later test.
- The WebRTC test creates two peers in the same page with no STUN/TURN servers, exchanges descriptions and ICE candidates locally, and verifies receipt of `PIXEL_TV_TEST` over a DataChannel. It does not test Pixel-to-TV networking or video. Browser policies can prevent local connectivity despite API presence.
- Reported receiver codecs are advertised capabilities only. **WebRTC H.264 receive capability remains UNKNOWN** until an actual remote video test.
- A successful WebRTC self-test makes WebRTC promising. H.264 + MediaSource is another candidate when those APIs advertise support. Fallback recommendations require later playback and performance tests.
- Compact values use `1` for present/succeeded or advertised format support, `0` for absent/failed/no advertised support, and `?` for unknown. In particular, `H264_MP4=1` and `H264_MSE=1` do not prove decoding. Keep the accompanying detailed results.
- Tizen and browser versions are displayed only when explicitly identifiable in the user agent. No TV model is guessed.

## Privacy and scope

The diagnostic uploads no report, uses no analytics or external scripts/fonts, and makes no live signaling or WebSocket connection. Results stay in the page. It requests no camera, microphone, location, screen capture, or login. GitHub Pages receives normal requests for the page and its local assets; the optional copy button writes only to the clipboard. Storage probes temporarily write a test key and restore/remove it.

Stage 1 does **not** implement an Android application, MediaProjection, production screen mirroring, or changes to the original lobby. The eventual goal is Pixel 7 screen capture to the TV browser without external hardware.

## Local development and deployment

Serve the repository root, for example:

```text
python -m http.server 8765 --bind 127.0.0.1
```

Open `http://127.0.0.1:8765/tv-test.html`. The diagnostic requires no build or npm runtime dependencies. GitHub Pages publishes the `main` branch, repository root. Only push to `https://github.com/nmurcin/pixel-tv-mirror.git`.

## API references

- [WebRTC offer creation and legacy callbacks](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/createOffer)
- [Receiver codec capability reporting](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/getCapabilities_static)

Desktop validation cannot establish Samsung TV compatibility. The TV results determine the next transport experiment.
