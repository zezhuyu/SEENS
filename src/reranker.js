/**
 * Optional reranker bridge for seens-radio.
 *
 * The reranker (seens-reranker module) is a completely separate component.
 * seens-radio works fully without it — this module simply bypasses gracefully
 * when the reranker is disabled or its server is not running.
 *
 * When enabled and reachable:
 *   1. DJ generates candidate tracks  (pass 1 — existing behaviour)
 *   2. Candidates sent here for reranking
 *   3. Reranked list returned to router
 *   4. Router sends reranked list back to DJ for final intro (pass 2)
 *
 * Enable via Settings → "Music Reranker" toggle or:
 *   POST /api/settings  { key: 'reranker.enabled', value: '1' }
 */

import { getPref }  from './state.js';
import { getWeatherContext } from './weather.js';

const RERANKER_URL     = process.env.RERANKER_URL ?? 'http://127.0.0.1:7480';
const CONNECT_TIMEOUT  = 3_000;   // ms — fast fail so the DJ isn't blocked
const RERANK_TIMEOUT   = 10_000;

// Track reachability to avoid hammering a down server every request
let _reachable  = null;   // null = unknown, true/false = known
let _lastProbe  = 0;
const PROBE_TTL = 30_000; // re-probe every 30 s

export function isRerankerEnabled() {
  return getPref('reranker.enabled', '0') === '1';
}

async function probe() {
  if (Date.now() - _lastProbe < PROBE_TTL && _reachable !== null) return _reachable;
  _lastProbe = Date.now();
  try {
    const res = await fetch(`${RERANKER_URL}/api/health`, {
      signal: AbortSignal.timeout(CONNECT_TIMEOUT),
    });
    _reachable = res.ok;
  } catch {
    _reachable = false;
  }
  return _reachable;
}

/**
 * Rerank a list of candidate tracks.
 *
 * @param {Array<{title,artist,source,uri?}>} candidates  — from djResponse.play
 * @param {object} contextOverrides  — optional: { mood, energy, weather_code, has_event }
 * @returns {Array|null}  ranked candidates (same shape) or null if reranker unavailable
 */
export async function rerank(candidates, contextOverrides = {}) {
  if (!candidates?.length) return null;
  if (!isRerankerEnabled()) return null;
  if (!await probe()) return null;

  // Build context — pull weather signal if available
  let weather_code = contextOverrides.weather_code ?? null;
  if (weather_code === null) {
    try {
      const wRaw = await getWeatherContext();
      const codeMatch = wRaw?.match(/\b(\d{1,3})\b/);
      if (codeMatch) weather_code = parseInt(codeMatch[1]);
    } catch { /* non-critical */ }
  }

  const now = new Date();
  const context = {
    time_of_day:  now.getHours() / 24,
    day_of_week:  now.getDay()   / 6,
    weather_code,
    mood:      contextOverrides.mood      ?? null,
    energy:    contextOverrides.energy    ?? null,
    has_event: contextOverrides.has_event ?? false,
  };

  // Map DJ track shape to reranker song shape
  const songs = candidates.map(t => ({
    id:     t.uri ?? `${t.title}___${t.artist}`,
    title:  t.title,
    artist: t.artist ?? '',
    source: t.source ?? 'any',
    // lyrics fallback so BGE can still embed without audio
    lyrics: `${t.title} ${t.artist}`,
  }));

  try {
    const res = await fetch(`${RERANKER_URL}/api/rerank`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ candidates: songs, context, top_k: songs.length }),
      signal:  AbortSignal.timeout(RERANK_TIMEOUT),
    });

    if (!res.ok) {
      console.warn('[Reranker] HTTP', res.status, '— bypassing');
      return null;
    }

    const { songs: ranked } = await res.json();

    // Map back to DJ track shape, preserving original fields
    const idMap = new Map(candidates.map(t => [t.uri ?? `${t.title}___${t.artist}`, t]));
    return ranked.map(r => {
      const orig = idMap.get(r.id) ?? { title: r.title, artist: r.artist, source: 'any' };
      return { ...orig, reranker_score: r.reranker_score, attention_weights: r.attention_weights };
    });
  } catch (err) {
    console.warn('[Reranker] request failed:', err.message, '— bypassing');
    _reachable = false;  // force re-probe next cycle
    _lastProbe = Date.now();
    return null;
  }
}

/**
 * Send playback feedback to the reranker (fire-and-forget).
 * Called by routes/feedback.js when user likes/skips a track.
 */
export async function sendFeedback(songId, event, context = null) {
  if (!isRerankerEnabled() || !await probe()) return;
  fetch(`${RERANKER_URL}/api/feedback`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ song_id: songId, event, context }),
    signal:  AbortSignal.timeout(3_000),
  }).catch(() => { /* non-critical */ });
}
