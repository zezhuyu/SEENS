import express from 'express';
import { recordFeedback } from '../src/state.js';

const router = express.Router();

// POST /api/feedback  { videoId, title, artist, rating: 'like'|'dislike' }
router.post('/', (req, res) => {
  const { videoId, title, artist, rating } = req.body;
  if (!title || !['like', 'dislike'].includes(rating)) {
    return res.status(400).json({ error: 'title and rating (like|dislike) required' });
  }
  try {
    recordFeedback({ videoId: videoId ?? null, title, artist: artist ?? '', rating });
    res.json({ ok: true });
  } catch (err) {
    console.error('[Feedback]', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
