// ---------------------------------------------------------------------------
// rooms.js — PURE room/membership logic for the signaling relay.
//
// This file is deliberately TRANSPORT-AGNOSTIC. It imports nothing — no `ws`,
// no `http`, no Node built-ins. It knows about "connections" only as opaque
// tokens (anything you pass in: a ws socket, a Cloudflare WebSocket, a number).
//
// WHY: this is the single seam that keeps the Cloudflare Workers + Durable
// Objects port (see README) an easy swap rather than a rewrite. The Render
// (`index.js`) and a future Cloudflare adapter both call into THIS logic; only
// the byte-pushing differs. Keep it pure — if you ever `require()` something
// here, you've broken the portability promise.
//
// Model: at most 2 peers per room. Join order is meaningful:
//   - 1st joiner  -> role "wait"  (does nothing until a peer arrives)
//   - 2nd joiner  -> role "offer" (becomes the WebRTC initiator)
// This deterministic initiator is what makes negotiation glare-free: exactly
// one side ever creates the first offer. See js/rtc.js.
// ---------------------------------------------------------------------------

const MAX_PER_ROOM = 2;

class RoomRegistry {
  constructor() {
    /** @type {Map<string, Array<any>>} roomCode -> array of opaque connections */
    this.rooms = new Map();
  }

  /**
   * Attempt to add `conn` to `roomCode`.
   *
   * Returns a result describing what the caller (transport adapter) should do.
   * This function performs NO IO; it only mutates the in-memory map and tells
   * the caller which messages to send.
   *
   * @returns {
   *   { ok: true, role: 'wait', size: 1, peer: null } |
   *   { ok: true, role: 'offer', size: 2, peer: any } |
   *   { ok: false, reason: 'room-full' } |
   *   { ok: false, reason: 'bad-room' } |
   *   { ok: false, reason: 'already-joined' }
   * }
   */
  join(roomCode, conn) {
    if (!isValidRoomCode(roomCode)) {
      return { ok: false, reason: 'bad-room' };
    }

    let members = this.rooms.get(roomCode);
    if (!members) {
      members = [];
      this.rooms.set(roomCode, members);
    }

    if (members.includes(conn)) {
      // Defensive: a client sent `join` twice on the same socket.
      return { ok: false, reason: 'already-joined' };
    }

    if (members.length >= MAX_PER_ROOM) {
      return { ok: false, reason: 'room-full' };
    }

    members.push(conn);

    if (members.length === 1) {
      // First occupant: wait for someone to join.
      return { ok: true, role: 'wait', size: 1, peer: null };
    }

    // Second occupant: this peer initiates the offer; the other peer is the
    // existing occupant, who must be told someone joined.
    const peer = members.find((m) => m !== conn) || null;
    return { ok: true, role: 'offer', size: members.length, peer };
  }

  /**
   * Return the other connection in the same room as `conn`, or null.
   * Used to relay an opaque signaling payload to "the peer".
   */
  peerOf(roomCode, conn) {
    const members = this.rooms.get(roomCode);
    if (!members) return null;
    return members.find((m) => m !== conn) || null;
  }

  /**
   * Return a shallow copy of the connections currently in `roomCode` (empty
   * array if the room doesn't exist). A copy so callers can iterate while
   * mutating the room (e.g. evicting a stale ghost) without skipping entries.
   * Stays transport-pure: the caller decides what an opaque conn means.
   */
  membersOf(roomCode) {
    const members = this.rooms.get(roomCode);
    return members ? members.slice() : [];
  }

  /**
   * Remove `conn` from `roomCode` (idempotent).
   * @returns {{ peer: any|null, roomEmpty: boolean }} the remaining peer (to
   *          notify with `peer-left`) and whether the room is now empty (so the
   *          caller can drop it from the map).
   */
  leave(roomCode, conn) {
    const members = this.rooms.get(roomCode);
    if (!members) return { peer: null, roomEmpty: true };

    const idx = members.indexOf(conn);
    if (idx !== -1) members.splice(idx, 1);

    const peer = members.length ? members[0] : null;
    const roomEmpty = members.length === 0;
    if (roomEmpty) this.rooms.delete(roomCode);

    return { peer, roomEmpty };
  }

  /**
   * Remove `conn` from EVERY room it might be in (used on socket close when we
   * don't trust the client to have told us which room). Returns the list of
   * { roomCode, peer } pairs whose remaining peer should be notified.
   */
  leaveAll(conn) {
    const notify = [];
    for (const [roomCode, members] of this.rooms) {
      if (members.includes(conn)) {
        const { peer } = this.leave(roomCode, conn);
        if (peer) notify.push({ roomCode, peer });
      }
    }
    return notify;
  }

  /** Total occupied rooms — handy for a /healthz body or debugging. */
  roomCount() {
    return this.rooms.size;
  }
}

/**
 * Room codes are user-facing and ride in a URL hash, so keep them tame:
 * 1–64 chars, letters/digits/dash/underscore. Rejecting junk here keeps the
 * `rooms` map from being polluted by malformed or hostile input.
 */
function isValidRoomCode(code) {
  return typeof code === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(code);
}

// CommonJS export (this file is loaded by the Node/Render relay, which has no
// "type":"module" in package.json). We intentionally do NOT add a bare `export`
// statement — that would be a syntax error under CommonJS. For a Cloudflare
// Workers build (ESM), either change this single line to `export { ... }` or add
// `"type":"module"` and a re-export shim. Nothing else in this file needs to
// change to port — that's the whole point of keeping it transport-pure.
const api = { RoomRegistry, isValidRoomCode, MAX_PER_ROOM };
if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
