// GET /api/me -> 200 { email } when the session cookie is valid; 401 otherwise.
// Polled by the extension (credentials: include) and by the dashboard pages.
const sess = require('./_session.js');

module.exports = async function handler(req, res) {
  sess.noStore(res);
  if (req.method !== 'GET') { res.status(405).json({ error: 'method not allowed' }); return; }
  const s = await sess.getSession(req, process.env);
  if (!s) { res.status(401).json({ error: 'not signed in' }); return; }
  res.status(200).json({ email: s.email });
};