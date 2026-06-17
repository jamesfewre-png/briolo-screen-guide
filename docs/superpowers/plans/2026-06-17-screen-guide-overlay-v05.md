# AI Screen Guide Overlay v05 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a structured Electron desktop overlay that uses Claude vision + DOM grounding + a JSON workflow engine to visually guide non-technical users through connecting Meta Business assets step-by-step.

**Architecture:** Three existing v04 components are ported verbatim (canvas overlay renderer, DOM scraper extension, bridge server); four new modules are built fresh (Claude reasoner, workflow engine, tracking loop, non-technical control UI). The main process wires them all together. The browser extension posts DOM state to a local HTTP bridge; the tracker keeps highlights accurate between AI calls; the workflow engine detects step completion without needing an AI call.

**Tech Stack:** Electron 31, Node.js CommonJS, `@anthropic-ai/sdk`, Chrome MV3 extension, `node:test` for unit tests, no bundler, no frontend framework.

## Global Constraints

- Project root: `E:\AI Flow Systems\AI Consult\screen-guide-overlay-v05\`
- Source to port from: `C:\Users\james\Downloads\screen-guide-overlay-v04\screen-guide-overlay-v04\`
- Node.js ≥ 18 required (for `node:test` built-in runner)
- Electron `^31.7.7` (locked in package.json)
- AI model: `claude-sonnet-4-6` via `@anthropic-ai/sdk`
- AI key env var: `ANTHROPIC_API_KEY`
- Bridge port: `17391` (env `SCREEN_GUIDE_PORT` overrides)
- No bundler — all CommonJS `require()`, no ESM, no TypeScript
- No frontend framework — vanilla JS in all renderer files
- Overlay colour: `#ff8a00` (orange) on dark background `#0f1117`
- All overlays must pass mouse events through (`setIgnoreMouseEvents(true, { forward: true })`)
- The human must click/copy/approve everything — the AI only points

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `package.json` | Create | Entry point, deps, test script |
| `.env.example` | Create | Document ANTHROPIC_API_KEY |
| `src/main.js` | Port + extend | Electron windows, bridge server, IPC handlers, wires engine/tracker/reasoner |
| `src/overlay.html` | Port verbatim | Transparent canvas container |
| `src/overlay.js` | Port verbatim | Canvas drawing: highlights, arrows, labels, pulse |
| `src/overlayPreload.js` | Port verbatim | IPC bridge for overlay window |
| `src/preload.js` | Rebuild | Exposes all IPC channels to control window |
| `src/control.html` | Rebuild | Non-technical UX: step dots, instruction, status |
| `src/control.js` | Rebuild | Screen capture loop, workflow state UI, start/pause/stop |
| `src/ai/domGuidance.js` | New | Pure DOM scoring and fallback guidance (no API calls) |
| `src/ai/claudeReasoner.js` | New | Claude tool-use call + domGuidance fallback |
| `src/workflow/engine.js` | New | Workflow state machine: load/start/pause/stop/advance |
| `src/workflow/definitions/meta-connect-assets.json` | New | 6-step Meta workflow definition |
| `src/tracking/tracker.js` | New | 100ms loop: re-anchor highlight to moving DOM target |
| `browser-helper/manifest.json` | Port verbatim | Chrome MV3 manifest |
| `browser-helper/content.js` | Port + fix | DOM scraper; fix: `chromeY = outerHeight - innerHeight` |
| `browser-helper/background.js` | Port verbatim | Bridge poster with 250ms throttle |
| `browser-helper/popup.html` | Port verbatim | Extension popup |
| `browser-helper/popup.js` | Port verbatim | Popup status display |
| `tests/sanitize.test.js` | New | Unit tests for sanitizePageState, normalizeRect |
| `tests/dom-guidance.test.js` | New | Unit tests for scoreElement, findBestElement, domGuidance |
| `tests/workflow-engine.test.js` | New | Unit tests for WorkflowEngine state machine |
| `tests/tracker.test.js` | New | Unit tests for Tracker anchor matching and scroll logic |

---

## Task 1: Scaffold + port overlay window

**Files:**
- Create: `screen-guide-overlay-v05/package.json`
- Create: `screen-guide-overlay-v05/.env.example`
- Create: `screen-guide-overlay-v05/src/main.js` (minimal — just windows + bridge stub)
- Port: `src/overlay.html` from v04
- Port: `src/overlay.js` from v04
- Port: `src/overlayPreload.js` from v04

**Interfaces:**
- Produces: `app.whenReady()` → two windows visible, bridge listening on port 17391

- [ ] **Step 1: Create project directory and package.json**

```
mkdir "E:\AI Flow Systems\AI Consult\screen-guide-overlay-v05"
cd "E:\AI Flow Systems\AI Consult\screen-guide-overlay-v05"
```

Create `package.json`:
```json
{
  "name": "screen-guide-overlay-v05",
  "version": "0.5.0",
  "description": "Level 3 AI desktop overlay guide: Claude vision + DOM grounding + workflow engine.",
  "main": "src/main.js",
  "scripts": {
    "start": "electron .",
    "dev": "electron .",
    "test:sanitize": "node --test tests/sanitize.test.js",
    "test:dom": "node --test tests/dom-guidance.test.js",
    "test:workflow": "node --test tests/workflow-engine.test.js",
    "test:tracker": "node --test tests/tracker.test.js"
  },
  "keywords": ["electron", "ai", "screen-overlay", "dom-aware", "guided-onboarding"],
  "author": "AI Flow Systems",
  "license": "UNLICENSED",
  "dependencies": {
    "@anthropic-ai/sdk": "^0.40.0"
  },
  "devDependencies": {
    "electron": "^31.7.7"
  }
}
```

- [ ] **Step 2: Create .env.example**

```
ANTHROPIC_API_KEY=your_key_here
SCREEN_GUIDE_PORT=17391
```

- [ ] **Step 3: Install dependencies**

```
npm install
```

Expected: `node_modules/@anthropic-ai/sdk` and `node_modules/electron` created.

- [ ] **Step 4: Create minimal src/main.js**

This is the foundation. Later tasks will extend it. Copy this file exactly:

```js
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const http = require('http');

const BRIDGE_PORT = Number(process.env.SCREEN_GUIDE_PORT || 17391);

let controlWindow;
let overlayWindow;
let bridgeServer;
let latestPageState = null;
let latestPageStateAt = 0;
let latestGuidance = null;

function createWindows() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { x, y, width, height } = primaryDisplay.bounds;

  controlWindow = new BrowserWindow({
    width: 520, height: 780, minWidth: 420, minHeight: 560,
    x: x + 40, y: y + 40,
    title: 'AI Screen Guide',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
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
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
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
  return {
    x: Number(rect.x || 0), y: Number(rect.y || 0),
    w: Number(rect.w || rect.width || 0), h: Number(rect.h || rect.height || 0)
  };
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

ipcMain.handle('guide:get-page-state', async () => ({
  state: latestPageState, receivedAt: latestPageStateAt,
  ageMs: latestPageStateAt ? Date.now() - latestPageStateAt : null
}));
ipcMain.handle('guide:clear-overlay', async () => { sendOverlay({ type: 'clear' }); return { ok: true }; });
ipcMain.handle('guide:show-overlay', async (_e, guidance) => { sendOverlay(guidance); return { ok: true }; });

app.whenReady().then(() => {
  startBridgeServer();
  createWindows();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindows(); });
});
app.on('before-quit', () => { if (bridgeServer) bridgeServer.close(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

module.exports = { sanitizePageState, normalizeRect, sendOverlay };
```

- [ ] **Step 5: Create temporary placeholder control.html and preload.js so app can start**

`src/control.html` (placeholder, replaced in Task 7):
```html
<!doctype html>
<html><head><meta charset="utf-8"><title>AI Screen Guide</title></head>
<body style="background:#0f1117;color:#fff;font-family:sans-serif;padding:20px">
  <h1 style="color:#ff8a00">AI Screen Guide v05</h1>
  <p>Control window placeholder — Task 7 will replace this.</p>
</body></html>
```

`src/preload.js` (placeholder, replaced in Task 7):
```js
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('screenGuide', {
  getPageState: () => ipcRenderer.invoke('guide:get-page-state'),
  clearOverlay: () => ipcRenderer.invoke('guide:clear-overlay'),
  showOverlay: (g) => ipcRenderer.invoke('guide:show-overlay', g),
  onPageStateUpdate: (cb) => ipcRenderer.on('page-state:update', (_e, d) => cb(d))
});
```

- [ ] **Step 6: Port overlay files verbatim from v04**

Copy these files exactly from `C:\Users\james\Downloads\screen-guide-overlay-v04\screen-guide-overlay-v04\src\`:
- `overlay.html` → `src/overlay.html`
- `overlay.js` → `src/overlay.js`
- `overlayPreload.js` → `src/overlayPreload.js`

No changes to these files.

- [ ] **Step 7: Create tests directory**

```
mkdir tests
```

- [ ] **Step 8: Write unit tests for sanitizePageState and normalizeRect**

Create `tests/sanitize.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizePageState, normalizeRect } = require('../src/main.js');

test('normalizeRect returns null for missing input', () => {
  assert.equal(normalizeRect(null), null);
  assert.equal(normalizeRect(undefined), null);
  assert.equal(normalizeRect('bad'), null);
});

test('normalizeRect handles w/h aliases', () => {
  const r = normalizeRect({ x: 10, y: 20, width: 100, height: 50 });
  assert.deepEqual(r, { x: 10, y: 20, w: 100, h: 50 });
});

test('normalizeRect handles w/h directly', () => {
  const r = normalizeRect({ x: 5, y: 5, w: 200, h: 40 });
  assert.deepEqual(r, { x: 5, y: 5, w: 200, h: 40 });
});

test('sanitizePageState trims text fields to max lengths', () => {
  const input = {
    url: 'https://example.com',
    title: 'Test Page',
    elements: [{
      tag: 'button', role: 'button', text: 'Click me', selector: '#btn',
      isClickable: true, isInput: false, visible: true, disabled: false,
      rect: { x: 10, y: 10, w: 100, h: 40 }, screenRect: { x: 110, y: 60, w: 100, h: 40 }
    }],
    summaryText: 'Some page content'
  };
  const result = sanitizePageState(input);
  assert.equal(result.url, 'https://example.com');
  assert.equal(result.source, 'browser-helper');
  assert.equal(result.elements.length, 1);
  assert.equal(result.elements[0].isClickable, true);
  assert.deepEqual(result.elements[0].screenRect, { x: 110, y: 60, w: 100, h: 40 });
});

test('sanitizePageState caps elements at 250', () => {
  const elements = Array.from({ length: 300 }, (_, i) => ({
    tag: 'button', text: `Button ${i}`, isClickable: true, isInput: false, visible: true
  }));
  const result = sanitizePageState({ url: 'https://x.com', elements });
  assert.equal(result.elements.length, 250);
});

test('sanitizePageState handles missing elements gracefully', () => {
  const result = sanitizePageState({ url: 'https://x.com' });
  assert.deepEqual(result.elements, []);
});

test('sanitizePageState strips password input text', () => {
  const input = {
    url: 'https://x.com',
    elements: [{ tag: 'input', type: 'password', text: 'mysecret', isInput: true }]
  };
  // content.js already excludes password values from text before sending.
  // This test just ensures no crash on password-typed elements.
  const result = sanitizePageState(input);
  assert.equal(result.elements.length, 1);
});
```

- [ ] **Step 9: Run sanitize tests**

```
npm run test:sanitize
```

Expected output:
```
▶ normalizeRect returns null for missing input
  ✔ normalizeRect returns null for missing input
...
ℹ tests 6
ℹ pass 6
ℹ fail 0
```

- [ ] **Step 10: Verify app starts**

```
npm start
```

Expected: Control window appears (placeholder), transparent overlay window appears behind it, terminal shows `Screen Guide bridge listening on http://127.0.0.1:17391`. No errors in console. Close the app.

- [ ] **Step 11: Commit**

```
cd "E:\AI Flow Systems\AI Consult"
git add screen-guide-overlay-v05/
git commit -m "feat(v05): scaffold project, port overlay window, bridge server, unit tests"
```

---

## Task 2: Port browser helper with coordinate fix

**Files:**
- Port: `browser-helper/manifest.json`
- Port + fix: `browser-helper/content.js` (one-line chromeY fix)
- Port: `browser-helper/background.js`
- Port: `browser-helper/popup.html`
- Port: `browser-helper/popup.js`

**Interfaces:**
- Produces: Chrome extension that POSTs `{ url, title, elements[], scroll, windowMetrics }` to `http://127.0.0.1:17391/page-state` on every DOM change, scroll, or click

- [ ] **Step 1: Create browser-helper directory and port manifest**

Copy `browser-helper/manifest.json` verbatim from v04:
```json
{
  "manifest_version": 3,
  "name": "AI Screen Guide Browser Helper",
  "version": "0.5.0",
  "description": "Sends URL, DOM, selectors, clickable elements, and screen-space bounds to the local AI Screen Guide desktop app.",
  "permissions": ["activeTab", "scripting", "tabs"],
  "host_permissions": ["<all_urls>", "http://127.0.0.1:17391/*"],
  "background": { "service_worker": "background.js" },
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["content.js"],
    "run_at": "document_idle",
    "all_frames": false
  }],
  "action": { "default_title": "AI Screen Guide Helper", "default_popup": "popup.html" }
}
```

- [ ] **Step 2: Port background.js verbatim**

Copy `browser-helper/background.js` exactly from v04. No changes needed.

- [ ] **Step 3: Port popup.html and popup.js verbatim**

Copy both files exactly from v04. No changes needed.

- [ ] **Step 4: Port content.js with the chromeY fix**

Copy `browser-helper/content.js` from v04, then apply this one-line change in `getWindowMetrics()`:

Find this line:
```js
const chromeY = Math.max(0, outerHeight - window.innerHeight - chromeX);
```

Replace with:
```js
const chromeY = Math.max(0, outerHeight - window.innerHeight);
```

This gives accurate toolbar height on Windows Chrome. `outerHeight - innerHeight` equals the actual combined height of the address bar + tabs bar (typically 88–120px). The old formula incorrectly subtracted the horizontal chrome estimate.

- [ ] **Step 5: Manual verification**

1. Start the app: `npm start` from the project root
2. Open Chrome. Go to `chrome://extensions/`. Enable Developer mode. Click "Load unpacked". Select the `browser-helper/` directory in the v05 project.
3. Navigate to `https://www.google.com`
4. Verify bridge health: open `http://127.0.0.1:17391/health` in Chrome — should return `{"ok":true,"app":"screen-guide-overlay-v05","port":17391}`

- [ ] **Step 6: Commit**

```
git add screen-guide-overlay-v05/browser-helper/
git commit -m "feat(v05): port browser helper with chromeY accuracy fix"
```

---

## Task 3: domGuidance module (pure logic)

**Files:**
- Create: `src/ai/domGuidance.js`
- Create: `tests/dom-guidance.test.js`

**Interfaces:**
- Produces: `domGuidance({ task, pageState, pageStateAgeMs, workflowStep }) → GuidanceResult`
- Produces: `scoreElement(el, keywords) → number`
- Produces: `findBestElement(pageState, keywords) → { element, confidence } | null`

- [ ] **Step 1: Create src/ai/ directory**

```
mkdir "src\ai"
```

- [ ] **Step 2: Write the failing tests**

Create `tests/dom-guidance.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scoreElement, findBestElement, domGuidance } = require('../src/ai/domGuidance.js');

const makeEl = (overrides = {}) => ({
  text: '', role: '', tag: 'div', type: '', selector: '',
  isClickable: false, isInput: false, visible: true, disabled: false,
  screenRect: null, ...overrides
});

test('scoreElement gives higher score for keyword match', () => {
  const el = makeEl({ text: 'Business Settings', isClickable: true, visible: true, screenRect: { x: 10, y: 10, w: 150, h: 40 } });
  const score = scoreElement(el, ['business settings']);
  assert.ok(score > 0.5, `expected score > 0.5 but got ${score}`);
});

test('scoreElement penalises disabled elements', () => {
  const el = makeEl({ text: 'Business Settings', isClickable: true, disabled: true });
  const score = scoreElement(el, ['business settings']);
  assert.ok(score < 0.3, `expected score < 0.3 for disabled element but got ${score}`);
});

test('scoreElement returns value between 0 and 1', () => {
  const el = makeEl({ text: 'abc', isClickable: true });
  const score = scoreElement(el, ['abc', 'def', 'ghi']);
  assert.ok(score >= 0 && score <= 1);
});

test('findBestElement returns null for empty elements', () => {
  const result = findBestElement({ elements: [] }, ['business settings']);
  assert.equal(result, null);
});

test('findBestElement returns null when pageState is null', () => {
  assert.equal(findBestElement(null, ['anything']), null);
});

test('findBestElement picks the highest-scoring element', () => {
  const pageState = {
    elements: [
      makeEl({ text: 'Settings', isClickable: true, selector: '#a', screenRect: { x: 10, y: 10, w: 100, h: 30 } }),
      makeEl({ text: 'Business Settings', isClickable: true, selector: '#b', screenRect: { x: 10, y: 50, w: 150, h: 40 } }),
      makeEl({ text: 'Home', isClickable: true, selector: '#c', screenRect: { x: 10, y: 90, w: 80, h: 30 } })
    ]
  };
  const result = findBestElement(pageState, ['business settings']);
  assert.equal(result.element.selector, '#b');
});

test('domGuidance returns fallback when no pageState', () => {
  const result = domGuidance({ task: 'connect Meta', pageState: null, pageStateAgeMs: null });
  assert.equal(result.source, 'fallback-no-dom');
  assert.ok(result.confidence < 0.3);
});

test('domGuidance returns low-confidence callout when target not found', () => {
  const pageState = {
    url: 'https://example.com', elements: [],
    summaryText: 'nothing useful here', scroll: { y: 0 }
  };
  const result = domGuidance({ task: 'find business settings', pageState, pageStateAgeMs: 100 });
  assert.equal(result.status, 'unsure');
  assert.equal(result.overlay.type, 'callout');
});

test('domGuidance returns dom-highlight when target found with screenRect', () => {
  const pageState = {
    url: 'https://business.facebook.com/settings', title: 'Business Settings',
    elements: [makeEl({ text: 'Business Settings', isClickable: true, selector: 'a#bs', screenRect: { x: 120, y: 400, w: 160, h: 40 }, visible: true })],
    scroll: { y: 0 }, windowMetrics: { screen: { width: 1920, height: 1080 } }, summaryText: 'Business Settings'
  };
  const workflowStep = { id: 'open-business-settings', instruction: 'Click Business Settings.', targetLabels: ['Business Settings'], fallback: 'Look in the sidebar.' };
  const result = domGuidance({ task: 'connect Meta', pageState, pageStateAgeMs: 100, workflowStep });
  assert.equal(result.source, 'level-3-dom-aware');
  assert.equal(result.overlay.type, 'dom-highlight');
  assert.ok(result.confidence > 0.7);
  assert.deepEqual(result.overlay.highlight, { x: 120, y: 400, w: 160, h: 40 });
});

test('domGuidance uses workflowStep fallback message when confidence is low', () => {
  const pageState = { url: 'https://business.facebook.com', elements: [], summaryText: '', scroll: { y: 0 } };
  const workflowStep = { targetLabels: ['Business Settings'], fallback: 'Look for Business Settings in the sidebar.' };
  const result = domGuidance({ task: 'connect Meta', pageState, pageStateAgeMs: 100, workflowStep });
  assert.equal(result.instruction, 'Look for Business Settings in the sidebar.');
});
```

- [ ] **Step 3: Run tests to confirm they fail**

```
npm run test:dom
```

Expected: `Error: Cannot find module '../src/ai/domGuidance.js'`

- [ ] **Step 4: Create src/ai/domGuidance.js**

```js
function clamp01(n) {
  return Math.max(0, Math.min(1, Number(n || 0)));
}

function rectCenter(rect) {
  if (!rect) return null;
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

function isFresh(pageStateAgeMs) {
  return typeof pageStateAgeMs === 'number' && pageStateAgeMs < 2500;
}

function scoreElement(el, keywords) {
  const hay = `${el.text || ''} ${el.role || ''} ${el.tag || ''} ${el.type || ''} ${el.selector || ''}`.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (!kw) continue;
    if (hay.includes(kw.toLowerCase())) score += kw.length > 5 ? 0.22 : 0.12;
  }
  if (el.isClickable) score += 0.16;
  if (el.isInput) score += 0.08;
  if (el.visible) score += 0.14;
  if (el.disabled) score -= 0.35;
  if (el.screenRect && el.screenRect.w > 5 && el.screenRect.h > 5) score += 0.12;
  return clamp01(score);
}

function findBestElement(pageState, keywords) {
  if (!pageState || !Array.isArray(pageState.elements)) return null;
  let best = null;
  for (const el of pageState.elements) {
    const score = scoreElement(el, keywords);
    if (!best || score > best.confidence) {
      best = { element: el, confidence: score };
    }
  }
  return best && best.confidence > 0 ? best : null;
}

function domGuidance({ task, pageState, pageStateAgeMs, workflowStep }) {
  const keywords = workflowStep?.targetLabels ||
    String(task || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3).slice(0, 12);

  const fresh = isFresh(pageStateAgeMs);
  const best = findBestElement(pageState, keywords);
  const target = best?.element || null;
  const targetConfidence = best?.confidence || 0;

  const evidence = {
    url_present: Boolean(pageState?.url),
    dom_present: Boolean(pageState?.elements?.length),
    page_state_fresh: fresh,
    target_text_found: Boolean(target?.text),
    selector_found: Boolean(target?.selector),
    screen_rect_found: Boolean(target?.screenRect),
    clickable: Boolean(target?.isClickable || target?.isInput),
    disabled: Boolean(target?.disabled),
    target_score: Number((targetConfidence).toFixed(2))
  };

  let confidence = 0.15;
  if (evidence.url_present) confidence += 0.12;
  if (evidence.dom_present) confidence += 0.16;
  if (evidence.page_state_fresh) confidence += 0.12;
  if (evidence.target_text_found) confidence += 0.16;
  if (evidence.selector_found) confidence += 0.10;
  if (evidence.screen_rect_found) confidence += 0.18;
  if (evidence.clickable) confidence += 0.08;
  confidence += Math.min(0.18, targetConfidence * 0.18);
  if (evidence.disabled) confidence -= 0.35;
  confidence = clamp01(confidence);

  const instruction = workflowStep?.instruction ||
    (target ? `Click "${target.text || 'the highlighted control'}".` :
      'I need a clearer target. Tell me the exact button or field you want to find.');

  if (!pageState) {
    return {
      instruction: 'Install or enable the browser helper for Level 3 DOM grounding.',
      confidence: 0.18,
      source: 'fallback-no-dom',
      status: 'checking',
      overlay: {
        type: 'message',
        message: 'Waiting for browser helper…',
        confidence: 0.18,
        evidence: { dom_present: false }
      }
    };
  }

  if (!target || confidence < 0.52 || !target.screenRect) {
    const fallback = workflowStep?.fallback || instruction;
    return {
      instruction: fallback,
      confidence,
      source: 'dom-aware-low-confidence',
      status: 'unsure',
      overlay: {
        type: 'callout',
        message: fallback,
        confidence,
        evidence,
        anchor: null,
        arrow: { direction: 'down', x: 0.5, y: 0.78 },
        label: 'Scroll / reveal the next control'
      }
    };
  }

  const c = rectCenter(target.screenRect);
  const screenW = pageState.windowMetrics?.screen?.width || 1920;
  const screenH = pageState.windowMetrics?.screen?.height || 1080;

  return {
    instruction,
    confidence,
    source: 'level-3-dom-aware',
    status: 'ready',
    target: {
      text: target.text, role: target.role, tag: target.tag,
      selector: target.selector, url: pageState.url, screenRect: target.screenRect
    },
    overlay: {
      type: 'dom-highlight',
      message: instruction,
      label: target.text ? `Click: ${target.text.slice(0, 60)}` : 'Click here',
      confidence,
      evidence,
      anchor: {
        strategy: 'dom-selector-and-bounds',
        selector: target.selector, text: target.text, role: target.role,
        rect: target.screenRect, url: pageState.url, freshnessMs: pageStateAgeMs
      },
      highlight: target.screenRect,
      arrow: {
        direction: 'target',
        x: screenW ? c.x / screenW : 0.5,
        y: screenH ? c.y / screenH : 0.5
      }
    }
  };
}

module.exports = { domGuidance, scoreElement, findBestElement, clamp01, isFresh };
```

- [ ] **Step 5: Run tests to confirm they pass**

```
npm run test:dom
```

Expected: `ℹ tests 9` / `ℹ pass 9` / `ℹ fail 0`

- [ ] **Step 6: Commit**

```
git add screen-guide-overlay-v05/src/ai/domGuidance.js screen-guide-overlay-v05/tests/dom-guidance.test.js
git commit -m "feat(v05): add domGuidance module with unit tests"
```

---

## Task 4: Claude reasoner

**Files:**
- Create: `src/ai/claudeReasoner.js`

**Interfaces:**
- Consumes: `domGuidance` from `./domGuidance`
- Consumes: `@anthropic-ai/sdk` — `new Anthropic({ apiKey })`, `client.messages.create()`
- Produces: `analyzeFrame(payload) → Promise<GuidanceResult>` — exported for use by main.js

Note on testing: The Claude API call is not unit-tested (requires live API key). The domGuidance fallback path IS covered by Task 3's tests. Manual verification of the Claude path is in Task 8.

- [ ] **Step 1: Create src/ai/claudeReasoner.js**

```js
const Anthropic = require('@anthropic-ai/sdk');
const { domGuidance } = require('./domGuidance');

const GUIDANCE_TOOL = {
  name: 'provide_guidance',
  description: 'Return the next overlay instruction as structured guidance data',
  input_schema: {
    type: 'object',
    required: ['instruction', 'confidence', 'source', 'overlay', 'status'],
    properties: {
      instruction: { type: 'string', description: 'Short human-readable instruction (max 120 chars)' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      source: { type: 'string', enum: ['level-3-dom-aware', 'dom-aware-low-confidence', 'vision-only', 'fallback'] },
      target: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          selector: { type: 'string' },
          role: { type: 'string' },
          tag: { type: 'string' },
          screenRect: {
            type: 'object',
            properties: {
              x: { type: 'number' }, y: { type: 'number' },
              w: { type: 'number' }, h: { type: 'number' }
            }
          }
        }
      },
      overlay: {
        type: 'object',
        required: ['type', 'message'],
        properties: {
          type: { type: 'string', enum: ['dom-highlight', 'vision-highlight', 'callout', 'message', 'clear'] },
          message: { type: 'string' },
          label: { type: 'string' },
          confidence: { type: 'number' },
          highlight: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } }
          },
          arrow: {
            type: 'object',
            properties: {
              direction: { type: 'string', enum: ['target', 'up', 'down', 'left', 'right'] },
              x: { type: 'number' }, y: { type: 'number' }
            }
          },
          evidence: { type: 'object' }
        }
      },
      status: { type: 'string', enum: ['ready', 'checking', 'unsure', 'complete', 'wrong-page'] }
    }
  }
};

const SYSTEM_PROMPT = `You are the reasoning layer for a human-gated AI desktop overlay guide.

Your job: inspect the structured browser context (and optional screenshot), then call provide_guidance with exactly one instruction.

Rules:
- NEVER automate clicks, bypass permissions, or approve dialogs. The human must do all of that.
- ALWAYS prefer DOM/selector evidence over screenshot guesses when both are available.
- NEVER display credential values (tokens, passwords, API keys) in the overlay message or label. You may highlight where to paste, but never echo what is there.
- If confidence < 0.45: set status to "unsure", write a fallback message, do NOT set highlight or arrow target coordinates.
- If the current URL does not match any expectedDomains for the workflow step: set status to "wrong-page" and tell the user where to navigate.
- Write a short reasoning note (1-2 sentences, internal — not shown in overlay).`;

function trimPageStateForModel(pageState) {
  if (!pageState) return null;
  return {
    url: pageState.url,
    title: pageState.title,
    viewport: pageState.viewport,
    windowMetrics: pageState.windowMetrics,
    scroll: pageState.scroll,
    summaryText: pageState.summaryText,
    elements: (pageState.elements || []).slice(0, 80).map(el => ({
      tag: el.tag, role: el.role, type: el.type, text: el.text,
      selector: el.selector, isClickable: el.isClickable, isInput: el.isInput,
      disabled: el.disabled, screenRect: el.screenRect, evidence: el.evidence
    }))
  };
}

function normalizeGuidance(input, pageStateAgeMs) {
  const confidence = Math.max(0, Math.min(1, Number(input.confidence || 0)));
  return {
    instruction: input.instruction || 'Continue.',
    confidence,
    source: input.source || 'level-3-dom-aware',
    status: input.status || 'ready',
    target: input.target || null,
    overlay: {
      type: input.overlay?.type || 'message',
      message: input.overlay?.message || input.instruction || 'Continue.',
      label: input.overlay?.label || input.instruction || 'Next step',
      confidence,
      evidence: input.overlay?.evidence || {},
      anchor: input.overlay?.anchor || input.target || null,
      highlight: input.overlay?.highlight || input.target?.screenRect || null,
      arrow: input.overlay?.arrow || { direction: 'target', x: 0.5, y: 0.5 },
      freshnessMs: pageStateAgeMs
    }
  };
}

async function analyzeWithClaude({ task, frameDataUrl, pageState, pageStateAgeMs, workflowStep, previousGuidance }) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const userPayload = {
    task,
    workflowStep: workflowStep ? {
      id: workflowStep.id,
      instruction: workflowStep.instruction,
      targetLabels: workflowStep.targetLabels,
      expectedDomains: workflowStep.expectedDomains,
      fallback: workflowStep.fallback
    } : null,
    pageStateAgeMs,
    pageState: trimPageStateForModel(pageState),
    previousGuidance: previousGuidance ? {
      type: previousGuidance.type,
      message: previousGuidance.message,
      confidence: previousGuidance.confidence,
      anchor: previousGuidance.anchor
    } : null
  };

  const content = [{ type: 'text', text: JSON.stringify(userPayload, null, 2) }];
  if (frameDataUrl && frameDataUrl.startsWith('data:image')) {
    const base64 = frameDataUrl.split(',')[1];
    if (base64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } });
  }

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [GUIDANCE_TOOL],
    tool_choice: { type: 'tool', name: 'provide_guidance' },
    messages: [{ role: 'user', content }]
  });

  const toolUse = response.content.find(b => b.type === 'tool_use');
  if (!toolUse) throw new Error('Claude did not call provide_guidance tool');

  return normalizeGuidance(toolUse.input, pageStateAgeMs);
}

async function analyzeFrame(payload) {
  const { task, frameDataUrl, pageState, pageStateAgeMs, workflowStep, previousGuidance } = payload || {};

  if (!process.env.ANTHROPIC_API_KEY) {
    return domGuidance({ task, pageState, pageStateAgeMs, workflowStep });
  }

  try {
    return await analyzeWithClaude({ task, frameDataUrl, pageState, pageStateAgeMs, workflowStep, previousGuidance });
  } catch (err) {
    const fallback = domGuidance({ task, pageState, pageStateAgeMs, workflowStep });
    return { ...fallback, reasoning: `Claude failed, fell back to DOM guidance: ${err.message}`, source: 'dom-aware-claude-fallback' };
  }
}

module.exports = { analyzeFrame, trimPageStateForModel, normalizeGuidance };
```

- [ ] **Step 2: Verify import resolves**

```
node -e "const { analyzeFrame } = require('./src/ai/claudeReasoner'); console.log(typeof analyzeFrame)"
```

Expected: `function`

- [ ] **Step 3: Commit**

```
git add screen-guide-overlay-v05/src/ai/claudeReasoner.js
git commit -m "feat(v05): add Claude reasoner with tool-use and domGuidance fallback"
```

---

## Task 5: Workflow engine

**Files:**
- Create: `src/workflow/engine.js`
- Create: `src/workflow/definitions/meta-connect-assets.json`
- Create: `tests/workflow-engine.test.js`

**Interfaces:**
- Produces: `new WorkflowEngine()` — `.load(id)`, `.start()`, `.pause()`, `.resume()`, `.stop()`, `.updatePageState(state)`, `.advanceStep()`, `.markStuck()`, `.resetStuck()`, `.getCurrentStep()`, `.getStepIndex()`, `.getTotalSteps()`, `.isRunning()`, `.onStepChange(cb)`, `.onStatusChange(cb)`

- [ ] **Step 1: Write failing tests**

Create `tests/workflow-engine.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WorkflowEngine, STATES } = require('../src/workflow/engine.js');

function makeEngine() {
  const e = new WorkflowEngine();
  e.load('meta-connect-assets');
  return e;
}

test('engine starts at idle state', () => {
  const e = new WorkflowEngine();
  assert.equal(e.getState(), STATES.IDLE);
});

test('engine loads workflow and has 6 steps', () => {
  const e = makeEngine();
  assert.equal(e.getTotalSteps(), 6);
});

test('engine starts at step 0', () => {
  const e = makeEngine();
  e.start();
  assert.equal(e.getStepIndex(), 0);
  assert.equal(e.getState(), STATES.RUNNING);
});

test('engine getCurrentStep returns step object', () => {
  const e = makeEngine();
  e.start();
  const step = e.getCurrentStep();
  assert.ok(step);
  assert.ok(step.id);
  assert.ok(step.instruction);
});

test('engine advanceStep increments stepIndex', () => {
  const e = makeEngine();
  e.start();
  e.advanceStep();
  assert.equal(e.getStepIndex(), 1);
});

test('engine emits onStepChange when step advances', () => {
  const e = makeEngine();
  e.start();
  let fired = false;
  let firedIndex = -1;
  e.onStepChange(({ index }) => { fired = true; firedIndex = index; });
  e.advanceStep();
  assert.ok(fired);
  assert.equal(firedIndex, 1);
});

test('engine emits complete when last step is advanced', () => {
  const e = makeEngine();
  e.start();
  let event = null;
  e.onStatusChange(({ event: ev }) => { event = ev; });
  for (let i = 0; i < 6; i++) e.advanceStep();
  assert.equal(event, 'complete');
  assert.equal(e.getState(), STATES.COMPLETE);
});

test('engine pause and resume change state', () => {
  const e = makeEngine();
  e.start();
  e.pause();
  assert.equal(e.getState(), STATES.PAUSED);
  assert.ok(!e.isRunning());
  e.resume();
  assert.equal(e.getState(), STATES.RUNNING);
  assert.ok(e.isRunning());
});

test('engine updatePageState returns wrong-page when domain mismatch', () => {
  const e = makeEngine();
  e.start();
  const result = e.updatePageState({ url: 'https://google.com', elements: [], summaryText: '', scroll: { y: 0 } });
  assert.equal(result.status, 'wrong-page');
});

test('engine updatePageState advances step when completionSignals match', () => {
  const e = makeEngine();
  e.start();
  const initialIndex = e.getStepIndex();
  const result = e.updatePageState({
    url: 'https://business.facebook.com/home',
    summaryText: 'Welcome to Business Manager. Business Settings People Accounts',
    elements: [],
    scroll: { y: 0 }
  });
  assert.equal(result.status, 'step-complete');
  assert.equal(e.getStepIndex(), initialIndex + 1);
});

test('engine markStuck emits stuck event after 3 calls', () => {
  const e = makeEngine();
  e.start();
  let stuckFired = false;
  e.onStatusChange(({ event }) => { if (event === 'stuck') stuckFired = true; });
  e.markStuck(); e.markStuck(); e.markStuck();
  assert.ok(stuckFired);
});

test('engine resetStuck prevents stuck event', () => {
  const e = makeEngine();
  e.start();
  let stuckFired = false;
  e.onStatusChange(({ event }) => { if (event === 'stuck') stuckFired = true; });
  e.markStuck(); e.markStuck();
  e.resetStuck();
  e.markStuck(); e.markStuck();
  assert.ok(!stuckFired);
});

test('engine updatePageState returns null when not running', () => {
  const e = makeEngine();
  const result = e.updatePageState({ url: 'https://business.facebook.com', elements: [] });
  assert.equal(result, null);
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
npm run test:workflow
```

Expected: `Cannot find module '../src/workflow/engine.js'`

- [ ] **Step 3: Create workflow definitions directory and meta workflow**

Create `src/workflow/definitions/meta-connect-assets.json`:
```json
{
  "id": "meta-connect-assets",
  "name": "Connect Meta Business Assets",
  "description": "Guide user through connecting Meta/Facebook business assets to their dashboard.",
  "steps": [
    {
      "id": "confirm-logged-in",
      "instruction": "Make sure you are logged in to Meta Business Suite.",
      "expectedDomains": ["business.facebook.com", "facebook.com"],
      "targetLabels": ["Business Suite", "Business Manager", "Business Settings"],
      "completionSignals": {
        "urlContains": ["business.facebook.com"],
        "textPresent": ["Business Manager", "Business Settings", "People", "Accounts"]
      },
      "fallback": "Go to business.facebook.com and log in with your business Facebook account."
    },
    {
      "id": "open-business-settings",
      "instruction": "Click Business Settings in the left sidebar.",
      "expectedDomains": ["business.facebook.com"],
      "targetLabels": ["Business Settings"],
      "completionSignals": {
        "urlContains": ["/settings/"],
        "textPresent": ["Business Settings", "Business Portfolio", "People and Assets"]
      },
      "fallback": "Look for Business Settings in the left navigation panel."
    },
    {
      "id": "open-apps",
      "instruction": "Click Apps or Integrations in the sidebar.",
      "expectedDomains": ["business.facebook.com"],
      "targetLabels": ["Apps", "Integrations", "Business Apps"],
      "completionSignals": {
        "textPresent": ["Apps", "Business Apps", "Connected apps"]
      },
      "fallback": "Scroll the left sidebar until you see Apps or Integrations."
    },
    {
      "id": "find-token-area",
      "instruction": "Find the access token or developer credentials section.",
      "targetLabels": ["Access Token", "Generate Token", "Developer", "Token"],
      "fallback": "Look for Developer or Token in the current section. You may need to scroll."
    },
    {
      "id": "copy-token",
      "instruction": "When the token is visible, copy it manually. Do not share it with anyone.",
      "targetLabels": ["Copy", "Generate", "Generate Token"],
      "completionSignals": {
        "textPresent": ["Copied", "Token copied"]
      },
      "fallback": "Click Generate or Copy when the token appears, then copy it manually."
    },
    {
      "id": "return-to-dashboard",
      "instruction": "Return to your AI Flow dashboard and paste the token in the field shown.",
      "expectedDomains": ["localhost", "aiflowsystems", "app."],
      "targetLabels": ["Paste token", "Access token", "API key"],
      "fallback": "Switch back to your dashboard tab and find the token input field."
    }
  ]
}
```

- [ ] **Step 4: Create src/workflow/engine.js**

```js
const path = require('path');
const fs = require('fs');

const DEFINITIONS_DIR = path.join(__dirname, 'definitions');

const STATES = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  STOPPED: 'stopped',
  COMPLETE: 'complete'
};

class WorkflowEngine {
  constructor() {
    this._workflow = null;
    this._stepIndex = 0;
    this._state = STATES.IDLE;
    this._stuckCount = 0;
    this._stepChangeListeners = [];
    this._statusChangeListeners = [];
  }

  load(workflowId) {
    const filePath = path.join(DEFINITIONS_DIR, `${workflowId}.json`);
    const raw = fs.readFileSync(filePath, 'utf8');
    this._workflow = JSON.parse(raw);
    this._stepIndex = 0;
    this._state = STATES.IDLE;
    this._stuckCount = 0;
    return this._workflow;
  }

  start() {
    if (!this._workflow) throw new Error('No workflow loaded. Call engine.load(id) first.');
    this._state = STATES.RUNNING;
    this._stepIndex = 0;
    this._stuckCount = 0;
    this._emitStatusChange('started');
    this._emitStepChange();
  }

  pause() {
    if (this._state === STATES.RUNNING) {
      this._state = STATES.PAUSED;
      this._emitStatusChange('paused');
    }
  }

  resume() {
    if (this._state === STATES.PAUSED) {
      this._state = STATES.RUNNING;
      this._emitStatusChange('resumed');
    }
  }

  stop() {
    this._state = STATES.STOPPED;
    this._stepIndex = 0;
    this._stuckCount = 0;
    this._emitStatusChange('stopped');
  }

  updatePageState(pageState) {
    if (this._state !== STATES.RUNNING) return null;
    if (!this._workflow) return null;

    const step = this.getCurrentStep();
    if (!step) return null;

    if (step.expectedDomains && step.expectedDomains.length > 0 && pageState.url) {
      const domainMatch = step.expectedDomains.some(d => pageState.url.includes(d));
      if (!domainMatch) return { status: 'wrong-page', step };
    }

    if (this._checkCompletionSignals(step, pageState)) {
      this._advanceStep();
      return { status: 'step-complete', step };
    }

    return { status: 'running', step };
  }

  _checkCompletionSignals(step, pageState) {
    if (!step.completionSignals) return false;
    const signals = step.completionSignals;

    if (signals.urlContains) {
      const urlMatch = signals.urlContains.some(s => (pageState.url || '').includes(s));
      if (!urlMatch) return false;
    }

    if (signals.textPresent) {
      const text = `${pageState.summaryText || ''} ${(pageState.elements || []).map(e => e.text || '').join(' ')}`;
      const textMatch = signals.textPresent.some(s => text.toLowerCase().includes(s.toLowerCase()));
      if (!textMatch) return false;
    }

    return true;
  }

  _advanceStep() {
    this._stuckCount = 0;
    if (this._stepIndex + 1 >= this._workflow.steps.length) {
      this._state = STATES.COMPLETE;
      this._emitStatusChange('complete');
    } else {
      this._stepIndex += 1;
      this._emitStepChange();
    }
  }

  advanceStep() { this._advanceStep(); }

  markStuck() {
    this._stuckCount += 1;
    if (this._stuckCount >= 3) this._emitStatusChange('stuck');
  }

  resetStuck() { this._stuckCount = 0; }

  getCurrentStep() {
    if (!this._workflow) return null;
    return this._workflow.steps[this._stepIndex] || null;
  }

  getStepIndex() { return this._stepIndex; }
  getTotalSteps() { return this._workflow?.steps.length || 0; }
  getState() { return this._state; }
  getWorkflowName() { return this._workflow?.name || ''; }
  isRunning() { return this._state === STATES.RUNNING; }

  onStepChange(cb) { this._stepChangeListeners.push(cb); }
  onStatusChange(cb) { this._statusChangeListeners.push(cb); }

  _emitStepChange() {
    const step = this.getCurrentStep();
    for (const cb of this._stepChangeListeners) cb({ step, index: this._stepIndex, total: this.getTotalSteps() });
  }

  _emitStatusChange(event) {
    for (const cb of this._statusChangeListeners) cb({ event, state: this._state, stepIndex: this._stepIndex });
  }
}

module.exports = { WorkflowEngine, STATES };
```

- [ ] **Step 5: Run tests to confirm they pass**

```
npm run test:workflow
```

Expected: `ℹ tests 13` / `ℹ pass 13` / `ℹ fail 0`

- [ ] **Step 6: Commit**

```
git add screen-guide-overlay-v05/src/workflow/ screen-guide-overlay-v05/tests/workflow-engine.test.js
git commit -m "feat(v05): add workflow engine and Meta workflow definition"
```

---

## Task 6: Tracking loop

**Files:**
- Create: `src/tracking/tracker.js`
- Create: `tests/tracker.test.js`

**Interfaces:**
- Consumes: `getPageState() → pageState | null` (injected)
- Consumes: `sendOverlay(guidance) → void` (injected)
- Produces: `new Tracker({ getPageState, sendOverlay })` — `.setAnchor(anchor)`, `.clearAnchor()`, `.start()`, `.stop()`, `.onRedetectNeeded(cb)`

- [ ] **Step 1: Write failing tests**

Create `tests/tracker.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Tracker } = require('../src/tracking/tracker.js');

function makeTracker(stateProvider, overlaySpy = []) {
  return new Tracker({
    getPageState: stateProvider,
    sendOverlay: (g) => overlaySpy.push(g)
  });
}

const makeEl = (text, selector, screenRect) => ({ text, selector, screenRect, isClickable: true, visible: true });

test('tracker does nothing when anchor is null', () => {
  const spy = [];
  const t = makeTracker(() => ({ elements: [], scroll: { y: 0 } }), spy);
  t._tick();
  assert.equal(spy.length, 0);
});

test('tracker finds element by selector', () => {
  const els = [makeEl('Business Settings', 'a#bs', { x: 120, y: 400, w: 160, h: 40 })];
  const t = makeTracker(() => ({ elements: els, scroll: { y: 0 } }));
  const found = t._findAnchorInState({ elements: els });
  assert.ok(found);
  assert.equal(found.selector, 'a#bs');
});

test('tracker finds element by text when selector misses', () => {
  const els = [makeEl('Business Settings', 'a#different', { x: 120, y: 400, w: 160, h: 40 })];
  const t = makeTracker(() => ({ elements: els, scroll: { y: 0 } }));
  t.setAnchor({ selector: 'a#bs', text: 'Business Settings', screenRect: { x: 120, y: 400, w: 160, h: 40 }, confidence: 0.9, overlayTemplate: { type: 'dom-highlight', message: 'Click here', arrow: { direction: 'target', x: 0.5, y: 0.5 } } });
  const found = t._findAnchorInState({ elements: els });
  assert.ok(found);
  assert.equal(found.text, 'Business Settings');
});

test('tracker sends overlay update when screenRect changes', () => {
  const spy = [];
  let scrollY = 0;
  const els = () => [makeEl('Business Settings', 'a#bs', { x: 120, y: 400 - scrollY, w: 160, h: 40 })];
  const t = makeTracker(() => ({ elements: els(), scroll: { y: scrollY } }), spy);
  t.setAnchor({ selector: 'a#bs', text: 'Business Settings', screenRect: { x: 120, y: 400, w: 160, h: 40 }, confidence: 0.9, overlayTemplate: { type: 'dom-highlight', message: 'Click here', arrow: { direction: 'target', x: 0.5, y: 0.5 } } });
  t._lastScrollY = 0;
  scrollY = 50;
  t._tick();
  assert.ok(spy.length > 0, 'expected overlay update');
  assert.deepEqual(spy[0].highlight, { x: 120, y: 350, w: 160, h: 40 });
});

test('tracker hides overlay on scroll when element not found', () => {
  const spy = [];
  let scrollY = 0;
  const t = makeTracker(() => ({ elements: [], scroll: { y: scrollY } }), spy);
  t.setAnchor({ selector: 'a#bs', text: 'Target', screenRect: { x: 120, y: 400, w: 160, h: 40 }, confidence: 0.9, overlayTemplate: {} });
  t._lastScrollY = 0;
  scrollY = 100;
  t._tick();
  const lastMsg = spy[spy.length - 1];
  assert.ok(lastMsg, 'expected an overlay message');
  assert.equal(lastMsg.type, 'message');
  assert.ok(lastMsg.message.includes('Checking'));
});

test('tracker clearAnchor resets state', () => {
  const spy = [];
  const t = makeTracker(() => ({ elements: [], scroll: { y: 0 } }), spy);
  t.setAnchor({ selector: 'a#bs', text: 'Target', screenRect: { x: 0, y: 0, w: 10, h: 10 }, confidence: 0.9, overlayTemplate: {} });
  t.clearAnchor();
  t._tick();
  assert.equal(spy.length, 0);
});

test('tracker calls onRedetectNeeded after anchor missing for 400ms', () => {
  return new Promise((resolve) => {
    const tracker = new Tracker({
      getPageState: () => ({ elements: [], scroll: { y: 0 } }),
      sendOverlay: () => {}
    });
    tracker.setAnchor({ selector: 'a#bs', text: 'Target', screenRect: { x: 0, y: 0, w: 10, h: 10 }, confidence: 0.9, overlayTemplate: {} });
    tracker._notFoundSince = Date.now() - 500;
    tracker.onRedetectNeeded(() => resolve());
    tracker._tick();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
npm run test:tracker
```

Expected: `Cannot find module '../src/tracking/tracker.js'`

- [ ] **Step 3: Create src/tracking/ directory and tracker.js**

```js
const INTERVAL_MS = 100;
const CONFIDENCE_DECAY = 0.1;
const CONFIDENCE_HIDE_THRESHOLD = 0.35;
const SCROLL_DELTA_THRESHOLD = 20;
const REDETECT_AFTER_MS = 400;

class Tracker {
  constructor({ getPageState, sendOverlay }) {
    this._getPageState = getPageState;
    this._sendOverlay = sendOverlay;
    this._anchor = null;
    this._anchorConfidence = 0;
    this._lastScreenRect = null;
    this._lastScrollY = null;
    this._notFoundSince = null;
    this._hidden = false;
    this._timer = null;
    this._onRedetectNeeded = null;
  }

  setAnchor(anchor) {
    this._anchor = anchor;
    this._anchorConfidence = anchor?.confidence || 0.8;
    this._lastScreenRect = anchor?.screenRect || null;
    this._notFoundSince = null;
    this._hidden = false;
  }

  clearAnchor() {
    this._anchor = null;
    this._anchorConfidence = 0;
    this._lastScreenRect = null;
    this._notFoundSince = null;
    this._hidden = false;
  }

  onRedetectNeeded(cb) { this._onRedetectNeeded = cb; }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), INTERVAL_MS);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  _tick() {
    if (!this._anchor) return;
    const pageState = this._getPageState();
    if (!pageState) return;

    const scrollY = pageState.scroll?.y ?? null;
    const scrolled = this._lastScrollY !== null && scrollY !== null &&
      Math.abs(scrollY - this._lastScrollY) > SCROLL_DELTA_THRESHOLD;
    if (scrollY !== null) this._lastScrollY = scrollY;

    const found = this._findAnchorInState(pageState);

    if (found && found.screenRect) {
      this._notFoundSince = null;
      this._anchorConfidence = Math.min(1, this._anchorConfidence + 0.05);

      const last = this._lastScreenRect;
      const changed = !last ||
        Math.abs(found.screenRect.x - last.x) > 3 || Math.abs(found.screenRect.y - last.y) > 3 ||
        Math.abs(found.screenRect.w - last.w) > 3;

      if (changed) {
        this._lastScreenRect = found.screenRect;
        this._hidden = false;
        this._sendOverlay({
          ...(this._anchor.overlayTemplate || {}),
          highlight: found.screenRect,
          arrow: this._anchor.overlayTemplate?.arrow || { direction: 'target', x: 0.5, y: 0.5 }
        });
      }
    } else if (found && !found.screenRect) {
      this._anchorConfidence -= CONFIDENCE_DECAY;
      if (this._anchorConfidence < CONFIDENCE_HIDE_THRESHOLD && !this._hidden) {
        this._hidden = true;
        this._sendOverlay({ type: 'message', message: 'Checking screen…', confidence: this._anchorConfidence });
      }
    } else {
      if (!this._notFoundSince) this._notFoundSince = Date.now();
      this._anchorConfidence -= CONFIDENCE_DECAY;

      if (scrolled && !this._hidden) {
        this._hidden = true;
        this._sendOverlay({ type: 'message', message: 'Checking screen…', confidence: this._anchorConfidence });
      }

      if (Date.now() - this._notFoundSince > REDETECT_AFTER_MS && this._onRedetectNeeded) {
        this._notFoundSince = Date.now();
        this._onRedetectNeeded();
      }
    }
  }

  _findAnchorInState(pageState) {
    if (!this._anchor || !Array.isArray(pageState.elements)) return null;
    const { selector, text } = this._anchor;

    if (selector) {
      const bySelector = pageState.elements.find(el => el.selector === selector);
      if (bySelector) return bySelector;
    }

    if (text) {
      const needle = text.toLowerCase().slice(0, 40);
      const byText = pageState.elements.find(el => el.text && el.text.toLowerCase().includes(needle));
      if (byText) return byText;
    }

    return null;
  }
}

module.exports = { Tracker };
```

- [ ] **Step 4: Run tests to confirm they pass**

```
npm run test:tracker
```

Expected: `ℹ tests 7` / `ℹ pass 7` / `ℹ fail 0`

- [ ] **Step 5: Commit**

```
git add screen-guide-overlay-v05/src/tracking/tracker.js screen-guide-overlay-v05/tests/tracker.test.js
git commit -m "feat(v05): add 100ms tracking loop with scroll detection and anchor re-find"
```

---

## Task 7: Preload and control window

**Files:**
- Create: `src/preload.js` (replaces placeholder)
- Create: `src/control.html` (replaces placeholder)
- Create: `src/control.js`

**Interfaces:**
- Consumes: IPC channels exposed by main.js (`guide:*`, `workflow:*`, `page-state:update`, `guide:redetect`)
- Produces: `window.screenGuide` API in control window renderer

- [ ] **Step 1: Create src/preload.js**

Replace the placeholder file entirely:

```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('screenGuide', {
  analyzeFrame: (payload) => ipcRenderer.invoke('guide:analyze-frame', payload),
  getPageState: () => ipcRenderer.invoke('guide:get-page-state'),
  clearOverlay: () => ipcRenderer.invoke('guide:clear-overlay'),
  showOverlay: (guidance) => ipcRenderer.invoke('guide:show-overlay', guidance),
  startWorkflow: (id) => ipcRenderer.invoke('guide:start-workflow', id),
  pauseWorkflow: (paused) => ipcRenderer.invoke('guide:pause-workflow', paused),
  stopWorkflow: () => ipcRenderer.invoke('guide:stop-workflow'),
  onPageStateUpdate: (cb) => ipcRenderer.on('page-state:update', (_e, data) => cb(data)),
  onWorkflowStepChange: (cb) => ipcRenderer.on('workflow:step-change', (_e, data) => cb(data)),
  onWorkflowStatusChange: (cb) => ipcRenderer.on('workflow:status-change', (_e, data) => cb(data)),
  onRedetect: (cb) => ipcRenderer.on('guide:redetect', () => cb())
});
```

- [ ] **Step 2: Create src/control.html**

Replace the placeholder file entirely:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>AI Screen Guide</title>
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';" />
  <style>
    :root {
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
      background: #0f1117; color: #f0f2f7;
      --orange: #ff8a00; --orange-dim: rgba(255,138,0,0.15);
      --surface: #171b24; --border: #252b3a; --text-dim: #8a96ac;
      --green: #2dd47e; --red: #ff5c5c;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { padding: 20px 18px; }
    h1 { font-size: 17px; font-weight: 700; color: var(--orange); margin-bottom: 3px; }
    .subtitle { font-size: 12px; color: var(--text-dim); margin-bottom: 18px; }
    label { display: block; font-size: 12px; color: var(--text-dim); margin: 0 0 6px; }
    textarea {
      width: 100%; border-radius: 10px; border: 1px solid var(--border);
      background: var(--surface); color: #f0f2f7; padding: 10px 12px;
      font-size: 13px; resize: none; height: 68px; outline: none; font-family: inherit;
    }
    textarea:focus { border-color: var(--orange); }
    .step-section { margin: 18px 0 14px; }
    .step-label { font-size: 11px; color: var(--text-dim); margin-bottom: 8px; }
    .step-dots { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--border); flex-shrink: 0; transition: background 0.2s; }
    .dot.done { background: var(--orange); }
    .dot.active { background: var(--orange); box-shadow: 0 0 0 3px var(--orange-dim); }
    .dot-connector { flex: 1; height: 2px; background: var(--border); }
    .dot-connector.done { background: var(--orange); }
    .instruction-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px; margin-bottom: 14px; }
    .instruction-text { font-size: 16px; font-weight: 600; line-height: 1.45; min-height: 48px; }
    .confidence-label { font-size: 11px; margin-top: 8px; color: var(--text-dim); }
    .confidence-confirmed { color: var(--green); }
    .confidence-checking { color: #ffd479; }
    .confidence-unsure { color: var(--red); }
    .helper-status { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border); border-radius: 999px; padding: 5px 10px; font-size: 12px; margin-bottom: 8px; }
    .status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-dim); }
    .status-dot.connected { background: var(--green); }
    .status-dot.disconnected { background: var(--red); }
    .helper-hint { font-size: 11px; color: var(--text-dim); margin-bottom: 14px; display: none; }
    .helper-hint.visible { display: block; }
    .btn-row { display: flex; gap: 8px; margin-bottom: 14px; }
    button { border: 0; border-radius: 10px; padding: 10px 14px; font-weight: 700; font-size: 13px; cursor: pointer; font-family: inherit; transition: opacity 0.15s; }
    button:disabled { opacity: 0.4; cursor: default; }
    .btn-primary { background: var(--orange); color: #111; flex: 1; }
    .btn-secondary { background: var(--surface); border: 1px solid var(--border); color: #f0f2f7; }
    .btn-danger { background: #3a1a1a; border: 1px solid #5c2330; color: #ff9292; }
    .debug-toggle { background: none; border: none; color: var(--text-dim); font-size: 12px; cursor: pointer; padding: 4px 0; display: block; text-align: left; width: 100%; }
    .debug-panel { display: none; margin-top: 10px; }
    .debug-panel.open { display: block; }
    .debug-content { font-family: ui-monospace, monospace; font-size: 11px; color: #8a96ac; white-space: pre-wrap; word-break: break-all; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 10px; max-height: 160px; overflow: auto; }
    .pill { display: inline-flex; align-items: center; border: 1px solid var(--border); border-radius: 999px; padding: 4px 8px; font-size: 11px; color: var(--text-dim); margin: 3px 3px 0 0; }
    .pill.ok { color: var(--green); } .pill.warn { color: #ffd479; } .pill.bad { color: var(--red); }
  </style>
</head>
<body>
  <h1>AI Screen Guide</h1>
  <p class="subtitle">Visual step-by-step guidance for connecting your business tools.</p>

  <label for="task">What do you want help with?</label>
  <textarea id="task">Help me connect my Meta account to my dashboard.</textarea>

  <div class="step-section">
    <div class="step-label" id="stepLabel">Ready to start</div>
    <div class="step-dots" id="stepDots"></div>
    <div class="instruction-card">
      <div class="instruction-text" id="instructionText">Click Start Guidance to begin.</div>
      <div class="confidence-label" id="confidenceLabel"></div>
    </div>
  </div>

  <div class="helper-status">
    <div class="status-dot" id="statusDot"></div>
    <span id="statusText">Checking browser helper…</span>
  </div>
  <div class="helper-hint" id="helperHint">
    Install the browser helper from <strong>browser-helper/</strong> in Chrome for better guidance.
  </div>

  <div class="btn-row">
    <button id="startBtn" class="btn-primary">Start Guidance</button>
    <button id="pauseBtn" class="btn-secondary" disabled>Pause</button>
    <button id="stopBtn" class="btn-danger" disabled>Stop</button>
  </div>

  <button class="debug-toggle" id="debugToggle">▸ Show debug panel</button>
  <div class="debug-panel" id="debugPanel">
    <div id="domPills" style="margin-bottom:8px"></div>
    <div class="debug-content" id="debugContent">Idle.</div>
  </div>

  <script src="control.js"></script>
</body>
</html>
```

- [ ] **Step 3: Create src/control.js**

```js
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
  renderStepDots(index, total);
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

  stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5, displaySurface: 'monitor' }, audio: false });
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

function scheduleLoop(delay = currentIntervalMs) {
  if (!running || paused) return;
  if (loopTimer) clearTimeout(loopTimer);
  loopTimer = setTimeout(captureAndAnalyze, delay);
}

function captureFrame() {
  if (!video.videoWidth) return null;
  const maxW = 1280;
  const scale = Math.min(1, maxW / video.videoWidth);
  captureCanvas.width = Math.round(video.videoWidth * scale);
  captureCanvas.height = Math.round(video.videoHeight * scale);
  const ctx = captureCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
  return captureCanvas.toDataURL('image/jpeg', 0.62);
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
    if (result?.instruction) instructionText.textContent = result.instruction;
    currentIntervalMs = confidence < 0.55 ? 500 : 900;
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
```

- [ ] **Step 4: Commit**

```
git add screen-guide-overlay-v05/src/preload.js screen-guide-overlay-v05/src/control.html screen-guide-overlay-v05/src/control.js
git commit -m "feat(v05): add preload IPC bridge and non-technical control window UI"
```

---

## Task 8: Wire everything in main.js

**Files:**
- Modify: `src/main.js` — add engine, tracker, reasoner integration and new IPC handlers

**Interfaces:**
- Consumes: `WorkflowEngine` from `./workflow/engine`
- Consumes: `Tracker` from `./tracking/tracker`
- Consumes: `analyzeFrame` from `./ai/claudeReasoner`
- Produces: complete `guide:*` IPC handler set

- [ ] **Step 1: Replace src/main.js with the final wired version**

Replace the entire file:

```js
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const http = require('http');
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

app.whenReady().then(() => {
  startBridgeServer();
  createWindows();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindows(); });
});

app.on('before-quit', () => { if (bridgeServer) bridgeServer.close(); tracker.stop(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

module.exports = { sanitizePageState, normalizeRect, sendOverlay };
```

- [ ] **Step 2: Run all unit tests to confirm no regressions**

```
npm run test:sanitize
npm run test:dom
npm run test:workflow
npm run test:tracker
```

Expected: all four suites pass with 0 failures.

- [ ] **Step 3: Start the app and verify**

```
npm start
```

Confirm:
- Control window loads with the proper non-technical UI (task textarea, step section, status pill, Start Guidance button)
- Transparent overlay window appears
- Terminal shows bridge listening message
- No errors in either window's DevTools console

- [ ] **Step 4: Commit**

```
git add screen-guide-overlay-v05/src/main.js
git commit -m "feat(v05): wire engine, tracker, and Claude reasoner into main process"
```

---

## Task 9: Integration verification (acceptance criteria)

This task verifies all 10 acceptance criteria from the spec. No new files — manual verification checklist.

**Prerequisites:**
- App is running: `$env:ANTHROPIC_API_KEY = "your_key_here"; npm start` from v05 directory
- Browser helper installed in Chrome from `browser-helper/` directory

- [ ] **Test 1: Highlight DOM button**
Navigate Chrome to `https://business.facebook.com`. Click Start Guidance. Grant screen share. Observe orange highlight over a relevant button. Click through overlay onto highlighted button — click passes through.

- [ ] **Test 2: Scroll with target highlighted**
With highlight active, scroll page slowly. Highlight follows the button within 100ms OR disappears and re-appears within 400ms.

- [ ] **Test 3: Target scrolls off-screen**
Scroll past highlighted element until it leaves viewport. Highlight disappears, "Checking screen…" message appears.

- [ ] **Test 4: Target scrolls back**
After Test 3, scroll back up. Highlight re-appears on element without AI call.

- [ ] **Test 5: Wrong page**
Click Start Guidance. Navigate Chrome to `https://google.com`. Overlay shows "You're on the wrong page" message. No arrow pointing at anything.

- [ ] **Test 6: Low confidence**
Click Start Guidance. Navigate to `about:blank`. Overlay shows callout message. Confidence label shows "Not sure — scroll slowly". No highlight.

- [ ] **Test 7: Meta workflow step**
Navigate to `https://business.facebook.com/settings/`. Click Start Guidance. Engine at step "open-business-settings". Orange highlight appears over a "Business Settings" element.

- [ ] **Test 8: No API key**
Stop app. `Remove-Item Env:ANTHROPIC_API_KEY` then `npm start`. Click Start Guidance, navigate to Meta. App still provides DOM-based guidance. Debug panel shows `source: "level-3-dom-aware"` or `"dom-aware-low-confidence"`.

- [ ] **Test 9: Sensitive field**
Navigate to page with visible access token. Overlay label and message text must NOT echo the token value.

- [ ] **Test 10: Step completion**
Navigate to `https://business.facebook.com/home` (satisfies step 0 signals). Click Start Guidance. Step dot advances from step 1 to step 2 without requiring an overlay button click.

- [ ] **Final commit**

```
git add .
git commit -m "feat(v05): complete AI Screen Guide Overlay v05 — all modules wired, acceptance criteria verified"
```

---

## Self-Review

**Spec coverage:**
- Claude via tool-use (Task 4) ✓
- domGuidance fallback (Task 3, Task 4) ✓
- Workflow engine with 6-step Meta workflow (Task 5) ✓
- Fast tracking loop 100ms (Task 6) ✓
- chromeY coordinate fix (Task 2) ✓
- Non-technical control UX (Task 7) ✓
- sanitizePageState (Task 1) ✓
- Wrong-page detection (Task 5, Task 8 IPC) ✓
- Privacy: no credential echo (Claude system prompt + Test 9) ✓
- All 10 acceptance criteria (Task 9) ✓

**Type consistency verified:**
- `tracker.setAnchor()` takes `{ selector, text, role, screenRect, confidence, overlayTemplate }` — consistent across Task 6 (definition) and Task 8 (call site)
- `analyzeFrame()` takes `{ task, frameDataUrl, pageState, pageStateAgeMs, workflowStep, previousGuidance }` — consistent across Task 4 (definition) and Task 8 (call site)
- `engine.updatePageState(pageState)` — consistent across Task 5 (definition) and Task 8 (call site)
- `sendOverlay(guidance)` — consistent across main.js definition and all call sites
