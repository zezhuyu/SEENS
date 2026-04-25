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
3. Set **Redirect URI** to `http://localhost:7477/callback/spotify` (must match `PORT`).
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
