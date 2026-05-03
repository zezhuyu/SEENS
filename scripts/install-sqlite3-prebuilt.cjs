#!/usr/bin/env node
/**
 * Install the correct better-sqlite3 prebuilt binary for Electron 33 (N-API v130).
 *
 * electron-rebuild compiles against system Node.js headers (v137) instead of
 * Electron headers, producing a binary that crashes with ERR_DLOPEN_FAILED.
 * This script downloads the official prebuilt from the better-sqlite3 GitHub
 * releases and puts it in the right place.
 *
 * Run via: npm run fix:sqlite3
 */

const { execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');
const https = require('https');

const ROOT    = path.resolve(__dirname, '..');
const DEST    = path.join(ROOT, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node');
const VERSION = '12.9.0';   // must match package.json better-sqlite3 version
const ABI     = '130';      // Electron 33 N-API version
const ARCH    = 'arm64';
const PLAT    = 'darwin';

const URL = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${VERSION}/better-sqlite3-v${VERSION}-electron-v${ABI}-${PLAT}-${ARCH}.tar.gz`;
const TMP_TGZ   = path.join(ROOT, 'dist', '.bsqlite3-prebuilt.tar.gz');
const TMP_UNPACK = path.join(ROOT, 'dist', '.bsqlite3-unpack');

// Check if the current binary is already the correct version by seeing if
// Electron can load it (quick heuristic: file size matches known prebuilt).
const KNOWN_SIZE = 1931680; // bytes for v12.9.0 electron-v130-darwin-arm64
if (fs.existsSync(DEST) && fs.statSync(DEST).size === KNOWN_SIZE) {
  console.log('✔ better-sqlite3 prebuilt already correct (v130)');
  process.exit(0);
}

console.log(`⬇  Downloading better-sqlite3 v${VERSION} prebuilt for Electron v${ABI}…`);
fs.mkdirSync(path.dirname(TMP_TGZ), { recursive: true });
fs.rmSync(TMP_UNPACK, { recursive: true, force: true });

execSync(`curl -fsSL "${URL}" -o "${TMP_TGZ}"`, { stdio: 'inherit' });
fs.mkdirSync(TMP_UNPACK, { recursive: true });
execSync(`tar -xzf "${TMP_TGZ}" -C "${TMP_UNPACK}"`, { stdio: 'inherit' });

const src = path.join(TMP_UNPACK, 'build/Release/better_sqlite3.node');
if (!fs.existsSync(src)) {
  console.error('Prebuilt binary not found in archive at:', src);
  process.exit(1);
}

fs.mkdirSync(path.dirname(DEST), { recursive: true });
fs.copyFileSync(src, DEST);
fs.rmSync(TMP_UNPACK, { recursive: true, force: true });
fs.rmSync(TMP_TGZ, { force: true });

console.log('✅ better-sqlite3 v130 prebuilt installed at', DEST);
