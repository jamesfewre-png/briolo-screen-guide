# Screen Guide — Security Notes

Status of the two pre-launch security issues and how each is mitigated. Read this
before deploying the proxy or publishing the extension.

## Issue 1 — Proxy abuse / runaway Anthropic bill

**Fixed in `api/analyze.js` + `api/_security.js` (unit-tested in `test/security.test.cjs`).**

| Control | What it does |
|---|---|
| Timing-safe auth | `x-guide-secret` is compared via SHA-256 + `crypto.timingSafeEqual` — no length or early-exit timing leak. |
| CORS allow-list | No more `Access-Control-Allow-Origin: *`. Only `chrome-extension://` origins and `GUIDE_ALLOWED_ORIGINS` are reflected. |
| Per-install limit | Extension sends a random `x-guide-install` id; limited to 40 req/60s per install. |
| Per-IP limit | 80 req/60s per client IP. |
| **Global daily ceiling** | Hard cap (default 5000/day, `GUIDE_MAX_DAILY`). **This is the real bill protection** — even if the secret leaks and someone scripts the endpoint, spend is bounded to a known number of calls/day. |

**Required Vercel env for production:** `ANTHROPIC_API_KEY`, `GUIDE_SHARED_SECRET`,
and (strongly recommended) `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`.
See `.env.example`.

**Residual limitations (by design, documented honestly):**
- Without Upstash, rate limiting is **best-effort in-memory** — it only sees one
  warm serverless instance, so a distributed attacker could exceed limits. The
  global daily ceiling still applies per instance. **Configure Upstash for prod.**
- Store errors **fail open** (a request is allowed if the limiter store is down)
  so guidance never breaks for a paying user. The trade-off is accepted for MVP.
- The shared secret still ships inside the extension, so it is only an interim
  guard. `verifyAuth()` in `_security.js` is the single seam where per-tenant
  Briolo tokens replace it once user-auth exists.

## Issue 2 — Screenshots leaking on-screen secrets/PII

**Fixed in `src/content.js` + `src/background.js`.**

- `content.js` `findSensitiveRegions()` returns device-pixel rectangles for:
  password inputs, credential-labelled fields, fields whose **value** looks like a
  token (covers the read-only "your new token" field), and credential-labelled
  containers that display a token.
- `background.js` `redactScreenshot()` blacks out those rectangles on an
  `OffscreenCanvas` **before** the JPEG is sent to the proxy.
- **Fail-safe:** if regions exist but redaction fails, the screenshot is dropped
  (returns `null`), never sent unredacted. Guidance continues from text elements.
- Text scrubbing broadened: `stripTokens` now also removes JWTs and long hex; a
  `stripSecretContext` strip removes short 2FA/OTP codes from credential-labelled
  elements. Mirrored server-side in `_security.js` `broadenedSanitize`.

**Residual limitations:**
- Region detection is **heuristic** — a secret rendered with no credential
  labelling and a non-token-shaped value could be missed. The redaction targets
  the high-value, high-confidence cases (password fields, generated tokens).
- Secrets inside cross-origin **iframes** are not redacted (coordinates are
  top-frame only). Meta's token dialog is top-frame, so the main flow is covered.

## How to verify the screenshot redaction (manual — needs a real browser)

The proxy logic is unit-tested. The screenshot path uses `OffscreenCanvas` /
`createImageBitmap` and live DOM, so verify it manually:

1. Build (`npm run build`) and load `dist/` unpacked; refresh the target page.
2. Open a page with a visible secret (e.g. Meta's "Generate token" result, or any
   page with a password field that has a value).
3. In the service-worker console, confirm `captureRedactedScreenshot` runs and the
   outgoing screenshot has the secret region blacked out (inspect the data URL, or
   temporarily render it).
4. Confirm guidance still works when the screenshot is dropped (no secret regions
   missing → normal behavior).

## Pre-launch checklist

- [ ] Set `GUIDE_SHARED_SECRET` (long random) in Vercel **and** rebuild the extension with the same value.
- [ ] Set `UPSTASH_REDIS_REST_URL` + `_TOKEN` in Vercel for durable rate limiting.
- [ ] Set `GUIDE_ALLOWED_ORIGINS` to the dashboard origins (once the web app calls the proxy).
- [ ] Tune `GUIDE_MAX_DAILY` to your real expected ceiling.
- [ ] Confirm `dist/` is gitignored (it is) and the secret is not in git history.
- [ ] Manually verify screenshot redaction (steps above).
