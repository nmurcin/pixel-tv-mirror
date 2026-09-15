# watch-together

A private, **two-person** screen-sharing web app. One of you shares a screen, window,
or tab in 1080p **with audio**; the other watches — with both webcams floating on top as
draggable picture-in-picture overlays, text chat, and optional voice. The page itself is
the shared viewing surface, so **the person sharing also watches here, with cameras on
top** — no one is stuck staring at a camera-less screen.

- **Peer-to-peer.** Audio and video go *directly* browser-to-browser (WebRTC). The only
  server is a tiny "signaling" relay that introduces the two browsers and then gets out of
  the way — it never sees your media.
- **Free to host.** Static front-end on **GitHub Pages**, signaling relay on **Render**'s
  free tier.
- **Symmetric.** Either person can share (one at a time). Webcam, mic, and screen are all
  independent toggles, and **nothing turns on until you choose it** — you're asked for
  camera/mic permission only when you flip them on.

> **Target browsers:** desktop **Chrome, Edge, or Brave** on Windows/Mac/Linux. These all
> use the same Blink/WebRTC engine. Mobile, Safari, and Firefox are intentionally not
> supported. (See [Using Brave](#using-brave) for one privacy-setting gotcha.)

---

## Table of contents

1. [How it works (the 60-second version)](#how-it-works)
2. [Quick start: get it online](#quick-start)
   - [Step 1 — Put the code on GitHub](#step-1)
   - [Step 2 — Turn on GitHub Pages](#step-2)
   - [Step 3 — Deploy the signaling server to Render](#step-3)
   - [Step 4 — Wire the front-end to the server](#step-4)
   - [Step 5 — Open it and test](#step-5)
3. [Manual test plan](#manual-test-plan) ← **read this to verify it really works**
4. [Using the app day-to-day](#using-the-app)
5. [Settings reference](#settings)
6. [Adding a TURN server (only if a connection ever fails)](#turn)
7. [Using Brave](#using-brave)
8. [Running the signaling server locally (optional)](#local-server)
9. [Deploying the server to Cloudflare instead of Render](#cloudflare)
10. [Project layout](#layout)
11. [Troubleshooting](#troubleshooting)

---

<a name="how-it-works"></a>
## 1. How it works (the 60-second version)

```
  Your browser  ─────────────  Signaling server (Render)  ─────────────  Their browser
        │            "here's how to reach me" (SDP + ICE, tiny JSON)            │
        │                                                                       │
        └───────────────────────  audio / video / chat  ───────────────────────┘
                         DIRECT peer-to-peer (never touches the server)
```

1. Both of you open the same **room link**. Your browsers each tell the signaling server
   "I'm in this room."
2. The server introduces you to each other by passing a few small handshake messages back
   and forth (this is all it ever does).
3. Once introduced, your browsers open a **direct** connection and the media flows
   peer-to-peer. The server is now idle.

Because the media is direct, the free server tier is plenty — it only ever moves a few
kilobytes of handshake JSON.

---

<a name="quick-start"></a>
## 2. Quick start: get it online

You'll need a free **GitHub** account and a free **Render** account. No coding required —
just clicking and one line of config.

<a name="step-1"></a>
### Step 1 — Put the code on GitHub

This project is already a local git repository. Create an empty repo on GitHub and push to
it.

1. Go to <https://github.com/new>. Name it (e.g. `watch-together`), leave it **empty** (no
   README/license — you already have them), and click **Create repository**.
2. GitHub shows you a URL like `https://github.com/YOUR-NAME/watch-together.git`. In a
   terminal, from this project folder, run:

   ```bash
   git remote add origin https://github.com/YOUR-NAME/watch-together.git
   git branch -M main
   git push -u origin main
   ```

   > If `git push` asks for a password, use a **Personal Access Token** (GitHub no longer
   > accepts your account password on the command line). Create one at
   > <https://github.com/settings/tokens> → "Generate new token (classic)" → check `repo`.

<a name="step-2"></a>
### Step 2 — Turn on GitHub Pages (hosts the front-end with HTTPS)

The camera and screen-share APIs require **HTTPS**. GitHub Pages gives you that for free.

1. In your repo on GitHub: **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **Deploy from a branch**.
3. Set **Branch** to `main` and folder to `/ (root)`. Click **Save**.
4. Wait ~1 minute. The page will show your site URL:
   `https://YOUR-NAME.github.io/watch-together/`. Keep this tab open — you'll use that URL
   in Step 5.

<a name="step-3"></a>
### Step 3 — Deploy the signaling server to Render

1. Go to <https://dashboard.render.com> and sign in (you can sign in with GitHub).
2. **New → Web Service**. Connect your GitHub account and pick the `watch-together` repo.
3. Fill in the service settings:
   | Field | Value |
   |---|---|
   | **Name** | anything, e.g. `watch-together-signal` |
   | **Root Directory** | `server` ← **important** (the server lives in the `server/` subfolder) |
   | **Runtime / Language** | **Node** |
   | **Build Command** | `npm install` |
   | **Start Command** | `npm start` |
   | **Instance Type** | **Free** |
4. Click **Create Web Service**. Render installs `ws` and starts the relay. When it's live,
   Render shows a URL like `https://watch-together-signal.onrender.com`.
5. Confirm it's healthy: open that URL in a browser. You should see a line like
   `watch-together signaling relay OK — rooms: 0`.

> **Heads-up about the free tier (this is normal, not a bug):** Render spins the free
> server **down after ~15 minutes of inactivity**. The next time someone connects, it
> **cold-starts for 30–60 seconds**. The app handles this gracefully — it shows "Waking up
> the server…" and keeps retrying. Just wait; it'll connect. If you want to avoid the wait,
> open the Render URL once a minute before a session, or upgrade off the free tier.

<a name="step-4"></a>
### Step 4 — Wire the front-end to the server (the one line of config)

1. Open **`js/config.js`** in your editor.
2. Find `SIGNALING_URL` near the top and replace the placeholder with your Render URL —
   **but change `https://` to `wss://`** (secure WebSocket):

   ```js
   // Before:
   SIGNALING_URL: "wss://YOUR-SERVICE-NAME.onrender.com",
   // After (example):
   SIGNALING_URL: "wss://watch-together-signal.onrender.com",
   ```

3. Save, commit, and push:

   ```bash
   git add js/config.js
   git commit -m "Point front-end at my Render signaling server"
   git push
   ```

   GitHub Pages redeploys automatically in ~1 minute.

<a name="step-5"></a>
### Step 5 — Open it and test

Open your GitHub Pages URL: `https://YOUR-NAME.github.io/watch-together/`. You'll land in
the **lobby**. Enter a name, copy the **invite link**, and send it to the one person you're
watching with. When you both click **Enter room**, you're connected.

Now jump to the [Manual test plan](#manual-test-plan) to verify everything works — including
a real cross-network test, which is the only way to truly confirm peer-to-peer.

---

<a name="manual-test-plan"></a>
## 3. Manual test plan

WebRTC's real failure modes — NAT traversal, ICE, firewalls — **only appear with two real
browsers on two real networks**. Automated tests can't surface them. So verify in two
passes: a local sanity check, then a true cross-network test.

### Test A — Local sanity check (two windows on one machine)

This confirms the UI, sharing, webcams, and chat all work. (It does **not** prove
peer-to-peer across networks — that's Test B.)

> You must complete Steps 3–4 first: the signaling server has to be deployed and
> `SIGNALING_URL` set, because you can't run the Node server locally without installing Node
> (see [Running the server locally](#local-server) if you want to).

1. Open your GitHub Pages URL in a **Chrome window**. In the lobby, type a name (e.g.
   "Window 1") and click **Copy** to grab the invite link, then **Enter room**.
   - ✅ You should see **"Waiting for your peer to join…"**.
2. Open a **second** window — use an **Incognito window** (Ctrl+Shift+N) or a different
   Chrome profile so it's treated as a separate person — and paste the **same invite link**.
   Enter a different name ("Window 2") and **Enter room**.
   - ✅ Both windows should flip to **connected** within a second or two (the status dot
     goes **green**). The waiting banner disappears.
3. In Window 1, click **Share** in the bottom bar. Pick **Desktop / code** or
   **Video / movie**, then choose a screen/window/tab in the browser picker. To test audio,
   pick a **Chrome tab** and tick **"Share tab audio"**.
   - ✅ The shared content appears on the **stage in BOTH windows**.
   - ✅ If you shared a tab with audio, Window 2 can hear it. (If you shared a *window*,
     there's usually no audio — that's a Chrome limitation; you'll see a note.)
4. In each window, click **Camera** and allow the permission prompt.
   - ✅ A small webcam tile appears floating over the screen (a **PiP**). **Drag** it
     around; **resize** it from the bottom-right corner. Reload — it should reappear where
     you left it.
   - ✅ Your own tile is **mirrored** for you; the other window sees you un-mirrored.
   - Click **Hide me** to hide your own tile; click again to show it.
5. Click **Mic** in one window and allow the prompt. Talk.
   - ✅ The other window hears you. (Use headphones, or you'll get an echo loop between two
     windows on one machine — that's expected here, not a bug.)
6. Type in the **chat** box in each window and press **Enter**.
   - ✅ Messages appear in both. Reload a window — chat history is still there (it persists).
7. Click **Full** (or press **F**) in Window 2 to go fullscreen.
   - ✅ The webcams stay on top and remain **draggable/resizable**. Chat appears as light
     text in the bottom-left that **fades** after a few seconds. Move the mouse, then stop —
     the control bar and **cursor auto-hide** after a few seconds; move again to bring them
     back. Press **Esc** to exit fullscreen.
8. In Window 1, click **Stop** (the Share button) or use Chrome's native "Stop sharing" bar.
   - ✅ The stage in both windows returns to the webcams (video-call view) or the
     **"Click to share content"** prompt if cameras are off.
9. While Window 1 is sharing, click **Share** in Window 2.
   - ✅ Window 2 is **blocked** with "…is already sharing — ask them to stop first." (Only
     one screen occupies the stage at a time.)

### Test B — True cross-network test (this is the real proof)

This confirms the peer-to-peer connection actually punches through real NATs/firewalls.
You need **two different networks**. Easiest options:

- Your laptop on **home Wi-Fi** + a second computer that a friend/partner opens on **their**
  network, **or**
- Your laptop on home Wi-Fi + a **second laptop tethered to your phone's cellular hotspot**
  (cellular is a genuinely different network from your Wi-Fi — perfect for this test).

> Do **not** test cross-network by opening two tabs on the same machine — that's Test A and
> doesn't exercise NAT traversal.

1. On **machine 1** (home Wi-Fi), open the GitHub Pages URL, enter the room, copy the invite
   link, and send it to machine 2 (text/email it to yourself).
2. On **machine 2** (the *other* network — second computer or the cellular-tethered laptop),
   open that same invite link and enter the room.
   - ✅ Both should reach **connected** (green dot). First connect after the server's been
     idle may take up to a minute while Render wakes — wait through "Waking up the server…".
3. Share a screen from machine 1, turn on cameras and mic on both.
   - ✅ Machine 2 sees the screen + both webcams and hears the audio, and vice-versa, across
     the two networks. **This is the real confirmation that P2P works for you.**

**If Test B will not connect** (it sits on "Connecting…" and the dot goes yellow/red while
Test A worked fine), you've likely hit a strict/symmetric NAT or firewall — the ~10–20% of
network pairs that can't punch a direct path. To diagnose:

- In Chrome on either machine, open a new tab to **`chrome://webrtc-internals`** *before*
  connecting, then connect in another tab. Look at the ICE connection state. If it's stuck
  at **`checking`** and never reaches `connected`/`completed`, that's the symptom.
- The fix is to add a **TURN server** — see [Adding a TURN server](#turn). You do **not**
  need TURN unless Test B fails.

---

<a name="using-the-app"></a>
## 4. Using the app day-to-day

- **Your room is permanent and private.** The first time you open the app it generates one
  long, unguessable room code and remembers it. Bookmark your invite link and reuse it
  forever with the same person. (Want a fresh link? **Settings → Regenerate link.**)
- **Whoever you share the link with can join** — there's no password, the unguessable link
  *is* the access control. A third person who somehow had the link just gets "room is full."
- **Controls** (bottom bar, auto-hides): **Share** screen, **Camera**, **Mic**, **Audio**
  (mute the shared screen's audio), **Hide me**, **Chat**, **Settings**, **Full**screen.
- **Keyboard:** **F** = fullscreen, **Enter** = jump to the chat box, **Esc** = exit
  fullscreen / close dialogs.

---

<a name="settings"></a>
## 5. Settings reference

Open **Settings** (gear icon). Everything is saved on your own machine.

- **Room** — view/copy your invite link; **Regenerate** a new one (kills the old link).
- **Display name** — change the name shown in chat and status.
- **Devices** — pick which camera/microphone to use; toggle **echo cancellation** (keep it
  on for talking; turn off only for hi-fi audio with headphones).
- **Video** — **quality cap** (drop to 720p/480p on a weak connection), **mirror** your
  self-view, show a detailed **stats overlay** (bitrate/fps/latency/packet-loss).
- **Chat overlay (fullscreen)** — how long lines stay before **fading**, how many recent
  messages to **permanently pin** in the corner, and chat **text size**.
- **Appearance & notifications** — **accent color**, a **sound** when your peer joins/leaves,
  and how quickly the controls auto-hide.

---

<a name="turn"></a>
## 6. Adding a TURN server (only if a connection ever fails)

**You almost certainly don't need this.** STUN (already configured) is enough for most
networks. But if [Test B](#manual-test-plan) won't connect, a TURN server relays the media
as a fallback when a direct path is impossible.

You have two easy options:

**Option A — a free/managed TURN service** (e.g. [Metered Open
Relay](https://www.metered.ca/tools/openrelay/), or Twilio's NTS). Sign up, get a host,
username, and credential.

**Option B — run your own** [coturn](https://github.com/coturn/coturn) on a small VPS.

Either way, open **`js/config.js`** and uncomment/fill the TURN block inside `ICE_SERVERS`:

```js
ICE_SERVERS: [
  { urls: "stun:stun.l.google.com:19302" },
  {
    urls: ["turn:YOUR-TURN-HOST:3478?transport=udp",
           "turn:YOUR-TURN-HOST:3478?transport=tcp"],
    username: "YOUR_TURN_USERNAME",
    credential: "YOUR_TURN_CREDENTIAL",
  },
],
```

Commit and push. That's it — the app will use TURN automatically when a direct path can't be
found.

> **Note:** TURN relays your media through that server, so it uses the server's bandwidth
> (and on paid/managed services, costs money). That's why it's opt-in and left empty by
> default.

---

<a name="using-brave"></a>
## 7. Using Brave

Brave's privacy features can occasionally interfere with WebRTC. If a connection won't
establish **in Brave specifically** (but works in Chrome/Edge):

1. **Lower Brave Shields for this site:** click the Brave lion icon in the address bar and
   set Shields to **down** for your GitHub Pages site.
2. **Check the WebRTC IP handling policy:** go to **Settings → Privacy and security** and
   look for the **WebRTC IP handling policy**. If it's set to a restrictive mode like
   "Disable non-proxied UDP", switch it to **"Default"** (or "Default public interface
   only"). The restrictive modes can block the candidates WebRTC needs.

This is a Brave configuration note only — the app uses standard WebRTC + STUN/TURN and needs
no code changes for Brave.

---

<a name="local-server"></a>
## 8. Running the signaling server locally (optional)

You don't need this to use the app — the front-end talks to the deployed Render server.
But if you want to develop the server, you need **Node.js 18+** installed (the project
machine doesn't have it by default). Then:

```bash
cd server
npm install
npm start
# → "watch-together signaling relay listening on :10000"
```

Point `js/config.js` at it with `SIGNALING_URL: "ws://localhost:10000"` (plain `ws://`,
since localhost isn't HTTPS), and serve the front-end locally:

```bash
# from the project root (this works with just Python — no Node needed):
py -m http.server 8000
# then open http://localhost:8000/  (localhost is a "secure context", so
# camera/screen APIs work even without HTTPS)
```

> Serving over `http://localhost` is fine for the media APIs. Opening `index.html` directly
> as a `file://` URL is **not** — the APIs are disabled there.

---

<a name="cloudflare"></a>
## 9. Deploying the server to Cloudflare instead of Render

The signaling logic is deliberately isolated in **`server/rooms.js`**, which imports nothing
Node-specific. That makes a Cloudflare Workers + Durable Objects port straightforward if you
ever want to avoid Render's cold starts:

- One **Durable Object per room** holds the two WebSocket connections (use `idFromName(room)`).
- The Worker's `fetch` handler does the WebSocket upgrade (`new WebSocketPair()`), then hands
  the socket to the room's Durable Object via the **WebSocket Hibernation API**
  (`state.acceptWebSocket(server)`), so the room isn't billed/evicted while idle.
- The DO's `webSocketMessage` / `webSocketClose` handlers call into the **same
  `rooms.js`** logic — only the transport shim differs.

This is documented here as a path, not built. Render's free tier is the default.

---

<a name="layout"></a>
## 10. Project layout

```
watch-together/
├─ index.html              Single page: stage, control bar, chat, modals
├─ css/app.css             Dark "theater" theme + all layout
├─ js/
│  ├─ config.js            ★ The one file you edit: SIGNALING_URL, STUN/TURN, tuning
│  ├─ signaling.js         WebSocket client (join handshake, reconnect, cold-start UX)
│  ├─ rtc.js               WebRTC core: peer connection, tracks, negotiation, reconnect
│  ├─ media.js             Camera/screen/mic capture + friendly permission errors
│  ├─ pip.js               Draggable/resizable webcam overlays
│  ├─ chat.js              Chat state, persistence, fading fullscreen overlay
│  └─ ui.js                Orchestrator: wires everything, state machine, settings
├─ server/                 Signaling relay (deploy this to Render; Root Directory = server)
│  ├─ index.js             Node + ws relay; binds $PORT; serves /healthz
│  ├─ rooms.js             Pure room/membership logic (the Cloudflare-portable seam)
│  └─ package.json         start script + ws dependency
├─ README.md               This file
├─ LICENSE                 MIT
└─ .gitignore
```

---

<a name="troubleshooting"></a>
## 11. Troubleshooting

| Symptom | Likely cause & fix |
|---|---|
| Lobby says "Waking up the server…" for ~30–60s | Normal Render free-tier cold start. Wait; it'll connect. To avoid it, hit your Render URL once before a session. |
| "Couldn't reach the signaling server" | `SIGNALING_URL` in `js/config.js` is wrong or still the placeholder. It must be `wss://your-service.onrender.com` (note **wss**, not https). Re-check Step 4. |
| Camera/screen buttons do nothing or error | You must be on **HTTPS** (your GitHub Pages URL) or `http://localhost`. A `file://` page can't use these APIs. Also check the site's permission in the address-bar icon. |
| Connected locally (Test A) but not cross-network (Test B) | Strict/symmetric NAT — add a [TURN server](#turn). Diagnose with `chrome://webrtc-internals` (ICE stuck at `checking`). |
| No audio when sharing | You shared a **window** or **whole screen** without ticking system audio. Share a **Chrome tab** and check **"Share tab audio"** for reliable sound (a Chrome limitation, not the app). |
| Echo when talking | Both sides have mic + speakers picking each other up. Use headphones, or keep echo cancellation on (Settings). On one machine in Test A, echo is expected. |
| It won't work in Firefox/Safari/on my phone | By design — desktop Chromium only (Chrome/Edge/Brave). |
| Brave won't connect but Chrome does | See [Using Brave](#using-brave) — lower Shields and check the WebRTC IP handling policy. |

---

Built for desktop Chrome / Edge / Brave. Media is peer-to-peer; the signaling server only
brokers the handshake and never sees your audio or video.
