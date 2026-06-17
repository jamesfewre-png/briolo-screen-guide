# Design Spec: AI Screen Guide Overlay v05

**Date:** 2026-06-17
**Project:** AI Flow Systems — AI Consult
**Directory:** `E:\AI Flow Systems\AI Consult\screen-guide-overlay-v05\`
**Status:** Approved — pending implementation plan

---

## Context

This is Sub-project 1 of the larger AI-Native Business Builder platform. The overlay is the wedge product and the first magic moment: a non-technical founder who does not know what to click sees the AI pointing at the exact button.

The overlay must feel like a patient human expert sitting beside the user, pointing at the screen — not touching the keyboard or mouse.

This spec describes v05, a structured rebuild of the existing v04 Electron prototype. v04 is proven for the core window/overlay/bridge architecture but has a hardcoded reasoning layer, no formal workflow engine, no scroll tracking, and a developer-facing control UI. v05 fixes all of these.

---

## Core principle

```
AI decides what matters.
Local tracking keeps the highlight attached.
Workflow logic keeps the AI grounded.
The human remains in control.
```

The AI must never click, type, copy, or approve anything. It guides; the human acts.

---

## What is ported from v04 (unchanged)

These three components are correct in v04 and are copied verbatim:

| Component | File | Why kept |
|---|---|---|
| Canvas overlay renderer | `src/overlay.html` + `overlay.js` | Orange highlights, arrows, labels, pulse, evidence badge all correct |
| DOM scraper | `browser-helper/content.js` | Full element collection, cssPath, aria extraction, screenRect calculation |
| Bridge poster | `browser-helper/background.js` | Correct throttle (250ms), health check, enable/disable |

One fix in `content.js`: change chromeY calculation from `outerHeight - innerHeight - chromeX` to `outerHeight - innerHeight` for more accurate toolbar height on Windows Chrome. No other changes.

---

## Project structure

```
screen-guide-overlay-v05/
├── package.json
├── .env.example
├── browser-helper/
│   ├── manifest.json           ← ported
│   ├── content.js              ← ported + chromeY fix
│   ├── background.js           ← ported
│   ├── popup.html              ← ported
│   └── popup.js                ← ported
├── src/
│   ├── main.js                 ← ported (bridge server, IPC, sanitizePageState)
│   ├── overlay.html            ← ported
│   ├── overlay.js              ← ported
│   ├── overlayPreload.js       ← ported
│   ├── preload.js              ← rebuilt (new IPC channels)
│   ├── control.html            ← rebuilt (non-technical UX)
│   ├── control.js              ← rebuilt (workflow-aware)
│   ├── ai/
│   │   └── claudeReasoner.js   ← new
│   ├── workflow/
│   │   ├── engine.js           ← new
│   │   └── definitions/
│   │       └── meta-connect-assets.json  ← new
│   └── tracking/
│       └── tracker.js          ← new
```

---

## Section 1: Claude reasoning layer

**File:** `src/ai/claudeReasoner.js`

**Replaces:** v04's `analyzeWithOpenAI()`

**Model:** `claude-sonnet-4-6`

**Dependency:** `@anthropic-ai/sdk`

**Environment:** `ANTHROPIC_API_KEY`

### Structured output via tool use

Claude is called with a `provide_guidance` tool and `tool_choice: { type: "tool", name: "provide_guidance" }`. This forces a valid, schema-matched JSON response — no parse failures, no schema drift.

Tool input schema:
```json
{
  "type": "object",
  "required": ["instruction", "confidence", "source", "overlay", "status"],
  "properties": {
    "instruction": { "type": "string" },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
    "source": { "type": "string", "enum": ["level-3-dom-aware", "dom-aware-low-confidence", "vision-only", "fallback"] },
    "target": {
      "type": "object",
      "properties": {
        "text": { "type": "string" },
        "selector": { "type": "string" },
        "role": { "type": "string" },
        "tag": { "type": "string" },
        "screenRect": { "type": "object" }
      }
    },
    "overlay": {
      "type": "object",
      "required": ["type", "message"],
      "properties": {
        "type": { "type": "string", "enum": ["dom-highlight", "vision-highlight", "callout", "message", "clear"] },
        "message": { "type": "string" },
        "label": { "type": "string" },
        "confidence": { "type": "number" },
        "highlight": { "type": "object" },
        "arrow": { "type": "object" }
      }
    },
    "status": { "type": "string", "enum": ["ready", "checking", "unsure", "complete", "wrong-page"] }
  }
}
```

### Context passed to Claude

```js
{
  task: "user's stated goal",
  workflowStep: {
    id: "open-business-settings",
    instruction: "Click Business Settings in the left sidebar.",
    targetLabels: ["Business Settings"],
    expectedDomains: ["business.facebook.com"],
    fallback: "Look for Business Settings in the left navigation."
  },
  pageState: {
    url, title, viewport, windowMetrics, scroll,
    summaryText,
    elements: [ /* first 80 visible clickable elements: text, role, selector, screenRect, isClickable, disabled */ ]
  },
  pageStateAgeMs: 340,
  previousGuidance: { type, message, confidence, anchor }
}
```

### System prompt rules (enforced)

- Do not automate clicks, bypass permissions, or approve dialogs. The human must do all of that.
- Prefer DOM/selector evidence over vision guesses when both are available.
- Never display credential values (tokens, passwords, API keys) in overlay text.
- If confidence < 0.45, set status "unsure" and show a fallback message. Do not draw an arrow.
- If the user is on the wrong domain, set status "wrong-page" and tell them where to navigate.
- Return reasoning in 1–2 sentences (internal, not shown in overlay).

### Fallback

If `ANTHROPIC_API_KEY` is absent or the Claude call fails, fall back to `domGuidance()` (ported from v04). App remains fully usable without an API key for local testing.

---

## Section 2: Workflow engine

**File:** `src/workflow/engine.js`

### Workflow definition format

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

### State machine

```
idle
  → running (currentStepIndex = 0)
      on each DOM update:
        check completionSignals for current step
          signals matched → advance to next step immediately (no AI call)
          signals not matched → pass step context to AI reasoner
        domain check: if URL does not match expectedDomains → status "wrong-page"
      on AI response.status = "complete" → advance to next step
      on confidence < 0.45 for 3+ consecutive cycles → stuck
          show step.fallback instruction
          reset stuck counter on next DOM change
  → complete (all steps done)
  → paused (user pressed Pause)
  → stopped
```

Completion detection runs on every DOM state update — not waiting for an AI call. Step transitions feel instant.

### Engine API

```js
engine.load(workflowId)       // loads JSON from workflow/definitions/
engine.start()
engine.pause()
engine.stop()
engine.onStepChange(cb)       // fires when step index advances
engine.onStatusChange(cb)     // fires on stuck / wrong-page / complete
engine.getCurrentStep()       // returns current step object
engine.getStepIndex()         // 0-based
engine.getTotalSteps()
engine.updatePageState(state) // called by main.js on each bridge POST
```

---

## Section 3: Fast local tracking loop

**File:** `src/tracking/tracker.js`

### Purpose

Keeps the overlay highlight attached to a target element without calling AI on every tick. Solves the scroll disconnect problem.

### Architecture

```
AI call returns → tracker.setAnchor({ selector, text, role, screenRect, confidence })

setInterval(100ms):
  search latestPageState.elements for element matching anchor.selector OR anchor.text
  → found, screenRect changed > 3px from lastKnown:
      push overlay:update with new rect immediately (< 50ms)
  → found, screenRect unchanged:
      no-op
  → found, no screenRect:
      confidence -= 0.1 per cycle
      if confidence < 0.35: hide highlight, show "Checking screen…"
  → not found:
      if |scroll.y delta| > 20px vs last: hide highlight, show "Checking screen…"
      if not found for > 400ms: schedule AI re-call (debounced, cancels if found first)
  → anchor is null:
      no-op
```

### Scroll detection

Compare `latestPageState.scroll.y` to last known value every 100ms. Delta > 20px = scroll in progress:
1. Hide highlight immediately
2. Show "Checking screen…" overlay message
3. Wait for content.js mutation observer to fire (updated DOM arrives within 220ms)
4. Tracker re-finds element in updated DOM data
5. Restore highlight in new position

Target latency: overlay movement < 100ms, re-detection after scroll < 400ms.

Tracker runs in the main process alongside main.js — reads `latestPageState` directly from the shared variable, calls `sendOverlay()` directly. No new IPC channels needed.

---

## Section 4: Coordinate accuracy

### Primary fix (content.js — one line change)

```js
// Before (v04):
const chromeY = Math.max(0, outerHeight - window.innerHeight - chromeX);

// After (v05):
const chromeY = Math.max(0, outerHeight - window.innerHeight);
```

`window.outerHeight - window.innerHeight` gives the actual Chrome toolbar + tab bar + address bar height (typically 88–120px on Windows). The old formula subtracted `chromeX` (horizontal chrome estimate) which incorrectly reduced the vertical offset.

This fix alone targets ±10–15px accuracy for standard Chrome window sizes on Windows.

### Optional calibration (out of scope for v05, noted for Phase 2)

A "Calibrate" button in the control window would allow user to confirm overlay position accuracy. Offset saved to `%APPDATA%/screen-guide/calibration.json`. Applied as constant offset to all `clientRectToScreen` results. Deferred.

---

## Section 5: Control window UX

**Files:** `src/control.html` + `src/control.js` (both rebuilt)

### Layout

```
┌─────────────────────────────────┐
│  AI Screen Guide                │
│                                 │
│  What do you want help with?    │
│  ┌─────────────────────────┐    │
│  │ Connect my Meta account │    │
│  └─────────────────────────┘    │
│                                 │
│  Step 2 of 6                    │
│  ●●──────────────────○○○○       │
│                                 │
│  "Click Business Settings       │
│   in the left sidebar."         │
│                                 │
│  ● Browser helper connected     │
│  Confidence: Confirmed          │
│                                 │
│  [ Start Guidance ]             │
│  [ Pause ]  [ Stop ]            │
│                                 │
│  ▸ Show debug panel             │
└─────────────────────────────────┘
```

### Behaviour rules

- Task textarea pre-filled with Meta workflow goal; editable for future workflows
- Step progress dots: filled = completed, active orange = current, empty = pending
- Current instruction displayed at 18px minimum — readable at arm's length
- Confidence displayed as human words: "Confirmed" (≥0.75) / "Checking…" (0.45–0.75) / "Not sure — scroll slowly" (<0.45)
- Raw confidence % only visible in debug panel
- Browser helper status pill: green "connected" or red "disconnected — install browser helper for better guidance ▸"
- Pause: stops AI calls and tracking loop, overlay shows "Paused. Click Resume to continue."
- Stop: clears overlay immediately, resets engine to idle
- Debug panel: collapsed by default, expands to show DOM pills + raw JSON (dev use)

---

## Section 6: Privacy model

- Screen frames captured to off-screen canvas, sent to Claude as base64, discarded immediately after API response. Never written to disk.
- `pageState` from browser helper is sanitised in `main.js` (same `sanitizePageState` function as v04). Input fields of type `password` are excluded from element text collection.
- Claude system prompt: never surface credential values in overlay text. Highlight paste targets only.
- No telemetry, remote logging, or analytics in v05.
- User can stop guidance at any time. Overlay clears immediately.

---

## Section 7: Acceptance criteria

| # | Test | Pass condition |
|---|---|---|
| 1 | Highlight DOM button | AI selects element → overlay highlights correct screen position → user can click through |
| 2 | Scroll with target highlighted | Target moves → highlight follows < 100ms OR hides + re-detects < 400ms |
| 3 | Target scrolls off-screen | Element leaves viewport → highlight disappears → scroll direction prompt shown |
| 4 | Target scrolls back | Element returns to viewport → highlight re-appears |
| 5 | Wrong page | URL/domain does not match step → no arrow → user told where to navigate |
| 6 | Low confidence | Expected element not found → status "unsure" → no misleading arrow |
| 7 | Meta workflow step | Engine at "open-business-settings" → DOM finds "Business Settings" link → overlay highlights it |
| 8 | No API key | App falls back to domGuidance(), still highlights DOM targets |
| 9 | Sensitive field | Token visible in DOM → overlay label never shows token text |
| 10 | Step completion | User reaches /settings/ URL → engine auto-advances to next step without AI call |

---

## Dependencies

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "latest"
  },
  "devDependencies": {
    "electron": "^31.7.7"
  }
}
```

No bundler. CommonJS in main process. Vanilla JS in renderer. No framework.

---

## Out of scope for v05

- Calibration UI
- Shopify / Stripe / Google Analytics workflows
- Business profile / onboarding module
- Cloud backend / user accounts
- Distribution packaging / installer
- Multi-monitor support
- macOS (Windows primary; Electron makes Mac straightforward later)
- Voice / TTS output
- Sensitive field redaction beyond password-type exclusion

---

## Build order

1. Scaffold project directory, `package.json`, `.env.example`, init git
2. Port `overlay.html`, `overlay.js`, `overlayPreload.js`
3. Port `browser-helper/` (content.js with chromeY fix, background.js, manifest.json, popup)
4. Port `main.js` bridge server and `sanitizePageState`; add engine + tracker hooks
5. Implement `src/ai/claudeReasoner.js` (Claude tool-use + domGuidance fallback)
6. Implement `src/workflow/engine.js` + `meta-connect-assets.json`
7. Implement `src/tracking/tracker.js` (100ms loop)
8. Rebuild `src/preload.js` with updated IPC channels
9. Rebuild `src/control.html` + `control.js` (non-technical UX, step tracker)
10. Wire all modules in `main.js`
11. Test: browser helper installed, Meta workflow, scroll tracking, low-confidence paths
12. Verify all 10 acceptance criteria
