import fs from 'fs';
import { createSign } from 'crypto';
import { getPref, setPref } from '../src/state.js';

// Generate a MusicKit developer token (valid 6 months)
export function getDeveloperToken() {
  const cached = getPref('apple.developer_token');
  const expiresAt = parseInt(getPref('apple.token_expires_at', '0'));
  if (cached && Date.now() < expiresAt - 86_400_000) return cached; // 1 day buffer

  const keyId = process.env.APPLE_KEY_ID;
  const teamId = process.env.APPLE_TEAM_ID;
  const keyPath = process.env.APPLE_PRIVATE_KEY_PATH;

  if (!keyId || !teamId || !keyPath) {
    throw new Error('Apple Music not configured. Set APPLE_KEY_ID, APPLE_TEAM_ID, APPLE_PRIVATE_KEY_PATH in .env');
  }

  const privateKey = fs.readFileSync(keyPath, 'utf8');
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 15_552_000; // 180 days

  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: teamId, iat: now, exp })).toString('base64url');
  const signingInput = `${header}.${payload}`;

  const sign = createSign('SHA256');
  sign.update(signingInput);
  const sig = sign.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');

  const token = `${signingInput}.${sig}`;
  setPref('apple.developer_token', token);
  setPref('apple.token_expires_at', String(exp * 1000));
  return token;
}

// User token is obtained via MusicKit JS in the browser
// The PWA posts it to /api/apple-token and we store it here
export function saveUserToken(token) {
  setPref('apple.user_token', token);
}

export function getUserToken() {
  return getPref('apple.user_token');
}
