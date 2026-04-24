import express from 'express';
import { peekNext } from '../src/state.js';
import { generate } from '../src/ai/index.js';
import { buildSystemPrompt } from '../src/context.js';
import { synthesize } from '../src/tts.js';
import { broadcast } from '../src/ws-broadcast.js';

const router = express.Router();
let transitioning = false;

router.post('/', async (req, res) => {
  res.json({ ok: true }); // respond immediately, work async

  if (transitioning) return;
  transitioning = true;

  try {
    const queue = peekNext();
    const next = queue[0];
    if (!next) return;

    const nextTitle  = next.resolved_title  ?? next.title;
    const nextArtist = next.resolved_artist ?? next.artist ?? '';

    console.log(`[Transition] generating intro for "${nextTitle}" by ${nextArtist}`);

    const systemPrompt = await buildSystemPrompt('transition');
    const userMsg = `You are between songs. Introduce the next track in 1-2 sentences: "${nextTitle}" by ${nextArtist}. Be warm, specific, and DJ-like. Respond only with the JSON object — no extra text.`;

    let say;
    try {
      const djResponse = await generate(systemPrompt, userMsg);
      say = djResponse.say?.trim();
    } catch (err) {
      console.warn('[Transition] AI error:', err.message);
    }

    if (!say) say = `Coming up: ${nextTitle}${nextArtist ? ` by ${nextArtist}` : ''}.`;

    const ttsResult = await synthesize(say).catch(err => {
      console.warn('[Transition] TTS error:', err.message);
      return null;
    });

    broadcast('dj-response', {
      say,
      ttsUrl: ttsResult?.url ?? null,
      trigger: 'transition',
      playIntent: 'end',
      firstTrack: null,
      play: [],
    });

    console.log(`[Transition] done — ttsUrl=${ttsResult?.url ?? 'null'}`);
  } catch (err) {
    console.error('[Transition] error:', err.message);
  } finally {
    transitioning = false;
  }
});

export default router;
