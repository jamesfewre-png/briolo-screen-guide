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
    if (!r.ok) return { ok: false };
    const j = await r.json();
    return { ok: true, detail: cleanDetail(j && j.name, 'your Meta account') };
  },
  async anthropic(token) {
    const r = await timedFetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': token, 'anthropic-version': '2023-06-01' },
    });
    return r.ok ? { ok: true, detail: 'your Claude key (active)' } : { ok: false };
  },
  async openai(token) {
    const r = await timedFetch('https://api.openai.com/v1/models', {
      headers: { Authorization: 'Bearer ' + token },
    });
    return r.ok ? { ok: true, detail: 'your OpenAI key (active)' } : { ok: false };
  },
  async calcom(token) {
    const r = await timedFetch('https://api.cal.com/v1/event-types?apiKey=' + encodeURIComponent(token));
    if (!r.ok) return { ok: false };
    const j = await r.json();
    const t = j && j.event_types && j.event_types[0] && j.event_types[0].title;
    return { ok: true, detail: cleanDetail(t, 'your Cal.com account') };
  },
  async calendly(token) {
    const r = await timedFetch('https://api.calendly.com/users/me', {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!r.ok) return { ok: false };
    const j = await r.json();
    return { ok: true, detail: cleanDetail(j && j.resource && j.resource.name, 'your Calendly account') };
  },
  async 'google-business'(token) {
    const r = await timedFetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!r.ok) return { ok: false };
    const j = await r.json();
    const n = j && j.accounts && j.accounts[0] && j.accounts[0].accountName;
    return { ok: true, detail: cleanDetail(n, 'your Google Business Profile') };
  },
  async resend(token) {
    const r = await timedFetch('https://api.resend.com/domains', {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!r.ok) return { ok: false };
    const j = await r.json();
    const n = j && j.data && j.data[0] && j.data[0].name;
    return { ok: true, detail: cleanDetail(n, 'your Resend account') };
  },
  async chatbase(token) {
    const r = await timedFetch('https://www.chatbase.co/api/v1/get-chatbots', {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!r.ok) return { ok: false };
    const j = await r.json();
    const n = j && j.chatbots && j.chatbots[0] && (j.chatbots[0].chatbotName || j.chatbots[0].name);
    return { ok: true, detail: cleanDetail(n, 'your Chatbase account') };
  },
};


module.exports = { PROVIDERS, timedFetch, cleanDetail };