const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizePageState, normalizeRect } = require('../src/main.js');

test('normalizeRect returns null for missing input', () => {
  assert.equal(normalizeRect(null), null);
  assert.equal(normalizeRect(undefined), null);
  assert.equal(normalizeRect('bad'), null);
});

test('normalizeRect handles w/h aliases', () => {
  const r = normalizeRect({ x: 10, y: 20, width: 100, height: 50 });
  assert.deepEqual(r, { x: 10, y: 20, w: 100, h: 50 });
});

test('normalizeRect handles w/h directly', () => {
  const r = normalizeRect({ x: 5, y: 5, w: 200, h: 40 });
  assert.deepEqual(r, { x: 5, y: 5, w: 200, h: 40 });
});

test('sanitizePageState trims text fields to max lengths', () => {
  const input = {
    url: 'https://example.com',
    title: 'Test Page',
    elements: [{
      tag: 'button', role: 'button', text: 'Click me', selector: '#btn',
      isClickable: true, isInput: false, visible: true, disabled: false,
      rect: { x: 10, y: 10, w: 100, h: 40 }, screenRect: { x: 110, y: 60, w: 100, h: 40 }
    }],
    summaryText: 'Some page content'
  };
  const result = sanitizePageState(input);
  assert.equal(result.url, 'https://example.com');
  assert.equal(result.source, 'browser-helper');
  assert.equal(result.elements.length, 1);
  assert.equal(result.elements[0].isClickable, true);
  assert.deepEqual(result.elements[0].screenRect, { x: 110, y: 60, w: 100, h: 40 });
});

test('sanitizePageState caps elements at 250', () => {
  const elements = Array.from({ length: 300 }, (_, i) => ({
    tag: 'button', text: `Button ${i}`, isClickable: true, isInput: false, visible: true
  }));
  const result = sanitizePageState({ url: 'https://x.com', elements });
  assert.equal(result.elements.length, 250);
});

test('sanitizePageState handles missing elements gracefully', () => {
  const result = sanitizePageState({ url: 'https://x.com' });
  assert.deepEqual(result.elements, []);
});

test('sanitizePageState strips password input text', () => {
  const input = {
    url: 'https://x.com',
    elements: [{ tag: 'input', type: 'password', text: 'mysecret', isInput: true }]
  };
  const result = sanitizePageState(input);
  assert.equal(result.elements.length, 1);
});
