let lastStateJson = '';
let statusHoldUntil = 0;     // don't let polling wipe a transient status message
let stopArmed = false;       // inline two-tap stop confirmation
let stopArmTimer = null;

async function getState() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, res => resolve(res || { enabled: false }));
  });
}

function setStatus(text, holdMs) {
  const el = document.getElementById('status-msg');
  if (el) el.textContent = text;
  statusHoldUntil = text ? Date.now() + (holdMs || 0) : 0;
}

function clearStatusIfMine() {
  if (Date.now() >= statusHoldUntil) {
    const el = document.getElementById('status-msg');
    if (el) el.textContent = '';
    statusHoldUntil = 0;
  }
}

function setAiMode(hasApiKey) {
  const dot = document.getElementById('ai-dot');
  const text = document.getElementById('ai-mode-text');
  if (dot) dot.className = 'ai-dot ' + (hasApiKey ? 'on' : 'off');
  if (text) text.textContent = hasApiKey ? 'AI mode: on' : 'AI mode: off (no key)';
}

// Status pill: only surface the states the user needs to act on.
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

function render(state) {
  // AI-mode indicator can change independent of run state — refresh before dedup.
  setAiMode(!!state.hasApiKey);

  const json = JSON.stringify(state);
  if (json === lastStateJson) { clearStatusIfMine(); return; }
  lastStateJson = json;

  const startScreen = document.getElementById('start-screen');
  const workflowScreen = document.getElementById('workflow-screen');
  const doneScreen = document.getElementById('done-screen');

  if (state.completed) {
    startScreen.style.display = 'none';
    workflowScreen.style.display = 'none';
    if (doneScreen) doneScreen.style.display = '';
    clearStatusIfMine();
    return;
  }

  if (!state.enabled) {
    startScreen.style.display = '';
    workflowScreen.style.display = 'none';
    if (doneScreen) doneScreen.style.display = 'none';
    clearStatusIfMine();
    return;
  }

  startScreen.style.display = 'none';
  workflowScreen.style.display = '';
  if (doneScreen) doneScreen.style.display = 'none';

  document.getElementById('goal-name').textContent = state.goalName || 'Guidance';

  // Thinking indicator while Claude is looking at the screen.
  const think = document.getElementById('think');
  if (think) think.style.display = state.thinking ? '' : 'none';

  setStatusPill(state.status);

  // The live instruction from Claude.
  const msgEl = document.getElementById('ai-msg');
  if (msgEl) msgEl.textContent = state.message || (state.thinking ? 'Looking at your screen…' : 'Getting my bearings…');

  // The "why" — shown when Claude provided reasoning.
  const whyEl = document.getElementById('ai-why');
  if (whyEl) {
    if (state.reasoning) { whyEl.style.display = ''; whyEl.innerHTML = '<b>Why:</b> ' + escapeHtml(state.reasoning); }
    else whyEl.style.display = 'none';
  }

  // No-key hint.
  const hint = document.getElementById('ai-hint');
  if (hint) hint.style.display = state.hasApiKey ? 'none' : '';

  clearStatusIfMine();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function refresh() { render(await getState()); }

function disarmStop() {
  stopArmed = false;
  if (stopArmTimer) { clearTimeout(stopArmTimer); stopArmTimer = null; }
  const btn = document.getElementById('btn-stop');
  if (btn) { btn.classList.remove('confirming'); btn.innerHTML = '✗ Stop Guidance'; }
}

function startWorkflow() {
  lastStateJson = '';
  return new Promise(resolve => chrome.runtime.sendMessage({ type: 'START_WORKFLOW', workflowId: 'meta-connect-assets' }, resolve));
}

document.getElementById('btn-start').addEventListener('click', async () => { await startWorkflow(); await refresh(); });

const btnRestart = document.getElementById('btn-restart');
if (btnRestart) btnRestart.addEventListener('click', async () => { await startWorkflow(); await refresh(); });

document.getElementById('btn-next').addEventListener('click', async () => {
  disarmStop();
  setStatus('Taking another look…', 2500);
  await new Promise(resolve => chrome.runtime.sendMessage({ type: 'NEXT_STEP' }, resolve));
  await refresh();
});

document.getElementById('btn-stuck').addEventListener('click', async () => {
  disarmStop();
  setStatus('Re-checking your screen…', 2500);
  await new Promise(resolve => chrome.runtime.sendMessage({ type: 'STUCK' }, resolve));
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
  await new Promise(resolve => chrome.runtime.sendMessage({ type: 'STOP' }, resolve));
  lastStateJson = '';
  statusHoldUntil = 0;
  await refresh();
});

setInterval(refresh, 1200);
refresh();
