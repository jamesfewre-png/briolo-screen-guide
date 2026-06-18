(() => {
  // Top-frame guard: with all_frames=true this script runs in every frame.
  // Only the top frame owns DOM scanning + the MutationObserver to avoid
  // duplicate/competing PAGE_STATE messages and clashing highlights.
  // Sub-frames still listen for HIGHLIGHT so a highlight can be drawn there.
  const IS_TOP = (() => {
    try { return window.top === window; } catch (_) { return false; }
  })();

  // Driver.js v1 IIFE exports window.driver.js.driver (factory fn, not class)
  const driverFactory = (typeof window !== 'undefined' && window.driver && window.driver.js)
    ? window.driver.js.driver : null;

  const driverInstance = driverFactory ? driverFactory({
    animate: true,
    overlayColor: 'rgba(0,0,0,0.30)',
    allowClose: false,
    disableActiveInteractionImpact: true,
    stagePadding: 8,
    popoverClass: 'sg-popover',
  }) : null;

  // ── Credential safety ─────────────────────────────────────────────────────
  // Long token-like runs (API keys, secrets, OAuth tokens). Stripped from any
  // visibleText before it ever leaves the page.
  const TOKEN_RE = /[A-Za-z0-9_-]{20,}/g;
  // Labels that mark a field as holding a credential value.
  const SECRET_LABEL_RE = /(token|secret|api[\s_-]?key|\bkey\b|password|passcode|credential)/i;

  function stripTokens(text) {
    if (!text) return '';
    return text.replace(TOKEN_RE, '').replace(/\s+/g, ' ').trim();
  }

  function isSecretInput(el) {
    try {
      const type = (el.getAttribute && el.getAttribute('type') || el.type || '').toLowerCase();
      if (type === 'password') return true;
      // aria-label / name / id / placeholder hinting at a credential field
      const hints = [
        el.getAttribute && el.getAttribute('aria-label'),
        el.getAttribute && el.getAttribute('name'),
        el.getAttribute && el.getAttribute('placeholder'),
        el.id,
      ].filter(Boolean).join(' ');
      if (hints && SECRET_LABEL_RE.test(hints)) return true;
    } catch (_) {}
    return false;
  }

  // ── DOM scan ──────────────────────────────────────────────────────────────
  function scanDOM() {
    const SELECTOR = [
      'button', 'a[href]', 'input:not([type=password])', 'textarea', 'select',
      '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="tab"]',
      '[role="option"]', '[tabindex]', '[aria-label]'
    ].join(',');
    const elements = [];
    let counter = 0;
    try {
      const seen = new Set();
      for (const el of document.querySelectorAll(SELECTOR)) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (counter >= 200) break;
        // Defensive credential exclusion (selector already drops password inputs).
        if (isSecretInput(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
        const sgId = counter++;
        el.setAttribute('data-sg-id', String(sgId));
        const rawText = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        elements.push({
          sgId,
          tag: el.tagName.toLowerCase(),
          visibleText: stripTokens(rawText),
          ariaLabel: stripTokens(el.getAttribute('aria-label') || ''),
          // placeholder/name help match input-targeted steps (empty visibleText).
          // Safe to send: secret fields are already excluded by isSecretInput().
          placeholder: stripTokens(el.getAttribute('placeholder') || ''),
          name: stripTokens(el.getAttribute('name') || ''),
          href: el.href || '',
          isInput: ['input', 'textarea', 'select'].includes(el.tagName.toLowerCase()),
        });
      }
    } catch (_) {}
    return elements;
  }

  // ── Tip div ───────────────────────────────────────────────────────────────
  function showTip(text) {
    let tip = document.getElementById('__sg_tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = '__sg_tip';
      tip.style.cssText = [
        'position:fixed', 'bottom:80px', 'left:50%', 'transform:translateX(-50%)',
        'background:#1a1a2e', 'color:#e8e8f0', 'border:1.5px solid #ff8a00',
        'border-radius:8px', 'padding:10px 16px', 'font-size:13px',
        'z-index:2147483647', 'pointer-events:none', 'max-width:360px',
        'text-align:center', 'box-shadow:0 4px 20px rgba(0,0,0,0.5)',
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
      ].join(';');
      document.documentElement.appendChild(tip);
    }
    tip.textContent = text;
  }

  function clearTip() {
    document.getElementById('__sg_tip')?.remove();
  }

  // ── Scroll-into-view fallback ─────────────────────────────────────────────
  function isOffScreen(el) {
    try {
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      const vw = window.innerWidth || document.documentElement.clientWidth;
      return r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw;
    } catch (_) { return false; }
  }

  function scrollIntoViewIfNeeded(el) {
    try {
      if (isOffScreen(el)) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      }
    } catch (_) {}
  }

  // ── Completion tracking ───────────────────────────────────────────────────
  // Clicks complete a step. For input/textarea/select targets (which the user
  // TYPES into rather than clicks), a committed value change also completes the
  // step — so type-only steps auto-advance without a manual "Mark Complete".
  let watchedEl = null;
  let watchedCleanup = null;

  function attachClickCompletion(el) {
    if (watchedCleanup) { try { watchedCleanup(); } catch (_) {} watchedCleanup = null; }
    watchedEl = el;

    let done = false;
    const fire = () => {
      if (done) return;
      done = true;
      if (watchedCleanup) { try { watchedCleanup(); } catch (_) {} watchedCleanup = null; }
      watchedEl = null;
      try {
        chrome.runtime.sendMessage({ type: 'STEP_COMPLETE' }, () => void chrome.runtime.lastError);
      } catch (_) {}
    };

    const onClick = () => fire();
    el.addEventListener('click', onClick);

    let onChange = null;
    const isField = ['input', 'textarea', 'select'].includes((el.tagName || '').toLowerCase());
    if (isField) {
      // 'change' fires on commit (blur after edit / option select) — advance only
      // once the field actually holds a value.
      onChange = () => { if ((el.value || '').trim()) fire(); };
      el.addEventListener('change', onChange);
    }

    watchedCleanup = () => {
      try { el.removeEventListener('click', onClick); } catch (_) {}
      if (onChange) { try { el.removeEventListener('change', onChange); } catch (_) {} }
    };
  }

  // ── Message listener ──────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'HIGHLIGHT') {
      clearTip();
      if (msg.sgId !== null && msg.sgId !== undefined) {
        const el = document.querySelector('[data-sg-id="' + msg.sgId + '"]');
        // Verify the element still exists in the live DOM before highlighting /
        // attaching a click listener — it may have been removed since the scan.
        if (el && document.contains(el)) {
          scrollIntoViewIfNeeded(el);
          if (driverInstance) {
            try {
              driverInstance.highlight({
                element: el,
                popover: {
                  title: msg.stepName || 'Next Step',
                  description: msg.instruction || '',
                  side: 'bottom',
                  align: 'start',
                }
              });
            } catch (_) {
              el.style.outline = '3px solid #ff8a00';
              el.style.outlineOffset = '2px';
              showTip(msg.instruction);
            }
          } else {
            // No driver.js available — outline + tip fallback.
            try {
              el.style.outline = '3px solid #ff8a00';
              el.style.outlineOffset = '2px';
            } catch (_) {}
            showTip(msg.instruction || 'Click the highlighted item');
          }
          attachClickCompletion(el);
          return;
        }
      }
      // No element found (or it was removed) — show tip.
      if (driverInstance) try { driverInstance.destroy(); } catch (_) {}
      showTip(msg.fallback || msg.instruction || 'Scroll to find the next step');
    }

    if (msg.type === 'SHOW_TIP') {
      if (driverInstance) try { driverInstance.destroy(); } catch (_) {}
      showTip(msg.text);
    }

    if (msg.type === 'CLEAR') {
      if (driverInstance) try { driverInstance.destroy(); } catch (_) {}
      clearTip();
    }
  });

  // ── Sub-frames stop here: they listen for HIGHLIGHT but never scan/observe ──
  if (!IS_TOP) return;

  // ── Initial scan + send (top frame only) ───────────────────────────────────
  function sendState() {
    try {
      const elements = scanDOM();
      chrome.runtime.sendMessage({ type: 'PAGE_STATE', elements, url: location.href }, () => void chrome.runtime.lastError);
    } catch (_) {}
  }

  sendState();

  // ── Re-scan on DOM changes (debounced, top frame only) ─────────────────────
  let debounce = null;
  const mo = new MutationObserver(() => {
    clearTimeout(debounce);
    debounce = setTimeout(sendState, 400);
  });
  try {
    mo.observe(document.body || document.documentElement, { childList: true, subtree: true });
  } catch (_) {}

  window.addEventListener('scroll', () => { clearTimeout(debounce); debounce = setTimeout(sendState, 400); }, { passive: true });

  // ── SPA URL-change detection (top frame only) ──────────────────────────────
  // Meta Business Suite is a single-page app: route changes often DON'T fire
  // chrome.tabs.onUpdated('complete'). We re-send PAGE_STATE (which carries the
  // new location.href) on every URL change so the background can run its
  // URL-pattern auto-advance for SPA navigation, not just hard page loads.
  let lastHref = location.href;
  function onUrlMaybeChanged() {
    if (location.href !== lastHref) {
      lastHref = location.href;
      sendState();
    }
  }
  for (const fn of ['pushState', 'replaceState']) {
    const orig = history[fn];
    if (typeof orig === 'function') {
      history[fn] = function () {
        const r = orig.apply(this, arguments);
        try { onUrlMaybeChanged(); } catch (_) {}
        return r;
      };
    }
  }
  window.addEventListener('popstate', onUrlMaybeChanged);
  // Backstop for routers that mutate the URL without using the history API.
  setInterval(onUrlMaybeChanged, 1000);
})();
