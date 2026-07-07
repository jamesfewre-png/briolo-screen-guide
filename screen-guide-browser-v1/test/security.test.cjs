// Unit tests for the proxy security helpers. Run: npm test  (node --test)
// Zero dependencies — uses the built-in node:test + node:assert.

const { test } = require('node:test');
const assert = require('node:assert');
const sec = require('../api/_security.js');

// ── broadenedSanitize ──────────────────────────────────────────────────────────
test('broadenedSanitize strips long opaque tokens', () => {
  const out = sec.broadenedSanitize('your key is AbCdEf0123456789XyZwVu more');
  assert.ok(!out.includes('AbCdEf0123456789XyZwVu'), 'token should be removed');
  assert.ok(out.includes('your key is'), 'surrounding text kept');
});

test('broadenedSanitize strips JWTs (dotted segments the old rule missed)', () => {
  const jwt = 'eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM';
  const out = sec.broadenedSanitize('token ' + jwt + ' end');
  assert.ok(!out.includes(jwt), 'JWT should be removed');
});

test('broadenedSanitize strips long hex digests', () => {
  const out = sec.broadenedSanitize('sig 0123456789abcdef0123 done');
  assert.ok(!out.includes('0123456789abcdef0123'), 'hex digest removed');
});

test('broadenedSanitize leaves normal UI text intact', () => {
  const t = 'Click Generate token to continue';
  assert.strictEqual(sec.broadenedSanitize(t), t);
});

test('broadenedSanitize handles non-strings', () => {
  assert.strictEqual(sec.broadenedSanitize(null), '');
  assert.strictEqual(sec.broadenedSanitize(undefined), '');
  assert.strictEqual(sec.broadenedSanitize(42), '');
});

// ── timingSafeEqualStr ─────────────────────────────────────────────────────────
test('timingSafeEqualStr true for equal strings', () => {
  assert.strictEqual(sec.timingSafeEqualStr('s3cr3t-value', 's3cr3t-value'), true);
});

test('timingSafeEqualStr false for different strings (incl. different lengths)', () => {
  assert.strictEqual(sec.timingSafeEqualStr('abc', 'abd'), false);
  assert.strictEqual(sec.timingSafeEqualStr('abc', 'abcdef'), false);
  assert.strictEqual(sec.timingSafeEqualStr('', 'x'), false);
});

test('timingSafeEqualStr false for non-strings', () => {
  assert.strictEqual(sec.timingSafeEqualStr(null, null), false);
  assert.strictEqual(sec.timingSafeEqualStr(undefined, 'x'), false);
});

// ── CORS ────────────────────────────────────────────────────────────────────────
test('resolveCorsOrigin allows chrome-extension origins', () => {
  const o = 'chrome-extension://abcdefghijklmnop';
  assert.strictEqual(sec.resolveCorsOrigin(o, []), o);
});

test('resolveCorsOrigin allows configured origins only', () => {
  const allowed = ['https://briolo.io', 'https://app.briolo.io'];
  assert.strictEqual(sec.resolveCorsOrigin('https://briolo.io', allowed), 'https://briolo.io');
  assert.strictEqual(sec.resolveCorsOrigin('https://evil.example', allowed), null);
});

test('resolveCorsOrigin returns null for missing origin (no wildcard)', () => {
  assert.strictEqual(sec.resolveCorsOrigin('', ['https://briolo.io']), null);
  assert.strictEqual(sec.resolveCorsOrigin(undefined, ['https://briolo.io']), null);
});

test('parseAllowedOrigins splits and trims', () => {
  const env = { GUIDE_ALLOWED_ORIGINS: 'https://a.com, https://b.com ,' };
  assert.deepStrictEqual(sec.parseAllowedOrigins(env), ['https://a.com', 'https://b.com']);
  assert.deepStrictEqual(sec.parseAllowedOrigins({}), []);
});

// ── getClientIp ─────────────────────────────────────────────────────────────────
test('getClientIp takes the first x-forwarded-for entry', () => {
  assert.strictEqual(sec.getClientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } }), '1.2.3.4');
  assert.strictEqual(sec.getClientIp({ headers: { 'x-real-ip': '9.9.9.9' } }), '9.9.9.9');
  assert.strictEqual(sec.getClientIp({ headers: {} }), '');
});

// ── verifyAuth ──────────────────────────────────────────────────────────────────
test('verifyAuth rejects a wrong secret', () => {
  const env = { GUIDE_SHARED_SECRET: 'correct-horse' };
  const r = sec.verifyAuth({ headers: { 'x-guide-secret': 'wrong' } }, env);
  assert.strictEqual(r.ok, false);
});

test('verifyAuth accepts the right secret and returns install identity', () => {
  const env = { GUIDE_SHARED_SECRET: 'correct-horse' };
  const r = sec.verifyAuth({ headers: { 'x-guide-secret': 'correct-horse', 'x-guide-install': 'inst-123' } }, env);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.identity, 'inst-123');
});

test('verifyAuth falls back to "shared" identity when no install id', () => {
  const env = { GUIDE_SHARED_SECRET: 'correct-horse' };
  const r = sec.verifyAuth({ headers: { 'x-guide-secret': 'correct-horse' } }, env);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.identity, 'shared');
});

test('verifyAuth allows when no secret configured (dev)', () => {
  const r = sec.verifyAuth({ headers: {} }, {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.identity, 'anon');
});

// ── rate limiting ───────────────────────────────────────────────────────────────
test('memoryStore counts within a window and resets after TTL', async () => {
  const s = sec.memoryStore();
  const t0 = 1000;
  assert.strictEqual(await s.incr('k', 60, t0), 1);
  assert.strictEqual(await s.incr('k', 60, t0 + 1), 2);
  // After the window expires, count resets.
  assert.strictEqual(await s.incr('k', 60, t0 + 61000), 1);
});

test('checkRateLimit blocks per-install over the limit', async () => {
  const s = sec.memoryStore();
  const limits = { perInstall: { max: 3, windowSec: 60 }, global: { max: 9999, windowSec: 86400 }, perIp: { max: 9999, windowSec: 60 } };
  const opts = { dayKey: '2026-06-22', installId: 'inst-A', ip: '1.1.1.1', nowMs: 5000 };
  let last;
  for (let i = 0; i < 3; i++) last = await sec.checkRateLimit(s, opts, limits);
  assert.strictEqual(last.allowed, true, 'first 3 allowed');
  last = await sec.checkRateLimit(s, opts, limits);
  assert.strictEqual(last.allowed, false, '4th blocked');
  assert.strictEqual(last.scope, 'install');
});

test('checkRateLimit enforces the global daily ceiling (circuit breaker)', async () => {
  const s = sec.memoryStore();
  const limits = { global: { max: 2, windowSec: 86400 }, perInstall: { max: 9999, windowSec: 60 }, perIp: { max: 9999, windowSec: 60 } };
  // Different installs/ips, but the global cap still trips.
  const mk = (n) => ({ dayKey: '2026-06-22', installId: 'inst-' + n, ip: '2.2.2.' + n, nowMs: 5000 });
  assert.strictEqual((await sec.checkRateLimit(s, mk(1), limits)).allowed, true);
  assert.strictEqual((await sec.checkRateLimit(s, mk(2), limits)).allowed, true);
  const blocked = await sec.checkRateLimit(s, mk(3), limits);
  assert.strictEqual(blocked.allowed, false);
  assert.strictEqual(blocked.scope, 'global');
});

test('checkRateLimit fails open when the store throws', async () => {
  const brokenStore = { async incr() { throw new Error('store down'); } };
  const r = await sec.checkRateLimit(brokenStore, { dayKey: 'd', installId: 'i', ip: 'x' }, {});
  assert.strictEqual(r.allowed, true, 'guidance must not break when the limiter store is down');
});

test('upstashStore issues an INCR+EXPIRE pipeline and returns the count', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), auth: opts.headers.Authorization });
    return { ok: true, json: async () => [{ result: 7 }, { result: 1 }] };
  };
  const s = sec.upstashStore('https://us1.upstash.io/', 'tok_abc', fakeFetch);
  const count = await s.incr('sg:ip:1.2.3.4', 60);
  assert.strictEqual(count, 7);
  assert.match(calls[0].url, /\/pipeline$/);
  assert.strictEqual(calls[0].auth, 'Bearer tok_abc');
  assert.deepStrictEqual(calls[0].body[0], ['INCR', 'sg:ip:1.2.3.4']);
  assert.deepStrictEqual(calls[0].body[1], ['EXPIRE', 'sg:ip:1.2.3.4', '60', 'NX']);
});

test('createStore picks upstash when env configured, else memory', () => {
  const mem = sec.createStore({}, async () => ({}));
  assert.strictEqual(mem.kind, 'memory');
  const up = sec.createStore({ UPSTASH_REDIS_REST_URL: 'https://x', UPSTASH_REDIS_REST_TOKEN: 't' }, async () => ({}));
  assert.strictEqual(up.kind, 'upstash');
});
