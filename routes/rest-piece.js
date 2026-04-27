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
  Food:       { bg: 'linear-gradient(165deg,#1a1208 0%,#3a2610 35%,#7a4e18 65%,#c8882a 100%)', accent: '#e8b84b' },
  Story:      { bg: 'linear-gradient(155deg,#080e18 0%,#101e30 35%,#1a3248 65%,#234860 100%)', accent: '#4fc3f7' },
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

// Hacker News Algolia API — no key required
async function fetchHNStories(queries) {
  const seen = new Set();
  const stories = [];
  for (const q of queries.slice(0, 4)) {
    try {
      const params = new URLSearchParams({
        query: q, tags: 'story', hitsPerPage: '6', numericFilters: 'points>10',
      });
      const res = await fetch(`https://hn.algolia.com/api/v1/search?${params}`, {
        headers: { 'User-Agent': 'SeensRadio/1.0' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const hit of (data.hits ?? [])) {
        if (!hit.objectID || seen.has(hit.objectID)) continue;
        seen.add(hit.objectID);
        stories.push({
          title:  hit.title ?? '',
          url:    hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
          author: hit.author ?? '',
          points: hit.points ?? 0,
          date:   hit.created_at?.slice(0, 10) ?? '',
        });
      }
    } catch { /* network issues — skip this query */ }
  }
  return stories;
}

// Parse bullet-point topics from story-interests.md → search query strings
function parseStoryTopics(md) {
  if (!md?.trim()) return ['building with AI', 'Show HN', 'indie hacker'];
  const topics = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^[-*]\s+(.+)/);
    if (m) {
      const topic = m[1].split(/[:,]/)[0].trim();
      if (topic.length > 2 && topic.length < 100) topics.push(topic);
    }
  }
  return topics.length > 0 ? topics.slice(0, 5) : ['building with AI', 'Show HN', 'indie hacker'];
}

// NASA Image and Video Library — no API key required
async function fetchNASAImage(query) {
  if (!query?.trim()) return null;
  try {
    const params = new URLSearchParams({ q: query.trim(), media_type: 'image', page_size: '5' });
    const res = await fetch(`https://images-api.nasa.gov/search?${params}`, {
      headers: { 'User-Agent': 'SeensRadio/1.0' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const items = data.collection?.items ?? [];
    for (const item of items) {
      const preview = item.links?.find(l => l.rel === 'preview' && l.render === 'image');
      if (preview?.href) return preview.href;
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

  // For Story category: fetch real HN stories as context
  const isStory = validCat === 'Story' || (!validCat && false); // only when explicitly requested
  let hnContext = '';
  if (validCat === 'Story') {
    const storyInterestsMd = readUserFile('story-interests.md');
    const topics = parseStoryTopics(storyInterestsMd);
    const stories = await fetchHNStories(topics);
    if (stories.length > 0) {
      hnContext = '\n\n<fetched_stories>\n' +
        stories.slice(0, 15).map((s, i) =>
          `${i + 1}. "${s.title}" by ${s.author} (${s.date}, ${s.points} pts)\n   URL: ${s.url}`
        ).join('\n') +
        '\n</fetched_stories>';
    }
  }

  try {
    const userMessage = validCat === 'Story' && hnContext
      ? `Here are recently fetched stories:\n${hnContext}\n\nPick the single most compelling one for my rest break.`
      : 'Recommend one work for my rest break.';

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
- title: work title (for Food: the dish name; for Photograph: the photograph's own title or common name)
- artist: creator's full name — director / architect / poet / photographer / chef as appropriate; for Food use the chef, cook, or region/culture of origin
- year: year or period as a string (for Food: approximate year the dish was codified or became famous)
- source: (Photograph required; others optional) the collection, publication, or institution this work is from. For Photograph use the specific named source — one of: National Geographic, NASA / Hubble Space Telescope, NASA / Apollo Archive, NASA / Mars Exploration, NASA / James Webb Space Telescope, Magnum Photos, LIFE Magazine, TIME Magazine, Discovery Magazine, AP Photos, Smithsonian Magazine, National Portrait Gallery, or a specific famous photographer's archive (e.g. "Ansel Adams Archive", "Dorothea Lange / FSA", "Robert Capa / Magnum"). For Painting/Sculpture/Building use the museum if notable (e.g. "Louvre", "MoMA", "Tate Modern"). Omit for Music, Film, Poem, Food.
- caption: 2-3 sentences describing the work vividly and specifically — no generic praise. For Photograph describe exactly what is in the frame: light, subject, composition, emotional charge. For Food describe flavours, textures, and appearance concretely.
- fact: one surprising or little-known fact
- story: 3-4 sentence human narrative. For Photograph tell the story behind the shot — where the photographer was, what was happening, why they pressed the shutter, and why this image endures. For Food tell the origin story: who invented it, why, what historical or cultural forces shaped it, and why it still matters.
- url: (Story only, required) the exact URL of the story from the fetched data — copy it verbatim, do not invent URLs
- wikiTitle: the exact English Wikipedia article title for this specific work (e.g. "Afghan Girl (photograph)", "Blade Runner", "The Waste Land", "Beef Wellington", "Pillars of Creation") — for the work itself, not the artist. Required for all categories except Story. Omit for Story.
- searchQuery: (Music only) ideal YouTube Music search string — omit for all other categories

Story category guidance:
- cat must be "Story"
- title: the story's headline from the fetched list
- artist: the author's username or name from the fetched list
- year: the publication year from the fetched list
- source: "Hacker News" (or the original publication if the URL is not HN)
- caption: 2-3 sentences on what this story is about and why it's worth reading — be specific about what the person built or discovered
- story: 3-4 sentence narrative about the human behind it — their motivation, what surprised them, a concrete detail that makes it real
- fact: one surprising thing about the project, the numbers, or the outcome

Photograph source guidance — draw specifically from:
- National Geographic iconic photographs (wildlife, human interest, documentary)
- NASA archives: Hubble images, Apollo mission photos, Mars rover shots, James Webb deep-field images
- Magnum Photos collective (Cartier-Bresson, Robert Capa, Sebastião Salgado, Steve McCurry, Elliott Erwitt, etc.)
- LIFE Magazine and TIME Magazine archives (mid-20th century photojournalism)
- Famous individual photographers: Ansel Adams, Dorothea Lange, Diane Arbus, Vivian Maier, Gordon Parks, Yousuf Karsh, Edward Weston, Man Ray, Irving Penn
- Discovery / Smithsonian science photography
- Famous people who were photographers: Churchill's war portraits, Einstein candids, etc.

Guidelines:
- Avoid the most famous/obvious examples (no Mona Lisa, Beethoven 9th, pizza Margherita, "Earthrise" every time, etc.)
- Vary era, geography, gender of artist / culture of origin
- Be specific — name movements, techniques, ingredients, real details
- No emoji, no bullet points`,
          },
          { role: 'user', content: userMessage },
        ],
        max_tokens: validCat === 'Story' ? 700 : 550,
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
      Food:       ['(dish)', '(food)', '(cuisine)'],
      Story:      [],
    };
    const disambigs = (wikiDisambig[piece.cat] ?? []).map(s => `${piece.title} ${s}`);

    // Story pieces rely on the gradient background — no image lookup needed
    let imageUrl = null;

    if (piece.cat !== 'Story') {
      // For NASA-sourced photographs, try the NASA Image Library first — it has the
      // actual archive assets at high quality and is free/public.
      const isNASASource = piece.cat === 'Photograph' && /nasa/i.test(piece.source ?? '');

      if (isNASASource) {
        imageUrl = await fetchNASAImage(piece.title);
        if (!imageUrl) imageUrl = await fetchNASAImage(`${piece.title} ${piece.artist}`);
      }

      if (!imageUrl) {
        imageUrl = await fetchWikiImage([
          piece.wikiTitle,              // AI-provided exact title (most reliable)
          piece.title,                  // bare title
          ...disambigs,                 // category-specific disambiguations
          piece.artist,                 // artist's own Wikipedia page as portrait fallback
        ]);
      }

      // Broader fallback: Wikipedia full-text search — catches obscure/disambiguated articles
      if (!imageUrl) imageUrl = await fetchWikiImageSearch(`${piece.title} ${piece.artist}`);
      if (!imageUrl) imageUrl = await fetchWikiImageSearch(piece.title);

      // Final NASA fallback for any photograph that still has no image
      if (!imageUrl && piece.cat === 'Photograph') {
        imageUrl = await fetchNASAImage(`${piece.title} ${piece.artist}`);
      }

      if (!imageUrl) console.warn(`[RestPiece] No image found for "${piece.title}"`);
    }

    res.json({ ...piece, ...gradient, imageUrl });
  } catch (err) {
    console.error('[RestPiece]', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
