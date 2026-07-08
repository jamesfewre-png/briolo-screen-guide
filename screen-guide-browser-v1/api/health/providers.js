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

async function alertIfUnhealthy(env, unhealthy) {
  if (!unhealthy.length || !env.RESEND_API_KEY || !env.GUIDE_ALERT_EMAIL) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.GUIDE_MAIL_FROM || 'onboarding@resend.dev',
        to: env.GUIDE_ALERT_EMAIL,
        subject: '⚠️ AI Consult: ' + unhealthy.length + ' connection(s) need attention',
        html: '<p>The provider liveness canary found integrations that no longer behave as expected:</p><ul>' +
          unhealthy.map(u => '<li><b>' + u.provider + '</b>: ' + u.reason + '</li>').join('') +
          '</ul><p>These are api/_providers.js smoke tests responding in an unexpected way — likely an API version bump or a moved endpoint. Fix before the next cohort.</p>',
      }),
    });
  } catch (_) { /* best-effort — the JSON response is the source of truth either way */ }
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

  await alertIfUnhealthy(env, unhealthy);

  res.status(overallHealthy ? 200 : 503).json({
    healthy: overallHealthy,
    checkedAt: new Date().toISOString(),
    providers: report,
  });
};