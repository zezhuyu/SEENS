import test from 'node:test';
import assert from 'node:assert/strict';
import { getPeriodicSyncIntervalMs, mergeSyncedTracks } from '../music/sync-policy.js';

test('periodic library sync defaults to daily and accepts safe test override', () => {
  const previous = process.env.SEENS_MUSIC_SYNC_INTERVAL_MS;
  delete process.env.SEENS_MUSIC_SYNC_INTERVAL_MS;
  assert.equal(getPeriodicSyncIntervalMs(), 24 * 60 * 60 * 1000);

  process.env.SEENS_MUSIC_SYNC_INTERVAL_MS = '3600000';
  assert.equal(getPeriodicSyncIntervalMs(), 3600000);

  process.env.SEENS_MUSIC_SYNC_INTERVAL_MS = '1000';
  assert.equal(getPeriodicSyncIntervalMs(), 24 * 60 * 60 * 1000);
  if (previous === undefined) delete process.env.SEENS_MUSIC_SYNC_INTERVAL_MS;
  else process.env.SEENS_MUSIC_SYNC_INTERVAL_MS = previous;
});

test('a failed provider keeps its previous tracks while successful sources refresh', () => {
  const current = [{ title: 'New Spotify Song', artist: 'A', source: 'spotify' }];
  const previous = [
    { title: 'Old Spotify Song', artist: 'A', source: 'spotify' },
    { title: 'YouTube Favorite', artist: 'B', source: 'youtube' },
  ];

  assert.deepEqual(mergeSyncedTracks(current, previous, new Set(['youtube'])), [
    current[0],
    previous[1],
  ]);
});
