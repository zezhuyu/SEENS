/**
 * electron-builder afterPack hook — runs after the app is assembled but
 * before the DMG is created. Replaces the better-sqlite3 binary compiled
 * for the host Node.js with the Electron-ABI prebuilt so the packaged app
 * loads correctly.
 */

const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const { execSync } = require('child_process');

const VERSION  = '12.9.0';
const ABI      = '130';   // Electron 33
const ARCH     = 'arm64';
const PLAT     = 'darwin';
const KNOWN_MD5 = '461f221f7771de1682b049246114e885';

function md5(p) {
  return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
}

exports.default = async function afterPack({ appOutDir }) {
  const dest = path.join(
    appOutDir,
    'Seens Radio.app/Contents/Resources/app.asar.unpacked',
    'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  );

  if (!fs.existsSync(dest)) {
    console.warn('[afterPack] better_sqlite3.node not found at expected path:', dest);
    return;
  }

  if (md5(dest) === KNOWN_MD5) {
    console.log('[afterPack] better-sqlite3 Electron prebuilt already correct');
    return;
  }

  const ROOT  = path.resolve(__dirname, '..');
  const cache = path.join(ROOT, 'dist', `.bsqlite3-electron-v${ABI}.node`);

  if (fs.existsSync(cache) && md5(cache) === KNOWN_MD5) {
    fs.copyFileSync(cache, dest);
    console.log('[afterPack] better-sqlite3: Electron v130 prebuilt applied from cache');
    return;
  }

  const url     = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${VERSION}/better-sqlite3-v${VERSION}-electron-v${ABI}-${PLAT}-${ARCH}.tar.gz`;
  const tmpTgz  = path.join(ROOT, 'dist', '.bsqlite3-afterpack.tar.gz');
  const tmpDir  = path.join(ROOT, 'dist', '.bsqlite3-afterpack-unpack');

  console.log('[afterPack] better-sqlite3: downloading Electron v130 prebuilt...');
  fs.mkdirSync(path.dirname(tmpTgz), { recursive: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  execSync(`curl -fsSL "${url}" -o "${tmpTgz}"`);
  fs.mkdirSync(tmpDir, { recursive: true });
  execSync(`tar -xzf "${tmpTgz}" -C "${tmpDir}"`);

  const src = path.join(tmpDir, 'build/Release/better_sqlite3.node');
  fs.copyFileSync(src, cache);
  fs.copyFileSync(src, dest);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(tmpTgz, { force: true });
  console.log('[afterPack] better-sqlite3: Electron v130 prebuilt installed');
};
