/**
 * Microsoft/Outlook Calendar OAuth2 (auth code flow via Microsoft identity platform).
 * Env vars required: MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET
 * Redirect URI registered in Azure Portal (App registrations):
 *   http://localhost:<PORT>/callback/microsoft
 *
 * Azure setup: Single-tenant or multi-tenant app, platform = Web,
 * redirect URI = http://localhost:8080/callback/microsoft
 */

import { getPref, setPref } from '../src/state.js';

const PORT = process.env.PORT ?? 8080;
const REDIRECT_URI = `http://localhost:${PORT}/callback/microsoft`;
const TENANT = process.env.MICROSOFT_TENANT_ID ?? 'common';
const SCOPES = 'Calendars.Read offline_access User.Read';

export function getAuthUrl() {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  if (!clientId) throw new Error('MICROSOFT_CLIENT_ID not set in .env');
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    response_mode: 'query',
  });
  return `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize?${params}`;
}

export async function exchangeCode(code) {
  const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
      scope: SCOPES,
    }),
  });
  if (!res.ok) throw new Error(`Microsoft token error: ${await res.text()}`);
  const data = await res.json();
  setPref('microsoft.access_token', data.access_token);
  if (data.refresh_token) setPref('microsoft.refresh_token', data.refresh_token);
  setPref('microsoft.expires_at', String(Date.now() + data.expires_in * 1000));
  return data;
}

async function getAccessToken() {
  const expiresAt = parseInt(getPref('microsoft.expires_at', '0'));
  if (Date.now() < expiresAt - 30_000) return getPref('microsoft.access_token');

  const refreshToken = getPref('microsoft.refresh_token');
  if (!refreshToken) throw new Error('Microsoft Calendar not authenticated');

  const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: SCOPES,
    }),
  });
  if (!res.ok) throw new Error(`Microsoft refresh error: ${await res.text()}`);
  const data = await res.json();
  setPref('microsoft.access_token', data.access_token);
  setPref('microsoft.expires_at', String(Date.now() + data.expires_in * 1000));
  return data.access_token;
}

export async function getTodayEvents() {
  const token = await getAccessToken();
  const now = new Date();
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  const endOfDay   = new Date(now); endOfDay.setHours(23, 59, 59, 999);

  const params = new URLSearchParams({
    startDateTime: startOfDay.toISOString(),
    endDateTime: endOfDay.toISOString(),
    $select: 'subject,start,end,isAllDay',
    $orderby: 'start/dateTime',
    $top: '8',
  });

  const res = await fetch(`https://graph.microsoft.com/v1.0/me/calendarView?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Microsoft Calendar events error: ${await res.text()}`);
  const data = await res.json();

  const items = data.value ?? [];
  if (!items.length) return null;
  const lines = items.map(e => {
    const start = e.isAllDay
      ? 'all day'
      : new Date(e.start.dateTime + 'Z').toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    return `  ${start}: ${e.subject ?? '(no title)'}`;
  });
  return `Outlook Calendar — today:\n${lines.join('\n')}`;
}
