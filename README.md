# Pixel TV Mirror

Current stage: **Stage 2 local-network computer-to-TV video test**.

Stage 1 TV diagnostic: **https://nmurcin.github.io/pixel-tv-mirror/tv-test.html**

Stage 2 launch information: **https://nmurcin.github.io/pixel-tv-mirror/tv-video.html** (the live test uses the local server below).

This independent repository began as a source-only copy of my own [watch-together](https://github.com/nmurcin/watch-together) project at commit `48c74bf51fac56bd479c9c6f21e96ba3aa8d9c13`. It has fresh Git history and only the `nmurcin/pixel-tv-mirror` remote. The original source application is preserved as reference; its documentation is in [WATCH_TOGETHER_README.md](WATCH_TOGETHER_README.md). The original repository and its deployment are not changed.

## Stage 2: isolated local video test

Stage 2 is separate from the preserved watch-together application and from the GitHub Pages diagnostic. On the Windows computer, run `Start-Video-Test.cmd` and keep its console open. Open the sender at `http://localhost:8766/tv-video.html`.

Choose **H.264 only** first, then use **Automatic** only as a comparison. Select **CREATE TEST** to create a fresh 8-digit pairing code. The console and page display one or more `http://<local-IP>:8766/tv-video.html` addresses: open one of those local addresses on the TV, enter the code, and select **JOIN TEST**. Do not open the GitHub Pages URL on the TV for this stage; Pages serves static files only and cannot run the local signaling server.

The computer generates a moving 1280 x 720 pattern at a 30 fps target. Those are test targets, not a claim about the TV’s actual decoded dimensions or frame rate. Compare the moving counter on the sender and TV visually. The on-page evidence also reports RTP statistics where available: the selected codec in RTP stats is stronger evidence than codec candidates listed in SDP; increasing decoded-frame counts are stronger than a clock fallback. RTT describes network round-trip timing, not one-way video delay.

This experiment builds no Android app and requests no camera, microphone, or screen-capture permission. It has no cloud service, production signaling service, STUN/TURN service, or external signaling dependency. It is a local synthetic-video test, not Pixel screen mirroring.

The observed Samsung TV evidence is recorded in [TV_RESULTS.md](TV_RESULTS.md): the Stage 1 self-test passed on the actual TV, with browser-reported Tizen 5.0 and Chrome 63.0.3239.84. That result supports trying this experiment; it does not establish remote-video codec selection, decoding, sustained playback, or practical delay.

### Optional temporary LAN firewall helper

`Enable-Video-Test-LAN.ps1` is an optional, narrowly scoped administrator helper for the case where Windows Firewall blocks the local test server. Windows administrator approval is required to run it. When explicitly launched, it creates one temporary inbound TCP rule only for the verified `video-server.cjs` Node process, supplied local IPv4 address and port, and `LocalSubnet`. It does not alter firewall profiles, defaults, or existing rules, and removes that exact rule when the verified server ends, its PID changes, or four hours pass.

## Stage 1: Samsung browser capability characterization

### Test on the TV

1. Open the URL above in the Samsung TV browser.
2. Select **RUN WEBRTC SELF TEST** and wait up to 20 seconds.
3. Photograph the summary and any failures; send the photo back to ChatGPT. The full user agent and detailed results are farther down the page.
4. **COPY RESULTS**, where supported, is optional. Results always remain visible as text.

The diagnostic uses ordinary ES5 JavaScript and minimal CSS, independently of the copied application's modern scripts. Use the exact `tv-test.html` URL; the root page is the preserved watch-together application, not the diagnostic.

### Interpret the results

- **AVAILABLE** means an API exists, not that video transmission works.
- **PASS** means the particular test succeeded; **FAIL** includes the failing step and error where available. **UNKNOWN** means untested or inconclusive.
- `canPlayType()` results are shown verbatim. `probably` and `maybe` are browser declarations; an empty result means no support was reported for that exact MIME string. No sample video has been decoded.
- MediaSource `isTypeSupported()` true means a format is advertised. Actual appending, decoding, latency, and sustained playback need a later test.
- The WebRTC test creates two peers in the same page with no STUN/TURN servers, exchanges descriptions and ICE candidates locally, and verifies receipt of `PIXEL_TV_TEST` over a DataChannel. It does not test Pixel-to-TV networking or video. Browser policies can prevent local connectivity despite API presence.
- Reported receiver codecs are advertised capabilities only. **WebRTC H.264 receive capability remains UNKNOWN** until an actual remote video test.
- A successful WebRTC self-test makes WebRTC promising. H.264 + MediaSource is another candidate when those APIs advertise support. Fallback recommendations require later playback and performance tests.
- Compact values use `1` for present/succeeded or advertised format support, `0` for absent/failed/no advertised support, and `?` for unknown. In particular, `H264_MP4=1` and `H264_MSE=1` do not prove decoding. Keep the accompanying detailed results.
- Tizen and browser versions are displayed only when explicitly identifiable in the user agent. No TV model is guessed.

### Privacy and scope

The diagnostic uploads no report, uses no analytics or external scripts/fonts, and makes no live signaling or WebSocket connection. Results stay in the page. It requests no camera, microphone, location, screen capture, or login. GitHub Pages receives normal requests for the page and its local assets; the optional copy button writes only to the clipboard. Storage probes temporarily write a test key and restore/remove it.

Stage 1 does **not** implement an Android application, MediaProjection, production screen mirroring, or changes to the original lobby. The eventual goal is Pixel 7 screen capture to the TV browser without external hardware.

## Stage 1 local development and deployment

Serve the repository root, for example:

```text
python -m http.server 8765 --bind 127.0.0.1
```

Open `http://127.0.0.1:8765/tv-test.html`. The diagnostic requires no build or npm runtime dependencies. GitHub Pages publishes the `main` branch, repository root. Only push to `https://github.com/nmurcin/pixel-tv-mirror.git`.

## API references

- [WebRTC offer creation and legacy callbacks](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/createOffer)
- [Receiver codec capability reporting](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/getCapabilities_static)

Desktop validation cannot establish Samsung TV compatibility. The TV results determine the next transport experiment.
