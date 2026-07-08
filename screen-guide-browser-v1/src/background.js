try { importScripts('claudeReasoner.js'); } catch (e) { console.warn('Screen Guide: claudeReasoner not loaded', e); }

// ── State ─────────────────────────────────────────────────────────────────────
// Goal-driven, not step-driven. Claude decides the next action each cycle from
// the live screen + goal; we just track the goal, recent guidance, and history.
// Session factory — one shape for every entry point (picker, custom, plan, Briolo).
// Workshop capture phases (spec 2026-07-02-workshop-capture-ux-design.md):
//   idle -> triage -> plan -> running -> finish -> verifying -> (running|flagged) -> ... -> alldone
function freshSession(extra) {
  return Object.assign({
    goalId: null,
    enabled: false,
    completed: false,
    thinking: false,
    confidence: 0,
    lastGuidance: null,   // { message, reasoning, sgId, status, confidence }
    history: [],          // recent message strings, so Claude doesn't repeat itself
    phase: 'idle',        // see phase diagram above
    plan: [],             // [{ id, name, reason, status: 'pending'|'current'|'done'|'flagged', detail }]
    planIdx: -1,
    verifyFails: 0,       // smoke-test failures for the CURRENT flow (1 = regen, 2 = flag)
    stuckCount: 0,        // "I'm Stuck" presses on the current flow (2 = flag)
    verifyDetail: '',     // human-recognizable detail returned by the smoke test
    verifyReason: '',     // plain-English reason when the smoke test failed
    verifyKind: '',        // 'token_rejected' | 'provider_unreachable' | 'integration_broken'
    verifyNote: '',       // honest note when verification could not run
    intake: null,         // { business, job } the owner typed
  }, extra || {});
}
let state = freshSession();
let goal = null;        // loaded goal definition
let apiKey = null;      // dev-mode only: direct Anthropic key (avoid in production)
let proxyUrl = null;    // production: Briolo backend endpoint (key stays server-side)
let proxySecret = null; // shared secret sent to the proxy
let installId = null;   // random per-install id — lets the proxy rate-limit per install
let brand = '';           // deployment brand shown in the panel (config.json)
let dashboardUrl = '';    // dashboard origin the finish line hands tokens into ('' = not configured)
let facilitatorName = ''; // who "will come to you" in flag mode

const lastElements = {}; // tabId → elements[]
const lastUrl = {};      // tabId → string
const lastSig = {};      // tabId → page signature (skip redundant evaluations)
const pendingAi = {};    // tabId → boolean (one Claude call in flight per tab)
const pendingRerun = {}; // tabId → boolean (a re-eval was requested while one was in flight)
const evalTimers = {};   // tabId → debounce timer

// ── Constants ─────────────────────────────────────────────────────────────────
const CLAUDE_TIMEOUT_MS = 22000;
const EVAL_DEBOUNCE_MS = 700;   // let the page settle before re-evaluating
const POST_ACTION_MS = 1000;    // after the user acts, wait for the page to react

// ── Load goal + API key ─────────────────────────────────────────────────────────
// Load a goal definition by id from the packaged goal library (workflows/<id>.json).
// Goal-agnostic: the tool guides ANY goal it is given, not just Meta.
async function loadGoal(goalId) {
  const id = goalId || (state && state.goalId) || null;
  if (!id) return;
  try {
    const url = chrome.runtime.getURL('workflows/' + id + '.json');
    const res = await fetch(url);
    goal = await res.json();
  } catch (e) { console.error('Screen Guide: failed to load goal', id, e); }
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
      if (cfg.brand) brand = String(cfg.brand);
      if (cfg.dashboardUrl) dashboardUrl = String(cfg.dashboardUrl).replace(/\/$/, '');
      if (cfg.facilitatorName) facilitatorName = String(cfg.facilitatorName);
      // Dev fallback: direct key baked into the build.
      if (!apiKey && cfg.claudeApiKey) {
        apiKey = cfg.claudeApiKey;
        await chrome.storage.local.set({ claudeApiKey: apiKey });
      }
    }
  } catch (e) {}
}

// Stable per-install id (random UUID), persisted in storage. Sent to the proxy
// as x-guide-install so rate limits/quotas can be applied per install even before
// per-tenant Briolo auth exists.
async function loadInstallId() {
  try {
    const stored = await chrome.storage.local.get('sgInstallId');
    if (stored.sgInstallId) { installId = stored.sgInstallId; return; }
    const id = (self.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : ('inst-' + Math.random().toString(36).slice(2) + Date.now().toString(36));
    await chrome.storage.local.set({ sgInstallId: id });
    installId = id;
  } catch (_) {}
}

// No goal is preloaded — the tool is goal-agnostic and loads the chosen goal on
// demand (START_WORKFLOW from the panel, or BRIOLO_START_TASK from the dashboard).
chrome.runtime.onInstalled.addListener(() => { loadConfig(); loadInstallId(); });
chrome.runtime.onStartup.addListener(() => { loadConfig(); loadInstallId(); });
loadConfig();
loadInstallId();

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

// Black out sensitive regions in a JPEG data URL using OffscreenCanvas (service-
// worker safe). Returns: the original dataUrl if there is nothing to redact; a
// redacted dataUrl on success; null if regions WERE required but redaction failed
// — the caller then drops the screenshot rather than ever sending it unredacted.
async function redactScreenshot(dataUrl, regions) {
  if (!dataUrl) return null;
  if (!regions || !regions.length) return dataUrl;
  try {
    const resp = await fetch(dataUrl);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    ctx.fillStyle = '#000';
    for (const r of regions) {
      const x = Math.max(0, Math.min(bitmap.width, r.x));
      const y = Math.max(0, Math.min(bitmap.height, r.y));
      const w = Math.max(0, Math.min(bitmap.width - x, r.w));
      const h = Math.max(0, Math.min(bitmap.height - y, r.h));
      if (w > 0 && h > 0) ctx.fillRect(x, y, w, h);
    }
    if (typeof bitmap.close === 'function') bitmap.close();
    const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.5 });
    const buf = await outBlob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return 'data:image/jpeg;base64,' + btoa(binary);
  } catch (_) {
    return null; // fail-safe: never fall through to the raw screenshot
  }
}

// Ask the page (top frame only) for sensitive regions, capture the tab, redact.
async function captureRedactedScreenshot(tabId, windowId) {
  let regions = [];
  try {
    regions = await chrome.tabs.sendMessage(tabId, { type: 'GET_SENSITIVE_REGIONS' }, { frameId: 0 });
  } catch (_) { regions = []; }
  if (!Array.isArray(regions)) regions = [];
  const shot = await captureScreenshot(windowId);
  if (!shot) return null;
  return await redactScreenshot(shot, regions);
}

function sendGuidance(tabId, g) {
  try { console.log('[ScreenGuide] guidance -> tab ' + tabId, { sgId: g.sgId, status: g.status, message: g.message }); } catch (_) {}
  chrome.tabs.sendMessage(tabId, {
    type: 'HIGHLIGHT',
    sgId: g.sgId || null,
    targetText: g.targetText || '',
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
  // Guidance only runs during a flow. Panel-owned phases (plan review, finish-line
  // ritual, verifying, flag mode) must never be overwritten by a page change.
  if (state.phase && state.phase !== 'running') return;
  if (!goal) { if (state.goalId) await loadGoal(state.goalId); if (!goal) return; }
  // A call is already in flight — remember to re-run afterwards so a click during
  // an in-flight evaluation isn't dropped.
  if (pendingAi[tabId]) { if (force) pendingRerun[tabId] = true; return; }

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

  const screenshotDataUrl = await captureRedactedScreenshot(tabId, windowId);

  try {
    const result = await Promise.race([
      self.analyzeWithClaude({
        goal, recentActions: state.history, elements,
        screenshotDataUrl, currentUrl: url, apiKey, proxyUrl, proxySecret, installId,
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
    // Token flows end at the FINISH LINE, not at "complete": the panel takes over
    // with the copy -> dashboard -> attest -> verify ritual.
    const atFinish = goalHasFinishLine(goal) && (result.tokenRevealed || result.status === 'complete');
    if (atFinish) {
      state.phase = 'finish';
      chrome.tabs.sendMessage(tabId, {
        type: 'SHOW_TIP',
        text: (goal && goal.finishLine) || 'This is your token — the panel on the right takes it from here.',
      }).catch(() => {});
      return;
    }
    if (result.status === 'complete') {
      // Non-token flow (custom goal, legacy guide) — done means done.
      flowDone(tabId);
      return;
    }
    if (result.status === 'guiding') state.stuckCount = 0; // fresh progress resets the stuck counter
    sendGuidance(tabId, result);
    maybeRerun(tabId);
  } catch (err) {
    pendingAi[tabId] = false;
    state.thinking = false;
    console.warn('Screen Guide: reasoner failed:', err.message);
    lastSig[tabId] = ''; // allow a retry on the next change
    // Surface the failure so the panel never silently sticks on "getting bearings".
    state.confidence = 0;
    const rateLimited = /\b429\b|rate limit/i.test(err.message || '');
    state.lastGuidance = {
      message: rateLimited
        ? 'The guide is busy for a moment — wait a few seconds, then tap "I\'m Stuck".'
        : 'I could not reach Claude just now. Tap "I\'m Stuck" to retry.',
      reasoning: 'Reasoner error: ' + (err.message || 'unknown'),
      sgId: '', status: 'blocked', confidence: 0,
    };
    sendGuidance(tabId, state.lastGuidance);
    maybeRerun(tabId);
  }
}

function scheduleEvaluate(tabId, ms, opts) {
  clearTimeout(evalTimers[tabId]);
  evalTimers[tabId] = setTimeout(() => evaluate(tabId, opts), ms ?? EVAL_DEBOUNCE_MS);
}

// If a re-eval was requested while a call was in flight, run it now.
function maybeRerun(tabId) {
  if (pendingRerun[tabId]) { pendingRerun[tabId] = false; scheduleEvaluate(tabId, 200, { force: true }); }
}

function activeTabThen(fn) {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, tabs => {
    const id = tabs[0]?.id;
    if (id) fn(id);
  });
}

// ── Workshop plan machinery ─────────────────────────────────────────────────────
function goalHasFinishLine(g) {
  return !!(g && (g.deepLink || (g.verify && g.verify.providers && g.verify.providers.length)));
}

async function loadIndex() {
  try {
    const res = await fetch(chrome.runtime.getURL('workflows/index.json'));
    const list = await res.json();
    return Array.isArray(list) ? list : [];
  } catch (_) { return []; }
}

function currentFlow() { return (state.planIdx >= 0 && state.plan[state.planIdx]) || null; }

// Start (or chain into) the plan entry at idx: load its goal, open its front door,
// and let the normal evaluate loop take over from the fresh page.
async function startFlowAt(idx) {
  const entry = state.plan[idx];
  if (!entry) { state.phase = 'alldone'; return; }
  state.planIdx = idx;
  state.plan.forEach((p, i) => { if (p.status !== 'done' && p.status !== 'flagged') p.status = i === idx ? 'current' : 'pending'; });
  state.goalId = entry.id;
  state.phase = 'running';
  state.verifyFails = 0;
  state.stuckCount = 0;
  state.verifyDetail = '';
  state.verifyNote = '';
  state.verifyReason = '';
  state.verifyKind = '';
  state.history = [];
  state.lastGuidance = null;
  goal = null;
  await loadGoal(entry.id);
  if (goal && entry.name !== goal.name) entry.name = goal.name;
  // Take them to the flow's front door — chained flows must not strand the user
  // on the previous platform's page. In-page actions remain 100% human.
  if (goal && goal.startUrl) {
    chrome.tabs.create({ url: goal.startUrl }, tab => {
      if (tab && tab.id !== undefined) { lastSig[tab.id] = ''; }
    });
  } else {
    activeTabThen(id => { lastSig[id] = ''; evaluate(id, { force: true }); });
  }
}

// The current flow is fully finished (verified, or honestly passed through).
function flowDone(tabId) {
  const entry = currentFlow();
  if (entry) { entry.status = 'done'; entry.detail = state.verifyDetail || ''; }
  if (tabId) chrome.tabs.sendMessage(tabId, { type: 'CLEAR' }).catch(() => {});
  else activeTabThen(id => chrome.tabs.sendMessage(id, { type: 'CLEAR' }).catch(() => {}));
  const next = state.planIdx + 1;
  if (state.plan.length && next < state.plan.length) { startFlowAt(next); }
  else { state.phase = 'alldone'; }
}

// Smoke test after the human attests the paste. The token NEVER passes through
// the extension — the dashboard (where it was pasted) runs the provider call and
// exposes a status endpoint; we only read ok/detail.
async function verifyCurrent() {
  const flow = goal;
  state.phase = 'verifying';
  if (!dashboardUrl || !flow || !flow.deepLink) {
    // No dashboard configured — be honest, never fake a green tick.
    state.verifyNote = 'Verification will run in your dashboard once it is connected.';
    flowDone();
    return;
  }
  const url = dashboardUrl + '/api/' + flow.deepLink + '/status';
  for (let attempt = 0; attempt < 8; attempt++) {
    let res, data;
    try { res = await fetch(url, { credentials: 'include' }); } catch (_) { res = null; }
    if (!res || res.status === 404) {
      state.verifyNote = 'Could not reach your dashboard to verify — ask your facilitator to check it later.';
      flowDone();
      return;
    }
    try { data = await res.json(); } catch (_) { data = {}; }
    if (data && data.status === 'verified') {
      state.verifyDetail = typeof data.detail === 'string' ? data.detail.slice(0, 120) : '';
      flowDone();
      return;
    }
    if (data && data.status === 'failed') {
      verifyFailed(
        typeof data.reason === 'string' ? data.reason.slice(0, 160) : '',
        typeof data.kind === 'string' ? data.kind : 'token_rejected'
      );
      return;
    }
    await new Promise(r => setTimeout(r, 2000)); // pending — poll again
  }
  state.verifyNote = 'Verification is taking longer than expected — it will finish in your dashboard.';
  flowDone();
}

// Reacts differently depending on WHOSE problem this is (see _providers.js):
//   token_rejected       -> guided regeneration, up to 2 attempts then flag
//   provider_unreachable -> the token may be fine; silently re-check once before
//                           bothering the human, then flag if still down
//   integration_broken   -> regenerating a token can never fix a stale integration
//                           and it is never the owner's fault — flag immediately,
//                           no wasted attempt
function verifyFailed(reason, kind) {
  state.verifyReason = reason || 'the provider rejected this token';
  state.verifyKind = kind || 'token_rejected';

  if (state.verifyKind === 'integration_broken') {
    state.phase = 'flagged';
    activeTabThen(id => chrome.tabs.sendMessage(id, { type: 'CLEAR' }).catch(() => {}));
    return;
  }

  if (state.verifyKind === 'provider_unreachable') {
    state.verifyFails += 1;
    if (state.verifyFails >= 2) {
      state.phase = 'flagged';
      activeTabThen(id => chrome.tabs.sendMessage(id, { type: 'CLEAR' }).catch(() => {}));
      return;
    }
    state.phase = 'verifying';
    setTimeout(() => verifyCurrent(), 4000);
    return;
  }

  state.verifyFails += 1;
  if (state.verifyFails >= 2) {
    state.phase = 'flagged';
    activeTabThen(id => chrome.tabs.sendMessage(id, { type: 'CLEAR' }).catch(() => {}));
    return;
  }
  state.phase = 'running';
  state.history.push('The pasted token failed verification (' + state.verifyReason + '). Guide the user to generate a FRESH token and copy it again. Stay calm and reassuring; the system takes the blame, never the user.');
  activeTabThen(id => { lastSig[id] = ''; evaluate(id, { force: true }); });
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
    // Two ways to start: a library goal (workflowId) or an inline goal object
    // (custom guide typed in the panel). Either way it becomes a plan of one, so
    // the finish-line/verify machinery applies uniformly.
    const inlineGoal = (msg.goal && typeof msg.goal === 'object') ? msg.goal : null;
    const startGoalId = msg.workflowId || (inlineGoal && inlineGoal.id) || null;
    state = freshSession({
      goalId: startGoalId, enabled: true, phase: 'running', planIdx: 0,
      plan: [{ id: startGoalId, name: (inlineGoal && inlineGoal.name) || '', reason: '', status: 'current', detail: '' }],
    });
    goal = inlineGoal || null;
    activeTabThen(async id => {
      chrome.sidePanel.open({ tabId: id }).catch(() => {});
      if (!goal && state.goalId) await loadGoal(state.goalId);
      if (goal && state.plan[0] && !state.plan[0].name) state.plan[0].name = goal.name || '';
      lastSig[id] = ''; // force a fresh evaluation
      evaluate(id, { force: true });
    });
    sendResponse({ ok: true });
    return true;
  }

  // Owner described their business — AI proposes which connections they need.
  if (msg.type === 'BUILD_PLAN') {
    const business = String(msg.business || '').trim();
    const job = String(msg.job || '').trim();
    state = freshSession({ enabled: true, phase: 'triage', intake: { business, job } });
    goal = null;
    (async () => {
      const library = (await loadIndex()).filter(g => Array.isArray(g.patterns) && g.patterns.length);
      let proposed = [];
      try {
        if (typeof self.triageWithClaude === 'function' && (proxyUrl || apiKey)) {
          proposed = await self.triageWithClaude({ business, job, library, apiKey, proxyUrl, proxySecret, installId });
        }
      } catch (e) { console.warn('Screen Guide: triage failed', e && e.message); }
      const byId = {};
      for (const g of library) byId[g.id] = g;
      let plan = (proposed || [])
        .filter(c => byId[c.workflowId])
        .map(c => ({ id: c.workflowId, name: byId[c.workflowId].name, reason: c.reason || '', status: 'pending', detail: '' }));
      if (!plan.length) {
        // Honest fallback: triage unavailable — offer the full library for the
        // facilitator to prune, never a silent dead end.
        plan = library.map(g => ({ id: g.id, name: g.name, reason: 'Suggested because automatic planning was unavailable — untick what you do not need.', status: 'pending', detail: '' }));
      }
      state.plan = plan;
      state.phase = 'plan';
    })();
    sendResponse({ ok: true });
    return true;
  }

  // Human confirmed (possibly edited) the proposed plan — run it.
  if (msg.type === 'CONFIRM_PLAN') {
    const ids = Array.isArray(msg.ids) ? msg.ids : [];
    const keep = [];
    for (const id of ids) { const e = state.plan.find(p => p.id === id); if (e) keep.push(e); }
    if (!keep.length) { sendResponse({ ok: false, error: 'empty plan' }); return true; }
    state.plan = keep;
    activeTabThen(id => chrome.sidePanel.open({ tabId: id }).catch(() => {}));
    startFlowAt(0);
    sendResponse({ ok: true });
    return true;
  }

  // Finish line: the human attests the token is pasted into their dashboard slot.
  if (msg.type === 'ATTESTED') {
    if (state.phase === 'finish') verifyCurrent();
    sendResponse({ ok: true });
    return true;
  }

  // Flag mode over — the facilitator sorted it; keep going.
  if (msg.type === 'FLAG_RESUME') {
    if (state.phase === 'flagged') {
      state.phase = 'running';
      state.stuckCount = 0;
      state.verifyFails = 0;
      activeTabThen(id => { lastSig[id] = ''; evaluate(id, { force: true }); });
    }
    sendResponse({ ok: true });
    return true;
  }

  // Finish-line guard: is the dashboard session live in THIS browser?
  if (msg.type === 'CHECK_SIGNIN') {
    if (!dashboardUrl) { sendResponse({ signedIn: null }); return true; }
    fetch(dashboardUrl + '/api/me', { credentials: 'include' })
      .then(r => sendResponse({ signedIn: r.ok }))
      .catch(() => sendResponse({ signedIn: false }));
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

  // User clicked any interactive element (e.g. expanded a menu) — re-evaluate
  // without clearing the ring first: the old ring stays visible during the
  // Claude call (~3-5 s) and moves when new guidance arrives.
  if (msg.type === 'USER_ACTED') {
    if (tabId) scheduleEvaluate(tabId, POST_ACTION_MS, { force: true });
    sendResponse({ ok: true });
    return true;
  }

  // A fresh content script announced itself (page load / refresh). Clear any
  // stale ring from the previous page and re-evaluate — never re-draw lastGuidance
  // here, because it belongs to the old page and would look like a "random ring".
  if (msg.type === 'CONTENT_READY') {
    if (tabId && state.enabled && !state.completed) {
      chrome.tabs.sendMessage(tabId, { type: 'CLEAR' }).catch(() => {});
      lastSig[tabId] = '';
      scheduleEvaluate(tabId, 600, { force: true });
    }
    sendResponse({ ok: true });
    return true;
  }

  // "I'm stuck" — force a fresh evaluation. Twice on the same flow = nobody loops
  // alone in a paid room: switch to flag mode and wave the facilitator over.
  if (msg.type === 'STUCK') {
    state.stuckCount = (state.stuckCount || 0) + 1;
    if (state.phase === 'finish') state.phase = 'running'; // token may no longer be on screen — re-guide
    if (state.plan.length && state.stuckCount >= 2) {
      state.phase = 'flagged';
      activeTabThen(id => chrome.tabs.sendMessage(id, { type: 'CLEAR' }).catch(() => {}));
      sendResponse({ ok: true });
      return true;
    }
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
      // Workshop capture session
      phase: state.phase || 'idle',
      plan: state.plan,
      planIdx: state.planIdx,
      brand: brand,
      facilitatorName: facilitatorName,
      hasDashboard: !!dashboardUrl,
      deepLinkUrl: (dashboardUrl && goal && goal.deepLink) ? (dashboardUrl + '/' + goal.deepLink) : '',
      finishLine: (goal && goal.finishLine) || '',
      verifyDetail: state.verifyDetail || '',
      verifyNote: state.verifyNote || '',
      verifyReason: state.verifyReason || '',
      verifyKind: state.verifyKind || '',
    });
    return true;
  }

  if (msg.type === 'PAGE_STATE') {
    if (tabId) {
      lastElements[tabId] = msg.elements || [];
      // If the URL changed (SPA navigation), clear any stale ring immediately
      // so the user never sees a ring for the old page while Claude re-evaluates.
      if (msg.url && msg.url !== lastUrl[tabId]) {
        chrome.tabs.sendMessage(tabId, { type: 'CLEAR' }).catch(() => {});
      }
      if (msg.url) lastUrl[tabId] = msg.url;
      // Re-evaluate when the page settles (debounced + signature-guarded so our
      // own highlight or idle mutations don't trigger needless Claude calls).
      if (state.enabled && !state.completed) scheduleEvaluate(tabId);
    }
    sendResponse({ ok: true });
    return true;
  }
});

// ── Briolo dashboard bridge (externally_connectable) ────────────────────────────
// The production entry point: Briolo's onboarding AI generates a task and pushes
// it here, so the user never has to know what to type. The manifest's
// externally_connectable "matches" is the real gate; this is defense-in-depth.
function isBrioloSender(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && (u.hostname === 'briolo.io' || u.hostname.endsWith('.briolo.io'))) return true;
    if (u.protocol === 'http:' && u.hostname === 'localhost') return true;
  } catch (_) {}
  return false;
}

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (!sender || !isBrioloSender(sender.url || (sender.origin + '/'))) return;

  if (msg.type === 'BRIOLO_GET_STATUS') {
    sendResponse({ installed: true, enabled: state.enabled, completed: !!state.completed });
    return true;
  }

  if (msg.type === 'BRIOLO_START_TASK') {
    // Briolo pushes a goal as plain data — no packaged file needed.
    state = freshSession({
      goalId: msg.integrationId || null, enabled: true, phase: 'running', planIdx: 0,
      plan: [{ id: msg.integrationId || 'briolo-task', name: msg.displayName || 'Guided task', reason: '', status: 'current', detail: '' }],
    });
    goal = {
      id: msg.integrationId || 'briolo-task',
      name: msg.displayName || 'Guided task',
      objective: msg.taskGoal || '',
      successCriteria: msg.successCriteria || 'The task described in the objective is complete on screen.',
      startUrl: msg.startUrl || '',
      notes: 'The human performs every click and keystroke; only point and explain. Never repeat credential characters.',
    };
    activeTabThen(async id => {
      chrome.sidePanel.open({ tabId: id }).catch(() => {});
      lastSig[id] = '';
      evaluate(id, { force: true });
    });
    sendResponse({ ok: true });
    return true;
  }
});

// ── Navigation: full page loads trigger a fresh evaluation ──────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && state.enabled && !state.completed) {
    // Full navigation — clear any stale ring before re-evaluating.
    chrome.tabs.sendMessage(tabId, { type: 'CLEAR' }).catch(() => {});
    if (tab.url) lastUrl[tabId] = tab.url;
    lastSig[tabId] = '';
    scheduleEvaluate(tabId);
  }
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (state.enabled && !state.completed) scheduleEvaluate(tabId);
});
