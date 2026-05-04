import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPref, setPref, clearQueue, setSessionStart, getSessionContext } from '../src/state.js';
import { AGENT_NAMES, getActiveAgentName, agentStatus, agentReset } from '../src/ai/index.js';
import { ensureUserDir, userPath, readUserFile } from '../src/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '../.env');

// Keys exposed via settings API — never include private auth tokens or key files
const EXPOSED_ENV_KEYS = [
  'TTS_PROVIDER',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_VOICE_ID',
  'OPENAI_API_KEY',
  'OPENAI_TTS_MODEL',
  'OPENAI_TTS_VOICE',
  'SPOTIFY_CLIENT_ID',
  'YOUTUBE_CLIENT_ID',
  'YOUTUBE_CLIENT_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
  'APPLE_KEY_ID',
  'APPLE_TEAM_ID',
  'APPLE_PRIVATE_KEY_PATH',
];

function readEnvFile() {
  try { return fs.readFileSync(ENV_PATH, 'utf8'); } catch { return ''; }
}

function writeEnvKey(key, value) {
  let content = readEnvFile();
  const regex = new RegExp(`^(#\\s*)?${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  if (regex.test(content)) {
    content = content.replace(regex, line);
  } else {
    content = content.trimEnd() + `\n${line}\n`;
  }
  fs.writeFileSync(ENV_PATH, content, 'utf8');
  process.env[key] = value;
}

function maskValue(val) {
  if (!val) return '';
  return val.length <= 4 ? '****' : val.slice(0, 4) + '****';
}

const REST_PREFS_PATH      = userPath('rest-preferences.md');
const STORY_INTERESTS_PATH = userPath('story-interests.md');
const ROUTINES_PATH        = userPath('routines.md');
const MOOD_RULES_PATH      = userPath('mood-rules.md');
const TASTE_PATH           = userPath('taste.md');

const router = express.Router();

// GET /api/settings — all user-facing prefs
router.get('/', (req, res) => {
  const ttsProvider = getPref('tts.provider', process.env.TTS_PROVIDER ?? 'elevenlabs');
  res.json({
    agent:       getPref('ai.agent',       process.env.AI_AGENT ?? 'claude'),
    voice:       getPref('tts.voice',      ''),
    energy:      getPref('mood.energy',    'auto'),
    prompt:      getPref('user.prompt',    ''),
    location:    getPref('user.location',  ''),
    workMin:     parseInt(getPref('session.workMin', '45')),
    restMin:     parseInt(getPref('session.restMin', '5')),
    chatSpeak:   getPref('tts.chatSpeak',  '1') !== '0',
    ttsProvider,
    availableAgents: AGENT_NAMES,
  });
});

// POST /api/settings — update prefs
router.post('/', (req, res) => {
  const { 'tts.voice': voice, 'mood.energy': energy, prompt, workMin, restMin, location, chatSpeak } = req.body;
  if (voice      !== undefined) setPref('tts.voice',       voice);
  if (energy     !== undefined) setPref('mood.energy',     energy);
  if (prompt     !== undefined) setPref('user.prompt',     prompt);
  if (chatSpeak  !== undefined) setPref('tts.chatSpeak',   chatSpeak ? '1' : '0');
  if (location !== undefined) {
    const loc = location.trim();
    setPref('user.location', loc);
    setPref('user.location.pinned', loc ? '1' : '');
  }
  if (workMin  !== undefined) setPref('session.workMin', String(parseInt(workMin) || 45));
  if (restMin  !== undefined) setPref('session.restMin', String(parseInt(restMin) || 5));
  res.json({ ok: true });
});

// GET /api/settings/agent — current active agent + live process status
router.get('/agent', async (req, res) => {
  const name = getActiveAgentName();
  try {
    const status = await agentStatus();
    res.json({ agent: name, available: AGENT_NAMES, process: status });
  } catch {
    res.json({ agent: name, available: AGENT_NAMES, process: null });
  }
});

// POST /api/settings/agent — switch agent at runtime
router.post('/agent', (req, res) => {
  const { agent } = req.body;
  if (!agent || !AGENT_NAMES.includes(agent.toLowerCase())) {
    return res.status(400).json({ error: `Invalid agent. Valid: ${AGENT_NAMES.join(', ')}` });
  }
  setPref('ai.agent', agent.toLowerCase());
  res.json({ agent: agent.toLowerCase() });
});

// POST /api/settings/agent/reset — clear agent memory and start fresh session
router.post('/agent/reset', async (req, res) => {
  try {
    await agentReset();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/settings/reranker — reranker enabled state + health
router.get('/reranker', async (req, res) => {
  const enabled = getPref('reranker.enabled', '0') === '1';
  let health = null;
  if (enabled) {
    try {
      const r = await fetch('http://127.0.0.1:7480/api/health', { signal: AbortSignal.timeout(2000) });
      health = r.ok ? await r.json() : null;
    } catch { health = null; }
  }
  res.json({ enabled, reachable: !!health, health });
});

// POST /api/settings/reranker — enable or disable
router.post('/reranker', (req, res) => {
  const { enabled } = req.body;
  setPref('reranker.enabled', enabled ? '1' : '0');
  res.json({ enabled: !!enabled });
});

// GET /api/settings/auth-status — which music services are connected
router.get('/auth-status', (req, res) => {
  res.json({
    spotify:   !!getPref('spotify.access_token'),
    youtube:   !!getPref('youtube.access_token'),
    apple:     !!getPref('apple.user_token'),
    google:    !!getPref('google.access_token'),
    microsoft: !!getPref('microsoft.access_token'),
  });
});

// Markdown file endpoints (read/write USER/*.md)
// Reads via readUserFile so files in the dev-repo USER/ are visible before
// the user saves for the first time (same two-path fallback as context.js).
// Writes go to userPath() (Electron data dir) which takes priority thereafter.
function mdRoutes(writePath, filename) {
  return [
    (req, res) => res.json({ content: readUserFile(filename) }),
    (req, res) => {
      const { content } = req.body;
      if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
      ensureUserDir();
      fs.writeFileSync(writePath, content, 'utf8');
      res.json({ ok: true });
    },
  ];
}

const [getRest,      postRest]      = mdRoutes(REST_PREFS_PATH,      'rest-preferences.md');
const [getStory,     postStory]     = mdRoutes(STORY_INTERESTS_PATH,  'story-interests.md');
const [getRoutines,  postRoutines]  = mdRoutes(ROUTINES_PATH,         'routines.md');
const [getMoodRules, postMoodRules] = mdRoutes(MOOD_RULES_PATH,       'mood-rules.md');
const [getTaste,     postTaste]     = mdRoutes(TASTE_PATH,            'taste.md');

router.get('/rest-prefs',      getRest);       router.post('/rest-prefs',      postRest);
router.get('/story-interests', getStory);      router.post('/story-interests', postStory);
router.get('/routines',        getRoutines);   router.post('/routines',        postRoutines);
router.get('/mood-rules',      getMoodRules);  router.post('/mood-rules',      postMoodRules);
router.get('/taste',           getTaste);      router.post('/taste',           postTaste);

// GET /api/settings/env-keys — current values masked (first 4 chars + ****)
router.get('/env-keys', (req, res) => {
  const result = {};
  for (const key of EXPOSED_ENV_KEYS) {
    result[key] = maskValue(process.env[key] ?? '');
  }
  res.json(result);
});

// POST /api/settings/env-keys — write to .env and hot-reload into process.env immediately
router.post('/env-keys', (req, res) => {
  const updated = [];
  for (const key of EXPOSED_ENV_KEYS) {
    const val = req.body[key];
    if (typeof val === 'string' && val.trim() !== '') {
      writeEnvKey(key, val.trim());
      updated.push(key);
    }
  }
  // Persist TTS_PROVIDER to prefs so it survives restart (asar .env is read-only in packaged app)
  if (typeof req.body['TTS_PROVIDER'] === 'string' && req.body['TTS_PROVIDER'].trim()) {
    setPref('tts.provider', req.body['TTS_PROVIDER'].trim());
  }
  res.json({ ok: true, updated });
});

// POST /api/settings/queue/clear — flush queue
router.post('/queue/clear', (req, res) => {
  clearQueue();
  res.json({ ok: true });
});

// POST /api/settings/session/start — mark session start so the DJ remembers all instructions from it
router.post('/session/start', (req, res) => {
  setSessionStart();
  res.json({ ok: true });
});

// GET /api/settings/session/context — current session context the DJ has captured
router.get('/session/context', (req, res) => {
  res.json({ context: getSessionContext() });
});

export default router;
