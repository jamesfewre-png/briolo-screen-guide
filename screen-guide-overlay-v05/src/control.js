const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');
const taskEl = document.getElementById('task');
const instructionText = document.getElementById('instructionText');
const confidenceLabel = document.getElementById('confidenceLabel');
const stepLabel = document.getElementById('stepLabel');
const stepDots = document.getElementById('stepDots');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const helperHint = document.getElementById('helperHint');
const debugToggle = document.getElementById('debugToggle');
const debugPanel = document.getElementById('debugPanel');
const debugContent = document.getElementById('debugContent');
const domPillsEl = document.getElementById('domPills');
const navigateBanner = document.getElementById('navigateBanner');
const navigateBtn = document.getElementById('navigateBtn');

let running = false;
let paused = false;
let loopTimer = null;
let currentIntervalMs = 900;
let lastAnalyzing = false;
let stream = null;

const video = document.createElement('video');
video.autoplay = true;
video.muted = true;
const captureCanvas = document.createElement('canvas');

window.screenGuide.onPageStateUpdate(updatePageStateDisplay);

window.screenGuide.onWorkflowStepChange(({ step, index, total }) => {
  stepLabel.textContent = `Step ${index + 1} of ${total}`;
  if (step) instructionText.textContent = step.instruction;
  confidenceLabel.textContent = '';
  navigateBanner.classList.remove('visible');
  renderStepDots(index, total);
});

window.screenGuide.onNavigate(({ url, label }) => {
  if (url) {
    navigateBtn.textContent = `Open ${label.replace(/-/g, ' ')} →`;
    navigateBtn.onclick = () => window.screenGuide.openUrl(url);
    navigateBanner.classList.add('visible');
  }
});

window.screenGuide.onWorkflowStatusChange(({ event, state }) => {
  if (state === 'complete') {
    instructionText.textContent = 'All done! Your Meta account is connected.';
    setConfidence(1);
    stopGuidance();
  }
  if (event === 'stuck') {
    confidenceLabel.className = 'confidence-label confidence-unsure';
    confidenceLabel.textContent = 'Not sure — scroll slowly or tell me what you see.';
  }
});

window.screenGuide.onRedetect(() => {
  if (running && !paused && !lastAnalyzing) captureAndAnalyze();
});

function updatePageStateDisplay(payload) {
  const state = payload?.state;
  const ageMs = payload?.receivedAt ? Date.now() - payload.receivedAt : null;
  const fresh = ageMs !== null && ageMs < 2500;
  const connected = Boolean(state);

  statusDot.className = 'status-dot ' + (connected ? 'connected' : 'disconnected');
  statusText.textContent = connected
    ? `Browser helper connected · ${state.elements?.length || 0} elements`
    : 'Browser helper not connected';
  helperHint.className = 'helper-hint' + (connected ? '' : ' visible');

  domPillsEl.innerHTML = connected
    ? `<span class="pill ${fresh ? 'ok' : 'warn'}">${fresh ? 'Fresh' : 'Stale'} DOM · ${ageMs ?? '—'}ms</span>
       <span class="pill">${state.elements?.length || 0} elements</span>
       <span class="pill">${tryHostname(state.url)}</span>`
    : '<span class="pill bad">DOM disconnected</span>';
}

function tryHostname(url) {
  try { return new URL(url || 'http://unknown').hostname; } catch { return 'unknown'; }
}

function renderStepDots(current, total) {
  if (!total) { stepDots.innerHTML = ''; return; }
  let html = '';
  for (let i = 0; i < total; i++) {
    if (i > 0) html += `<div class="dot-connector${i <= current ? ' done' : ''}"></div>`;
    let cls = 'dot';
    if (i < current) cls += ' done';
    else if (i === current) cls += ' active';
    html += `<div class="${cls}"></div>`;
  }
  stepDots.innerHTML = html;
}

function setConfidence(confidence) {
  if (confidence >= 0.75) {
    confidenceLabel.className = 'confidence-label confidence-confirmed';
    confidenceLabel.textContent = 'Confirmed';
  } else if (confidence >= 0.45) {
    confidenceLabel.className = 'confidence-label confidence-checking';
    confidenceLabel.textContent = 'Checking…';
  } else {
    confidenceLabel.className = 'confidence-label confidence-unsure';
    confidenceLabel.textContent = 'Not sure — scroll slowly';
  }
}

async function startGuidance() {
  running = true; paused = false;
  startBtn.disabled = true; pauseBtn.disabled = false; stopBtn.disabled = false;

  stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1, displaySurface: 'monitor' }, audio: false });
  video.srcObject = stream;
  await video.play();
  stream.getVideoTracks()[0].addEventListener('ended', stopGuidance);

  const result = await window.screenGuide.startWorkflow('meta-connect-assets');
  if (result.step) instructionText.textContent = result.step.instruction;
  renderStepDots(result.stepIndex || 0, result.totalSteps || 6);
  stepLabel.textContent = `Step ${(result.stepIndex || 0) + 1} of ${result.totalSteps || 6}`;
  scheduleLoop(300);
}

function pauseGuidance() {
  paused = !paused;
  pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  window.screenGuide.pauseWorkflow(paused);
  if (!paused) scheduleLoop(200);
  if (paused) {
    instructionText.textContent = 'Paused. Click Resume to continue.';
    confidenceLabel.textContent = '';
  }
}

function stopGuidance() {
  running = false; paused = false;
  if (loopTimer) clearTimeout(loopTimer);
  loopTimer = null;
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  startBtn.disabled = false;
  pauseBtn.disabled = true; pauseBtn.textContent = 'Pause';
  stopBtn.disabled = true;
  window.screenGuide.stopWorkflow();
  stepDots.innerHTML = '';
  stepLabel.textContent = 'Stopped';
  instructionText.textContent = 'Click Start Guidance to begin.';
  confidenceLabel.textContent = '';
}

function scheduleLoop(delay) {
  const d = (delay !== undefined) ? delay : currentIntervalMs;
  if (!running || paused) return;
  if (loopTimer) clearTimeout(loopTimer);
  loopTimer = setTimeout(captureAndAnalyze, d);
}

function captureFrame() {
  if (!video.videoWidth) return null;
  const maxW = 800;
  const scale = Math.min(1, maxW / video.videoWidth);
  captureCanvas.width = Math.round(video.videoWidth * scale);
  captureCanvas.height = Math.round(video.videoHeight * scale);
  const ctx = captureCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
  return captureCanvas.toDataURL('image/jpeg', 0.40);
}

async function captureAndAnalyze() {
  if (!running || paused || lastAnalyzing) { scheduleLoop(200); return; }
  lastAnalyzing = true;
  try {
    const frameDataUrl = captureFrame();
    const result = await window.screenGuide.analyzeFrame({
      task: taskEl.value.trim(), frameDataUrl,
      captureMeta: { videoWidth: video.videoWidth, videoHeight: video.videoHeight }
    });
    debugContent.textContent = JSON.stringify(result, null, 2);
    const confidence = Number(result?.confidence || 0);
    setConfidence(confidence);
    if (result?.instruction && result?.status !== 'wrong-page') instructionText.textContent = result.instruction;
    currentIntervalMs = confidence < 0.55 ? 800 : 2000;
  } catch (err) {
    debugContent.textContent = `Error: ${err.message}`;
    currentIntervalMs = 1200;
  } finally {
    lastAnalyzing = false;
    scheduleLoop(currentIntervalMs);
  }
}

async function refreshPageState() {
  const payload = await window.screenGuide.getPageState();
  updatePageStateDisplay(payload);
}
setInterval(refreshPageState, 1500);
refreshPageState();

startBtn.addEventListener('click', startGuidance);
pauseBtn.addEventListener('click', pauseGuidance);
stopBtn.addEventListener('click', stopGuidance);
debugToggle.addEventListener('click', () => {
  debugPanel.classList.toggle('open');
  debugToggle.textContent = debugPanel.classList.contains('open') ? '▾ Hide debug panel' : '▸ Show debug panel';
});
