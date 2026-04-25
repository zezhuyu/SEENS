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

  const taste = generateTasteProfile(results);
  fs.writeFileSync(userPath('taste.md'), taste);

  const { setPref } = await import('../src/state.js');
  setPref('music.last_sync', String(Date.now()));

  console.log(`[Sync] Done. ${deduped.length} unique tracks across ${Object.keys(results).filter(k => k !== 'errors').length} services.`);
  if (results.errors.length) console.warn('[Sync] Errors:', results.errors);
  return deduped;
}

async function syncService(service, results) {
  try {
    if (service === 'spotify') {
      const { syncRecentlyPlayed, syncTopTracks, syncPlaylists, syncTopArtists } = await import('./spotify.js');
      const [recent, top, playlists] = await Promise.all([syncRecentlyPlayed(), syncTopTracks(), syncPlaylists()]);
      results.spotify = [...recent, ...top, ...playlists].filter(Boolean);
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
