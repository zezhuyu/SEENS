import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getRecentMessages, getRecentPlays, getPref } from './state.js';
import { getWeatherContext } from './weather.js';

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
  const tasteRaw = readFile('USER/taste.md') || '(No taste profile yet — ask the user about their music preferences)';
  const taste = tasteRaw.length > 2000 ? tasteRaw.slice(0, 2000) + '\n...(truncated)' : tasteRaw;
  const routines = readFile('USER/routines.md');
  const moodRules = readFile('USER/mood-rules.md');

  // Fragment 3 — Environment (time, day, season, variety seed)
  const now = new Date();
  const MOODS  = ['nostalgic','energetic','dreamy','melancholic','uplifting','introspective','euphoric','raw'];
  const LENSES = ['deep cut','B-side','underrated gem','recent release','live version era','debut album feel'];
  const seed   = MOODS[now.getMinutes() % MOODS.length];
  const lens   = LENSES[Math.floor(now.getSeconds() / 10) % LENSES.length];
  const envParts = [
    `Current time: ${now.toLocaleString('en-US', { weekday: 'long', hour: '2-digit', minute: '2-digit' })}`,
    `Season: ${getSeason(now)}`,
    `Trigger: ${triggerType}`,
    `Session mood seed: ${seed} — lean toward ${lens} picks this session`,
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

  // Fragment 5 — Active agent info
  const agentPref = getPref('ai.agent', null) ?? process.env.AI_AGENT ?? 'claude';
  const agentInfo = `You are running as the ${agentPref === 'claude' ? 'Claude (Anthropic)' : 'Codex (OpenAI)'} backend.`;

  // Fragment 6 — Mood/prefs from state
  const energyPref = getPref('mood.energy', 'auto');
  const moodState = `Current energy preference: ${energyPref}`;

  // Fragment 7 — Custom user instructions
  const customPrompt = getPref('user.prompt', '').trim();

  return [
    persona,
    '---\n## User Taste Profile\n' + taste,
    routines ? '## Routines\n' + routines : '',
    moodRules ? '## Mood Rules\n' + moodRules : '',
    '## Environment\n' + env,
    calendarContext ? '## Today\'s Schedule\n' + calendarContext : '',
    '## Memory\n' + memory,
    '## Agent Info\n' + agentInfo,
    '## Mood State\n' + moodState,
    customPrompt ? '## Custom Instructions from User\n' + customPrompt : '',
  ].filter(Boolean).join('\n\n---\n\n');
}

function getSeason(date) {
  const m = date.getMonth() + 1;
  if (m >= 3 && m <= 5) return 'Spring';
  if (m >= 6 && m <= 8) return 'Summer';
  if (m >= 9 && m <= 11) return 'Autumn';
  return 'Winter';
}
