#!/usr/bin/env node
/**
 * Install the Electron 33 better-sqlite3 prebuilt into a packaged app output.
 *
 * This intentionally writes only to the provided app output path. Development
 * node_modules must keep the host Node.js binary used by `npm start`.
 */

const { execSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

function md5(filePath) {
  return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
}

const ROOT = path.resolve(__dirname, '..');
const DEST = process.argv[2] ? path.resolve(process.argv[2]) : null;
const VERSION = '12.9.0'; // must match package.json better-sqlite3 version
const ABI = '130';        // Electron 33
const ARCH = 'arm64';
const PLAT = 'darwin';
const KNOWN_MD5 = '461f221f7771de1682b049246114e885'; // Electron v130 arm64 prebuilt

if (!DEST) {
  console.error('Usage: node scripts/install-sqlite3-prebuilt.cjs <packaged better_sqlite3.node path>');
  process.exit(2);
}

const URL = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${VERSION}/better-sqlite3-v${VERSION}-electron-v${ABI}-${PLAT}-${ARCH}.tar.gz`;
const TMP_TGZ = path.join(ROOT, 'dist', '.bsqlite3-prebuilt.tar.gz');
const TMP_UNPACK = path.join(ROOT, 'dist', '.bsqlite3-unpack');
const CACHE = path.join(ROOT, 'dist', `.bsqlite3-electron-v${ABI}.node`);

// MD5 check is necessary — host Node.js binary may coincidentally match the Electron prebuilt's byte size
if (fs.existsSync(DEST) && md5(DEST) === KNOWN_MD5) {
  console.log('better-sqlite3 Electron prebuilt already present');
  process.exit(0);
}

fs.mkdirSync(path.dirname(DEST), { recursive: true });

if (fs.existsSync(CACHE) && md5(CACHE) === KNOWN_MD5) {
  fs.copyFileSync(CACHE, DEST);
  console.log('better-sqlite3 Electron prebuilt restored from cache');
  process.exit(0);
}

console.log(`Downloading better-sqlite3 v${VERSION} prebuilt for Electron ABI ${ABI}...`);
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

fs.copyFileSync(src, CACHE);
fs.copyFileSync(src, DEST);
fs.rmSync(TMP_UNPACK, { recursive: true, force: true });
fs.rmSync(TMP_TGZ, { force: true });

console.log('better-sqlite3 Electron prebuilt installed at', DEST);
