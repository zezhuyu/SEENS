import { getAccessToken } from '../auth/spotify-auth.js';

const BASE = 'https://api.spotify.com/v1';

async function spotifyFetch(path) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Spotify API ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function paginate(path, limit = 50) {
  const items = [];
  let url = `${path}${path.includes('?') ? '&' : '?'}limit=${limit}&offset=0`;
  while (url) {
    const data = await spotifyFetch(url.replace(BASE, ''));
    const page = data.items ?? data.tracks?.items ?? [];
    items.push(...page);
    url = data.next ? data.next.replace(BASE, '') : null;
  }
  return items;
}

export async function syncRecentlyPlayed() {
  const data = await spotifyFetch('/me/player/recently-played?limit=50');
  return (data.items ?? []).map(({ track }) => normalizeTrack(track, 'spotify'));
}

export async function syncTopTracks() {
  const data = await spotifyFetch('/me/top/tracks?limit=50&time_range=medium_term');
  return (data.items ?? []).map(t => normalizeTrack(t, 'spotify'));
}

export async function syncTopArtists() {
  const data = await spotifyFetch('/me/top/artists?limit=50&time_range=medium_term');
  return (data.items ?? []).map(a => ({
    id: a.id,
    name: a.name,
    genres: a.genres,
    popularity: a.popularity,
  }));
}

export async function syncPlaylists() {
  const playlists = await paginate('/me/playlists');
  const tracks = [];
  for (const pl of playlists.slice(0, 20)) { // limit to 20 playlists
    try {
      const items = await paginate(`/playlists/${pl.id}/tracks`);
      tracks.push(...items.map(i => i.track).filter(Boolean).map(t => normalizeTrack(t, 'spotify')));
    } catch { /* skip inaccessible playlists */ }
  }
  return tracks;
}

// Fetch an artist's top tracks — used to discover catalog beyond the synced library.
// market defaults to 'from_token' which uses the user's Spotify country.
export async function getArtistTopTracks(artistId) {
  const data = await spotifyFetch(`/artists/${artistId}/top-tracks?market=from_token`);
  return (data.tracks ?? []).map(t => normalizeTrack(t, 'spotify'));
}

// Fetch artists similar to a given one — used to broaden discovery to new artists.
export async function getRelatedArtists(artistId) {
  const data = await spotifyFetch(`/artists/${artistId}/related-artists`);
  return (data.artists ?? []).slice(0, 5).map(a => ({
    id: a.id, name: a.name, genres: a.genres ?? [],
  }));
}

function normalizeTrack(t, source) {
  if (!t) return null;
  return {
    id: t.id,
    title: t.name,
    artist: t.artists?.map(a => a.name).join(', ') ?? '',
    album: t.album?.name ?? '',
    uri: t.uri,
    source,
    previewUrl: t.preview_url ?? null,
  };
}
