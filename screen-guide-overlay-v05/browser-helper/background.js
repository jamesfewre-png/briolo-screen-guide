const BRIDGE_URL = 'http://127.0.0.1:17391/page-state';
const HEALTH_URL = 'http://127.0.0.1:17391/health';
const GUIDANCE_URL = 'http://127.0.0.1:17391/guidance';
let lastPostAt = 0;
let lastOkAt = 0;
let lastError = null;
let enabled = true;

// Self-contained — no fetch, no closure over external vars.
// Injected directly into every frame via executeScript so it works even
// when the content script was never loaded (existing tabs after extension reload).
function injectHighlight(g) {
  const ID = '__sg_highlight';
  const ex = document.getElementById(ID);
  if (!g || g.type === 'clear' || g.type !== 'dom-highlight') { if (ex) ex.remove(); return; }
  const anchor = g.anchor || g.target;
  const text = (anchor && anchor.text ? anchor.text : '').replace(/\s+/g, ' ').trim();
  const tag = (anchor && anchor.tag) ? anchor.tag : 'a';
  let el = null;
  if (anchor && anchor.selector) { try { el = document.querySelector(anchor.selector); } catch (_) {} }
  if (!el && text) {
    const tags = tag === 'a' ? ['a', '[role="link"]'] : [tag];
    for (let ti = 0; ti < tags.length; ti++) {
      const all = document.querySelectorAll(tags[ti]);
      for (let i = 0; i < all.length; i++) {
        if ((all[i].innerText || all[i].textContent || '').replace(/\s+/g, ' ').trim() === text) {
          el = all[i]; break;
        }
      }
      if (el) break;
    }
  }
  if (!el) { if (ex) ex.remove(); return; }
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) { if (ex) ex.remove(); return; }
  const div = ex || document.createElement('div');
  if (!ex) { div.id = ID; document.documentElement.appendChild(div); }
  div.style.cssText = 'position:fixed;left:' + (r.left - 3) + 'px;top:' + (r.top - 3) + 'px;width:' + (r.width + 6) + 'px;height:' + (r.height + 6) + 'px;border:2px solid #ff8a00;border-radius:5px;box-shadow:0 0 0 4px rgba(255,138,0,0.18),0 0 16px rgba(255,138,0,0.22);pointer-events:none;z-index:2147483647;box-sizing:border-box;transition:left 0.15s,top 0.15s,width 0.15s,height 0.15s';
}

// Push current guidance to a specific tab (all frames).
// Background service worker fetches /guidance — no page CSP restriction.
async function pushGuidanceToTab(tabId) {
  if (!tabId || !enabled) return;
  try {
    const res = await fetch(GUIDANCE_URL);
    if (!res.ok) return;
    const { guidance } = await res.json();
    if (!guidance) return;
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: injectHighlight,
      args: [guidance]
    }).catch(() => {});
  } catch (_) {}
}

// Fallback poll — fires every 500ms for the last-focused Chrome window.
// Primary delivery is via push (page-state receipt) using sender.tab.id.
async function pollGuidance() {
  if (!enabled) return;
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    for (const tab of tabs) {
      if (tab.id) await pushGuidanceToTab(tab.id);
    }
  } catch (_) {}
}
setInterval(pollGuidance, 500);

// Re-inject whenever any tab finishes loading (handles navigation without page reload).
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete' && enabled) pushGuidanceToTab(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'SCREEN_GUIDE_PAGE_STATE') {
    if (!enabled) {
      sendResponse({ ok: false, disabled: true });
      return true;
    }

    const now = Date.now();
    if (now - lastPostAt < 250) {
      sendResponse({ ok: true, throttled: true });
      return true;
    }
    lastPostAt = now;

    const tabId = sender.tab?.id;
    postPageState(message.payload)
      .then(result => {
        sendResponse(result);
        // Push guidance back to exactly this tab — no chrome.tabs.query needed.
        if (tabId) pushGuidanceToTab(tabId);
      })
      .catch(err => {
        lastError = err.message;
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  if (message?.type === 'SCREEN_GUIDE_STATUS') {
    checkHealth().then(health => sendResponse({ enabled, lastOkAt, lastError, health }));
    return true;
  }

  if (message?.type === 'SCREEN_GUIDE_SET_ENABLED') {
    enabled = Boolean(message.enabled);
    sendResponse({ ok: true, enabled });
    return true;
  }
});

async function postPageState(payload) {
  const res = await fetch(BRIDGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Screen-Guide-Source': 'chrome-extension'
    },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Desktop bridge returned ${res.status}: ${text.slice(0, 200)}`);
  lastOkAt = Date.now();
  lastError = null;
  return JSON.parse(text || '{}');
}

async function checkHealth() {
  try {
    const res = await fetch(HEALTH_URL);
    return await res.json();
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
