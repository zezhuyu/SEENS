import fs from 'fs';
import path from 'path';
import { getPref } from '../src/state.js';
import { ensureUserDir, userPath } from '../src/paths.js';
import { getMusicConnectors, syncConnectorTracks } from '../src/music-connector.js';

const MIN_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export async function syncAll({ force = false } = {}) {
  const lastSync = parseInt(getPref('music.last_sync', '0'));
  if (!force && Date.now() - lastSync < MIN_SYNC_INTERVAL_MS) {
    console.log('[Sync] Skipping — synced less than 6 hours ago. Use --force to override.');
    return;
  }

  const results = { spotify: [], youtube: [], apple: [], errors: [] };

  // Run all three built-in services in parallel, gracefully handle auth failures
  await Promise.all([
    syncService('spotify', results),
    syncService('youtube', results),
    syncService('apple', results),
  ]);

  // Expand catalog: fetch top tracks from user's top artists + related artists
  if (results.spotifyArtists?.length) {
    try {
      const { getArtistTopTracks, getRelatedArtists } = await import('./spotify.js');
      const discoveries = await syncSpotifyDiscoveries(results.spotifyArtists, getArtistTopTracks, getRelatedArtists);
      fs.writeFileSync(userPath('discoveries.json'), JSON.stringify(discoveries, null, 2));
      console.log(`[Sync:discoveries] ${discoveries.length} tracks saved`);
    } catch (err) {
      console.warn('[Sync:discoveries] Failed:', err.message);
    }
  }

  // Sync any enabled custom music connectors
  const connectors = getMusicConnectors();
  const connectorResults = await Promise.all(
    connectors.map(async (p) => {
      try {
        const tracks = await syncConnectorTracks(p);
        console.log(`[Sync:${p.name}] ${tracks.length} tracks`);
        return { name: p.name, tracks };
      } catch (err) {
        console.warn(`[Sync:${p.name}] Skipped: ${err.message}`);
        results.errors.push({ service: p.name, error: err.message });
        return { name: p.name, tracks: [] };
      }
    })
  );
  results.connectors = connectorResults;
  const connectorTracks = connectorResults.flatMap(r => r.tracks);

  const allTracks = [...results.spotify, ...results.youtube, ...results.apple, ...connectorTracks];
  const deduped = deduplicateTracks(allTracks);

  ensureUserDir();
  fs.writeFileSync(userPath('playlists.json'), JSON.stringify(deduped, null, 2));

  // Persist Spotify top-artist rank so the AI can weight recommendations by listening frequency
  if (results.spotifyArtists?.length) {
    const topArtistsData = results.spotifyArtists.map((a, i) => ({
      rank: i + 1,
      name: a.name,
      genres: a.genres ?? [],
      popularity: a.popularity,
    }));
    fs.writeFileSync(userPath('top-artists.json'), JSON.stringify(topArtistsData, null, 2));
  }

  const taste = generateTasteProfile(results);
  fs.writeFileSync(userPath('taste.md'), taste);

  const { setPref } = await import('../src/state.js');
  setPref('music.last_sync', String(Date.now()));

  console.log(`[Sync] Done. ${deduped.length} unique tracks across ${Object.keys(results).filter(k => k !== 'errors').length} services.`);
  if (results.errors.length) console.warn('[Sync] Errors:', results.errors);

  // ── Seed reranker in background ───────────────────────────────────────────
  // Kick off embedding for the top 200 library tracks + discoveries.
  // Runs in background — downloads 60s audio clips + embeds all 3 models.
  // Lyrics are fetched from lrclib and passed so BGE gets real lyrics, not
  // just "title artist" fallback.
  _seedRerankerBackground(deduped).catch(err =>
    console.warn('[Sync] Reranker seed error:', err.message)
  );

  return deduped;
}

async function _seedRerankerBackground(tracks) {
  const { isRerankerEnabled, isSubprocessRunning, seedLibrary } = await import('../src/reranker.js');
  if (!isRerankerEnabled() || !isSubprocessRunning()) return;

  const { fetchLyricsBatch } = await import('./lyrics.js');

  const top200 = tracks.slice(0, 200);
  console.log(`[Sync] Seeding reranker with ${top200.length} tracks (background)…`);

  // Fetch lyrics for all tracks in parallel before seeding so BGE gets real lyrics.
  const lyricsList = await fetchLyricsBatch(top200);
  const withLyrics = top200.map((t, i) => ({
    ...t,
    lyrics: lyricsList[i] ?? undefined,  // undefined → sync.py uses its own fallback
  }));

  const result = await seedLibrary(withLyrics, { limit: 200 });
  console.log(`[Sync] Reranker seed done — ok=${result.ok} skip=${result.skipped} fail=${result.fail}`);

  // Also seed discoveries if available
  const discPath = userPath('discoveries.json');
  if (fs.existsSync(discPath)) {
    try {
      const discoveries = JSON.parse(fs.readFileSync(discPath, 'utf8'));
      if (discoveries?.length) {
        const discTop = discoveries.slice(0, 200);
        const discLyrics = await fetchLyricsBatch(discTop);
        const discWithLyrics = discTop.map((t, i) => ({ ...t, lyrics: discLyrics[i] ?? undefined }));
        const discResult = await seedLibrary(discWithLyrics, { limit: 200 });
        console.log(`[Sync] Reranker seed (discoveries) done — ok=${discResult.ok} skip=${discResult.skipped}`);
      }
    } catch (err) {
      console.warn('[Sync] Discovery seed failed:', err.message);
    }
  }
}

async function syncService(service, results) {
  try {
    if (service === 'spotify') {
      const { syncRecentlyPlayed, syncTopTracks, syncPlaylists, syncTopArtists, syncLikedSongs } = await import('./spotify.js');
      const [recent, top, playlists, liked] = await Promise.all([syncRecentlyPlayed(), syncTopTracks(), syncPlaylists(), syncLikedSongs()]);
      results.spotify = [...recent, ...top, ...playlists, ...liked].filter(Boolean);
      results.spotifyArtists = await syncTopArtists();
    } else if (service === 'youtube') {
      const { syncLikedVideos, syncPlaylists } = await import('./youtube.js');
      const [liked, playlists] = await Promise.all([syncLikedVideos(), syncPlaylists()]);
      results.youtube = [...liked, ...playlists].filter(Boolean);
    } else if (service === 'apple') {
      const { syncLibrarySongs, syncLibraryPlaylists } = await import('./apple-music.js');
      const [songs, playlists] = await Promise.all([syncLibrarySongs(), syncLibraryPlaylists()]);
      results.apple = [...songs, ...playlists].filter(Boolean);
    }
    console.log(`[Sync:${service}] ${results[service].length} tracks`);
  } catch (err) {
    console.warn(`[Sync:${service}] Skipped: ${err.message}`);
    results.errors.push({ service, error: err.message });
  }
}

async function syncSpotifyDiscoveries(topArtists, getArtistTopTracks, getRelatedArtists) {
  const discoveries = [];
  const seen = new Set();

  const addTrack = (t, source) => {
    if (!t?.title) return;
    const key = `${t.title.toLowerCase()}::${(t.artist ?? '').toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      discoveries.push({ ...t, discoverySource: source });
    }
  };

  // Top tracks from user's top 12 Spotify artists (deeper cuts beyond the synced library)
  const primaryArtists = topArtists.slice(0, 12);
  await Promise.all(primaryArtists.map(async (artist) => {
    try {
      const tracks = await getArtistTopTracks(artist.id);
      tracks.forEach(t => addTrack(t, `top-tracks:${artist.name}`));
    } catch {}
  }));

  // Related artists for the top 5 artists — broader discovery territory
  const relatedSets = await Promise.all(
    topArtists.slice(0, 5).map(a => getRelatedArtists(a.id).catch(() => []))
  );
  const relatedArtists = [...new Map(relatedSets.flat().map(a => [a.id, a])).values()].slice(0, 10);

  await Promise.all(relatedArtists.map(async (artist) => {
    try {
      const tracks = (await getArtistTopTracks(artist.id)).slice(0, 5);
      tracks.forEach(t => addTrack(t, `related:${artist.name}`));
    } catch {}
  }));

  return discoveries;
}

function deduplicateTracks(tracks) {
  const seen = new Map();
  for (const t of tracks) {
    if (!t?.title) continue;
    const key = `${t.title.toLowerCase().trim()}::${(t.artist ?? '').toLowerCase().trim()}`;
    if (!seen.has(key)) seen.set(key, t);
  }
  return [...seen.values()];
}

function generateTasteProfile(results) {
  const artistCounts = new Map();
  const connectorTracks = (results.connectors ?? []).flatMap(r => r.tracks);
  const allTracks = [...results.spotify, ...results.youtube, ...results.apple, ...connectorTracks].filter(Boolean);

  for (const t of allTracks) {
    if (!t.artist) continue;
    artistCounts.set(t.artist, (artistCounts.get(t.artist) ?? 0) + 1);
  }

  const topArtists = [...artistCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, count]) => `- ${name} (${count} tracks)`);

  const spotifyGenres = (results.spotifyArtists ?? [])
    .flatMap(a => a.genres ?? [])
    .reduce((acc, g) => { acc[g] = (acc[g] ?? 0) + 1; return acc; }, {});
  const topGenres = Object.entries(spotifyGenres)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([g, c]) => `- ${g} (${c})`);

  const syncDate = new Date().toLocaleString();
  return `# Music Taste Profile
*Auto-generated from Spotify, Apple Music, YouTube — last synced ${syncDate}*

## Top Artists (by track count)
${topArtists.join('\n') || '- (not yet synced)'}

## Top Genres (from Spotify)
${topGenres.join('\n') || '- (not yet synced)'}

## Library Stats
- Spotify tracks: ${results.spotify.length}
- Apple Music tracks: ${results.apple.length}
- YouTube tracks: ${results.youtube.length}
${(results.connectors ?? []).filter(r => r.tracks.length > 0).map(r => `- ${r.name} tracks: ${r.tracks.length}`).join('\n')}
- Total unique: ${[...results.spotify, ...results.apple, ...results.youtube, ...connectorTracks].filter(Boolean).length}

## Notes
*(Edit this file to add personal notes about your taste — the AI DJ will read them)*
`;
}
