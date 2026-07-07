// Panel controller — renders one screen per session phase:
//   idle -> intake | triage | plan | running | finish | verifying | flagged | alldone
// State lives in the background service worker; this file only renders + relays.
let lastStateJson = '';
let statusHoldUntil = 0;     // don't let polling wipe a transient status message
let stopArmed = false;       // inline two-tap stop confirmation
let stopArmTimer = null;
let lastPlanSig = '';        // re-render the plan checklist only when the plan changes
let lastPhase = '';          // detect phase transitions (finish -> sign-in check)
const unticked = new Set();  // plan entries the human has unticked

function send(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, res => resolve(res || {})));
}
async function getState() { return send({ type: 'GET_STATE' }); }

function setStatus(elId, text, holdMs) {
  const el = document.getElementById(elId);
  if (el) el.textContent = text;
  statusHoldUntil = text ? Date.now() + (holdMs || 0) : 0;
}
function clearStatusIfMine() {
  if (Date.now() >= statusHoldUntil) {
    for (const id of ['status-msg', 'intake-status', 'plan-status']) {
      const el = document.getElementById(id);
      if (el) el.textContent = '';
    }
    statusHoldUntil = 0;
  }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setAiMode(hasApiKey) {
  const dot = document.getElementById('ai-dot');
  const text = document.getElementById('ai-mode-text');
  if (dot) dot.className = 'ai-dot ' + (hasApiKey ? 'on' : 'off');
  if (text) text.textContent = hasApiKey ? 'AI mode: on' : 'AI mode: off (no key)';
}

function setStatusPill(status) {
  const el = document.getElementById('status-pill');
  if (!el) return;
  if (status === 'wrong-page') {
    el.style.display = ''; el.className = 'status-pill pill-amber'; el.textContent = 'Wrong page — navigate first';
  } else if (status === 'blocked') {
    el.style.display = ''; el.className = 'status-pill pill-red'; el.textContent = 'Need your help';
  } else {
    el.style.display = 'none';
  }
}

const SCREENS = ['intake-screen', 'triage-screen', 'plan-screen', 'workflow-screen',
  'finish-screen', 'verify-screen', 'flag-screen', 'done-screen'];
function showScreen(id) {
  for (const s of SCREENS) {
    const el = document.getElementById(s);
    if (el) el.style.display = (s === id) ? '' : 'none';
  }
}

function applyBrand(state) {
  const t = document.getElementById('brand-title');
  const sub = document.getElementById('brand-sub');
  if (t) t.textContent = state.brand || 'AI Screen Guide';
  if (sub) sub.textContent = state.brand ? 'Your guided setup' : 'Live, AI-guided setup';
}

// ── Plan strip (session progress) ────────────────────────────────────────────────
function renderStrip(containerId, plan, planIdx) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!Array.isArray(plan) || plan.length < 2) { el.innerHTML = ''; return; }
  el.innerHTML = '';
  plan.forEach((p, i) => {
    const row = document.createElement('div');
    const cls = p.status === 'done' ? 'done' : (i === planIdx ? 'current' : '');
    row.className = 'strip-row ' + cls;
    row.innerHTML = '<span class="strip-dot ' + cls + '"></span>' + escapeHtml(p.name || p.id);
    el.appendChild(row);
  });
}

// ── Plan checklist ───────────────────────────────────────────────────────────────
function renderPlanList(plan) {
  const el = document.getElementById('plan-list');
  if (!el) return;
  el.innerHTML = '';
  plan.forEach(p => {
    const row = document.createElement('label');
    row.className = 'plan-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !unticked.has(p.id);
    cb.addEventListener('change', () => { cb.checked ? unticked.delete(p.id) : unticked.add(p.id); });
    const body = document.createElement('div');
    body.innerHTML = '<div class="p-name">' + escapeHtml(p.name) + '</div>' +
      (p.reason ? '<div class="p-reason">' + escapeHtml(p.reason) + '</div>' : '');
    row.appendChild(cb);
    row.appendChild(body);
    el.appendChild(row);
  });
}

// ── Finish line ──────────────────────────────────────────────────────────────────
async function enterFinish(state) {
  const note = document.getElementById('finish-note');
  if (note) note.textContent = state.finishLine
    ? state.finishLine + ' Treat it like a password — no screenshots, no emailing it to yourself.'
    : 'Treat it like a password — don\'t screenshot it, don\'t email it to yourself.';
  const openBtn = document.getElementById('btn-open-dashboard');
  const dest = document.getElementById('ritual-dest');
  const hint = document.getElementById('signin-hint');
  if (hint) hint.style.display = 'none';
  if (state.deepLinkUrl) {
    if (openBtn) { openBtn.style.display = ''; openBtn.dataset.url = state.deepLinkUrl; }
    if (dest) dest.innerHTML = 'Open your dashboard with the button below — it lands on this connection\'s slot.';
    const res = await send({ type: 'CHECK_SIGNIN' });
    if (res && res.signedIn === false && hint) hint.style.display = '';
  } else {
    if (openBtn) openBtn.style.display = 'none';
    if (dest) dest.innerHTML = state.hasDashboard
      ? 'Open your dashboard and find this connection\'s slot.'
      : 'Your facilitator will tell you exactly where to paste it.';
  }
}

// ── All done ─────────────────────────────────────────────────────────────────────
function renderDone(state) {
  const list = document.getElementById('done-list');
  const msg = document.getElementById('done-msg');
  const plan = Array.isArray(state.plan) ? state.plan : [];
  if (msg) msg.textContent = plan.length > 1
    ? 'Every connection in your plan is done. Your robot has what it needs.'
    : (state.goalName ? 'You\'ve completed: ' + state.goalName + '.' : 'You\'ve completed this guide.');
  if (!list) return;
  list.innerHTML = '';
  plan.forEach(p => {
    const row = document.createElement('div');
    row.className = 'done-item';
    let sub = '';
    if (p.detail) sub = '<div class="d-detail">Verified — connected to ' + escapeHtml(p.detail) + '</div>';
    else if (state.verifyNote) sub = '<div class="d-note">' + escapeHtml(state.verifyNote) + '</div>';
    row.innerHTML = '<span class="done-check">&#10003;</span><div><div class="d-name">' +
      escapeHtml(p.name || p.id) + '</div>' + sub + '</div>';
    list.appendChild(row);
  });
}

// ── Render ───────────────────────────────────────────────────────────────────────
function render(state) {
  setAiMode(!!state.hasApiKey);
  applyBrand(state);

  const json = JSON.stringify(state);
  if (json === lastStateJson) { clearStatusIfMine(); return; }
  lastStateJson = json;

  const phase = state.phase || 'idle';
  const phaseChanged = phase !== lastPhase;
  lastPhase = phase;

  if (!state.enabled && !state.completed) { showScreen('intake-screen'); clearStatusIfMine(); return; }

  if (phase === 'triage') { showScreen('triage-screen'); return; }

  if (phase === 'plan') {
    showScreen('plan-screen');
    const sig = JSON.stringify((state.plan || []).map(p => p.id));
    if (sig !== lastPlanSig) { lastPlanSig = sig; unticked.clear(); renderPlanList(state.plan || []); }
    clearStatusIfMine();
    return;
  }

  if (phase === 'finish') {
    showScreen('finish-screen');
    renderStrip('finish-strip', state.plan, state.planIdx);
    if (phaseChanged) enterFinish(state);
    return;
  }

  if (phase === 'verifying') { showScreen('verify-screen'); return; }

  if (phase === 'flagged') {
    showScreen('flag-screen');
    const sub = document.getElementById('flag-sub');
    const who = state.facilitatorName || 'Your facilitator';
    if (sub) sub.textContent = who + ' will come to you. Nothing is broken — this one just needs a human eye.';
    return;
  }

  if (phase === 'alldone' || state.completed) {
    showScreen('done-screen');
    renderDone(state);
    clearStatusIfMine();
    return;
  }

  // phase === 'running' (or legacy guidance)
  showScreen('workflow-screen');
  renderStrip('plan-strip', state.plan, state.planIdx);
  document.getElementById('goal-name').textContent = state.goalName || 'Guidance';
  const think = document.getElementById('think');
  if (think) think.style.display = state.thinking ? '' : 'none';
  setStatusPill(state.status);
  const msgEl = document.getElementById('ai-msg');
  if (msgEl) msgEl.textContent = state.message || (state.thinking ? 'Looking at your screen…' : 'Getting my bearings…');
  const whyEl = document.getElementById('ai-why');
  if (whyEl) {
    if (state.reasoning) { whyEl.style.display = ''; whyEl.innerHTML = '<b>Why:</b> ' + escapeHtml(state.reasoning); }
    else whyEl.style.display = 'none';
  }
  const hint = document.getElementById('ai-hint');
  if (hint) hint.style.display = state.hasApiKey ? 'none' : '';
  clearStatusIfMine();
}

async function refresh() { render(await getState()); }

// ── Stop (two-tap) ───────────────────────────────────────────────────────────────
function disarmStop() {
  stopArmed = false;
  if (stopArmTimer) { clearTimeout(stopArmTimer); stopArmTimer = null; }
  const btn = document.getElementById('btn-stop');
  if (btn) { btn.classList.remove('confirming'); btn.innerHTML = '✗ Stop Guidance'; }
}

// ── Guide picker + custom form (advanced path) ──────────────────────────────────
function startWorkflow(payload) {
  lastStateJson = '';
  return send(Object.assign({ type: 'START_WORKFLOW' }, payload || {}));
}

async function loadGuides() {
  const listEl = document.getElementById('guide-list');
  if (!listEl) return;
  let guides = [];
  try {
    const res = await fetch(chrome.runtime.getURL('workflows/index.json'));
    guides = await res.json();
  } catch (_) {}
  listEl.innerHTML = '';
  if (!Array.isArray(guides) || !guides.length) {
    listEl.innerHTML = '<div class="subtitle">No guides installed.</div>';
    return;
  }
  for (const g of guides) {
    const btn = document.createElement('button');
    btn.className = 'guide-btn';
    const obj = g.objective
      ? '<div class="g-obj">' + escapeHtml(g.objective.slice(0, 110)) + (g.objective.length > 110 ? '…' : '') + '</div>'
      : '';
    btn.innerHTML = '<div class="g-name">' + escapeHtml(g.name) + '</div>' + obj;
    btn.addEventListener('click', async () => { await startWorkflow({ workflowId: g.id }); await refresh(); });
    listEl.appendChild(btn);
  }
}

function wireCustomForm() {
  const toggle = document.getElementById('btn-custom-toggle');
  const form = document.getElementById('custom-form');
  if (toggle && form) {
    toggle.addEventListener('click', () => {
      form.style.display = form.style.display === 'none' ? '' : 'none';
    });
  }
  const startBtn = document.getElementById('btn-custom-start');
  if (startBtn) startBtn.addEventListener('click', async () => {
    const name = (document.getElementById('custom-name').value || '').trim();
    const objective = (document.getElementById('custom-objective').value || '').trim();
    const startUrl = (document.getElementById('custom-url').value || '').trim();
    if (!objective) { setStatus('intake-status', 'Describe the goal first.', 3000); return; }
    await startWorkflow({ goal: {
      id: 'custom',
      name: name || 'Custom guide',
      objective: objective,
      successCriteria: 'The objective described has been accomplished on screen.',
      startUrl: startUrl,
      notes: 'The human performs every click and keystroke; only point and explain. Never repeat credential characters.'
    } });
    await refresh();
  });
}

// ── Wiring ───────────────────────────────────────────────────────────────────────
document.getElementById('btn-build-plan').addEventListener('click', async () => {
  const business = (document.getElementById('intake-business').value || '').trim();
  const job = (document.getElementById('intake-job').value || '').trim();
  if (!business || !job) { setStatus('intake-status', 'Fill in both boxes first — a sentence each is plenty.', 3500); return; }
  lastStateJson = '';
  await send({ type: 'BUILD_PLAN', business, job });
  await refresh();
});

document.getElementById('btn-advanced-toggle').addEventListener('click', () => {
  const area = document.getElementById('advanced-area');
  if (area) area.style.display = area.style.display === 'none' ? '' : 'none';
});

document.getElementById('btn-confirm-plan').addEventListener('click', async () => {
  const state = await getState();
  const ids = (state.plan || []).map(p => p.id).filter(id => !unticked.has(id));
  if (!ids.length) { setStatus('plan-status', 'Keep at least one connection ticked.', 3500); return; }
  lastStateJson = '';
  await send({ type: 'CONFIRM_PLAN', ids });
  await refresh();
});

document.getElementById('btn-plan-back').addEventListener('click', async () => {
  await send({ type: 'STOP' });
  lastStateJson = '';
  await refresh();
});

document.getElementById('btn-open-dashboard').addEventListener('click', (e) => {
  const url = e.currentTarget.dataset.url;
  if (url) chrome.tabs.create({ url });
});

document.getElementById('btn-attest').addEventListener('click', async () => {
  lastStateJson = '';
  await send({ type: 'ATTESTED' });
  await refresh();
});

document.getElementById('btn-finish-stuck').addEventListener('click', async () => {
  lastStateJson = '';
  await send({ type: 'STUCK' });
  await refresh();
});

document.getElementById('btn-flag-resume').addEventListener('click', async () => {
  lastStateJson = '';
  await send({ type: 'FLAG_RESUME' });
  await refresh();
});

document.getElementById('btn-restart').addEventListener('click', async () => {
  await send({ type: 'STOP' });
  lastStateJson = '';
  lastPlanSig = '';
  unticked.clear();
  await refresh();
});

document.getElementById('btn-next').addEventListener('click', async () => {
  disarmStop();
  setStatus('status-msg', 'Taking another look…', 2500);
  await send({ type: 'NEXT_STEP' });
  await refresh();
});

document.getElementById('btn-stuck').addEventListener('click', async () => {
  disarmStop();
  setStatus('status-msg', 'Re-checking your screen…', 2500);
  await send({ type: 'STUCK' });
  await refresh();
});

document.getElementById('btn-stop').addEventListener('click', async () => {
  const btn = document.getElementById('btn-stop');
  if (!stopArmed) {
    stopArmed = true;
    if (btn) { btn.classList.add('confirming'); btn.innerHTML = 'Tap again to stop'; }
    stopArmTimer = setTimeout(disarmStop, 3000);
    return;
  }
  disarmStop();
  await send({ type: 'STOP' });
  lastStateJson = '';
  statusHoldUntil = 0;
  await refresh();
});

loadGuides();
wireCustomForm();
setInterval(refresh, 1200);
refresh();
