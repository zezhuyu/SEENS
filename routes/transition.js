import express from 'express';
import { peekNext, addMessage } from '../src/state.js';
import { generate } from '../src/ai/index.js';
import { buildSystemPrompt } from '../src/context.js';
import { synthesize } from '../src/tts.js';
import { deliver } from '../src/ws-broadcast.js';

const router = express.Router();
let transitioning = false;
let activeTransition = null;
let cachedTransition = null;

function transitionKey(track) {
  return track.video_id
    ? `video:${track.video_id}`
    : `title:${String(track.resolved_title ?? track.title ?? '').trim().toLowerCase()}::artist:${String(track.resolved_artist ?? track.artist ?? '').trim().toLowerCase()}`;
}

function deliverTransition(payload, clientIds) {
  for (const clientId of new Set(clientIds)) {
    deliver('dj-response', payload, { clientId });
  }
}

router.post('/', async (req, res) => {
  const { clientId = null } = req.body ?? {};
  res.json({ ok: true }); // respond immediately, work async
  let ownsTransition = false;

  try {
    const queue = peekNext();
    const next = queue[0];
    if (!next) return;
    const key = transitionKey(next);
    if (activeTransition?.key === key) {
      activeTransition.clientIds.push(clientId);
      console.log(`[Transition] coalesced duplicate request for "${next.title}"`);
      return;
    }
    if (cachedTransition?.key === key && Date.now() - cachedTransition.createdAt < 5 * 60 * 1000) {
      console.log(`[Transition] reused cached intro for "${next.title}"`);
      deliverTransition(cachedTransition.payload, [clientId]);
      return;
    }
    if (transitioning) return;
    transitioning = true;
    ownsTransition = true;
    activeTransition = { key, clientIds: [clientId] };

    const nextTitle  = next.resolved_title  ?? next.title;
    const nextArtist = next.resolved_artist ?? next.artist ?? '';
    const transitionFor = {
      id: next.id,
      videoId: next.video_id ?? null,
      title: nextTitle,
      artist: nextArtist,
    };

    console.log(`[Transition] generating intro for "${nextTitle}" by ${nextArtist}`);

    const systemPrompt = await buildSystemPrompt('transition', { agentMode: true });
    const userMsg = `You are between songs. Introduce the next track in 1-2 sentences: "${nextTitle}" by ${nextArtist}. Be warm, specific, and DJ-like. Respond only with the JSON object — no extra text.`;

    let say;
    try {
      const djResponse = await generate(systemPrompt, userMsg);
      say = djResponse.say?.trim();
    } catch (err) {
      console.warn('[Transition] AI error:', err.message);
    }

    if (!say) say = `Coming up: ${nextTitle}${nextArtist ? ` by ${nextArtist}` : ''}.`;

    // Store the segue intro so follow-up questions ("tell me more about this song")
    // can reference what the DJ just introduced, not just what's audio-playing.
    addMessage('assistant', say);

    const ttsResult = await synthesize(say).catch(err => {
      console.warn('[Transition] TTS error:', err.message);
      return null;
    });

    const payload = {
      say,
      ttsUrl: ttsResult?.url ?? null,
      trigger: 'transition',
      transitionFor,
      playIntent: 'end',
      firstTrack: null,
      play: [],
    };
    cachedTransition = { key, createdAt: Date.now(), payload };
    deliverTransition(payload, activeTransition?.clientIds ?? [clientId]);

    console.log(`[Transition] done — ttsUrl=${ttsResult?.url ?? 'null'}`);
  } catch (err) {
    console.error('[Transition] error:', err.message);
  } finally {
    if (ownsTransition) {
      transitioning = false;
      activeTransition = null;
    }
  }
});

export default router;
