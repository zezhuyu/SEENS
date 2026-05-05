import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getSessionMessages, getRecentPlays, peekNext, getQueueTracks, getPref, getSessionSuggestions, getRecentCrossSessionSuggestions, getCrossSessionSuggestions, getRecentFeedback, getArtistFeedback, getRecentSkips, getSessionMood, getSessionContext, getTemporalPlaysProfile } from './state.js';
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
export async function buildSystemPrompt(triggerType = 'user-chat', { agentMode = false } = {}) {
  // Fragment 1 — DJ Persona
  const persona = readFile('prompts/dj-persona.md');

  // Fragment 2 — User Taste (cap at 2000 chars to keep prompts fast)
  const tasteRaw = readUserFile('taste.md') || '(No taste profile yet — ask the user about their music preferences)';
  const taste = tasteRaw.length > 2000 ? tasteRaw.slice(0, 2000) + '\n...(truncated)' : tasteRaw;
  const routines = readUserFile('routines.md');
  const moodRules = readUserFile('mood-rules.md');
  const temporalProfile = getTemporalPlaysProfile();

  // Fragment 3 — Environment (time, day, season, variety seed)
  const now = new Date();
  // Seed is fixed for the whole session so recommendations stay tonally consistent.
  const { seed, lens } = getSessionMood();
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

  // Fragment 4 — Now playing + queue order (used for both display and conversational grounding)
  const plays = getRecentPlays(7); // [0] = currently playing, [1..] = history
  const nowPlaying = plays[0] ?? null;
  const recentHistory = plays.slice(1);
  // If nothing has played yet, surface the first queued track as the active song
  const queued = peekNext();
  const queuedNow = !nowPlaying && queued[0]
    ? { title: queued[0].resolved_title ?? queued[0].title, artist: queued[0].resolved_artist ?? queued[0].artist }
    : null;
  const activeSong = nowPlaying ?? queuedNow;

  // Full ordered queue (up to 6 tracks) for the "Up Next" informational block
  // This is separate from the dedup block — it tells the AI what will play and in what order.
  const upNextTracks = getQueueTracks().slice(0, 6);

  const nowPlayingCtx = activeSong
    ? `NOW PLAYING (the song the user is currently hearing): "${activeSong.resolvedTitle ?? activeSong.title}" by ${activeSong.resolvedArtist ?? activeSong.artist ?? 'unknown'}`
    : null;

  const upNextCtx = upNextTracks.length
    ? `UP NEXT (queued in this order — these will play after the current song):\n${upNextTracks.map((t, i) => `${i + 1}. "${t.title}"${t.artist ? ` by ${t.artist}` : ''}`).join('\n')}`
    : null;

  // In agentMode the long-running agent owns conversation memory — skip injecting it here.
  const messages = agentMode ? [] : getSessionMessages(30);
  const memory = [
    recentHistory.length ? `Recently finished (already played, do not re-suggest):\n${recentHistory.map(p => `- "${p.title}" by ${p.artist ?? 'unknown'}`).join('\n')}` : '',
    messages.length ? `This session's conversation (mood instructions set here carry through the whole session):\n${messages.map(m => `${m.role}: ${m.content}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n') || '(No listening history yet)';

  // Fragment 5b — Suggestion history: queued + session + recent cross-session (hard block) + older cross-session (soft)
  const queuedTracks                 = getQueueTracks();
  const sessionSuggestions           = getSessionSuggestions();
  const recentCrossSessionSuggestions = getRecentCrossSessionSuggestions(7, 300); // last 7 days
  const olderCrossSessionSuggestions  = getCrossSessionSuggestions(75);           // older than 7 days

  // Merge queued + session + last-7-days into one hard-block list.
  const hardBlockTracks = new Map();
  const key = t => `${t.title.toLowerCase()}|||${(t.artist ?? '').toLowerCase()}`;
  for (const t of queuedTracks)                  hardBlockTracks.set(key(t), t);
  for (const t of sessionSuggestions)            hardBlockTracks.set(key(t), t);
  for (const t of recentCrossSessionSuggestions) hardBlockTracks.set(key(t), t);
  const hardBlockList = [...hardBlockTracks.values()];

  const suggestionHistory = [
    hardBlockList.length
      ? `⛔ ABSOLUTE HARD BLOCK — ${hardBlockList.length} track${hardBlockList.length > 1 ? 's' : ''} you MUST NOT suggest (already played or suggested in the last 7 days):\n${
          hardBlockList.map(s => `- "${s.title}"${s.artist ? ` by ${s.artist}` : ''}`).join('\n')
        }\nEven if a title or artist appears in your Library or Discoveries sections, skip it if it's listed here.`
      : '',
    olderCrossSessionSuggestions.length
      ? `Tracks suggested more than a week ago — avoid repeating unless user explicitly requests:\n${
          olderCrossSessionSuggestions.map(s => `- "${s.title}"${s.artist ? ` by ${s.artist}` : ''}`).join('\n')
        }`
      : '',
  ].filter(Boolean).join('\n\n');

  // Fragment 5c — User feedback: artist-level aggregation + per-track signals + skips
  const trackFeedback   = getRecentFeedback(40);
  const artistFeedback  = getArtistFeedback();
  const recentSkips     = getRecentSkips(30);
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
    recentSkips.length
      ? `Tracks the user skipped (did not want to hear) — avoid these AND songs with a similar sound/energy/genre:\n${recentSkips.map(s => `- "${s.title}"${s.artist ? ` by ${s.artist}` : ''}${s.skip_count > 1 ? ` (skipped ${s.skip_count}×)` : ''}`).join('\n')}`
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

  // Fragment 8 — User's actual music library + expanded discoveries + Spotify listening rank
  const libraryCtx     = buildLibraryContext(readUserJSON('playlists.json'), artistFeedback);
  const discoveriesCtx = buildDiscoveriesContext(readUserJSON('discoveries.json'));
  const topArtistsCtx  = buildTopArtistsContext(readUserJSON('top-artists.json'));

  const pluginCtx = pluginSystemContext();
  const sessionCtx = getSessionContext();

  return [
    persona,
    '---\n## User Taste Profile\n' + taste,
    routines ? '## Routines\n' + routines : '',
    temporalProfile ? `## Listening Habits by Time of Day\n*(Learned from play history — what the user actually listens to at each time)*\n${temporalProfile}` : '',
    moodRules ? '## Mood Rules\n' + moodRules : '',
    topArtistsCtx  ? '## Spotify Listening Rank (taste signal — use to understand genres, eras, and energy; curate freely beyond this)\n' + topArtistsCtx  : '',
    libraryCtx     ? '## User\'s Music Library (taste reference + occasional picks — not the only source)\n' + libraryCtx     : '',
    discoveriesCtx ? '## Discoverable Tracks (adjacent picks — deeper cuts and related artists)\n' + discoveriesCtx : '',
    '## Environment\n' + env,
    calendarContext ? '## Today\'s Schedule\n' + calendarContext : '',
    sessionCtx ? '## Session Context\nThe user has told you the following about their current activity or mood — honor this throughout the session:\n' + sessionCtx : '',
    nowPlayingCtx ? '## Now Playing\n' + nowPlayingCtx : '',
    upNextCtx ? '## Up Next\n' + upNextCtx : '',
    '## Session History\n' + memory,
    // Suggestion history placed immediately after session history so the AI sees
    // the hard-block list right before it writes its response — highest attention window.
    suggestionHistory ? '## Suggestion History\n' + suggestionHistory : '',
    feedbackSummary   ? '## User Feedback\n'       + feedbackSummary   : '',
    '## Agent Info\n' + agentInfo,
    '## Mood State\n' + moodState,
    customPrompt ? '## Custom Instructions from User\n' + customPrompt : '',
    pluginCtx    ? '## Plugins\n' + pluginCtx : '',
    // Repeat the hard block at the END of the prompt — LLMs pay highest attention
    // to the beginning and end. This double-anchoring prevents session repeats.
    hardBlockList.length
      ? `## ⛔ Final Reminder — Do Not Repeat\nYou MUST NOT suggest any of these ${hardBlockList.length} track${hardBlockList.length > 1 ? 's' : ''} — already played or suggested in the last 7 days:\n${hardBlockList.map(s => `- "${s.title}"${s.artist ? ` by ${s.artist}` : ''}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n\n---\n\n');
}

function getSeason(date) {
  const m = date.getMonth() + 1;
  if (m >= 3 && m <= 5) return 'Spring';
  if (m >= 6 && m <= 8) return 'Summer';
  if (m >= 9 && m <= 11) return 'Autumn';
  return 'Winter';
}

// Groups the synced library by artist for the AI.
// Sorted by user preference: artists with explicit likes first, then by track count.
// Liked artists are annotated so the AI can weight them appropriately.
function buildLibraryContext(playlists, artistFeedback = []) {
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

  // Build lookup: artist name (lowercase) → like/dislike counts from feedback
  const fbMap = new Map(
    artistFeedback.map(a => [a.artist.toLowerCase().trim(), a])
  );

  const total = [...byArtist.values()].reduce((s, v) => s + v.length, 0);
  const lines = [...byArtist.entries()]
    .sort(([aName, aTracks], [bName, bTracks]) => {
      const aLikes = fbMap.get(aName.toLowerCase())?.likes ?? 0;
      const bLikes = fbMap.get(bName.toLowerCase())?.likes ?? 0;
      if (bLikes !== aLikes) return bLikes - aLikes; // liked artists first
      return bTracks.length - aTracks.length;         // then by track count
    })
    .map(([artist, titles]) => {
      const fb = fbMap.get(artist.toLowerCase());
      const tag = fb?.likes ? ` [${fb.likes} liked${fb.dislikes ? `, ${fb.dislikes} skipped` : ''}]` : '';
      return `${artist}${tag}: ${titles.map(t => `"${t}"`).join(', ')}`;
    });

  return (
    `${total} tracks across ${byArtist.size} artists in the user's collection ` +
    `(sorted by preference — liked artists shown first with [N liked] tags):\n` +
    lines.join('\n')
  );
}

// Formats the user's Spotify top-artist list (rank = listening frequency order from Spotify).
// This is the strongest behavioral signal: who the user actually plays the most.
function buildTopArtistsContext(topArtists) {
  if (!Array.isArray(topArtists) || !topArtists.length) return null;
  const lines = topArtists.slice(0, 20).map(a => {
    const genres = a.genres?.slice(0, 3).join(', ');
    return `${a.rank}. ${a.name}${genres ? ` (${genres})` : ''}`;
  });
  return (
    `The user's ${lines.length} most-listened artists on Spotify, ranked by actual listening frequency — ` +
    `these are the strongest taste signal:\n` +
    lines.join('\n')
  );
}

// Formats the expanded catalog (artist top tracks + related artist tracks) for the AI.
// These are good discovery picks — the user loves these artists but may not own all songs.
function buildDiscoveriesContext(discoveries) {
  if (!Array.isArray(discoveries) || !discoveries.length) return null;

  const fromTopArtists = new Map();
  const fromRelated    = new Map();

  for (const t of discoveries) {
    const artist = t.artist?.trim();
    const title  = t.title?.trim();
    if (!artist || !title) continue;
    const map = t.discoverySource?.startsWith('related:') ? fromRelated : fromTopArtists;
    if (!map.has(artist)) map.set(artist, []);
    map.get(artist).push(title);
  }

  const parts = [];
  if (fromTopArtists.size) {
    const lines = [...fromTopArtists.entries()]
      .map(([a, ts]) => `${a}: ${ts.map(t => `"${t}"`).join(', ')}`);
    parts.push(`From your top artists (deeper cuts and less-heard tracks):\n${lines.join('\n')}`);
  }
  if (fromRelated.size) {
    const lines = [...fromRelated.entries()]
      .map(([a, ts]) => `${a}: ${ts.map(t => `"${t}"`).join(', ')}`);
    parts.push(`From related artists (new discovery territory):\n${lines.join('\n')}`);
  }

  return parts.length
    ? `${discoveries.length} tracks for discovery — pick freely from these to expand beyond the library:\n\n` + parts.join('\n\n')
    : null;
}
