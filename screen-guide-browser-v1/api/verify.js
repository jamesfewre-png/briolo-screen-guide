// Connection smoke-test endpoint (Vercel serverless function).
//
// POST { provider, token } -> { ok: true, detail } | { ok: false, reason }
//
// Called by the DASHBOARD after an owner pastes a freshly minted token, so the
// workshop finish-line can show "Verified - connected to <their Page>" while the
// facilitator is still in the room (spec 2026-07-02-workshop-capture-ux-design.md).
//
// HARD RULES (non-negotiable):
//   - The token is used for ONE ephemeral, read-only provider call. It is never
//     logged, never persisted, never echoed back in any response or error.
//   - `detail` is one human-recognizable name (their Page, their business), capped
//     and credential-scrubbed before it leaves.
//   - Same auth/CORS/rate-limit posture as api/analyze.js.

const sec = require('./_security.js');
const { PROVIDERS } = require('./_providers.js');

const FETCH_TIMEOUT_MS = 10000;

function setCorsHeaders(res, allowOrigin) {
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-guide-secret, x-guide-install');
}

async function readBody(req) {
  if (req.body) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

async function timedFetch(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

function cleanDetail(s, fallback) {
  const d = sec.broadenedSanitize(String(s || '')).slice(0, 80);
  return d || fallback;
}

module.exports = async function handler(req, res) {
  const env = process.env;
  const allowOrigin = sec.resolveCorsOrigin(req.headers.origin, sec.parseAllowedOrigins(env));
  setCorsHeaders(res, allowOrigin);

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }

  const auth = sec.verifyAuth(req, env);
  if (!auth.ok) { res.status(401).json({ error: 'unauthorized' }); return; }

  const store = sec.createStore(env, typeof fetch === 'function' ? fetch : null);
  const rl = await sec.checkRateLimit(store, {
    dayKey: new Date().toISOString().slice(0, 10),
    installId: auth.identity,
    ip: sec.getClientIp(req),
  });
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfter || 60));
    res.status(429).json({ error: 'rate limited', scope: rl.scope });
    return;
  }

  let payload;
  try { payload = await readBody(req); } catch (_) { res.status(400).json({ error: 'bad json' }); return; }

  const provider = String((payload && payload.provider) || '').toLowerCase();
  const token = (payload && payload.token) || '';
  const fn = PROVIDERS[provider];
  if (!fn) { res.status(400).json({ error: 'unknown provider' }); return; }
  if (typeof token !== 'string' || token.length < 8 || token.length > 4096) {
    res.status(400).json({ ok: false, reason: 'token missing or malformed' });
    return;
  }

  try {
    const result = await fn(token);
    if (result && result.ok) { res.status(200).json({ ok: true, detail: result.detail || '' }); return; }
    res.status(200).json({ ok: false, reason: (result && result.reason) || 'the provider rejected this token' });
  } catch (err) {
    const timeout = err && err.name === 'AbortError';
    res.status(200).json({ ok: false, reason: timeout ? 'the provider took too long to answer' : 'could not reach the provider' });
  }
};
