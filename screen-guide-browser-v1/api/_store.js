// Tiny KV for sessions / tokens / verification statuses.
//
// DEPLOYMENT NOTE: functions are pinned to syd1 (see vercel.json "regions").
// The Upstash vault lives in ap-southeast-2 (Sydney) and the attendees are in
// Perth, so Washington-DC functions (Vercel's iad1 default) put a ~250ms
// Pacific crossing on every request AND every Redis op. Pinning to syd1
// collapses both. The trade: the Claude proxy now hops Sydney->US, adding
// ~200ms to a call that already takes 3-5s. Worth it.
// Upstash Redis REST when configured (multi-instance safe); otherwise a
// module-global Map — fine for local dev and demo, NOT for multi-instance prod.
// Values are JSON. Keys are namespaced by the caller. TTL in seconds.

const mem = new Map(); // key -> { v: string, exp: ms|null }

function upstash(env) {
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return { url: env.UPSTASH_REDIS_REST_URL.replace(/\/$/, ''), token: env.UPSTASH_REDIS_REST_TOKEN };
  }
  return null;
}

async function redisCmd(up, cmd) {
  const res = await fetch(up.url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + up.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error('upstash ' + res.status);
  const j = await res.json();
  return j.result;
}

async function kvGet(env, key) {
  const up = upstash(env);
  if (up) {
    const r = await redisCmd(up, ['GET', key]);
    return r == null ? null : JSON.parse(r);
  }
  const e = mem.get(key);
  if (!e) return null;
  if (e.exp && Date.now() > e.exp) { mem.delete(key); return null; }
  return JSON.parse(e.v);
}

async function kvSet(env, key, value, ttlSec) {
  const v = JSON.stringify(value);
  const up = upstash(env);
  if (up) {
    const cmd = ttlSec ? ['SET', key, v, 'EX', String(ttlSec)] : ['SET', key, v];
    await redisCmd(up, cmd);
    return;
  }
  mem.set(key, { v, exp: ttlSec ? Date.now() + ttlSec * 1000 : null });
}

async function kvDel(env, key) {
  const up = upstash(env);
  if (up) { await redisCmd(up, ['DEL', key]); return; }
  mem.delete(key);
}

function memoryOnly(env) { return !upstash(env); }

// ── Token sealing (AES-256-GCM at rest) ─────────────────────────────────────────
// Key = sha256(GUIDE_VAULT_KEY || GUIDE_SHARED_SECRET). If neither is set (bare
// dev), the value is stored unsealed and marked enc:false — never silently.
const crypto = require('crypto');

function vaultKey(env) {
  const secret = env.GUIDE_VAULT_KEY || env.GUIDE_SHARED_SECRET;
  if (!secret) return null;
  return crypto.createHash('sha256').update('sg-vault:' + secret).digest();
}

function sealToken(env, plaintext) {
  const key = vaultKey(env);
  if (!key) return { enc: false, v: plaintext };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { enc: true, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), v: ct.toString('base64') };
}

function openToken(env, sealed) {
  if (!sealed || sealed.enc === false) return sealed ? sealed.v : null;
  const key = vaultKey(env);
  if (!key) return null;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.v, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { kvGet, kvSet, kvDel, memoryOnly, sealToken, openToken };