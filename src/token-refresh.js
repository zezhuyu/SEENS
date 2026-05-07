/**
 * Proactive background token refresh.
 *
 * Each service's access token lasts ~1 hour. Without proactive refresh the token
 * can expire while the app is idle (overnight), causing the first morning request
 * to race against a refresh — or fail entirely if error handling isn't perfect.
 *
 * This module refreshes all connected service tokens on startup and then every
 * 45 minutes, keeping them perpetually valid without user interaction.
 *
 * Apple Music user tokens are JWTs with a fixed expiry (~6 months) that cannot
 * be refreshed programmatically. We detect expiry, warn early, and clear the
 * stored token when it expires so the UI correctly shows it as disconnected.
 */

import { getPref, setPref } from './state.js';

const REFRESH_INTERVAL_MS  = 45 * 60 * 1000;  // check every 45 min (well before 1-hour expiry)
const PROACTIVE_BUFFER_MS  =  5 * 60 * 1000;  // refresh if expiring within 5 min
const APPLE_WARN_DAYS      = 7;               // warn this many days before Apple token expires

async function _refreshSpotify() {
  if (!getPref('spotify.refresh_token')) return;
  const expiresAt = parseInt(getPref('spotify.expires_at', '0'));
  if (expiresAt > 0 && Date.now() < expiresAt - PROACTIVE_BUFFER_MS) {
    console.log('[TokenRefresh] Spotify still valid');
    return;
  }
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
  const expiresAt = parseInt(getPref('youtube.expires_at', '0'));
  if (expiresAt > 0 && Date.now() < expiresAt - PROACTIVE_BUFFER_MS) {
    console.log('[TokenRefresh] YouTube still valid');
    return;
  }
  try {
    const { refreshAccessToken } = await import('../auth/youtube-auth.js');
    await refreshAccessToken();
    console.log('[TokenRefresh] YouTube ✓');
  } catch (err) {
    console.warn('[TokenRefresh] YouTube failed:', err.message);
  }
}

async function _refreshGoogle() {
  if (!getPref('google.refresh_token')) return;
  const expiresAt = parseInt(getPref('google.expires_at', '0'));
  if (expiresAt > 0 && Date.now() < expiresAt - PROACTIVE_BUFFER_MS) {
    console.log('[TokenRefresh] Google Calendar still valid');
    return;
  }
  try {
    const { getAccessToken } = await import('../auth/google-calendar-auth.js');
    await getAccessToken();
    console.log('[TokenRefresh] Google Calendar ✓');
  } catch (err) {
    console.warn('[TokenRefresh] Google Calendar failed:', err.message);
  }
}

async function _refreshMicrosoft() {
  if (!getPref('microsoft.refresh_token')) return;
  const expiresAt = parseInt(getPref('microsoft.expires_at', '0'));
  if (expiresAt > 0 && Date.now() < expiresAt - PROACTIVE_BUFFER_MS) {
    console.log('[TokenRefresh] Microsoft still valid');
    return;
  }
  try {
    const { getAccessToken } = await import('../auth/microsoft-auth.js');
    await getAccessToken();
    console.log('[TokenRefresh] Microsoft ✓');
  } catch (err) {
    console.warn('[TokenRefresh] Microsoft failed:', err.message);
  }
}

// Apple Music user tokens are JWTs with a fixed expiry — cannot be refreshed.
// Detect expiry from the stored timestamp, warn early, and clear when expired.
async function _checkApple() {
  const token = getPref('apple.user_token');
  if (!token) return;

  const expiresAt = parseInt(getPref('apple.user_token_expires_at', '0'));
  if (!expiresAt) return;

  const msLeft  = expiresAt - Date.now();
  const daysLeft = msLeft / (24 * 60 * 60 * 1000);

  if (msLeft <= 0) {
    setPref('apple.user_token', '');
    setPref('apple.user_token_expires_at', '0');
    console.warn('[TokenRefresh] Apple Music user token expired — cleared. User must reconnect via Settings.');
  } else if (daysLeft <= APPLE_WARN_DAYS) {
    console.warn(`[TokenRefresh] Apple Music token expires in ${Math.ceil(daysLeft)} day(s) — user should reconnect via Settings.`);
  } else {
    console.log(`[TokenRefresh] Apple Music ✓ (${Math.floor(daysLeft)}d remaining)`);
  }
}

async function refreshAll() {
  await Promise.allSettled([
    _refreshSpotify(),
    _refreshYouTube(),
    _refreshGoogle(),
    _refreshMicrosoft(),
    _checkApple(),
  ]);
}

/**
 * Start the background token refresh loop.
 * Runs immediately (after a short startup delay) then every 45 minutes.
 */
export function startTokenRefresh() {
  setTimeout(async () => {
    console.log('[TokenRefresh] Running proactive token refresh…');
    await refreshAll();
    setInterval(() => {
      console.log('[TokenRefresh] Periodic token refresh…');
      refreshAll().catch(() => {});
    }, REFRESH_INTERVAL_MS);
  }, 10_000);
}
