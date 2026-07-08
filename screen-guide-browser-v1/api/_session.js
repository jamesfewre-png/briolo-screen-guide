// Stateless auth for the dashboard: sign-in tokens and session cookies are
// HMAC-SHA256-signed payloads (key derived from GUIDE_VAULT_KEY || GUIDE_SHARED_SECRET),
// so ANY serverless instance can verify them with zero shared storage.
// Trade-off (v1, accepted): sign-in links are expiry-limited (15 min) but not
// single-use — stateless tokens cannot be revoked. Cookie is SameSite=None; Secure
// so the extension service worker can include it when polling.
const crypto = require('crypto');

const SESSION_TTL_S = 60 * 60 * 24 * 30; // 30 days
const SIGNIN_TTL_MS = 15 * 60 * 1000;

function authKey(env) {
  const s = env.GUIDE_VAULT_KEY || env.GUIDE_SHARED_SECRET;
  return s ? crypto.createHash('sha256').update('sg-auth:' + s).digest() : null;
}

function b64u(buf) { return Buffer.from(buf).toString('base64url'); }

function sign(env, payload) {
  const key = authKey(env);
  if (!key) return null;
  const blob = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac('sha256', key).update(blob).digest());
  return blob + '.' + sig;
}

function verify(env, value, type) {
  const key = authKey(env);
  if (!key || typeof value !== 'string' || value.length > 2048) return null;
  const dot = value.indexOf('.');
  if (dot < 1) return null;
  const blob = value.slice(0, dot), sig = value.slice(dot + 1);
  const expect = b64u(crypto.createHmac('sha256', key).update(blob).digest());
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(blob, 'base64url').toString('utf8')); } catch (_) { return null; }
  if (!payload || payload.t !== type || typeof payload.x !== 'number' || Date.now() > payload.x) return null;
  return payload;
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function getSession(req, env) {
  const p = verify(env, parseCookies(req).sg_session, 'sess');
  return p ? { email: p.e } : null;
}

function createSession(env, email) {
  return sign(env, { e: email, x: Date.now() + SESSION_TTL_S * 1000, t: 'sess' });
}

function createSigninToken(env, email) {
  return sign(env, { e: email, x: Date.now() + SIGNIN_TTL_MS, t: 'signin' });
}

function verifySigninToken(env, token) {
  const p = verify(env, token, 'signin');
  return p ? { email: p.e } : null;
}

function sessionCookie(value) {
  return 'sg_session=' + encodeURIComponent(value) + '; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=' + SESSION_TTL_S;
}

function noStore(res) { res.setHeader('Cache-Control', 'no-store'); }

module.exports = { getSession, createSession, createSigninToken, verifySigninToken, sessionCookie, parseCookies, noStore };