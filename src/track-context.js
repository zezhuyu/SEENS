/**
 * Fetches background context for a track (song + artist) from Wikipedia.
 * Used to give the DJ factual material for introductions and transitions.
 * All calls are fire-and-forget with short timeouts — never blocks playback.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const WIKI_AGENT = 'SeensRadio/1.0 (seens-radio-dj)';
const TIMEOUT_MS = 4000;
const execFileAsync = promisify(execFile);

async function fetchWikipediaJson(url) {
  const nativeFetch = fetch(url, {
      headers: { 'User-Agent': WIKI_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    .then(res => res.ok ? res.json() : null)
    .catch(() => null);
  const localCurl = execFileAsync('/usr/bin/curl', [
      '--silent', '--show-error', '--fail', '--location',
      '--max-time', '2', '--user-agent', WIKI_AGENT, url,
    ], { timeout: 2500, maxBuffer: 512 * 1024 })
    .then(({ stdout }) => JSON.parse(stdout))
    .catch(() => null);

  // Electron's fetch can stall on DNS/proxy discovery even when curl has the
  // answer in a few hundred milliseconds. Both hit the identical endpoint, so
  // the first transport to finish is sufficient and keeps this path bounded.
  return Promise.race([nativeFetch, localCurl]);
}

export function wikipediaFactFromContext(context, maxWords = 24) {
  if (!context) return null;
  const blocks = context.split(/\n\n+/);
  const preferred = blocks.find(block => block.startsWith('SONG ')) ?? blocks[0];
  const summary = preferred?.slice(preferred.indexOf(':') + 1).trim();
  if (!summary) return null;
  const sentence = summary.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? summary;
  const words = sentence.split(/\s+/);
  const clipped = words.length > maxWords
    ? `${words.slice(0, maxWords).join(' ').replace(/[,:;]$/, '')}…`
    : sentence;
  return clipped;
}

export function appendWikipediaFact(say, context) {
  const fact = wikipediaFactFromContext(context);
  if (!fact || String(say ?? '').toLowerCase().includes(fact.toLowerCase())) {
    return { say: String(say ?? ''), changed: false };
  }
  return {
    say: `${String(say ?? '').trim()} Wikipedia notes: ${fact}`.trim(),
    changed: true,
  };
}

async function wikiPageSummary(pageTitle) {
  if (!pageTitle?.trim()) return null;
  const data = await fetchWikipediaJson(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pageTitle.trim())}`,
  );
  return data?.extract?.trim() || null;
}

async function wikiSearchFirst(query) {
  if (!query?.trim()) return null;
  const params = new URLSearchParams({
    action: 'query', format: 'json', origin: '*',
    list: 'search', srsearch: query.trim(), srlimit: '3', srinfo: '', srprop: '',
  });
  const data = await fetchWikipediaJson(`https://en.wikipedia.org/w/api.php?${params}`);
  const firstTitle = data?.query?.search?.[0]?.title;
  return firstTitle ? wikiPageSummary(firstTitle) : null;
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

function artistMatchesSummary(summary, artist) {
  if (!summary || !artist) return true;
  const tokens = artist.toLowerCase().match(/[\p{L}\p{N}]+/gu)
    ?.filter(token => token.length > 2 && !['the', 'and', 'band'].includes(token)) ?? [];
  if (!tokens.length) return true;
  const haystack = summary.toLowerCase();
  return tokens.every(token => haystack.includes(token));
}

function formatTrackContext(title, artist, rawSongInfo, rawArtistInfo) {
  const songInfo = artistMatchesSummary(rawSongInfo, artist) ? rawSongInfo : null;
  const artistInfo = artistMatchesSummary(rawArtistInfo, artist) ? rawArtistInfo : null;
  if (!songInfo && !artistInfo) return null;

  const parts = [];
  if (songInfo) parts.push(`SONG "${title}": ${trimExtract(songInfo, 500)}`);
  if (artistInfo) parts.push(`ARTIST "${artist}": ${trimExtract(artistInfo, 400)}`);
  return parts.join('\n\n');
}

/**
 * One-round-trip Wikipedia lookup used to choose among cached reranker picks.
 * It intentionally avoids search fallbacks so several candidates can be
 * checked in parallel without turning startup into a serial research pass.
 */
export async function fetchDirectTrackContext(title, artist) {
  if (!title) return null;
  const [songResult, artistResult] = await Promise.allSettled([
    wikiPageSummary(`${title} (song)`),
    artist ? wikiPageSummary(artist) : Promise.resolve(null),
  ]);
  return formatTrackContext(
    title,
    artist,
    songResult.status === 'fulfilled' ? songResult.value : null,
    artistResult.status === 'fulfilled' ? artistResult.value : null,
  );
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

  return formatTrackContext(
    title,
    artist,
    songResult.status === 'fulfilled' ? songResult.value : null,
    artistResult.status === 'fulfilled' ? artistResult.value : null,
  );
}
