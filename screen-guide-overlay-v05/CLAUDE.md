# AI Screen Guide Overlay v05 — Project Context

## What This Is

An Electron desktop overlay that **visually guides non-technical users** through connecting Meta Business assets (API keys, tokens, page connections) to the Briolo platform. The AI points at UI elements with an orange highlight; the human does all clicking and typing. Zero automation, zero credential harvesting.

This is a **core Briolo module** — not a demo. It solves the onboarding friction of getting SMB clients to wire up their Meta Business Suite credentials without needing a developer.

## How to Run

Double-click: `Launch AI Screen Guide.bat`

Or from terminal:
```
cd "E:\AI Flow Systems\AI Consult\screen-guide-overlay-v05"
npm start
```

The app auto-kills any stale process holding port 17391 on startup. No manual port cleanup needed.

## Architecture

```
Chrome Extension (browser-helper/)
    POST /page-state  (DOM elements + screen coords)
Bridge Server (src/main.js :17391)
    latestPageState
WorkflowEngine (src/workflow/engine.js)
    current step
Control Window (src/control.html + control.js)
    getDisplayMedia → JPEG frame → Claude API
Claude AI (src/ai/claudeReasoner.js)
    overlay guidance (type, highlight rect, message, confidence)
Overlay Window (src/overlay.html + overlay.js)
    always-on-top transparent canvas, never intercepts mouse
```

## Key Files

| File | Purpose |
|---|---|
| `src/main.js` | Electron main — windows, bridge server, IPC handlers |
| `src/control.js` | Control panel — capture loop, step display, navigate button |
| `src/overlay.js` | Canvas renderer — highlights, arrows, message boxes |
| `src/overlayPreload.js` | Exposes `overlayBridge.onUpdate` to overlay renderer |
| `src/preload.js` | Exposes `screenGuide.*` API to control panel |
| `src/ai/claudeReasoner.js` | Calls claude-sonnet-4-6, returns structured overlay guidance |
| `src/workflow/engine.js` | Step machine — tracks current step, completion signals |
| `src/workflow/definitions/meta-connect-assets.json` | Workflow steps for Meta connection |
| `src/tracking/tracker.js` | DOM anchor tracker — re-uses last known element position |
| `browser-helper/content.js` | Chrome extension — scrapes DOM, posts to bridge |
| `browser-helper/manifest.json` | Load unpacked from this folder in Chrome |

## Coordinate Pipeline — CRITICAL

Elements flow through this pipeline to become orange highlights:

1. `getBoundingClientRect()` → **CSS pixels** relative to viewport
2. `clientRectToScreen()` in `content.js` → adds browser window offset → **CSS pixels**
3. Sent to Electron via bridge → **CSS pixels**
4. `overlay.js` canvas: `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)` → draws in **CSS pixels**, DPR applied internally
5. `drawHighlight(rect)` uses coords directly

**NEVER multiply by `devicePixelRatio` in the pipeline.** The canvas handles DPR once internally. Double-scaling shifts highlights by ~1.5–2× — a bug that was fixed and must not be reintroduced.

## Security Constraints — NON-NEGOTIABLE

- `setIgnoreMouseEvents(true, { forward: true })` set ONCE at overlay creation, **never changed** — changing it freezes the entire PC
- Never display credential values in overlay (tokens, passwords, API keys)
- Never automate clicks — human must click everything
- Never store raw screenshots
- Password inputs excluded from DOM scraping (`sanitizePageState`)
- URLs opened only via `shell.openExternal()`, `https://` and `http://` only

## Current Performance Settings

| Setting | Value |
|---|---|
| Screen capture | 1 fps |
| Frame width | 800px, JPEG q0.40 |
| First analysis trigger | 300ms |
| Confident cadence | 2000ms |
| Unsure cadence | 800ms |
| Overlay repaint interval | 600ms |

## AI Prompt Constraints

- `overlay.message` ≤ 60 chars, plain text, no markdown, no asterisks
- `overlay.label` ≤ 40 chars
- Wrong-page → `type:'message', message:'Wrong page'` + navigate button in control panel only
- `setIgnoreMouseEvents` never called from any AI handler

## Workflow Definition — Needs Work

`src/workflow/definitions/meta-connect-assets.json` — 6 steps, currently too vague.

**The real Meta connection flow Briolo clients need:**
1. Log in to business.facebook.com
2. Business Settings → Users → System Users
3. Create system user (Advertiser role)
4. Assign assets (Pages, Ad Account, Instagram)
5. Generate long-lived access token
6. Copy token → paste into Briolo dashboard

The workflow JSON needs rebuilding against the real 2026 Meta UI with precise selectors and completion signals per screen.

## Browser Extension Setup

1. Chrome → `chrome://extensions` → Enable Developer Mode
2. Load unpacked → select `browser-helper/` folder
3. Keep extension active on the Meta Business Suite tab
4. Control panel shows "Browser helper connected" when working

## Port

Bridge: `http://127.0.0.1:17391` (configurable via `SCREEN_GUIDE_PORT` in `.env`)

## Parent Project

Module of **Briolo** (B2B SaaS AI content pipeline, `briolo.io`).
Demo tenant: **Lux & Glo** (`luxandglo.com`).
Root working dir: `E:\AI Flow Systems\AI Consult`
