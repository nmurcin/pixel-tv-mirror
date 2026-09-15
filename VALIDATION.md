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
