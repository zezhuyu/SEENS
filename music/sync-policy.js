const DAILY_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function getPeriodicSyncIntervalMs() {
  const value = Number(process.env.SEENS_MUSIC_SYNC_INTERVAL_MS);
  return Number.isFinite(value) && value >= 60_000 ? value : DAILY_SYNC_INTERVAL_MS;
}

export function mergeSyncedTracks(currentTracks, previousTracks, failedSources) {
  const retainedTracks = (previousTracks ?? []).filter(track => failedSources.has(track?.source));
  const seen = new Map();
  for (const track of [...(currentTracks ?? []), ...retainedTracks]) {
    if (!track?.title) continue;
    const key = `${track.title.toLowerCase().trim()}::${(track.artist ?? '').toLowerCase().trim()}`;
    if (!seen.has(key)) seen.set(key, track);
  }
  return [...seen.values()];
}
