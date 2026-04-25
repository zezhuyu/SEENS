import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getRecentMessages, getRecentPlays, getPref, getTodaySuggestions, getCrossSessionSuggestions, getRecentFeedback, getArtistFeedback } from './state.js';
import { getWeatherContext } from './weather.js';
import { getLocation } from './location.js';
import { readUserFile, readUserJSON } from './paths.js';
import { pluginSystemContext } from './plugin-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function readFile(relPath) {
  try { return fs.readFileSync(path.join(ROOT, relPath), 'utf8'); }
  catch { return ''; }
}

async function getCalendarContext() {
  const parts = [];

  if (getPref('google.access_token')) {
    try {
      const { getTodayEvents } = await import('../auth/google-calendar-auth.js');
      const events = await getTodayEvents();
      if (events) parts.push(events);
    } catch (err) {
      console.warn('[Context] Google Calendar:', err.message);
    }
  }

  if (getPref('microsoft.access_token')) {
    try {
      const { getTodayEvents } = await import('../auth/microsoft-auth.js');
      const events = await getTodayEvents();
      if (events) parts.push(events);
    } catch (err) {
      console.warn('[Context] Microsoft Calendar:', err.message);
    }
  }

  return parts.join('\n\n') || null;
}

// Assemble the system prompt sent to the active AI agent
export async function buildSystemPrompt(triggerType = 'user-chat') {
  // Fragment 1 — DJ Persona
  const persona = readFile('prompts/dj-persona.md');

  // Fragment 2 — User Taste (cap at 2000 chars to keep prompts fast)
  const tasteRaw = readUserFile('taste.md') || '(No taste profile yet — ask the user about their music preferences)';
  const taste = tasteRaw.length > 2000 ? tasteRaw.slice(0, 2000) + '\n...(truncated)' : tasteRaw;
  const routines = readUserFile('routines.md');
  const moodRules = readUserFile('mood-rules.md');

  // Fragment 3 — Environment (time, day, season, variety seed)
  const now = new Date();
  const MOODS  = ['nostalgic','energetic','dreamy','melancholic','uplifting','introspective','euphoric','raw'];
  const LENSES = ['deep cut','B-side','underrated gem','recent release','live version era','debut album feel'];
  const seed   = MOODS[now.getMinutes() % MOODS.length];
  const lens   = LENSES[Math.floor(now.getSeconds() / 10) % LENSES.length];
  const userLocation = getLocation();
  const envParts = [
    `Current time: ${now.toLocaleString('en-US', { weekday: 'long', hour: '2-digit', minute: '2-digit' })}`,
    `Season: ${getSeason(now)}`,
    `Trigger: ${triggerType}`,
    `Session mood seed: ${seed} — lean toward ${lens} picks this session`,
    ...(userLocation ? [`User location: ${userLocation}`] : []),
  ];

  // Weather (async, non-blocking — falls back gracefully)
  const [weather, calendarContext] = await Promise.all([
    getWeatherContext().catch(() => null),
    getCalendarContext().catch(() => null),
  ]);
  if (weather) envParts.push(`Weather: ${weather}`);
  const env = envParts.join('\n');

  // Fragment 4 — Memory (recent plays + messages)
  const plays = getRecentPlays(6);
  const messages = getRecentMessages(4);
  const memory = [
    plays.length ? `Recent plays:\n${plays.map(p => `- ${p.title} by ${p.artist ?? 'unknown'} (${p.source})`).join('\n')}` : '',
    messages.length ? `Recent conversation:\n${messages.map(m => `${m.role}: ${m.content}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n') || '(No listening history yet)';

  // Fragment 5b — Suggestion history: today (strict) + cross-session (soft)
  const todaySuggestions = getTodaySuggestions();
  const crossSessionSuggestions = getCrossSessionSuggestions(25);
  const suggestionHistory = [
    todaySuggestions.length
      ? `Tracks already suggested TODAY — do not suggest these again under any circumstances:\n${
          todaySuggestions.map(s => `- "${s.title}"${s.artist ? ` by ${s.artist}` : ''}`).join('\n')
        }`
      : '',
    crossSessionSuggestions.length
      ? `Tracks suggested in recent past sessions — avoid repeating unless specifically requested:\n${
          crossSessionSuggestions.map(s => `- "${s.title}"${s.artist ? ` by ${s.artist}` : ''}`).join('\n')
        }`
      : '',
  ].filter(Boolean).join('\n\n');

  // Fragment 5c — User feedback: artist-level aggregation + per-track signals
  const trackFeedback   = getRecentFeedback(40);
  const artistFeedback  = getArtistFeedback();
  const likedArtists    = artistFeedback.filter(a => a.likes > 0);
  const dislikedArtists = artistFeedback.filter(a => a.dislikes > 0);
  const likedTracks     = trackFeedback.filter(f => f.rating === 'like');
  const dislikedTracks  = trackFeedback.filter(f => f.rating === 'dislike');
  const feedbackParts   = [
    likedArtists.length
      ? `Artists this user consistently loves (bias toward these):\n${likedArtists.map(a => `- ${a.artist} (${a.likes} liked track${a.likes > 1 ? 's' : ''}${a.dislikes ? `, ${a.dislikes} disliked` : ''})`).join('\n')}`
      : '',
    dislikedArtists.filter(a => a.dislikes > 0 && a.likes === 0).length
      ? `Artists to avoid entirely:\n${dislikedArtists.filter(a => a.likes === 0).map(a => `- ${a.artist} (${a.dislikes} disliked)`).join('\n')}`
      : '',
    likedTracks.length
      ? `Individual tracks loved:\n${likedTracks.map(f => `- "${f.title}"${f.artist ? ` by ${f.artist}` : ''}`).join('\n')}`
      : '',
    dislikedTracks.length
      ? `Individual tracks to avoid:\n${dislikedTracks.map(f => `- "${f.title}"${f.artist ? ` by ${f.artist}` : ''}`).join('\n')}`
      : '',
  ].filter(Boolean);
  const feedbackSummary = feedbackParts.join('\n\n');

  // Fragment 5 — Active agent info
  const agentPref = getPref('ai.agent', null) ?? process.env.AI_AGENT ?? 'claude';
  const agentInfo = `You are running as the ${agentPref === 'claude' ? 'Claude (Anthropic)' : 'Codex (OpenAI)'} backend.`;

  // Fragment 6 — Mood/prefs from state
  const energyPref = getPref('mood.energy', 'auto');
  const moodState = `Current energy preference: ${energyPref}`;

  // Fragment 7 — Custom user instructions
  const customPrompt = getPref('user.prompt', '').trim();

  // Fragment 8 — User's actual music library (prefer these tracks when relevant)
  const libraryCtx = buildLibraryContext(readUserJSON('playlists.json'));

  const pluginCtx = pluginSystemContext();

  return [
    persona,
    '---\n## User Taste Profile\n' + taste,
    routines ? '## Routines\n' + routines : '',
    moodRules ? '## Mood Rules\n' + moodRules : '',
    libraryCtx ? '## User\'s Music Library\n' + libraryCtx : '',
    '## Environment\n' + env,
    calendarContext ? '## Today\'s Schedule\n' + calendarContext : '',
    '## Memory\n' + memory,
    suggestionHistory ? '## Suggestion History\n' + suggestionHistory : '',
    feedbackSummary   ? '## User Feedback\n'       + feedbackSummary   : '',
    '## Agent Info\n' + agentInfo,
    '## Mood State\n' + moodState,
    customPrompt ? '## Custom Instructions from User\n' + customPrompt : '',
    pluginCtx    ? '## Plugins\n' + pluginCtx : '',
  ].filter(Boolean).join('\n\n---\n\n');
}

function getSeason(date) {
  const m = date.getMonth() + 1;
  if (m >= 3 && m <= 5) return 'Spring';
  if (m >= 6 && m <= 8) return 'Summer';
  if (m >= 9 && m <= 11) return 'Autumn';
  return 'Winter';
}

// Groups the synced library by artist and formats it compactly for the AI.
// The AI should prefer these tracks when they fit the mood — they are verified
// to exist in the user's collection and will resolve cleanly.
function buildLibraryContext(playlists) {
  if (!Array.isArray(playlists) || !playlists.length) return null;

  const byArtist = new Map();
  for (const t of playlists) {
    const artist = t.artist?.trim();
    const title  = t.title?.trim();
    if (!artist || !title) continue;
    if (!byArtist.has(artist)) byArtist.set(artist, []);
    byArtist.get(artist).push(title);
  }
  if (!byArtist.size) return null;

  const total = [...byArtist.values()].reduce((s, v) => s + v.length, 0);
  const lines = [...byArtist.entries()]
    .sort((a, b) => b[1].length - a[1].length) // most tracks first
    .map(([artist, titles]) => `${artist}: ${titles.map(t => `"${t}"`).join(', ')}`);

  return (
    `These ${total} tracks across ${byArtist.size} artists are in the user's actual library — ` +
    `strongly prefer suggesting from these when they fit the mood:\n` +
    lines.join('\n')
  );
}
