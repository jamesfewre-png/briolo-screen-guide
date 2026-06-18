let lastStateJson = '';
// Timestamp until which the polling render must not overwrite a user-visible
// status message. Set whenever we show a transient status; render() respects it.
let statusHoldUntil = 0;
// Inline two-tap stop confirmation state.
let stopArmed = false;
let stopArmTimer = null;

async function getState() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, res => {
      resolve(res || { enabled: false });
    });
  });
}

function setStatus(text, holdMs) {
  const el = document.getElementById('status-msg');
  if (el) el.textContent = text;
  statusHoldUntil = text ? Date.now() + (holdMs || 0) : 0;
}

function clearStatusIfMine() {
  // Only clear if the hold window has elapsed (avoids wiping a fresh message
  // queued by another interaction).
  if (Date.now() >= statusHoldUntil) {
    const el = document.getElementById('status-msg');
    if (el) el.textContent = '';
    statusHoldUntil = 0;
  }
}

function setBadge(confidence) {
  const el = document.getElementById('confidence-badge');
  if (!el) return;
  if (confidence === null || confidence === undefined) { el.textContent = ''; el.className = 'badge'; return; }
  const cls = confidence >= 70 ? 'badge-green' : confidence >= 40 ? 'badge-amber' : 'badge-red';
  el.className = 'badge ' + cls;
  el.textContent = confidence + '% match';
}

function setAiMode(hasApiKey) {
  const dot = document.getElementById('ai-dot');
  const text = document.getElementById('ai-mode-text');
  if (dot) dot.className = 'ai-dot ' + (hasApiKey ? 'on' : 'off');
  if (text) text.textContent = hasApiKey
    ? 'AI mode: on'
    : 'AI mode: off (text-match fallback)';
}

function render(state) {
  // hasApiKey can change independently of workflow state, so always refresh the
  // start-screen indicator before the dedup short-circuit.
  setAiMode(!!state.hasApiKey);

  const json = JSON.stringify(state);
  if (json === lastStateJson) {
    // State unchanged — still let an expired status message clear itself.
    clearStatusIfMine();
    return;
  }
  lastStateJson = json;

  const startScreen = document.getElementById('start-screen');
  const workflowScreen = document.getElementById('workflow-screen');
  const doneScreen = document.getElementById('done-screen');

  // Terminal state takes priority — show the completion view.
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

  const step = state.step || {};
  const idx = state.stepIndex ?? 0;
  const total = state.totalSteps || 0; // 0 until the workflow JSON loads

  // Progress: step 1 reads 0%, final step reads 100%. Guard total <= 1.
  const denom = total > 1 ? total - 1 : 1;
  const pct = Math.max(0, Math.min(100, Math.round((idx / denom) * 100)));

  document.getElementById('step-num').textContent = String(idx + 1);
  document.getElementById('step-total').textContent = total ? String(total) : '—';
  document.getElementById('step-name').textContent = step.name || '—';
  document.getElementById('instruction-text').textContent = step.instruction || '—';
  document.getElementById('progress-fill').style.width = pct + '%';
  // Navigation-only steps have no targetText, so a 0%/red "match" badge would
  // read like a failure — suppress it for those and show it only when there's
  // an element to match.
  const hasTarget = !!(step && step.targetText);
  setBadge(hasTarget ? (state.confidence ?? null) : null);

  // Show the AI-disabled hint only when there's no API key AND we have no usable
  // confidence signal (null or low) — i.e. when AI assist would have helped.
  const conf = state.confidence;
  const lowOrNoConfidence = conf === null || conf === undefined || conf < 40;
  const hint = document.getElementById('ai-hint');
  if (hint) hint.style.display = (!state.hasApiKey && lowOrNoConfidence) ? '' : 'none';

  clearStatusIfMine();
}

async function refresh() {
  const state = await getState();
  render(state);
}

function disarmStop() {
  stopArmed = false;
  if (stopArmTimer) { clearTimeout(stopArmTimer); stopArmTimer = null; }
  const btn = document.getElementById('btn-stop');
  if (btn) {
    btn.classList.remove('confirming');
    btn.innerHTML = '✗ Stop Guidance';
  }
}

document.getElementById('btn-start').addEventListener('click', async () => {
  await new Promise(resolve => chrome.runtime.sendMessage({ type: 'START_WORKFLOW', workflowId: 'meta-connect-assets' }, resolve));
  await refresh();
});

const btnRestart = document.getElementById('btn-restart');
if (btnRestart) btnRestart.addEventListener('click', async () => {
  lastStateJson = '';
  await new Promise(resolve => chrome.runtime.sendMessage({ type: 'START_WORKFLOW', workflowId: 'meta-connect-assets' }, resolve));
  await refresh();
});

document.getElementById('btn-next').addEventListener('click', async () => {
  disarmStop();
  setStatus('Moving to next step…', 1500);
  await new Promise(resolve => chrome.runtime.sendMessage({ type: 'NEXT_STEP' }, resolve));
  await refresh();
});

document.getElementById('btn-stuck').addEventListener('click', async () => {
  disarmStop();
  setStatus('Re-highlighting target…', 2000);
  await new Promise(resolve => chrome.runtime.sendMessage({ type: 'STUCK' }, resolve));
});

document.getElementById('btn-stop').addEventListener('click', async () => {
  const btn = document.getElementById('btn-stop');
  if (!stopArmed) {
    // First tap: arm and ask for a second tap. Auto-disarm after 3s.
    stopArmed = true;
    if (btn) { btn.classList.add('confirming'); btn.innerHTML = 'Tap again to stop'; }
    stopArmTimer = setTimeout(disarmStop, 3000);
    return;
  }
  // Second tap: actually stop.
  disarmStop();
  await new Promise(resolve => chrome.runtime.sendMessage({ type: 'STOP' }, resolve));
  lastStateJson = '';
  statusHoldUntil = 0;
  await refresh();
});

setInterval(refresh, 1500);
refresh();
