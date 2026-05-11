/**
 * Fetches background context for a track (song + artist) from Wikipedia.
 * Used to give the DJ factual material for introductions and transitions.
 * All calls are fire-and-forget with short timeouts — never blocks playback.
 */

const WIKI_AGENT = 'SeensRadio/1.0 (seens-radio-dj)';
const TIMEOUT_MS = 4000;

async function wikiPageSummary(pageTitle) {
  if (!pageTitle?.trim()) return null;
  try {
    const res = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pageTitle.trim())}`,
      { headers: { 'User-Agent': WIKI_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.extract?.trim() || null;
  } catch { return null; }
}

async function wikiSearchFirst(query) {
  if (!query?.trim()) return null;
  try {
    const params = new URLSearchParams({
      action: 'query', format: 'json', origin: '*',
      list: 'search', srsearch: query.trim(), srlimit: '3', srinfo: '', srprop: '',
    });
    const res = await fetch(
      `https://en.wikipedia.org/w/api.php?${params}`,
      { headers: { 'User-Agent': WIKI_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const firstTitle = data.query?.search?.[0]?.title;
    return firstTitle ? wikiPageSummary(firstTitle) : null;
  } catch { return null; }
}

/** Trim extract to a max length, cutting at sentence boundary. */
function trimExtract(text, maxLen) {
  if (!text) return null;
  text = text.trim();
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const dot = cut.lastIndexOf('. ');
  return dot > maxLen * 0.5 ? cut.slice(0, dot + 1) : cut + '…';
}

/**
 * Fetch Wikipedia background for a track — song article + artist article in parallel.
 * Returns a formatted string ready to inject into a DJ intro prompt, or null if nothing useful found.
 *
 * @param {string} title
 * @param {string} artist
 * @returns {Promise<string|null>}
 */
export async function fetchTrackContext(title, artist) {
  if (!title) return null;

  const [songResult, artistResult] = await Promise.allSettled([
    // Song: try "(song)" disambiguation → bare title → keyword search
    wikiPageSummary(`${title} (song)`)
      .then(r => r ?? wikiPageSummary(title))
      .then(r => r ?? wikiSearchFirst(artist ? `${title} ${artist} song` : `${title} song`)),

    // Artist: direct lookup → search
    artist
      ? wikiPageSummary(artist).then(r => r ?? wikiSearchFirst(`${artist} musician singer band`))
      : Promise.resolve(null),
  ]);

  const songInfo   = songResult.status   === 'fulfilled' ? songResult.value   : null;
  const artistInfo = artistResult.status === 'fulfilled' ? artistResult.value : null;

  if (!songInfo && !artistInfo) return null;

  const parts = [];
  if (songInfo)   parts.push(`SONG "${title}": ${trimExtract(songInfo, 500)}`);
  if (artistInfo) parts.push(`ARTIST "${artist}": ${trimExtract(artistInfo, 400)}`);

  return parts.join('\n\n');
}
