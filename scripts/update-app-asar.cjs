#!/usr/bin/env node
/**
 * Hot-update the installed app with the latest source code.
 * Packs a new asar from source + the existing node_modules, replaces it in-place.
 * Much faster than a full npm run dist. Never touches source files.
 *
 * Usage: node scripts/update-app-asar.cjs
 */

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const ROOT   = path.resolve(__dirname, '..');
const APP    = process.env.SEENS_APP_PATH ?? '/Applications/Seens Radio.app';
const ASAR   = path.join(APP, 'Contents/Resources/app.asar');
const STAGE  = path.join(ROOT, 'dist', '.asar-stage');
const OUTPUT = path.join(ROOT, 'dist', 'app.asar.new');

if (!fs.existsSync(APP)) {
  console.error(`App not found: ${APP}\nSet SEENS_APP_PATH env var if installed elsewhere.`);
  process.exit(1);
}

// Source dirs/files to copy (matches electron-builder "files" list, minus node_modules)
const SOURCE_ITEMS = [
  'electron', 'server.js', 'routes', 'src', 'music', 'auth',
  'public', 'scripts', 'prompts', 'USER', '.env', 'package.json',
];

console.log('📦 Building staging directory...');
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

// 1. Copy source files into staging
for (const item of SOURCE_ITEMS) {
  const src = path.join(ROOT, item);
  if (!fs.existsSync(src)) continue;
  const dst = path.join(STAGE, item);
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    execSync(`cp -r "${src}" "${dst}"`);
  } else {
    fs.copyFileSync(src, dst);
  }
}

// 2. Copy node_modules from the project (same Electron version — already correct ABI)
console.log('  Copying node_modules (may take a few seconds)...');
execSync(`cp -r "${path.join(ROOT, 'node_modules')}" "${path.join(STAGE, 'node_modules')}"`);

// 3. Pack to asar
console.log('  Packing asar...');
const result = spawnSync('npx', ['@electron/asar', 'pack', STAGE, OUTPUT], {
  stdio: 'inherit',
  shell: true,
});
if (result.status !== 0) {
  console.error('asar pack failed');
  process.exit(1);
}

// 4. Replace installed asar
console.log('  Replacing installed asar...');
fs.copyFileSync(OUTPUT, ASAR);

// 5. Cleanup
fs.rmSync(STAGE, { recursive: true, force: true });
fs.rmSync(OUTPUT, { force: true });

console.log(`\n✅ Updated: ${ASAR}`);
console.log('   Quit and reopen "Seens Radio" to load the new code.');
