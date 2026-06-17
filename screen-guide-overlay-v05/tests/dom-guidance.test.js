const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scoreElement, findBestElement, domGuidance } = require('../src/ai/domGuidance.js');

const makeEl = (overrides = {}) => ({
  text: '', role: '', tag: 'div', type: '', selector: '',
  isClickable: false, isInput: false, visible: true, disabled: false,
  screenRect: null, ...overrides
});

test('scoreElement gives higher score for keyword match', () => {
  const el = makeEl({ text: 'Business Settings', isClickable: true, visible: true, screenRect: { x: 10, y: 10, w: 150, h: 40 } });
  const score = scoreElement(el, ['business settings']);
  assert.ok(score > 0.5, `expected score > 0.5 but got ${score}`);
});

test('scoreElement penalises disabled elements', () => {
  const el = makeEl({ text: 'Business Settings', isClickable: true, disabled: true });
  const score = scoreElement(el, ['business settings']);
  assert.ok(score < 0.3, `expected score < 0.3 for disabled element but got ${score}`);
});

test('scoreElement returns value between 0 and 1', () => {
  const el = makeEl({ text: 'abc', isClickable: true });
  const score = scoreElement(el, ['abc', 'def', 'ghi']);
  assert.ok(score >= 0 && score <= 1);
});

test('findBestElement returns null for empty elements', () => {
  const result = findBestElement({ elements: [] }, ['business settings']);
  assert.equal(result, null);
});

test('findBestElement returns null when pageState is null', () => {
  assert.equal(findBestElement(null, ['anything']), null);
});

test('findBestElement picks the highest-scoring element', () => {
  const pageState = {
    elements: [
      makeEl({ text: 'Settings', isClickable: true, selector: '#a', screenRect: { x: 10, y: 10, w: 100, h: 30 } }),
      makeEl({ text: 'Business Settings', isClickable: true, selector: '#b', screenRect: { x: 10, y: 50, w: 150, h: 40 } }),
      makeEl({ text: 'Home', isClickable: true, selector: '#c', screenRect: { x: 10, y: 90, w: 80, h: 30 } })
    ]
  };
  const result = findBestElement(pageState, ['business settings']);
  assert.equal(result.element.selector, '#b');
});

test('domGuidance returns fallback when no pageState', () => {
  const result = domGuidance({ task: 'connect Meta', pageState: null, pageStateAgeMs: null });
  assert.equal(result.source, 'fallback-no-dom');
  assert.ok(result.confidence < 0.3);
});

test('domGuidance returns low-confidence callout when target not found', () => {
  const pageState = {
    url: 'https://example.com', elements: [],
    summaryText: 'nothing useful here', scroll: { y: 0 }
  };
  const result = domGuidance({ task: 'find business settings', pageState, pageStateAgeMs: 100 });
  assert.equal(result.status, 'unsure');
  assert.equal(result.overlay.type, 'callout');
});

test('domGuidance returns dom-highlight when target found with screenRect', () => {
  const pageState = {
    url: 'https://business.facebook.com/settings', title: 'Business Settings',
    elements: [makeEl({ text: 'Business Settings', isClickable: true, selector: 'a#bs', screenRect: { x: 120, y: 400, w: 160, h: 40 }, visible: true })],
    scroll: { y: 0 }, windowMetrics: { screen: { width: 1920, height: 1080 } }, summaryText: 'Business Settings'
  };
  const workflowStep = { id: 'open-business-settings', instruction: 'Click Business Settings.', targetLabels: ['Business Settings'], fallback: 'Look in the sidebar.' };
  const result = domGuidance({ task: 'connect Meta', pageState, pageStateAgeMs: 100, workflowStep });
  assert.equal(result.source, 'level-3-dom-aware');
  assert.equal(result.overlay.type, 'dom-highlight');
  assert.ok(result.confidence > 0.7);
  assert.deepEqual(result.overlay.highlight, { x: 120, y: 400, w: 160, h: 40 });
});

test('domGuidance uses workflowStep fallback message when confidence is low', () => {
  const pageState = { url: 'https://business.facebook.com', elements: [], summaryText: '', scroll: { y: 0 } };
  const workflowStep = { targetLabels: ['Business Settings'], fallback: 'Look for Business Settings in the sidebar.' };
  const result = domGuidance({ task: 'connect Meta', pageState, pageStateAgeMs: 100, workflowStep });
  assert.equal(result.instruction, 'Look for Business Settings in the sidebar.');
});
