#!/usr/bin/env node
/**
 * Hot-update the installed app with the latest source code.
 * Packs a new asar from source + the existing node_modules, replaces it in-place.
 * Much faster than a full npm run dist. Never touches source files.
 *
 * Native .node binaries are marked "unpacked" in the asar header so Electron
 * redirects those paths to app.asar.unpacked — they cannot be loaded from
 * inside the asar archive.
 *
 * Usage: node scripts/update-app-asar.cjs
 */

const { execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const ROOT        = path.resolve(__dirname, '..');
const APP         = process.env.SEENS_APP_PATH ?? '/Applications/Seens Radio.app';
const RESOURCES   = path.join(APP, 'Contents/Resources');
const ASAR        = path.join(RESOURCES, 'app.asar');
const ASAR_UNPACK = path.join(RESOURCES, 'app.asar.unpacked');
const STAGE       = path.join(ROOT, 'dist', '.asar-stage');
const OUTPUT      = path.join(ROOT, 'dist', 'app.asar.new');
const OUTPUT_UNPACK = `${OUTPUT}.unpacked`;

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

// 2. Copy node_modules (including .node binaries — they stay in the stage so
//    createPackageWithOptions can mark them as unpacked in the asar header)
console.log('  Copying node_modules (may take a few seconds)...');
execSync(`cp -r "${path.join(ROOT, 'node_modules')}" "${path.join(STAGE, 'node_modules')}"`);

// 2b. Replace better-sqlite3 binary with the Electron-ABI prebuilt.
//     The source tree binary targets Node.js (for `npm run dev`); Electron 33
//     needs MODULE_VERSION 130 (N-API).  Download the prebuilt if not already
//     cached, then copy it into the staging tree.
(function installElectronSqlite3() {
  const SQLITE_VERSION = '12.9.0';
  const SQLITE_ABI     = '130';        // Electron 33
  const SQLITE_ARCH    = 'arm64';
  const SQLITE_PLAT    = 'darwin';
  const KNOWN_SIZE     = 1931680;      // bytes for this specific prebuilt

  const stageNode = path.join(STAGE, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node');
  const cacheNode = path.join(ROOT,  'dist', '.bsqlite3-electron-v130.node');

  // Use cached copy if size matches
  if (fs.existsSync(cacheNode) && fs.statSync(cacheNode).size === KNOWN_SIZE) {
    fs.copyFileSync(cacheNode, stageNode);
    console.log('  better-sqlite3: using cached Electron v130 prebuilt');
    return;
  }

  const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${SQLITE_VERSION}/better-sqlite3-v${SQLITE_VERSION}-electron-v${SQLITE_ABI}-${SQLITE_PLAT}-${SQLITE_ARCH}.tar.gz`;
  const tmpTgz    = path.join(ROOT, 'dist', '.bsqlite3-electron.tar.gz');
  const tmpUnpack = path.join(ROOT, 'dist', '.bsqlite3-unpack');

  console.log('  better-sqlite3: downloading Electron v130 prebuilt...');
  execSync(`curl -fsSL "${url}" -o "${tmpTgz}"`);
  fs.rmSync(tmpUnpack, { recursive: true, force: true });
  fs.mkdirSync(tmpUnpack, { recursive: true });
  execSync(`tar -xzf "${tmpTgz}" -C "${tmpUnpack}"`);

  const src = path.join(tmpUnpack, 'build/Release/better_sqlite3.node');
  fs.copyFileSync(src, cacheNode);   // cache for next run
  fs.copyFileSync(src, stageNode);   // inject into staging
  fs.rmSync(tmpUnpack, { recursive: true, force: true });
  fs.rmSync(tmpTgz, { force: true });
  console.log('  better-sqlite3: Electron v130 prebuilt installed in staging');
}());

// 3. Pack to asar, marking all .node binaries as "unpacked" so Electron reads
//    them from app.asar.unpacked rather than extracting them to a temp file.
console.log('  Packing asar...');
const asar = require('@electron/asar');
asar.createPackageWithOptions(STAGE, OUTPUT, { unpack: '*.node' }).then(() => {

  // 4. Replace installed asar
  console.log('  Replacing installed asar...');
  fs.copyFileSync(OUTPUT, ASAR);

  // 5. Replace app.asar.unpacked with the freshly generated unpacked directory
  if (fs.existsSync(OUTPUT_UNPACK)) {
    console.log('  Updating app.asar.unpacked...');
    fs.rmSync(ASAR_UNPACK, { recursive: true, force: true });
    // renameSync fails across volumes; use cp+rm instead
    execSync(`cp -r "${OUTPUT_UNPACK}" "${ASAR_UNPACK}"`);
    fs.rmSync(OUTPUT_UNPACK, { recursive: true, force: true });
  }

  // 6. Cleanup
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.rmSync(OUTPUT, { force: true });

  console.log(`\n✅ Updated: ${ASAR}`);
  console.log('   Quit and reopen "Seens Radio" to load the new code.');
}).catch(err => {
  console.error('asar pack failed:', err);
  process.exit(1);
});
