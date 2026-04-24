import { getDeveloperToken, getUserToken } from '../auth/apple-auth.js';

const BASE = 'https://api.music.apple.com/v1';

async function appleFetch(path) {
  const devToken = getDeveloperToken();
  const userToken = getUserToken();
  if (!userToken) throw new Error('Apple Music user not authenticated. Connect via Settings.');
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${devToken}`,
      'Music-User-Token': userToken,
    },
  });
  if (!res.ok) throw new Error(`Apple Music API ${path}: ${res.status}`);
  return res.json();
}

export async function syncLibraryPlaylists() {
  const data = await appleFetch('/me/library/playlists?limit=25');
  const playlists = data.data ?? [];
  const tracks = [];

  for (const pl of playlists) {
    try {
      const tracksData = await appleFetch(`/me/library/playlists/${pl.id}/tracks?limit=100`);
      tracks.push(...(tracksData.data ?? []).map(t => normalizeTrack(t)));
    } catch { /* skip */ }
  }
  return tracks;
}

export async function syncLibrarySongs() {
  const items = [];
  let offset = 0;
  while (true) {
    const data = await appleFetch(`/me/library/songs?limit=100&offset=${offset}`);
    const batch = data.data ?? [];
    items.push(...batch.map(normalizeTrack));
    if (!data.next || batch.length < 100) break;
    offset += 100;
    if (offset >= 500) break; // reasonable limit
  }
  return items;
}

function normalizeTrack(item) {
  const a = item.attributes ?? {};
  return {
    id: item.id,
    title: a.name ?? '',
    artist: a.artistName ?? '',
    album: a.albumName ?? '',
    uri: a.url ?? `music://music.apple.com/song/${item.id}`,
    source: 'apple',
    artworkUrl: a.artwork ? buildArtworkUrl(a.artwork, 300) : null,
  };
}

function buildArtworkUrl(artwork, size) {
  return artwork.url?.replace('{w}', size).replace('{h}', size) ?? null;
}
