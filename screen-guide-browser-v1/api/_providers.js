// Provider smoke tests shared by api/verify.js (direct) and the dashboard paste
// endpoint (api/connections/[slug].js). One ephemeral read-only call per provider.
// HARD RULE: tokens are never logged, persisted here, or echoed in errors.
const sec = require('./_security.js');

const FETCH_TIMEOUT_MS = 10000;

async function timedFetch(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: controller.signal }));
  } finally {
    clearTimeout(timer);
  }
}

function cleanDetail(s, fallback) {
  const d = sec.broadenedSanitize(String(s || '')).slice(0, 80);
  return d || fallback;
}
// Map a provider's HTTP rejection to a plain-English, actionable reason the
// panel can show a non-technical owner (critic finding, iteration 2).
// kind classifies WHOSE problem this is, so the extension can react correctly:
//   token_rejected      -> the pasted credential is bad; regenerating helps
//   provider_unreachable -> transient (rate limit / 5xx / network); retry, don't regen
//   integration_broken   -> OUR assumptions about this API are stale (moved/retired
//                           endpoint, unexpected status); regenerating will NOT help,
//                           and it is never the owner's fault
//
// LESSON (found by the health canary on its first real run, 2026-07-08): not
// every provider signals "your credential is bad" via 401/403. Meta and Resend
// both use 400; Chatbase's key lookup throws a raw 500 db error ("no rows
// returned"). Treating status code alone as ground truth misclassified all
// three as integration_broken — the exact "assume the shape instead of reading
// it" bug this taxonomy exists to prevent, one layer up. So: read the body
// before trusting the status code for anything outside the unambiguous cases.
const AUTH_REASON = 'the provider rejected this key — it may be expired, revoked, or missing a character from the copy';

function looksLikeAuthRejection(body) {
  if (!body || typeof body !== 'object') return false;
  const type = String((body.error && body.error.type) || body.type || body.name || '');
  const code = (body.error && body.error.code);
  if (/oauthexception/i.test(type)) return true;        // Meta: OAuthException
  if (code === 190) return true;                          // Meta: invalid/expired access token
  const blob = JSON.stringify(body).toLowerCase();
  if (/validation_error/i.test(type) && /(api key|token)/.test(blob)) return true; // Resend
  if (/(invalid|expired|revoked).{0,20}(api.?key|access.?token|token)/i.test(blob)) return true;
  if (/(\(or no\)|no) rows? (were )?returned|0 rows returned|row.{0,15}not found/i.test(blob)) return true; // Chatbase key-lookup miss: "multiple (or no) rows returned"
  return false;
}

async function failReason(res) {
  if (!res) return { ok: false, kind: 'provider_unreachable', reason: 'could not reach the provider' };
  if (res.status === 401 || res.status === 403) {
    return { ok: false, kind: 'token_rejected', reason: AUTH_REASON };
  }
  if (res.status === 429) {
    return { ok: false, kind: 'provider_unreachable', reason: 'the provider is rate-limiting right now — wait a minute, then try the same token again' };
  }
  // Ambiguous status — read the body before assuming OUR integration is what's
  // broken; some providers only ever signal a bad credential this way.
  let body = null;
  try { body = await res.json(); } catch (_) { /* non-JSON body — fall through */ }
  if (looksLikeAuthRejection(body)) {
    return { ok: false, kind: 'token_rejected', reason: AUTH_REASON };
  }
  if (res.status >= 500) {
    return { ok: false, kind: 'provider_unreachable', reason: 'the provider is having trouble on their end right now — we will try again shortly' };
  }
  return { ok: false, kind: 'integration_broken', reason: 'this connection needs an update on our side — it is not something you did wrong' };
}
// One read-only smoke test per provider. Each returns { ok, detail } or throws.
const PROVIDERS = {
  async meta(token) {
    let r = await timedFetch('https://graph.facebook.com/v21.0/me/accounts?fields=name&access_token=' + encodeURIComponent(token));
    if (r.ok) {
      const j = await r.json();
      const name = j && j.data && j.data[0] && j.data[0].name;
      if (name) return { ok: true, detail: cleanDetail(name, 'your Facebook Page') };
    }
    r = await timedFetch('https://graph.facebook.com/v21.0/me?fields=name&access_token=' + encodeURIComponent(token));
    if (!r.ok) return failReason(r);
    const j = await r.json();
    return { ok: true, detail: cleanDetail(j && j.name, 'your Meta account') };
  },
  async anthropic(token) {
    const r = await timedFetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': token, 'anthropic-version': '2023-06-01' },
    });
    return r.ok ? { ok: true, detail: 'your Claude key (active)' } : failReason(r);
  },
  async openai(token) {
    const r = await timedFetch('https://api.openai.com/v1/models', {
      headers: { Authorization: 'Bearer ' + token },
    });
    return r.ok ? { ok: true, detail: 'your OpenAI key (active)' } : failReason(r);
  },
  async calcom(token) {
    // Cal.com API v1 was retired (returns 410 Gone). Use v2 (Bearer auth);
    // fall back to v1 only if v2 answers with a non-auth error.
    const r = await timedFetch('https://api.cal.com/v2/me', {
      headers: { Authorization: 'Bearer ' + token, 'cal-api-version': '2024-06-14' },
    });
    if (r.ok) {
      const j = await r.json();
      const d = (j && j.data) || {};
      return { ok: true, detail: cleanDetail(d.name || d.username || d.email, 'your Cal.com account') };
    }
    if (r.status === 401 || r.status === 403 || r.status === 429) return failReason(r);
    const r1 = await timedFetch('https://api.cal.com/v1/event-types?apiKey=' + encodeURIComponent(token));
    if (!r1.ok) return failReason(r);
    const j1 = await r1.json();
    const t = j1 && j1.event_types && j1.event_types[0] && j1.event_types[0].title;
    return { ok: true, detail: cleanDetail(t, 'your Cal.com account') };
  },
  async calendly(token) {
    const r = await timedFetch('https://api.calendly.com/users/me', {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!r.ok) return failReason(r);
    const j = await r.json();
    return { ok: true, detail: cleanDetail(j && j.resource && j.resource.name, 'your Calendly account') };
  },
  async 'google-business'(token) {
    const r = await timedFetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!r.ok) return failReason(r);
    const j = await r.json();
    const n = j && j.accounts && j.accounts[0] && j.accounts[0].accountName;
    return { ok: true, detail: cleanDetail(n, 'your Google Business Profile') };
  },
  async resend(token) {
    const r = await timedFetch('https://api.resend.com/domains', {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!r.ok) return failReason(r);
    const j = await r.json();
    const n = j && j.data && j.data[0] && j.data[0].name;
    return { ok: true, detail: cleanDetail(n, 'your Resend account') };
  },
  async chatbase(token) {
    const r = await timedFetch('https://www.chatbase.co/api/v1/get-chatbots', {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!r.ok) return failReason(r);
    const j = await r.json();
    const n = j && j.chatbots && j.chatbots[0] && (j.chatbots[0].chatbotName || j.chatbots[0].name);
    return { ok: true, detail: cleanDetail(n, 'your Chatbase account') };
  },
};


module.exports = { PROVIDERS, timedFetch, cleanDetail, failReason };