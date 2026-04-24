import express from 'express';
import { synthesize } from '../src/tts.js';

const router = express.Router();

router.post('/', async (req, res) => {
  const { piece } = req.body;
  if (!piece?.title) return res.status(400).json({ error: 'piece required' });

  const key = process.env.OPENAI_API_KEY;
  if (!key) return res.status(500).json({ error: 'OPENAI_API_KEY not set' });

  let say;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.CODEX_MODEL ?? 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a warm, deeply knowledgeable museum and cultural tour guide giving a spoken audio introduction to a work of art, photography, film, architecture, or music. Your voice is intimate and curious — like a trusted friend who happens to know everything about this piece. You are NOT a DJ; you are a storyteller standing beside the listener.

Your introduction must:
- Open with a vivid, specific detail that immediately pulls the listener in (not "This is...")
- Weave in the human story behind the work — who made it, under what circumstances, what drove them
- Include one surprising or reframing fact that changes how you see or hear it
- End with a thought or question that lingers

Speak in 4-5 natural sentences, under 100 words. Conversational tone, no jargon, no filler phrases like "fascinating" or "incredible". Write for the ear, not the page.`,
          },
          {
            role: 'user',
            content: `Introduce this work:

Title: ${piece.title}
Creator: ${piece.artist}
Year: ${piece.year}
Category: ${piece.cat}

Context: ${piece.caption}
Story: ${piece.story ?? ''}
Fun fact: ${piece.fact}

Write the spoken introduction as plain text — no JSON, no formatting.`,
          },
        ],
        max_tokens: 180,
        temperature: 0.85,
      }),
    });

    if (response.ok) {
      const data = await response.json();
      say = data.choices?.[0]?.message?.content?.trim();
    } else {
      console.warn('[RestNarrate] AI HTTP error:', response.status);
    }
  } catch (err) {
    console.warn('[RestNarrate] AI error:', err.message);
  }

  // Fallback narration
  if (!say) {
    say = `${piece.title} — ${piece.artist}, ${piece.year}. ${piece.caption} ${piece.fact}`;
  }

  const ttsResult = await synthesize(say).catch(err => {
    console.warn('[RestNarrate] TTS error:', err.message);
    return null;
  });

  res.json({ say, url: ttsResult?.url ?? null });
});

export default router;
