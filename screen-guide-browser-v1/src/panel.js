let lastStateJson = '';

async function getState() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, res => {
      resolve(res || { enabled: false });
    });
  });
}

function setBadge(confidence) {
  const el = document.getElementById('confidence-badge');
  if (!el) return;
  if (confidence === null || confidence === undefined) { el.textContent = ''; return; }
  const cls = confidence >= 70 ? 'badge-green' : confidence >= 40 ? 'badge-amber' : 'badge-red';
  el.className = 'badge ' + cls;
  el.textContent = confidence + '% match';
}

function render(state) {
  const json = JSON.stringify(state);
  if (json === lastStateJson) return;
  lastStateJson = json;

  const startScreen = document.getElementById('start-screen');
  const workflowScreen = document.getElementById('workflow-screen');

  if (!state.enabled) {
    startScreen.style.display = '';
    workflowScreen.style.display = 'none';
    return;
  }

  startScreen.style.display = 'none';
  workflowScreen.style.display = '';

  const step = state.step || {};
  const idx = state.stepIndex ?? 0;
  const total = state.totalSteps ?? 7;

  document.getElementById('step-num').textContent = String(idx + 1);
  document.getElementById('step-total').textContent = String(total);
  document.getElementById('step-name').textContent = step.name || '—';
  document.getElementById('instruction-text').textContent = step.instruction || '—';
  document.getElementById('progress-fill').style.width = Math.round(((idx) / total) * 100) + '%';
  setBadge(state.confidence ?? null);
}

async function refresh() {
  const state = await getState();
  render(state);
}

document.getElementById('btn-start').addEventListener('click', async () => {
  await new Promise(resolve => chrome.runtime.sendMessage({ type: 'START_WORKFLOW', workflowId: 'meta-connect-assets' }, resolve));
  await refresh();
});

document.getElementById('btn-next').addEventListener('click', async () => {
  document.getElementById('status-msg').textContent = 'Moving to next step…';
  await new Promise(resolve => chrome.runtime.sendMessage({ type: 'NEXT_STEP' }, resolve));
  setTimeout(() => { document.getElementById('status-msg').textContent = ''; }, 1500);
  await refresh();
});

document.getElementById('btn-stuck').addEventListener('click', async () => {
  document.getElementById('status-msg').textContent = 'Re-highlighting target…';
  await new Promise(resolve => chrome.runtime.sendMessage({ type: 'STUCK' }, resolve));
  setTimeout(() => { document.getElementById('status-msg').textContent = ''; }, 2000);
});

document.getElementById('btn-stop').addEventListener('click', async () => {
  if (!confirm('Stop guidance?')) return;
  await new Promise(resolve => chrome.runtime.sendMessage({ type: 'STOP' }, resolve));
  lastStateJson = '';
  await refresh();
});

setInterval(refresh, 1500);
refresh();
