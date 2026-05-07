import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { getPref, setPref, clearQueue, setSessionStart, getSessionContext, getSessionMood, getSessionMoodLabel } from '../src/state.js';
import { AGENT_NAMES, getActiveAgentName, agentStatus, agentReset } from '../src/ai/index.js';
import { isRerankerEnabled, enableReranker, disableReranker, isSubprocessRunning, getHealth as getRerankerHealth, seedPlaylist, seedLibrary } from '../src/reranker.js';
import { reloadSchedule, regenerateSchedule } from '../src/scheduler.js';
import { ensureUserDir, userPath, readUserFile, readUserJSON } from '../src/paths.js';

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
const RERANKER_BINARY_PATH  = userPath('reranker', 'seens-reranker');
const RERANKER_PACKAGE_DIR  = userPath('reranker', 'seens-reranker-package');

const router = express.Router();

function removeIfExists(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}

function signExecutable(executablePath) {
  const signingRoot = executablePath.startsWith(RERANKER_PACKAGE_DIR)
    ? RERANKER_PACKAGE_DIR
    : executablePath;
  try { execFileSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', signingRoot], { stdio: 'ignore' }); } catch {}
  try { execFileSync('/usr/bin/xattr', ['-dr', 'com.apple.provenance', signingRoot], { stdio: 'ignore' }); } catch {}
  try {
    execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', executablePath], { stdio: 'pipe' });
  } catch (err) {
    const stderr = err.stderr?.toString?.() || err.message;
    throw new Error(`codesign failed: ${stderr}`);
  }
}

function findPackagedReranker(rootDir) {
  const queue = [rootDir];
  for (let depth = 0; queue.length && depth < 5; depth++) {
    const level = queue.splice(0);
    for (const dir of level) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isFile() && entry.name === 'seens-reranker') return p;
        if (entry.isDirectory() && !entry.name.startsWith('__MACOSX')) queue.push(p);
      }
    }
  }
  return null;
}

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

// GET /api/settings/reranker — enabled state + subprocess/health status
router.get('/reranker', async (req, res) => {
  const enabled    = isRerankerEnabled();
  const running    = isSubprocessRunning();
  const scriptPath = getPref('reranker.script', null);
  const binaryPath = getPref('reranker.binary', '');
  const health     = enabled ? await getRerankerHealth() : null;
  res.json({ enabled, running, reachable: !!health, health, scriptPath, binaryPath, binaryInstalled: !!binaryPath && fs.existsSync(binaryPath) });
});

// POST /api/settings/reranker — enable (spawns subprocess) or disable (kills it)
router.post('/reranker', async (req, res) => {
  const { enabled, scriptPath, binaryPath } = req.body;
  const currentScript = getPref('reranker.script', null);
  const currentBinary = getPref('reranker.binary', '');
  const nextScript = scriptPath !== undefined ? (scriptPath || null) : currentScript;
  const nextBinary = binaryPath !== undefined ? (binaryPath || null) : currentBinary;
  const pathChanged = (scriptPath !== undefined && nextScript !== currentScript) ||
    (binaryPath !== undefined && nextBinary !== currentBinary);
  const restartNeeded = isSubprocessRunning() && pathChanged;
  if (scriptPath !== undefined) setPref('reranker.script', nextScript);
  if (binaryPath !== undefined) setPref('reranker.binary', nextBinary);
  if (restartNeeded) {
    await disableReranker();
  }
  if (enabled) {
    enableReranker();
  } else if (!restartNeeded) {
    await disableReranker();
  }
  res.json({ enabled: !!enabled, running: isSubprocessRunning() });
});

// PUT /api/settings/reranker/binary — upload a standalone executable or zipped onedir package
router.put('/reranker/binary', async (req, res) => {
  try {
    ensureUserDir();
    fs.mkdirSync(path.dirname(RERANKER_BINARY_PATH), { recursive: true });
    const uploadedName = String(req.headers['x-reranker-filename'] || '').toLowerCase();
    const tmpPath = `${RERANKER_BINARY_PATH}.upload-${Date.now()}`;
    let bytes = 0;
    const out = fs.createWriteStream(tmpPath, { mode: 0o755 });

    req.on('data', chunk => { bytes += chunk.length; });
    req.on('aborted', () => {
      try { out.destroy(); } catch {}
      try { fs.unlinkSync(tmpPath); } catch {}
    });

    out.on('error', err => {
      try { fs.unlinkSync(tmpPath); } catch {}
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });

    out.on('finish', async () => {
      try {
        let installedPath = RERANKER_BINARY_PATH;

        const isZip = uploadedName.endsWith('.zip') || (() => {
          const fd = fs.openSync(tmpPath, 'r');
          try {
            const sig = Buffer.alloc(4);
            fs.readSync(fd, sig, 0, 4, 0);
            return sig[0] === 0x50 && sig[1] === 0x4b;
          } finally {
            fs.closeSync(fd);
          }
        })();

        if (isZip) {
          const extractDir = `${RERANKER_PACKAGE_DIR}.upload-${Date.now()}`;
          removeIfExists(extractDir);
          fs.mkdirSync(extractDir, { recursive: true });
          execFileSync('/usr/bin/ditto', ['-x', '-k', tmpPath, extractDir]);

          const executable = findPackagedReranker(extractDir);
          if (!executable) throw new Error('No seens-reranker executable found in uploaded package');

          removeIfExists(RERANKER_PACKAGE_DIR);
          fs.renameSync(path.dirname(executable), RERANKER_PACKAGE_DIR);
          removeIfExists(extractDir);
          try { fs.unlinkSync(tmpPath); } catch {}
          installedPath = path.join(RERANKER_PACKAGE_DIR, 'seens-reranker');
        } else {
          fs.chmodSync(tmpPath, 0o755);
          fs.renameSync(tmpPath, RERANKER_BINARY_PATH);
        }

        fs.chmodSync(installedPath, 0o755);
        signExecutable(installedPath);
        setPref('reranker.binary', installedPath);

        const shouldRestart = getPref('reranker.enabled', '0') === '1';
        if (shouldRestart) {
          await disableReranker();
          enableReranker();
        }

        res.json({ ok: true, bytes, binaryPath: installedPath, restarted: shouldRestart });
      } catch (err) {
        try { fs.unlinkSync(tmpPath); } catch {}
        if (!res.headersSent) res.status(500).json({ error: err.message });
      }
    });

    req.pipe(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// GET  /api/settings/schedule — return current schedule.json sessions
// POST /api/settings/schedule/reload — re-read schedule.json and reschedule cron jobs
router.get('/schedule', (req, res) => {
  try {
    const data = fs.readFileSync(userPath('schedule.json'), 'utf8');
    res.json({ sessions: JSON.parse(data) });
  } catch {
    res.json({ sessions: [] });
  }
});
router.post('/schedule/reload', (req, res) => {
  try {
    const sessions = reloadSchedule();
    res.json({ ok: true, sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/settings/schedule/regenerate — re-run AI generation from routines.md + mood-rules.md
router.post('/schedule/regenerate', async (req, res) => {
  try {
    const sessions = await regenerateSchedule();
    res.json({ ok: true, sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

// POST /api/settings/reranker/seed-library — embed tracks from ALL connected music services.
// Fetches liked/library songs live from each connected service at click time so the seed
// always reflects the current library, not whatever was cached in playlists.json.
router.post('/reranker/seed-library', async (req, res) => {
  if (!isRerankerEnabled() || !isSubprocessRunning()) {
    return res.status(503).json({ error: 'Reranker not running — enable it first' });
  }

  const perSource = parseInt(req.body?.limit) || 200;
  const connected = {
    spotify: !!getPref('spotify.access_token'),
    youtube: !!getPref('youtube.access_token'),
    apple:   !!getPref('apple.user_token'),
  };

  if (!connected.spotify && !connected.youtube && !connected.apple) {
    return res.status(400).json({ error: 'No music services connected — connect Spotify, YouTube, or Apple Music in settings first' });
  }

  // Fetch liked/library tracks live from every connected service in parallel.
  // Each service is isolated — a failure in one never blocks the others.
  const fetched = { spotify: [], youtube: [], apple: [] };
  const errors  = [];

  await Promise.all([
    connected.spotify && (async () => {
      try {
        const { syncLikedSongs } = await import('../music/spotify.js');
        fetched.spotify = (await syncLikedSongs(perSource)).slice(0, perSource);
        console.log(`[SeedLibrary] Spotify: ${fetched.spotify.length} liked songs`);
      } catch (err) {
        errors.push(`spotify: ${err.message}`);
        console.warn('[SeedLibrary] Spotify fetch failed:', err.message);
      }
    })(),

    connected.youtube && (async () => {
      try {
        const { syncLikedVideos } = await import('../music/youtube.js');
        fetched.youtube = (await syncLikedVideos()).slice(0, perSource);
        console.log(`[SeedLibrary] YouTube: ${fetched.youtube.length} liked videos`);
      } catch (err) {
        errors.push(`youtube: ${err.message}`);
        console.warn('[SeedLibrary] YouTube fetch failed:', err.message);
      }
    })(),

    connected.apple && (async () => {
      try {
        const { syncLibrarySongs } = await import('../music/apple-music.js');
        fetched.apple = (await syncLibrarySongs()).slice(0, perSource);
        console.log(`[SeedLibrary] Apple Music: ${fetched.apple.length} library songs`);
      } catch (err) {
        errors.push(`apple: ${err.message}`);
        console.warn('[SeedLibrary] Apple Music fetch failed:', err.message);
      }
    })(),
  ].filter(Boolean));

  // Deduplicate across services by title::artist (keeps first-seen source)
  const allFetched = [...fetched.spotify, ...fetched.youtube, ...fetched.apple].filter(Boolean);
  const seen = new Map();
  for (const t of allFetched) {
    if (!t?.title) continue;
    const key = `${t.title.toLowerCase().trim()}::${(t.artist ?? '').toLowerCase().trim()}`;
    if (!seen.has(key)) seen.set(key, t);
  }
  const tracks = [...seen.values()];

  if (!tracks.length) {
    return res.status(400).json({
      error: errors.length
        ? `All services failed — ${errors.join('; ')}`
        : 'No tracks found in your connected libraries',
    });
  }

  const savedPlaylists = JSON.parse(getPref('reranker.saved_playlists', '[]'));
  const sourceBreakdown = Object.entries(fetched)
    .filter(([, v]) => v.length > 0)
    .map(([s, v]) => `${s}:${v.length}`);
  if (savedPlaylists.length) sourceBreakdown.push(`saved_playlists:${savedPlaylists.length}`);
  if (errors.length) console.warn('[SeedLibrary] partial failures:', errors);

  res.json({ ok: true, total: tracks.length, message: `Seeding started (${sourceBreakdown.join(', ')})` });

  // Seed library tracks, then saved playlist URLs — all in background
  (async () => {
    try {
      await seedLibrary(tracks, { limit: tracks.length });
    } catch (err) {
      console.warn('[SeedLibrary] seed error:', err.message);
    }
    for (const playlistUrl of savedPlaylists) {
      try {
        console.log(`[SeedLibrary] seeding saved playlist: ${playlistUrl}`);
        await seedPlaylist(playlistUrl, { limit: perSource, downloadAudio: true });
      } catch (err) {
        console.warn(`[SeedLibrary] saved playlist seed error (${playlistUrl}):`, err.message);
      }
    }
  })();
});

// GET /api/settings/reranker/seed-progress — poll current seed status
router.get('/reranker/seed-progress', async (req, res) => {
  if (!isRerankerEnabled() || !isSubprocessRunning()) {
    return res.json({ running: false, ok: 0, skipped: 0, fail: 0, total: 0 });
  }
  try {
    const { getSeedProgress } = await import('../src/reranker.js');
    const progress = await getSeedProgress();
    res.json(progress ?? { running: false, ok: 0, skipped: 0, fail: 0, total: 0 });
  } catch {
    res.json({ running: false, ok: 0, skipped: 0, fail: 0, total: 0 });
  }
});

// POST /api/settings/reranker/seed — fetch playlist from URL and embed songs
// Fire-and-forget like seed-library — poll /seed-progress for status
// Also saves the URL so "Seed music library" includes it automatically next time.
router.post('/reranker/seed', async (req, res) => {
  const { url, limit, downloadAudio } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url required' });
  }
  if (!isRerankerEnabled() || !isSubprocessRunning()) {
    return res.status(503).json({ error: 'Reranker not running — enable it first' });
  }
  // Persist this URL so seed-library includes it going forward
  const saved = JSON.parse(getPref('reranker.saved_playlists', '[]'));
  if (!saved.includes(url)) {
    saved.push(url);
    setPref('reranker.saved_playlists', JSON.stringify(saved));
  }
  const resolvedLimit = parseInt(limit) || 200;
  res.json({ ok: true, total: resolvedLimit, message: 'Seeding started' });
  seedPlaylist(url, {
    limit: resolvedLimit,
    downloadAudio: downloadAudio ?? true,
  }).catch(err => console.warn('[Settings] seed-url error:', err.message));
});

// GET /api/settings/reranker/saved-playlists — list saved playlist URLs
router.get('/reranker/saved-playlists', (req, res) => {
  res.json(JSON.parse(getPref('reranker.saved_playlists', '[]')));
});

// DELETE /api/settings/reranker/saved-playlists — remove a saved playlist URL
router.delete('/reranker/saved-playlists', (req, res) => {
  const { url } = req.body;
  const saved = JSON.parse(getPref('reranker.saved_playlists', '[]'));
  setPref('reranker.saved_playlists', JSON.stringify(saved.filter(u => u !== url)));
  res.json({ ok: true });
});

// POST /api/settings/queue/clear — flush queue
router.post('/queue/clear', (req, res) => {
  clearQueue();
  res.json({ ok: true });
});

// POST /api/settings/session/start — mark session start so the DJ remembers all instructions from it
router.post('/session/start', (req, res) => {
  setSessionStart();
  res.json({
    ok: true,
    mood: {
      ...getSessionMood(),
      label: getSessionMoodLabel(),
    },
  });
});

// GET /api/settings/session/context — current session context the DJ has captured
router.get('/session/context', (req, res) => {
  res.json({
    context: getSessionContext(),
    mood: {
      ...getSessionMood(),
      label: getSessionMoodLabel(),
    },
  });
});

export default router;
