/**
 * Resolve AI song suggestions → playable track data.
 *
 * Strategy:
 *   1. Spotify search → artwork, canonical title/artist, URI
 *   2. yt-search (no API key) → YouTube videoId for IFrame playback
 */

import { getAccessToken } from '../auth/spotify-auth.js';
import ytSearch from 'yt-search';

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

async function resolveOne(track) {
  // Plugin and connector tracks with a direct streamUrl — skip all lookups
  if ((track.source === 'plugin' || track.source?.startsWith('connector:')) && track.streamUrl) return track;

  let meta = { ...track };

  // Step 1: Spotify metadata (artwork, canonical names, URI)
  try {
    meta = await resolveSpotifyMeta(track);
  } catch (e) {
    console.warn(`[Resolver] Spotify: "${track.title}" — ${e.message}`);
  }

  // Step 2: YouTube videoId via yt-search (no API key, no quota)
  try {
    const title  = meta.resolvedTitle  ?? track.title;
    const artist = meta.resolvedArtist ?? track.artist;
    const videoId = await searchYouTube(title, artist);
    if (videoId) {
      meta.videoId   = videoId;
      meta.streamUrl = `/api/stream/${videoId}`;
      console.log(`[Resolver] ✓ "${title}" → yt:${videoId} → ${meta.streamUrl}`);
    }
  } catch (e) {
    console.warn(`[Resolver] YouTube: "${track.title}" — ${e.message}`);
  }

  return meta;
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

  // Pick the item whose artist name best matches what the DJ requested
  const wantedWords = artistWords(track.artist);
  const best = items.find(item => {
    const got = item.artists.map(a => a.name).join(' ');
    return wantedWords.some(w => got.toLowerCase().includes(w));
  }) ?? items[0];

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

  const artistWds = artistWords(artist);

  // Significant words from the track title (strip articles, short words)
  const STOP = new Set(['the', 'and', 'for', 'feat', 'ft', 'vs', 'with', 'a', 'an', 'in', 'of', 'to']);
  const titleWds = title.toLowerCase().split(/[\s\-–—()\[\]]+/).filter(w => w.length > 2 && !STOP.has(w));

  const score = (v) => {
    const hay = `${v.title} ${v.author?.name ?? ''}`.toLowerCase();
    const artistHit = artistWds.length > 0 && artistWds.some(w => hay.includes(w));
    const titleHit  = titleWds.length  > 0 && titleWds.some(w => hay.includes(w));
    if (artistHit && titleHit) return 2;
    if (artistHit)             return 1;
    if (titleHit)              return 0;
    return -1;
  };

  let bestVideoId = null;
  let bestScore   = -2;

  for (const q of queries) {
    try {
      const result = await ytSearch(q);
      const videos = result.videos?.filter(v => v.seconds > 60) ?? [];
      if (!videos.length) continue;
      for (const v of videos) {
        const s = score(v);
        if (s > bestScore) {
          bestScore   = s;
          bestVideoId = v.videoId;
          if (s === 2) break; // perfect match — stop searching
        }
      }
      if (bestScore === 2) break;
    } catch { /* try next query */ }
  }

  if (bestVideoId) {
    const label = bestScore === 2 ? 'artist+title match' : bestScore === 1 ? 'artist match only' : 'title match only';
    console.log(`[Resolver] yt "${title}" by "${artist}" → ${bestVideoId} (${label})`);
  } else {
    console.warn(`[Resolver] yt no match for "${artist} — ${title}"`);
  }
  return bestVideoId;
}
