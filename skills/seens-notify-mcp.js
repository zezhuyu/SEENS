#!/usr/bin/env node
/**
 * SEENS Notify — MCP server (zero-dependency, stdio transport)
 *
 * Exposes a single `notify` tool that sends a notification to the SEENS
 * widget running on localhost. Auto-detects the port.
 *
 * Install into Claude Code (run once from the repo root):
 *   claude mcp add seens-notify -- node "$(pwd)/skills/seens-notify-mcp.js"
 *
 * Or copy this file anywhere and point the path at it.
 * The .mcp.json at the repo root wires it automatically when
 * enableAllProjectMcpServers is true in .claude/settings.local.json.
 */

import http from 'http';

// ── Tool definition ────────────────────────────────────────────────────────────

const NOTIFY_TOOL = {
  name: 'notify',
  description:
    'Send a notification to the SEENS widget app. ' +
    'Shows a toast popup in the bottom-right corner and adds an entry to the bell-icon panel. ' +
    'Use for: task completions, build results, subscription alerts, reminders, background job status, ' +
    'or anything the user should be aware of while focused.',
  inputSchema: {
    type: 'object',
    required: ['title', 'message'],
    properties: {
      title: {
        type: 'string',
        description: 'Short headline — keep under 60 characters',
      },
      message: {
        type: 'string',
        description: 'Notification body — 1 to 3 sentences explaining what happened or what needs attention',
      },
      type: {
        type: 'string',
        enum: ['info', 'success', 'warning', 'error'],
        description:
          'Severity level. info = blue (neutral), success = green (completed), ' +
          'warning = amber (needs attention), error = red (something failed). Defaults to info.',
      },
      link: {
        type: 'string',
        description: 'Optional URL — clicking the notification item in the widget panel will open this',
      },
    },
  },
};

// ── Port detection ─────────────────────────────────────────────────────────────

async function detectPort() {
  const candidates = [
    process.env.PORT,
    process.env.SEENS_PORT,
    '8080',
    '7477',
    '3000',
    '3001',
  ].filter(Boolean);

  for (const port of candidates) {
    if (await portLive(Number(port))) return Number(port);
  }
  return 7477;
}

function portLive(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/api/now', method: 'GET', timeout: 800 },
      () => { req.destroy(); resolve(true); }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// ── HTTP helper ────────────────────────────────────────────────────────────────

function postJSON(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 5000,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode, body: raw }); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

// ── MCP JSON-RPC 2.0 (stdio) ───────────────────────────────────────────────────

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function textContent(text) {
  return { content: [{ type: 'text', text }] };
}

function errorContent(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'seens-notify', version: '1.0.0' },
      });
      break;

    case 'notifications/initialized':
      break; // client notification — no response

    case 'ping':
      reply(id, {});
      break;

    case 'tools/list':
      reply(id, { tools: [NOTIFY_TOOL] });
      break;

    case 'tools/call': {
      const { name, arguments: args = {} } = params ?? {};

      if (name !== 'notify') {
        replyError(id, -32601, `Unknown tool: ${name}`);
        break;
      }

      const { title, message, type = 'info', link } = args;

      if (!title?.trim() || !message?.trim()) {
        reply(id, errorContent('title and message are required'));
        break;
      }

      try {
        const port = await detectPort();
        const res = await postJSON(port, '/api/notify', { title, message, type, link });

        if (res.status === 200 && res.body?.ok) {
          reply(id, textContent(
            `✓ Notification sent to SEENS widget (port ${port})\n` +
            `  Title:   ${title}\n` +
            `  Message: ${message}\n` +
            `  Level:   ${type}`
          ));
        } else {
          reply(id, errorContent(
            `SEENS API returned HTTP ${res.status}: ${JSON.stringify(res.body)}`
          ));
        }
      } catch (err) {
        reply(id, errorContent(
          `Could not reach the SEENS widget: ${err.message}\n` +
          'Make sure the app is running before sending notifications.'
        ));
      }
      break;
    }

    default:
      if (id != null) replyError(id, -32601, `Method not found: ${method}`);
  }
}

// ── Stdin reader ───────────────────────────────────────────────────────────────

let _buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  _buf += chunk;
  const lines = _buf.split('\n');
  _buf = lines.pop();
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let msg;
    try { msg = JSON.parse(t); } catch { continue; }
    handleMessage(msg).catch((err) =>
      process.stderr.write(`[seens-notify] unhandled: ${err.message}\n`)
    );
  }
});

process.stdin.on('end', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
