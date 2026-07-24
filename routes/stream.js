import { register } from '../src/ws-broadcast.js';
import { peekNext } from '../src/state.js';
import { prewarmCache } from './stream-audio.js';

export default function streamHandler(ws, req) {
  register(ws, req.query?.clientId);
  ws.send(JSON.stringify({ type: 'connected', ts: Date.now() }));

  // Pre-warm yt-dlp cache for queued tracks so music is ready when DJ finishes speaking
  const queued = peekNext();
  if (queued.length) {
    prewarmCache(queued.map(r => r.video_id).filter(Boolean));
  }
}
