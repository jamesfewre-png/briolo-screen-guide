(() => {
  const MAX_ELEMENTS = 220;
  const SEND_DEBOUNCE_MS = 220;
  let scheduled = null;
  let lastSentSignature = '';

  function schedule(reason) {
    if (scheduled) clearTimeout(scheduled);
    scheduled = setTimeout(() => {
      scheduled = null;
      sendState(reason).catch(() => {});
    }, SEND_DEBOUNCE_MS);
  }

  async function sendState(reason) {
    const payload = collectPageState(reason);
    const signature = `${payload.url}|${payload.title}|${payload.scroll?.x},${payload.scroll?.y}|${payload.elements?.slice(0, 12).map(e => e.text + JSON.stringify(e.rect)).join('|')}`;
    if (signature === lastSentSignature) return;
    lastSentSignature = signature;
    chrome.runtime.sendMessage({ type: 'SCREEN_GUIDE_PAGE_STATE', payload }, () => void chrome.runtime.lastError);
  }

  function collectPageState(reason) {
    const elements = collectElements();
    return {
      url: location.href,
      origin: location.origin,
      title: document.title,
      capturedAt: new Date().toISOString(),
      reason,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1
      },
      windowMetrics: getWindowMetrics(),
      scroll: {
        x: window.scrollX,
        y: window.scrollY,
        maxX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
        maxY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
      },
      activeElement: describeElement(document.activeElement),
      summaryText: getVisibleTextSummary(),
      elements
    };
  }

  function getWindowMetrics() {
    // Meta Business Suite runs its settings inside an iframe. window.innerHeight in an
    // iframe equals the iframe's CSS height (can exceed outerHeight), making chromeY
    // go negative and vp.y collapse to 0. Fix: always use the top-level window for
    // chrome-height maths; getBoundingClientRect() in the iframe is still correct
    // because the iframe occupies the full page viewport (iframeTop = 0).
    let ref = window;
    try {
      if (window.top && window.top !== window) {
        void window.top.outerHeight; // throws SecurityError for cross-origin iframes
        ref = window.top;
      }
    } catch (_) { /* cross-origin iframe — fall back to window */ }

    const screenLeft = Number(ref.screenX ?? ref.screenLeft ?? 0);
    const screenTop = Number(ref.screenY ?? ref.screenTop ?? 0);
    const outerWidth = Number(ref.outerWidth || ref.innerWidth);
    const outerHeight = Number(ref.outerHeight || ref.innerHeight);
    const chromeX = Math.max(0, (outerWidth - ref.innerWidth) / 2);
    const chromeY = Math.max(0, outerHeight - ref.innerHeight);
    return {
      screen: {
        width: window.screen?.width || 0,
        height: window.screen?.height || 0,
        availWidth: window.screen?.availWidth || 0,
        availHeight: window.screen?.availHeight || 0
      },
      outer: { x: screenLeft, y: screenTop, width: outerWidth, height: outerHeight },
      inner: { width: ref.innerWidth, height: ref.innerHeight },
      estimatedViewportOnScreen: {
        x: screenLeft + chromeX,
        y: screenTop + chromeY,
        width: ref.innerWidth,
        height: ref.innerHeight
      },
      devicePixelRatio: window.devicePixelRatio || 1,
      isInFrame: ref !== window,
      note: 'estimatedViewportOnScreen derived from top-level window to avoid iframe innerHeight pollution.'
    };
  }

  function collectElements() {
    const selector = [
      'button',
      'a',
      'input',
      'textarea',
      'select',
      'summary',
      'label',
      '[role="button"]',
      '[role="link"]',
      '[role="menuitem"]',
      '[role="tab"]',
      '[role="option"]',
      '[contenteditable="true"]',
      '[onclick]',
      '[tabindex]'
    ].join(',');

    const seen = new Set();
    const output = [];
    for (const el of document.querySelectorAll(selector)) {
      if (!(el instanceof HTMLElement)) continue;
      if (seen.has(el)) continue;
      seen.add(el);

      const desc = describeElement(el);
      if (!desc.visible) continue;
      if (!desc.text && !desc.isInput && !desc.role) continue;
      output.push(desc);
      if (output.length >= MAX_ELEMENTS) break;
    }
    return output;
  }

  function describeElement(el) {
    if (!el || !(el instanceof Element)) return null;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const visible = isVisible(el, rect, style);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || implicitRole(el);
    const type = el.getAttribute('type') || '';
    const text = elementText(el);
    const isInput = ['input', 'textarea', 'select'].includes(tag) || el.isContentEditable;
    const isClickable = Boolean(
      tag === 'button' || tag === 'a' ||
      ['button', 'link', 'menuitem', 'tab', 'option'].includes(role) ||
      el.hasAttribute('onclick') ||
      Number(el.getAttribute('tabindex')) >= 0
    );
    const screenRect = clientRectToScreen(rect);
    return {
      id: stableId(el),
      tag,
      role,
      type,
      text,
      selector: cssPath(el),
      href: tag === 'a' ? el.href || '' : '',
      isClickable,
      isInput,
      visible,
      disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      screenRect,
      center: screenRect ? { x: screenRect.x + screenRect.w / 2, y: screenRect.y + screenRect.h / 2 } : null,
      evidence: buildEvidence(el, text, role, isClickable, isInput)
    };
  }

  function clientRectToScreen(rect) {
    const metrics = getWindowMetrics();
    const vp = metrics.estimatedViewportOnScreen;
    // vp and rect are CSS (logical) pixels; overlay canvas also draws in CSS pixels
    return {
      x: Math.round(vp.x + rect.x),
      y: Math.round(vp.y + rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height)
    };
  }

  function isVisible(el, rect, style) {
    if (!rect || rect.width <= 1 || rect.height <= 1) return false;
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
    // Use top-level viewport bounds so iframe elements below the browser window are filtered out.
    let viewH = window.innerHeight, viewW = window.innerWidth;
    try { if (window.top !== window) { viewH = window.top.innerHeight; viewW = window.top.innerWidth; } } catch (_) {}
    if (rect.bottom < 0 || rect.right < 0 || rect.top > viewH || rect.left > viewW) return false;
    return true;
  }

  function elementText(el) {
    const attrs = [
      'aria-label',
      'data-testid',
      'data-test-id',
      'title',
      'placeholder',
      'alt',
      'name'
    ];
    const parts = [];
    for (const attr of attrs) {
      const v = el.getAttribute(attr);
      if (v) parts.push(v);
    }
    if ('value' in el && typeof el.value === 'string' && el.value && el.type !== 'password') parts.push(el.value);
    const txt = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (txt) parts.push(txt);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelText = labelledBy.split(/\s+/).map(id => document.getElementById(id)?.innerText || '').join(' ').trim();
      if (labelText) parts.push(labelText);
    }
    return unique(parts).join(' | ').replace(/\s+/g, ' ').trim().slice(0, 220);
  }

  function implicitRole(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (['button', 'submit', 'reset'].includes(type)) return 'button';
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    return '';
  }

  function buildEvidence(el, text, role, isClickable, isInput) {
    const out = [];
    if (text) out.push('text');
    if (role) out.push('role');
    if (isClickable) out.push('clickable');
    if (isInput) out.push('input');
    if (el.getAttribute('data-testid') || el.getAttribute('data-test-id')) out.push('test-id');
    if (el.id) out.push('id');
    if (el.getAttribute('aria-label')) out.push('aria-label');
    return out;
  }

  function stableId(el) {
    return [el.tagName.toLowerCase(), el.id || '', el.getAttribute('data-testid') || '', elementText(el).slice(0, 40)].join(':');
  }

  function cssPath(el) {
    if (!(el instanceof Element)) return '';
    const direct = directSelector(el);
    if (direct && document.querySelectorAll(direct).length === 1) return direct;

    const parts = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
      const part = directSelector(current, true);
      parts.unshift(part);
      const candidate = parts.join(' > ');
      try {
        if (document.querySelectorAll(candidate).length === 1) return candidate;
      } catch (_) {}
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  function directSelector(el, allowNth = false) {
    const tag = el.tagName.toLowerCase();
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `#${CSS.escape(el.id)}`;
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
    if (testId) return `${tag}[data-testid="${cssAttr(testId)}"], ${tag}[data-test-id="${cssAttr(testId)}"]`.split(', ')[0];
    const aria = el.getAttribute('aria-label');
    if (aria && aria.length < 80) return `${tag}[aria-label="${cssAttr(aria)}"]`;
    const name = el.getAttribute('name');
    if (name) return `${tag}[name="${cssAttr(name)}"]`;
    if (!allowNth) return tag;
    const parent = el.parentElement;
    if (!parent) return tag;
    const same = [...parent.children].filter(c => c.tagName === el.tagName);
    const idx = same.indexOf(el) + 1;
    return same.length > 1 ? `${tag}:nth-of-type(${idx})` : tag;
  }

  function cssAttr(v) {
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function unique(arr) {
    return [...new Set(arr.filter(Boolean))];
  }

  function getVisibleTextSummary() {
    const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    return bodyText.slice(0, 1800);
  }

  // ── In-page highlight ─────────────────────────────────────────────────────
  // The extension draws the element highlight directly in the page via
  // position:fixed CSS so screen-coordinate calculation is not needed.
  // The Electron overlay still handles GuideCardBanner + WorkflowDock.

  const HIGHLIGHT_ID = '__sg_highlight';

  function applyInPageHighlight(guidance) {
    const existing = document.getElementById(HIGHLIGHT_ID);
    const type = guidance?.type;
    const anchor = guidance?.anchor || guidance?.target;
    const selector = anchor?.selector;
    const anchorText = (anchor?.text || '').replace(/\s+/g, ' ').trim();
    const anchorTag = anchor?.tag || 'a';

    if (!guidance || type === 'clear' || type !== 'dom-highlight') {
      existing?.remove();
      return;
    }

    // 1. Try the CSS selector generated at collection time.
    let el = null;
    if (selector) {
      try { el = document.querySelector(selector); } catch (_) {}
    }

    // 2. Fallback: match by tag + exact text content (survives React re-renders
    //    that shift nth-of-type positions in the generated selector).
    if (!el && anchorText) {
      const tags = anchorTag === 'a' ? ['a', '[role="link"]'] : [anchorTag];
      outer: for (const t of tags) {
        for (const c of document.querySelectorAll(t)) {
          if ((c.innerText || c.textContent || '').replace(/\s+/g, ' ').trim() === anchorText) {
            el = c;
            break outer;
          }
        }
      }
    }

    if (!el) { existing?.remove(); return; }

    const rect = el.getBoundingClientRect();
    const div = existing || document.createElement('div');
    if (!existing) {
      div.id = HIGHLIGHT_ID;
      document.documentElement.appendChild(div);
    }
    div.style.cssText = [
      'position:fixed',
      `left:${rect.left - 3}px`,
      `top:${rect.top - 3}px`,
      `width:${rect.width + 6}px`,
      `height:${rect.height + 6}px`,
      'border:2px solid #ff8a00',
      'border-radius:5px',
      'box-shadow:0 0 0 4px rgba(255,138,0,0.18),0 0 16px rgba(255,138,0,0.22)',
      'pointer-events:none',
      'z-index:2147483647',
      'box-sizing:border-box',
      'transition:left 0.15s,top 0.15s,width 0.15s,height 0.15s',
    ].join(';');
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'SCREEN_GUIDE_APPLY_HIGHLIGHT') {
      applyInPageHighlight(message.guidance);
    }
  });

  ['click', 'input', 'change', 'focusin'].forEach(evt => document.addEventListener(evt, () => schedule(evt), true));
  ['scroll', 'resize'].forEach(evt => window.addEventListener(evt, () => schedule(evt), { passive: true }));

  const mo = new MutationObserver(() => schedule('mutation'));
  mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-label', 'aria-disabled', 'hidden', 'style', 'class', 'disabled'] });

  // All frames (including iframes) poll /guidance directly so each frame
  // can draw the highlight inside its own DOM using getBoundingClientRect().
  // The background.js relay only reaches the main frame; this covers iframes.
  setInterval(async () => {
    try {
      const res = await fetch('http://127.0.0.1:17391/guidance');
      if (!res.ok) return;
      const { guidance } = await res.json();
      applyInPageHighlight(guidance);
    } catch (_) {}
  }, 500);

  schedule('initial');
  setInterval(() => schedule('heartbeat'), 1500);
})();
