# AI Screen Guide — Chrome Extension

An AI-guided browser walkthrough tool. It highlights the next element you need to
click for a given workflow (e.g. connecting Meta Business assets), advancing
automatically as you complete each step. Guidance is driven by fuzzy text
matching, with a hybrid Claude Haiku 4.5 reasoning fallback that fires when the
text-match confidence is low.

The extension never clicks anything for you — **you click everything**. It only
points the way.

## Architecture

| File | Role |
| --- | --- |
| `src/background.js` | MV3 service worker — state machine, step matching, hybrid Claude calls |
| `src/content.js` | DOM scan + Driver.js highlight + click-completion tracking |
| `src/claudeReasoner.js` | Raw fetch to Claude Haiku 4.5 (`provide_guidance` tool) |
| `src/panel.html` / `src/panel.js` | Customer-facing side panel UI |
| `src/workflows/*.json` | Workflow step definitions (every JSON here is shipped) |
| `src/vendor/driver.js` / `driver.css` | Driver.js highlight library |
| `build.cjs` | Zero-dependency build — copies `src/` to `dist/`, injects the API key |

## Build

```bash
node build.cjs
```

This copies everything from `src/` into `dist/` and:

- copies **every** `*.json` in `src/workflows/` (new workflows ship automatically — no edit to the build needed),
- injects your Anthropic API key into `dist/config.json` (see below).

The build always completes. If no API key is found it prints a warning and ships
with AI hybrid reasoning disabled; text-match guidance still works.

## Load the extension

1. Run `node build.cjs`.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top right).
4. Click **Load unpacked** and select the **`dist/`** folder.
5. Click the toolbar icon (or open the side panel) to start.

After rebuilding, click the reload icon on the extension card in
`chrome://extensions` to pick up changes.

## The `.env` requirement (API key)

The Claude hybrid reasoning needs an Anthropic API key. At build time `build.cjs`
looks for `ANTHROPIC_API_KEY` in this order:

1. `./.env` (a local `.env` in this folder, if present)
2. `../.env` (the repo-root `.env`)

Provide one with:

```
ANTHROPIC_API_KEY=sk-ant-...
```

The key is written to **`dist/config.json` only** — that is the single place the
key ever lands. The service worker reads it via
`chrome.runtime.getURL('config.json')`, an extension-internal fetch, so
`config.json` is **not** exposed in `web_accessible_resources` (and must never
be).

## Security constraints (non-negotiable)

- **You click everything.** The extension never automates clicks — it only
  highlights and explains. No programmatic clicking, ever.
- **No credential echo.** Credential values are never read back, logged, or
  displayed. Password inputs are excluded from the DOM scan.
- **Overlay messages stay short.** Guidance text is concise and never repeats
  anything sensitive on screen.
- **`config.json` stays private.** It is not a web-accessible resource; only the
  extension's own code can fetch it.

## Never commit `dist/`

`dist/config.json` contains your API key. The `dist/` folder is gitignored
(`screen-guide-browser-v1/dist/` at the repo root) and **must never be
committed**. If you ever see `dist/` staged, unstage it before committing.
