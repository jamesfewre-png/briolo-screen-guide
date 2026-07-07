// Security helpers for the Screen Guide proxy.
//
// This file is underscore-prefixed so Vercel does NOT route it as a serverless
// endpoint — it is a pure helper module imported by api/analyze.js. Keeping the
// logic here (a) makes it unit-testable without spinning up the function and
// (b) keeps analyze.js focused on request/response wiring.
//
// Nothing here performs I/O except the Upstash store, which is injected with a
// fetch implementation so tests can stub it.

const crypto = require('crypto');

// ── Credential scrubbing (defense-in-depth on any free text we echo back) ──────
// Broader than the old single 20+ char rule: also catches JWTs (dot-separated
// base64url segments) and long hex digests (session ids, HMACs).
const JWT_G = /[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g;
const TOKEN_G = /[A-Za-z0-9_\-]{20,}/g;
const HEX_G = /\b[0-9a-fA-F]{16,}\b/g;

function broadenedSanitize(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(JWT_G, '')
    .replace(TOKEN_G, '')
    .replace(HEX_G, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ── Timing-safe secret comparison ──────────────────────────────────────────────
// Hash both sides to a fixed length first, so neither the secret's length nor a
// per-character early-exit leaks via response timing.
function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ── CORS ────────────────────────────────────────────────────────────────────────
// No wildcard. Reflect the request Origin only if it is a Chrome extension or in
// the configured allow-list. A request with no Origin header (the extension's
// privileged service-worker fetch, or any non-browser client) gets no ACAO header
// and is unaffected — CORS only constrains browser JS, so this closes the
// website-based abuse vector without breaking the extension.
function parseAllowedOrigins(env) {
  return String((env && env.GUIDE_ALLOWED_ORIGINS) || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function resolveCorsOrigin(origin, allowedList) {
  if (!origin) return null;
  if (origin.startsWith('chrome-extension://')) return origin;
  if (Array.isArray(allowedList) && allowedList.includes(origin)) return origin;
  return null;
}

// ── Client IP (Vercel sets x-forwarded-for) ────────────────────────────────────
function getClientIp(req) {
  const xff = req && req.headers && req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  const xr = req && req.headers && req.headers['x-real-ip'];
  return xr ? String(xr).trim() : '';
}

// ── Rate-limit stores ───────────────────────────────────────────────────────────
// Both expose: async incr(key, ttlSec) -> current count for the window.
// Fixed-window counter: INCR, and set TTL only when the key is first created.

function memoryStore() {
  const m = new Map(); // key -> { count, expiresAt }
  return {
    kind: 'memory',
    async incr(key, ttlSec, nowMs) {
      const now = typeof nowMs === 'number' ? nowMs : Date.now();
      let e = m.get(key);
      if (!e || e.expiresAt <= now) {
        e = { count: 0, expiresAt: now + ttlSec * 1000 };
        m.set(key, e);
      }
      e.count += 1;
      if (m.size > 5000) { // opportunistic cleanup
        for (const [k, v] of m) if (v.expiresAt <= now) m.delete(k);
      }
      return e.count;
    },
  };
}

function upstashStore(url, token, fetchImpl) {
  const base = String(url).replace(/\/$/, '');
  const f = fetchImpl;
  return {
    kind: 'upstash',
    async incr(key, ttlSec) {
      // One round-trip: INCR then EXPIRE-if-not-set (NX keeps the window fixed).
      const res = await f(base + '/pipeline', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify([['INCR', key], ['EXPIRE', key, String(ttlSec), 'NX']]),
      });
      if (!res.ok) throw new Error('upstash ' + res.status);
      const data = await res.json(); // [{result:n}, {result:0|1}]
      return Number(data && data[0] && data[0].result);
    },
  };
}

function createStore(env, fetchImpl) {
  const url = env && env.UPSTASH_REDIS_REST_URL;
  const token = env && env.UPSTASH_REDIS_REST_TOKEN;
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (url && token && f) return upstashStore(url, token, f);
  return memoryStore();
}

// ── Rate-limit decision ─────────────────────────────────────────────────────────
// Three buckets, checked cheapest-blast-radius last:
//   global  — a hard daily ceiling (circuit breaker). Even if the shared secret
//             leaks and someone scripts the endpoint, total spend is bounded to a
//             known number of calls/day. THIS is the real protection against a
//             surprise Anthropic bill.
//   install — per extension install (x-guide-install header).
//   ip      — per client IP.
// Store errors fail OPEN per-bucket (never break guidance for a paying user), but
// the global ceiling still applies via whichever store is up.
const DEFAULT_LIMITS = {
  perInstall: { max: 40, windowSec: 60 },
  perIp: { max: 80, windowSec: 60 },
  global: { max: 5000, windowSec: 86400 },
};

async function checkRateLimit(store, opts, limits) {
  const L = Object.assign({}, DEFAULT_LIMITS, limits || {});
  const buckets = [
    { key: 'sg:global:' + (opts.dayKey || 'na'), max: L.global.max, windowSec: L.global.windowSec, scope: 'global' },
  ];
  if (opts.installId) buckets.push({ key: 'sg:inst:' + opts.installId, max: L.perInstall.max, windowSec: L.perInstall.windowSec, scope: 'install' });
  if (opts.ip) buckets.push({ key: 'sg:ip:' + opts.ip, max: L.perIp.max, windowSec: L.perIp.windowSec, scope: 'ip' });

  for (const b of buckets) {
    let count;
    try {
      count = await store.incr(b.key, b.windowSec, opts.nowMs);
    } catch (_) {
      continue; // store unavailable — fail open for this bucket
    }
    if (typeof count === 'number' && count > b.max) {
      return { allowed: false, scope: b.scope, retryAfter: b.windowSec, limit: b.max };
    }
  }
  return { allowed: true };
}

// ── Auth seam ───────────────────────────────────────────────────────────────────
// Today: a single shared secret (interim). Returns an identity used only for
// rate-limit bucketing — the install id if present, else 'shared'.
// FUTURE: when Briolo user-auth exists, validate a per-tenant token here and
// return the tenant/user id. That is the one place that changes.
function verifyAuth(req, env) {
  const requiredSecret = env && env.GUIDE_SHARED_SECRET;
  const installId = req && req.headers && req.headers['x-guide-install'];
  const cleanInstall = typeof installId === 'string' ? installId.slice(0, 64) : '';
  if (!requiredSecret) {
    return { ok: true, identity: cleanInstall || 'anon' }; // dev / unconfigured
  }
  const provided = req && req.headers && req.headers['x-guide-secret'];
  if (!timingSafeEqualStr(String(provided || ''), String(requiredSecret))) {
    return { ok: false };
  }
  return { ok: true, identity: cleanInstall || 'shared' };
}

module.exports = {
  broadenedSanitize,
  timingSafeEqualStr,
  parseAllowedOrigins,
  resolveCorsOrigin,
  getClientIp,
  memoryStore,
  upstashStore,
  createStore,
  checkRateLimit,
  verifyAuth,
  DEFAULT_LIMITS,
};
