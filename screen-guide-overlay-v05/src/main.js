const path = require('path');
const http = require('http');

// Guard Electron-only requires so plain-Node test imports of this file don't crash
let app, BrowserWindow, ipcMain, screen;
try {
  const electron = require('electron');
  app = electron.app;
  BrowserWindow = electron.BrowserWindow;
  ipcMain = electron.ipcMain;
  screen = electron.screen;
} catch (_) {}

const { WorkflowEngine } = require('./workflow/engine');
const { Tracker } = require('./tracking/tracker');
const { analyzeFrame } = require('./ai/claudeReasoner');

const BRIDGE_PORT = Number(process.env.SCREEN_GUIDE_PORT || 17391);

let controlWindow;
let overlayWindow;
let bridgeServer;
let latestPageState = null;
let latestPageStateAt = 0;
let latestGuidance = null;

const engine = new WorkflowEngine();
const tracker = new Tracker({
  getPageState: () => latestPageState,
  sendOverlay: (guidance) => sendOverlay(guidance)
});

engine.onStepChange(({ step, index, total }) => {
  tracker.clearAnchor();
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('workflow:step-change', { step, index, total });
  }
});

engine.onStatusChange(({ event, state }) => {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('workflow:status-change', { event, state });
  }
});

tracker.onRedetectNeeded(() => {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('guide:redetect');
  }
});

function createWindows() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { x, y, width, height } = primaryDisplay.bounds;

  controlWindow = new BrowserWindow({
    width: 520, height: 780, minWidth: 420, minHeight: 560,
    x: x + 40, y: y + 40,
    title: 'AI Screen Guide',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  controlWindow.loadFile(path.join(__dirname, 'control.html'));

  overlayWindow = new BrowserWindow({
    x, y, width, height,
    frame: false, transparent: true, resizable: false, movable: false,
    hasShadow: false, focusable: false, skipTaskbar: true, alwaysOnTop: true,
    title: 'AI Screen Guide Overlay',
    webPreferences: {
      preload: path.join(__dirname, 'overlayPreload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWindow.once('ready-to-show', () => overlayWindow.showInactive());
}

function sendOverlay(guidance) {
  latestGuidance = guidance;
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('overlay:update', guidance);
  }
}

function sendPageStateToControl() {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('page-state:update', { state: latestPageState, receivedAt: latestPageStateAt });
  }
}

function sanitizePageState(input) {
  const elements = Array.isArray(input.elements) ? input.elements.slice(0, 250).map(el => ({
    id: String(el.id || ''),
    tag: String(el.tag || '').slice(0, 24),
    role: String(el.role || '').slice(0, 64),
    type: String(el.type || '').slice(0, 64),
    text: String(el.text || '').replace(/\s+/g, ' ').trim().slice(0, 220),
    selector: String(el.selector || '').slice(0, 500),
    href: String(el.href || '').slice(0, 500),
    isClickable: Boolean(el.isClickable),
    isInput: Boolean(el.isInput),
    visible: Boolean(el.visible),
    disabled: Boolean(el.disabled),
    rect: normalizeRect(el.rect),
    screenRect: normalizeRect(el.screenRect),
    center: el.center ? { x: Number(el.center.x || 0), y: Number(el.center.y || 0) } : null,
    evidence: Array.isArray(el.evidence) ? el.evidence.slice(0, 8).map(String) : []
  })) : [];
  return {
    source: 'browser-helper',
    url: String(input.url || '').slice(0, 1500),
    title: String(input.title || '').slice(0, 500),
    origin: String(input.origin || '').slice(0, 500),
    viewport: input.viewport || null,
    windowMetrics: input.windowMetrics || null,
    activeElement: input.activeElement || null,
    scroll: input.scroll || null,
    elements,
    summaryText: String(input.summaryText || '').replace(/\s+/g, ' ').trim().slice(0, 2000),
    capturedAt: input.capturedAt || new Date().toISOString()
  };
}

function normalizeRect(rect) {
  if (!rect || typeof rect !== 'object') return null;
  return { x: Number(rect.x || 0), y: Number(rect.y || 0), w: Number(rect.w || rect.width || 0), h: Number(rect.h || rect.height || 0) };
}

function startBridgeServer() {
  bridgeServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Screen-Guide-Source');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, app: 'screen-guide-overlay-v05', port: BRIDGE_PORT }));
      return;
    }

    if (req.method === 'POST' && req.url === '/page-state') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); if (body.length > 2_000_000) req.destroy(); });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}');
          latestPageState = sanitizePageState(parsed);
          latestPageStateAt = Date.now();
          sendPageStateToControl();

          const engineResult = engine.updatePageState(latestPageState);
          if (engineResult?.status === 'wrong-page') {
            const step = engineResult.step;
            sendOverlay({ type: 'message', message: `You're on the wrong page. ${step.fallback}`, confidence: 0.99 });
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, receivedAt: latestPageStateAt }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Not found' }));
  });
  bridgeServer.listen(BRIDGE_PORT, '127.0.0.1', () => {
    console.log(`Screen Guide bridge listening on http://127.0.0.1:${BRIDGE_PORT}`);
  });
}

function registerIpcHandlers() {
  ipcMain.handle('guide:analyze-frame', async (_e, payload) => {
    const pageStateAgeMs = latestPageStateAt ? Date.now() - latestPageStateAt : null;
    const currentStep = engine.getCurrentStep();

    const result = await analyzeFrame({
      ...payload,
      workflowStep: currentStep,
      pageState: latestPageState,
      pageStateAgeMs,
      previousGuidance: latestGuidance
    });

    sendOverlay(result.overlay || result);

    if (result.target?.screenRect && result.confidence >= 0.52) {
      tracker.setAnchor({
        selector: result.target.selector,
        text: result.target.text,
        role: result.target.role,
        screenRect: result.target.screenRect,
        confidence: result.confidence,
        overlayTemplate: result.overlay
      });
    } else {
      tracker.clearAnchor();
    }

    if (result.confidence < 0.45) engine.markStuck();
    else engine.resetStuck();

    if (result.status === 'complete') engine.advanceStep();

    return result;
  });

  ipcMain.handle('guide:get-page-state', async () => ({
    state: latestPageState, receivedAt: latestPageStateAt,
    ageMs: latestPageStateAt ? Date.now() - latestPageStateAt : null
  }));

  ipcMain.handle('guide:clear-overlay', async () => { sendOverlay({ type: 'clear' }); return { ok: true }; });
  ipcMain.handle('guide:show-overlay', async (_e, guidance) => { sendOverlay(guidance); return { ok: true }; });

  ipcMain.handle('guide:start-workflow', async (_e, workflowId) => {
    engine.load(workflowId);
    engine.start();
    tracker.start();
    const step = engine.getCurrentStep();
    return { ok: true, step, stepIndex: engine.getStepIndex(), totalSteps: engine.getTotalSteps() };
  });

  ipcMain.handle('guide:pause-workflow', async (_e, paused) => {
    if (paused) { engine.pause(); tracker.stop(); }
    else { engine.resume(); tracker.start(); }
    return { ok: true };
  });

  ipcMain.handle('guide:stop-workflow', async () => {
    engine.stop();
    tracker.stop();
    tracker.clearAnchor();
    sendOverlay({ type: 'clear' });
    return { ok: true };
  });
}

if (app) {
  app.whenReady().then(() => {
    startBridgeServer();
    registerIpcHandlers();
    createWindows();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindows(); });
  });

  app.on('before-quit', () => { if (bridgeServer) bridgeServer.close(); tracker.stop(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

module.exports = { sanitizePageState, normalizeRect, sendOverlay };
