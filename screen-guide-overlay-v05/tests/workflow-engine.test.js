const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WorkflowEngine, STATES } = require('../src/workflow/engine.js');

function makeEngine() {
  const e = new WorkflowEngine();
  e.load('meta-connect-assets');
  return e;
}

test('engine starts at idle state', () => {
  const e = new WorkflowEngine();
  assert.equal(e.getState(), STATES.IDLE);
});

test('engine loads workflow and has 6 steps', () => {
  const e = makeEngine();
  assert.equal(e.getTotalSteps(), 6);
});

test('engine starts at step 0', () => {
  const e = makeEngine();
  e.start();
  assert.equal(e.getStepIndex(), 0);
  assert.equal(e.getState(), STATES.RUNNING);
});

test('engine getCurrentStep returns step object', () => {
  const e = makeEngine();
  e.start();
  const step = e.getCurrentStep();
  assert.ok(step);
  assert.ok(step.id);
  assert.ok(step.instruction);
});

test('engine advanceStep increments stepIndex', () => {
  const e = makeEngine();
  e.start();
  e.advanceStep();
  assert.equal(e.getStepIndex(), 1);
});

test('engine emits onStepChange when step advances', () => {
  const e = makeEngine();
  e.start();
  let fired = false;
  let firedIndex = -1;
  e.onStepChange(({ index }) => { fired = true; firedIndex = index; });
  e.advanceStep();
  assert.ok(fired);
  assert.equal(firedIndex, 1);
});

test('engine emits complete when last step is advanced', () => {
  const e = makeEngine();
  e.start();
  let event = null;
  e.onStatusChange(({ event: ev }) => { event = ev; });
  for (let i = 0; i < 6; i++) e.advanceStep();
  assert.equal(event, 'complete');
  assert.equal(e.getState(), STATES.COMPLETE);
});

test('engine pause and resume change state', () => {
  const e = makeEngine();
  e.start();
  e.pause();
  assert.equal(e.getState(), STATES.PAUSED);
  assert.ok(!e.isRunning());
  e.resume();
  assert.equal(e.getState(), STATES.RUNNING);
  assert.ok(e.isRunning());
});

test('engine updatePageState returns wrong-page when domain mismatch', () => {
  const e = makeEngine();
  e.start();
  const result = e.updatePageState({ url: 'https://google.com', elements: [], summaryText: '', scroll: { y: 0 } });
  assert.equal(result.status, 'wrong-page');
});

test('engine updatePageState advances step when completionSignals match', () => {
  const e = makeEngine();
  e.start();
  const initialIndex = e.getStepIndex();
  const result = e.updatePageState({
    url: 'https://business.facebook.com/home',
    summaryText: 'Welcome to Business Manager. Business Settings People Accounts',
    elements: [],
    scroll: { y: 0 }
  });
  assert.equal(result.status, 'step-complete');
  assert.equal(e.getStepIndex(), initialIndex + 1);
});

test('engine markStuck emits stuck event after 3 calls', () => {
  const e = makeEngine();
  e.start();
  let stuckFired = false;
  e.onStatusChange(({ event }) => { if (event === 'stuck') stuckFired = true; });
  e.markStuck(); e.markStuck(); e.markStuck();
  assert.ok(stuckFired);
});

test('engine resetStuck prevents stuck event', () => {
  const e = makeEngine();
  e.start();
  let stuckFired = false;
  e.onStatusChange(({ event }) => { if (event === 'stuck') stuckFired = true; });
  e.markStuck(); e.markStuck();
  e.resetStuck();
  e.markStuck(); e.markStuck();
  assert.ok(!stuckFired);
});

test('engine updatePageState returns null when not running', () => {
  const e = makeEngine();
  const result = e.updatePageState({ url: 'https://business.facebook.com', elements: [] });
  assert.equal(result, null);
});
