# Seens Radio

A personal AI radio station for Mac. An AI DJ — powered by Claude or OpenAI — picks music based on your taste, time of day, and mood, speaks between tracks, and streams audio from YouTube. Runs as a menu-bar Electron app or in any browser at `http://localhost:7477`.

---

## Prerequisites

Install these before anything else.

### Homebrew

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/homebrew/install/HEAD/install.sh)"
```

### Node.js (v20 or later)

```bash
brew install node
```

### yt-dlp and ffmpeg

yt-dlp resolves YouTube audio URLs. ffmpeg is used by the macOS `say` TTS fallback.

```bash
brew install yt-dlp ffmpeg
```

### AI CLI (pick one or both)

The DJ brain runs through one of two CLI tools — no server-side API keys needed for the AI itself.

**Option A — Claude (Anthropic)**
Requires a Claude Max or Pro subscription.

```bash
brew install claude
claude login          # opens browser to authenticate
claude --version      # confirm it works
```

**Option B — Codex (OpenAI)**
Requires a ChatGPT Plus subscription or an OpenAI API key.

```bash
brew install codex
codex login           # or set OPENAI_API_KEY in .env
codex --version
```

Set `AI_AGENT=claude` or `AI_AGENT=codex` in `.env` to pick which one runs at startup. You can also switch agents live in the Settings panel inside the app.

---

## Installation

```bash
git clone <repo-url>
cd SEENS
npm install
```

Copy the example env file and fill in your keys:

```bash
cp .env.example .env
```

---

## Configuration (`.env`)

Open `.env` in any editor. The sections below explain each key, what it does, and where to get it.

### Server

```env
PORT=7477
NODE_ENV=development
```

`PORT` is the local HTTP port. All OAuth redirect URIs must match this port when you register them with each provider.

---

### AI Agent

```env
AI_AGENT=claude          # or: codex
```

No API key needed here — the agent runs through the CLI you installed above. If you want to use the Codex adapter with a direct OpenAI API key instead of the `codex` CLI:

```env
OPENAI_API_KEY=sk-...
```

Get an OpenAI key at **platform.openai.com → API keys**.

---

### TTS (Text-to-Speech)

The DJ speaks between tracks. Three providers are supported:

```env
TTS_PROVIDER=openai      # openai | elevenlabs | say
```

| Provider | Quality | Cost | Key needed |
|---|---|---|---|
| `openai` | Good | ~$0.015/1k chars | `OPENAI_API_KEY` |
| `elevenlabs` | Excellent | 10k chars/month free | `ELEVENLABS_API_KEY` |
| `say` | Basic | Free | None (macOS only) |

**OpenAI TTS** — uses the same `OPENAI_API_KEY` as above. Optionally configure voice and model:

```env
OPENAI_TTS_VOICE=nova    # alloy | ash | coral | echo | fable | nova | onyx | sage | shimmer
OPENAI_TTS_MODEL=tts-1   # tts-1 (fast) | tts-1-hd (higher quality)
```

**ElevenLabs TTS** — sign up at **elevenlabs.io**, go to Profile → API Key:

```env
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=21m00Tcm4TlvDq8ikWAM   # optional — Rachel is the default
```

To browse available voices: `curl -s https://api.elevenlabs.io/v1/voices -H "xi-api-key: YOUR_KEY" | jq '.voices[] | {id, name}'`

**macOS say** — no key needed. Pick a voice:

```env
TTS_VOICE=Samantha
```

List available English voices: `say -v ? | grep en_`

---

### Spotify

Spotify is used for track metadata, artwork, and canonical song names. Music still streams from YouTube — Spotify is not required for audio playback.

1. Go to **developer.spotify.com/dashboard** and log in.
2. Click **Create app**.
3. Set **Redirect URI** to `http://127.0.0.1:7477/callback/spotify` (must match `PORT`).
4. Copy the **Client ID** (no secret needed — uses PKCE).

```env
SPOTIFY_CLIENT_ID=...
```

After adding the key, run the app and go to **Settings → Connect Spotify** to complete OAuth.

---

### YouTube / Google OAuth

Required if you want to stream from YouTube Music or sync your YouTube playlists.

1. Go to **console.cloud.google.com** and create a project.
2. Enable the **YouTube Data API v3** (APIs & Services → Library).
3. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
4. Application type: **Web application**.
5. Add `http://localhost:7477/callback/youtube` as an **Authorized redirect URI**.
6. Copy the **Client ID** and **Client Secret**.

```env
YOUTUBE_CLIENT_ID=...
YOUTUBE_CLIENT_SECRET=...
```

After adding the keys, go to **Settings → Connect YouTube** in the app.

---

### Google Calendar (optional)

Lets the DJ see your schedule and adjust music accordingly (e.g. quieter before meetings).

1. In the same Google Cloud project, enable the **Google Calendar API**.
2. Go to **Credentials → Create Credentials → OAuth client ID** (Web application).
3. Add `http://localhost:7477/callback/google` as an **Authorized redirect URI**.
4. Copy the **Client ID** and **Client Secret**.

```env
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

After adding the keys, go to **Settings → Connect Google Calendar** in the app.

---

### Microsoft / Outlook Calendar (optional)

1. Go to **portal.azure.com → App registrations → New registration**.
2. Set **Supported account types** to "Accounts in any organizational directory and personal Microsoft accounts".
3. Add a **Redirect URI** (Web platform): `http://localhost:7477/callback/microsoft`.
4. After creation, copy the **Application (client) ID**.
5. Go to **Certificates & secrets → New client secret** and copy the value.

```env
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
```

After adding the keys, go to **Settings → Connect Microsoft Calendar** in the app.

---

### Apple Music (optional)

Allows syncing your Apple Music library for taste profiling. Requires an Apple Developer account ($99/year).

1. Go to **developer.apple.com → Certificates, IDs & Profiles → Keys**.
2. Click **+** and enable **MusicKit**.
3. Download the `.p8` private key file — you can only download it once.
4. Note your **Key ID** and **Team ID** (visible in the top-right of the developer portal).

```env
APPLE_KEY_ID=XXXXXXXXXX
APPLE_TEAM_ID=XXXXXXXXXX
APPLE_PRIVATE_KEY_PATH=/absolute/path/to/AuthKey_XXXXXXXXXX.p8
```

---

## Running the app

### Development (browser)

```bash
npm start
```

Open **http://localhost:7477** in any browser.

### Development (Electron desktop)

```bash
npm run electron:dev
```

### Build and install the Mac app

```bash
npm run dist
```

This builds `dist/mac-arm64/Seens Radio.app`. Copy it to `/Applications` or double-click to run.

---

## Notifications

Seens Radio has a built-in notification system. A toast appears at the top-right of the widget and an entry is added to the bell-icon panel. The bell badge shows the unread count; clicking it opens the full list.

### How it works

The Express server exposes a localhost-only endpoint:

```
POST http://localhost:7477/api/notify
```

Payload:

```json
{
  "title":   "Short headline",
  "message": "One to three sentences explaining what happened.",
  "type":    "info",
  "link":    "https://optional-url.com"
}
```

| Field | Required | Values |
|---|---|---|
| `title` | yes | under 60 characters |
| `message` | yes | 1–3 sentences |
| `type` | no | `info` (blue) · `success` (green) · `warning` (amber) · `error` (red) |
| `link` | no | URL opened when the user clicks the notification in the panel |

The server broadcasts the notification over WebSocket to all open widget tabs. The toast stays visible for 8 seconds (or until the user closes it with ×) and a chime plays on delivery.

---

## Claude Code notification skill

The `skills/` folder contains an MCP server that lets Claude Code send notifications to the widget directly — no manual `curl` needed.

### Install

Run once from the repo root:

```bash
claude mcp add seens-notify -- node "$(pwd)/skills/seens-notify-mcp.js"
```

Or, if you have `.mcp.json` and `enableAllProjectMcpServers: true` in `.claude/settings.local.json` (already set in this repo), the skill is wired up automatically when you open the project in Claude Code.

### Use in Claude Code

Ask Claude to send a notification:

> "notify me when the build finishes"
> "send me a warning that my Spotify token expires today"

Claude will call the `notify` tool with an appropriate title, message, and severity level. The tool auto-detects the widget port and delivers the notification in one step.

### Manual test

```bash
node -e "
const { spawn } = require('child_process');
const child = spawn('node', ['skills/seens-notify-mcp.js'], { stdio: ['pipe','pipe','pipe'] });
child.stdout.on('data', d => console.log(d.toString().trim()));
const send = msg => child.stdin.write(JSON.stringify(msg) + '\n');
send({ jsonrpc:'2.0', id:1, method:'initialize', params:{ protocolVersion:'2024-11-05', capabilities:{}, clientInfo:{name:'test',version:'1.0'} } });
send({ jsonrpc:'2.0', method:'notifications/initialized', params:{} });
setTimeout(() => {
  send({ jsonrpc:'2.0', id:2, method:'tools/call', params:{ name:'notify', arguments:{ title:'Test notification', message:'The skill is working.', type:'success' } } });
  setTimeout(() => child.stdin.end(), 3000);
}, 500);
"
```

### Fallback (curl)

```bash
curl -s -X POST http://localhost:7477/api/notify \
  -H 'Content-Type: application/json' \
  -d '{"title":"Hello","message":"Notification from curl.","type":"info"}'
```

---

## Plugin system

Plugins let the DJ fetch content from other apps or services on demand. When you say "play me the latest briefing" or "show me something from my reading list", the DJ can call a plugin, get back audio/images/text, and act on it — play the audio directly, show the image as a rest-break recommendation, or weave the text into its reply.

No rebuild is needed once the plugin infrastructure is in the app. Plugins are managed entirely through `USER/plugins.json` and the Settings panel.

---

### Do you need to write a dedicated API?

**Short answer: it depends on the transport you choose.**

| Situation | What you need |
|---|---|
| Your app already has an HTTP server | Add one `GET /plugin-manifest` route and you're done |
| Your app communicates over a Unix socket | Same — expose `GET /plugin-manifest` on the socket |
| You don't want to touch your app at all | Write a small STDIO bridge script (20–40 lines) that reads from stdin and calls your app's internal logic |
| Your app has no API surface at all | STDIO is the easiest path — the bridge script can import your app's modules directly |

The key point: **SEENS calls out to your plugin, your plugin never calls into SEENS**. The plugin just needs to answer two things: a manifest describing itself, and calls to its endpoints.

---

### Installing a plugin

Open **Settings → Plugins** and paste the plugin's URL into the Install field, then press Enter or click **Install**. The app fetches the manifest and registers the plugin immediately — no restart needed.

Supported URL formats:

```
http://localhost:3001          → HTTP server
https://my-service.local       → HTTPS server
unix:///tmp/my-app.sock        → Unix domain socket
socket:///tmp/my-app.sock      → same
ipc:///tmp/my-app.sock         → same
/tmp/my-app.sock               → bare socket path (detected by .sock extension)
stdio://node /path/to/plugin.js  → subprocess (JSON-RPC over stdin/stdout)
stdio:///path/to/executable      → any binary
```

After installing, use the toggle next to each plugin to enable or disable it. The DJ only sees enabled plugins.

---

### Plugin manifest

Every plugin must expose its manifest — a JSON object that tells SEENS what the plugin is and what it can do.

- **HTTP / socket plugins** expose it at `GET /plugin-manifest`
- **STDIO plugins** return it when they receive `{"method":"manifest"}` on stdin

#### Full manifest schema

```json
{
  "name":        "briefcast",
  "description": "Personal podcast app. Use when the user asks to play a podcast or briefing episode.",
  "version":     "1.0.0",
  "baseUrl":     "http://localhost:3001",
  "endpoints": {
    "latest": {
      "path":        "/api/episodes/latest",
      "method":      "GET",
      "description": "Returns the most recent episode. Response: { title, audioUrl, imageUrl, description, duration, pubDate }",
      "params":      []
    },
    "search": {
      "path":        "/api/episodes/search",
      "method":      "GET",
      "description": "Search episodes by keyword or topic. Response: [{ title, audioUrl, imageUrl, description }]",
      "params": [
        { "name": "q", "in": "query", "description": "search query or topic" }
      ]
    }
  }
}
```

#### Field reference

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Unique identifier. Used as the plugin's key in `plugins.json`. |
| `description` | yes | **This goes into the AI's system prompt verbatim.** Write it as instructions: when to call this plugin, what it returns, what it's best for. |
| `baseUrl` | recommended | The base URL SEENS uses to call endpoints. If omitted, the install URL is used. For STDIO plugins this should be `stdio://node /path/to/plugin.js`. |
| `version` | no | Informational only. |
| `endpoints` | yes | Map of endpoint name → endpoint definition. |

#### Endpoint field reference

| Field | Required | Notes |
|---|---|---|
| `path` | yes (HTTP) | Sub-path appended to `baseUrl`. Not used for STDIO — the endpoint name becomes the JSON-RPC method. |
| `method` | no | HTTP method. Defaults to `GET`. |
| `description` | yes | **Also injected into the AI prompt.** Describe what this endpoint does, what parameters it accepts, and what its response shape is. Be specific — the AI uses this to decide whether and how to call it. |
| `params` | no | List of parameter descriptors: `{ name, in, description }`. `in` is `"query"` (appended to URL) or `"body"` (JSON body). |

#### Implementing `GET /plugin-manifest`

Minimal Express example:

```js
const manifest = {
  name: 'briefcast',
  description: 'Personal podcast app. Call when the user asks to play a podcast, briefing, or news episode.',
  baseUrl: 'http://localhost:3001',
  endpoints: {
    latest: {
      path: '/api/episodes/latest',
      method: 'GET',
      description: 'Returns the most recent episode. Response shape: { title, audioUrl, imageUrl, description, duration }',
      params: [],
    },
    search: {
      path: '/api/episodes/search',
      method: 'GET',
      description: 'Search by keyword. Query param: q (string). Response: [{ title, audioUrl, imageUrl, description }]',
      params: [{ name: 'q', in: 'query', description: 'search terms' }],
    },
  },
};

app.get('/plugin-manifest', (req, res) => res.json(manifest));
```

That single route is the only addition needed to an existing server.

---

### Plugin response shape

Endpoints return JSON. The DJ interprets the response and decides what to do via `pluginAction.type`:

| `pluginAction.type` | What happens |
|---|---|
| `play` | `audioUrl` is proxied through `/api/stream/proxy` and enqueued in the player |
| `rest-piece` | `imageUrl` + `text` are saved as the art recommendation for the next break |
| `info` | Data is woven into the DJ's spoken reply only — no media action |

Common useful fields in a plugin response:

```json
{
  "title":       "Episode title or content name",
  "audioUrl":    "https://cdn.example.com/episode.mp3",
  "imageUrl":    "https://cdn.example.com/cover.jpg",
  "description": "One paragraph summary",
  "sourceUrl":   "https://original-source.com/item"
}
```

You don't need all of them — the DJ picks what's relevant based on the action type.

---

### Transport options

#### HTTP / HTTPS

Add two routes to your existing server:

```js
// Express example
app.get('/plugin-manifest', (req, res) => res.json(manifest));
app.get('/api/episodes/latest', (req, res) => res.json(getLatestEpisode()));
```

That's it. The `baseUrl` in the manifest should be your server's base URL.

---

#### Unix domain socket

Identical to HTTP — same routes, same JSON responses, just served over a socket file instead of a TCP port. Node.js example:

```js
import http from 'http';
const server = http.createServer(app);
server.listen('/tmp/my-app.sock');
```

Set `baseUrl` to `unix:///tmp/my-app.sock` in the manifest. SEENS uses `http.request({ socketPath })` internally so the HTTP protocol is identical.

---

#### STDIO (subprocess)

No server, no socket, no port. SEENS spawns your script as a child process and communicates over stdin/stdout using newline-delimited JSON-RPC 2.0.

**Request** (written to stdin):
```json
{"jsonrpc":"2.0","id":1,"method":"latest","params":{}}
```

**Response** (written to stdout, one line):
```json
{"jsonrpc":"2.0","id":1,"result":{"title":"...","audioUrl":"..."}}
```

For the manifest, SEENS sends `{"method":"manifest"}` and expects the manifest object in `result`.

**Minimal Node.js plugin** (~25 lines):

```js
#!/usr/bin/env node
import { createInterface } from 'readline';

const manifest = {
  name: 'my-plugin',
  description: 'Does something useful when the user asks for it.',
  baseUrl: `stdio://node ${process.argv[1]}`,
  endpoints: {
    latest: {
      path: '/latest',
      method: 'GET',
      description: 'Returns the latest item. Response: { title, audioUrl, description }',
      params: [],
    },
  },
};

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', line => {
  const { jsonrpc, id, method, params } = JSON.parse(line);

  if (method === 'manifest') {
    return console.log(JSON.stringify({ jsonrpc, id, result: manifest }));
  }

  if (method === 'latest') {
    // Call your app's internal logic here
    const result = { title: 'My Episode', audioUrl: 'https://...', description: '...' };
    console.log(JSON.stringify({ jsonrpc, id, result }));
  }
});
```

Install it:

```
stdio://node /path/to/my-plugin.js
```

**STDIO is the right choice when:**
- Your app is a CLI tool or a script with no existing HTTP server
- You want zero network configuration — no ports, no sockets
- You want the plugin to import your app's modules directly rather than going through a network hop
- You're writing a bridge to a service that has a Node/Python/Go SDK but no HTTP API

---

### Editing `plugins.json` directly

Plugins are stored in `USER/plugins.json`. You can edit it in any text editor and the system picks up changes automatically — no restart, no reload button needed.

**File locations:**

- **Development**: `USER/plugins.json` in the repo root
- **Installed app**: `~/Library/Application Support/seens-radio/USER/plugins.json`

**How hot-reload works:** The server watches `plugins.json` with `fs.watch`. When the file changes it broadcasts a `plugins-changed` WebSocket event to all connected clients. If the Settings panel is open it re-fetches `/api/plugins` and updates immediately. The DJ's system prompt also reads from disk on every chat request, so new or changed plugins are available to the AI without any restart.

**Full file format:**

```json
[
  {
    "name":        "briefcast",
    "description": "Personal podcast app. Use when the user asks to play a podcast or briefing.",
    "enabled":     true,
    "baseUrl":     "http://localhost:3001",
    "endpoints": {
      "latest": {
        "path":        "/api/episodes/latest",
        "method":      "GET",
        "description": "Returns the most recent episode. Response: { title, audioUrl, imageUrl, description }",
        "params":      []
      }
    }
  },
  {
    "name":        "my-stdio-plugin",
    "description": "Does something useful. Call when the user asks for X.",
    "enabled":     false,
    "baseUrl":     "stdio://node /path/to/plugin.js",
    "endpoints": {
      "fetch": {
        "path":        "/fetch",
        "method":      "GET",
        "description": "Fetches data. Response: { title, audioUrl }",
        "params":      []
      }
    }
  }
]
```

`enabled: false` keeps the plugin registered but hidden from the AI and not callable. Toggle it in the Settings panel or flip the boolean in the file.

---

## Personalising the DJ

Edit the files in the `USER/` folder — the DJ reads them at the start of every session:

| File | Purpose |
|---|---|
| `USER/taste.md` | Your music taste, favourite artists, genres, era preferences |
| `USER/routines.md` | Your daily schedule (morning workout, lunch break, evening wind-down) |
| `USER/mood-rules.md` | Rules for the DJ (e.g. "no vocals before 9am", "upbeat on Mondays") |
| `USER/rest-preferences.md` | Preferences for the cultural rest-break feature |
| `USER/story-interests.md` | Topics used to fetch live Hacker News stories for the Story rest-break category (one bullet per topic) |

You can also sync your Spotify/Apple Music/YouTube library to auto-populate `taste.md`:

```bash
npm run sync
```

---

## Switching AI agents at runtime

In the Settings panel, use the **Agent** dropdown to switch between Claude and Codex without restarting. The change takes effect on the next DJ response.

To set a default in `.env`:

```env
AI_AGENT=claude    # or: codex
```

---

## Troubleshooting

**Music not playing**
Make sure `yt-dlp` is installed and on PATH: `yt-dlp --version`. If you installed it via Homebrew, it lives at `/opt/homebrew/bin/yt-dlp` which is already on the app's PATH.

**DJ voice silent**
Check that your TTS provider key is set and valid. The server logs (terminal or Electron DevTools console) will print the error. You can fall back to the free macOS `say` provider by setting `TTS_PROVIDER=say` in `.env`.

**AI not responding**
Run `claude --version` or `codex --version` to confirm the CLI is installed and logged in. The server logs will show the exact error from the subprocess.

**Port already in use**
Change `PORT=7477` to any free port in `.env`. Update all OAuth redirect URIs in each provider's dashboard to match.
