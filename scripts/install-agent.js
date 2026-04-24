#!/usr/bin/env node
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const LABEL = 'com.sam.seens-radio';
const AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const PLIST_DEST = path.join(AGENTS_DIR, `${LABEL}.plist`);
const NODE_BIN = execSync('which node').toString().trim();

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>WorkingDirectory</key>
  <string>${ROOT}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${os.homedir()}</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>

  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${path.join(ROOT, 'server.js')}</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/tmp/seens-radio.out.log</string>

  <key>StandardErrorPath</key>
  <string>/tmp/seens-radio.err.log</string>
</dict>
</plist>`;

fs.mkdirSync(AGENTS_DIR, { recursive: true });
fs.writeFileSync(PLIST_DEST, plist);
console.log(`✓ Wrote ${PLIST_DEST}`);

// Unload if already loaded
try { execSync(`launchctl unload "${PLIST_DEST}" 2>/dev/null`); } catch { /* ok */ }
execSync(`launchctl load "${PLIST_DEST}"`);
console.log('✓ LaunchAgent loaded — Seens Radio will start at login');

// Verify
const status = execSync(`launchctl list | grep seens-radio || echo "not found"`).toString().trim();
console.log(`Status: ${status}`);
