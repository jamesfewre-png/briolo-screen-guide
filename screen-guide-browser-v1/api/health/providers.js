// GET /api/health/providers — liveness canary for every provider integration.
//
// THE INSIGHT: a deliberately fake token is a free liveness probe. Fire one at
// each provider and check HOW it fails:
//   401/403 (token_rejected)       -> endpoint alive, auth working -> HEALTHY
//   404/410/anything else          -> our integration has rotted   -> UNHEALTHY
//   timeout/5xx (provider_unreachable) -> provider outage, not our bug -> skip
// This turns "a tradie discovers it in a paid room" into "a cron catches it
// overnight" — the whole point of this endpoint (spec: root-cause fix for
// AI Consult not staying current with API versions / page workflows).
//
// Triggered by Vercel Cron (sends Authorization: Bearer $CRON_SECRET automatically
// when that env var is set) or manually via x-guide-secret (same auth as the rest
// of the API). No real credentials are ever used — every token below is fake.
const sec = require('../_security.js');
const { PROVIDERS } = require('../_providers.js');

const FAKE_TOKENS = {
  meta: 'CANARY_FAKE_META_TOKEN_0000000000000',
  anthropic: 'sk-ant-canary-fake-000000000000000000',
  openai: 'sk-canary-fake-0000000000000000000000',
  calcom: 'cal_canary_fake_00000000000000000000',
  calendly: 'canary_fake_calendly_token_0000000000',
  'google-business': 'canary.fake.google.business.token.0000',
  resend: 're_canary_fake_00000000000000000000',
  chatbase: 'canary_fake_chatbase_token_00000000',
};

function cronAuthorized(req, env) {
  if (env.CRON_SECRET) {
    const hdr = String(req.headers.authorization || '');
    return hdr === 'Bearer ' + env.CRON_SECRET;
  }
  return false;
}

// Alerts use GUIDE_ALERT_FROM, deliberately SEPARATE from GUIDE_MAIL_FROM:
// configuring operator alerts must never arm the attendee sign-in email path
// (see api/auth.js). Prefer a verified sending domain — Resend's shared
// onboarding@resend.dev sender only ever reaches the account owner.
// Returns a result object so a self-test can prove the path actually works;
// the cron path still treats failure as non-fatal.
async function alertIfUnhealthy(env, unhealthy) {
  if (!unhealthy.length) return { attempted: false, reason: 'nothing to report' };
  if (!env.RESEND_API_KEY || !env.GUIDE_ALERT_EMAIL) {
    return { attempted: false, reason: 'RESEND_API_KEY or GUIDE_ALERT_EMAIL not configured' };
  }
  const from = env.GUIDE_ALERT_FROM || env.GUIDE_MAIL_FROM || 'onboarding@resend.dev';
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from,
        to: env.GUIDE_ALERT_EMAIL,
        subject: '⚠️ AI Consult: ' + unhealthy.length + ' connection(s) need attention',
        html: '<p>The provider liveness canary found integrations that no longer behave as expected:</p><ul>' +
          unhealthy.map(u => '<li><b>' + u.provider + '</b>: ' + u.reason + '</li>').join('') +
          '</ul><p>These are api/_providers.js smoke tests responding in an unexpected way — likely an API version bump or a moved endpoint. Fix before the next cohort.</p>',
      }),
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      return { attempted: true, sent: false, from, status: r.status, error: detail.slice(0, 200) };
    }
    const body = await r.json().catch(() => ({}));
    return { attempted: true, sent: true, from, to: env.GUIDE_ALERT_EMAIL, id: body.id || null };
  } catch (err) {
    return { attempted: true, sent: false, from, error: (err && err.message) || 'send threw' };
  }
}

module.exports = async function handler(req, res) {
  const env = process.env;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.status(405).json({ error: 'method not allowed' }); return; }

  const auth = sec.verifyAuth(req, env);
  if (!cronAuthorized(req, env) && !(auth.ok && req.headers['x-guide-secret'])) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const results = await Promise.allSettled(
    Object.entries(FAKE_TOKENS).map(async ([provider, token]) => {
      const fn = PROVIDERS[provider];
      if (!fn) return { provider, healthy: false, kind: 'unknown_provider', reason: 'no smoke test registered' };
      try {
        const outcome = await fn(token);
        if (outcome && outcome.ok) {
          // A FAKE token must never pass. If it did, our validation call itself
          // is broken (e.g. hitting an endpoint that doesn't actually check auth).
          return { provider, healthy: false, kind: 'unexpected_success', reason: 'a deliberately invalid token was accepted — the smoke test is not actually validating' };
        }
        const healthy = outcome && outcome.kind === 'token_rejected';
        return { provider, healthy, kind: (outcome && outcome.kind) || 'unknown', reason: (outcome && outcome.reason) || 'unknown failure' };
      } catch (err) {
        // A real network failure during the canary itself — treat as inconclusive,
        // not unhealthy, so a flaky network doesn't page anyone for nothing.
        return { provider, healthy: null, kind: 'canary_error', reason: (err && err.message) || 'canary probe threw' };
      }
    })
  );

  const report = results.map(r => r.value || { provider: 'unknown', healthy: null, kind: 'canary_error', reason: 'settle failed' });
  const unhealthy = report.filter(r => r.healthy === false);
  const overallHealthy = unhealthy.length === 0;

  // ?selftest=1 — prove the alerting path end to end without waiting for a real
  // outage. Drives the SAME alertIfUnhealthy() the cron uses, with a synthetic
  // finding, and reports exactly what Resend said. Auth-gated like everything here.
  const selftest = req.query && (req.query.selftest === '1' || req.query.selftest === 'true');
  const toAlert = selftest
    ? [{ provider: 'canary-selftest', reason: 'synthetic finding — this is a TEST of the alert path, no integration is actually broken' }]
    : unhealthy;

  const alert = await alertIfUnhealthy(env, toAlert);

  res.status(selftest ? 200 : (overallHealthy ? 200 : 503)).json({
    healthy: overallHealthy,
    selftest: selftest || undefined,
    checkedAt: new Date().toISOString(),
    alert,
    providers: report,
  });
};