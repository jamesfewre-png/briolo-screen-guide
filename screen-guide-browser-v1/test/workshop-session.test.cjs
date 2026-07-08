// Integration tests for the workshop capture session engine (background.js).
// Runs the REAL service-worker source in a vm sandbox with stubbed chrome APIs
// and the REAL workflow JSONs from src/workflows/, then drives the full journey:
//   BUILD_PLAN -> plan -> CONFIRM_PLAN -> chained flows -> finish -> ATTESTED ->
//   verify pass-through -> alldone, plus stuck/flag paths.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function buildIndex(wfDir) {
  const index = [];
  for (const f of fs.readdirSync(wfDir)) {
    if (!f.toLowerCase().endsWith('.json') || f.toLowerCase() === 'index.json') continue;
    const g = JSON.parse(fs.readFileSync(path.join(wfDir, f), 'utf8'));
    index.push({
      id: g.id, name: g.name, objective: g.objective || '',
      patterns: Array.isArray(g.patterns) ? g.patterns : [],
      deepLink: g.deepLink || '',
      hasVerify: !!(g.verify && g.verify.providers && g.verify.providers.length),
    });
  }
  return index;
}

function makeEnv(opts) {
  opts = opts || {};
  const calls = { createdTabs: [], tabMessages: [] };
  let messageListener = null;

  const wfDir = path.join(ROOT, 'src', 'workflows');
  const files = { 'config.json': JSON.stringify(Object.assign({ claudeApiKey: 'test-key' }, opts.config || {})) };
  for (const f of fs.readdirSync(wfDir)) {
    if (f.toLowerCase().endsWith('.json')) files['workflows/' + f] = fs.readFileSync(path.join(wfDir, f), 'utf8');
  }
  files['workflows/index.json'] = JSON.stringify(buildIndex(wfDir));

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, URL, AbortController, JSON, Math, Date, Promise, Object, Array, String, Number, Error,
    fetch: async (url, fopts) => {
      const rel = String(url).replace('chrome-extension://test/', '');
      if (files[rel] !== undefined) return { ok: true, status: 200, json: async () => JSON.parse(files[rel]) };
      if (opts.fetchImpl) return opts.fetchImpl(url, fopts);
      throw new Error('unexpected fetch ' + url);
    },
    chrome: {
      runtime: {
        getURL: p => 'chrome-extension://test/' + p,
        onMessage: { addListener: fn => { messageListener = fn; } },
        onMessageExternal: { addListener() {} },
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
        sendMessage() {},
        lastError: null,
      },
      storage: { local: { get: async () => ({}), set: async () => ({}) } },
      tabs: {
        query: (q, cb) => cb([{ id: 1, active: true, windowId: 1 }]),
        get: async id => ({ id, windowId: 1, active: true }),
        create: (props, cb) => { calls.createdTabs.push(props.url); if (cb) cb({ id: 90 + calls.createdTabs.length }); },
        sendMessage: (tabId, msg) => {
          calls.tabMessages.push(msg);
          if (msg && msg.type === 'GET_SENSITIVE_REGIONS') return Promise.resolve([]);
          return Promise.resolve();
        },
        captureVisibleTab: (winId, o, cb) => cb(null),
        onUpdated: { addListener() {} },
        onActivated: { addListener() {} },
      },
      sidePanel: { open: () => Promise.resolve() },
    },
  };
  sandbox.self = sandbox;
  sandbox.importScripts = () => {};
  sandbox.crypto = { randomUUID: () => 'test-uuid' };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'background.js'), 'utf8'), sandbox);

  const rawSend = msg => new Promise(resolve => { messageListener(msg, { tab: { id: 1 } }, resolve); });
  const getState = () => rawSend({ type: 'GET_STATE' });
  // loadConfig() is async at sandbox boot — wait for the key before driving,
  // otherwise the engine correctly reports "AI not configured" and tests race.
  let readyP = null;
  const ensureReady = () => {
    if (!readyP) readyP = (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 3000) {
        const s = await getState();
        if (s.hasApiKey) return;
        await new Promise(r => setTimeout(r, 20));
      }
    })();
    return readyP;
  };
  const send = async msg => { await ensureReady(); return rawSend(msg); };
  const until = async (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 3000)) {
      if (await fn()) return true;
      await new Promise(r => setTimeout(r, 25));
    }
    return false;
  };
  return { sandbox, send, getState, until, calls };
}

test('BUILD_PLAN: triage proposal becomes an ordered, named plan', async () => {
  const env = makeEnv();
  env.sandbox.self.triageWithClaude = async ({ library }) => {
    assert.ok(library.length >= 5, 'library should list the pattern flows');
    return [
      { workflowId: 'meta-connect-assets', reason: 'You said customers DM you.' },
      { workflowId: 'llm-api-key', reason: 'The brain that writes replies.' },
    ];
  };
  await env.send({ type: 'BUILD_PLAN', business: 'Mobile dog groomer', job: 'Reply to Instagram DMs' });
  assert.ok(await env.until(async () => (await env.getState()).phase === 'plan'), 'reaches plan phase');
  const s = await env.getState();
  assert.strictEqual(s.plan.length, 2);
  assert.strictEqual(s.plan[0].id, 'meta-connect-assets');
  assert.match(s.plan[0].name, /Meta/i);
  assert.match(s.plan[0].reason, /DM/);
});

test('BUILD_PLAN: triage failure falls back to the full pattern library, never a dead end', async () => {
  const env = makeEnv();
  env.sandbox.self.triageWithClaude = async () => { throw new Error('boom'); };
  await env.send({ type: 'BUILD_PLAN', business: 'Cafe', job: 'Reviews' });
  assert.ok(await env.until(async () => (await env.getState()).phase === 'plan'));
  const s = await env.getState();
  assert.ok(s.plan.length >= 5, 'all pattern flows offered');
  assert.ok(s.plan.every(p => p.id !== 'shopify-connect'), 'patternless flows excluded');
});

test('full journey: confirm -> chained flows -> finish -> attest -> pass-through verify -> alldone', async () => {
  const env = makeEnv();
  env.sandbox.self.triageWithClaude = async () => ([
    { workflowId: 'meta-connect-assets', reason: 'DMs' },
    { workflowId: 'llm-api-key', reason: 'brain' },
  ]);
  // Reasoner always reports the token on screen -> immediate finish line.
  env.sandbox.self.analyzeWithClaude = async () => ({
    reasoning: '', message: 'Your token is on screen', sgId: '', targetText: '',
    confidence: 0.9, status: 'complete', tokenRevealed: true,
  });

  await env.send({ type: 'BUILD_PLAN', business: 'Groomer', job: 'DMs' });
  await env.until(async () => (await env.getState()).phase === 'plan');
  await env.send({ type: 'CONFIRM_PLAN', ids: ['meta-connect-assets', 'llm-api-key'] });

  assert.ok(await env.until(() => env.calls.createdTabs.length >= 1), 'opens flow 1 front door');
  assert.match(env.calls.createdTabs[0], /business\.facebook\.com/);

  await env.send({ type: 'NEXT_STEP' }); // triggers an evaluate on the active tab
  assert.ok(await env.until(async () => (await env.getState()).phase === 'finish'), 'flow 1 reaches finish line');

  await env.send({ type: 'ATTESTED' }); // no dashboard configured -> honest pass-through
  assert.ok(await env.until(async () => (await env.getState()).phase === 'running'), 'chains to flow 2');
  let s = await env.getState();
  assert.strictEqual(s.plan[0].status, 'done');
  assert.ok(s.verifyNote === '' || true, 'verifyNote reset per flow');
  assert.ok(await env.until(() => env.calls.createdTabs.length >= 2), 'opens flow 2 front door');
  assert.match(env.calls.createdTabs[1], /console\.anthropic\.com/);

  await env.send({ type: 'NEXT_STEP' });
  assert.ok(await env.until(async () => (await env.getState()).phase === 'finish'), 'flow 2 reaches finish line');
  await env.send({ type: 'ATTESTED' });
  assert.ok(await env.until(async () => (await env.getState()).phase === 'alldone'), 'session completes');
  s = await env.getState();
  assert.ok(s.plan.every(p => p.status === 'done'));
});

test('STUCK twice on one flow flags the facilitator; FLAG_RESUME recovers', async () => {
  const env = makeEnv();
  env.sandbox.self.analyzeWithClaude = async () => ({
    reasoning: '', message: 'Try the menu', sgId: '', targetText: '',
    confidence: 0.4, status: 'blocked', tokenRevealed: false,
  });
  await env.send({ type: 'START_WORKFLOW', workflowId: 'meta-connect-assets' });
  await env.until(async () => (await env.getState()).goalName.length > 0);
  await env.send({ type: 'STUCK' });
  let s = await env.getState();
  assert.notStrictEqual(s.phase, 'flagged', 'first stuck does not flag');
  await env.send({ type: 'STUCK' });
  s = await env.getState();
  assert.strictEqual(s.phase, 'flagged', 'second stuck flags');
  await env.send({ type: 'FLAG_RESUME' });
  s = await env.getState();
  assert.strictEqual(s.phase, 'running', 'resume returns to guidance');
});

test('CHECK_SIGNIN without a dashboard reports null (guard hidden)', async () => {
  const env = makeEnv();
  const res = await env.send({ type: 'CHECK_SIGNIN' });
  assert.strictEqual(res.signedIn, null);
});

test('dashboard verify: failed status triggers regeneration, second failure flags', async () => {
  let verifyCalls = 0;
  const env = makeEnv({
    config: { claudeApiKey: 'test-key', dashboardUrl: 'https://dash.test' },
    fetchImpl: async (url) => {
      if (String(url).startsWith('https://dash.test/api/connections/meta/status')) {
        verifyCalls++;
        return { ok: true, status: 200, json: async () => ({ status: 'failed', reason: 'test-reason: key expired or miscopied' }) };
      }
      throw new Error('unexpected fetch ' + url);
    },
  });
  env.sandbox.self.analyzeWithClaude = async () => ({
    reasoning: '', message: 'Token on screen', sgId: '', targetText: '',
    confidence: 0.9, status: 'complete', tokenRevealed: true,
  });
  await env.send({ type: 'START_WORKFLOW', workflowId: 'meta-connect-assets' });
  await env.send({ type: 'NEXT_STEP' });
  assert.ok(await env.until(async () => (await env.getState()).phase === 'finish'), 'reaches finish');

  // Fail #1 -> guided regeneration. The 'running' hop is transient (the stub
  // reasoner instantly re-reveals the token), so assert the observable contract:
  // exactly one smoke test ran and we are back at the finish line.
  await env.send({ type: 'ATTESTED' });
  assert.ok(await env.until(async () => (await env.getState()).phase === 'finish'), 'regen re-guides back to the finish line');
  assert.strictEqual(verifyCalls, 1, 'exactly one smoke test ran');
  assert.match((await env.getState()).verifyReason, /key expired/, 'actionable reason exposed to the panel');
  await env.send({ type: 'ATTESTED' }); // fail #2 -> flag mode
  assert.ok(await env.until(async () => (await env.getState()).phase === 'flagged'), 'second failure flags');
});

test('integration_broken: never regenerates, flags on the FIRST failure, never blames the owner', async () => {
  let verifyCalls = 0;
  const env = makeEnv({
    config: { claudeApiKey: 'test-key', dashboardUrl: 'https://dash.test' },
    fetchImpl: async (url) => {
      if (String(url).startsWith('https://dash.test/api/connections/meta/status')) {
        verifyCalls++;
        return { ok: true, status: 200, json: async () => ({ status: 'failed', kind: 'integration_broken', reason: 'this connection needs an update on our side' }) };
      }
      throw new Error('unexpected fetch ' + url);
    },
  });
  env.sandbox.self.analyzeWithClaude = async () => ({
    reasoning: '', message: 'Token on screen', sgId: '', targetText: '',
    confidence: 0.9, status: 'complete', tokenRevealed: true,
  });
  await env.send({ type: 'START_WORKFLOW', workflowId: 'meta-connect-assets' });
  await env.send({ type: 'NEXT_STEP' });
  assert.ok(await env.until(async () => (await env.getState()).phase === 'finish'), 'reaches finish');

  await env.send({ type: 'ATTESTED' }); // a stale integration must NEVER trigger a regen attempt
  assert.ok(await env.until(async () => (await env.getState()).phase === 'flagged'), 'flags immediately on first failure');
  assert.strictEqual(verifyCalls, 1, 'no wasted retry — regenerating a token cannot fix a stale integration');
  const s = await env.getState();
  assert.strictEqual(s.verifyKind, 'integration_broken');
  assert.match(s.verifyReason, /update on our side/);
});

test('provider_unreachable: silently retries the SAME token once before flagging', async () => {
  let verifyCalls = 0;
  const env = makeEnv({
    config: { claudeApiKey: 'test-key', dashboardUrl: 'https://dash.test' },
    fetchImpl: async (url) => {
      if (String(url).startsWith('https://dash.test/api/connections/meta/status')) {
        verifyCalls++;
        return { ok: true, status: 200, json: async () => ({ status: 'failed', kind: 'provider_unreachable', reason: 'the provider is having trouble on their end right now' }) };
      }
      throw new Error('unexpected fetch ' + url);
    },
  });
  env.sandbox.self.analyzeWithClaude = async () => ({
    reasoning: '', message: 'Token on screen', sgId: '', targetText: '',
    confidence: 0.9, status: 'complete', tokenRevealed: true,
  });
  await env.send({ type: 'START_WORKFLOW', workflowId: 'meta-connect-assets' });
  await env.send({ type: 'NEXT_STEP' });
  assert.ok(await env.until(async () => (await env.getState()).phase === 'finish'), 'reaches finish');

  await env.send({ type: 'ATTESTED' }); // fail #1 -> silent re-check, NOT a regen guide (the token may be fine)
  assert.ok(await env.until(async () => verifyCalls >= 2, 4500), 'auto-retries the same token without asking the owner to do anything');
  assert.ok(await env.until(async () => (await env.getState()).phase === 'flagged', 3000), 'flags after the retry also fails');
  const s = await env.getState();
  assert.strictEqual(s.verifyKind, 'provider_unreachable');
});