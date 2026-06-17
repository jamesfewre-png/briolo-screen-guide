const INTERVAL_MS = 100;
const CONFIDENCE_DECAY = 0.1;
const CONFIDENCE_HIDE_THRESHOLD = 0.35;
const SCROLL_DELTA_THRESHOLD = 20;
const REDETECT_AFTER_MS = 400;

class Tracker {
  constructor({ getPageState, sendOverlay }) {
    this._getPageState = getPageState;
    this._sendOverlay = sendOverlay;
    this._anchor = null;
    this._anchorConfidence = 0;
    this._lastScreenRect = null;
    this._lastScrollY = null;
    this._notFoundSince = null;
    this._hidden = false;
    this._timer = null;
    this._onRedetectNeeded = null;
  }

  setAnchor(anchor) {
    this._anchor = anchor;
    this._anchorConfidence = anchor?.confidence || 0.8;
    this._lastScreenRect = anchor?.screenRect || null;
    this._notFoundSince = null;
    this._hidden = false;
  }

  clearAnchor() {
    this._anchor = null;
    this._anchorConfidence = 0;
    this._lastScreenRect = null;
    this._notFoundSince = null;
    this._hidden = false;
  }

  onRedetectNeeded(cb) { this._onRedetectNeeded = cb; }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), INTERVAL_MS);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  _tick() {
    if (!this._anchor) return;
    const pageState = this._getPageState();
    if (!pageState) return;

    const scrollY = pageState.scroll?.y ?? null;
    const scrolled = this._lastScrollY !== null && scrollY !== null &&
      Math.abs(scrollY - this._lastScrollY) > SCROLL_DELTA_THRESHOLD;
    if (scrollY !== null) this._lastScrollY = scrollY;

    const found = this._findAnchorInState(pageState);

    if (found && found.screenRect) {
      this._notFoundSince = null;
      this._anchorConfidence = Math.min(1, this._anchorConfidence + 0.05);

      const last = this._lastScreenRect;
      const changed = !last ||
        Math.abs(found.screenRect.x - last.x) > 3 || Math.abs(found.screenRect.y - last.y) > 3 ||
        Math.abs(found.screenRect.w - last.w) > 3;

      if (changed) {
        this._lastScreenRect = found.screenRect;
        this._hidden = false;
        this._sendOverlay({
          ...(this._anchor.overlayTemplate || {}),
          highlight: found.screenRect,
          arrow: this._anchor.overlayTemplate?.arrow || { direction: 'target', x: 0.5, y: 0.5 }
        });
      }
    } else if (found && !found.screenRect) {
      this._anchorConfidence -= CONFIDENCE_DECAY;
      if (this._anchorConfidence < CONFIDENCE_HIDE_THRESHOLD && !this._hidden) {
        this._hidden = true;
        this._sendOverlay({ type: 'message', message: 'Checking screen…', confidence: this._anchorConfidence });
      }
    } else {
      if (!this._notFoundSince) this._notFoundSince = Date.now();
      this._anchorConfidence -= CONFIDENCE_DECAY;

      if (scrolled && !this._hidden) {
        this._hidden = true;
        this._sendOverlay({ type: 'message', message: 'Checking screen…', confidence: this._anchorConfidence });
      }

      if (Date.now() - this._notFoundSince > REDETECT_AFTER_MS && this._onRedetectNeeded) {
        this._notFoundSince = Date.now();
        this._onRedetectNeeded();
      }
    }
  }

  _findAnchorInState(pageState) {
    if (!Array.isArray(pageState.elements)) return null;
    if (!this._anchor) {
      return pageState.elements.length > 0 ? pageState.elements[0] : null;
    }
    const { selector, text } = this._anchor;

    if (selector) {
      const bySelector = pageState.elements.find(el => el.selector === selector);
      if (bySelector) return bySelector;
    }

    if (text) {
      const needle = text.toLowerCase().slice(0, 40);
      const byText = pageState.elements.find(el => el.text && el.text.toLowerCase().includes(needle));
      if (byText) return byText;
    }

    return null;
  }
}

module.exports = { Tracker };
