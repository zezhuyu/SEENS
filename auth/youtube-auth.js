import { google } from 'googleapis';
import { getPref, setPref } from '../src/state.js';

const REDIRECT_URI = `http://localhost:${process.env.PORT ?? 7477}/callback/youtube`;
const SCOPES = ['https://www.googleapis.com/auth/youtube.readonly'];

function createClient() {
  return new google.auth.OAuth2(
    process.env.YOUTUBE_CLIENT_ID,
    process.env.YOUTUBE_CLIENT_SECRET,
    REDIRECT_URI
  );
}

export function getAuthUrl() {
  if (!process.env.YOUTUBE_CLIENT_ID) throw new Error('YOUTUBE_CLIENT_ID not set in .env');
  return createClient().generateAuthUrl({ access_type: 'offline', scope: SCOPES });
}

export async function exchangeCode(code) {
  const client = createClient();
  const { tokens } = await client.getToken(code);
  saveTokens(tokens);
  return tokens;
}

export function getAuthenticatedClient() {
  const client = createClient();
  const accessToken = getPref('youtube.access_token');
  const refreshToken = getPref('youtube.refresh_token');
  if (!accessToken) throw new Error('YouTube not authenticated. Run npm run setup.');
  const expiryDate = parseInt(getPref('youtube.expires_at', '0')) || undefined;
  // Pass expiry_date so googleapis knows proactively when to refresh instead of
  // sending the expired token and waiting for a 401.
  client.setCredentials({ access_token: accessToken, refresh_token: refreshToken, expiry_date: expiryDate });
  client.on('tokens', saveTokens);
  return client;
}

function saveTokens(tokens) {
  if (tokens.access_token) setPref('youtube.access_token', tokens.access_token);
  if (tokens.refresh_token) setPref('youtube.refresh_token', tokens.refresh_token);
  if (tokens.expiry_date) setPref('youtube.expires_at', String(tokens.expiry_date));
}
