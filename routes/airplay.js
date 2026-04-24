/**
 * AirPlay (RAOP) streaming route.
 *
 * Discovery : bonjour-service mDNS scan for _raop._tcp
 * Streaming : airtunes2 (ALAC/AES over RAOP) + ffmpeg for PCM conversion
 * Audio src : existing yt-dlp cache via getAudioUrl()
 *
 * Routes:
 *   GET  /api/airplay/devices     — 5s mDNS scan, returns found speakers
 *   POST /api/airplay/select      — { name, host, port } or {} to deselect
 *   POST /api/airplay/play        — { videoId, title, artist } — push track
 *   POST /api/airplay/pause       — pause (stop + re-buffer not supported by RAOP)
 *   POST /api/airplay/stop        — stop streaming
 *   GET  /api/airplay/status      — active device + now playing
 *   GET  /api/airplay/sys-devices — list macOS audio output devices (for Chrome)
 *   POST /api/airplay/sys-select  — { name } or {} — switch / restore system audio output
 */

import express  from 'express';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
import { networkInterfaces, tmpdir } from 'os';
import { join } from 'path';
import { statSync, openSync, readSync, closeSync } from 'fs';
import { unlink } from 'fs/promises';
import { Bonjour } from 'bonjour-service';
import { getAudioUrl } from './stream-audio.js';

function getLanIp() {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

const execFileAsync = promisify(execFile);

const require      = createRequire(import.meta.url);
const AirTunes     = require('airtunes2');
const airtunes     = new AirTunes();

airtunes.on('device', (key, status, desc) => {
  console.log(`[AirPlay] device ${key}: ${status}${desc ? ' — ' + desc : ''}`);
});

const router  = express.Router();
const bonjour = new Bonjour();

const FFMPEG       = process.env.FFMPEG_BIN        ?? '/opt/homebrew/bin/ffmpeg';
const SWITCHAUDIO  = process.env.SWITCH_AUDIO_BIN  ?? '/opt/homebrew/bin/SwitchAudioSource';

// ── runtime state ─────────────────────────────────────────────────────────────
let activeDevice  = null;  // { name, host, port }
let nowPlaying    = null;  // { videoId, title, artist }
let currentFfmpeg = null;  // ChildProcess
let sysOrigDevice = null;  // macOS output before sys-select (restored on deselect)

// ── helpers ───────────────────────────────────────────────────────────────────
async function stopCurrent() {
  const ff = currentFfmpeg;
  currentFfmpeg = null;
  if (ff) {
    ff.stdout.removeAllListeners();
    ff.stderr.removeAllListeners();
    ff.kill('SIGKILL');
  }

  // device_airtunes.js assigns udpServers without `var` → implicit global on
  // the Node.js global object.  Log it so we can confirm access is working.
  const uds = global.udpServers;
  console.log(`[AirPlay] stopCurrent: udpServers=${uds ? 'ok status=' + uds.status : 'MISSING'}`);

  if (uds) {
    uds.close();                      // set UNBOUND, close open sockets
    uds.removeAllListeners('ports');  // drop stale once('ports') callbacks from stuck devices
    if (Array.isArray(uds.hosts)) uds.hosts = [];  // clear accumulated host list
  }

  // Clear the devices dict BEFORE stopAll so stopAll iterates an empty list —
  // stuck devices with a null RTSP socket would crash on teardown() otherwise.
  if (airtunes.devices?.devices) airtunes.devices.devices = {};

  // stopAll with 3-second guard (dict is empty so this resolves immediately)
  await new Promise(resolve => {
    const t = setTimeout(resolve, 3000);
    try { airtunes.stopAll(() => { clearTimeout(t); resolve(); }); } catch { clearTimeout(t); resolve(); }
  });
  if (airtunes.devices?.devices) airtunes.devices.devices = {};
  airtunes.reset();
}

// ── routes ────────────────────────────────────────────────────────────────────

// GET /api/airplay/devices — 5s mDNS scan
router.get('/devices', (req, res) => {
  const found = new Map(); // fqdn → device

  const browser = bonjour.find({ type: 'raop' });
  browser.on('up', svc => {
    // Strip MAC prefix (e.g. "AABBCC@Speaker Name" → "Speaker Name")
    const displayName = svc.name.replace(/^[0-9A-Fa-f]{12}@/, '');
    found.set(svc.fqdn ?? svc.name, {
      name:    displayName,
      rawName: svc.name,
      host:    svc.host,
      port:    svc.port || 5000,
    });
  });

  setTimeout(() => {
    browser.stop();
    res.json({ devices: [...found.values()], active: activeDevice });
  }, 5000);
});

// POST /api/airplay/select — { name, host, port } or {} to deselect
router.post('/select', async (req, res) => {
  const { name, host, port } = req.body ?? {};
  if (!host) {
    await stopCurrent();
    activeDevice = null;
    nowPlaying   = null;
    console.log('[AirPlay] Deselected');
    return res.json({ ok: true, active: null });
  }
  activeDevice = { name: name ?? host, host, port: port || 5000 };
  console.log(`[AirPlay] Selected: "${activeDevice.name}" @ ${host}:${activeDevice.port}`);
  res.json({ ok: true, active: activeDevice.name });
});

// POST /api/airplay/play — { videoId, title, artist }
router.post('/play', async (req, res) => {
  if (!activeDevice) return res.status(400).json({ error: 'No AirPlay device selected' });
  const { videoId, title, artist } = req.body ?? {};
  if (!videoId) return res.status(400).json({ error: 'videoId required' });

  console.log(`[AirPlay] play request: "${title ?? videoId}" on ${activeDevice.host}:${activeDevice.port}`);

  let audioUrl;
  try {
    audioUrl = await getAudioUrl(videoId);
  } catch (err) {
    return res.status(502).json({ error: `Could not resolve audio: ${err.message}` });
  }

  try {
    await stopCurrent();

    // Start RAOP handshake and wait for 'ready' before feeding audio.
    // syncAudio() runs from module load so RTP seqs advance continuously — starting
    // ffmpeg only after ready ensures the speaker receives audio at the right sequence.
    const device = airtunes.add(activeDevice.host, { port: activeDevice.port, volume: 50 });

    // Capture the low-level RTSP failure reason for clear diagnostics.
    // rtsp 'end' fires (with the specific error string) before device 'status' fires,
    // so rtspError will be populated when we check raopStatus.
    let rtspError = null;
    device.rtsp.once('end', (err, detail) => {
      rtspError = err + (detail ? ` (${detail})` : '');
      console.log(`[AirPlay] RTSP end: ${rtspError}`);
    });

    const raopStatus = await new Promise(resolve => {
      const t = setTimeout(() => resolve('timeout'), 10_000);
      device.once('status', (status, desc) => {
        clearTimeout(t);
        console.log(`[AirPlay] RAOP status: ${status}${desc ? ' — ' + desc : ''}`);
        resolve(status);
      });
    });

    if (raopStatus !== 'ready') {
      const errDetail = rtspError || raopStatus;
      console.log(`[AirPlay] Handshake failed: ${errDetail}`);
      return res.status(502).json({ error: `RAOP handshake failed: ${errDetail}` });
    }

    // Spawn ffmpeg — no -re flag so it fills the buffer immediately
    currentFfmpeg = spawn(FFMPEG, [
      '-loglevel', 'error',
      '-i', audioUrl,
      '-vn',
      '-acodec', 'pcm_s16be',
      '-ar', '44100',
      '-ac', '2',
      '-f', 's16be',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    currentFfmpeg.stdout.on('data', chunk => airtunes.write(chunk));
    currentFfmpeg.stdout.on('end',  ()    => { try { airtunes.end(); } catch {} });

    currentFfmpeg.stderr.on('data', d => {
      const msg = d.toString().trim();
      if (msg) console.warn('[AirPlay] ffmpeg:', msg);
    });

    currentFfmpeg.on('exit', (code, signal) => {
      console.log(`[AirPlay] ffmpeg exited (${signal ?? code}) for "${title ?? videoId}"`);
      currentFfmpeg = null;
    });

    nowPlaying = { videoId, title, artist };
    console.log(`[AirPlay] Streaming "${title ?? videoId}" → ${activeDevice.name} (${activeDevice.host}:${activeDevice.port})`);
    res.json({ ok: true, device: activeDevice.name });

  } catch (err) {
    console.error('[AirPlay] Play error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/airplay/stop
router.post('/stop', async (req, res) => {
  try {
    await stopCurrent();
    nowPlaying = null;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/airplay/status
router.get('/status', (req, res) => {
  res.json({ device: activeDevice, nowPlaying });
});

// GET /api/airplay/host — LAN base URL so the widget can build device-reachable stream URLs
router.get('/host', (req, res) => {
  const port = process.env.PORT ?? 8080;
  res.json({ base: `http://${getLanIp()}:${port}` });
});

// Active transcode jobs for AirPlay stream: videoId → { path, ff, done }
// Keeping ffmpeg alive across client reconnects prevents restart-from-beginning.
const airplayJobs = new Map();

// Poll until tmpPath has at least minBytes written, or timeout.
function waitForBytes(tmpPath, minBytes, ms = 15_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const check = () => {
      try { if (statSync(tmpPath).size >= minBytes) return resolve(); } catch {}
      if (Date.now() > deadline) return reject(new Error('transcode timeout'));
      setTimeout(check, 80);
    };
    check();
  });
}

// GET /api/airplay/stream/:videoId — MP3 via ffmpeg, written to a temp file so
// Safari range-request reconnects resume from the correct byte offset instead of
// restarting the stream from the beginning.
router.get('/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return res.status(400).end();

  let audioUrl;
  try {
    audioUrl = await getAudioUrl(videoId);
  } catch (err) {
    console.error('[AirPlay stream] resolve error:', err.message);
    return res.status(502).end();
  }

  const tmpPath = join(tmpdir(), `seens-airplay-${videoId}.mp3`);
  let job = airplayJobs.get(videoId);

  if (!job) {
    // Start a new transcode — write directly to temp file, not to a pipe.
    // This lets us serve the same bytes to reconnecting clients.
    const ff = spawn(FFMPEG, [
      '-loglevel', 'error',
      '-i', audioUrl,
      '-vn', '-acodec', 'libmp3lame', '-b:a', '192k',
      '-ar', '44100', '-ac', '2',
      '-y', tmpPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    job = { path: tmpPath, ff, done: false };
    airplayJobs.set(videoId, job);

    ff.stderr.on('data', d => {
      const m = d.toString().trim();
      if (m) console.warn('[AirPlay stream] ffmpeg:', m);
    });
    ff.on('exit', (code, signal) => {
      job.done = true;
      job.ff = null;
      console.log(`[AirPlay stream] ffmpeg done (${signal ?? code}) for ${videoId}`);
      // Clean up temp file after 15 minutes
      setTimeout(() => {
        airplayJobs.delete(videoId);
        unlink(tmpPath).catch(() => {});
      }, 15 * 60 * 1000);
    });
  }

  // Wait for at least 128 KB before responding (avoids 0-byte race on first request)
  try {
    await waitForBytes(tmpPath, 128 * 1024);
  } catch (err) {
    console.error('[AirPlay stream] transcode timeout for', videoId);
    return res.status(502).end();
  }

  // Parse Range header (Safari sends these on reconnects)
  let startByte = 0;
  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const m = rangeHeader.match(/bytes=(\d+)-/);
    if (m) startByte = parseInt(m[1], 10);
  }

  // If client wants bytes past what's been written so far, wait for them
  if (startByte > 0) {
    try { await waitForBytes(tmpPath, startByte + 1); } catch {}
  }

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');

  if (rangeHeader && startByte > 0) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${startByte}-*/*`);
  }

  // Pump from temp file, following ffmpeg as it writes more data.
  // Do NOT kill ffmpeg when the client disconnects — keep it running so the
  // next reconnect can resume without restarting the transcode.
  let clientGone = false;
  req.on('close', () => { clientGone = true; });

  let pos = startByte;
  const CHUNK = 128 * 1024;

  const pump = async () => {
    while (!clientGone) {
      let fileSize;
      try { fileSize = statSync(tmpPath).size; } catch { break; }

      if (pos < fileSize) {
        const toRead = Math.min(CHUNK, fileSize - pos);
        const buf = Buffer.allocUnsafe(toRead);
        const fd = openSync(tmpPath, 'r');
        const bytesRead = readSync(fd, buf, 0, toRead, pos);
        closeSync(fd);
        pos += bytesRead;
        const ok = res.write(buf.slice(0, bytesRead));
        if (!ok) await new Promise(r => res.once('drain', r));
      } else if (job.done) {
        break;
      } else {
        // ffmpeg still running — wait for more data
        await new Promise(r => setTimeout(r, 80));
      }
    }
    if (!res.writableEnded) res.end();
  };

  pump().catch(err => {
    console.warn('[AirPlay stream] pump error:', err.message);
    if (!res.writableEnded) res.end();
  });
});

// ── macOS system audio switching (Chrome workaround) ─────────────────────────

// GET /api/airplay/sys-devices — list macOS audio output devices
router.get('/sys-devices', async (req, res) => {
  // Try SwitchAudioSource first (brew install switchaudio-osx)
  try {
    const { stdout } = await execFileAsync(SWITCHAUDIO, ['-a', '-t', 'output', '-f', 'json'])
      .catch(() => execFileAsync(SWITCHAUDIO, ['-a', '-t', 'output']));
    let devices;
    try {
      devices = stdout.trim().split('\n').map(l => JSON.parse(l)).map(d => d.name ?? d);
    } catch {
      devices = stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);
    }
    const { stdout: cur } = await execFileAsync(SWITCHAUDIO, ['-c', '-t', 'output']);
    return res.json({ devices, current: cur.trim() });
  } catch {}

  // Fallback: system_profiler (built-in macOS, no install required)
  // Note: switching via sys-select requires SwitchAudioSource — install with:
  //   brew install switchaudio-osx
  try {
    const { stdout } = await execFileAsync('/usr/sbin/system_profiler', ['SPAudioDataType', '-json'], { timeout: 12_000 });
    const data = JSON.parse(stdout);
    // Devices are nested under _items within each SPAudioDataType group
    const allDevices = (data.SPAudioDataType ?? []).flatMap(g => g._items ?? []);
    // Output devices have coreaudio_device_output (channel count > 0)
    const outputDevices = allDevices.filter(d => d.coreaudio_device_output != null);
    const devices = outputDevices.map(d => d._name).filter(Boolean);
    const current = allDevices.find(d => d.coreaudio_default_audio_output_device === 'spaudio_yes')?._name ?? '';
    res.json({ devices, current, switchUnavailable: true });
  } catch (err) {
    res.status(500).json({ error: `Audio device listing unavailable: ${err.message}` });
  }
});

// POST /api/airplay/sys-select — { name } to switch, {} to restore original
router.post('/sys-select', async (req, res) => {
  const { name } = req.body ?? {};
  try {
    if (!name) {
      if (sysOrigDevice) {
        await execFileAsync(SWITCHAUDIO, ['-s', sysOrigDevice, '-t', 'output']);
        console.log(`[AirPlay] Restored system audio → "${sysOrigDevice}"`);
        sysOrigDevice = null;
      }
      return res.json({ ok: true, current: null });
    }
    if (!sysOrigDevice) {
      const { stdout } = await execFileAsync(SWITCHAUDIO, ['-c', '-t', 'output']);
      sysOrigDevice = stdout.trim();
    }
    await execFileAsync(SWITCHAUDIO, ['-s', name, '-t', 'output']);
    console.log(`[AirPlay] System audio → "${name}" (orig="${sysOrigDevice}")`);
    res.json({ ok: true, current: name });
  } catch (err) {
    const isMissing = err.code === 'ENOENT';
    res.status(isMissing ? 501 : 500).json({
      error: isMissing
        ? 'SwitchAudioSource not installed — run: brew install switchaudio-osx'
        : err.message,
    });
  }
});

export default router;
