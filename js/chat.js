// ===========================================================================
// chat.js — chat state + rendering. Transport is the RTCDataChannel (wired in
// ui.js); this module owns the message list, persistence, and the two views:
//
//   1) PANEL view  — the normal side panel (windowed mode): full scrollback.
//   2) OVERLAY view — fullscreen, non-intrusive: recent lines as light text in
//      the bottom-left corner with NO background. Each line fades out
//      `chatFadeSeconds` after the newest message arrives. Optionally the last
//      `chatPinnedCount` messages stay permanently pinned (no fade).
//
// Persistence: messages are saved per-room in localStorage so a reload or brief
// drop doesn't lose the conversation. A Clear button wipes both view and store.
// Unread count (while the panel is hidden) is exposed for the tab-title badge.
// ===========================================================================

import { CONFIG, STORAGE_KEYS } from "./config.js";

function historyKey(roomCode) {
  return `${STORAGE_KEYS.CHAT_HISTORY}.${roomCode}`;
}

// Match bare http/https URLs. Kept deliberately conservative — only these two
// schemes ever become links (no javascript:/data: etc.), which is half of why
// this is XSS-safe; the other half is that we build real text + anchor NODES
// below and never touch innerHTML.
const URL_RE = /https?:\/\/[^\s]+/g;

/**
 * Append `text` to `parent`, turning any http(s) URLs into safe clickable
 * links. Everything is added as DOM nodes (createTextNode / <a>), so message
 * content is never parsed as HTML — a peer can't inject markup. Trailing
 * punctuation like a period or closing paren is kept out of the href.
 */
function appendLinkified(parent, text) {
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index;
    if (start > last) parent.appendChild(document.createTextNode(text.slice(last, start)));
    let url = m[0];
    let trailing = "";
    // Don't swallow trailing sentence punctuation into the link.
    const trail = url.match(/[).,!?;:'"]+$/);
    if (trail) {
      trailing = trail[0];
      url = url.slice(0, -trailing.length);
    }
    const a = document.createElement("a");
    a.className = "chat-link";
    a.href = url;
    a.textContent = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    parent.appendChild(a);
    if (trailing) parent.appendChild(document.createTextNode(trailing));
    last = start + m[0].length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

export class Chat {
  /**
   * @param {object} refs DOM refs:
   *   { panel, panelList, overlay, input, form, clearBtn, unreadBadge }
   * @param {string} roomCode  for per-room persistence
   * @param {() => object} getSettings  returns live settings (fade secs, pinned count, text size)
   * @param {(text:string) => void} onSend  called when the user submits a line
   */
  constructor(refs, roomCode, getSettings, onSend) {
    this.refs = refs;
    this.roomCode = roomCode;
    this.getSettings = getSettings;
    this.onSend = onSend;

    this.messages = this._load(); // [{ id, from, self, text, ts }]
    this.unread = 0;
    this.panelVisible = true; // ui.js toggles this
    this.fadeTimers = new Map(); // messageId -> timeout (overlay fade)

    this._bind();
    this._renderAll();
  }

  // --- persistence ---------------------------------------------------------
  _load() {
    try {
      return JSON.parse(localStorage.getItem(historyKey(this.roomCode))) || [];
    } catch (_err) {
      return [];
    }
  }
  _save() {
    try {
      // Cap stored history so localStorage can't grow without bound.
      const trimmed = this.messages.slice(-500);
      localStorage.setItem(historyKey(this.roomCode), JSON.stringify(trimmed));
    } catch (_err) {
      /* storage disabled/full — chat still works in-memory this session */
    }
  }

  _bind() {
    this.refs.form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = this.refs.input.value.trim();
      if (!text) return;
      this.refs.input.value = "";
      this.onSend(text);
    });
    if (this.refs.clearBtn) {
      this.refs.clearBtn.addEventListener("click", () => this.clear());
    }
  }

  // --- public API ----------------------------------------------------------
  /** Add a message authored locally. */
  addLocal(text, fromName) {
    this._add({ from: fromName || "You", self: true, text });
  }

  /** Add a message received from the peer. */
  addRemote(text, fromName) {
    this._add({ from: fromName || "Peer", self: false, text });
    if (!this.panelVisible) {
      this.unread += 1;
      this._renderUnread();
    }
  }

  /** Add a neutral system line (e.g. "Alice joined"). Not persisted. */
  addSystem(text) {
    const msg = { id: this._nextId(), from: null, self: false, text, ts: Date.now(), system: true };
    this._renderOne(msg, /*animate*/ true);
  }

  setPanelVisible(visible) {
    this.panelVisible = visible;
    if (visible) {
      this.unread = 0;
      this._renderUnread();
      // Jump to newest when reopening.
      this.refs.panelList.scrollTop = this.refs.panelList.scrollHeight;
    }
  }

  /**
   * Rebind to a different room (used by Settings → Regenerate link). Without
   * this, chat kept persisting under the OLD room's storage key and showed the
   * old scrollback. We just switch keys and reload — no history migration.
   */
  setRoom(roomCode) {
    if (roomCode === this.roomCode) return;
    this.roomCode = roomCode;
    this.fadeTimers.forEach((t) => clearTimeout(t));
    this.fadeTimers.clear();
    this.messages = this._load();
    this.unread = 0;
    this._renderAll();
  }

  /** Re-apply settings that affect rendering (text size, pinned count, fade). */
  applySettings() {
    const s = this.getSettings();
    // Set on :root so EVERY consumer inherits it — the panel, the corner overlay
    // lines, AND the fullscreen overlay input (which lives in a sibling subtree
    // of #chatOverlay and so never inherited a value set only on the overlay).
    document.documentElement.style.setProperty("--chat-text-size", `${s.chatTextSize}px`);
    // Re-render overlay so pinned-count / fade changes take effect immediately.
    this._renderOverlay();
  }

  clear() {
    this.messages = [];
    this._save();
    this.refs.panelList.innerHTML = "";
    this.refs.overlay.innerHTML = "";
    this.fadeTimers.forEach((t) => clearTimeout(t));
    this.fadeTimers.clear();
    this.unread = 0;
    this._renderUnread();
  }

  // --- internals -----------------------------------------------------------
  _nextId() {
    this._idCounter = (this._idCounter || 0) + 1;
    return `m${Date.now()}_${this._idCounter}`;
  }

  _add({ from, self, text }) {
    const msg = { id: this._nextId(), from, self, text, ts: Date.now() };
    this.messages.push(msg);
    this._save();
    this._renderOne(msg, /*animate*/ true);
  }

  _renderAll() {
    this.refs.panelList.innerHTML = "";
    this.refs.overlay.innerHTML = "";
    for (const msg of this.messages) this._renderOne(msg, /*animate*/ false);
    this.applySettings();
    this._renderUnread();
  }

  _renderOne(msg, animate) {
    // --- panel line (full scrollback) ---
    const line = document.createElement("div");
    line.className = "chat-line" + (msg.self ? " self" : msg.system ? " system" : " peer");
    if (msg.system) {
      line.textContent = msg.text;
    } else {
      const who = document.createElement("span");
      who.className = "chat-who";
      who.textContent = msg.from ? `${msg.from}: ` : "";
      const body = document.createElement("span");
      body.className = "chat-body";
      appendLinkified(body, msg.text); // builds text + <a> nodes — XSS-safe
      line.appendChild(who);
      line.appendChild(body);
    }
    this.refs.panelList.appendChild(line);
    this.refs.panelList.scrollTop = this.refs.panelList.scrollHeight;

    // --- overlay line (fullscreen corner) ---
    this._renderOverlayLine(msg, animate);
  }

  _renderOverlayLine(msg) {
    const o = document.createElement("div");
    o.className = "chat-overlay-line" + (msg.self ? " self" : msg.system ? " system" : " peer");
    o.dataset.id = msg.id;
    if (msg.system) {
      o.textContent = msg.text;
    } else {
      o.textContent = msg.from ? `${msg.from}: ${msg.text}` : msg.text;
    }
    this.refs.overlay.appendChild(o);

    // Keep the overlay DOM bounded: only the most recent ~12 lines live here.
    while (this.refs.overlay.children.length > 12) {
      const first = this.refs.overlay.firstChild;
      const id = first.dataset?.id;
      if (id && this.fadeTimers.has(id)) {
        clearTimeout(this.fadeTimers.get(id));
        this.fadeTimers.delete(id);
      }
      first.remove();
    }

    this._applyFadeRules();
  }

  /**
   * Decide which overlay lines are pinned (never fade) vs. fading. The last
   * `chatPinnedCount` messages are pinned; everything else fades `fadeSeconds`
   * after it appeared. Called on every new line and whenever settings change.
   */
  _applyFadeRules() {
    const s = this.getSettings();
    const fadeMs = Math.max(1, s.chatFadeSeconds) * 1000;
    const pinned = Math.max(0, s.chatPinnedCount | 0);

    const lines = Array.from(this.refs.overlay.children);
    const pinnedFrom = pinned > 0 ? Math.max(0, lines.length - pinned) : lines.length;

    lines.forEach((el, idx) => {
      const id = el.dataset.id;
      const isPinned = idx >= pinnedFrom;
      // Clear any prior timer; we recompute fresh each pass.
      if (this.fadeTimers.has(id)) {
        clearTimeout(this.fadeTimers.get(id));
        this.fadeTimers.delete(id);
      }
      if (isPinned) {
        el.classList.remove("faded");
        return;
      }
      el.classList.remove("faded"); // visible now…
      const t = setTimeout(() => el.classList.add("faded"), fadeMs); // …fade later
      this.fadeTimers.set(id, t);
    });
  }

  _renderOverlay() {
    // Re-apply fade/pin rules to the overlay lines ALREADY in the DOM, rather
    // than tearing down and rebuilding from this.messages. A rebuild would drop
    // system lines ("Peer left." etc.), which are intentionally not stored in
    // this.messages — so a stray settings nudge used to erase them mid-session.
    // The overlay DOM is kept in sync incrementally by _renderOverlayLine/clear,
    // so reconciling in place is sufficient (text size is applied via the CSS
    // var in applySettings, independent of this).
    this._applyFadeRules();
  }

  _renderUnread() {
    // The optional badge element is updated only if present…
    if (this.refs.unreadBadge) {
      if (this.unread > 0) {
        this.refs.unreadBadge.textContent = String(this.unread);
        this.refs.unreadBadge.classList.add("show");
      } else {
        this.refs.unreadBadge.classList.remove("show");
      }
    }
    // …but the event ALWAYS fires — ui.js drives the tab-title badge off it, and
    // ui.js intentionally passes no badge element. (Don't move this behind the
    // null check above, or the tab title would never update.)
    this.refs.panel.dispatchEvent(
      new CustomEvent("chat-unread", { detail: { unread: this.unread }, bubbles: true })
    );
  }
}
