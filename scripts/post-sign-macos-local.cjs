const path = require('path');
const { signAsync } = require('@electron/osx-sign');

async function main() {
  const appPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(__dirname, '..', 'dist', 'mac-arm64', 'Seens Radio.app');
  const mainEntitlements = path.resolve(__dirname, '..', 'build', 'entitlements.mac.plist');
  const inheritEntitlements = path.resolve(__dirname, '..', 'build', 'entitlements.mac.inherit.plist');

  await signAsync({
    app: appPath,
    platform: 'darwin',
    identity: '-',
    identityValidation: false,
    preAutoEntitlements: false,
    optionsForFile: (filePath) => {
      if (path.resolve(filePath) === appPath) {
        return { entitlements: mainEntitlements };
      }

      if (filePath.endsWith('.app')) {
        return { entitlements: inheritEntitlements };
      }

      return null;
    },
  });

  console.log(`[mac-local] Ad-hoc signed ${appPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
