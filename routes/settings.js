import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getPref, setPref, clearQueue } from '../src/state.js';
import { AGENT_NAMES, getActiveAgent } from '../src/ai/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REST_PREFS_PATH = path.join(__dirname, '../USER/rest-preferences.md');

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
    ttsProvider,
    availableAgents: AGENT_NAMES,
  });
});

// POST /api/settings — update prefs
router.post('/', (req, res) => {
  const { 'tts.voice': voice, 'mood.energy': energy, prompt, workMin, restMin, location } = req.body;
  if (voice    !== undefined) setPref('tts.voice',       voice);
  if (energy   !== undefined) setPref('mood.energy',     energy);
  if (prompt   !== undefined) setPref('user.prompt',     prompt);
  if (location !== undefined) setPref('user.location',   location.trim());
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

// GET /api/settings/rest-prefs — read rest-preferences.md
router.get('/rest-prefs', (req, res) => {
  try { res.json({ content: fs.readFileSync(REST_PREFS_PATH, 'utf8') }); }
  catch { res.json({ content: '' }); }
});

// POST /api/settings/rest-prefs — write rest-preferences.md
router.post('/rest-prefs', (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
  fs.mkdirSync(path.dirname(REST_PREFS_PATH), { recursive: true });
  fs.writeFileSync(REST_PREFS_PATH, content, 'utf8');
  res.json({ ok: true });
});

// POST /api/settings/queue/clear — flush queue
router.post('/queue/clear', (req, res) => {
  clearQueue();
  res.json({ ok: true });
});

export default router;
