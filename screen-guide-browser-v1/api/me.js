// GET /api/me -> 200 { email } when the session cookie is valid; 401 otherwise.
// Polled by the extension service worker (credentials: 'include') and the pages.
// CORS: a credentialed cross-origin fetch requires an explicit origin echo +
// Allow-Credentials — never '*'. Without these the extension's fetch REJECTS and
// the panel wrongly reports "not signed in".
const sess = require('./_session.js');
const sec = require('./_security.js');

function cors(req, res) {
  const allowOrigin = sec.resolveCorsOrigin(req.headers.origin, sec.parseAllowedOrigins(process.env));
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
}

module.exports = async function handler(req, res) {
  sess.noStore(res);
  cors(req, res);
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET') { res.status(405).json({ error: 'method not allowed' }); return; }
  const s = await sess.getSession(req, process.env);
  if (!s) { res.status(401).json({ error: 'not signed in' }); return; }
  res.status(200).json({ email: s.email });
};