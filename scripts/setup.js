#!/usr/bin/env node
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';
import readline from 'readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(r => rl.question(q, r));

console.log('\n🎙  Seens Radio — First-time Setup\n');

// ─── Check .env ────────────────────────────────────────────────────────────
const envPath = path.join(ROOT, '.env');
if (!fs.existsSync(envPath)) {
  fs.copyFileSync(path.join(ROOT, '.env.example'), envPath);
  console.log('✓ Created .env from .env.example');
  console.log('\n⚠  Open .env and add your API keys before continuing.');
  console.log('   Required: ANTHROPIC_API_KEY (for Claude) or OPENAI_API_KEY (for Codex)');
  console.log('   Optional: SPOTIFY_CLIENT_ID, YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET\n');
  const cont = await ask('Press Enter after editing .env, or Ctrl+C to exit: ');
}

// ─── Check Node deps ────────────────────────────────────────────────────────
if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
  console.log('\n📦 Installing dependencies...');
  execSync('npm install', { cwd: ROOT, stdio: 'inherit' });
}

// ─── Create required dirs ───────────────────────────────────────────────────
['tts-cache', 'data', 'USER'].forEach(d => {
  fs.mkdirSync(path.join(ROOT, d), { recursive: true });
});
console.log('✓ Directories ready');

// ─── Test TTS ──────────────────────────────────────────────────────────────
console.log('\n🔊 Testing TTS (macOS say command)...');
try {
  execSync(`say -v Samantha "Seens Radio is ready"`, { timeout: 10000 });
  console.log('✓ TTS working');
} catch {
  console.warn('⚠  TTS test failed — is this macOS?');
}

// ─── OAuth flows ────────────────────────────────────────────────────────────
const doSpotify = process.env.SPOTIFY_CLIENT_ID;
const doYouTube = process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET;

if (doSpotify || doYouTube) {
  console.log('\n🎵 Starting OAuth flows...\n');

  // Start callback server temporarily
  const callbackServer = spawn('node', ['-e', `
    import('dotenv/config').then(() =>
      import('./auth/callback-server.js').then(async m => {
        if (${doSpotify ? 'true' : 'false'}) await m.runOAuthFlow('spotify').catch(e => console.error('Spotify:', e.message));
        if (${doYouTube ? 'true' : 'false'}) await m.runOAuthFlow('youtube').catch(e => console.error('YouTube:', e.message));
        process.exit(0);
      })
    );
  `], { cwd: ROOT, stdio: 'inherit' });

  await new Promise(r => callbackServer.on('exit', r));
}

// ─── Done ───────────────────────────────────────────────────────────────────
console.log('\n✅ Setup complete!\n');
console.log('To start Seens Radio:  npm start');
console.log('To sync music:         npm run sync');
console.log('To install at login:   npm run install-agent');
console.log('Open in browser:       http://localhost:8080\n');

rl.close();
process.exit(0);
