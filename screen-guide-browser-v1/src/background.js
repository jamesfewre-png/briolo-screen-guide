try { importScripts('claudeReasoner.js'); } catch (e) { console.warn('Screen Guide: claudeReasoner not loaded', e); }

// ── State ─────────────────────────────────────────────────────────────────────
// Goal-driven, not step-driven. Claude decides the next action each cycle from
// the live screen + goal; we just track the goal, recent guidance, and history.
let state = {
  goalId: null,
  enabled: false,
  completed: false,
  thinking: false,
  confidence: 0,
  lastGuidance: null,   // { message, reasoning, sgId, status, confidence }
  history: [],          // recent message strings, so Claude doesn't repeat itself
};
let goal = null;        // loaded goal definition
let apiKey = null;      // dev-mode only: direct Anthropic key (avoid in production)
let proxyUrl = null;    // production: Briolo backend endpoint (key stays server-side)
let proxySecret = null; // shared secret sent to the proxy

const lastElements = {}; // tabId → elements[]
const lastUrl = {};      // tabId → string
const lastSig = {};      // tabId → page signature (skip redundant evaluations)
const pendingAi = {};    // tabId → boolean (one Claude call in flight per tab)
const evalTimers = {};   // tabId → debounce timer

// ── Constants ─────────────────────────────────────────────────────────────────
const CLAUDE_TIMEOUT_MS = 22000;
const EVAL_DEBOUNCE_MS = 700;   // let the page settle before re-evaluating
const POST_ACTION_MS = 1000;    // after the user acts, wait for the page to react

// ── Load goal + API key ─────────────────────────────────────────────────────────
async function loadGoal() {
  try {
    const url = chrome.runtime.getURL('workflows/meta-connect-assets.json');
    const res = await fetch(url);
    goal = await res.json();
  } catch (e) { console.error('Screen Guide: failed to load goal', e); }
}

async function loadConfig() {
  try {
    const stored = await chrome.storage.local.get('claudeApiKey');
    if (stored.claudeApiKey) apiKey = stored.claudeApiKey;
    const res = await fetch(chrome.runtime.getURL('config.json'));
    if (res.ok) {
      const cfg = await res.json();
      // Production: proxy config (preferred — no key in the browser).
      if (cfg.proxyUrl) proxyUrl = cfg.proxyUrl;
      if (cfg.proxySecret) proxySecret = cfg.proxySecret;
      // Dev fallback: direct key baked into the build.
      if (!apiKey && cfg.claudeApiKey) {
        apiKey = cfg.claudeApiKey;
        await chrome.storage.local.set({ claudeApiKey: apiKey });
      }
    }
  } catch (e) {}
}

chrome.runtime.onInstalled.addListener(() => { loadGoal(); loadConfig(); });
chrome.runtime.onStartup.addListener(() => { loadGoal(); loadConfig(); });
loadGoal();
loadConfig();

// ── Helpers ─────────────────────────────────────────────────────────────────────
function pageSignature(url, elements) {
  const texts = (elements || []).slice(0, 40).map(e => e.visibleText || '').join('|');
  return (url || '') + '::' + ((elements && elements.length) || 0) + '::' + texts.slice(0, 600);
}

function captureScreenshot(windowId) {
  return new Promise(resolve => {
    try {
      chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 45 }, dataUrl => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(dataUrl || null);
      });
    } catch (_) { resolve(null); }
  });
}

function sendGuidance(tabId, g) {
  chrome.tabs.sendMessage(tabId, {
    type: 'HIGHLIGHT',
    sgId: g.sgId || null,
    instruction: g.message || '',
    stepName: (goal && goal.name) || 'Guidance',
    reasoning: g.reasoning || '',
    status: g.status || 'guiding',
    confidence: state.confidence,
    fallback: g.message || 'Look at the highlighted area to continue.',
  }).catch(() => {});
}

// ── Core: ask Claude what to do next, given the live screen + goal ───────────────
async function evaluate(tabId, opts) {
  const force = !!(opts && opts.force);
  if (!state.enabled || state.completed || !tabId) return;
  if (!goal) { await loadGoal(); if (!goal) return; }
  if (pendingAi[tabId]) return;

  const elements = lastElements[tabId] || [];
  const url = lastUrl[tabId] || '';
  const sig = pageSignature(url, elements);
  if (!force && sig === lastSig[tabId]) return; // nothing meaningful changed

  const aiReady = (proxyUrl || apiKey) && typeof self.analyzeWithClaude === 'function';
  if (!aiReady) {
    state.lastGuidance = { message: 'AI not configured — set a proxy URL or API key and rebuild.', reasoning: '', sgId: '', status: 'blocked', confidence: 0 };
    state.confidence = 0;
    sendGuidance(tabId, state.lastGuidance);
    return;
  }

  // Only capture/evaluate the active tab (captureVisibleTab grabs the active tab).
  let windowId, active = true;
  try { const tab = await chrome.tabs.get(tabId); windowId = tab.windowId; active = tab.active; } catch (_) {}
  if (!active) return;

  pendingAi[tabId] = true;
  state.thinking = true;
  lastSig[tabId] = sig;

  const screenshotDataUrl = await captureScreenshot(windowId);

  try {
    const result = await Promise.race([
      self.analyzeWithClaude({
        goal, recentActions: state.history, elements,
        screenshotDataUrl, currentUrl: url, apiKey, proxyUrl, proxySecret,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('reasoner timed out')), CLAUDE_TIMEOUT_MS)),
    ]);
    pendingAi[tabId] = false;
    state.thinking = false;
    state.confidence = Math.round((result.confidence || 0) * 100);
    state.lastGuidance = result;
    if (result.message) {
      state.history.push(result.message);
      if (state.history.length > 12) state.history = state.history.slice(-12);
    }
    if (result.status === 'complete') {
      state.completed = true;
      chrome.tabs.sendMessage(tabId, { type: 'CLEAR' }).catch(() => {});
      return;
    }
    sendGuidance(tabId, result);
  } catch (err) {
    pendingAi[tabId] = false;
    state.thinking = false;
    console.warn('Screen Guide: reasoner failed:', err.message);
    lastSig[tabId] = ''; // allow a retry on the next change
    // Surface the failure so the panel never silently sticks on "getting bearings".
    state.confidence = 0;
    state.lastGuidance = {
      message: 'I could not reach Claude just now. Tap "I\'m Stuck" to retry.',
      reasoning: 'Reasoner error: ' + (err.message || 'unknown'),
      sgId: '', status: 'blocked', confidence: 0,
    };
    sendGuidance(tabId, state.lastGuidance);
  }
}

function scheduleEvaluate(tabId, ms, opts) {
  clearTimeout(evalTimers[tabId]);
  evalTimers[tabId] = setTimeout(() => evaluate(tabId, opts), ms ?? EVAL_DEBOUNCE_MS);
}

function activeTabThen(fn) {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, tabs => {
    const id = tabs[0]?.id;
    if (id) fn(id);
  });
}

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  if (msg.type === 'SET_API_KEY') {
    apiKey = msg.apiKey || null;
    chrome.storage.local.set({ claudeApiKey: apiKey }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'START_WORKFLOW') {
    state = {
      goalId: msg.workflowId || 'meta-connect-assets',
      enabled: true, completed: false, thinking: false,
      confidence: 0, lastGuidance: null, history: [],
    };
    activeTabThen(async id => {
      chrome.sidePanel.open({ tabId: id }).catch(() => {});
      if (!goal) await loadGoal();
      lastSig[id] = ''; // force a fresh evaluation
      evaluate(id, { force: true });
    });
    sendResponse({ ok: true });
    return true;
  }

  // User says "I've done this" / "what's next" — force a fresh look.
  if (msg.type === 'NEXT_STEP') {
    activeTabThen(id => { lastSig[id] = ''; evaluate(id, { force: true }); });
    sendResponse({ ok: true });
    return true;
  }

  // User clicked the highlighted element — re-evaluate once the page reacts.
  if (msg.type === 'STEP_COMPLETE') {
    if (tabId) scheduleEvaluate(tabId, POST_ACTION_MS, { force: true });
    sendResponse({ ok: true });
    return true;
  }

  // "I'm stuck" — force a fresh evaluation of the current screen.
  if (msg.type === 'STUCK') {
    activeTabThen(id => { lastSig[id] = ''; evaluate(id, { force: true }); });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'STOP') {
    state.enabled = false;
    activeTabThen(id => chrome.tabs.sendMessage(id, { type: 'CLEAR' }).catch(() => {}));
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'GET_STATE') {
    const g = state.lastGuidance || {};
    sendResponse({
      enabled: state.enabled,
      completed: !!state.completed,
      thinking: !!state.thinking,
      goalName: (goal && goal.name) || '',
      message: g.message || '',
      reasoning: g.reasoning || '',
      status: g.status || (state.enabled ? 'guiding' : ''),
      confidence: state.confidence ?? 0,
      hasApiKey: !!(apiKey || proxyUrl),
    });
    return true;
  }

  if (msg.type === 'PAGE_STATE') {
    if (tabId) {
      lastElements[tabId] = msg.elements || [];
      if (msg.url) lastUrl[tabId] = msg.url;
      // Re-evaluate when the page settles (debounced + signature-guarded so our
      // own highlight or idle mutations don't trigger needless Claude calls).
      if (state.enabled && !state.completed) scheduleEvaluate(tabId);
    }
    sendResponse({ ok: true });
    return true;
  }
});

// ── Navigation: full page loads trigger a fresh evaluation ──────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && state.enabled && !state.completed) {
    if (tab.url) lastUrl[tabId] = tab.url;
    lastSig[tabId] = ''; // URL changed — definitely re-evaluate
    scheduleEvaluate(tabId);
  }
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (state.enabled && !state.completed) scheduleEvaluate(tabId);
});
