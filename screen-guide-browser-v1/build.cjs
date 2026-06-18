// Zero-dependency build: copies src/ to dist/ (no bundler needed for plain-JS extension)
const { cpSync, mkdirSync, existsSync, rmSync, readFileSync, writeFileSync } = require('fs');
const { join } = require('path');

const src = 'src';
const dist = 'dist';

if (existsSync(dist)) rmSync(dist, { recursive: true });
mkdirSync(join(dist, 'vendor'), { recursive: true });
mkdirSync(join(dist, 'workflows'), { recursive: true });

for (const f of ['background.js', 'content.js', 'panel.html', 'panel.js', 'manifest.json', 'claudeReasoner.js']) {
  cpSync(join(src, f), join(dist, f));
}
cpSync(join(src, 'vendor', 'driver.js'), join(dist, 'vendor', 'driver.js'));
cpSync(join(src, 'vendor', 'driver.css'), join(dist, 'vendor', 'driver.css'));
cpSync(join(src, 'workflows', 'meta-connect-assets.json'), join(dist, 'workflows', 'meta-connect-assets.json'));

// Inject API key from root .env into dist/config.json (never committed to git)
try {
  const envContent = readFileSync(join('..', '.env'), 'utf8');
  const match = envContent.match(/^ANTHROPIC_API_KEY=(.+)$/m);
  if (match) {
    writeFileSync(join(dist, 'config.json'), JSON.stringify({ claudeApiKey: match[1].trim() }));
    console.log('API key injected from .env');
  } else {
    console.warn('ANTHROPIC_API_KEY not found in .env — AI mode disabled until key is set');
  }
} catch (e) {
  console.warn('Could not read ../.env —', e.message);
}

console.log('Build complete -> dist/  (load this folder as an unpacked Chrome extension)');
