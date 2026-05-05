import express from 'express';
import { recordFeedback, recordSkip, markRerankerSkip } from '../src/state.js';
import { sendFeedback, isRerankerEnabled } from '../src/reranker.js';

const router = express.Router();

// POST /api/feedback  { videoId, title, artist, rating: 'like'|'dislike'|'skip' }
router.post('/', (req, res) => {
  const { videoId, title, artist, rating } = req.body;
  if (!title || !['like', 'dislike', 'skip'].includes(rating)) {
    return res.status(400).json({ error: 'title and rating (like|dislike|skip) required' });
  }
  try {
    if (rating === 'skip') {
      recordSkip({ videoId: videoId ?? null, title, artist: artist ?? '' });
      // Mark so /api/next doesn't also fire a 'replay' for this song
      markRerankerSkip(`${title}___${artist ?? ''}`);
      if (isRerankerEnabled()) sendFeedback({ title, artist: artist ?? '' }, 'skip');
    } else {
      recordFeedback({ videoId: videoId ?? null, title, artist: artist ?? '', rating });
      // 'like' → strong positive preference signal to the reranker
      if (rating === 'like' && isRerankerEnabled()) {
        sendFeedback({ title, artist: artist ?? '' }, 'like');
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[Feedback]', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
