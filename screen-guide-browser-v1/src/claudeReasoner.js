// Claude Haiku 4.5 element-finder — raw fetch, no SDK, service-worker safe
// Loaded via importScripts() in background.js

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
- If the page URL clearly does not match expectedDomains: status "wrong-page".
- message must be 60 characters or fewer, plain English, no markdown, no asterisks.`;

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

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      tools: [GUIDANCE_TOOL],
      tool_choice: { type: 'tool', name: 'provide_guidance' },
      messages: [{ role: 'user', content: JSON.stringify(payload) }]
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const toolUse = data.content?.find(b => b.type === 'tool_use');
  if (!toolUse) throw new Error('Claude did not call provide_guidance');
  return toolUse.input; // { sgId, confidence, message, status }
}

self.analyzeWithClaude = analyzeWithClaude;
