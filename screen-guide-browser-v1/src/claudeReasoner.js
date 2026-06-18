// Claude Haiku 4.5 element-finder — raw fetch, no SDK, service-worker safe
// Loaded via importScripts() in background.js
//
// Model id verified 2026-06-18 against the claude-api reference skill
// (shared/models.md "Current Models" table): the canonical current id for
// Claude Haiku 4.5 is `claude-haiku-4-5` (alias; full ID
// `claude-haiku-4-5-20251001`). Status: Active. 200K context, $1/$5 per MTok.
// Keep the alias — Anthropic recommends using aliases over dated full IDs.
const CLAUDE_MODEL = 'claude-haiku-4-5';

// Network/timeout/retry tuning.
const FETCH_TIMEOUT_MS = 10000; // per-attempt AbortController timeout
const MAX_ATTEMPTS = 2;         // total attempts (1 initial + 1 retry)
const BACKOFF_BASE_MS = 500;    // exponential backoff base between attempts

// Matches token-like strings (API keys, access tokens, long opaque IDs).
// Used to scrub any credential the model might echo into the user-facing message.
const TOKEN_LIKE_RE = /[A-Za-z0-9_-]{20,}/g;

const GUIDANCE_TOOL = {
  name: 'provide_guidance',
  description: 'Identify the target page element for this workflow step',
  input_schema: {
    type: 'object',
    required: ['sgId', 'confidence', 'message', 'status'],
    properties: {
      sgId: {
        type: 'string',
        description: 'The sgId of the best matching element as a string, or "" if not found'
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'How confident you are this is the correct target element (0-1)'
      },
      message: {
        type: 'string',
        description: 'User-facing tip — max 60 chars, plain English, no markdown'
      },
      status: {
        type: 'string',
        enum: ['ready', 'unsure', 'wrong-page']
      }
    }
  }
};

const SYSTEM_PROMPT = `You are the AI element-finder for a step-by-step browser workflow guide.

Given a workflow step and a list of visible page elements, call provide_guidance to identify which element the user should interact with next.

Rules:
- Match elements by text or ariaLabel against the step targetText. Prefer exact or close matches.
- NEVER echo credential values (tokens, passwords, API keys) in the message field.
- If found with confidence >= 0.7: set sgId to that element's sgId string, status "ready".
- If confidence < 0.5: set sgId to "", status "unsure", describe what to look for in message.
- Compare the page currentUrl against the step expectedDomains. If currentUrl clearly does not match expectedDomains: status "wrong-page".
- message must be 60 characters or fewer, plain English, no markdown, no asterisks.`;

// Sleep helper — service-worker safe (no Node, no DOM dependency).
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Remove any token-like substring from a free-text field so a credential can
// never leak into the overlay, even if the model echoes one despite the prompt.
function sanitizeMessage(message) {
  if (typeof message !== 'string') return '';
  return message.replace(TOKEN_LIKE_RE, '').replace(/\s{2,}/g, ' ').trim();
}

// Single fetch attempt with a hard AbortController timeout. Returns the parsed
// JSON body. Throws an Error tagged with `.status` (HTTP) or `.network` (true)
// so the caller can decide whether the failure is retryable.
async function attemptFetch(payload, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        tools: [GUIDANCE_TOOL],
        tool_choice: { type: 'tool', name: 'provide_guidance' },
        messages: [{ role: 'user', content: JSON.stringify(payload) }]
      }),
      signal: controller.signal
    });
  } catch (e) {
    // AbortError (timeout) or a transport-level failure — both retryable.
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

// Decide whether a thrown error warrants a retry: network/timeout failures,
// HTTP 429 (rate limit), and HTTP 529 (overloaded).
function isRetryable(err) {
  if (!err) return false;
  if (err.network) return true;
  return err.status === 429 || err.status === 529;
}

async function analyzeWithClaude({ step, elements, currentUrl, apiKey }) {
  const payload = {
    currentUrl: currentUrl || '',
    step: {
      name: step.name,
      instruction: step.instruction,
      targetText: step.targetText || '',
      targetTag: step.targetTag || null,
      expectedDomains: step.expectedDomains || []
    },
    elements: elements.slice(0, 80).map(el => ({
      sgId: String(el.sgId),
      tag: el.tag,
      text: (el.visibleText || '').slice(0, 100),
      aria: (el.ariaLabel || '').slice(0, 80)
    }))
  };

  let lastErr;
  let data;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      data = await attemptFetch(payload, apiKey);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      // Retry only on transient failures, and only if attempts remain.
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
  // Defensive: scrub any credential the model might have echoed into the
  // user-facing message before it can ever reach the overlay.
  return {
    sgId: typeof input.sgId === 'string' ? input.sgId : '',
    confidence: typeof input.confidence === 'number' ? input.confidence : 0,
    message: sanitizeMessage(input.message),
    status: input.status || 'unsure'
  };
}

self.analyzeWithClaude = analyzeWithClaude;
