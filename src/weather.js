/**
 * Weather context — uses wttr.in (free, no API key).
 * Cached for 30 minutes. Returns a short string for the DJ system prompt.
 */

import { getPref } from './state.js';
import { getLocation } from './location.js';

let cache = null;
let cacheExpiry = 0;
const TTL = 30 * 60 * 1000;

const openMeteoCode = (code) => {
  if (code === 0) return 113;
  if ([1, 2].includes(code)) return 116;
  if (code === 3) return 122;
  if ([45, 48].includes(code)) return 248;
  if ([51, 53, 55].includes(code)) return 263;
  if ([56, 57].includes(code)) return 281;
  if ([61, 63].includes(code)) return 293;
  if (code === 65) return 305;
  if ([66, 67].includes(code)) return 311;
  if ([71, 73, 75].includes(code)) return 323;
  if (code === 77) return 227;
  if ([80, 81].includes(code)) return 353;
  if (code === 82) return 359;
  if (code === 95) return 389;
  if ([96, 99].includes(code)) return 395;
  return 122;
};

async function fetchOpenMeteo(location) {
  const geo = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`, { signal: AbortSignal.timeout(5000) });
  if (!geo.ok) return null;
  const place = (await geo.json()).results?.[0];
  if (!place) return null;
  const forecast = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,weather_code&timezone=auto`, { signal: AbortSignal.timeout(5000) });
  if (!forecast.ok) return null;
  const current = (await forecast.json()).current;
  if (!current || current.temperature_2m == null) return null;
  return {
    city: place.name,
    country: place.country ?? '',
    tempC: Number(current.temperature_2m),
    code: openMeteoCode(Number(current.weather_code)),
  };
}

export async function getWeather() {
  if (cache && Date.now() < cacheExpiry) return cache;
  const location = getLocation();
  if (!location) return null;

  try {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(location)}?format=j1`, {
      headers: { 'User-Agent': 'SeensRadio/1.0' }, signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      const current = data.current_condition?.[0];
      if (current) {
        const area = data.nearest_area?.[0];
        cache = { city: area?.areaName?.[0]?.value ?? location, country: area?.country?.[0]?.value ?? '', tempC: Number(current.temp_C), code: Number(current.weatherCode) };
        cacheExpiry = Date.now() + TTL;
        return cache;
      }
    }
  } catch (err) {
    console.warn('[Weather] wttr.in failed, trying Open-Meteo:', err.message);
  }

  try {
    cache = await fetchOpenMeteo(location);
    if (cache) cacheExpiry = Date.now() + TTL;
    return cache;
  } catch (err) {
    console.warn('[Weather] Open-Meteo failed:', err.message);
    return null;
  }
}

export async function getWeatherContext() {
  try {
    const weather = await getWeather();
    return weather ? `Weather in ${weather.city}${weather.country ? ', ' + weather.country : ''}: ${weather.tempC}°C` : null;
  } catch (err) {
    console.warn('[Weather] fetch failed:', err.message);
    return null;
  }
}

export function clearWeatherCache() { cache = null; cacheExpiry = 0; }
