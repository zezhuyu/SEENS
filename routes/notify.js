import express from 'express';
import { broadcast } from '../src/ws-broadcast.js';

const router = express.Router();

// Localhost-only — reject any request not from 127.0.0.1 / ::1
router.use((req, res, next) => {
  const raw = req.ip ?? req.socket?.remoteAddress ?? '';
  const ip = raw.replace('::ffff:', '');
  if (ip !== '127.0.0.1' && ip !== '::1') {
    return res.status(403).json({ error: 'localhost only' });
  }
  next();
});

const VALID_TYPES = new Set(['info', 'success', 'warning', 'error']);

router.post('/', (req, res) => {
  const { title, message, type, link } = req.body;
  if (!title?.trim() || !message?.trim()) {
    return res.status(400).json({ error: 'title and message are required' });
  }

  const level = VALID_TYPES.has(type) ? type : 'info';
  const notification = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title: title.trim(),
    message: message.trim(),
    level,                         // 'level' avoids clobbering the WS 'type' discriminator
    link: link?.trim() || null,
  };

  broadcast('notification', notification);
  res.json({ ok: true, notification });
});

export default router;
