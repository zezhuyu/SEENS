# macOS Release Checklist

`Seens Radio.app` must be signed with `Developer ID Application` and notarized before distribution. If either step is skipped, Gatekeeper can show the "contains malware" warning.

## Required signing inputs

Provide one signing source:

- `CSC_LINK` or `CSC_NAME`
- A `Developer ID Application` certificate installed in Keychain

## Required notarization inputs

Provide one notarization strategy:

- `APPLE_KEYCHAIN_PROFILE`
- `APPLE_API_KEY` + `APPLE_API_KEY_ID` with optional `APPLE_API_ISSUER`
- `APPLE_ID` + `APPLE_TEAM_ID` + `APPLE_APP_SPECIFIC_PASSWORD`

## Build commands

```bash
npm run dist:mac
npm run dist:mac:release
npm run verify:mac-app
```

`npm run dist:mac` now creates a local ad-hoc signed app bundle in `dist/mac-arm64/` for testing on a developer machine without Apple release credentials.

`npm run dist:mac:release` keeps the strict release gate. It fails early if signing or notarization is missing, and the notarization hook validates:

- `codesign --verify --deep --strict`
- `spctl --assess --type execute -vv`
- `xcrun stapler validate`

If you previously copied an older unsigned or unnotarized `Seens Radio.app` into `/Applications`, remove that copy before testing a new build.
