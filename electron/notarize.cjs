const path = require('path');
const { notarize } = require('@electron/notarize');
const { getNotarizeOptions, verifySignedApp } = require('./macos-release-utils.cjs');

exports.default = async function notarizeApp(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  if (process.env.SKIP_MAC_NOTARIZE === '1') {
    console.log('[notarize] Skipping notarization for local mac build.');
    return;
  }

  const options = getNotarizeOptions();
  if (!options) {
    throw new Error(
      '[notarize] Missing notarization credentials. Set APPLE_KEYCHAIN_PROFILE, APPLE_API_KEY + APPLE_API_KEY_ID, or APPLE_ID + APPLE_TEAM_ID + APPLE_APP_SPECIFIC_PASSWORD.'
    );
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`[notarize] Submitting ${appPath}`);
  await notarize({
    appPath,
    ...options,
  });
  verifySignedApp(appPath);
  console.log(`[notarize] Completed for ${appName}`);
};

exports.getNotarizeOptions = getNotarizeOptions;
