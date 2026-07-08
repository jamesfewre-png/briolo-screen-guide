// Magic-link sign-in for the workshop dashboard.
// POST { email }  -> creates a 15-min sign-in token. If RESEND_API_KEY is set the
//                    link is emailed; otherwise the link is RETURNED in the
//                    response (dev mode) so cohort-0 testing needs no mail setup.
// GET  ?token=... -> consumes the token, sets the session cookie
//                    (SameSite=None; Secure — required for extension polling),
//                    redirects to ?to= (same-site paths only) or /.


const sess = require('./_session.js');



async function readBody(req) {
  if (req.body) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function origin(req) {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  return proto + '://' + req.headers.host;
}

module.exports = async function handler(req, res) {
  const env = process.env;
  sess.noStore(res);

  if (req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (_) { res.status(400).json({ error: 'bad json' }); return; }
    const email = String((body && body.email) || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200) {
      res.status(400).json({ error: 'valid email required' });
      return;
    }
    const token = sess.createSigninToken(env, email);
    if (!token) { res.status(500).json({ error: 'server not configured (no auth secret)' }); return; }
    const to = (body && typeof body.to === 'string' && body.to.startsWith('/')) ? body.to : '/';
    const link = origin(req) + '/api/auth?token=' + token + '&to=' + encodeURIComponent(to);

    // Send real email ONLY when a key AND an explicitly verified sender are both
    // configured. RESEND_API_KEY alone is NOT enough — it also powers the health
    // canary's alert emails, and Resend's shared sandbox sender
    // (onboarding@resend.dev) only ever delivers to the account owner. Falling
    // back to it would mean a room of attendees staring at inboxes that never
    // receive anything, with the server cheerfully reporting {"sent":true}.
    // No verified sender => stay in dev-link mode, which visibly works.
    if (env.RESEND_API_KEY && env.GUIDE_MAIL_FROM) {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.GUIDE_MAIL_FROM,
          to: email,
          subject: (env.GUIDE_BRAND || 'Screen Guide') + ' — your sign-in link',
          html: '<p>Click to sign in (valid 15 minutes):</p><p><a href="' + link + '">' + link + '</a></p>',
        }),
      });
      if (!r.ok) { res.status(502).json({ error: 'email send failed' }); return; }
      res.status(200).json({ ok: true, sent: true });
      return;
    }
    // Dev mode — no mail provider configured. Return the link directly.
    res.status(200).json({ ok: true, sent: false, devLink: link, note: 'no verified sender configured (set GUIDE_MAIL_FROM) — dev sign-in link returned' });
    return;
  }

  if (req.method === 'GET') {
    const token = String((req.query && req.query.token) || '');
    if (!token || token.length > 2048) { res.status(400).send('Invalid link.'); return; }
    const rec = sess.verifySigninToken(env, token);
    if (!rec) { res.status(400).send('This sign-in link has expired. Go back and request a new one.'); return; }
    const sid = sess.createSession(env, rec.email);
    const to = (req.query && typeof req.query.to === 'string' && req.query.to.startsWith('/') && !req.query.to.startsWith('//')) ? req.query.to : '/';
    res.setHeader('Set-Cookie', sess.sessionCookie(sid));
    res.statusCode = 302;
    res.setHeader('Location', to);
    res.end();
    return;
  }

  res.status(405).json({ error: 'method not allowed' });
};