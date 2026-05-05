/**
 * Optional reranker bridge for seens-radio.
 *
 * When the reranker is enabled via the UI, this module spawns
 * subprocess_main.py from the seens-reranker repo and communicates
 * with it over JSON-RPC on stdin/stdout — no separate server needed.
 *
 * The HTTP API path (RERANKER_URL) is kept as a fallback for when the
 * standalone server is already running externally.
 *
 * Script path resolution order:
 *   1. RERANKER_SCRIPT env var
 *   2. reranker.script pref (set via settings UI)
 *   3. ../seens-reranker/subprocess_main.py  (sibling repo default)
 */

import { spawn }          from 'child_process';
import readline           from 'readline';
import fs                 from 'fs';
import path               from 'path';
import { fileURLToPath }  from 'url';
import { getPref, setPref } from './state.js';
import { getWeatherContext } from './weather.js';
import { fetchLyricsBatch } from '../music/lyrics.js';

const ROOT          = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_SCRIPT = path.join(ROOT, 'seens-reranker', 'subprocess_main.py');

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

function _scriptPath() {
  return process.env.RERANKER_SCRIPT
      ?? getPref('reranker.script', null)
      ?? DEFAULT_SCRIPT;
}

function _pythonBin(scriptPath) {
  // Prefer the venv python sibling to the script's repo root.
  // Checks both .venv (standard) and venv (legacy) directory names.
  const repoRoot = path.dirname(scriptPath);
  for (const venvDir of ['.venv', 'venv']) {
    const candidate = path.join(repoRoot, venvDir, 'bin', 'python3');
    if (fs.existsSync(candidate)) return candidate;
  }
  return process.env.RERANKER_PYTHON ?? 'python3';
}

function _spawnSubprocess() {
  _warmupPromise = null;
  const script = _scriptPath();
  const python  = _pythonBin(script);
  console.log(`[Reranker] spawning subprocess: ${python} ${script}`);
  _proc = spawn(python, [script], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env },
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
    // Reject any in-flight calls
    for (const [, { reject }] of _pending) reject(new Error('Reranker subprocess exited'));
    _pending.clear();
    // Auto-restart on crash (signal != null) — but not for spawn errors or deliberate disables.
    if (!_spawnFailed && isRerankerEnabled() && signal !== null) {
      const delay = 5_000;
      console.log(`[Reranker] unexpected exit — restarting in ${delay / 1000}s`);
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
  return getPref('reranker.enabled', '0') === '1';
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
    const script = _scriptPath();
    if (!fs.existsSync(script)) {
      console.error(`[Reranker] script not found: ${script}`);
      console.error('[Reranker] Set RERANKER_SCRIPT env var or reranker.script pref to the full path of subprocess_main.py');
      return;
    }
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
    const result = await _call('find_similar', { song_id, limit }, 30_000);
    return result?.songs ?? null;
  } catch (err) {
    console.warn('[Reranker] findSimilar failed:', err.message);
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
