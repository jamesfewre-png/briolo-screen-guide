try { importScripts('claudeReasoner.js'); } catch (e) { console.warn('Screen Guide: claudeReasoner not loaded', e); }

// ── State ─────────────────────────────────────────────────────────────────────
let state = { workflowId: null, stepIndex: 0, enabled: false, confidence: 0, completed: false };
let workflow = null;
let apiKey = null;
const lastElements = {}; // tabId → elements[]
const lastUrl = {};      // tabId → string
const pendingAi = {};    // tabId → boolean — throttle concurrent Claude calls
let lastCompletedIndex = -1; // guard against double-advance (click STEP_COMPLETE + URL match)

// ── Constants ─────────────────────────────────────────────────────────────────
const CLAUDE_TIMEOUT_MS = 12000;

// Number of steps in the active workflow (0 until loaded)
function totalSteps() { return workflow?.steps?.length ?? 0; }

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
    const vt = (el.visibleText || '').toLowerCase();
    const al = (el.ariaLabel || '').toLowerCase();
    if (vt.includes(needle)) score += 3;
    if (al.includes(needle)) score += 2;
    // Inputs/textareas usually have empty visibleText — fall back to the
    // placeholder/name attributes so input-targeted steps can still match.
    if ((el.placeholder || '').toLowerCase().includes(needle)) score += 2;
    if ((el.name || '').toLowerCase().includes(needle)) score += 1;
    if (step.targetTag && el.tag === step.targetTag) score += 1;
    // Exact-label bonus: prefer the element whose label IS the target over one
    // that merely contains it — e.g. "Users" should beat "System users".
    if (vt === needle || al === needle) score += 3;
    if (score > bestScore) { bestScore = score; best = el; }
  }
  return best && bestScore > 0 ? { ...best, score: bestScore } : null;
}

// ── Push guidance to a tab ────────────────────────────────────────────────────
// forceAi = true skips the text-match threshold check (used by STUCK button)
async function pushToTab(tabId, forceAi = false) {
  if (!state.enabled || !tabId) return;
  // Workflow finished — clear any highlight; the panel shows the done view.
  if (state.completed) {
    chrome.tabs.sendMessage(tabId, { type: 'CLEAR' }).catch(() => {});
    return;
  }
  const step = currentStep();
  if (!step) return;
  const elements = lastElements[tabId] || [];
  const total = totalSteps();
  const match = matchStep(elements, step);
  const textScore = match ? match.score : 0;
  const textConfidence = Math.min(100, Math.round((textScore / 6) * 100));

  // Call Claude only when text match is weak (score < 3) or user is stuck,
  // and only if an API key is configured and no call is already in flight.
  const canUseAi = apiKey && typeof self.analyzeWithClaude === 'function';
  const needsAi = canUseAi && (forceAi || textScore < 3) && !pendingAi[tabId];

  // No API key and no text match at all — give the user a clear fallback
  // instruction instead of staying silent.
  if (!canUseAi && textScore === 0) {
    state.confidence = 0;
    chrome.tabs.sendMessage(tabId, {
      type: 'HIGHLIGHT',
      sgId: null,
      instruction: step.instruction,
      stepName: step.name,
      stepIndex: state.stepIndex,
      totalSteps: total,
      confidence: 0,
      fallback: step.fallback || `Scroll to find: ${step.name}`,
    }).catch(() => {});
    return;
  }

  if (needsAi) {
    pendingAi[tabId] = true;
    try {
      // Race the Claude call against a hard timeout so a slow/hung request
      // falls through to the text-match fallback in the catch block.
      const result = await Promise.race([
        self.analyzeWithClaude({
          step, elements, apiKey,
          currentUrl: lastUrl[tabId] || ''
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Claude request timed out')), CLAUDE_TIMEOUT_MS)
        ),
      ]);
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

// ── URL-based auto-advance ──────────────────────────────────────────────────
// Mutates state if the current step's completionUrlPattern matches `url`.
// Works for both full page loads (tabs.onUpdated) and SPA soft navigation
// (PAGE_STATE, since content.js re-sends state on history/URL changes).
// Returns true if it advanced or marked the workflow complete.
function maybeAdvanceOnUrl(url) {
  if (!state.enabled || !url) return false;
  const step = currentStep();
  if (!step || !step.completionUrlPattern) return false;
  // Double-advance guard: a click STEP_COMPLETE may have already advanced.
  if (lastCompletedIndex === state.stepIndex) return false;
  let matched = false;
  try { matched = new RegExp(step.completionUrlPattern).test(url); } catch (_) { return false; }
  if (!matched) return false;
  const total = totalSteps();
  lastCompletedIndex = state.stepIndex;
  if (total > 0 && state.stepIndex < total - 1) {
    state.stepIndex++;
  } else {
    // Terminal step's URL matched — the workflow is done.
    state.completed = true;
  }
  return true;
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
    state = { workflowId: msg.workflowId || 'meta-connect-assets', stepIndex: 0, enabled: true, confidence: 0, completed: false };
    lastCompletedIndex = -1;
    // sender.tab is undefined when message comes from the side panel — query active tab instead
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, async tabs => {
      const activeTabId = tabs[0]?.id;
      if (activeTabId) {
        chrome.sidePanel.open({ tabId: activeTabId }).catch(() => {});
        // If the workflow failed to load earlier (or hasn't loaded yet),
        // retry before pushing so the first step isn't silently dropped.
        if (!workflow || !workflow.steps || workflow.steps.length === 0) {
          await loadWorkflow();
        }
        pushToTab(activeTabId);
      }
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'NEXT_STEP') {
    const total = totalSteps();
    if (total > 0 && state.stepIndex < total - 1) state.stepIndex++;
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, tabs => {
      tabs.forEach(t => t.id && pushToTab(t.id));
    });
    sendResponse({ ok: true, stepIndex: state.stepIndex });
    return true;
  }

  if (msg.type === 'STEP_COMPLETE') {
    const total = totalSteps();
    // Guard against double-advance: only advance if this step index hasn't
    // already been completed (e.g. by a URL-pattern match on navigation).
    if (state.enabled && total > 0 && state.stepIndex < total - 1
        && lastCompletedIndex !== state.stepIndex) {
      lastCompletedIndex = state.stepIndex;
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
      totalSteps: totalSteps(),
      step: step ?? null,
      workflowName: workflow?.name ?? '',
      confidence: state.confidence ?? 0,
      hasApiKey: !!apiKey,
      completed: !!state.completed,
    });
    return true;
  }

  if (msg.type === 'PAGE_STATE') {
    if (tabId) {
      lastElements[tabId] = msg.elements || [];
      if (msg.url) {
        lastUrl[tabId] = msg.url;
        // SPA soft navigation lands here (content.js re-sends on URL change),
        // so this is where URL auto-advance fires for single-page apps.
        maybeAdvanceOnUrl(msg.url);
      }
      pushToTab(tabId); // fire-and-forget
    }
    sendResponse({ ok: true });
    return true;
  }
});

// ── Re-push on navigation ─────────────────────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && state.enabled) {
    if (tab.url) {
      lastUrl[tabId] = tab.url;
      maybeAdvanceOnUrl(tab.url); // full page-load auto-advance
    }
    pushToTab(tabId);
  }
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (state.enabled) pushToTab(tabId);
});
