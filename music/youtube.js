import { google } from 'googleapis';
import { getAuthenticatedClient } from '../auth/youtube-auth.js';

function getYouTube() {
  const auth = getAuthenticatedClient();
  return google.youtube({ version: 'v3', auth });
}

export async function syncLikedVideos() {
  const yt = getYouTube();
  const items = [];
  let pageToken;
  do {
    const res = await yt.videos.list({
      part: ['snippet'],
      myRating: 'like',
      maxResults: 50,
      videoCategoryId: '10', // Music
      ...(pageToken ? { pageToken } : {}),
    });
    items.push(...(res.data.items ?? []));
    pageToken = res.data.nextPageToken;
  } while (pageToken && items.length < 200);

  return items.map(normalizeVideo);
}

export async function syncPlaylists() {
  const yt = getYouTube();
  const plRes = await yt.playlists.list({ part: ['snippet'], mine: true, maxResults: 25 });
  const playlists = plRes.data.items ?? [];

  const tracks = [];
  for (const pl of playlists) {
    try {
      const itemRes = await yt.playlistItems.list({
        part: ['snippet'],
        playlistId: pl.id,
        maxResults: 50,
      });
      for (const item of itemRes.data.items ?? []) {
        const s = item.snippet;
        tracks.push({
          id: s.resourceId?.videoId,
          title: s.title,
          artist: s.videoOwnerChannelTitle ?? '',
          album: pl.snippet?.title ?? '',
          uri: `https://www.youtube.com/watch?v=${s.resourceId?.videoId}`,
          source: 'youtube',
        });
      }
    } catch { /* skip restricted playlists */ }
  }
  return tracks;
}

function normalizeVideo(item) {
  const s = item.snippet;
  return {
    id: item.id,
    title: s.title,
    artist: s.channelTitle ?? '',
    album: '',
    uri: `https://www.youtube.com/watch?v=${item.id}`,
    source: 'youtube',
  };
}
