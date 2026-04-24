import express from 'express';
import { readUserFile } from '../src/paths.js';

const router = express.Router();

const CATEGORY_GRADIENTS = {
  Painting:   { bg: 'linear-gradient(160deg,#2a1a0e 0%,#5a3520 40%,#8a6040 70%,#c8a878 100%)', accent: '#c8a878' },
  Photograph: { bg: 'linear-gradient(180deg,#0a0e1a 0%,#1a2235 45%,#3d4458 75%,#8a8475 100%)', accent: '#d9d2bc' },
  Music:      { bg: 'linear-gradient(200deg,#2a2449 0%,#3f3666 40%,#7a6ea3 75%,#c9c2dc 100%)', accent: '#c9c2dc' },
  Film:       { bg: 'linear-gradient(150deg,#1a0a0e 0%,#3a1520 40%,#7a2a30 70%,#c06050 100%)', accent: '#f0c070' },
  Poem:       { bg: 'linear-gradient(170deg,#1e2e1a 0%,#3a5233 40%,#7a8f5c 70%,#d4cfa0 100%)', accent: '#d4cfa0' },
  Place:      { bg: 'linear-gradient(180deg,#0e1820 0%,#1a3040 45%,#3a6070 75%,#88b0c0 100%)', accent: '#88b0c0' },
  Building:   { bg: 'linear-gradient(190deg,#2a3035 0%,#4d5459 35%,#8a8478 70%,#c2b8a4 100%)', accent: '#c2b8a4' },
  Sculpture:  { bg: 'linear-gradient(160deg,#3a2a5a 0%,#6a5a8a 35%,#a090b0 65%,#d8d0e8 100%)', accent: '#d8d0e8' },
};

const ALL_CATS = Object.keys(CATEGORY_GRADIENTS);

function readPrefs() {
  return readUserFile('rest-preferences.md');
}

// Try multiple Wikipedia article titles until one returns an image
async function fetchWikiImage(candidates) {
  const headers = { 'User-Agent': 'SeensRadio/1.0 (cultural-rest-break-app)' };
  for (const title of candidates) {
    if (!title?.trim()) continue;
    try {
      const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.trim())}`;
      const res = await fetch(url, { headers });
      if (!res.ok) continue;
      const data = await res.json();
      const img = data.thumbnail?.source ?? data.originalimage?.source ?? null;
      if (img) return img;
    } catch { /* try next */ }
  }
  return null;
}

// Broader fallback: Wikipedia full-text search with pageimages — works for obscure works
// where the exact article title isn't known or has no thumbnail in page/summary.
async function fetchWikiImageSearch(query) {
  if (!query?.trim()) return null;
  try {
    const params = new URLSearchParams({
      action: 'query', format: 'json', origin: '*',
      generator: 'search', gsrsearch: query.trim(), gsrlimit: '5',
      prop: 'pageimages', pithumbsize: '800',
    });
    const res = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, {
      headers: { 'User-Agent': 'SeensRadio/1.0' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const pages = Object.values(data.query?.pages ?? {});
    for (const page of pages) {
      if (page.thumbnail?.source) return page.thumbnail.source;
    }
  } catch {}
  return null;
}

router.get('/', async (req, res) => {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return res.status(500).json({ error: 'OPENAI_API_KEY not set' });

  const requestedCat = req.query.cat;
  const validCat = ALL_CATS.includes(requestedCat) ? requestedCat : null;
  const catLine = validCat
    ? `The category must be "${validCat}".`
    : `Choose any category from: ${ALL_CATS.join(', ')}. Vary widely across categories.`;

  const prefs = readPrefs();
  const prefsSection = prefs ? `\n\nUser preferences for rest pieces:\n${prefs}` : '';

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.CODEX_MODEL ?? 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `You curate one cultural work as a short creative rest break for a focused person who values depth and taste. ${catLine}${prefsSection}

Return JSON with exactly these fields:
- cat: one of ${ALL_CATS.join(', ')}
- title: work title
- artist: creator's full name (director / architect / poet / photographer as appropriate)
- year: year as a string
- caption: 2-3 sentences describing the work vividly and specifically — no generic praise
- fact: one surprising or little-known fact
- story: 3-4 sentence human narrative — the circumstances of creation, a detail that reframes the work, or why it still matters
- wikiTitle: the exact English Wikipedia article title for this specific work (e.g. "Afghan Girl (photograph)", "Blade Runner", "The Waste Land") — for the work itself, not the artist. This field is required and must be a real Wikipedia article.
- searchQuery: (Music only) ideal YouTube Music search string — omit for non-music

Guidelines:
- Avoid the most famous/obvious examples (no Mona Lisa, Beethoven 9th, etc.)
- Vary era, geography, gender of artist
- Be specific — name movements, techniques, real details
- No emoji, no bullet points`,
          },
          { role: 'user', content: 'Recommend one work for my rest break.' },
        ],
        max_tokens: 550,
        temperature: 1.1,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI error ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) throw new Error('No content from AI');

    const piece = JSON.parse(raw);
    if (!ALL_CATS.includes(piece.cat)) piece.cat = validCat ?? 'Painting';
    const gradient = CATEGORY_GRADIENTS[piece.cat];

    // Fetch Wikipedia thumbnail — try multiple candidate titles
    // Wikipedia uses specific disambiguation suffixes; try the most likely ones per category
    const wikiDisambig = {
      Music:      ['(song)', '(album)', '(single)'],
      Film:       ['(film)', '(movie)'],
      Poem:       ['(poem)'],
      Painting:   ['(painting)'],
      Photograph: ['(photograph)', '(photo)'],
      Sculpture:  ['(sculpture)'],
      Building:   [],
      Place:      [],
    };
    const disambigs = (wikiDisambig[piece.cat] ?? []).map(s => `${piece.title} ${s}`);

    let imageUrl = await fetchWikiImage([
      piece.wikiTitle,              // AI-provided exact title (most reliable)
      piece.title,                  // bare title
      ...disambigs,                 // category-specific disambiguations
      piece.artist,                 // artist's own Wikipedia page as portrait fallback
    ]);

    // Broader fallback: Wikipedia full-text search — catches obscure/disambiguated articles
    if (!imageUrl) imageUrl = await fetchWikiImageSearch(`${piece.title} ${piece.artist}`);
    if (!imageUrl) imageUrl = await fetchWikiImageSearch(piece.title);

    if (!imageUrl) console.warn(`[RestPiece] No image found for "${piece.title}"`);

    res.json({ ...piece, ...gradient, imageUrl });
  } catch (err) {
    console.error('[RestPiece]', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
