// Proactive vision reasoner — Claude SEES the live page (screenshot + DOM) and
// decides the next action toward a GOAL. No hardcoded step script.
// Loaded via importScripts() in background.js (service-worker safe: raw fetch).
//
// Model: claude-sonnet-4-6 — vision-capable, strong reasoning, sensible cost for
// per-change guidance. Verified against the claude-api reference skill.
const CLAUDE_MODEL = 'claude-sonnet-4-6';

// Network/timeout/retry tuning.
const FETCH_TIMEOUT_MS = 20000; // vision calls are heavier — allow more time
const MAX_ATTEMPTS = 2;
const BACKOFF_BASE_MS = 600;

// Strip credential-like runs from any free text the model returns.
const TOKEN_LIKE_RE = /[A-Za-z0-9_\-]{20,}/g;

const GUIDANCE_TOOL = {
  name: 'provide_guidance',
  description: 'Decide the single next action the user should take toward the goal, based on what is actually on screen.',
  input_schema: {
    type: 'object',
    required: ['reasoning', 'message', 'sgId', 'confidence', 'status'],
    properties: {
      reasoning: {
        type: 'string',
        description: 'Internal: 1-2 sentences on what you see and why this is the next action. Not shown verbatim to the user.'
      },
      message: {
        type: 'string',
        description: 'What to TELL the user to do next — proactive, specific, friendly. Max 90 chars. Plain English, no markdown. e.g. "Click Business settings in the left menu to manage your assets."'
      },
      sgId: {
        type: 'string',
        description: 'The data-sg-id (as a string) of the element to highlight for this action, or "" if no single element applies (e.g. the user must navigate or type).'
      },
      targetText: {
        type: 'string',
        description: 'The exact visible label of the element to highlight, e.g. "Generate token". Used to locate the element if the id is stale. "" if no single element applies.'
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'How sure you are this is the correct next action.'
      },
      status: {
        type: 'string',
        enum: ['guiding', 'wrong-page', 'complete', 'blocked'],
        description: 'guiding = normal next step; wrong-page = user must navigate elsewhere first; complete = the goal is achieved; blocked = cannot determine a safe next step.'
      }
    }
  }
};

const SYSTEM_PROMPT = `You are a proactive, intelligent on-screen guide for a non-technical user. You can SEE the current browser page (a screenshot is provided) and you also receive its interactive elements as structured data (each with an sgId).

Your job: look at what is ACTUALLY on screen right now, compare it to the GOAL, and decide the SINGLE best next action that moves the user toward the goal. Then point to the element and tell them what to do — like an expert sitting beside them.

Be proactive, not passive:
- Do not follow a fixed checklist. Reason from the live screen toward the goal.
- If the page changed because the user just acted, recognise the progress and give the NEXT action — never repeat an action already done (see recentActions).
- If the user is on the wrong page to make progress, set status "wrong-page" and tell them where to go (the control panel handles navigation — describe it, do not try to click it).
- When the goal is fully achieved on screen, set status "complete" and congratulate briefly.
- If you genuinely cannot find a safe next step, set status "blocked" and say what you need.

Choosing the element:
- Pick the sgId of the ONE element the user should interact with next. Match it to what you SEE in the screenshot, using the elements list to get its sgId.
- ALSO set targetText to that element's exact visible label (e.g. "Generate token", "System users") so it can be located even if the id is stale. Set both sgId and targetText whenever you reference a button, link, tab, or field.
- If the next action is to type into a field, point to that field's sgId/targetText and tell them what to type (never type or click for them).
- If no single element applies (e.g. they must scroll, navigate, or read), set sgId "" and explain in the message.

Hard rules (non-negotiable):
- NEVER instruct in a way that assumes you clicked — the human does every click and keystroke. You only point and explain.
- NEVER echo credential values (tokens, passwords, API keys) in message or reasoning. You may say "copy the token shown" but never repeat its characters.
- message must be <= 90 characters, plain English, no markdown, no asterisks.
- Always call provide_guidance exactly once.`;

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function sanitize(text) {
  if (typeof text !== 'string') return '';
  return text.replace(TOKEN_LIKE_RE, '').replace(/\s{2,}/g, ' ').trim();
}

async function attemptFetch(body, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        // Required to call the API from a browser/extension origin — without this
        // Anthropic's CORS policy rejects the request. (Node/CLI doesn't need it.)
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (e) {
    const err = new Error(
      e && e.name === 'AbortError'
        ? `Claude request timed out after ${FETCH_TIMEOUT_MS}ms`
        : `Claude network error: ${(e && e.message) || 'unknown'}`
    );
    err.network = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err = new Error(`Claude API ${res.status}: ${errText.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function isRetryable(err) {
  if (!err) return false;
  if (err.network) return true;
  return err.status === 429 || err.status === 529;
}

// PRODUCTION path: call the Briolo backend proxy instead of Anthropic directly.
// The proxy holds the real API key server-side; the extension only carries a
// shared secret. Returns the same { reasoning, message, sgId, confidence, status }.
async function analyzeViaProxy({ goal, recentActions, elements, screenshotDataUrl, currentUrl, proxyUrl, proxySecret }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (proxySecret) headers['x-guide-secret'] = proxySecret;
    res = await fetch(proxyUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ goal, recentActions, elements, screenshotDataUrl, currentUrl }),
      signal: controller.signal
    });
  } catch (e) {
    const err = new Error(e && e.name === 'AbortError' ? `Proxy timed out after ${FETCH_TIMEOUT_MS}ms` : `Proxy network error: ${(e && e.message) || 'unknown'}`);
    err.network = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const err = new Error(`Proxy ${res.status}: ${errText.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const input = await res.json();
  return {
    reasoning: sanitize(input.reasoning),
    message: sanitize(input.message),
    sgId: typeof input.sgId === 'string' ? input.sgId : '',
    targetText: typeof input.targetText === 'string' ? sanitize(input.targetText) : '',
    confidence: typeof input.confidence === 'number' ? input.confidence : 0,
    status: input.status || 'guiding'
  };
}

// goal: { name, objective, successCriteria }
// recentActions: array of recent message strings already given
// elements: [{ sgId, tag, visibleText, ariaLabel, placeholder, name }]
// screenshotDataUrl: "data:image/jpeg;base64,..." (optional but strongly preferred)
// proxyUrl/proxySecret: if set, route through the Briolo backend (key stays server-side)
async function analyzeWithClaude({ goal, recentActions, elements, screenshotDataUrl, currentUrl, apiKey, proxyUrl, proxySecret }) {
  // Production: proxy mode — no API key in the browser.
  if (proxyUrl) {
    return analyzeViaProxy({ goal, recentActions, elements, screenshotDataUrl, currentUrl, proxyUrl, proxySecret });
  }
  // Dev fallback: direct call to Anthropic (requires apiKey in the extension).
  const payload = {
    goal: {
      name: goal?.name || '',
      objective: goal?.objective || '',
      successCriteria: goal?.successCriteria || ''
    },
    currentUrl: currentUrl || '',
    recentActions: (recentActions || []).slice(-6),
    elements: (elements || []).slice(0, 90).map(el => ({
      sgId: String(el.sgId),
      tag: el.tag,
      text: (el.visibleText || '').slice(0, 100),
      aria: (el.ariaLabel || '').slice(0, 80),
      placeholder: (el.placeholder || '').slice(0, 60),
      name: (el.name || '').slice(0, 40)
    }))
  };

  const content = [{ type: 'text', text: JSON.stringify(payload) }];
  if (screenshotDataUrl && screenshotDataUrl.startsWith('data:image')) {
    const base64 = screenshotDataUrl.split(',')[1];
    if (base64) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: base64 }
      });
    }
  }

  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [GUIDANCE_TOOL],
    tool_choice: { type: 'tool', name: 'provide_guidance' },
    messages: [{ role: 'user', content }]
  };

  let data, lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      data = await attemptFetch(body, apiKey);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_ATTEMPTS && isRetryable(e)) {
        await delay(BACKOFF_BASE_MS * Math.pow(2, attempt - 1));
        continue;
      }
      throw e;
    }
  }
  if (lastErr) throw lastErr;

  const toolUse = data.content?.find(b => b.type === 'tool_use');
  if (!toolUse) throw new Error('Claude did not call provide_guidance');
  const input = toolUse.input || {};
  return {
    reasoning: sanitize(input.reasoning),
    message: sanitize(input.message),
    sgId: typeof input.sgId === 'string' ? input.sgId : '',
    targetText: typeof input.targetText === 'string' ? sanitize(input.targetText) : '',
    confidence: typeof input.confidence === 'number' ? input.confidence : 0,
    status: input.status || 'guiding'
  };
}

self.analyzeWithClaude = analyzeWithClaude;
