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
  const storedExpiry = parseInt(getPref('youtube.expires_at', '0'));
  // Pass expiry_date so googleapis knows proactively when to refresh instead of
  // sending the expired token and waiting for a 401.
  client.setCredentials({
    access_token:  accessToken,
    refresh_token: refreshToken,
    expiry_date:   storedExpiry > 0 ? storedExpiry : undefined,
  });
  client.on('tokens', saveTokens);
  return client;
}

// Explicit proactive refresh — used by the background token-refresh scheduler.
export async function refreshAccessToken() {
  if (!getPref('youtube.refresh_token')) throw new Error('YouTube not authenticated');
  const client = getAuthenticatedClient();
  const { credentials } = await client.refreshAccessToken();
  saveTokens(credentials);
  return credentials.access_token;
}

function saveTokens(tokens) {
  if (tokens.access_token) setPref('youtube.access_token', tokens.access_token);
  if (tokens.refresh_token) setPref('youtube.refresh_token', tokens.refresh_token);
  // Calculate expiry_date from expires_in when googleapis omits the field.
  const expiryDate = tokens.expiry_date
    ?? (tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null);
  if (expiryDate) setPref('youtube.expires_at', String(expiryDate));
}
