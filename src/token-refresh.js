/**
 * Proactive background token refresh.
 *
 * Each service's access token lasts ~1 hour. Without proactive refresh the token
 * can expire while the app is idle (overnight), causing the first morning request
 * to race against a refresh — or fail entirely if error handling isn't perfect.
 *
 * This module refreshes all connected service tokens on startup and then every
 * 45 minutes, keeping them perpetually valid without user interaction.
 */

import { getPref } from './state.js';

const REFRESH_INTERVAL_MS = 45 * 60 * 1000; // 45 min — well before the 1-hour expiry

async function _refreshSpotify() {
  if (!getPref('spotify.refresh_token')) return;
  try {
    const { getAccessToken } = await import('../auth/spotify-auth.js');
    await getAccessToken();
    console.log('[TokenRefresh] Spotify ✓');
  } catch (err) {
    console.warn('[TokenRefresh] Spotify failed:', err.message);
  }
}

async function _refreshYouTube() {
  if (!getPref('youtube.refresh_token')) return;
  try {
    // Force a refresh by clearing the stored expiry so getAuthenticatedClient returns
    // a client that googleapis will immediately refresh on the next API call.
    // Simpler: call the googleapis refreshAccessToken directly.
    const { getAuthenticatedClient } = await import('../auth/youtube-auth.js');
    const client = getAuthenticatedClient();
    await client.getAccessToken(); // triggers refresh if expired
    console.log('[TokenRefresh] YouTube ✓');
  } catch (err) {
    console.warn('[TokenRefresh] YouTube failed:', err.message);
  }
}

async function _refreshGoogle() {
  if (!getPref('google.refresh_token')) return;
  try {
    const expiresAt = parseInt(getPref('google.expires_at', '0'));
    if (Date.now() < expiresAt - 2 * 60 * 1000) { console.log('[TokenRefresh] Google still valid'); return; }
    // Import getAccessToken indirectly — it's not exported, but getTodayEvents calls it.
    // The in-flight lock in google-calendar-auth.js ensures no concurrent refresh race.
    const { getTodayEvents } = await import('../auth/google-calendar-auth.js');
    await getTodayEvents().catch(() => {});
    console.log('[TokenRefresh] Google ✓');
  } catch (err) {
    console.warn('[TokenRefresh] Google failed:', err.message);
  }
}

async function _refreshMicrosoft() {
  if (!getPref('microsoft.refresh_token')) return;
  try {
    const expiresAt = parseInt(getPref('microsoft.expires_at', '0'));
    if (Date.now() < expiresAt - 2 * 60 * 1000) { console.log('[TokenRefresh] Microsoft still valid'); return; }
    const { getTodayEvents } = await import('../auth/microsoft-auth.js');
    await getTodayEvents().catch(() => {});
    console.log('[TokenRefresh] Microsoft ✓');
  } catch (err) {
    console.warn('[TokenRefresh] Microsoft failed:', err.message);
  }
}

async function refreshAll() {
  await Promise.allSettled([
    _refreshSpotify(),
    _refreshYouTube(),
    _refreshGoogle(),
    _refreshMicrosoft(),
  ]);
}

/**
 * Start the background token refresh loop.
 * Runs immediately (after a short startup delay) then every 45 minutes.
 */
export function startTokenRefresh() {
  // Delay first run so server startup doesn't race with DB initialization.
  setTimeout(async () => {
    console.log('[TokenRefresh] Running proactive token refresh…');
    await refreshAll();
    setInterval(() => {
      console.log('[TokenRefresh] Periodic token refresh…');
      refreshAll().catch(() => {});
    }, REFRESH_INTERVAL_MS);
  }, 10_000);
}
