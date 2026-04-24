import express from 'express';
import { handleInput } from '../src/router.js';

const router = express.Router();

router.post('/', async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message required' });

  try {
    const result = await handleInput(message);
    res.json(result);
  } catch (err) {
    console.error('[/api/chat]', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
