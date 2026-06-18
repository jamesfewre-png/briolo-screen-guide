// Briolo screen-guide backend proxy (Vercel serverless function).
//
// The browser extension calls THIS endpoint instead of Anthropic directly, so
// the ANTHROPIC_API_KEY never leaves the server. The extension authenticates
// with a shared secret (GUIDE_SHARED_SECRET) — an interim guard until Briolo
// user-auth tokens exist. Rotate the secret to revoke access.
//
// Env vars (set in Vercel project settings, never committed):
//   ANTHROPIC_API_KEY   — your Anthropic key (server-side only)
//   GUIDE_SHARED_SECRET — shared secret the extension must send as x-guide-secret

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const FETCH_TIMEOUT_MS = 22000;
const TOKEN_LIKE_RE = /[A-Za-z0-9_\-]{20,}/g;

const GUIDANCE_TOOL = {
  name: 'provide_guidance',
  description: 'Decide the single next action the user should take toward the goal, based on what is actually on screen.',
  input_schema: {
    type: 'object',
    required: ['reasoning', 'message', 'sgId', 'confidence', 'status'],
    properties: {
      reasoning: { type: 'string', description: 'Internal: 1-2 sentences on what you see and why this is the next action.' },
      message: { type: 'string', description: 'What to TELL the user to do next — proactive, specific, friendly. Max 90 chars, plain English, no markdown.' },
      sgId: { type: 'string', description: 'data-sg-id (string) of the element to highlight, or "" if no single element applies.' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      status: { type: 'string', enum: ['guiding', 'wrong-page', 'complete', 'blocked'] }
    }
  }
};

const SYSTEM_PROMPT = `You are a proactive, intelligent on-screen guide for a non-technical user. You can SEE the current browser page (a screenshot is provided) and you also receive its interactive elements as structured data (each with an sgId).

Your job: look at what is ACTUALLY on screen right now, compare it to the GOAL, and decide the SINGLE best next action that moves the user toward the goal. Then point to the element and tell them what to do — like an expert sitting beside them.

Be proactive, not passive:
- Do not follow a fixed checklist. Reason from the live screen toward the goal.
- If the page changed because the user just acted, recognise the progress and give the NEXT action — never repeat an action already done (see recentActions).
- If the user is on the wrong page to make progress, set status "wrong-page" and tell them where to go.
- When the goal is fully achieved on screen, set status "complete" and congratulate briefly.
- If you genuinely cannot find a safe next step, set status "blocked" and say what you need.

Choosing the element:
- Pick the sgId of the ONE element the user should interact with next, matching what you SEE in the screenshot.
- If the next action is to type into a field, point to that field's sgId and tell them what to type (never type or click for them).
- If no single element applies, set sgId "" and explain in the message.

Hard rules (non-negotiable):
- NEVER instruct in a way that assumes you clicked — the human does every click and keystroke.
- NEVER echo credential values (tokens, passwords, API keys) in message or reasoning.
- message must be <= 90 characters, plain English, no markdown, no asterisks.
- Always call provide_guidance exactly once.`;

function sanitize(text) {
  if (typeof text !== 'string') return '';
  return text.replace(TOKEN_LIKE_RE, '').replace(/\s{2,}/g, ' ').trim();
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-guide-secret');
}

async function readBody(req) {
  if (req.body) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'server not configured' }); return; }

  const requiredSecret = process.env.GUIDE_SHARED_SECRET;
  if (requiredSecret) {
    const provided = req.headers['x-guide-secret'];
    if (provided !== requiredSecret) { res.status(401).json({ error: 'unauthorized' }); return; }
  }

  let payload;
  try { payload = await readBody(req); } catch (_) { res.status(400).json({ error: 'bad json' }); return; }

  const { goal, recentActions, elements, screenshotDataUrl, currentUrl } = payload || {};
  if (!goal) { res.status(400).json({ error: 'missing goal' }); return; }

  const userPayload = {
    goal: {
      name: goal.name || '',
      objective: goal.objective || '',
      successCriteria: goal.successCriteria || ''
    },
    currentUrl: currentUrl || '',
    recentActions: (recentActions || []).slice(-6),
    elements: (elements || []).slice(0, 90).map(el => ({
      sgId: String(el.sgId),
      tag: el.tag,
      text: (el.visibleText || el.text || '').slice(0, 100),
      aria: (el.ariaLabel || el.aria || '').slice(0, 80),
      placeholder: (el.placeholder || '').slice(0, 60),
      name: (el.name || '').slice(0, 40)
    }))
  };

  const content = [{ type: 'text', text: JSON.stringify(userPayload) }];
  if (typeof screenshotDataUrl === 'string' && screenshotDataUrl.startsWith('data:image')) {
    const base64 = screenshotDataUrl.split(',')[1];
    if (base64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: [GUIDANCE_TOOL],
        tool_choice: { type: 'tool', name: 'provide_guidance' },
        messages: [{ role: 'user', content }]
      }),
      signal: controller.signal
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text().catch(() => '');
      res.status(502).json({ error: `claude ${apiRes.status}`, detail: errText.slice(0, 200) });
      return;
    }

    const data = await apiRes.json();
    const toolUse = (data.content || []).find(b => b.type === 'tool_use');
    if (!toolUse) { res.status(502).json({ error: 'no tool_use in response' }); return; }
    const input = toolUse.input || {};
    res.status(200).json({
      reasoning: sanitize(input.reasoning),
      message: sanitize(input.message),
      sgId: typeof input.sgId === 'string' ? input.sgId : '',
      confidence: typeof input.confidence === 'number' ? input.confidence : 0,
      status: input.status || 'guiding'
    });
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? 'claude timeout' : (err && err.message) || 'unknown error';
    res.status(502).json({ error: msg });
  } finally {
    clearTimeout(timer);
  }
};
