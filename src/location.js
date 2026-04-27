/**
 * Background location detection — runs at startup and refreshes every hour.
 *
 * Uses ip-api.com (free, no key) for IP-based city detection.
 * Result is stored in pref "user.location.auto" and never overwrites a
 * manually pinned location ("user.location.pinned" = '1').
 *
 * weather.js and context.js fall back to the auto value when no manual
 * location has been saved.
 */

import { getPref, setPref } from './state.js';

const REFRESH_INTERVAL = 60 * 60 * 1000; // 1 hour

async function detectFromIP() {
  const res = await fetch(
    'http://ip-api.com/json/?fields=status,city,regionName,country,lat,lon',
    { signal: AbortSignal.timeout(8_000) }
  );
  if (!res.ok) return null;
  const data = await res.json();
  if (data.status !== 'success' || !data.city) return null;
  return `${data.city}${data.country ? ', ' + data.country : ''}`;
}

export async function refreshAutoLocation() {
  // Don't overwrite a location the user pinned manually
  if (getPref('user.location.pinned', '') === '1') return;

  try {
    const loc = await detectFromIP();
    if (!loc) return;

    const prev = getPref('user.location.auto', '');
    if (loc === prev) return;

    setPref('user.location.auto', loc);
    import('./weather.js').then(({ clearWeatherCache }) => clearWeatherCache());
    console.log(`[Location] auto-detected: ${loc}`);
  } catch (err) {
    console.warn('[Location] IP detection failed:', err.message);
  }
}

export function startLocationRefresh() {
  refreshAutoLocation();
  setInterval(refreshAutoLocation, REFRESH_INTERVAL);
}

// Returns the best available location string: manual > auto > ''
export function getLocation() {
  return getPref('user.location', '').trim() || getPref('user.location.auto', '').trim();
}
