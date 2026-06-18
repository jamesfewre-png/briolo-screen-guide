(() => {
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
        const rect = el.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) continue;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
        const sgId = counter++;
        el.setAttribute('data-sg-id', String(sgId));
        elements.push({
          sgId,
          tag: el.tagName.toLowerCase(),
          visibleText: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          ariaLabel: el.getAttribute('aria-label') || '',
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

  // ── Click-completion tracking ─────────────────────────────────────────────
  let watchedEl = null;
  let watchedListener = null;

  function attachClickCompletion(el) {
    if (watchedEl && watchedListener) {
      watchedEl.removeEventListener('click', watchedListener);
    }
    watchedEl = el;
    watchedListener = () => {
      watchedEl = null; watchedListener = null;
      chrome.runtime.sendMessage({ type: 'STEP_COMPLETE' }, () => void chrome.runtime.lastError);
    };
    el.addEventListener('click', watchedListener, { once: true });
  }

  // ── Message listener ──────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'HIGHLIGHT') {
      clearTip();
      if (msg.sgId !== null && msg.sgId !== undefined) {
        const el = document.querySelector('[data-sg-id="' + msg.sgId + '"]');
        if (el && driverInstance) {
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
          attachClickCompletion(el);
          return;
        }
      }
      // No element found — show tip
      if (driverInstance) try { driverInstance.destroy(); } catch (_) {}
      showTip(msg.fallback || msg.instruction || 'Scroll to find the next element');
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

  // ── Initial scan + send ───────────────────────────────────────────────────
  function sendState() {
    try {
      const elements = scanDOM();
      chrome.runtime.sendMessage({ type: 'PAGE_STATE', elements, url: location.href }, () => void chrome.runtime.lastError);
    } catch (_) {}
  }

  sendState();

  // ── Re-scan on DOM changes (debounced) ────────────────────────────────────
  let debounce = null;
  const mo = new MutationObserver(() => {
    clearTimeout(debounce);
    debounce = setTimeout(sendState, 400);
  });
  try {
    mo.observe(document.body || document.documentElement, { childList: true, subtree: true });
  } catch (_) {}

  window.addEventListener('scroll', () => { clearTimeout(debounce); debounce = setTimeout(sendState, 400); }, { passive: true });
})();
