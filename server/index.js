// ---------------------------------------------------------------------------
// index.js — WebSocket signaling RELAY (Render free-tier entry point).
//
// This process does exactly ONE job: shuttle WebRTC handshake messages (SDP
// offer/answer + ICE candidates, plus a couple of tiny control messages)
// between the two peers in a room. It NEVER sees or proxies media — audio and
// video travel peer-to-peer directly between the browsers. Keeping media off
// this server is what makes free hosting viable (the only bytes here are a few
// KB of JSON per connection).
//
// It also answers plain HTTP on `/` and `/healthz` so Render's health check
// (which hits `/`) marks the service healthy — a WebSocket-only server would
// look "down" to that check and get killed.
//
// Transport lives here; ROOM LOGIC lives in rooms.js (pure, no imports). That
// split is the seam that lets you port the relay to Cloudflare Workers +
// Durable Objects later without touching the membership logic. See README.
// ---------------------------------------------------------------------------

'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');
const { RoomRegistry } = require('./rooms');

// Render injects the port to bind via process.env.PORT. Hardcoding a port makes
// the health check fail. Fall back to 10000 for local `node index.js` runs.
const PORT = process.env.PORT || 10000;

// Heartbeat: ping every client every 30s; if a socket misses a pong, it's dead
// (half-open TCP behind a NAT that vanished). This keeps the room map honest so
// a ghost peer doesn't hold a room slot forever.
const HEARTBEAT_MS = 30_000;

const registry = new RoomRegistry();

// --- Plain HTTP server (health checks + a friendly root) --------------------
const server = http.createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/') {
    // charset=utf-8 so the em-dash renders correctly (without it, browsers
    // fall back to Windows-1252 and show mojibake like "â€”").
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`watch-together signaling relay OK — rooms: ${registry.roomCount()}\n`);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found\n');
});

// --- WebSocket server (the actual signaling) --------------------------------
// We attach ws to the same HTTP server so one port serves both health checks
// and the WS upgrade — required on Render (single bound port).
//
// maxPayload caps any single inbound frame. Real signaling frames (SDP + ICE)
// are a few KB; 64 KiB is comfortably above that. Without a cap the ws default
// is 100 MB, so one oversized frame from a client that knows a (leakable) room
// code could amplify memory/bandwidth on the single shared free-tier box. ws
// closes connections that exceed this automatically.
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

/**
 * Send a JSON object to a socket if it's open. Swallows send errors (a peer can
 * vanish between our decision to send and the actual write).
 */
function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (_err) {
      /* peer went away mid-send; nothing to do */
    }
  }
}

wss.on('connection', (ws) => {
  // Per-socket state. `room` is set on join. `isAlive` drives the heartbeat.
  // `peerId` is a stable per-tab token the client repeats on every (re)join so
  // the server can recognise a returning peer and reap its own stale ghost.
  ws.room = null;
  ws.peerId = null;
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_err) {
      return; // ignore non-JSON noise
    }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'join': {
        // Remember who this socket is (stable across the client's WS reconnects)
        // so we can reclaim its slot from a stale ghost below.
        ws.peerId = typeof msg.peerId === 'string' ? msg.peerId : null;

        // A socket may only be in one room at a time. If it tries to join a new
        // room while already in one, treat it as leaving the old one first.
        if (ws.room && ws.room !== msg.room) {
          handleLeave(ws);
        }

        // Ghost reclaim (fixes the reconnect lockout): when a peer's TCP goes
        // half-open silently (sleep/Wi-Fi roam), the server doesn't notice until
        // the heartbeat sweep (up to ~60s away), so the dead socket still holds a
        // room slot. The browser detects the drop in seconds and reconnects on a
        // NEW socket, re-sending join with the SAME peerId. If we see a member
        // with that id already present, it can only be this same client's ghost —
        // evict it now so the returning peer isn't told "room-full" for its own
        // room. A genuine third device has a different peerId and is unaffected.
        if (ws.peerId) {
          for (const stale of registry.membersOf(msg.room)) {
            if (stale !== ws && stale.peerId === ws.peerId) {
              // Null the room first so the terminated socket's later 'close'
              // handler no-ops (it won't find itself and won't spuriously tell
              // the surviving peer we left — they're about to be re-paired).
              stale.room = null;
              registry.leave(msg.room, stale);
              try {
                stale.terminate();
              } catch (_err) {
                /* already gone */
              }
            }
          }
        }

        const result = registry.join(msg.room, ws);
        if (!result.ok) {
          // room-full / bad-room / already-joined → tell the client, don't crash.
          send(ws, { type: result.reason });
          return;
        }
        ws.room = msg.room;
        if (result.role === 'wait') {
          // First occupant: sit tight until a peer arrives.
          send(ws, { type: 'joined' });
        } else {
          // Second occupant: YOU are the initiator — create the offer.
          send(ws, { type: 'ready' });
          // Tell the first occupant their peer arrived (waiting → connecting).
          send(result.peer, { type: 'peer-joined' });
        }
        break;
      }

      case 'signal': {
        // Opaque relay: forward msg.data verbatim to the other peer. The server
        // does NOT inspect SDP/ICE — it's just a pipe. This is what keeps the
        // logic portable and the server dumb.
        const peer = registry.peerOf(ws.room, ws);
        if (peer) send(peer, { type: 'signal', data: msg.data });
        break;
      }

      case 'bye': {
        // Graceful leave (e.g. user closed the tab cleanly via beforeunload).
        handleLeave(ws);
        break;
      }

      default:
        // Unknown type — ignore. Forward-compatible.
        break;
    }
  });

  ws.on('close', () => handleLeave(ws));
  ws.on('error', () => handleLeave(ws));
});

/**
 * Remove a socket from its room and notify the remaining peer (if any) that
 * their partner left, so they can tear down the PC and show "peer left".
 * Idempotent — safe to call from both `bye` and `close`.
 */
function handleLeave(ws) {
  if (!ws.room) {
    // Not in a tracked room, but sweep all rooms defensively in case state
    // drifted (shouldn't happen, but cheap insurance).
    const stray = registry.leaveAll(ws);
    for (const { peer } of stray) send(peer, { type: 'peer-left' });
    return;
  }
  const { peer } = registry.leave(ws.room, ws);
  ws.room = null;
  if (peer) send(peer, { type: 'peer-left' });
}

// --- Heartbeat sweep --------------------------------------------------------
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      // Missed the last pong → terminate. The 'close' handler cleans up the room.
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (_err) {
      /* ignore */
    }
  }
}, HEARTBEAT_MS);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`watch-together signaling relay listening on :${PORT}`);
});
