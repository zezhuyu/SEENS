/**
 * Google Calendar OAuth2 (auth code + client secret flow).
 * Env vars required: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 * Redirect URI registered in Google Cloud Console:
 *   http://localhost:<PORT>/callback/google
 */

import { getPref, setPref } from '../src/state.js';

const BASE = 'http://localhost';
const PORT = process.env.PORT ?? 8080;
const REDIRECT_URI = `${BASE}:${PORT}/callback/google`;
const SCOPES = 'https://www.googleapis.com/auth/calendar.readonly';

export function getAuthUrl() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID not set in .env');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function exchangeCode(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`Google token error: ${await res.text()}`);
  const data = await res.json();
  setPref('google.access_token', data.access_token);
  if (data.refresh_token) setPref('google.refresh_token', data.refresh_token);
  setPref('google.expires_at', String(Date.now() + data.expires_in * 1000));
  return data;
}

let _refreshInFlight = null;

async function getAccessToken() {
  const expiresAt = parseInt(getPref('google.expires_at', '0'));
  if (Date.now() < expiresAt - 30_000) return getPref('google.access_token');

  if (_refreshInFlight) return _refreshInFlight;

  const refreshToken = getPref('google.refresh_token');
  if (!refreshToken) throw new Error('Google Calendar not authenticated');

  _refreshInFlight = (async () => {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) throw new Error(`Google refresh error: ${await res.text()}`);
    const data = await res.json();
    setPref('google.access_token', data.access_token);
    setPref('google.expires_at', String(Date.now() + data.expires_in * 1000));
    return data.access_token;
  })().finally(() => { _refreshInFlight = null; });

  return _refreshInFlight;
}

// Returns today's events as a short summary string
export async function getTodayEvents() {
  const token = await getAccessToken();
  const now = new Date();
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  const endOfDay   = new Date(now); endOfDay.setHours(23, 59, 59, 999);

  const params = new URLSearchParams({
    timeMin: startOfDay.toISOString(),
    timeMax: endOfDay.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '8',
  });

  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Google Calendar events error: ${await res.text()}`);
  const data = await res.json();
  return formatEvents(data.items ?? [], 'Google');
}

function formatEvents(items, source) {
  if (!items.length) return null;
  const lines = items.map(e => {
    const start = e.start?.dateTime
      ? new Date(e.start.dateTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
      : 'all day';
    return `  ${start}: ${e.summary ?? '(no title)'}`;
  });
  return `${source} Calendar — today:\n${lines.join('\n')}`;
}
