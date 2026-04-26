import express from 'express';
import fs from 'fs';
import { getPref, setPref, clearQueue } from '../src/state.js';
import { AGENT_NAMES, getActiveAgent } from '../src/ai/index.js';
import { ensureUserDir, userPath, readUserFile } from '../src/paths.js';

const REST_PREFS_PATH      = userPath('rest-preferences.md');
const STORY_INTERESTS_PATH = userPath('story-interests.md');
const ROUTINES_PATH        = userPath('routines.md');
const MOOD_RULES_PATH      = userPath('mood-rules.md');
const TASTE_PATH           = userPath('taste.md');

const router = express.Router();

// GET /api/settings — all user-facing prefs
router.get('/', (req, res) => {
  const ttsProvider = process.env.TTS_PROVIDER ?? 'elevenlabs';
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

// GET /api/settings/agent — current active agent
router.get('/agent', (req, res) => {
  const { name } = getActiveAgent();
  res.json({ agent: name, available: AGENT_NAMES });
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

// POST /api/settings/queue/clear — flush queue
router.post('/queue/clear', (req, res) => {
  clearQueue();
  res.json({ ok: true });
});

export default router;
