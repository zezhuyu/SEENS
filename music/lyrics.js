/**
 * Lyrics fetcher — lrclib.net (free, no auth, no rate-limit for reasonable use).
 *
 * API: GET https://lrclib.net/api/get?artist_name=X&track_name=Y
 * Returns { plainLyrics, syncedLyrics } or 404 when not found.
 *
 * Results are cached in memory for the process lifetime so repeated
 * DJ rerank calls for the same song don't hit the network twice.
 */

const LRCLIB_BASE = 'https://lrclib.net/api/get';
const FETCH_TIMEOUT_MS = 5_000;

const _cache = new Map(); // key → lyrics string | null

/**
 * Fetch plain-text lyrics for a track.
 * Returns the lyrics string, or null if not found / on error.
 */
export async function fetchLyrics(title, artist) {
  const key = `${title.toLowerCase()}__${(artist ?? '').toLowerCase()}`;
  if (_cache.has(key)) return _cache.get(key);

  try {
    const url = `${LRCLIB_BASE}?artist_name=${encodeURIComponent(artist ?? '')}&track_name=${encodeURIComponent(title)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) { _cache.set(key, null); return null; }
    const data = await res.json();
    // Prefer plain lyrics; strip timestamps from synced lyrics as fallback
    const lyrics = data.plainLyrics
      ?? data.syncedLyrics?.replace(/\[\d+:\d+\.\d+\]\s*/g, '').trim()
      ?? null;
    _cache.set(key, lyrics);
    return lyrics;
  } catch {
    _cache.set(key, null);
    return null;
  }
}

/**
 * Fetch lyrics for a batch of tracks in parallel.
 * Returns an array of lyrics strings (or nulls) in the same order.
 */
export async function fetchLyricsBatch(tracks) {
  return Promise.all(tracks.map(t => fetchLyrics(t.title, t.artist ?? '')));
}
