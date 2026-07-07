// Zero-dependency build: copies src/ to dist/ (no bundler needed for plain-JS extension)
const { cpSync, mkdirSync, existsSync, rmSync, readFileSync, writeFileSync, readdirSync } = require('fs');
const { join } = require('path');

const src = 'src';
const dist = 'dist';

if (existsSync(dist)) rmSync(dist, { recursive: true });
mkdirSync(join(dist, 'vendor'), { recursive: true });
mkdirSync(join(dist, 'workflows'), { recursive: true });

// Core extension files
for (const f of ['background.js', 'content.js', 'panel.html', 'panel.js', 'manifest.json', 'claudeReasoner.js']) {
  cpSync(join(src, f), join(dist, f));
}

// Vendor (Driver.js)
cpSync(join(src, 'vendor', 'driver.js'), join(dist, 'vendor', 'driver.js'));
cpSync(join(src, 'vendor', 'driver.css'), join(dist, 'vendor', 'driver.css'));

// Copy ALL goal JSON files so new guides ship automatically (no hardcoding), and
// build workflows/index.json so the panel can list available guides at runtime
// (extensions can't readdir() packaged files).
const workflowSrc = join(src, 'workflows');
let workflowCount = 0;
const goalIndex = [];
if (existsSync(workflowSrc)) {
  for (const f of readdirSync(workflowSrc)) {
    if (!f.toLowerCase().endsWith('.json') || f.toLowerCase() === 'index.json') continue;
    cpSync(join(workflowSrc, f), join(dist, 'workflows', f));
    workflowCount++;
    try {
      const g = JSON.parse(readFileSync(join(workflowSrc, f), 'utf8'));
      if (g && g.id && g.name) goalIndex.push({
        id: g.id, name: g.name, objective: g.objective || '',
        patterns: Array.isArray(g.patterns) ? g.patterns : [],
        deepLink: g.deepLink || '',
        hasVerify: !!(g.verify && Array.isArray(g.verify.providers) && g.verify.providers.length),
      });
    } catch (_) { console.warn(`Skipping malformed goal file: ${f}`); }
  }
}
writeFileSync(join(dist, 'workflows', 'index.json'), JSON.stringify(goalIndex, null, 2));
console.log(`Copied ${workflowCount} guide(s); index.json lists ${goalIndex.length}.`);

// ── Config injection (dist/config.json — gitignored, never committed) ──────────
// PRODUCTION: if GUIDE_PROXY_URL is set, ship the proxy URL + shared secret and
// NO Anthropic key (the key stays server-side on the Briolo backend).
// DEV: otherwise ship ANTHROPIC_API_KEY so the extension can call Claude directly.
// Read from a local ./.env first, then fall back to the repo-root ../.env.
function readVar(envPath, name) {
  try {
    const content = readFileSync(envPath, 'utf8');
    const m = content.match(new RegExp('^' + name + '=(.+)$', 'm'));
    if (m) return m[1].trim();
  } catch (_) { /* missing file is fine */ }
  return null;
}
function readAny(name) { return readVar('.env', name) || readVar(join('..', '.env'), name); }

const proxyUrl = readAny('GUIDE_PROXY_URL');
const proxySecret = readAny('GUIDE_SHARED_SECRET');
const apiKey = readAny('ANTHROPIC_API_KEY');

// Deployment identity (all optional): the brand shown in the panel, the dashboard
// the finish-line hands tokens into, and the facilitator named in flag mode.
const extras = {};
const brand = readAny('GUIDE_BRAND');
const dashboardUrl = readAny('GUIDE_DASHBOARD_URL');
const facilitatorName = readAny('GUIDE_FACILITATOR_NAME');
if (brand) extras.brand = brand;
if (dashboardUrl) extras.dashboardUrl = dashboardUrl.replace(/\/$/, '');
if (facilitatorName) extras.facilitatorName = facilitatorName;

if (proxyUrl) {
  const cfg = Object.assign({ proxyUrl }, extras);
  if (proxySecret) cfg.proxySecret = proxySecret;
  writeFileSync(join(dist, 'config.json'), JSON.stringify(cfg));
  console.log(`Proxy mode: dist/config.json -> ${proxyUrl} (no API key shipped)`);
} else if (apiKey) {
  writeFileSync(join(dist, 'config.json'), JSON.stringify(Object.assign({ claudeApiKey: apiKey }, extras)));
  console.log('Dev mode: API key injected into dist/config.json');
  console.log('REMINDER: dist/ is gitignored — never commit it (it contains your API key).');
} else {
  writeFileSync(join(dist, 'config.json'), JSON.stringify(extras));
  console.warn('--------------------------------------------------------------------');
  console.warn('WARNING: no GUIDE_PROXY_URL and no ANTHROPIC_API_KEY in ./.env or ../.env');
  console.warn('Build completes, but AI guidance is DISABLED until you set one and rebuild.');
  console.warn('  Production: GUIDE_PROXY_URL=https://your-app.vercel.app/api/analyze');
  console.warn('  Dev:        ANTHROPIC_API_KEY=sk-ant-...');
  console.warn('--------------------------------------------------------------------');
}

console.log('Build complete -> dist/  (load this folder as an unpacked Chrome extension)');
