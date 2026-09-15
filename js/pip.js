// ===========================================================================
// pip.js — draggable + resizable picture-in-picture webcam overlays.
//
// Each PiP is an absolutely-positioned element inside the stage container, so
// it floats on top of the shared screen AND stays on top in fullscreen (we
// fullscreen the stage container, not a bare <video>). Two instances exist:
// "self" (your mirrored camera) and "peer" (their camera).
//
// Behavior (per your spec):
//   - Free drag anywhere; resize via a bottom-right handle.
//   - Position + size remembered per-PiP in localStorage, restored next time.
//   - Soft-clamped so a PiP can't be dragged fully off-screen.
//   - Uses Pointer Events so mouse works (touch is out of scope but harmless).
//
// This module is purely the floating-window mechanics. WHAT goes in the <video>
// (which track, mirrored or not, shown/hidden) is decided by ui.js.
// ===========================================================================

import { STORAGE_KEYS } from "./config.js";

const MIN_W = 120; // px — don't let a PiP shrink to nothing
const MIN_H = 90;
const EDGE_MARGIN = 16; // keep at least this many px on-screen when clamping

function loadLayout() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.PIP_LAYOUT)) || {};
  } catch (_err) {
    return {};
  }
}
function saveLayout(layout) {
  try {
    localStorage.setItem(STORAGE_KEYS.PIP_LAYOUT, JSON.stringify(layout));
  } catch (_err) {
    /* storage full / disabled — non-fatal, just won't persist */
  }
}

export class PipOverlay {
  /**
   * @param {string} id "self" | "peer" — also the localStorage layout key.
   * @param {HTMLElement} stage the stage container the PiP floats within.
   * @param {object} opts { defaultCorner, defaultSize:{w,h}, mirrored, label }
   */
  constructor(id, stage, opts = {}) {
    this.id = id;
    this.stage = stage;
    this.opts = opts;
    this.hidden = false;

    // --- DOM ---------------------------------------------------------------
    this.el = document.createElement("div");
    this.el.className = `pip pip-${id}`;
    this.el.setAttribute("role", "group");
    this.el.setAttribute("aria-label", opts.label || `${id} camera`);

    this.video = document.createElement("video");
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = true; // a PiP never plays audio (audio flows via main path)
    if (opts.mirrored) this.video.classList.add("mirrored");
    this.el.appendChild(this.video);

    this.labelEl = document.createElement("span");
    this.labelEl.className = "pip-label";
    this.labelEl.textContent = opts.label || "";
    this.el.appendChild(this.labelEl);

    this.handle = document.createElement("div");
    this.handle.className = "pip-resize-handle";
    this.handle.setAttribute("aria-hidden", "true");
    this.el.appendChild(this.handle);

    this.stage.appendChild(this.el);

    // --- restore or default position/size ---------------------------------
    const saved = loadLayout()[id];
    if (saved) {
      this._setRect(saved.x, saved.y, saved.w, saved.h, /*clampOnly*/ true);
    } else {
      this._applyDefault();
    }

    // --- interaction -------------------------------------------------------
    this._bindDrag();
    this._bindResize();

    // Re-clamp on stage resize / fullscreen transitions so a PiP never strands
    // off the new viewport.
    this._resizeObserver = new ResizeObserver(() => this._clampIntoView());
    this._resizeObserver.observe(this.stage);
  }

  _applyDefault() {
    const { w, h } = this.opts.defaultSize || { w: 240, h: 180 };
    // Wait a tick so the stage has dimensions; fall back to sensible offsets.
    const sr = this.stage.getBoundingClientRect();
    const corner = this.opts.defaultCorner || "bottom-right";
    let x = sr.width - w - EDGE_MARGIN;
    let y = sr.height - h - EDGE_MARGIN;
    if (corner.includes("top")) y = EDGE_MARGIN;
    if (corner.includes("left")) x = EDGE_MARGIN;
    // self in bottom-right, peer in bottom-left by default so they don't stack
    this._setRect(Math.max(EDGE_MARGIN, x), Math.max(EDGE_MARGIN, y), w, h);
  }

  _setRect(x, y, w, h, clampOnly = false) {
    this._x = x;
    this._y = y;
    this._w = Math.max(MIN_W, w);
    this._h = Math.max(MIN_H, h);
    this.el.style.width = `${this._w}px`;
    this.el.style.height = `${this._h}px`;
    this.el.style.left = `${this._x}px`;
    this.el.style.top = `${this._y}px`;
    if (!clampOnly) this._clampIntoView();
  }

  _clampIntoView() {
    const sr = this.stage.getBoundingClientRect();
    if (sr.width === 0 || sr.height === 0) return; // stage not laid out yet

    // First make sure the PiP isn't larger than the stage (minus a margin).
    const w = Math.min(this._w, Math.max(MIN_W, sr.width - EDGE_MARGIN));
    const h = Math.min(this._h, Math.max(MIN_H, sr.height - EDGE_MARGIN));

    // Allow the PiP to hang partly off any edge, but always keep a grabbable
    // sliver (SLIVER px) on-screen so it can never be lost. Left/top bounds:
    //   x in [SLIVER - w, sr.width - SLIVER]
    //   y in [0,         sr.height - SLIVER]   (never hide above the top edge)
    const SLIVER = EDGE_MARGIN * 3;
    const x = Math.max(SLIVER - w, Math.min(this._x, sr.width - SLIVER));
    const y = Math.max(0, Math.min(this._y, sr.height - SLIVER));

    this._x = x;
    this._y = y;
    this._w = w;
    this._h = h;
    this.el.style.left = `${x}px`;
    this.el.style.top = `${y}px`;
    this.el.style.width = `${w}px`;
    this.el.style.height = `${h}px`;
  }

  _persist() {
    const layout = loadLayout();
    layout[this.id] = { x: this._x, y: this._y, w: this._w, h: this._h };
    saveLayout(layout);
  }

  _bindDrag() {
    let startX, startY, origX, origY, dragging = false;
    const onDown = (e) => {
      // Don't start a drag from the resize handle.
      if (e.target === this.handle) return;
      dragging = true;
      this.el.classList.add("dragging");
      startX = e.clientX;
      startY = e.clientY;
      origX = this._x;
      origY = this._y;
      this.el.setPointerCapture(e.pointerId);
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!dragging) return;
      this._setRect(origX + (e.clientX - startX), origY + (e.clientY - startY), this._w, this._h);
    };
    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      this.el.classList.remove("dragging");
      try {
        this.el.releasePointerCapture(e.pointerId);
      } catch (_err) {
        /* ignore */
      }
      this._persist();
    };
    this.el.addEventListener("pointerdown", onDown);
    this.el.addEventListener("pointermove", onMove);
    this.el.addEventListener("pointerup", onUp);
    this.el.addEventListener("pointercancel", onUp);
  }

  _bindResize() {
    let startX, startY, origW, origH, resizing = false;
    const onDown = (e) => {
      resizing = true;
      this.el.classList.add("resizing");
      startX = e.clientX;
      startY = e.clientY;
      origW = this._w;
      origH = this._h;
      this.handle.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    };
    const onMove = (e) => {
      if (!resizing) return;
      this._setRect(
        this._x,
        this._y,
        origW + (e.clientX - startX),
        origH + (e.clientY - startY)
      );
    };
    const onUp = (e) => {
      if (!resizing) return;
      resizing = false;
      this.el.classList.remove("resizing");
      try {
        this.handle.releasePointerCapture(e.pointerId);
      } catch (_err) {
        /* ignore */
      }
      this._persist();
    };
    this.handle.addEventListener("pointerdown", onDown);
    this.handle.addEventListener("pointermove", onMove);
    this.handle.addEventListener("pointerup", onUp);
    this.handle.addEventListener("pointercancel", onUp);
  }

  // --- public API used by ui.js -------------------------------------------
  setStream(stream) {
    this.video.srcObject = stream || null;
    if (stream) {
      // Autoplay can reject if not yet allowed; muted PiP should always play.
      this.video.play().catch(() => {});
    }
  }

  setLabel(text) {
    this.labelEl.textContent = text || "";
  }

  setMirrored(on) {
    this.video.classList.toggle("mirrored", !!on);
  }

  /** Show/hide this PiP. Hiding keeps the stream attached (cheap to restore). */
  setHidden(hidden) {
    this.hidden = !!hidden;
    this.el.classList.toggle("hidden", this.hidden);
  }

  /** Whether there's an active stream attached. */
  hasStream() {
    return !!this.video.srcObject;
  }

  destroy() {
    try {
      this._resizeObserver.disconnect();
    } catch (_err) {
      /* ignore */
    }
    this.video.srcObject = null;
    this.el.remove();
  }
}
