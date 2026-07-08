// Briolo screen-guide backend proxy (Vercel serverless function).
//
// The browser extension calls THIS endpoint instead of Anthropic directly, so
// the ANTHROPIC_API_KEY never leaves the server.
//
// Security model (see api/_security.js for the testable logic):
//   - Auth:  shared secret (x-guide-secret), compared timing-safely. Interim until
//            per-tenant Briolo auth lands — verifyAuth() is the seam to swap it.
//   - CORS:  no wildcard; only chrome-extension:// origins and GUIDE_ALLOWED_ORIGINS.
//   - Rate:  per-install + per-IP windows AND a hard global daily ceiling that caps
//            worst-case spend even if the secret leaks. Uses Upstash if configured,
//            else best-effort in-memory.
//
// Env vars (set in Vercel project settings, never committed):
//   ANTHROPIC_API_KEY        — your Anthropic key (server-side only)
//   GUIDE_SHARED_SECRET      — shared secret the extension must send as x-guide-secret
//   GUIDE_ALLOWED_ORIGINS    — optional, comma-separated extra allowed Origins
//   UPSTASH_REDIS_REST_URL   — optional, enables durable cross-instance rate limiting
//   UPSTASH_REDIS_REST_TOKEN — optional, paired with the URL above
//   GUIDE_MAX_DAILY          — optional, overrides the global daily request ceiling

const sec = require('./_security.js');

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const FETCH_TIMEOUT_MS = 22000;

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
      targetText: { type: 'string', description: 'The exact visible label of the element to highlight, e.g. "Generate token". Used to locate the element if the id is stale. "" if no single element applies.' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      status: { type: 'string', enum: ['guiding', 'wrong-page', 'complete', 'blocked'] },
      tokenRevealed: { type: 'boolean', description: 'true ONLY when the credential/token/key the goal is working toward is visible on screen right now (even partially masked).' }
    }
  }
};

// Triage: business description -> proposed connection plan (mode: 'triage').
const TRIAGE_TOOL = {
  name: 'propose_plan',
  description: 'Propose which connection guides this business owner needs, in the order they should run.',
  input_schema: {
    type: 'object',
    required: ['connections'],
    properties: {
      connections: {
        type: 'array',
        items: {
          type: 'object',
          required: ['workflowId', 'reason'],
          properties: {
            workflowId: { type: 'string', description: 'The id of a guide from the provided library. NEVER invent an id.' },
            reason: { type: 'string', description: 'One plain-English sentence, max 100 chars, tying this connection to what THEY said.' }
          }
        }
      }
    }
  }
};

const TRIAGE_PROMPT = `You are planning which platform connections a non-technical small-business owner needs so a robot can take over ONE repetitive job they described. You are given their business description, the job they want automated, and a library of available connection guides (each with an id, name, objective, and the automation patterns it serves).

Rules:
- Choose ONLY from the provided library ids. Never invent a connection.
- Include a guide only if THIS owner's described job actually needs it. Fewer, correct connections beat more.
- An AI/LLM key guide (if present) is almost always needed - it is the brain that writes replies and content.
- Order: put the connection most central to their described job first; the AI key second; supporting connections after.
- Each reason must reference what THEY said, in plain English a tradesperson would nod along to. No jargon.
- Call propose_plan exactly once.`;

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
- ALSO set targetText to that element's exact visible label (e.g. "Generate token", "System users") so it can be located even if the id is stale. Almost every guiding step has a clickable target — set both sgId and targetText whenever you reference a button, link, tab, or field.
- If the next action is to type into a field, point to that field's sgId/targetText and tell them what to type (never type or click for them).
- Only if NO single element applies (pure navigation away from this page, or reading) set sgId "" and targetText "".

Hard rules (non-negotiable):
- NEVER instruct in a way that assumes you clicked — the human does every click and keystroke.
- NEVER echo credential values (tokens, passwords, API keys) in message or reasoning.
- message must be <= 90 characters, plain English, no markdown, no asterisks.
- The moment the credential/token/key the goal seeks is visible on screen (even partially masked), set tokenRevealed true AND status "complete" — the panel takes over from there.
- Always call provide_guidance exactly once.`;

function setCorsHeaders(res, allowOrigin) {
  // Only emit ACAO when the origin is permitted; never wildcard.
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-guide-secret, x-guide-install');
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
  const env = process.env;
  const allowedOrigins = sec.parseAllowedOrigins(env);
  const allowOrigin = sec.resolveCorsOrigin(req.headers.origin, allowedOrigins);
  setCorsHeaders(res, allowOrigin);

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'server not configured' }); return; }

  // 1) Authenticate (timing-safe) and derive a rate-limit identity.
  const auth = sec.verifyAuth(req, env);
  if (!auth.ok) { res.status(401).json({ error: 'unauthorized' }); return; }

  // 2) Rate limit: per-install, per-IP, and a hard global daily ceiling.
  const store = sec.createStore(env, typeof fetch === 'function' ? fetch : null);
  const dayKey = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
  const limits = {};
  if (env.GUIDE_MAX_DAILY) {
    const max = parseInt(env.GUIDE_MAX_DAILY, 10);
    if (Number.isFinite(max) && max > 0) limits.global = { max, windowSec: 86400 };
  }
  const rl = await sec.checkRateLimit(store, {
    dayKey,
    installId: auth.identity,
    ip: sec.getClientIp(req),
  }, limits);
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfter || 60));
    res.status(429).json({ error: 'rate limited', scope: rl.scope });
    return;
  }

  let payload;
  try { payload = await readBody(req); } catch (_) { res.status(400).json({ error: 'bad json' }); return; }

  // ── Triage mode: business description -> proposed connection plan ────────────
  if (payload && payload.mode === 'triage') {
    const triagePayload = {
      business: String(payload.business || '').slice(0, 600),
      job: String(payload.job || '').slice(0, 600),
      library: (Array.isArray(payload.library) ? payload.library : []).slice(0, 30).map(g => ({
        id: String(g.id || ''), name: String(g.name || '').slice(0, 80),
        objective: String(g.objective || '').slice(0, 200),
        patterns: Array.isArray(g.patterns) ? g.patterns.slice(0, 10) : [],
      })),
    };
    if (!triagePayload.library.length) { res.status(400).json({ error: 'missing library' }); return; }
    const tController = new AbortController();
    const tTimer = setTimeout(() => tController.abort(), FETCH_TIMEOUT_MS);
    try {
      const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 1024,
          system: TRIAGE_PROMPT,
          tools: [TRIAGE_TOOL],
          tool_choice: { type: 'tool', name: 'propose_plan' },
          messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(triagePayload) }] }],
        }),
        signal: tController.signal,
      });
      if (!apiRes.ok) {
        const errText = await apiRes.text().catch(() => '');
        res.status(502).json({ error: `claude ${apiRes.status}`, detail: errText.slice(0, 200) });
        return;
      }
      const data = await apiRes.json();
      const toolUse = (data.content || []).find(b => b.type === 'tool_use');
      const conns = (toolUse && toolUse.input && toolUse.input.connections) || [];
      res.status(200).json({
        connections: conns
          .filter(c => c && typeof c.workflowId === 'string')
          .map(c => ({ workflowId: c.workflowId, reason: sec.broadenedSanitize(String(c.reason || '')).slice(0, 140) })),
      });
    } catch (err) {
      const msg = err && err.name === 'AbortError' ? 'claude timeout' : (err && err.message) || 'unknown error';
      res.status(502).json({ error: msg });
    } finally {
      clearTimeout(tTimer);
    }
    return;
  }

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
    // COST: the DOM payload was 66% of every call's input tokens (90 els x 100
    // chars ~= 5,550 tok). 40 x 60 roughly halves it with negligible guidance
    // loss — Claude also sees the screenshot, and the ring targets by sgId.
    elements: (elements || []).slice(0, 40).map(el => ({
      sgId: String(el.sgId),
      tag: el.tag,
      text: (el.visibleText || el.text || '').slice(0, 60),
      aria: (el.ariaLabel || el.aria || '').slice(0, 50),
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
        // Prompt caching: the system prompt and tool schema are identical on
        // every call. Marking them cacheable makes cache hits ~90% cheaper.
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: [Object.assign({}, GUIDANCE_TOOL, { cache_control: { type: 'ephemeral' } })],
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
      reasoning: sec.broadenedSanitize(input.reasoning),
      message: sec.broadenedSanitize(input.message),
      sgId: typeof input.sgId === 'string' ? input.sgId : '',
      targetText: typeof input.targetText === 'string' ? sec.broadenedSanitize(input.targetText) : '',
      confidence: typeof input.confidence === 'number' ? input.confidence : 0,
      status: input.status || 'guiding',
      tokenRevealed: input.tokenRevealed === true
    });
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? 'claude timeout' : (err && err.message) || 'unknown error';
    res.status(502).json({ error: msg });
  } finally {
    clearTimeout(timer);
  }
};
