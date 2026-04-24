import express from 'express';

const router = express.Router();

router.post('/', async (req, res) => {
  const { piece, question } = req.body;
  if (!piece || !question?.trim()) return res.status(400).json({ error: 'piece and question required' });

  const key = process.env.OPENAI_API_KEY;
  if (!key) return res.status(500).json({ error: 'OPENAI_API_KEY not set' });

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.CODEX_MODEL ?? 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are an art-knowledgeable guide inside a Mac widget called SEENS. Answer questions about art, music, film, photography, poetry, architecture, and culture concisely (2-4 sentences), warm and curious tone, no emoji. If you don\'t know, say so briefly.',
          },
          {
            role: 'user',
            content: `The user is viewing "${piece.title}" by ${piece.artist} (${piece.year}), category: ${piece.cat}.\n\nSummary already shown: ${piece.caption}\nFact already shown: ${piece.fact}\n\nUser question: ${question}`,
          },
        ],
        max_tokens: 200,
        temperature: 0.7,
      }),
    });
    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content?.trim() ?? "I'm not sure about that one.";
    res.json({ reply });
  } catch (err) {
    console.error('[Guide]', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
