import { randomBytes, createHash } from 'crypto';
import { getPref, setPref } from '../src/state.js';

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const REDIRECT_URI = `http://127.0.0.1:${process.env.PORT ?? 7477}/callback/spotify`;
const SCOPES = [
  'user-read-recently-played',
  'user-library-read',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-top-read',
].join(' ');

// Generate PKCE pair
export function generatePKCE() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function getAuthUrl(challenge) {
  if (!CLIENT_ID) throw new Error('SPOTIFY_CLIENT_ID not set in .env');
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}

export async function exchangeCode(code, verifier) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error(`Spotify token error: ${await res.text()}`);
  const data = await res.json();
  saveTokens(data);
  return data;
}

// In-flight refresh lock — prevents concurrent callers from each POSTing to
// Spotify with the same refresh_token. Spotify rotates tokens on first use;
// the second concurrent request would get "Failed to remove token".
let _refreshInFlight = null;

export async function getAccessToken() {
  const expiresAt = parseInt(getPref('spotify.expires_at', '0'));
  if (Date.now() < expiresAt - 30_000) {
    return getPref('spotify.access_token');
  }
  // If a refresh is already in progress, wait for it and return the new token.
  if (_refreshInFlight) return _refreshInFlight;

  const refreshToken = getPref('spotify.refresh_token');
  if (!refreshToken) throw new Error('Spotify not authenticated. Run npm run setup.');

  _refreshInFlight = (async () => {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) throw new Error(`Spotify refresh error: ${await res.text()}`);
    const data = await res.json();
    saveTokens(data);
    return data.access_token;
  })().finally(() => { _refreshInFlight = null; });

  return _refreshInFlight;
}

function saveTokens(data) {
  setPref('spotify.access_token', data.access_token);
  if (data.refresh_token) setPref('spotify.refresh_token', data.refresh_token);
  setPref('spotify.expires_at', String(Date.now() + data.expires_in * 1000));
}
