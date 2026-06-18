try { importScripts('claudeReasoner.js'); } catch (e) { console.warn('Screen Guide: claudeReasoner not loaded', e); }

// ── State ─────────────────────────────────────────────────────────────────────
let state = { workflowId: null, stepIndex: 0, enabled: false, confidence: 0 };
let workflow = null;
let apiKey = null;
const lastElements = {}; // tabId → elements[]
const lastUrl = {};      // tabId → string
const pendingAi = {};    // tabId → boolean — throttle concurrent Claude calls

// ── Load workflow and API key ─────────────────────────────────────────────────
async function loadWorkflow() {
  try {
    const url = chrome.runtime.getURL('workflows/meta-connect-assets.json');
    const res = await fetch(url);
    workflow = await res.json();
  } catch (e) { console.error('Screen Guide: failed to load workflow', e); }
}

async function loadApiKey() {
  try {
    const stored = await chrome.storage.local.get('claudeApiKey');
    if (stored.claudeApiKey) { apiKey = stored.claudeApiKey; return; }
    // Fall back to build-injected config.json (generated from .env at build time)
    const res = await fetch(chrome.runtime.getURL('config.json'));
    if (res.ok) {
      const cfg = await res.json();
      if (cfg.claudeApiKey) {
        apiKey = cfg.claudeApiKey;
        await chrome.storage.local.set({ claudeApiKey: apiKey });
      }
    }
  } catch (e) {}
}

chrome.runtime.onInstalled.addListener(() => { loadWorkflow(); loadApiKey(); });
chrome.runtime.onStartup.addListener(() => { loadWorkflow(); loadApiKey(); });
loadWorkflow();
loadApiKey();

// ── Step helpers ──────────────────────────────────────────────────────────────
function currentStep() {
  if (!workflow || !state.workflowId) return null;
  return workflow.steps[state.stepIndex] ?? null;
}

function matchStep(elements, step) {
  if (!step || !step.targetText) return null;
  const needle = step.targetText.toLowerCase();
  let best = null, bestScore = 0;
  for (const el of elements) {
    let score = 0;
    if ((el.visibleText || '').toLowerCase().includes(needle)) score += 3;
    if ((el.ariaLabel || '').toLowerCase().includes(needle)) score += 2;
    if (step.targetTag && el.tag === step.targetTag) score += 1;
    if (score > bestScore) { bestScore = score; best = el; }
  }
  return best && bestScore > 0 ? { ...best, score: bestScore } : null;
}

// ── Push guidance to a tab ────────────────────────────────────────────────────
// forceAi = true skips the text-match threshold check (used by STUCK button)
async function pushToTab(tabId, forceAi = false) {
  if (!state.enabled || !tabId) return;
  const step = currentStep();
  if (!step) return;
  const elements = lastElements[tabId] || [];
  const total = workflow?.steps?.length ?? 7;
  const match = matchStep(elements, step);
  const textScore = match ? match.score : 0;
  const textConfidence = Math.round((textScore / 6) * 100);

  // Call Claude only when text match is weak (score < 3) or user is stuck,
  // and only if an API key is configured and no call is already in flight.
  const canUseAi = apiKey && typeof self.analyzeWithClaude === 'function';
  const needsAi = canUseAi && (forceAi || textScore < 3) && !pendingAi[tabId];

  if (needsAi) {
    pendingAi[tabId] = true;
    try {
      const result = await self.analyzeWithClaude({
        step, elements, apiKey,
        currentUrl: lastUrl[tabId] || ''
      });
      pendingAi[tabId] = false;
      const aiConf = Math.round((result.confidence || 0) * 100);
      state.confidence = aiConf;
      chrome.tabs.sendMessage(tabId, {
        type: 'HIGHLIGHT',
        sgId: result.sgId || null,
        instruction: step.instruction,
        stepName: step.name,
        stepIndex: state.stepIndex,
        totalSteps: total,
        confidence: aiConf,
        fallback: result.message || step.fallback,
      }).catch(() => {});
    } catch (err) {
      pendingAi[tabId] = false;
      console.warn('Screen Guide: Claude failed, falling back to text match:', err.message);
      state.confidence = textConfidence;
      chrome.tabs.sendMessage(tabId, {
        type: 'HIGHLIGHT',
        sgId: match ? String(match.sgId) : null,
        instruction: step.instruction,
        stepName: step.name,
        stepIndex: state.stepIndex,
        totalSteps: total,
        confidence: textConfidence,
        fallback: step.fallback,
      }).catch(() => {});
    }
  } else {
    state.confidence = textConfidence;
    chrome.tabs.sendMessage(tabId, {
      type: 'HIGHLIGHT',
      sgId: match ? String(match.sgId) : null,
      instruction: step.instruction,
      stepName: step.name,
      stepIndex: state.stepIndex,
      totalSteps: total,
      confidence: textConfidence,
      fallback: step.fallback,
    }).catch(() => {});
  }
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
    state = { workflowId: msg.workflowId || 'meta-connect-assets', stepIndex: 0, enabled: true, confidence: 0 };
    // sender.tab is undefined when message comes from the side panel — query active tab instead
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, tabs => {
      const activeTabId = tabs[0]?.id;
      if (activeTabId) {
        chrome.sidePanel.open({ tabId: activeTabId }).catch(() => {});
        pushToTab(activeTabId);
      }
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'NEXT_STEP') {
    const total = workflow?.steps?.length ?? 7;
    if (state.stepIndex < total - 1) state.stepIndex++;
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, tabs => {
      tabs.forEach(t => t.id && pushToTab(t.id));
    });
    sendResponse({ ok: true, stepIndex: state.stepIndex });
    return true;
  }

  if (msg.type === 'STEP_COMPLETE') {
    const total = workflow?.steps?.length ?? 7;
    if (state.enabled && state.stepIndex < total - 1) {
      state.stepIndex++;
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, tabs => {
        tabs.forEach(t => t.id && pushToTab(t.id));
      });
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'STUCK') {
    // Force AI on stuck — even if text match was confident, user says it's wrong
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, tabs => {
      tabs.forEach(t => t.id && pushToTab(t.id, true));
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'STOP') {
    state.enabled = false;
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, tabs => {
      tabs.forEach(t => t.id && chrome.tabs.sendMessage(t.id, { type: 'CLEAR' }).catch(() => {}));
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'GET_STATE') {
    const step = currentStep();
    sendResponse({
      enabled: state.enabled,
      workflowId: state.workflowId,
      stepIndex: state.stepIndex,
      totalSteps: workflow?.steps?.length ?? 7,
      step: step ?? null,
      workflowName: workflow?.name ?? '',
      confidence: state.confidence ?? 0,
      hasApiKey: !!apiKey,
    });
    return true;
  }

  if (msg.type === 'PAGE_STATE') {
    if (tabId) {
      lastElements[tabId] = msg.elements || [];
      if (msg.url) lastUrl[tabId] = msg.url;
      pushToTab(tabId); // fire-and-forget
    }
    sendResponse({ ok: true });
    return true;
  }
});

// ── Re-push on navigation ─────────────────────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && state.enabled) {
    if (tab.url) lastUrl[tabId] = tab.url;
    // Auto-advance navigation-only steps (no targetText) when URL matches completionUrlPattern
    const step = currentStep();
    if (step && !step.targetText && step.completionUrlPattern) {
      try {
        if (new RegExp(step.completionUrlPattern).test(tab.url)) {
          const total = workflow?.steps?.length ?? 7;
          if (state.stepIndex < total - 1) state.stepIndex++;
        }
      } catch (_) {}
    }
    pushToTab(tabId);
  }
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (state.enabled) pushToTab(tabId);
});
