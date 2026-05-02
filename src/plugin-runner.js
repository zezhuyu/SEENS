import { readUserJSON, userPath } from './paths.js';
import fs from 'fs';
import http from 'http';
import { spawn } from 'child_process';

export function loadPlugins() {
  return readUserJSON('plugins.json') ?? [];
}

export function savePlugins(plugins) {
  fs.writeFileSync(userPath('plugins.json'), JSON.stringify(plugins, null, 2));
}

// ── Transport detection ───────────────────────────────────────────────────────
// Supported baseUrl schemes:
//   http://host:port         — standard HTTP
//   https://host             — standard HTTPS (fetch)
//   unix:///path/to.sock     — Unix domain socket (HTTP over socket)
//   socket:///path/to.sock
//   ipc:///path/to.sock
//   /absolute/path.sock      — bare socket path (auto-detected by .sock extension)
//   stdio://node /path/to/plugin.js  — subprocess, JSON-RPC over stdin/stdout
//   stdio:///path/to/executable
//   cli:///path/to/binary    — CLI subprocess: runs `<binary> <endpoint> [<params-json>]`
//   cli://command-on-PATH    — CLI subprocess via PATH lookup

function socketPath(baseUrl) {
  const m = baseUrl.match(/^(?:unix|socket|ipc):\/\/(\/.*)/);
  if (m) return m[1];
  if (/^\/.*\.sock(\/|$)/.test(baseUrl)) return baseUrl.replace(/\/.*$/, '') || baseUrl;
  return null;
}

// Low-level HTTP request over a Unix domain socket.
// Returns a plain response-like object: { ok, status, json() }
function httpOverSocket({ path: sockPath, method, httpPath, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const opts = {
      socketPath: sockPath,
      path: httpPath,
      method: method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...headers,
      },
    };

    const req = http.request(opts, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 400,
          status: res.statusCode,
          json: () => JSON.parse(raw),
        });
      });
    });

    req.on('error', reject);
    const timer = setTimeout(() => { req.destroy(); reject(new Error('socket timeout')); }, 10_000);
    req.on('close', () => clearTimeout(timer));

    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ── STDIO transport ───────────────────────────────────────────────────────────
// baseUrl format:  stdio://node /path/to/plugin.js
//                  stdio:///path/to/executable
// Protocol: one JSON-RPC 2.0 request line on stdin → one JSON response line on stdout.
// Each call spawns a fresh process (stateless, no long-lived daemon needed).
//
// Plugin stdin receives:
//   {"jsonrpc":"2.0","id":1,"method":"<endpointName>","params":{...}}
//
// Plugin stdout must reply with one of:
//   {"jsonrpc":"2.0","id":1,"result":{...}}
//   {"jsonrpc":"2.0","id":1,"error":{"message":"..."}}
//   {<plain result object>}  — simple scripts may omit the jsonrpc envelope

function parseStdioCommand(baseUrl) {
  // Strip scheme and split into [bin, ...args]
  const cmd = baseUrl.replace(/^stdio:\/\//, '').trim();
  const parts = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return { bin: parts[0] ?? '', args: parts.slice(1) };
}

function callStdio({ bin, args, method, params = {} }) {
  return new Promise((resolve, reject) => {
    if (!bin) return reject(new Error('STDIO plugin: no executable specified'));

    const proc = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('STDIO plugin timeout (15s)'));
    }, 15_000);

    proc.on('error', err => { clearTimeout(timer); reject(err); });

    proc.on('close', () => {
      clearTimeout(timer);
      // Parse the last valid JSON line from stdout
      const lines = stdout.trim().split('\n').reverse();
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          const obj = JSON.parse(t);
          if (obj.error)  return reject(new Error(obj.error.message ?? JSON.stringify(obj.error)));
          if (obj.result !== undefined) return resolve(obj.result);
          return resolve(obj); // plain JSON without jsonrpc envelope
        } catch { /* try next line */ }
      }
      reject(new Error(
        `STDIO plugin returned no JSON${stderr ? `: ${stderr.slice(0, 200)}` : ''}`
      ));
    });

    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n');
    proc.stdin.end();
  });
}

// ── CLI transport ─────────────────────────────────────────────────────────────
// baseUrl format:  cli:///path/to/binary   (absolute path)
//                  cli://command-name       (resolved via PATH)
//
// Protocol: spawns  `<command> <endpoint> [<params-as-json-string>]`
// Reads the last valid JSON line from stdout as the result.
// The binary must exit 0 on success; non-zero exit is treated as an error.
//
// Minimal CLI plugin example (node):
//   process.argv[2] is the endpoint name ("manifest", "latest", etc.)
//   process.argv[3] is params as a JSON string (may be absent)
//   Write result JSON to stdout and exit 0.

function parseCliCommand(baseUrl) {
  return baseUrl.replace(/^cli:\/\//, '') || '';
}

function callCli({ command, method, params = {} }) {
  return new Promise((resolve, reject) => {
    if (!command) return reject(new Error('CLI plugin: no command specified'));
    const args = [method];
    if (Object.keys(params).length > 0) args.push(JSON.stringify(params));

    const proc = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => { stderr += d; });

    const timer = setTimeout(() => { proc.kill(); reject(new Error('CLI plugin timeout (15s)')); }, 15_000);
    proc.on('error', err => { clearTimeout(timer); reject(err); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      const lines = stdout.trim().split('\n').reverse();
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          const obj = JSON.parse(t);
          if (obj.error) return reject(new Error(obj.error.message ?? JSON.stringify(obj.error)));
          if (obj.result !== undefined) return resolve(obj.result);
          return resolve(obj);
        } catch { /* try next line */ }
      }
      reject(new Error(
        `CLI plugin ${code !== 0 ? `exited ${code}` : 'returned no JSON'}${stderr ? `: ${stderr.slice(0, 200)}` : ''}`
      ));
    });
  });
}

// pluginFetch handles HTTP(S) and Unix socket transports (request/response style).
// For STDIO plugins use callPlugin / fetchPluginManifest which dispatch differently.
export async function pluginFetch({ baseUrl, method = 'GET', httpPath = '/', body }) {
  const sock = socketPath(baseUrl);
  if (sock) {
    return httpOverSocket({ path: sock, method, httpPath, body });
  }
  // Standard HTTP/HTTPS via fetch
  const url = baseUrl.replace(/\/$/, '') + httpPath;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10_000),
  };
  if (body) opts.body = typeof body === 'string' ? body : JSON.stringify(body);
  const r = await fetch(url, opts);
  return { ok: r.ok, status: r.status, json: () => r.json() };
}

// Fetch the plugin manifest regardless of transport. Used by install-from-url.
export async function fetchPluginManifest(baseUrl) {
  if (baseUrl.startsWith('cli://')) {
    const command = parseCliCommand(baseUrl);
    return callCli({ command, method: 'manifest', params: {} });
  }
  if (baseUrl.startsWith('stdio://')) {
    const { bin, args } = parseStdioCommand(baseUrl);
    return callStdio({ bin, args, method: 'manifest', params: {} });
  }
  // HTTP / socket: try /plugin-manifest then root
  const errors = [];
  for (const httpPath of ['/plugin-manifest', '/']) {
    try {
      const r = await pluginFetch({ baseUrl, method: 'GET', httpPath });
      if (r.ok) return r.json();
      errors.push(`HTTP ${r.status} at ${httpPath}`);
    } catch (e) { errors.push(e.message); }
  }
  throw new Error(`Could not fetch manifest: ${errors.join('; ')}`);
}

// ── Plugin call ───────────────────────────────────────────────────────────────

export async function callPlugin(pluginName, endpointName, params = {}) {
  const plugins = loadPlugins();
  const plugin = plugins.find(p => p.name === pluginName && p.enabled);
  if (!plugin) throw new Error(`Plugin "${pluginName}" not found or disabled`);

  const endpoint = plugin.endpoints?.[endpointName];
  if (!endpoint) throw new Error(`Endpoint "${endpointName}" not found on plugin "${pluginName}"`);

  // ── CLI transport ───────────────────────────────────────────────────────────
  if (plugin.baseUrl.startsWith('cli://')) {
    const command = parseCliCommand(plugin.baseUrl);
    console.log(`[Plugin] ${pluginName}/${endpointName} → cli ${command} (method=${endpointName})`);
    return callCli({ command, method: endpointName, params });
  }

  // ── STDIO transport ─────────────────────────────────────────────────────────
  if (plugin.baseUrl.startsWith('stdio://')) {
    const { bin, args } = parseStdioCommand(plugin.baseUrl);
    console.log(`[Plugin] ${pluginName}/${endpointName} → stdio ${bin} (method=${endpointName})`);
    return callStdio({ bin, args, method: endpointName, params });
  }

  // ── HTTP / socket transport ─────────────────────────────────────────────────
  const method = (endpoint.method || 'GET').toUpperCase();

  // Substitute {param} path templates and collect remaining params
  let httpPath = endpoint.path;
  const usedInPath = new Set();
  for (const [k, v] of Object.entries(params)) {
    if (httpPath.includes(`{${k}}`)) {
      httpPath = httpPath.replace(`{${k}}`, encodeURIComponent(String(v)));
      usedInPath.add(k);
    }
  }
  const remainingParams = Object.fromEntries(Object.entries(params).filter(([k]) => !usedInPath.has(k)));

  let body;
  if (method === 'GET') {
    if (Object.keys(remainingParams).length > 0) {
      httpPath += '?' + new URLSearchParams(remainingParams).toString();
    }
  } else {
    // Always send a JSON body for non-GET requests (some servers reject bodyless POSTs)
    body = Object.keys(remainingParams).length > 0 ? remainingParams : {};
  }

  console.log(`[Plugin] ${pluginName}/${endpointName} → ${method} ${plugin.baseUrl}${httpPath}`);
  const res = await pluginFetch({ baseUrl: plugin.baseUrl, method, httpPath, body });
  if (!res.ok) throw new Error(`Plugin ${pluginName}/${endpointName} returned HTTP ${res.status}`);
  return res.json();
}

// ── System prompt context ─────────────────────────────────────────────────────

export function pluginSystemContext() {
  const plugins = loadPlugins();
  const enabled = plugins.filter(p => p.enabled);
  if (!enabled.length) return null;

  const lines = [
    'You have access to external plugins.',
    'IMPORTANT: For any of the categories below, you MUST issue a "pluginCall" and leave "play" empty. Do NOT answer from memory, do not fabricate data, do not guess URLs.',
    '  • News, headlines, today\'s news, current events, daily briefing, podcast, episode → use briefcast plugin',
    '  • Market insight, market conditions, stocks, portfolio, investment research, financial data, daily market briefing, investment radar, wealth → use aegis-wealth plugin',
    '  • Any real-time or today\'s information that a connected plugin can provide',
    'When in doubt whether to use a plugin: if the data could have changed since yesterday, use the plugin.',
    'You will receive the plugin result in the next turn and should then set "pluginAction" to decide what to do with it.',
    '',
    'Available plugins:',
  ];

  for (const p of enabled) {
    lines.push(`\n### ${p.name}`);
    lines.push(p.description);
    lines.push('Endpoints:');
    // If djEndpoints is set, only expose those endpoints to the DJ to keep the prompt concise
    const allowedNames = p.djEndpoints?.length ? new Set(p.djEndpoints) : null;
    for (const [name, ep] of Object.entries(p.endpoints ?? {})) {
      if (allowedNames && !allowedNames.has(name)) continue;
      const paramList = (ep.params ?? []).map(pr => `${pr.name}: ${pr.description}`).join(', ');
      lines.push(`  - ${name}(${paramList}): ${ep.description}`);
    }
  }

  lines.push('');
  lines.push('pluginAction type — choose based on what the plugin returned:');
  lines.push('  "play"       → plugin has audio (audio_url/audioUrl/url). Set audioUrl (copy verbatim). Set imageUrl if there is an image. Set play=[].');
  lines.push('  "rest-piece" → plugin has an image + article/text but NO audio. Set imageUrl and text.');
  lines.push('  "info"       → plugin returned only text/data. Summarize in say. No pluginAction needed.');
  lines.push('');
  lines.push('Field copy rules — always copy values exactly from the plugin result, never rewrite or shorten:');
  lines.push('  audio_url / audioUrl / url  → pluginAction.audioUrl  (accepts file://, /absolute/path, or https://)');
  lines.push('  image_url / imageUrl / image → pluginAction.imageUrl (may be a relative path — copy as-is, server resolves it)');
  lines.push('  title                        → pluginAction.title');
  lines.push('Always write a non-empty say — spoken intro for play, spoken summary for rest-piece or info.');

  return lines.join('\n');
}
