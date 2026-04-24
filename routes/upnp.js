/**
 * UPnP / DLNA AV streaming
 *
 * Discovery: UDP SSDP M-SEARCH → finds MediaRenderer devices on LAN
 * Playback:  SOAP AVTransport → SetAVTransportURI + Play
 * Audio src: /api/stream/:videoId  (existing yt-dlp proxy, reachable by LAN IP)
 *
 * Routes:
 *   GET  /api/upnp/devices  — scan for DLNA renderers (4s timeout)
 *   POST /api/upnp/select   — { name, controlUrl } — choose active renderer
 *   POST /api/upnp/play     — { videoId, title, artist } — push track to renderer
 *   POST /api/upnp/pause    — pause renderer
 *   POST /api/upnp/stop     — stop renderer
 *   GET  /api/upnp/status   — active renderer + what's playing
 */

import express      from 'express';
import dgram        from 'dgram';
import { spawn }    from 'child_process';
import { networkInterfaces } from 'os';
import { getAudioUrl } from './stream-audio.js';

const router  = express.Router();
const FFMPEG  = process.env.FFMPEG_BIN ?? '/opt/homebrew/bin/ffmpeg';

// ── LAN IP ────────────────────────────────────────────────────────────────────
function getLanIp() {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

// ── SSDP discovery ────────────────────────────────────────────────────────────
const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const SSDP_MSG  = [
  'M-SEARCH * HTTP/1.1',
  `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
  'MAN: "ssdp:discover"',
  'MX: 3',
  'ST: urn:schemas-upnp-org:device:MediaRenderer:1',
  '', '',
].join('\r\n');

async function discoverRenderers(timeoutMs = 4500) {
  return new Promise((resolve) => {
    const socket  = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const seen    = new Set();
    const devices = [];
    let done      = false;

    const finish = () => {
      if (done) return;
      done = true;
      try { socket.close(); } catch {}
      resolve(devices);
    };

    socket.on('error', finish);

    socket.on('message', async (msg) => {
      if (done) return;
      const text = msg.toString();
      const loc  = text.match(/LOCATION:\s*(\S+)/i)?.[1];
      if (!loc || seen.has(loc)) return;
      seen.add(loc);
      try {
        const dev = await fetchDeviceInfo(loc);
        if (dev && !done) devices.push(dev);
      } catch { /* unreachable device — skip */ }
    });

    socket.bind(0, '0.0.0.0', () => {
      try {
        socket.setMulticastTTL(4);
        socket.setMulticastLoopback(true);
        socket.addMembership(SSDP_ADDR, '0.0.0.0');
      } catch {}
      // Send M-SEARCH twice for reliability
      const buf = Buffer.from(SSDP_MSG);
      socket.send(buf, SSDP_PORT, SSDP_ADDR);
      setTimeout(() => { if (!done) socket.send(buf, SSDP_PORT, SSDP_ADDR); }, 1000);
    });

    setTimeout(finish, timeoutMs);
  });
}

// Parse device description XML — returns { name, location, controlUrl } or null
async function fetchDeviceInfo(location) {
  const res = await fetch(location, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) return null;
  const xml  = await res.text();

  // Must have AVTransport service
  const avBlock = xml.match(
    /<serviceType>urn:schemas-upnp-org:service:AVTransport:1<\/serviceType>[\s\S]*?<controlURL>([^<]+)<\/controlURL>/
  );
  if (!avBlock) return null;

  const rawName   = xml.match(/<friendlyName>([^<]+)<\/friendlyName>/)?.[1]?.trim() ?? 'Unknown';
  // SONOS format: "10.0.2.126 - SYMFONISK Table lamp - RINCON_542A1B524DEC01400"
  // Strip leading IP:  "10.0.2.126 - "
  // Strip trailing device-ID:  " - RINCON_XXXX" or similar (all-caps+hex, ≥8 chars)
  let name = rawName;
  name = name.replace(/^\d{1,3}(\.\d{1,3}){3}\s*[-–]\s*/, '');                   // leading IP
  name = name.replace(/\s*[-–]\s*[A-Z][A-Z0-9_]{3,}[0-9A-Fa-f]{6,}\s*$/, '');  // trailing ID
  name = name.replace(/\s*[\[(]?\d{1,3}(\.\d{1,3}){3}[\])]?\s*$/, '');          // trailing IP
  name = name.trim() || rawName;
  const rawCtrl   = avBlock[1].trim();
  const base      = new URL(location);
  const controlUrl = rawCtrl.startsWith('http') ? rawCtrl : `${base.protocol}//${base.host}${rawCtrl.startsWith('/') ? '' : '/'}${rawCtrl}`;

  return { name, location, controlUrl };
}

// ── SOAP helpers ──────────────────────────────────────────────────────────────
function soapEnvelope(action, body) {
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action} xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      ${body}
    </u:${action}>
  </s:Body>
</s:Envelope>`;
}

async function soapAction(controlUrl, action, body) {
  const res = await fetch(controlUrl, {
    method:  'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      'SOAPAction':   `"urn:schemas-upnp-org:service:AVTransport:1#${action}"`,
    },
    body:   soapEnvelope(action, body),
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`SOAP ${action} → ${res.status}: ${detail.slice(0, 120)}`);
  }
  return res.text();
}

// DIDL-Lite metadata (XML-escaped, embedded in the SOAP body)
function buildDIDL(title, artist, uri) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const titleEsc  = esc(title ?? 'Unknown');
  const label     = artist ? `${titleEsc} — ${esc(artist)}` : titleEsc;
  return (
    '&lt;DIDL-Lite xmlns=&quot;urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/&quot; ' +
    'xmlns:dc=&quot;http://purl.org/dc/elements/1.1/&quot; ' +
    'xmlns:upnp=&quot;urn:schemas-upnp-org:metadata-1-0/upnp/&quot;&gt;' +
    '&lt;item id=&quot;1&quot; parentID=&quot;0&quot; restricted=&quot;1&quot;&gt;' +
    `&lt;dc:title&gt;${label}&lt;/dc:title&gt;` +
    '&lt;upnp:class&gt;object.item.audioItem.musicTrack&lt;/upnp:class&gt;' +
    `&lt;res protocolInfo=&quot;http-get:*:audio/mpeg:DLNA.ORG_PN=MP3;DLNA.ORG_FLAGS=01500000000000000000000000000000&quot;&gt;${esc(uri)}&lt;/res&gt;` +
    '&lt;/item&gt;&lt;/DIDL-Lite&gt;'
  );
}

// ── Runtime state ─────────────────────────────────────────────────────────────
let activeRenderer = null;   // { name, controlUrl }
let nowPlaying     = null;   // { videoId, title, artist }

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/upnp/devices — 4.5s SSDP scan
router.get('/devices', async (req, res) => {
  try {
    const devices = await discoverRenderers();
    res.json({ devices, active: activeRenderer ?? null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/upnp/select — { name, controlUrl } or {} to deselect
router.post('/select', (req, res) => {
  const { name, controlUrl } = req.body;
  if (!controlUrl) {
    activeRenderer = null;
    nowPlaying     = null;
    return res.json({ ok: true, active: null });
  }
  activeRenderer = { name: name ?? controlUrl, controlUrl };
  console.log(`[UPnP] Renderer selected: "${activeRenderer.name}" → ${controlUrl}`);
  res.json({ ok: true, active: activeRenderer.name });
});

// POST /api/upnp/play — { videoId, title, artist }
router.post('/play', async (req, res) => {
  if (!activeRenderer) return res.status(400).json({ error: 'No renderer selected' });
  const { videoId, title, artist } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });

  const port      = process.env.PORT ?? 8080;
  const lanIp     = getLanIp();
  // Use a transcoded MP3 stream — DLNA renderers rarely support WebM/Opus
  const streamUrl = `http://${lanIp}:${port}/api/upnp/transcode/${videoId}`;
  const didl      = buildDIDL(title, artist, streamUrl);

  console.log(`[UPnP] → SetAVTransportURI on ${activeRenderer.controlUrl}`);
  console.log(`[UPnP]   stream: ${streamUrl}`);
  try {
    await soapAction(activeRenderer.controlUrl, 'SetAVTransportURI',
      `<InstanceID>0</InstanceID>
       <CurrentURI>${streamUrl}</CurrentURI>
       <CurrentURIMetaData>${didl}</CurrentURIMetaData>`
    );
    console.log('[UPnP] SetAVTransportURI OK — sending Play');
    await soapAction(activeRenderer.controlUrl, 'Play',
      `<InstanceID>0</InstanceID><Speed>1</Speed>`
    );
    nowPlaying = { videoId, title, artist };
    console.log(`[UPnP] Playing "${title ?? videoId}" on "${activeRenderer.name}"`);
    res.json({ ok: true, streaming: streamUrl, renderer: activeRenderer.name });
  } catch (err) {
    console.error('[UPnP] Play error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/upnp/pause
router.post('/pause', async (req, res) => {
  if (!activeRenderer) return res.status(400).json({ error: 'No renderer selected' });
  try {
    await soapAction(activeRenderer.controlUrl, 'Pause', '<InstanceID>0</InstanceID>');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/upnp/stop
router.post('/stop', async (req, res) => {
  if (!activeRenderer) return res.status(400).json({ error: 'No renderer selected' });
  try {
    await soapAction(activeRenderer.controlUrl, 'Stop', '<InstanceID>0</InstanceID>');
    nowPlaying = null;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/upnp/status
router.get('/status', (req, res) => {
  res.json({ renderer: activeRenderer ?? null, nowPlaying: nowPlaying ?? null });
});

// GET /api/upnp/transcode/:videoId — real-time ffmpeg transcode → MP3 for DLNA renderers
router.get('/transcode/:videoId', async (req, res) => {
  const { videoId } = req.params;
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) return res.status(400).end();

  let audioUrl;
  try {
    audioUrl = await getAudioUrl(videoId);
  } catch (err) {
    console.error('[UPnP transcode] resolve error:', err.message);
    return res.status(502).end();
  }

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-store');

  const ff = spawn(FFMPEG, [
    '-loglevel', 'error',
    '-i', audioUrl,
    '-vn',
    '-acodec', 'libmp3lame',
    '-ab', '192k',
    '-ar', '44100',
    '-ac', '2',
    '-f', 'mp3',
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  ff.stderr.on('data', d => {
    const m = d.toString().trim();
    if (m) console.warn('[UPnP transcode] ffmpeg:', m);
  });

  ff.stdout.pipe(res);

  ff.on('exit', (code, signal) => {
    console.log(`[UPnP transcode] ffmpeg done (${signal ?? code}) for ${videoId}`);
    res.end();
  });

  req.on('close', () => ff.kill('SIGKILL'));
});

export default router;
