/**
 * GET /api/stream/:videoId
 *
 * Uses yt-dlp to get the direct audio URL for a YouTube video,
 * then proxies the audio stream through this server to the browser.
 * This avoids all YouTube IFrame / autoplay / CORS / ad-blocker issues.
 *
 * The browser just does: <audio src="/api/stream/xMxLJ10udDw">
 */

import express from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';

const router = express.Router();
const execFileAsync = promisify(execFile);

const YTDLP = process.env.YTDLP_BIN ?? '/opt/homebrew/bin/yt-dlp';

// Cache resolved URLs for 4 hours (they expire in ~6h)
const urlCache   = new Map(); // videoId → { url, expires }
const inFlight   = new Map(); // videoId → Promise (dedup concurrent requests)
const CACHE_TTL  = 4 * 60 * 60 * 1000;

async function getAudioUrl(videoId) {
  const cached = urlCache.get(videoId);
  if (cached && Date.now() < cached.expires) {
    console.log(`[Stream] Cache hit: ${videoId}`);
    return cached.url;
  }
  // Dedup: if a resolve is already in flight for this videoId, wait for it
  if (inFlight.has(videoId)) {
    console.log(`[Stream] Waiting for in-flight resolve: ${videoId}`);
    return inFlight.get(videoId);
  }

  console.log(`[Stream] yt-dlp resolving: ${videoId}`);
  const promise = _resolve(videoId);
  inFlight.set(videoId, promise);
  try { return await promise; } finally { inFlight.delete(videoId); }
}

async function _resolve(videoId) {
  const browser = process.env.YTDLP_COOKIES_BROWSER ?? 'chrome';
  const baseArgs = [
    '-f', 'bestaudio[ext=m4a]/bestaudio',
    '--get-url',
    '--no-playlist',
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
  const opts = {
    timeout: 20_000,
    env: { ...process.env, HOME: process.env.HOME ?? '/Users/' + (process.env.USER ?? 'user') },
  };

  // Try with browser cookies first, fall back to no-cookies if keychain/access
  // is unavailable (common in packaged Electron apps on macOS).
  const attempts = [
    ['with-cookies',    [...baseArgs.slice(0, -1), '--cookies-from-browser', browser, baseArgs.at(-1)]],
    ['no-cookies',      baseArgs],
  ];

  let lastErr;
  for (const [label, args] of attempts) {
    try {
      const { stdout } = await execFileAsync(YTDLP, args, { ...opts, encoding: 'utf8' });
      const url = stdout.trim().split('\n')[0];
      if (!url) throw new Error('yt-dlp returned no URL');
      urlCache.set(videoId, { url, expires: Date.now() + CACHE_TTL });
      console.log(`[Stream] Resolved ${videoId} (${label}) → ${url.slice(0, 80)}...`);
      return url;
    } catch (err) {
      const stderrLast = err.stderr?.trim().split('\n').pop();
      const detail = (stderrLast || err.message) || String(err);
      console.warn(`[Stream] yt-dlp ${label} failed for ${videoId}: ${detail}`);
      lastErr = new Error(`yt-dlp: ${detail}`);
    }
  }
  throw lastErr;
}

// GET /api/stream/:videoId — redirect browser to CDN URL
// Redirecting (302) instead of proxying means Safari manages its own connection
// to the CDN, handling range requests and reconnects natively. The previous
// proxy approach caused Safari to restart streams from the beginning when the
// Node.js/undici upstream socket reset mid-stream.
router.get('/:videoId', async (req, res) => {
  const { videoId } = req.params;
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'Invalid videoId' });
  }

  let audioUrl;
  try {
    audioUrl = await getAudioUrl(videoId);
  } catch (err) {
    console.error(`[Stream] yt-dlp failed for ${videoId}:`, err.message);
    return res.status(502).json({ error: err.message });
  }

  // no-store so Safari re-hits this endpoint on reconnect (we hand out a fresh
  // CDN URL each time, which stays valid as long as the 4-hour cache is warm)
  res.setHeader('Cache-Control', 'no-store');
  res.redirect(302, audioUrl);
});

// GET /api/stream/:videoId/url — just return the URL (for debug)
router.get('/:videoId/url', async (req, res) => {
  try {
    const url = await getAudioUrl(req.params.videoId);
    res.json({ url, videoId: req.params.videoId });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

export { getAudioUrl };

// Pre-warm the cache for a list of videoIds (fire-and-forget)
export function prewarmCache(videoIds) {
  for (const id of videoIds) {
    if (!id) continue;
    const cached = urlCache.get(id);
    if (cached && Date.now() < cached.expires) continue;
    getAudioUrl(id).catch(err => console.warn(`[Stream] Prewarm failed ${id}:`, err.message));
  }
}

export default router;
