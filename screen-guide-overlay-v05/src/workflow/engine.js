const path = require('path');
const fs = require('fs');

const DEFINITIONS_DIR = path.join(__dirname, 'definitions');

const STATES = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  STOPPED: 'stopped',
  COMPLETE: 'complete'
};

class WorkflowEngine {
  constructor() {
    this._workflow = null;
    this._stepIndex = 0;
    this._state = STATES.IDLE;
    this._stuckCount = 0;
    this._stepChangeListeners = [];
    this._statusChangeListeners = [];
  }

  load(workflowId) {
    const filePath = path.join(DEFINITIONS_DIR, `${workflowId}.json`);
    const raw = fs.readFileSync(filePath, 'utf8');
    this._workflow = JSON.parse(raw);
    this._stepIndex = 0;
    this._state = STATES.IDLE;
    this._stuckCount = 0;
    return this._workflow;
  }

  start() {
    if (!this._workflow) throw new Error('No workflow loaded. Call engine.load(id) first.');
    this._state = STATES.RUNNING;
    this._stepIndex = 0;
    this._stuckCount = 0;
    this._emitStatusChange('started');
    this._emitStepChange();
  }

  pause() {
    if (this._state === STATES.RUNNING) {
      this._state = STATES.PAUSED;
      this._emitStatusChange('paused');
    }
  }

  resume() {
    if (this._state === STATES.PAUSED) {
      this._state = STATES.RUNNING;
      this._emitStatusChange('resumed');
    }
  }

  stop() {
    this._state = STATES.STOPPED;
    this._stepIndex = 0;
    this._stuckCount = 0;
    this._emitStatusChange('stopped');
  }

  updatePageState(pageState) {
    if (this._state !== STATES.RUNNING) return null;
    if (!this._workflow) return null;

    const step = this.getCurrentStep();
    if (!step) return null;

    if (step.expectedDomains && step.expectedDomains.length > 0 && pageState.url) {
      const domainMatch = step.expectedDomains.some(d => pageState.url.includes(d));
      if (!domainMatch) return { status: 'wrong-page', step };
    }

    if (this._checkCompletionSignals(step, pageState)) {
      this._advanceStep();
      return { status: 'step-complete', step };
    }

    return { status: 'running', step };
  }

  _checkCompletionSignals(step, pageState) {
    if (!step.completionSignals) return false;
    const signals = step.completionSignals;

    if (signals.urlContains) {
      const urlMatch = signals.urlContains.some(s => (pageState.url || '').includes(s));
      if (!urlMatch) return false;
    }

    if (signals.textPresent) {
      const text = `${pageState.summaryText || ''} ${(pageState.elements || []).map(e => e.text || '').join(' ')}`;
      const textMatch = signals.textPresent.some(s => text.toLowerCase().includes(s.toLowerCase()));
      if (!textMatch) return false;
    }

    return true;
  }

  _advanceStep() {
    this._stuckCount = 0;
    if (this._stepIndex + 1 >= this._workflow.steps.length) {
      this._state = STATES.COMPLETE;
      this._emitStatusChange('complete');
    } else {
      this._stepIndex += 1;
      this._emitStepChange();
    }
  }

  advanceStep() { this._advanceStep(); }

  markStuck() {
    this._stuckCount += 1;
    if (this._stuckCount >= 3) this._emitStatusChange('stuck');
  }

  resetStuck() { this._stuckCount = 0; }

  getCurrentStep() {
    if (!this._workflow) return null;
    return this._workflow.steps[this._stepIndex] || null;
  }

  getStepIndex() { return this._stepIndex; }
  getTotalSteps() { return this._workflow?.steps.length || 0; }
  getState() { return this._state; }
  getWorkflowName() { return this._workflow?.name || ''; }
  isRunning() { return this._state === STATES.RUNNING; }

  onStepChange(cb) { this._stepChangeListeners.push(cb); }
  onStatusChange(cb) { this._statusChangeListeners.push(cb); }

  _emitStepChange() {
    const step = this.getCurrentStep();
    for (const cb of this._stepChangeListeners) cb({ step, index: this._stepIndex, total: this.getTotalSteps() });
  }

  _emitStatusChange(event) {
    for (const cb of this._statusChangeListeners) cb({ event, state: this._state, stepIndex: this._stepIndex });
  }
}

module.exports = { WorkflowEngine, STATES };
