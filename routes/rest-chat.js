import express from 'express';
import { synthesize } from '../src/tts.js';

const router = express.Router();

/**
 * POST /api/rest-chat
 * Body: { piece, message, history }
 *   piece   — the rest-piece object currently shown to the user
 *   message — the user's question
 *   history — array of { text, isUser } prior turns in this rest session
 *
 * Returns: { say, url }  (url may be null if TTS unavailable)
 */
router.post('/', async (req, res) => {
  const { piece, message, history = [] } = req.body;
  if (!piece?.title) return res.status(400).json({ error: 'piece required' });
  if (!message?.trim()) return res.status(400).json({ error: 'message required' });

  const key = process.env.OPENAI_API_KEY;
  if (!key) return res.status(500).json({ error: 'OPENAI_API_KEY not set' });

  const systemPrompt = `You are a warm, deeply knowledgeable cultural guide. You personally recommended this piece to the listener and they are currently experiencing it during their break. Answer their questions about it with depth, curiosity, and warmth. Be concise — 2-3 sentences unless a longer answer clearly needs more. No filler phrases like "great question" or "fascinating".

The piece you recommended:
Title: ${piece.title}
Creator: ${piece.artist || '—'}
Category: ${piece.cat || '—'}
Context: ${piece.caption || '—'}
Story: ${piece.story || '—'}
Fact: ${piece.fact || '—'}`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(m => ({ role: m.isUser ? 'user' : 'assistant', content: m.text })),
    { role: 'user', content: message },
  ];

  let say;
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.CODEX_MODEL ?? 'gpt-4o-mini',
        messages,
        max_tokens: 220,
        temperature: 0.75,
      }),
    });
    if (response.ok) {
      const data = await response.json();
      say = data.choices?.[0]?.message?.content?.trim();
    } else {
      console.warn('[RestChat] AI HTTP error:', response.status);
    }
  } catch (err) {
    console.warn('[RestChat] AI error:', err.message);
  }

  if (!say) say = "I don't have more on that right now — enjoy the piece.";

  const ttsResult = await synthesize(say).catch(err => {
    console.warn('[RestChat] TTS error:', err.message);
    return null;
  });

  res.json({ say, url: ttsResult?.url ?? null });
});

export default router;
