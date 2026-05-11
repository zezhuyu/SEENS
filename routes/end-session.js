import express from 'express';
import { clearSession } from '../src/state.js';
import { broadcast } from '../src/ws-broadcast.js';

const router = express.Router();

router.post('/', (req, res) => {
  clearSession();
  broadcast('session-ended', {});
  console.log('[EndSession] queue and session state cleared');
  res.json({ ok: true });
});

export default router;
