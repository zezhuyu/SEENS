/**
 * Optional reranker bridge for seens-radio.
 *
 * When the reranker is enabled via the UI, this module spawns
 * a standalone reranker binary (preferred) or falls back to the
 * legacy subprocess_main.py path and communicates with it over JSON-RPC
 * on stdin/stdout — no separate server needed.
 *
 * The HTTP API path (RERANKER_URL) is kept as a fallback for when the
 * standalone server is already running externally.
 *
 * Launch target resolution order:
 *   1. RERANKER_BINARY env var
 *   2. reranker.binary pref (set via settings UI)
 *   3. user data dir binary (USER/reranker/seens-reranker)
 *   4. RERANKER_SCRIPT env var
 *   5. reranker.script pref (legacy fallback)
 *   6. ../seens-reranker/subprocess_main.py  (sibling repo fallback)
 */

import { spawn }          from 'child_process';
import readline           from 'readline';
import fs                 from 'fs';
import path               from 'path';
import { fileURLToPath }  from 'url';
import { getPref, setPref } from './state.js';
import { userPath } from './paths.js';
import { getWeatherContext } from './weather.js';
import { fetchLyricsBatch } from '../music/lyrics.js';

const ROOT          = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_SCRIPT = path.join(ROOT, 'seens-reranker', 'subprocess_main.py');
const DEFAULT_BINARY = userPath('reranker', 'seens-reranker');
const DEFAULT_BINARY_PACKAGE = userPath('reranker', 'seens-reranker-package', 'seens-reranker');

// ─── Canonical song ID ────────────────────────────────────────────────────────
// Must match Python's _canonical_key() in seens-reranker/reranker/sync.py:
//   norm = re.sub(r"[^a-z0-9]", "", s.lower())
//   key  = f"lib:{norm(title)}___{norm(artist)}"
// Using a unified scheme everywhere (seeding, reranking, feedback) so DB
// lookups always hit — Spotify URIs dropped as IDs in favour of canonical keys.
function _norm(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
export function canonicalSongId(track) {
  return `lib:${_norm(track.title)}___${_norm(track.artist || '')}`;
}
const RERANKER_URL  = process.env.RERANKER_URL ?? 'http://127.0.0.1:7480';
const CONNECT_TIMEOUT  = 3_000;
const RERANK_TIMEOUT   = 120_000;   // model inference once loaded (runs in parallel — latency ok)
const WARMUP_TIMEOUT   = 15 * 60_000; // first run may download model from HuggingFace

// ─── Subprocess state ─────────────────────────────────────────────────────────

let _proc          = null;
let _rl            = null;
let _pending       = new Map();   // id → { resolve, reject }
let _idCounter     = 0;
let _warmupPromise = null;        // resolves true (ready) or false (failed) once model is loaded
let _restartTimer  = null;        // debounce handle for auto-restart
let _stopRequested = false;       // suppress restart when disableReranker() intentionally stops it
let _restartAttempts = 0;         // bounded crash-loop protection

export function isRerankerInstalled() {
  try { return !!_launchTarget(); } catch { return false; }
}

function _binaryPath() {
  return process.env.RERANKER_BINARY
      ?? getPref('reranker.binary', null)
      ?? DEFAULT_BINARY;
}

function _scriptPath() {
  return process.env.RERANKER_SCRIPT
      ?? getPref('reranker.script', null)
      ?? DEFAULT_SCRIPT;
}

function _binaryLaunchTarget() {
  const binary = _binaryPath();
  if (binary && fs.existsSync(binary)) {
    const stat = fs.statSync(binary);
    if (stat.isFile()) {
      return { kind: 'binary', command: binary, args: [], cwd: path.dirname(binary) };
    }
    if (stat.isDirectory()) {
      for (const rel of ['seens-reranker', 'Contents/MacOS/seens-reranker']) {
        const candidate = path.join(binary, rel);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return { kind: 'binary', command: candidate, args: [], cwd: path.dirname(candidate) };
        }
      }
    }
  }

  if (fs.existsSync(DEFAULT_BINARY_PACKAGE) && fs.statSync(DEFAULT_BINARY_PACKAGE).isFile()) {
    return { kind: 'binary', command: DEFAULT_BINARY_PACKAGE, args: [], cwd: path.dirname(DEFAULT_BINARY_PACKAGE) };
  }
  return null;
}

function _scriptLaunchTarget() {
  const script = _scriptPath();
  if (script && fs.existsSync(script)) {
    const repoRoot = path.dirname(script);
    let python = process.env.RERANKER_PYTHON ?? 'python3';
    for (const venvDir of ['.venv', 'venv']) {
      const candidate = path.join(repoRoot, venvDir, 'bin', 'python3');
      if (fs.existsSync(candidate)) { python = candidate; break; }
    }
    return { kind: 'script', command: python, args: [script], cwd: repoRoot };
  }

  return null;
}

function _launchTarget() {
  return _binaryLaunchTarget() ?? _scriptLaunchTarget();
}

function _spawnSubprocess() {
  if (isSubprocessRunning()) return;
  _warmupPromise = null;
  _stopRequested = false;
  const launch = _launchTarget();
  if (!launch) throw new Error('No reranker binary or script available');
  console.log(`[Reranker] spawning subprocess: ${launch.command} ${launch.args.join(' ')}`);
  _proc = spawn(launch.command, launch.args, {
    cwd: launch.cwd ?? process.cwd(),
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, SEENS_RERANKER_MANAGED: '1' },
  });

  let _spawnFailed = false;
  _proc.on('error', err => {
    console.error('[Reranker] subprocess error:', err.message);
    _spawnFailed = true;
    _proc = null;
  });

  _proc.on('exit', (code, signal) => {
    console.warn(`[Reranker] subprocess exited (code=${code} signal=${signal})`);
    _proc = null;
    _rl   = null;
    _warmupPromise = null;
    // Reject any in-flight calls
    for (const [, { reject }] of _pending) reject(new Error('Reranker subprocess exited'));
    _pending.clear();
    // Auto-restart only for unexpected exits. Deliberate shutdowns/restarts
    // set _stopRequested so we do not immediately loop forever on SIGTERM.
    const crashed = code !== 0 && signal !== 'SIGTERM';
    if (!_spawnFailed && !_stopRequested && isRerankerEnabled() && crashed) {
      _restartAttempts += 1;
      if (_restartAttempts > 3) {
        console.warn('[Reranker] crash-loop detected — disabling auto-restart until user toggles reranker');
        setPref('reranker.enabled', '0');
        return;
      }
      const delay = Math.min(30_000, 5_000 * _restartAttempts);
      console.log(`[Reranker] unexpected exit — restarting in ${delay / 1000}s (attempt ${_restartAttempts}/3)`);
      clearTimeout(_restartTimer);
      _restartTimer = setTimeout(() => {
        if (!isSubprocessRunning() && isRerankerEnabled()) {
          console.log('[Reranker] auto-restarting subprocess after crash');
          _spawnSubprocess();
          _warmup();
        }
      }, delay);
    }
  });

  _rl = readline.createInterface({ input: _proc.stdout, terminal: false });
  _rl.on('line', line => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const cb = _pending.get(String(msg.id));
    if (!cb) return;
    _pending.delete(String(msg.id));
    msg.error ? cb.reject(new Error(msg.error)) : cb.resolve(msg.result);
  });
}

function _call(method, params, timeoutMs = RERANK_TIMEOUT) {
  return new Promise((resolve, reject) => {
    if (!_proc) return reject(new Error('Reranker subprocess not running'));
    const id = String(++_idCounter);
    const timer = setTimeout(() => {
      _pending.delete(id);
      reject(new Error(`Reranker ${method} timeout`));
    }, timeoutMs);
    _pending.set(id, {
      resolve: v => { clearTimeout(timer); resolve(v); },
      reject:  e => { clearTimeout(timer); reject(e); },
    });
    _proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}

// ─── Public lifecycle ─────────────────────────────────────────────────────────

export function isRerankerEnabled() {
  return isRerankerInstalled() && getPref('reranker.enabled', '0') === '1';
}

export function isSubprocessRunning() {
  return _proc !== null && !_proc.killed;
}

/**
 * Enable the reranker — spawns the subprocess if not already running.
 * Called by POST /api/settings/reranker { enabled: true }.
 */
export function enableReranker() {
  setPref('reranker.enabled', '1');
  if (!isSubprocessRunning()) {
    try {
      _spawnSubprocess();
      _warmup();
    } catch (err) {
      console.error('[Reranker] failed to spawn subprocess:', err.message);
    }
  }
}

function _warmup() {
  // Models are eagerly loaded at subprocess startup — use `health` to wait for
  // them without any DB writes (avoids "database is locked" when two processes
  // share the DB during development).
  console.log('[Reranker] waiting for subprocess — model may download from HuggingFace on first run (up to 15 min)');
  _warmupPromise = _call('health', {}, WARMUP_TIMEOUT)
    .then(h => {
      const loaded = Object.values(h?.models_loaded ?? {}).filter(Boolean).length;
      _restartAttempts = 0;
      console.log(`[Reranker] warm-up done — ${loaded} model(s) ready`);
      return true;
    })
    .catch(err => { console.warn('[Reranker] warm-up failed (non-fatal):', err.message); return false; });
}

/**
 * Disable the reranker — shuts down the subprocess.
 * Called by POST /api/settings/reranker { enabled: false }.
 */
export async function disableReranker() {
  setPref('reranker.enabled', '0');
  _stopRequested = true;
  clearTimeout(_restartTimer);
  _restartTimer = null;
  if (isSubprocessRunning()) {
    try { await _call('shutdown', {}, 3_000); } catch { /* ignore */ }
    try { _proc.kill(); } catch { /* ignore */ }
    _proc = null;
    _rl   = null;
  }
}

// ─── Core rerank call ─────────────────────────────────────────────────────────

/**
 * Rerank a list of candidate tracks.
 * Uses the subprocess when running, falls back to HTTP API if not.
 *
 * @param {Array<{title,artist,source,uri?}>} candidates
 * @param {object} contextOverrides — { mood, energy, weather_code, has_event }
 * @returns {Array|null}  ranked candidates or null if unavailable
 */
export async function rerank(candidates, contextOverrides = {}) {
  if (!candidates?.length || !isRerankerEnabled()) return null;

  // Fetch real lyrics for all candidates in parallel (5 s timeout each).
  // Better lyrics → richer BGE embeddings → more accurate reranking.
  const [context, lyricsList] = await Promise.all([
    _buildContext(contextOverrides),
    fetchLyricsBatch(candidates),
  ]);

  const songs = candidates.map((t, i) => ({
    id:     canonicalSongId(t),
    title:  t.title,
    artist: t.artist ?? '',
    source: t.source ?? 'any',
    lyrics: lyricsList[i] ?? `${t.title} ${t.artist ?? ''}`,
  }));

  // ── Subprocess path (preferred) ─────────────────────────────────────────────
  if (isSubprocessRunning()) {
    // Wait for warm-up to finish before the real call — ensures models are loaded.
    // If warmup failed (e.g. transient DB lock), still attempt the real call;
    // the DB may be free by now and real inference doesn't need warmup to succeed.
    if (_warmupPromise) await _warmupPromise;

    if (isSubprocessRunning()) {
      try {
        const result = await _call('rerank', { candidates: songs, context, top_k: songs.length }, RERANK_TIMEOUT);
        return _mapBack(result?.songs ?? result, candidates);
      } catch (err) {
        console.warn('[Reranker] subprocess call failed:', err.message, '— trying HTTP');
      }
    }
  }

  // ── HTTP fallback (standalone API server) ───────────────────────────────────
  return _rerankHttp(songs, context, candidates);
}

async function _rerankHttp(songs, context, candidates) {
  try {
    const res = await fetch(`${RERANKER_URL}/api/rerank`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ candidates: songs, context, top_k: songs.length }),
      signal:  AbortSignal.timeout(RERANK_TIMEOUT),
    });
    if (!res.ok) { console.warn('[Reranker] HTTP', res.status); return null; }
    const { songs: ranked } = await res.json();
    return _mapBack(ranked, candidates);
  } catch (err) {
    console.warn('[Reranker] HTTP failed:', err.message, '— bypassing');
    return null;
  }
}

function _mapBack(ranked, candidates) {
  if (!ranked?.length) return null;
  const idMap = new Map(candidates.map(t => [canonicalSongId(t), t]));
  return ranked.map(r => {
    const orig = idMap.get(r.id) ?? { title: r.title, artist: r.artist, source: 'any' };
    return { ...orig, reranker_score: r.reranker_score, attention_weights: r.attention_weights };
  });
}

async function _buildContext(overrides = {}) {
  let weather_code = overrides.weather_code ?? null;
  if (weather_code === null) {
    try {
      const wRaw = await getWeatherContext();
      const m = wRaw?.match(/\b(\d{1,3})\b/);
      if (m) weather_code = parseInt(m[1]);
    } catch { /* non-critical */ }
  }
  const now = new Date();
  return {
    time_of_day:  now.getHours() / 24,
    day_of_week:  now.getDay()   / 6,
    weather_code,
    mood:      overrides.mood      ?? null,
    energy:    overrides.energy    ?? null,
    has_event: overrides.has_event ?? false,
  };
}

// ─── Health check ─────────────────────────────────────────────────────────────

export async function getHealth() {
  if (isSubprocessRunning()) {
    try {
      const h = await _call('health', {}, CONNECT_TIMEOUT);
      return { source: 'subprocess', ...h };
    } catch { /* fall through */ }
  }
  // Try HTTP
  try {
    const res = await fetch(`${RERANKER_URL}/api/health`, {
      signal: AbortSignal.timeout(CONNECT_TIMEOUT),
    });
    if (res.ok) return { source: 'http', ...(await res.json()) };
  } catch { /* unreachable */ }
  return null;
}

// ─── Playlist seed ────────────────────────────────────────────────────────────

/**
 * Fetch up to `limit` songs from a YouTube playlist URL via yt-dlp,
 * embed them with all available models, and store in the reranker DB.
 *
 * @param {string} url  — YouTube playlist (or channel/video) URL
 * @param {{ limit?: number, downloadAudio?: boolean }} opts
 * @returns {Promise<{ ok, fail, total, fetched }>}
 */
export async function seedPlaylist(url, { limit = 200, downloadAudio = true } = {}) {
  return _call('seed', { url, limit, download_audio: downloadAudio }, 30 * 60_000);
}

/**
 * Seed the reranker DB from connected music service tracks.
 * For each track: searches YouTube, downloads 60s audio, embeds with all 3 models.
 * Already-embedded songs are skipped.
 *
 * @param {Array<{title,artist,source,uri?}>} tracks
 * @param {{ limit?: number }} opts
 * @returns {Promise<{ ok, fail, total, fetched, skipped }>}
 */
export async function seedLibrary(tracks, { limit = 200 } = {}) {
  return _call('seed_library', { tracks, limit }, 30 * 60_000);
}

// ─── Similar-song search ─────────────────────────────────────────────────────

/**
 * Find songs in the reranker DB that are acoustically/semantically similar
 * to the given track. Uses KNN on CLAP embedding + full rerank pipeline.
 *
 * @param {{ title: string, artist?: string }} track  — reference song
 * @param {number} limit — max results
 * @returns {Promise<Array|null>}
 */
export async function findSimilar(track, limit = 20) {
  if (!isRerankerEnabled() || !isSubprocessRunning()) return null;
  const song_id = canonicalSongId(track);
  try {
    const result = await _call('find_similar', { song_id, limit }, 10_000);
    return result?.songs ?? null;
  } catch (err) {
    console.warn('[Reranker] findSimilar failed:', err.message);
    return null;
  }
}

/**
 * Ask the reranker to suggest songs from its own DB based on taste + current context.
 * Used as a fallback when the DJ's candidates repeatedly fail the score threshold.
 *
 * @param {number} limit — how many songs to return
 * @returns {Promise<Array|null>}
 */
export async function recommend(limit = 10) {
  if (!isRerankerEnabled() || !isSubprocessRunning()) return null;
  try {
    const context = await _buildContext({});
    const result  = await _call('recommend', { limit, context }, 90_000);
    return result?.songs ?? null;
  } catch (err) {
    console.warn('[Reranker] recommend failed:', err.message);
    return null;
  }
}

// ─── Feedback (fire-and-forget) ───────────────────────────────────────────────

export async function getSeedProgress() {
  if (!isSubprocessRunning()) return null;
  try {
    return await _call('seed_progress', {}, 3_000);
  } catch { return null; }
}

/**
 * Record a user preference event for a song.
 * @param {{ title: string, artist?: string }} track
 * @param {'like'|'skip'|'replay'} event
 * @param {object|null} context
 */
export function sendFeedback(track, event, context = null) {
  if (!isRerankerEnabled()) return;
  const song_id = canonicalSongId(track);
  if (isSubprocessRunning()) {
    _call('feedback', { song_id, event, context }, 3_000).catch(() => {});
    return;
  }
  fetch(`${RERANKER_URL}/api/feedback`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ song_id, event, context }),
    signal:  AbortSignal.timeout(3_000),
  }).catch(() => {});
}
