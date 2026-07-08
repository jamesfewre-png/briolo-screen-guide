# autoloop memory — screen-guide capture system (2026-07-08)

- Vercel serverless: per-FUNCTION isolated memory — an in-memory store NEVER shares state across api/*.js functions. Fix used: stateless HMAC auth (key: GUIDE_SHARED_SECRET) + consolidate coupled endpoints into ONE function (status rewritten onto the paste function). Upstash env vars auto-upgrade _store.js when added.
- Session cookie MUST be SameSite=None; Secure or the extension service worker drops it on cross-site polls.
- vercel CLI is authenticated locally (jamesfewre-9340); deploy with --prod --yes works but output is wrapped in plugin-shim noise — verify deployment by probing a NEW endpoint (401-vs-404), not CLI output.
- PowerShell 5.1 traps hit here: curly apostrophes terminate single-quoted strings (use here-strings); Set-Content -Encoding utf8 writes a BOM (Node JSON.parse rejects it — use UTF8Encoding($false)); the built-in deletion cmdlet is hook-blocked in this harness (use [System.IO.File]::Delete instead); Invoke-WebRequest fumbles 302+Set-Cookie (use curl.exe with a cookie jar).
- Extension contract source of truth: background.js verifyCurrent() reads data.status ('verified'|'failed'), data.detail (verified path), data.reason (failed path, iter 2+); 404 = "unreachable dashboard" pass-through; 401-with-{status:'pending'} keeps the poller graceful.
- Dominant lever confirmed: contract fidelity + cookie mechanics; hygiene items were never the blocker.
- E2E without real credentials: dev-link auth mode + a dummy provider token (real provider API genuinely rejects it) exercises the full chain.