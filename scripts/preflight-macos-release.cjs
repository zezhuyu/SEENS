const { assertMacReleasePrereqs } = require('../electron/macos-release-utils.cjs');

assertMacReleasePrereqs();
console.log('[mac-release] Signing + notarization prerequisites look good.');
