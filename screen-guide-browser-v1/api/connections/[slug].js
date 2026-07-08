// POST /api/connections/:slug   body { provider, token }
// The owner pastes a freshly minted token into their slot. We run the provider
// smoke test immediately and store the outcome the extension polls for.
// HARD RULES: session required; token never logged/echoed; token stored in the
// vault ONLY after it verifies; detail is credential-scrubbed.
const sess = require('../_session.js');
const store = require('../_store.js');
const { PROVIDERS } = require('../_providers.js');
const sec = require('../_security.js');

// Credentialed cross-origin GETs from the extension need an explicit origin echo
// plus Allow-Credentials (never '*'), or the fetch rejects and verifyCurrent()
// falls to the "could not reach dashboard" path.
function cors(req, res) {
  const allowOrigin = sec.resolveCorsOrigin(req.headers.origin, sec.parseAllowedOrigins(process.env));
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
}

const SLUGS = {
  'meta': ['meta'],
  'llm': ['anthropic', 'openai'],
  'booking': ['calcom', 'calendly'],
  'google-business': ['google-business'],
  'chat-email': ['resend', 'chatbase'],
};
const WEEK = 60 * 60 * 24 * 7;

async function readBody(req) {
  if (req.body) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  const env = process.env;
  sess.noStore(res);
  cors(req, res);
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).end();
    return;
  }

  const s = await sess.getSession(req, env);
  const slug = String((req.query && req.query.slug) || '');
  const providers = SLUGS[slug];

  // GET = status (the extension polls /api/connections/:slug/status, rewritten
  // here so paste + poll share one function/instance when memory-backed).
  if (req.method === 'GET') {
    if (!s) { res.status(401).json({ status: 'pending', error: 'not signed in' }); return; }
    if (!providers) { res.status(404).json({ error: 'unknown connection' }); return; }
    const rec = await store.kvGet(env, 'sg:status:' + s.email + ':' + slug);
    res.status(200).json(rec || { status: 'pending' });
    return;
  }

  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  if (!s) { res.status(401).json({ error: 'not signed in' }); return; }
  if (!providers) { res.status(404).json({ error: 'unknown connection' }); return; }

  let body;
  try { body = await readBody(req); } catch (_) { res.status(400).json({ error: 'bad json' }); return; }
  const provider = String((body && body.provider) || providers[0]).toLowerCase();
  if (!providers.includes(provider)) { res.status(400).json({ error: 'provider not valid for this connection' }); return; }
  const token = (body && body.token) || '';
  if (typeof token !== 'string' || token.length < 8 || token.length > 4096) {
    res.status(400).json({ error: 'token missing or malformed' });
    return;
  }

  const statusKey = 'sg:status:' + s.email + ':' + slug;
  await store.kvSet(env, statusKey, { status: 'pending' }, WEEK);

  let outcome;
  try {
    outcome = await PROVIDERS[provider](token);
  } catch (err) {
    const timeout = err && err.name === 'AbortError';
    outcome = { ok: false, reason: timeout ? 'the provider took too long to answer' : 'could not reach the provider' };
  }

  if (outcome && outcome.ok) {
    // Vault the verified token (the future runtime reads it from here).
    await store.kvSet(env, 'sg:token:' + s.email + ':' + slug, { provider, sealed: store.sealToken(env, token), at: Date.now() }, WEEK);
    await store.kvSet(env, statusKey, { status: 'verified', detail: outcome.detail || '', provider }, WEEK);
    res.status(200).json({ ok: true, status: 'verified', detail: outcome.detail || '' });
    return;
  }

  await store.kvSet(env, statusKey, { status: 'failed', reason: (outcome && outcome.reason) || 'the provider rejected this token', provider }, WEEK);
  res.status(200).json({ ok: false, status: 'failed', reason: (outcome && outcome.reason) || 'the provider rejected this token' });
};