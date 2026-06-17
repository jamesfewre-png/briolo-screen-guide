function clamp01(n) {
  return Math.max(0, Math.min(1, Number(n || 0)));
}

function rectCenter(rect) {
  if (!rect) return null;
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

function isFresh(pageStateAgeMs) {
  return typeof pageStateAgeMs === 'number' && pageStateAgeMs < 2500;
}

function scoreElement(el, keywords) {
  const hay = `${el.text || ''} ${el.role || ''} ${el.tag || ''} ${el.type || ''} ${el.selector || ''}`.toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    if (!kw) continue;
    if (hay.includes(kw.toLowerCase())) score += kw.length > 5 ? 0.22 : 0.12;
  }
  if (el.isClickable) score += 0.16;
  if (el.isInput) score += 0.08;
  if (el.visible) score += 0.14;
  if (el.disabled) score -= 0.35;
  if (el.screenRect && el.screenRect.w > 5 && el.screenRect.h > 5) score += 0.12;
  return clamp01(score);
}

function findBestElement(pageState, keywords) {
  if (!pageState || !Array.isArray(pageState.elements)) return null;
  let best = null;
  for (const el of pageState.elements) {
    const score = scoreElement(el, keywords);
    if (!best || score > best.confidence) {
      best = { element: el, confidence: score };
    }
  }
  return best && best.confidence > 0 ? best : null;
}

function domGuidance({ task, pageState, pageStateAgeMs, workflowStep }) {
  const keywords = workflowStep?.targetLabels ||
    String(task || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3).slice(0, 12);

  const fresh = isFresh(pageStateAgeMs);
  const best = findBestElement(pageState, keywords);
  const target = best?.element || null;
  const targetConfidence = best?.confidence || 0;

  const evidence = {
    url_present: Boolean(pageState?.url),
    dom_present: Boolean(pageState?.elements?.length),
    page_state_fresh: fresh,
    target_text_found: Boolean(target?.text),
    selector_found: Boolean(target?.selector),
    screen_rect_found: Boolean(target?.screenRect),
    clickable: Boolean(target?.isClickable || target?.isInput),
    disabled: Boolean(target?.disabled),
    target_score: Number((targetConfidence).toFixed(2))
  };

  let confidence = 0.15;
  if (evidence.url_present) confidence += 0.12;
  if (evidence.dom_present) confidence += 0.16;
  if (evidence.page_state_fresh) confidence += 0.12;
  if (evidence.target_text_found) confidence += 0.16;
  if (evidence.selector_found) confidence += 0.10;
  if (evidence.screen_rect_found) confidence += 0.18;
  if (evidence.clickable) confidence += 0.08;
  confidence += Math.min(0.18, targetConfidence * 0.18);
  if (evidence.disabled) confidence -= 0.35;
  confidence = clamp01(confidence);

  const instruction = workflowStep?.instruction ||
    (target ? `Click "${target.text || 'the highlighted control'}".` :
      'I need a clearer target. Tell me the exact button or field you want to find.');

  if (!pageState) {
    return {
      instruction: 'Install or enable the browser helper for Level 3 DOM grounding.',
      confidence: 0.18,
      source: 'fallback-no-dom',
      status: 'checking',
      overlay: {
        type: 'message',
        message: 'Waiting for browser helper…',
        confidence: 0.18,
        evidence: { dom_present: false }
      }
    };
  }

  if (!target || confidence < 0.52 || !target.screenRect) {
    const fallback = workflowStep?.fallback || instruction;
    return {
      instruction: fallback,
      confidence,
      source: 'dom-aware-low-confidence',
      status: 'unsure',
      overlay: {
        type: 'callout',
        message: fallback,
        confidence,
        evidence,
        anchor: null,
        arrow: { direction: 'down', x: 0.5, y: 0.78 },
        label: 'Scroll / reveal the next control'
      }
    };
  }

  const c = rectCenter(target.screenRect);
  const screenW = pageState.windowMetrics?.screen?.width || 1920;
  const screenH = pageState.windowMetrics?.screen?.height || 1080;

  return {
    instruction,
    confidence,
    source: 'level-3-dom-aware',
    status: 'ready',
    target: {
      text: target.text, role: target.role, tag: target.tag,
      selector: target.selector, url: pageState.url, screenRect: target.screenRect
    },
    overlay: {
      type: 'dom-highlight',
      message: instruction,
      label: target.text ? `Click: ${target.text.slice(0, 60)}` : 'Click here',
      confidence,
      evidence,
      anchor: {
        strategy: 'dom-selector-and-bounds',
        selector: target.selector, text: target.text, role: target.role,
        rect: target.screenRect, url: pageState.url, freshnessMs: pageStateAgeMs
      },
      highlight: target.screenRect,
      arrow: {
        direction: 'target',
        x: screenW ? c.x / screenW : 0.5,
        y: screenH ? c.y / screenH : 0.5
      }
    }
  };
}

module.exports = { domGuidance, scoreElement, findBestElement, clamp01, isFresh };
