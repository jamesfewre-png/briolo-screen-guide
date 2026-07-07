# Workshop Capture UX — Design Spec

**Date:** 2026-07-02 · **Status:** Approved (James, 2026-07-02) · **Builds on:** `screen-guide-browser-v1`
**Supersedes nothing** — extends the current side-panel + Driver.js + Claude-reasoner architecture. The old Electron/helper design (`2026-06-17-screen-guide-overlay-v05-design.md`) is historical.

## Purpose

Extend AI Consult so a non-technical Robot Roadmap cohort attendee goes from "describe your business" to "verified, working platform tokens handed into their own dashboard slot" — guided live, with the human performing every click. Five new connection flows: Meta (FB+IG), LLM API key (Claude/OpenAI), Cal.com/Calendly, Google Business Profile, Website Chat/Email (Tidio/Chatbase or Resend).

## 1 · Scope & boundaries

**In scope:** the capture experience — intake, AI-proposed connection plan, chained guided flows, finish-line hand-off, smoke-test verification, workshop-room error handling.

**Parked (separate projects):** dashboard internals (storage/encryption/post-login UI) and the automation runtime that executes on captured tokens.

**Deliberate carve-out:** the smoke test sends the token through a verify endpoint for ONE ephemeral read-only call — never logged, never persisted. Extends the existing "no credential echo" discipline one hop.

## 2 · Session journey

1. **Group sign-in** (synchronized, session start): attendees open the dashboard link, magic-link auth against their free-talk email, thumbs-up when in. Must be the same browser running the extension (guarded — §7).
2. **Intake:** attendee describes their business + the Robot Job they circled on their R.O.B.O.T. scorecard.
3. **Plan:** AI triage proposes the needed connections as an editable checklist with one plain-English reason each. Attendee/facilitator confirms. (Propose-then-confirm: AI decides, human approves, then it leads.)
4. **Chained flows:** the existing guidance engine runs each confirmed connection in order — no returning to a picker.
5. **Finish line per flow:** distinct panel state -> copy token -> deep-link button opens their dashboard slot -> paste -> attest -> smoke test -> verified success beat.
6. **All done:** summary of every verified connection.

## 3 · Panel screens

- **Start/Intake** (new default screen): two plain-English fields — "What's your business?" and "What's the job you want to hand to a robot?" Existing guide picker remains underneath as "Choose a specific guide" (facilitator override / standalone use).
- **Plan** (new): editable checklist (uncheck/reorder), one-line why per connection, "Looks right — let's start." Persists across the session as the progress view (done / current / upcoming).
- **Guidance** (existing, minor): unchanged mechanics + a slim plan strip showing position in the larger arc.
- **Finish line** (new state): visually distinct; numbered ritual — 1) Click Copy on the page. 2) [Open your dashboard ->] (deep-link, pre-aimed at this connection's slot, new tab). 3) Paste it there. 4) "I've pasted it into my dashboard" (attestation button). Named destination only — never "somewhere safe."
- **Verifying** (new state): spinner -> success beat (green check + one specific pulled-back detail, e.g. "Connected to <Page name>'s Facebook Page") or failure handling (§7).
- **All-done** (new): every verified connection with its detail line.

## 4 · On-page overlay

Mechanics unchanged (pulsing amber ring, tip bubble, click-through, auto-advance). One addition: on the token-reveal step the tip switches to finish-line framing ("This is your token — the panel takes it from here"). Palette stays #ff8a00.

## 5 · Smoke-test verification

Per flow, one read-only call with the pasted token, executed dashboard-side on attestation:

| Flow | Verify call | Detail displayed |
|---|---|---|
| Meta | fetch Page / IG account | Page/IG name |
| LLM key | trivial models-list call | provider + "key active" |
| Cal.com / Calendly | fetch event types | account/event-type name |
| Google Business Profile | fetch business | business name |
| Chat/Email | provider account check | account/site name |

Success MUST return one human-recognizable detail — a named thing, not a bare green tick. Rationale (recon-backed): token failures surface while the facilitator is in the room, not weeks later.

**Constraint:** the extension cannot verify the copy via clipboard — reading the clipboard would touch the credential. Completion = human attestation + smoke test.

## 6 · Workflow definition schema (additions)

Current fields: `id · name · objective · successCriteria · startUrl · notes`. Add:

- `patterns` — which R.O.B.O.T. patterns this connection serves (feeds triage)
- `verify` — verify-endpoint slug + which detail to display
- `deepLink` — dashboard slot path for the finish-line button
- `finishLine` — optional reveal-step copy override

Brand string moves to `config.json` (panel currently hardcodes "Briolo"; workshop deployments show "Robot Roadmap").

## 7 · Errors, stuck, and the room

- **Smoke test fails:** one guided regeneration (jump back to the token step only; "Tokens sometimes get miscopied — let's mint a fresh one"). Second failure -> **flag mode**: large calm amber banner — "Keep your seat — James will come to you." No networked facilitator view in v1; the on-screen banner is the signal.
- **Not signed in / wrong browser:** finish line checks the dashboard session before offering the deep-link; if absent, plain-language redirect to the sign-in step.
- **"I'm Stuck" twice on one step:** same flag mode. Nobody loops alone in a paid room.
- **Tone rule:** the system takes the blame, never the attendee.

## 8 · Security invariants

Carried forward untouched: human clicks everything; password inputs excluded from DOM scan; token/JWT/hex regex-stripped before reaching Claude; screenshot regions redacted. New: extension never reads the clipboard; the human pastes the token only into their own authenticated dashboard; verify calls are ephemeral and unlogged.

## 9 · Decisions log

| # | Decision | Choice |
|---|---|---|
| 1 | Scope | Capture UX only; destination/runtime parked |
| 2 | Picker IA | Describe -> AI proposes -> human confirms -> auto-chained flows |
| 3 | Finish line | Distinct state, named destination, attestation button |
| 4 | Verification | Ephemeral smoke test w/ specific success detail |
| 5 | Failure default | Retry-regenerate once -> facilitator flag mode |
| 6 | Identity | Magic-link tied to free-talk email; synchronized group sign-in |
| 7 | Intake shape | Two guided fields (scorecard pre-fill = later nice-to-have) |
| 8 | Facilitator visibility | On-screen flag state only (v1) |
| 9 | Flow packaging | 5 flows; provider choice inside a flow (Claude/OpenAI etc.) |
| 10 | Branding | Configurable brand string in config.json |

## Out of scope / follow-ups

- Dashboard build (auth, storage, post-login UI) — separate spec.
- Automation runtime (what executes on tokens) — separate spec; blocks nothing here except the deep-link target existing in some minimal form.
- Scorecard -> intake pre-fill data path.
- Networked facilitator dashboard.
- Chrome Web Store packaging (cohort 1 sideloads).
