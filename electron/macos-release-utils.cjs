const fs = require('fs');
const { execFileSync } = require('child_process');

function formatCommand(command, args) {
  return [command, ...args].join(' ');
}

function readCommand(command, args, { allowFailure = false } = {}) {
  try {
    const output = execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: output.trim() };
  } catch (error) {
    const stdout = error.stdout?.toString().trim() ?? '';
    const stderr = error.stderr?.toString().trim() ?? '';
    const detail = [stdout, stderr].filter(Boolean).join('\n');

    if (allowFailure) {
      return { ok: false, output: detail };
    }

    throw new Error(`[mac-release] ${formatCommand(command, args)} failed${detail ? `\n${detail}` : ''}`);
  }
}

function hasSigningIdentity() {
  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    return true;
  }

  const result = readCommand('security', ['find-identity', '-v', '-p', 'codesigning'], {
    allowFailure: true,
  });

  return result.ok && result.output.includes('Developer ID Application:');
}

function getNotarizeOptions() {
  if (process.env.APPLE_KEYCHAIN_PROFILE) {
    const options = { keychainProfile: process.env.APPLE_KEYCHAIN_PROFILE };
    if (process.env.APPLE_KEYCHAIN) {
      options.keychain = process.env.APPLE_KEYCHAIN;
    }
    return options;
  }

  if (process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID) {
    const options = {
      appleApiKey: process.env.APPLE_API_KEY,
      appleApiKeyId: process.env.APPLE_API_KEY_ID,
    };

    if (process.env.APPLE_API_ISSUER) {
      options.appleApiIssuer = process.env.APPLE_API_ISSUER;
    }

    return options;
  }

  if (
    process.env.APPLE_ID &&
    process.env.APPLE_TEAM_ID &&
    (process.env.APPLE_APP_SPECIFIC_PASSWORD || process.env.APPLE_APP_PASSWORD)
  ) {
    return {
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD || process.env.APPLE_APP_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    };
  }

  return null;
}

function assertMacReleasePrereqs() {
  if (process.platform !== 'darwin') {
    throw new Error('[mac-release] macOS release builds must run on macOS.');
  }

  if (!hasSigningIdentity()) {
    throw new Error(
      '[mac-release] Missing Developer ID Application signing identity. Set CSC_LINK/CSC_NAME or install a Developer ID Application certificate in Keychain. If you only need an unsigned local build, run npm run dist:mac:local instead.'
    );
  }

  if (!getNotarizeOptions()) {
    throw new Error(
      '[mac-release] Missing notarization credentials. Set APPLE_KEYCHAIN_PROFILE, APPLE_API_KEY + APPLE_API_KEY_ID, or APPLE_ID + APPLE_TEAM_ID + APPLE_APP_SPECIFIC_PASSWORD.'
    );
  }

  readCommand('xcrun', ['notarytool', '--version']);
}

function verifySignedApp(appPath) {
  if (!appPath || !fs.existsSync(appPath)) {
    throw new Error(`[mac-release] App not found: ${appPath}`);
  }

  readCommand('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  readCommand('spctl', ['--assess', '--type', 'execute', '-vv', appPath]);
  readCommand('xcrun', ['stapler', 'validate', appPath]);
}

module.exports = {
  assertMacReleasePrereqs,
  getNotarizeOptions,
  verifySignedApp,
};
