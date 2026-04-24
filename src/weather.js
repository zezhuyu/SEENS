/**
 * Weather context — uses wttr.in (free, no API key).
 * Cached for 30 minutes. Returns a short string for the DJ system prompt.
 */

import { getPref } from './state.js';

let cache = null;
let cacheExpiry = 0;
const TTL = 30 * 60 * 1000;

export async function getWeatherContext() {
  if (cache && Date.now() < cacheExpiry) return cache;

  const location = getPref('user.location', '').trim();
  if (!location) return null;

  try {
    const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'SeensRadio/1.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();

    const current = data.current_condition?.[0];
    if (!current) return null;

    const tempC   = current.temp_C;
    const tempF   = current.temp_F;
    const desc    = current.weatherDesc?.[0]?.value ?? '';
    const feels   = current.FeelsLikeC;
    const area    = data.nearest_area?.[0];
    const city    = area?.areaName?.[0]?.value ?? location;
    const country = area?.country?.[0]?.value ?? '';

    cache = `Weather in ${city}${country ? ', ' + country : ''}: ${desc}, ${tempC}°C / ${tempF}°F (feels like ${feels}°C)`;
    cacheExpiry = Date.now() + TTL;
    return cache;
  } catch (err) {
    console.warn('[Weather] fetch failed:', err.message);
    return null;
  }
}

export function clearWeatherCache() { cache = null; cacheExpiry = 0; }
