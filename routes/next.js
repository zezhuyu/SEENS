import express from 'express';
import { dequeue, peekNext, getRecentPlays } from '../src/state.js';
import { broadcast } from '../src/ws-broadcast.js';
import { handleInput } from '../src/router.js';

const router = express.Router();

const MIN_QUEUE = 2;   // refill when fewer than this many tracks remain
let refilling = false;

function refillFromHistory() {
  if (refilling) return;
  refilling = true;

  const recent = getRecentPlays(10);
  const artists = [...new Set(recent.map(p => p.artist).filter(Boolean))].slice(0, 5);
  const prompt = artists.length
    ? `Based on my recent listening history (${artists.join(', ')}), queue 4 more tracks I'll enjoy. Vary the mood and avoid repeating what was just played.`
    : 'Queue 4 tracks based on my taste profile and the current time of day.';

  console.log('[Queue] Low — auto-refilling from history');
  handleInput(prompt, 'auto-refill')
    .catch(err => console.error('[Queue] Refill error:', err.message))
    .finally(() => { refilling = false; });
}

router.post('/', (req, res) => {
  const track = dequeue();
  const queued = peekNext();
  const upNext = queued[0] ? {
    title:          queued[0].title,
    artist:         queued[0].artist,
    resolvedTitle:  queued[0].resolved_title  ?? queued[0].title,
    resolvedArtist: queued[0].resolved_artist ?? queued[0].artist,
  } : null;
  // Don't broadcast now-playing here — the client that called /api/next
  // handles playback directly, and the WS echo would cause a double-play restart.
  res.json({ track: track ?? null, upNext, message: track ? undefined : 'Queue empty' });

  // Refill in background whenever queue runs low
  if (queued.length < MIN_QUEUE) refillFromHistory();
});

export default router;
