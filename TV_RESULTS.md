# Samsung TV evidence and next experiment

## Stage 1: observed on the actual TV

The owner's photos show the diagnostic executing and all seven WebRTC self-test stages passing: constructor, offer, answer, ICE gathering, peer connection, DataChannel open, and payload reception.

User-agent tokens report Tizen 5.0, SamsungBrowser 2.2, and Chrome 63.0.3239.84. These are browser-reported identifiers; the TV hardware model remains unknown.

WebSocket, WebRTC, MediaSource, and fullscreen APIs are present. H.264 MP4 and H.264 MediaSource support are advertised. The initial photo shows unrun self-test values; the subsequent photo shows the completed passing test.

Not yet established: remote video reception, selected RTP video codec, sustained decoding, practical latency, or Pixel screen capture. The optional receive-codec and error-log photos can add context but are not prerequisites for Stage 2.

## Stage 2: real computer-to-TV video

A separate local server serves the video test and exchanges connection setup messages only within the home network. It does not contact the original watch-together signaling service. The original application and Stage 1 diagnostic remain intact.

The computer draws a synthetic moving pattern and captures that canvas at a target 1280 x 720, 30 fps. It requests no microphone, camera, or screen capture. The TV receives a WebRTC video stream. Start with H.264-only mode; automatic mode is a separate comparison and must not be presented as proof of H.264 support.

Evidence to collect:

- A visibly moving pattern on the TV, and whether playback needs the Play button.
- RTP codec from stats where exposed; SDP codec lists alone are only negotiated candidates.
- Video dimensions, increasing decoded frames, measured frame rate, and bitrate where available.
- Several minutes of stable playback, including any interruptions or error messages.
- Visible delay by comparing the same pattern counter on computer and TV. Network RTT is round-trip transport timing, not one-way video delay.

The sender runs on localhost. The TV opens the HTTP LAN address printed by the local server, not the HTTPS GitHub Pages URL. Static Pages cannot host this local signaling server. No self-signed certificate, browser security bypass, public signaling account, STUN, or TURN service is required for this experiment.

Keep both devices on the same trusted home network. Guest/client isolation, the host firewall, HTTP browser restrictions, and old/new ICE candidate interoperability can still prevent the cross-device connection even though the single-page self-test passed. Any such failure is evidence to investigate, not proof that all WebRTC video is unsupported.

No Android application or MediaProjection implementation is included in this stage.
