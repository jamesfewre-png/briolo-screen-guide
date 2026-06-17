const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Tracker } = require('../src/tracking/tracker.js');

function makeTracker(stateProvider, overlaySpy = []) {
  return new Tracker({
    getPageState: stateProvider,
    sendOverlay: (g) => overlaySpy.push(g)
  });
}

const makeEl = (text, selector, screenRect) => ({ text, selector, screenRect, isClickable: true, visible: true });

test('tracker does nothing when anchor is null', () => {
  const spy = [];
  const t = makeTracker(() => ({ elements: [], scroll: { y: 0 } }), spy);
  t._tick();
  assert.equal(spy.length, 0);
});

test('tracker finds element by selector', () => {
  const els = [makeEl('Business Settings', 'a#bs', { x: 120, y: 400, w: 160, h: 40 })];
  const t = makeTracker(() => ({ elements: els, scroll: { y: 0 } }));
  const found = t._findAnchorInState({ elements: els });
  assert.ok(found);
  assert.equal(found.selector, 'a#bs');
});

test('tracker finds element by text when selector misses', () => {
  const els = [makeEl('Business Settings', 'a#different', { x: 120, y: 400, w: 160, h: 40 })];
  const t = makeTracker(() => ({ elements: els, scroll: { y: 0 } }));
  t.setAnchor({ selector: 'a#bs', text: 'Business Settings', screenRect: { x: 120, y: 400, w: 160, h: 40 }, confidence: 0.9, overlayTemplate: { type: 'dom-highlight', message: 'Click here', arrow: { direction: 'target', x: 0.5, y: 0.5 } } });
  const found = t._findAnchorInState({ elements: els });
  assert.ok(found);
  assert.equal(found.text, 'Business Settings');
});

test('tracker sends overlay update when screenRect changes', () => {
  const spy = [];
  let scrollY = 0;
  const els = () => [makeEl('Business Settings', 'a#bs', { x: 120, y: 400 - scrollY, w: 160, h: 40 })];
  const t = makeTracker(() => ({ elements: els(), scroll: { y: scrollY } }), spy);
  t.setAnchor({ selector: 'a#bs', text: 'Business Settings', screenRect: { x: 120, y: 400, w: 160, h: 40 }, confidence: 0.9, overlayTemplate: { type: 'dom-highlight', message: 'Click here', arrow: { direction: 'target', x: 0.5, y: 0.5 } } });
  t._lastScrollY = 0;
  scrollY = 50;
  t._tick();
  assert.ok(spy.length > 0, 'expected overlay update');
  assert.deepEqual(spy[0].highlight, { x: 120, y: 350, w: 160, h: 40 });
});

test('tracker hides overlay on scroll when element not found', () => {
  const spy = [];
  let scrollY = 0;
  const t = makeTracker(() => ({ elements: [], scroll: { y: scrollY } }), spy);
  t.setAnchor({ selector: 'a#bs', text: 'Target', screenRect: { x: 120, y: 400, w: 160, h: 40 }, confidence: 0.9, overlayTemplate: {} });
  t._lastScrollY = 0;
  scrollY = 100;
  t._tick();
  const lastMsg = spy[spy.length - 1];
  assert.ok(lastMsg, 'expected an overlay message');
  assert.equal(lastMsg.type, 'message');
  assert.ok(lastMsg.message.includes('Checking'));
});

test('tracker clearAnchor resets state', () => {
  const spy = [];
  const t = makeTracker(() => ({ elements: [], scroll: { y: 0 } }), spy);
  t.setAnchor({ selector: 'a#bs', text: 'Target', screenRect: { x: 0, y: 0, w: 10, h: 10 }, confidence: 0.9, overlayTemplate: {} });
  t.clearAnchor();
  t._tick();
  assert.equal(spy.length, 0);
});

test('tracker calls onRedetectNeeded after anchor missing for 400ms', () => {
  return new Promise((resolve) => {
    const tracker = new Tracker({
      getPageState: () => ({ elements: [], scroll: { y: 0 } }),
      sendOverlay: () => {}
    });
    tracker.setAnchor({ selector: 'a#bs', text: 'Target', screenRect: { x: 0, y: 0, w: 10, h: 10 }, confidence: 0.9, overlayTemplate: {} });
    tracker._notFoundSince = Date.now() - 500;
    tracker.onRedetectNeeded(() => resolve());
    tracker._tick();
  });
});
