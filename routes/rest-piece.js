import express from 'express';
import { readUserFile } from '../src/paths.js';
import { recordRestPiece, getRecentRestPieces } from '../src/state.js';
import { callPlugin, loadPlugins, pluginSystemContext } from '../src/plugin-runner.js';

const router = express.Router();

const CATEGORY_GRADIENTS = {
  Painting:   { bg: 'linear-gradient(160deg,#2a1a0e 0%,#5a3520 40%,#8a6040 70%,#c8a878 100%)', accent: '#c8a878' },
  Photograph: { bg: 'linear-gradient(180deg,#0a0e1a 0%,#1a2235 45%,#3d4458 75%,#8a8475 100%)', accent: '#d9d2bc' },
  Music:      { bg: 'linear-gradient(200deg,#2a2449 0%,#3f3666 40%,#7a6ea3 75%,#c9c2dc 100%)', accent: '#c9c2dc' },
  Podcast:    { bg: 'linear-gradient(200deg,#13243d 0%,#20466f 40%,#4e79a7 75%,#c6d7f0 100%)', accent: '#c6d7f0' },
  'White Noise': { bg: 'linear-gradient(180deg,#1b2028 0%,#39424f 45%,#77808b 75%,#d6dce2 100%)', accent: '#d6dce2' },
  Quote:      { bg: 'linear-gradient(180deg,#1d1722 0%,#32263b 40%,#66506c 72%,#d8c8da 100%)', accent: '#d8c8da' },
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

function extractRestAudioDirective(...sources) {
  const lines = sources.filter(Boolean).join('\n').split('\n');
  const captured = [];
  let active = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const header = line.match(/^(?:#{1,6}\s*)?(rest audio|break audio|audio during breaks|rest content|break content|rest mode)\b[:\-–—]?\s*(.*)$/i);
    if (header) {
      active = true;
      if (header[2]) captured.push(header[2]);
      continue;
    }

    if (active) {
      if (/^#{1,6}\s+/.test(line)) {
        active = false;
        continue;
      }
      captured.push(line);
    }
  }

  const text = captured.join(' ').toLowerCase();
  if (!text.trim()) return null;

  const kinds = [
    { kind: 'White Noise', patterns: ['white noise', 'ambient', 'soundscape', 'brown noise', 'pink noise', 'rain', 'nature'] },
    { kind: 'Podcast',     patterns: ['podcast', 'episode', 'show', 'talk'] },
    { kind: 'Music',       patterns: ['music', 'playlist', 'song', 'track', 'album'] },
    { kind: 'Quote',       patterns: ['quote', 'excerpt', 'passage', 'wiki'] },
  ];

  let best = null;
  for (const entry of kinds) {
    for (const pattern of entry.patterns) {
      const idx = text.indexOf(pattern);
      if (idx === -1) continue;
      if (!best || idx < best.idx) best = { kind: entry.kind, idx };
    }
  }

  return best?.kind ?? null;
}

function normalizeRestCat(cat) {
  const value = String(cat ?? '').trim().toLowerCase();
  const map = {
    quote: 'Quote',
    podcast: 'Podcast',
    music: 'Music',
    'white noise': 'White Noise',
    'white-noise': 'White Noise',
    whitenoise: 'White Noise',
    painting: 'Painting',
    photograph: 'Photograph',
    film: 'Film',
    poem: 'Poem',
    place: 'Place',
    building: 'Building',
    sculpture: 'Sculpture',
    food: 'Food',
    story: 'Story',
  };
  return map[value] ?? cat;
}

function parseRestPiecePreferences(md) {
  const text = String(md ?? '');
  const lines = text.split('\n');
  const preferred = [];
  const avoided = [];

  for (const line of lines) {
    const preferredMatch = line.match(/preferred categories(?:\s*\(.*?\))?\s*:\s*(.+)$/i);
    if (preferredMatch) {
      preferred.push(...preferredMatch[1].split(',').map(s => normalizeRestCat(s.trim())).filter(Boolean));
    }

    const avoidMatch = line.match(/avoid or reduce\s*:\s*(.+)$/i);
    if (avoidMatch) {
      avoided.push(...avoidMatch[1].split(',').map(s => normalizeRestCat(s.trim())).filter(Boolean));
    }
  }

  const lower = text.toLowerCase();
  const noteLines = lines.map(l => l.trim()).filter(Boolean);

  return {
    preferred: [...new Set(preferred)],
    avoided: [...new Set(avoided)],
    prefersVisuals: /visual presence|more photograph|more photography|image|artwork|artworks|art work|art works|visual art|less text|less text related work/.test(lower),
    prefersAudio: /podcast|music|white noise|white noises|ambient|soundscape|noise/.test(lower),
    prefersText: /quote|story|snippet|passage|wiki/.test(lower),
    notes: noteLines,
  };
}

function pickRestCategory({ prefsMd = '', routinesMd = '', storyTopics = [], explicitCat = null }) {
  if (explicitCat) {
    return { cat: normalizeRestCat(explicitCat), theme: storyTopics[0] ?? null, reason: 'explicit' };
  }

  const prefs = parseRestPiecePreferences(prefsMd);
  const directive = extractRestAudioDirective(routinesMd, prefsMd);
  const theme = storyTopics.length ? storyTopics.slice(0, 2).join(', ') : null;

  if (directive) {
    return { cat: directive, theme, reason: `directive:${directive}` };
  }

  const preferredCat = prefs.preferred.map(normalizeRestCat).find(cat => ALL_CATS.includes(cat));
  if (preferredCat) {
    return { cat: preferredCat, theme, reason: `preferred:${preferredCat}` };
  }

  const score = new Map(ALL_CATS.map(cat => [cat, 0]));
  const bump = (cats, delta) => {
    for (const cat of cats) {
      if (score.has(cat)) score.set(cat, score.get(cat) + delta);
    }
  };

  for (const cat of prefs.preferred) bump([cat], 5);
  for (const cat of prefs.avoided) bump([cat], -8);

  if (prefs.prefersVisuals) bump(['Painting', 'Photograph', 'Film', 'Place', 'Building', 'Sculpture'], 4);
  if (prefs.prefersAudio) bump(['Music', 'Podcast', 'White Noise'], 3);
  if (prefs.prefersText) bump(['Quote', 'Story', 'Podcast'], 2);

  const storyText = storyTopics.join(' ').toLowerCase();
  const strongPreference = prefs.preferred.length > 0 || prefs.prefersVisuals || prefs.prefersAudio || prefs.prefersText;
  if (storyText && !strongPreference) {
    if (/\b(build|startup|ai|llm|coding|developer|maker|lesson|project|founder)\b/.test(storyText)) {
      bump(['Story'], 8);
      bump(['Quote', 'Podcast'], 3);
    }
    if (/\b(show hn|hacker news|hn|indie hacker|builder|founder story|launch)\b/.test(storyText)) {
      bump(['Story'], 8);
    }
    if (/\b(quote|essay|writing|book|reading|snippet|sentence)\b/.test(storyText)) {
      bump(['Quote'], 4);
    }
    if (/\b(podcast|interview|talk|show)\b/.test(storyText)) {
      bump(['Podcast'], 4);
    }
    if (/\b(music|song|album|artist|sound)\b/.test(storyText)) {
      bump(['Music'], 4);
    }
    if (/\b(ambient|noise|focus|calm|work|study|white)\b/.test(storyText)) {
      bump(['White Noise'], 4);
    }
  }

  // If the preferences lean heavily visual and there are no text/audio hints, bias toward artwork.
  if (prefs.prefersVisuals && !prefs.prefersText && !prefs.prefersAudio) {
    bump(['Painting', 'Photograph'], 2);
  }

  let bestCat = 'Painting';
  let bestScore = -Infinity;
  for (const cat of ALL_CATS) {
    const s = score.get(cat) ?? 0;
    if (s > bestScore) {
      bestScore = s;
      bestCat = cat;
    }
  }

  return { cat: bestCat, theme, reason: 'picker' };
}

function trimPluginData(data, maxLen = 300) {
  if (Array.isArray(data)) return data.map(item => trimPluginData(item, maxLen));
  if (!data || typeof data !== 'object') return data;
  return Object.fromEntries(Object.entries(data).map(([k, v]) => {
    if (typeof v === 'string' && v.length > maxLen) return [k, v.slice(0, maxLen) + '…'];
    if (v && typeof v === 'object') return [k, trimPluginData(v, maxLen)];
    return [k, v];
  }));
}

async function callPluginAndPoll(pluginName, endpoint, params = {}) {
  let result = await callPlugin(pluginName, endpoint, params);
  const isPending = value => value && typeof value === 'object' && !Array.isArray(value) && (
    value.pending === true ||
    value.status === 'pending' ||
    value.state === 'pending'
  );

  for (let i = 0; i < 5 && isPending(result); i++) {
    await new Promise(r => setTimeout(r, 4_000));
    result = await callPlugin(pluginName, endpoint, params);
  }
  return result;
}

function resolvePluginUrl(rawUrl, pluginName) {
  if (!rawUrl || /^https?:\/\//.test(rawUrl) || rawUrl.startsWith('file://')) return rawUrl ?? null;
  const plugin = loadPlugins().find(p => p.name === pluginName);
  if (rawUrl.startsWith('/') && plugin?.baseUrl && /^https?:\/\//.test(plugin.baseUrl)) {
    return plugin.baseUrl.replace(/\/$/, '') + rawUrl;
  }
  return rawUrl;
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

  const prefs = readPrefs();
  const prefsSection = prefs ? `\n\nUser preferences for rest pieces:\n${prefs}` : '';
  const routines = readUserFile('routines.md');
  const storyInterestsMd = readUserFile('story-interests.md');
  const storyTopics = parseStoryTopics(storyInterestsMd);
  const picker = pickRestCategory({ prefsMd: prefs, routinesMd: routines, storyTopics, explicitCat: validCat });
  const selectedCat = picker.cat;
  const pluginCtx = pluginSystemContext();

  const recentPieces = getRecentRestPieces();
  const recentSection = recentPieces.length
    ? `\n\nDo NOT repeat any of these recently shown works — pick something entirely different:\n${recentPieces.map(p => `- "${p.title}"${p.artist ? ` by ${p.artist}` : ''} [${p.cat}]`).join('\n')}`
    : '';

  const pickerSection = `\n\nRest picker: ${selectedCat}${picker.theme ? `\nTheme anchor: ${picker.theme}` : ''}${picker.reason ? `\nPicker reason: ${picker.reason}` : ''}`;

  const audioDirectiveSection = picker.cat && ['Quote', 'Podcast', 'Music', 'White Noise'].includes(selectedCat)
    ? `\n\nRest audio / quote directive selected by the picker: ${selectedCat}. Use this when the user has asked for rest-time audio or a quote.`
    : '';

  const pluginSection = pluginCtx ? `\n\n${pluginCtx}` : '';
  const wikiPluginSection = `\n\nIf a personal wiki plugin is available in the plugin list above, use it for sentence-level snippets and let the plugin tell you where its wiki index or notes live. Do not assume a local file path or invent a wiki source.`;

  const isStoryMode = selectedCat === 'Story';
  const isAudioOrQuoteMode = ['Quote', 'Podcast', 'Music', 'White Noise'].includes(selectedCat);
  const isArtMode = !isStoryMode && !isAudioOrQuoteMode;

  // For Story category: fetch real HN stories as context
  let hnContext = '';
  if (isStoryMode) {
    const stories = await fetchHNStories(storyTopics);
    if (stories.length > 0) {
      hnContext = '\n\n<fetched_stories>\n' +
        stories.slice(0, 15).map((s, i) =>
          `${i + 1}. "${s.title}" by ${s.author} (${s.date}, ${s.points} pts)\n   URL: ${s.url}`
        ).join('\n') +
        '\n</fetched_stories>';
    }
  }

  try {
    const userMessage = isStoryMode && hnContext
      ? `Here are recently fetched stories:\n${hnContext}\n\nPick the single most compelling one for my rest break.`
      : isAudioOrQuoteMode
        ? `Recommend one rest-time item that follows the picker-selected mode: ${selectedCat}. Prefer a real quote or sentence snippet from a wiki-like source or connected plugin when the mode is Quote. Prefer a playable recommendation from a connected plugin or music service when the mode is Podcast, Music, or White Noise. If a plugin can supply the content, use it.`
        : 'Recommend one work for my rest break.';

    const systemPrompt = isArtMode
      ? `You curate one cultural work as a short creative rest break for a focused person who values depth and taste. The category must be "${selectedCat}".${prefsSection}${pickerSection}${recentSection}

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
- No emoji, no bullet points`
      : isStoryMode
        ? `You curate one Story rest break. Use the user's story interests to find a relevant Hacker News story or other story-like rest item. The story topics are:\n${storyTopics.join('\n') || '(none)'}${prefsSection}${pickerSection}${recentSection}${pluginSection}

Return JSON with exactly these fields:
- cat: Story
- title: the story headline or rest-story title
- artist: the author / creator / speaker
- year: the publication year if known
- source: the publication or source
- caption: 2-3 sentences about why it fits the user's interests
- fact: one surprising fact
- story: 3-4 sentence narrative
- url: a source URL if available
- audioUrl: if the story is actually an audio story or podcast, include the playable URL
- pluginCall: object with { plugin, endpoint, params } if a connected plugin should fetch it; otherwise null

Rules:
- Prefer fetched Hacker News stories when available.
- Do not invent URLs.`
        : `You curate one rest-time recommendation for a focused person. Use the user's break piece preferences to decide whether to return a quote, podcast, music, white-noise, or a cultural work. The personal wiki is usually sentence-based, so quote the sentence or a short snippet directly — do not turn it into an art/object description. When the user asks for a quote, prefer a real sentence or short snippet from a wiki-like source or a connected plugin. Keep quote mode text-first — do not default to pictures or art objects. When the user asks for audio, prefer a connected plugin or music service that can supply playable audio.${audioDirectiveSection}${prefsSection}${wikiPluginSection}${pickerSection}${recentSection}${pluginSection}

Return JSON with exactly these fields:
- kind: one of Quote, Podcast, Music, White Noise, Painting, Photograph, Film, Poem, Place, Building, Sculpture, Food, Story
- title: the thing being recommended or quoted
- artist: creator / speaker / host / artist / publisher, if known
- year: year or period as a string, if known
- source: origin of the quote or audio, if applicable
- caption: 2-3 sentences describing the recommendation concretely
- fact: one surprising or useful thing about it
- story: 3-4 sentence context or why it fits this break
- url: a source URL if available
- wikiTitle: exact Wikipedia title if applicable
- searchQuery: search string if useful for YouTube Music or a plugin
- audioUrl: a playable URL if a plugin or service provided one
- imageUrl: image URL if available
- pluginCall: object with { plugin, endpoint, params } when a plugin should be called to fetch the real content; otherwise null

Rules:
- If a plugin can provide the quote/audio directly, use pluginCall.
- If the result is quote-like, keep it short, exact, and properly sourced. For Quote kind, the "quote" may be a sentence or snippet from a wiki-like source.
- If the result is audio, prefer a playable recommendation and set audioUrl when available.
- Do not invent URLs or quotes.`;
;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.CODEX_MODEL ?? 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        max_tokens: isStoryMode ? 700 : 650,
        temperature: 1.05,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI error ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) throw new Error('No content from AI');

    let piece = JSON.parse(raw);
    if (!piece || typeof piece !== 'object') throw new Error('AI returned invalid JSON');
    if (piece.kind && !piece.cat) piece.cat = piece.kind;
    piece.cat = normalizeRestCat(piece.cat ?? selectedCat ?? 'Painting');
    if (!validCat && selectedCat && piece.cat !== selectedCat) piece.cat = selectedCat;
    if (!CATEGORY_GRADIENTS[piece.cat]) piece.cat = selectedCat ?? 'Painting';
    const gradient = CATEGORY_GRADIENTS[piece.cat] ?? CATEGORY_GRADIENTS.Painting;

    // Optional plugin two-pass: quote/audio providers can deliver raw text or audio URLs.
    if (piece.pluginCall?.plugin && piece.pluginCall?.endpoint) {
      const { plugin: pluginName, endpoint, params = {} } = piece.pluginCall;
      try {
        const pluginData = await callPluginAndPoll(pluginName, endpoint, params);
        const trimmedData = trimPluginData(pluginData);
        const pluginAudioUrl = resolvePluginUrl(
          pluginData?.audio_url ?? pluginData?.audioUrl ?? pluginData?.url ?? null,
          pluginName,
        );
        const pluginImageUrl = resolvePluginUrl(
          pluginData?.image_url ?? pluginData?.imageUrl ?? pluginData?.image ?? null,
          pluginName,
        );
        const pluginPrompt = `You are finishing a rest-time recommendation. The plugin data is already fetched. Produce the final JSON object and do not emit pluginCall again.

Fetched plugin data:
${JSON.stringify(trimmedData, null, 2)}

Copy values exactly when present:
- audio_url / audioUrl / url → audioUrl
- image_url / imageUrl / image → imageUrl
- title → title

If the plugin returned a quote or transcript excerpt, use it as the caption or story.
If it returned audio, keep the recommendation concise and set cat to Podcast, Music, or White Noise as appropriate.
If it returned only text, summarize it into the rest recommendation.

Return JSON with exactly the same fields as before.`;

        const followup = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: process.env.CODEX_MODEL ?? 'gpt-4o-mini',
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: pluginPrompt },
              { role: 'user', content: `[Data fetched]\n${JSON.stringify(trimmedData, null, 2)}` },
            ],
            max_tokens: 700,
            temperature: 0.9,
          }),
        });

        if (followup.ok) {
          const followupData = await followup.json();
          const followupRaw = followupData.choices?.[0]?.message?.content;
          if (followupRaw) {
            const merged = JSON.parse(followupRaw);
            piece = {
              ...piece,
              ...merged,
              audioUrl: merged.audioUrl ?? pluginAudioUrl ?? piece.audioUrl ?? null,
              imageUrl: merged.imageUrl ?? pluginImageUrl ?? piece.imageUrl ?? null,
              title: merged.title ?? piece.title,
              artist: merged.artist ?? piece.artist,
              cat: normalizeRestCat(merged.cat ?? piece.cat),
            };
          }
        }
      } catch (err) {
        console.warn('[RestPiece] plugin pass failed:', err.message);
        if (!piece.audioUrl) piece.audioUrl = null;
      }
    }

    // Fetch Wikipedia thumbnail — try multiple candidate titles
    // Wikipedia uses specific disambiguation suffixes; try the most likely ones per category
    const wikiDisambig = {
      Music:      ['(song)', '(album)', '(single)'],
      Podcast:    ['(podcast)', '(episode)', '(show)'],
      'White Noise': [],
      Quote:      [],
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

    // Story pieces rely on the gradient background — no image lookup needed.
    // Quote/podcast/white-noise modes may already have a plugin image or a plain text result.
    let imageUrl = piece.imageUrl ?? null;

    if (piece.cat !== 'Story' && piece.cat !== 'Quote' && piece.cat !== 'Podcast' && piece.cat !== 'White Noise') {
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

    recordRestPiece({ title: piece.title, artist: piece.artist ?? '', cat: piece.cat });
    res.json({ ...piece, ...gradient, imageUrl });
  } catch (err) {
    console.error('[RestPiece]', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
