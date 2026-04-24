import 'dotenv/config';
import express from 'express';
import expressWs from 'express-ws';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure required dirs exist before any module touches them
fs.mkdirSync(path.join(__dirname, 'tts-cache'), { recursive: true });
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
fs.mkdirSync(path.join(__dirname, 'USER'), { recursive: true });

const app = express();
expressWs(app);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// CORS for local PWA dev
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// ─── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use('/tts', express.static(path.join(__dirname, 'tts-cache')));

// ─── Routes ───────────────────────────────────────────────────────────────────
const { default: streamAudioRoute }  = await import('./routes/stream-audio.js');
const { default: chatRoute }         = await import('./routes/chat.js');
const { default: nowRoute }          = await import('./routes/now.js');
const { default: nextRoute }         = await import('./routes/next.js');
const { default: tasteRoute }        = await import('./routes/taste.js');
const { default: planRoute }         = await import('./routes/plan.js');
const { default: settingsRoute }     = await import('./routes/settings.js');
const { default: transitionRoute }   = await import('./routes/transition.js');
const { default: guideRoute }        = await import('./routes/guide.js');
const { default: restPieceRoute }    = await import('./routes/rest-piece.js');
const { default: restNarrateRoute }  = await import('./routes/rest-narrate.js');
const { default: upnpRoute }         = await import('./routes/upnp.js');
const { default: airplayRoute }      = await import('./routes/airplay.js');
const streamHandler                  = (await import('./routes/stream.js')).default;

app.use('/api/stream', streamAudioRoute);
app.use('/api/chat', chatRoute);
app.use('/api/now', nowRoute);
app.use('/api/next', nextRoute);
app.use('/api/taste', tasteRoute);
app.use('/api/plan', planRoute);
app.use('/api/settings', settingsRoute);
app.use('/api/transition', transitionRoute);
app.use('/api/guide', guideRoute);
app.use('/api/rest-piece', restPieceRoute);
app.use('/api/rest-narrate', restNarrateRoute);
app.use('/api/upnp', upnpRoute);
app.use('/api/airplay', airplayRoute);
app.ws('/stream', streamHandler);

// Apple Music user token endpoint (POSTed from MusicKit JS in the browser)
app.post('/api/apple-token', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });
  const { saveUserToken } = await import('./auth/apple-auth.js');
  saveUserToken(token);
  res.json({ ok: true });
});

// On-demand music sync
app.post('/api/sync', async (req, res) => {
  try {
    const { syncAll } = await import('./music/sync.js');
    res.json({ ok: true, message: 'Sync started' });
    await syncAll({ force: true }); // run after response
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// OAuth initiation routes (open in popup from Settings UI)
app.get('/api/auth/spotify', async (req, res) => {
  try {
    const { generatePKCE, getAuthUrl } = await import('./auth/spotify-auth.js');
    const { verifier, challenge } = generatePKCE();
    // Store verifier temporarily in prefs so callback server can retrieve it
    const { setPref } = await import('./src/state.js');
    setPref('spotify.pkce_verifier', verifier);
    res.redirect(getAuthUrl(challenge));
  } catch (err) { res.status(500).send(err.message); }
});

app.get('/api/auth/youtube', async (req, res) => {
  try {
    const { getAuthUrl } = await import('./auth/youtube-auth.js');
    res.redirect(getAuthUrl());
  } catch (err) { res.status(500).send(err.message); }
});

// OAuth callbacks (redirect_uri registered with each provider as http://localhost:8080/callback/*)
app.get('/callback/spotify', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('<h2>Error: no code</h2>');
  try {
    const { exchangeCode } = await import('./auth/spotify-auth.js');
    const { getPref } = await import('./src/state.js');
    const verifier = getPref('spotify.pkce_verifier');
    await exchangeCode(code, verifier);
    res.send('<h2>✓ Spotify connected!</h2><script>window.close()</script>');
  } catch (err) { res.send(`<h2>Error: ${err.message}</h2>`); }
});

app.get('/callback/youtube', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('<h2>Error: no code</h2>');
  try {
    const { exchangeCode } = await import('./auth/youtube-auth.js');
    await exchangeCode(code);
    res.send('<h2>✓ YouTube connected!</h2><script>window.close()</script>');
  } catch (err) { res.send(`<h2>Error: ${err.message}</h2>`); }
});

app.get('/api/auth/google', async (req, res) => {
  try {
    const { getAuthUrl } = await import('./auth/google-calendar-auth.js');
    res.redirect(getAuthUrl());
  } catch (err) { res.status(500).send(err.message); }
});

app.get('/api/auth/microsoft', async (req, res) => {
  try {
    const { getAuthUrl } = await import('./auth/microsoft-auth.js');
    res.redirect(getAuthUrl());
  } catch (err) { res.status(500).send(err.message); }
});

app.get('/callback/google', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('<h2>Error: no code</h2>');
  try {
    const { exchangeCode } = await import('./auth/google-calendar-auth.js');
    await exchangeCode(code);
    res.send('<h2>✓ Google Calendar connected!</h2><script>window.close()</script>');
  } catch (err) { res.send(`<h2>Error: ${err.message}</h2>`); }
});

app.get('/callback/microsoft', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('<h2>Error: no code</h2>');
  try {
    const { exchangeCode } = await import('./auth/microsoft-auth.js');
    await exchangeCode(code);
    res.send('<h2>✓ Microsoft Calendar connected!</h2><script>window.close()</script>');
  } catch (err) { res.send(`<h2>Error: ${err.message}</h2>`); }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? '8080');
app.listen(PORT, () => {
  console.log(`\n🎙  Seens Radio running at http://localhost:${PORT}\n`);

  // Start scheduler after server is up
  import('./src/scheduler.js').then(({ startScheduler }) => startScheduler());

  // TTS cache pruning once a day
  import('./src/tts.js').then(({ pruneCache }) => {
    pruneCache();
    setInterval(pruneCache, 24 * 60 * 60 * 1000);
  });
});

process.on('SIGINT', () => { console.log('\n[Server] Shutting down'); process.exit(0); });
process.on('SIGTERM', () => { console.log('\n[Server] Shutting down'); process.exit(0); });
