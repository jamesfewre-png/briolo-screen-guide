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

// Copy ALL workflow JSON files so new workflows ship automatically (no hardcoding)
const workflowSrc = join(src, 'workflows');
let workflowCount = 0;
if (existsSync(workflowSrc)) {
  for (const f of readdirSync(workflowSrc)) {
    if (f.toLowerCase().endsWith('.json')) {
      cpSync(join(workflowSrc, f), join(dist, 'workflows', f));
      workflowCount++;
    }
  }
}
console.log(`Copied ${workflowCount} workflow file(s) from ${workflowSrc}/`);

// ── API key injection ─────────────────────────────────────────────────────────
// Read ANTHROPIC_API_KEY from a local .env first, then fall back to the repo-root ../.env.
// The key lands ONLY in dist/config.json, which is gitignored and never committed.
function readKeyFrom(envPath) {
  try {
    const content = readFileSync(envPath, 'utf8');
    const match = content.match(/^ANTHROPIC_API_KEY=(.+)$/m);
    if (match) return { key: match[1].trim(), source: envPath };
  } catch (_) {
    // missing file is fine — fall through to the next candidate
  }
  return null;
}

const found = readKeyFrom('.env') || readKeyFrom(join('..', '.env'));

if (found && found.key) {
  // config.json is the ONLY place the API key is written.
  writeFileSync(join(dist, 'config.json'), JSON.stringify({ claudeApiKey: found.key }));
  console.log(`API key injected into dist/config.json (source: ${found.source})`);
  console.log('REMINDER: dist/ is gitignored — never commit it (it contains your API key).');
} else {
  console.warn('--------------------------------------------------------------------');
  console.warn('WARNING: ANTHROPIC_API_KEY not found in ./.env or ../.env');
  console.warn('Build will complete, but AI hybrid reasoning is DISABLED.');
  console.warn('Add ANTHROPIC_API_KEY=sk-ant-... to ./.env (or ../.env) and rebuild');
  console.warn('to enable Claude-assisted guidance. Text-match guidance still works.');
  console.warn('--------------------------------------------------------------------');
}

console.log('Build complete -> dist/  (load this folder as an unpacked Chrome extension)');
