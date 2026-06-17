const Anthropic = require('@anthropic-ai/sdk');
const { domGuidance } = require('./domGuidance');

const GUIDANCE_TOOL = {
  name: 'provide_guidance',
  description: 'Return the next overlay instruction as structured guidance data',
  input_schema: {
    type: 'object',
    required: ['instruction', 'confidence', 'source', 'overlay', 'status'],
    properties: {
      instruction: { type: 'string', description: 'Short human-readable instruction (max 120 chars)' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      source: { type: 'string', enum: ['level-3-dom-aware', 'dom-aware-low-confidence', 'vision-only', 'fallback'] },
      target: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          selector: { type: 'string' },
          role: { type: 'string' },
          tag: { type: 'string' },
          screenRect: {
            type: 'object',
            properties: {
              x: { type: 'number' }, y: { type: 'number' },
              w: { type: 'number' }, h: { type: 'number' }
            }
          }
        }
      },
      overlay: {
        type: 'object',
        required: ['type', 'message'],
        properties: {
          type: { type: 'string', enum: ['dom-highlight', 'vision-highlight', 'callout', 'message', 'clear'] },
          message: { type: 'string', description: 'Overlay tooltip — max 60 chars, plain words only, no markdown' },
          label: { type: 'string', description: 'Element label — max 40 chars' },
          confidence: { type: 'number' },
          highlight: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } }
          },
          arrow: {
            type: 'object',
            properties: {
              direction: { type: 'string', enum: ['target', 'up', 'down', 'left', 'right'] },
              x: { type: 'number' }, y: { type: 'number' }
            }
          },
          evidence: { type: 'object' }
        }
      },
      status: { type: 'string', enum: ['ready', 'checking', 'unsure', 'complete', 'wrong-page'] }
    }
  }
};

const SYSTEM_PROMPT = `You are the reasoning layer for a human-gated AI desktop overlay guide.

Your job: inspect the structured browser context (and optional screenshot), then call provide_guidance with exactly one instruction.

Rules:
- NEVER automate clicks, bypass permissions, or approve dialogs. The human must do all of that.
- ALWAYS prefer DOM/selector evidence over screenshot guesses when both are available.
- NEVER display credential values (tokens, passwords, API keys) in the overlay message or label. You may highlight where to paste, but never echo what is there.
- If confidence < 0.45: set status to "unsure", write a fallback message, do NOT set highlight or arrow target coordinates.
- Read the URL from the browser address bar in the screenshot. If it matches the completionSignals.urlContains patterns for the current step, set status "complete" immediately.
- If the current URL does not match any expectedDomains for the workflow step: set status to "wrong-page" and tell the user where to navigate.
- Write a short reasoning note (1-2 sentences, internal — not shown in overlay).
- overlay.message must be ≤60 characters, plain English, no markdown, no asterisks. Think tooltip, not paragraph.
- overlay.label must be ≤40 characters.
- Use overlay type "message" for confirmations and status updates.
- When you can identify a target element from the screenshot (no DOM data), use type "vision-highlight" with pixel coordinates in highlight. Set source to "vision-only".
- When DOM data provides a screenRect, use type "dom-highlight". Set source to "level-3-dom-aware".
- Only use type "callout" as a last resort when you cannot determine pixel coordinates at all.
- Never instruct the user to navigate or switch tabs in overlay.message — navigation is handled separately.
- highlight coordinates must be a TIGHT bounding box around the single target element only — do not pad or expand to include neighbouring elements.`;

function trimPageStateForModel(pageState) {
  if (!pageState) return null;
  return {
    url: pageState.url,
    title: pageState.title,
    viewport: pageState.viewport,
    windowMetrics: pageState.windowMetrics,
    scroll: pageState.scroll,
    summaryText: pageState.summaryText,
    elements: (pageState.elements || []).slice(0, 80).map(el => ({
      tag: el.tag, role: el.role, type: el.type, text: el.text,
      selector: el.selector, isClickable: el.isClickable, isInput: el.isInput,
      disabled: el.disabled, screenRect: el.screenRect, evidence: el.evidence
    }))
  };
}

function normalizeGuidance(input, pageStateAgeMs) {
  const confidence = Math.max(0, Math.min(1, Number(input.confidence || 0)));
  return {
    instruction: input.instruction || 'Continue.',
    confidence,
    source: input.source || 'level-3-dom-aware',
    status: input.status || 'ready',
    target: input.target || null,
    overlay: {
      type: input.overlay?.type || 'message',
      message: input.overlay?.message || input.instruction || 'Continue.',
      label: input.overlay?.label || input.instruction || 'Next step',
      confidence,
      evidence: input.overlay?.evidence || {},
      anchor: input.overlay?.anchor || input.target || null,
      highlight: input.overlay?.highlight || input.target?.screenRect || null,
      arrow: input.overlay?.arrow || { direction: 'target', x: 0.5, y: 0.5 },
      freshnessMs: pageStateAgeMs
    }
  };
}

async function analyzeWithClaude({ task, frameDataUrl, pageState, pageStateAgeMs, workflowStep, previousGuidance }) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const userPayload = {
    task,
    workflowStep: workflowStep ? {
      id: workflowStep.id,
      instruction: workflowStep.instruction,
      targetLabels: workflowStep.targetLabels,
      expectedDomains: workflowStep.expectedDomains,
      fallback: workflowStep.fallback
    } : null,
    pageStateAgeMs,
    pageState: trimPageStateForModel(pageState),
    previousGuidance: previousGuidance ? {
      type: previousGuidance.type,
      message: previousGuidance.message,
      confidence: previousGuidance.confidence,
      anchor: previousGuidance.anchor
    } : null
  };

  const content = [{ type: 'text', text: JSON.stringify(userPayload, null, 2) }];
  if (frameDataUrl && frameDataUrl.startsWith('data:image')) {
    const base64 = frameDataUrl.split(',')[1];
    if (base64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } });
  }

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [GUIDANCE_TOOL],
    tool_choice: { type: 'tool', name: 'provide_guidance' },
    messages: [{ role: 'user', content }]
  });

  const toolUse = response.content.find(b => b.type === 'tool_use');
  if (!toolUse) throw new Error('Claude did not call provide_guidance tool');

  return normalizeGuidance(toolUse.input, pageStateAgeMs);
}

async function analyzeFrame(payload) {
  const { task, frameDataUrl, pageState, pageStateAgeMs, workflowStep, previousGuidance } = payload || {};

  if (!process.env.ANTHROPIC_API_KEY) {
    return domGuidance({ task, pageState, pageStateAgeMs, workflowStep });
  }

  try {
    return await analyzeWithClaude({ task, frameDataUrl, pageState, pageStateAgeMs, workflowStep, previousGuidance });
  } catch (err) {
    const fallback = domGuidance({ task, pageState, pageStateAgeMs, workflowStep });
    return { ...fallback, reasoning: `Claude failed, fell back to DOM guidance: ${err.message}`, source: 'dom-aware-claude-fallback' };
  }
}

module.exports = { analyzeFrame, trimPageStateForModel, normalizeGuidance };
