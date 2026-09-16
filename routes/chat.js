import express from 'express';
import { handleInput } from '../src/router.js';
import { broadcast } from '../src/ws-broadcast.js';

const router = express.Router();

router.post('/', async (req, res) => {
  const { message, clientId, requestId, internal = false } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message required' });
  console.log(`[Chat] request clientId=${clientId ?? 'unknown'} requestId=${requestId ?? 'unknown'} internal=${!!internal} message=${JSON.stringify(message.trim().slice(0, 120))}`);

  // The widget's own sendChat() renders the user's bubble locally the
  // instant they hit send, before this request even lands. A request with
  // no clientId did not come from the widget (e.g. a voice message spoken
  // to the DJ from the watch via the bridge), so nothing has shown it in
  // the chat log yet — broadcast it so the open window can.
  if (!clientId) broadcast('user-message', { text: message });

  try {
    const result = await handleInput(message, 'user-chat', { clientId, requestId, recordUserMessage: !internal });
    if (result.duplicateTuneIn) {
      console.warn(`[Chat] duplicate Tune In suppressed clientId=${clientId ?? 'unknown'} requestId=${requestId ?? 'unknown'}`);
      return res.json({ ok: true, ignored: true, reason: 'active-session' });
    }
    if (result.error) return res.status(503).json({ error: result.error, retry: true });
    res.json(result);
  } catch (err) {
    console.error('[/api/chat]', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
