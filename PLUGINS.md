# Plugin system

Plugins let the DJ fetch content from other apps or services on demand. When you say "play me the latest briefing" or "show me something from my reading list", the DJ can call a plugin, get back audio/images/text, and act on it — play the audio directly, show the image as a rest-break recommendation, or weave the text into its reply.

No rebuild is needed once the plugin infrastructure is in the app. Plugins are managed entirely through `USER/plugins.json` and the Settings panel.

---

## Do you need to write a dedicated API?

**Short answer: it depends on the transport you choose.**

| Situation | What you need |
|---|---|
| Your app already has an HTTP server | Add one `GET /plugin-manifest` route and you're done |
| Your app communicates over a Unix socket | Same — expose `GET /plugin-manifest` on the socket |
| You don't want to touch your app at all | Write a small STDIO bridge script (20–40 lines) that reads from stdin and calls your app's internal logic |
| Your app has no API surface at all | STDIO is the easiest path — the bridge script can import your app's modules directly |

The key point: **SEENS calls out to your plugin, your plugin never calls into SEENS**. The plugin just needs to answer two things: a manifest describing itself, and calls to its endpoints.

---

## Installing a plugin

Open **Settings → Plugins** and paste the plugin's URL into the Install field, then press Enter or click **Install**. The app fetches the manifest and registers the plugin immediately — no restart needed.

Supported URL formats:

```
http://localhost:3001             → HTTP server
https://my-service.local          → HTTPS server
unix:///tmp/my-app.sock           → Unix domain socket
socket:///tmp/my-app.sock         → same
ipc:///tmp/my-app.sock            → same
/tmp/my-app.sock                  → bare socket path (detected by .sock extension)
stdio://node /path/to/plugin.js   → subprocess (JSON-RPC over stdin/stdout)
stdio:///path/to/executable       → any binary
```

After installing, use the toggle next to each plugin to enable or disable it. The DJ only sees enabled plugins.

---

## Plugin manifest

Every plugin must expose its manifest — a JSON object that tells SEENS what the plugin is and what it can do.

- **HTTP / socket plugins** expose it at `GET /plugin-manifest`
- **STDIO plugins** return it when they receive `{"method":"manifest"}` on stdin

### Full manifest schema

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

### Field reference

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Unique identifier. Used as the plugin's key in `plugins.json`. |
| `description` | yes | **This goes into the AI's system prompt verbatim.** Write it as instructions: when to call this plugin, what it returns, what it's best for. |
| `baseUrl` | recommended | The base URL SEENS uses to call endpoints. If omitted, the install URL is used. For STDIO plugins this should be `stdio://node /path/to/plugin.js`. |
| `version` | no | Informational only. |
| `endpoints` | yes | Map of endpoint name → endpoint definition. |

### Endpoint field reference

| Field | Required | Notes |
|---|---|---|
| `path` | yes (HTTP) | Sub-path appended to `baseUrl`. Not used for STDIO — the endpoint name becomes the JSON-RPC method. |
| `method` | no | HTTP method. Defaults to `GET`. |
| `description` | yes | **Also injected into the AI prompt.** Describe what this endpoint does, what parameters it accepts, and what its response shape is. Be specific — the AI uses this to decide whether and how to call it. |
| `params` | no | List of parameter descriptors: `{ name, in, description }`. `in` is `"query"` (appended to URL) or `"body"` (JSON body). |

### Implementing `GET /plugin-manifest`

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

## Plugin response shape

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

## Transport options

### HTTP / HTTPS

Add two routes to your existing server:

```js
// Express example
app.get('/plugin-manifest', (req, res) => res.json(manifest));
app.get('/api/episodes/latest', (req, res) => res.json(getLatestEpisode()));
```

That's it. The `baseUrl` in the manifest should be your server's base URL.

---

### Unix domain socket

Identical to HTTP — same routes, same JSON responses, just served over a socket file instead of a TCP port. Node.js example:

```js
import http from 'http';
const server = http.createServer(app);
server.listen('/tmp/my-app.sock');
```

Set `baseUrl` to `unix:///tmp/my-app.sock` in the manifest. SEENS uses `http.request({ socketPath })` internally so the HTTP protocol is identical.

---

### STDIO (subprocess)

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

## Editing `plugins.json` directly

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
