(() => {
  // Top-frame guard: with all_frames=true this script runs in every frame.
  // Only the top frame owns DOM scanning + the MutationObserver to avoid
  // duplicate/competing PAGE_STATE messages and clashing highlights.
  // Sub-frames still listen for HIGHLIGHT so a highlight can be drawn there.
  const IS_TOP = (() => {
    try { return window.top === window; } catch (_) { return false; }
  })();

  // Diagnostic: confirms THIS (fresh) content script is live on the page. If you
  // reload the extension you MUST refresh the page — otherwise the old orphaned
  // script runs and highlights never appear.
  try { console.log('[ScreenGuide] content script loaded BUILD v0.5.4', { top: IS_TOP, url: location.href }); } catch (_) {}

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
        // Skip our own guide UI (driver.js popover + tip) so drawing a highlight
        // doesn't change the page signature and trigger a re-evaluation loop.
        try { if (el.closest && (el.closest('.driver-popover') || el.id === '__sg_tip')) continue; } catch (_) {}
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

  // ── Animated highlight ring ────────────────────────────────────────────────
  // A glowing, pulsing ring drawn over the target element. pointer-events:none so
  // the human can still click straight through it. It tracks the element via rAF,
  // so it stays glued to the target during scroll and layout changes.
  let hlEl = null;       // the ring node
  let hlTarget = null;   // the element being highlighted
  let hlRaf = null;      // requestAnimationFrame handle

  function ensureHighlightNodes() {
    if (!document.getElementById('__sg_hl_style')) {
      const st = document.createElement('style');
      st.id = '__sg_hl_style';
      st.textContent =
        '@keyframes __sg_pulse{' +
        '0%,100%{box-shadow:0 0 0 3px rgba(255,138,0,.40),0 0 14px 3px rgba(255,138,0,.45)}' +
        '50%{box-shadow:0 0 0 7px rgba(255,138,0,.18),0 0 30px 10px rgba(255,138,0,.85)}}';
      document.documentElement.appendChild(st);
    }
    if (!hlEl) {
      hlEl = document.createElement('div');
      hlEl.id = '__sg_highlight';
      hlEl.style.cssText = [
        'position:fixed', 'z-index:2147483646', 'pointer-events:none',
        'box-sizing:border-box', 'border:3px solid #ff8a00', 'border-radius:8px',
        'background:rgba(255,138,0,0.08)',
        'transition:top .12s ease,left .12s ease,width .12s ease,height .12s ease',
        'animation:__sg_pulse 1.25s ease-in-out infinite', 'display:none'
      ].join(';');
      document.documentElement.appendChild(hlEl);
    }
  }

  function positionHighlight() {
    if (!hlTarget || !hlEl) return;
    if (!document.contains(hlTarget)) { clearHighlight(); return; }
    const r = hlTarget.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) { hlEl.style.display = 'none'; return; }
    const pad = 4;
    hlEl.style.display = 'block';
    hlEl.style.top = (r.top - pad) + 'px';
    hlEl.style.left = (r.left - pad) + 'px';
    hlEl.style.width = (r.width + pad * 2) + 'px';
    hlEl.style.height = (r.height + pad * 2) + 'px';
  }

  function trackHighlight() {
    positionHighlight();
    hlRaf = requestAnimationFrame(trackHighlight);
  }

  function showHighlight(el) {
    ensureHighlightNodes();
    hlTarget = el;
    positionHighlight();
    if (!hlRaf) trackHighlight();
  }

  function clearHighlight() {
    hlTarget = null;
    if (hlRaf) { cancelAnimationFrame(hlRaf); hlRaf = null; }
    if (hlEl) hlEl.style.display = 'none';
  }

  // Locate the SPECIFIC element matching a label and return a tight target.
  // Scans ALL elements (not a narrow selector) for the SMALLEST one whose text is
  // the label — that's the leaf (e.g. the "System users" link), never the parent
  // "Users" group. Handles verbose targetText ("System users in the left menu")
  // by also matching when the element's own label is contained in the needle.
  // Finally climbs to a clickable ancestor, but only if it isn't dramatically
  // larger, so the ring stays tight on the item and never balloons to the group.
  // Find the best visible interactive element matching a text label.
  // Uses a narrow selector (only real interactive elements) so it's fast and never
  // picks a wrapper container. Scores matches: exact label > label-within-needle >
  // needle-within-label; tie-breaks by text length (shorter = more specific leaf).
  // No ancestor climbing needed — every queried element is already interactive.
  function findByText(text) {
    const needle = (text || '').trim().toLowerCase();
    if (!needle) return null;
    const SEL = [
      'a[href]', 'button', 'input', 'select', 'textarea',
      '[role="button"]', '[role="link"]', '[role="menuitem"]',
      '[role="tab"]', '[role="option"]', '[role="treeitem"]',
    ].join(',');
    let nodes;
    try { nodes = document.querySelectorAll(SEL); } catch (_) { return null; }
    let best = null, bestScore = -Infinity;
    for (const el of nodes) {
      try {
        if (el.id === '__sg_highlight') continue;
        try { if (el.closest('.driver-popover') || el.id === '__sg_tip') continue; } catch (_) {}
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        const st = window.getComputedStyle(el);
        if (!st || st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') continue;
        // innerText respects CSS visibility; fall back to textContent then aria-label.
        let vt = '';
        try { vt = el.innerText || ''; } catch (_) {}
        if (!vt) vt = el.textContent || '';
        if (!vt) vt = el.getAttribute('aria-label') || '';
        vt = vt.replace(/\s+/g, ' ').trim().toLowerCase();
        if (!vt) continue;
        // Score: exact match 100, label inside needle 80, needle inside label 40.
        // Subtract text length so shorter (more specific) elements win ties.
        let base = 0;
        if (vt === needle) base = 100;
        else if (needle.includes(vt) && vt.length >= 3) base = 80;
        else if (vt.includes(needle)) base = 40;
        else continue;
        const score = base * 10000 - vt.length;
        if (score > bestScore) { bestScore = score; best = el; }
      } catch (_) {}
    }
    return best;
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
      // Prefer the precise label match (the leaf link/button — avoids highlighting
      // a parent container that merely contains the label). Fall back to the id,
      // then to any label-based match. Otherwise show a tip.
      let el = null;
      if (msg.targetText) {
        el = findByText(msg.targetText);
      }
      if ((!el || !document.contains(el)) && msg.sgId !== null && msg.sgId !== undefined && msg.sgId !== '') {
        el = document.querySelector('[data-sg-id="' + msg.sgId + '"]');
      }
      try { console.log('[ScreenGuide] HIGHLIGHT sgId=' + msg.sgId + ' targetText="' + (msg.targetText || '') + '" resolved=' + !!el); } catch (_) {}
      if (el && document.contains(el)) {
        try { console.log('[ScreenGuide] highlighting <' + el.tagName.toLowerCase() + '> "' + (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) + '"'); } catch (_) {}
        scrollIntoViewIfNeeded(el);
        showHighlight(el);          // glowing, pulsing ring that tracks the element
        attachClickCompletion(el);
        return;
      }
      // Nothing to point at (true navigation/read step) — clear ring, show tip.
      clearHighlight();
      showTip(msg.fallback || msg.instruction || 'Follow the guidance in the panel');
    }

    if (msg.type === 'SHOW_TIP') {
      clearHighlight();
      showTip(msg.text);
    }

    if (msg.type === 'CLEAR') {
      clearHighlight();
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

  // Announce that a FRESH content script is live on this page, so the background
  // immediately re-draws the current highlight here (recovers after a refresh /
  // extension reload, instead of leaving a stale ring from an orphaned script).
  try { chrome.runtime.sendMessage({ type: 'CONTENT_READY' }, () => void chrome.runtime.lastError); } catch (_) {}

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

  // ── Click tracking → auto re-evaluate ──────────────────────────────────────
  // When the user clicks any interactive element (e.g. expands the "Users" menu),
  // tell the background to re-evaluate the screen — so guidance advances on its
  // own, without the user pressing "I've done this". Debounced so rapid clicks
  // coalesce into one evaluation. Capture phase so we still see it if the page
  // stops propagation.
  let clickReevalTimer = null;
  document.addEventListener('click', (e) => {
    const t = e.target;
    const interactive = t && t.closest && t.closest(
      'a,button,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="option"],[tabindex],input,select,textarea,label,summary'
    );
    if (!interactive) return;
    clearTimeout(clickReevalTimer);
    clickReevalTimer = setTimeout(() => {
      try { chrome.runtime.sendMessage({ type: 'USER_ACTED' }, () => void chrome.runtime.lastError); } catch (_) {}
    }, 450);
  }, true);
})();
