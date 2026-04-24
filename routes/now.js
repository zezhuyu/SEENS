import express from 'express';
import db, { getRecentPlays, peekNext } from '../src/state.js';

const router = express.Router();

router.get('/', (req, res) => {
  const [lastPlayed] = getRecentPlays(1);
  const queued = peekNext();
  // If something is actively playing use that; otherwise surface the first queued track
  const nowPlaying = lastPlayed ?? (queued[0] ? {
    ...queued[0],
    resolvedTitle:  queued[0].resolved_title  ?? queued[0].title,
    resolvedArtist: queued[0].resolved_artist ?? queued[0].artist,
    streamUrl:      queued[0].stream_url,
    artworkUrl:     queued[0].artwork_url,
  } : null);
  const upNext = queued[1] ?? null;

  if (req.query.full === '1') {
    const allQueued = db.prepare('SELECT * FROM queue ORDER BY position ASC LIMIT 50').all()
      .map(t => ({ title: t.resolved_title ?? t.title, artist: t.resolved_artist ?? t.artist ?? '' }));
    return res.json({ nowPlaying: nowPlaying ?? null, upNext: upNext ?? null, queue: allQueued });
  }

  res.json({ nowPlaying: nowPlaying ?? null, upNext: upNext ?? null });
});

export default router;
