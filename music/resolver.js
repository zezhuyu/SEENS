/**
 * Resolve AI song suggestions → playable track data.
 *
 * Strategy:
 *   1. Spotify search → artwork, canonical title/artist, URI
 *   2. yt-search (no API key) → YouTube videoId for IFrame playback
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { getAccessToken } from '../auth/spotify-auth.js';
import { getAuthenticatedClient } from '../auth/youtube-auth.js';
import { google } from 'googleapis';
import ytSearch from 'yt-search';
import { startProgressiveResolution } from '../src/progressive-resolution.js';

const execFileAsync = promisify(execFile);
const YTDLP = process.env.YTDLP_BIN ?? '/opt/homebrew/bin/yt-dlp';

const SPOTIFY_BASE = 'https://api.spotify.com/v1';

export async function resolveTracks(tracks) {
  const resolved = await Promise.all(tracks.map(resolveOne));
  // Keep all tracks in order — player auto-skips ones with no streamUrl
  return resolved.filter(Boolean);
}

export async function resolveTracksOrdered(tracks) {
  // Like resolveTracks but preserves positions so firstTrack matches DJ's words
  const resolved = await Promise.all(tracks.map(async (t, i) => {
    const r = await resolveOne(t);
    return r ?? { ...t, source: t.source ?? 'any' }; // fallback: keep original if resolve fails
  }));
  return resolved;
}

export function resolveTracksProgressively(tracks) {
  return startProgressiveResolution(tracks, {
    resolveFirst: track => resolveOne(track, { preferYouTubeApi: true }),
    resolveRemaining: track => resolveOne(track),
  });
}

async function resolveOne(track, { preferYouTubeApi = false } = {}) {
  // Plugin and connector tracks with a direct streamUrl — skip all lookups
  if ((track.source === 'plugin' || track.source?.startsWith('connector:')) && track.streamUrl) return track;

  let meta = { ...track };

  // The foreground track needs only a playable video ID. Spotify artwork and
  // canonical metadata are useful for the rest of the queue but add a serial
  // network round-trip before playback can begin.
  if (!preferYouTubeApi) {
    try {
      meta = await resolveSpotifyMeta(track);
    } catch (e) {
      const detail = e.cause?.code ?? e.message;
      console.warn(`[Resolver] Spotify: "${track.title}" — ${detail}`);
    }
  }

  // Step 2: YouTube videoId via yt-search (no API key, no quota)
  try {
    const title  = meta.resolvedTitle  ?? track.title;
    const artist = meta.resolvedArtist ?? track.artist;
    const videoId = preferYouTubeApi
      ? await searchYouTubeApi(title, artist).then(id => id ?? searchYouTube(title, artist))
      : await searchYouTube(title, artist);
    if (videoId) {
      meta.videoId   = videoId;
      meta.streamUrl = `/api/stream/${videoId}`;
      console.log(`[Resolver] ✓ "${title}" → yt:${videoId}`);
    }
  } catch (e) {
    console.warn(`[Resolver] yt-search: "${track.title}" — ${e.message}`);
  }

  // Step 3: yt-dlp fallback when yt-search finds nothing
  if (!meta.videoId) {
    try {
      const title  = meta.resolvedTitle  ?? track.title;
      const artist = meta.resolvedArtist ?? track.artist;
      const videoId = await searchYtDlp(title, artist);
      if (videoId) {
        meta.videoId   = videoId;
        meta.streamUrl = `/api/stream/${videoId}`;
        console.log(`[Resolver] ✓ "${title}" → yt-dlp:${videoId}`);
      }
    } catch (e) {
      console.warn(`[Resolver] yt-dlp: "${track.title}" — ${e.message}`);
    }
  }

  return meta;
}

async function searchYouTubeApi(title, artist) {
  try {
    const youtube = google.youtube({ version: 'v3', auth: getAuthenticatedClient() });
    const { data } = await youtube.search.list({
      part: ['snippet'],
      q: `${artist} ${title} official audio`,
      type: ['video'],
      videoCategoryId: '10',
      maxResults: 8,
    });
    const videos = (data.items ?? []).map(item => ({
      videoId: item.id?.videoId,
      title: item.snippet?.title ?? '',
      author: { name: item.snippet?.channelTitle ?? '' },
    })).filter(item => item.videoId);
    const best = pickBestVideo(videos, title, artist);
    if (best) console.log(`[Resolver] YouTube API "${title}" by "${artist}" → ${best}`);
    return best;
  } catch (err) {
    console.warn(`[Resolver] YouTube API fast lookup failed for "${artist} — ${title}": ${err.message}`);
    return null;
  }
}

async function resolveSpotifyMeta(track) {
  const token = await getAccessToken();
  // Use Spotify field filters for precise artist+title matching
  const precise = encodeURIComponent(`track:${track.title} artist:${track.artist}`);
  const res = await fetch(`${SPOTIFY_BASE}/search?q=${precise}&type=track&limit=5`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const items = data.tracks?.items ?? [];
  if (!items.length) return track;

  // Pick the item whose artist name best matches what the DJ requested.
  // If no item matches the requested artist, return the original track unchanged —
  // don't fall back to a random result which would give a completely wrong artist.
  const wantedWords = artistWords(track.artist);
  const best = wantedWords.length > 0
    ? items.find(item => {
        const got = item.artists.map(a => a.name).join(' ');
        return wantedWords.some(w => got.toLowerCase().includes(w));
      }) ?? null
    : items[0];
  if (!best) return track;

  return {
    ...track,
    id:             best.id,
    resolvedTitle:  best.name,
    resolvedArtist: best.artists.map(a => a.name).join(', '),
    uri:            best.uri,
    previewUrl:     best.preview_url ?? null,
    artworkUrl:     best.album?.images?.[0]?.url ?? null,
    source:         'spotify',
  };
}

// Return significant lowercase words from an artist string for matching
function artistWords(artist) {
  const STOP = new Set(['the', 'and', 'feat', 'ft', 'vs', 'with', 'de', 'la', 'le']);
  return artist.toLowerCase().split(/[\s,&()+]+/).filter(w => w.length > 2 && !STOP.has(w));
}

async function searchYouTube(title, artist) {
  const queries = [
    `${artist} - ${title} (official audio)`,
    `${artist} ${title}`,
    `${title} ${artist}`,
  ];

  let bestVideoId = null;
  let bestScore   = -2;
  const artistWds = artistWords(artist);
  const stop = new Set(['the', 'and', 'for', 'feat', 'ft', 'vs', 'with', 'a', 'an', 'in', 'of', 'to']);
  const titleWds = title.toLowerCase().split(/[\s\-–—()\[\]]+/)
    .filter(word => word.length > 2 && !stop.has(word));

  for (const q of queries) {
    try {
      const result = await ytSearch(q);
      const videos = result.videos?.filter(v => v.seconds > 60) ?? [];
      if (!videos.length) continue;
      for (const v of videos) {
        const s = scoreVideo(v, title, artist);
        if (s > bestScore) {
          bestScore   = s;
          bestVideoId = v.videoId;
          if (s === 2) break; // perfect match — stop searching
        }
      }
      if (bestScore === 2) break;
    } catch (err) {
      console.warn(`[Resolver] yt-search query failed ("${q}"):`, err.message);
    }
  }

  // Reject title-only matches (score=0) — common words appear in thousands of videos.
  if (bestScore === 0 && artistWds.length > 0) {
    console.warn(`[Resolver] yt rejected title-only match for "${artist} — ${title}" (artist not found in results)`);
    bestVideoId = null;
  }

  // Reject artist-only matches (score=1) — wrong song by the right artist.
  if (bestScore === 1 && titleWds.length > 0) {
    console.warn(`[Resolver] yt rejected artist-only match for "${artist} — ${title}" (title not found in results)`);
    bestVideoId = null;
  }

  if (bestVideoId) {
    const label = bestScore === 2 ? 'artist+title' : bestScore === 1 ? 'artist match only' : 'partial match';
    console.log(`[Resolver] yt "${title}" by "${artist}" → ${bestVideoId} (${label})`);
  } else {
    console.warn(`[Resolver] yt no confident match for "${artist} — ${title}"`);
  }
  return bestVideoId;
}

function pickBestVideo(videos, title, artist) {
  let best = null;
  let bestScore = -2;
  for (const video of videos) {
    const score = scoreVideo(video, title, artist);
    if (score > bestScore) {
      best = video.videoId;
      bestScore = score;
    }
  }
  return bestScore === 2 ? best : null;
}

function scoreVideo(video, title, artist) {
  const artistWds = artistWords(artist);
  const stop = new Set(['the', 'and', 'for', 'feat', 'ft', 'vs', 'with', 'a', 'an', 'in', 'of', 'to']);
  const titleWds = title.toLowerCase().split(/[\s\-–—()\[\]]+/)
    .filter(word => word.length > 2 && !stop.has(word));
  const hay = `${video.title} ${video.author?.name ?? ''}`.toLowerCase();
  const artistHit = artistWds.length > 0 && artistWds.some(word => hay.includes(word));
  const titleHit = titleWds.length > 0 && titleWds.some(word => hay.includes(word));
  if (artistHit && titleHit) return 2;
  if (artistHit) return 1;
  if (titleHit) return 0;
  return -1;
}

async function searchYtDlp(title, artist) {
  const q = `${artist} - ${title}`;
  const { stdout } = await execFileAsync(YTDLP, [
    `ytsearch3:${q}`,
    '--print', '%(id)s',
    '--no-playlist', '--quiet', '--no-warnings',
  ], { timeout: 20_000 });
  const ids = stdout.trim().split('\n').filter(Boolean);
  if (ids[0]) console.log(`[Resolver] yt-dlp search "${q}" → ${ids[0]}`);
  return ids[0] ?? null;
}
