const BRIDGE_URL = 'http://127.0.0.1:17391/page-state';
const HEALTH_URL = 'http://127.0.0.1:17391/health';
let lastPostAt = 0;
let lastOkAt = 0;
let lastError = null;
let enabled = true;

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

    postPageState(message.payload)
      .then(result => sendResponse(result))
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
