/**
 * /api/widget  — lightweight snapshot for the macOS Notification Centre widget.
 * Returns: session state, now playing, up-next queue, work/rest minutes, weather.
 * Designed to respond in < 200 ms so the widget timeline provider is never blocked.
 */

import express from 'express';
import { getPref, getRecentPlays, peekNext, getSessionMoodLabel } from '../src/state.js';
import { getWeatherContext } from '../src/weather.js';

const router = express.Router();

/** Parse the DJ weather string into a compact { temp, desc } object. */
function parseWeather(str) {
  if (!str) return null;
  // "Weather in City, Country: Partly cloudy, 18°C / 65°F (feels like 16°C)"
  const descMatch = str.match(/:\s*([^,]+),/);
  const tempMatch  = str.match(/([\d.-]+)°C/);
  if (!descMatch || !tempMatch) return null;
  return {
    desc: descMatch[1].trim(),
    temp: `${Math.round(parseFloat(tempMatch[1]))}°`,
  };
}

router.get('/', async (req, res) => {
  // Fetch weather with a tight timeout — don't block the widget response
  const weatherStr = await Promise.race([
    getWeatherContext().catch(() => null),
    new Promise(resolve => setTimeout(() => resolve(null), 800)),
  ]);

  const sessionStartedAt = parseInt(getPref('session.started_at', '0')) || 0;
  const queued = peekNext(9);

  // Filter plays to the current session only (played_at >= session start).
  // This prevents a track from a previous session leaking in as nowPlaying.
  const recentPlays = sessionStartedAt > 0
    ? getRecentPlays(5).filter(p => p.played_at >= sessionStartedAt)
    : [];
  const [lastPlayed] = recentPlays;

  // Session is "active" only if explicitly started AND not stale.
  // Staleness: no queue tracks remaining AND last play was > 10 minutes ago.
  const tenMinAgo = Math.floor(Date.now() / 1000) - 10 * 60;
  const recentlyPlayed = lastPlayed && lastPlayed.played_at >= tenMinAgo;
  const sessionActive = sessionStartedAt > 0 && !!(queued.length > 0 || recentlyPlayed);

  // work / rest minutes — stored by the server when the iOS app syncs them,
  // otherwise falls back to the defaults used across the project.
  const workMinutes = parseInt(getPref('session.workMin', '45')) || 45;
  const restMinutes = parseInt(getPref('session.restMin', '5'))  || 5;
  const moodLabel   = getSessionMoodLabel() || null;

  // Build now-playing object
  const np = lastPlayed
    ? {
        title:      lastPlayed.resolvedTitle  ?? lastPlayed.title,
        artist:     lastPlayed.resolvedArtist ?? lastPlayed.artist ?? null,
        artworkUrl: lastPlayed.artworkUrl     ?? null,
      }
    : queued[0]
      ? {
          title:      queued[0].resolved_title  ?? queued[0].title,
          artist:     queued[0].resolved_artist ?? queued[0].artist ?? null,
          artworkUrl: queued[0].artwork_url     ?? null,
        }
      : null;

  // Queue list (skip the currently-playing entry if it came from queued[0])
  const queueStart = (!lastPlayed && queued.length > 0) ? 1 : 0;
  const queue = queued.slice(queueStart, queueStart + 8).map(t => ({
    title:      t.resolved_title  ?? t.title,
    artist:     t.resolved_artist ?? t.artist ?? null,
    artworkUrl: t.artwork_url     ?? null,
  }));

  res.json({
    sessionActive,
    sessionStartedAt: sessionActive && sessionStartedAt ? sessionStartedAt : null,
    workMinutes,
    restMinutes,
    moodLabel,
    nowPlaying: np,
    queue,
    weather: parseWeather(weatherStr),
  });
});

export default router;
