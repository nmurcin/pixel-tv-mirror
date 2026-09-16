# Stage 1 validation

Validated on Windows using installed Chrome 152 in an isolated headless browser profile.

- Both diagnostic JavaScript files parse with Acorn `ecmaVersion: 5`.
- The HTML loads only two ordinary local JavaScript files, with no module loader or imports.
- Two consecutive actual WebRTC self-tests passed all seven steps, including receipt of the test payload by peer B.
- Missing RTC constructors and MediaSource do not stop the page.
- Throwing storage, MediaSource, RTCRtpReceiver, and navigator getters remain visible as unknown/error results while later sections render.
- Constructor errors and rejected offers produce readable failures and leave the run button usable.
- Runtime errors and unhandled rejections render as literal text and preserve the summary.
- The browser tests observed no external page requests.
- Callback-only and Promise-style WebRTC mock tests passed, including rejection, timeout, and stale-callback behavior.
- The 1280 x 720 screenshot was visually reviewed for TV readability.

The same real WebRTC test timed out under the restricted execution sandbox after successful offer/answer and ICE gathering. It passed twice when run under the normal Windows account without changing browser flags or the implementation. This demonstrates why API availability alone cannot establish connectivity.

All copied application files matched the source snapshot SHA-256 hashes. The original README is preserved byte for byte as WATCH_TOGETHER_README.md. Source snapshot: 48c74bf51fac56bd479c9c6f21e96ba3aa8d9c13.

These desktop tests do not establish Samsung browser compatibility or remote H.264 video reception. The next required evidence is the actual TV diagnostic result.

See tests/README.md for reproducible test commands.

## Stage 2 validation

Validated with installed Chrome 152 in two isolated browser contexts on the same Windows computer, with the receiver loaded through the computer LAN IPv4 URL over HTTP (`isSecureContext=false`). This exercises a real encoded video stream, but is not yet a test of a second physical device.

- H.264-only mode: RTP stats confirmed H264; decoded video reached 1280 x 720. A 120-second stability run advanced beyond 3,300 frames without a 10-second stall.
- Automatic mode: RTP stats confirmed VP8; a separate 120-second run also advanced beyond 3,300 frames and reached 1280 x 720. Resolution adaptation during startup is allowed and reported rather than hidden.
- Sender and receiver peer connections both closed after Stop. No external browser requests were observed.
- Acorn ES5 parsing passed for both Stage 2 runtime scripts.
- Video-engine unit tests cover strict H.264 filtering with matching RTX, rejection when H.264 is absent, legacy callbacks/statistics, queued ICE, cleanup, missing counters, decoded-frame stalls/recovery, and clock-only stalls/recovery.
- Server tests cover malformed JSON without crashes, pairing limits, role-token authorization, exact origin/host checks, polling cursors, queue limits, session expiry, and rejection of arbitrary file paths.
- Original application and Stage 1 runtime files remain unchanged.

The actual Samsung still needs to join this local video test. Desktop results cannot establish Tizen H.264 decoding, home-network connectivity between the two devices, or practical TV playback delay. The firewall helper was syntax-reviewed; its administrator action is a separate host setup step.
