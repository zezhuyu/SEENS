const path = require('path');
const { verifySignedApp } = require('../electron/macos-release-utils.cjs');

const appPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, '..', 'dist', 'mac-arm64', 'Seens Radio.app');

verifySignedApp(appPath);
console.log(`[mac-release] Verified ${appPath}`);
