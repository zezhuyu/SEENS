/**
 * SEENS AI Agent — long-running subprocess.
 *
 * Spawned ONCE by AgentClient when seens-radio starts.
 * Stays alive for the lifetime of the server.
 * All conversation memory is managed HERE — nothing in the SEENS app.
 *
 * Memory lives at: ~/.seens/agent/
 *   state.json          — session IDs, metadata
 *   codex-messages.json — Codex conversation history
 *   claude-session      — Claude Code session ID (plain text)
 *
 * Protocol: newline-delimited JSON over stdin/stdout
 *   Request:  { id, method, params }
 *   Response: { id, result }  |  { id, error }
 *
 * Methods:
 *   generate   { systemPrompt, userMessage, mcpConfigPath, skills }
 *              → { say, play, reason, segue, sessionId? }
 *   status     {} → { backend, sessionId, messageCount, uptime }
 *   reset      {} → { ok } — clears this session's memory
 */

import { spawn }      from 'child_process';
import fs             from 'fs';
import path           from 'path';
import os             from 'os';
import readline       from 'readline';
import { createRequire } from 'module';

// ─── Agent memory directory (outside SEENS app) ──────────────────────────────

const AGENT_DIR = path.join(os.homedir(), '.seens', 'agent');
fs.mkdirSync(AGENT_DIR, { recursive: true });

const STATE_FILE   = path.join(AGENT_DIR, 'state.json');
const CODEX_HIST   = path.join(AGENT_DIR, 'codex-messages.json');
const CLAUDE_SID   = path.join(AGENT_DIR, 'claude-session');

// ─── Config ──────────────────────────────────────────────────────────────────

const BACKEND      = (process.env.AI_AGENT ?? 'claude').toLowerCase();
const CLAUDE_BIN   = process.env.CLAUDE_BIN   ?? 'claude';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5';
const CODEX_MODEL  = process.env.CODEX_MODEL  ?? 'gpt-4o-mini';

const START_TIME   = Date.now();

// ─── State ───────────────────────────────────────────────────────────────────

let claudeSessionId = null;    // for --resume
let codexMessages   = [];      // for OpenAI multi-turn

function loadState() {
  // Claude session ID
  try {
    claudeSessionId = fs.readFileSync(CLAUDE_SID, 'utf8').trim() || null;
    if (claudeSessionId) log(`Resuming Claude session: ${claudeSessionId}`);
  } catch { /* no prior session */ }

  // Codex message history
  try {
    const raw = fs.readFileSync(CODEX_HIST, 'utf8');
    codexMessages = JSON.parse(raw);
    log(`Loaded ${codexMessages.length} Codex messages from disk`);
  } catch { codexMessages = []; }
}

function saveState() {
  try {
    if (claudeSessionId) fs.writeFileSync(CLAUDE_SID, claudeSessionId, 'utf8');
    if (BACKEND === 'codex') {
      fs.writeFileSync(CODEX_HIST, JSON.stringify(codexMessages), 'utf8');
    }
    const meta = { backend: BACKEND, claudeSessionId, messageCount: codexMessages.length, savedAt: new Date().toISOString() };
    fs.writeFileSync(STATE_FILE, JSON.stringify(meta, null, 2), 'utf8');
  } catch (err) { log('saveState error: ' + err.message); }
}

// ─── DJ response schema ───────────────────────────────────────────────────────

const DJ_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    say:    { type: 'string' },
    play:   { type: 'array', items: { type: 'object' } },
    reason: { type: 'string' },
    segue:  { type: 'string' },
    pluginCall: {
      type: 'object',
      properties: {
        plugin:   { type: 'string' },
        endpoint: { type: 'string' },
        params:   { type: 'object' },
      },
      required: ['plugin', 'endpoint'],
    },
    pluginAction: {
      type: 'object',
      properties: {
        type:      { type: 'string', enum: ['play', 'rest-piece', 'info'] },
        title:     { type: 'string' },
        audioUrl:  { type: 'string' },
        imageUrl:  { type: 'string' },
        text:      { type: 'string' },
        sourceUrl: { type: 'string' },
      },
      required: ['type', 'title'],
    },
  },
  required: ['say', 'play', 'reason', 'segue'],
});

const CODEX_JSON_INSTRUCTION = `
Respond ONLY with a single JSON object (no markdown) matching:
{"say":"","play":[{"title":"","artist":"","source":"spotify|apple|youtube|any"}],"reason":"","segue":"","pluginCall":null,"pluginAction":null}
pluginAction.type: "play" (has audio), "rest-piece" (image+text, no audio), "info" (text only).
Always populate say.`;

// ─── Backend: Claude ──────────────────────────────────────────────────────────

async function generateClaude(systemPrompt, userMessage, mcpConfigPath, skills) {
  const args = [
    '-p', userMessage,
    '--output-format', 'json',
    '--json-schema', DJ_SCHEMA,
    '--model', CLAUDE_MODEL,
  ];

  // Inject fresh context as appended system prompt
  let appendPrompt = systemPrompt;
  if (skills?.length) {
    appendPrompt += '\n\n---\n## Skills Available\n' + skills.join('\n\n');
  }
  args.push('--append-system-prompt', appendPrompt);

  // Resume existing session (persistent memory via Claude Code session system)
  if (claudeSessionId) {
    args.push('--resume', claudeSessionId);
    log(`Resuming session ${claudeSessionId}`);
  }

  // MCP tools
  if (mcpConfigPath && fs.existsSync(mcpConfigPath)) {
    args.push('--mcp-config', mcpConfigPath);
  }

  // NOTE: --no-session-persistence intentionally removed — claude manages memory
  const raw = await runCLI(CLAUDE_BIN, args);
  const { result, sessionId } = parseClaude(raw);

  // Capture/update session ID for next turn
  if (sessionId && sessionId !== claudeSessionId) {
    claudeSessionId = sessionId;
    log(`New Claude session: ${claudeSessionId}`);
    saveState();
  }

  return result;
}

function parseClaude(raw) {
  let sessionId = null;
  let obj = null;
  try {
    const parsed = JSON.parse(raw.trim());
    // Extract session ID from claude CLI JSON output
    sessionId = parsed.session_id ?? parsed.sessionId ?? null;
    if (parsed.structured_output) obj = parsed.structured_output;
    else if (parsed.result) {
      try { obj = JSON.parse(parsed.result); } catch { obj = parsed; }
    } else { obj = parsed; }
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) { try { obj = JSON.parse(match[0]); } catch { /* */ } }
  }
  return { result: normalizeResult(obj, raw), sessionId };
}

// ─── Backend: Codex ───────────────────────────────────────────────────────────

async function generateCodex(systemPrompt, userMessage) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');

  // Build system message from current context (replaces/updates system turn)
  const sysMsg = { role: 'system', content: systemPrompt + '\n' + CODEX_JSON_INSTRUCTION };

  // Keep system message + last 40 turns to stay within context limits
  const history = codexMessages.slice(-40);
  const messages = [sysMsg, ...history, { role: 'user', content: userMessage }];

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: CODEX_MODEL,
      response_format: { type: 'json_object' },
      messages,
      max_tokens: 1500,
      temperature: 1.1,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';

  // Persist conversation turns in agent memory (not in SEENS)
  codexMessages.push({ role: 'user', content: userMessage });
  codexMessages.push({ role: 'assistant', content: text });
  saveState();

  return normalizeResult(parseJSON(text), text);
}

// ─── Normalise ────────────────────────────────────────────────────────────────

function normalizeResult(obj, raw) {
  if (!obj) return { say: raw?.trim() ?? '', play: [], reason: '', segue: '' };
  return {
    say:          String(obj.say ?? ''),
    play:         Array.isArray(obj.play) ? obj.play.map(normalizeTrack) : [],
    reason:       String(obj.reason ?? ''),
    segue:        String(obj.segue ?? ''),
    playIntent:   obj.playIntent   ?? null,
    pluginCall:   obj.pluginCall?.plugin ? obj.pluginCall   : null,
    pluginAction: obj.pluginAction?.type ? obj.pluginAction : null,
  };
}

function normalizeTrack(t) {
  return {
    title:  String(t.title ?? t.track ?? t.name ?? t.song ?? ''),
    artist: String(t.artist ?? t.by ?? ''),
    source: String(t.source ?? 'any'),
    uri:    t.uri ?? null,
  };
}

function parseJSON(text) {
  const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  try { return JSON.parse(cleaned); } catch { /* */ }
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch { /* */ } }
  return null;
}

// ─── CLI runner ───────────────────────────────────────────────────────────────

function runCLI(bin, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { env: process.env });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`claude exited ${code}: ${stderr.slice(0, 300)}`));
      else resolve(stdout);
    });
    proc.on('error', reject);
    setTimeout(() => { proc.kill(); reject(new Error('claude CLI timeout')); }, 90_000);
  });
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

async function dispatch(method, params) {
  switch (method) {

    case 'generate': {
      const { systemPrompt, userMessage, mcpConfigPath, skills } = params;
      log(`generate via ${BACKEND} (sessionId=${claudeSessionId ?? 'none'})`);

      if (BACKEND === 'claude') {
        return generateClaude(systemPrompt, userMessage, mcpConfigPath, skills);
      } else {
        return generateCodex(systemPrompt, userMessage);
      }
    }

    case 'status': {
      return {
        backend:      BACKEND,
        sessionId:    claudeSessionId,
        messageCount: codexMessages.length,
        uptimeMs:     Date.now() - START_TIME,
      };
    }

    case 'reset': {
      claudeSessionId = null;
      codexMessages   = [];
      try { fs.unlinkSync(CLAUDE_SID);  } catch { /* */ }
      try { fs.unlinkSync(CODEX_HIST);  } catch { /* */ }
      saveState();
      log('Session reset');
      return { ok: true };
    }

    case 'shutdown':
      saveState();
      return { ok: true };

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

// ─── stdio JSON-RPC loop ──────────────────────────────────────────────────────

function log(msg) {
  process.stderr.write(`[AgentProcess] ${msg}\n`);
}

async function main() {
  loadState();
  log(`Started. backend=${BACKEND} pid=${process.pid}`);

  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on('line', async (line) => {
    line = line.trim();
    if (!line) return;

    let req;
    try { req = JSON.parse(line); }
    catch (e) {
      sendRaw({ id: null, error: `Invalid JSON: ${e.message}` });
      return;
    }

    const { id, method, params = {} } = req;
    try {
      const result = await dispatch(method, params);
      sendRaw({ id, result });
    } catch (err) {
      log(`Error in ${method}: ${err.message}`);
      sendRaw({ id, error: err.message });
    }

    if (method === 'shutdown') {
      process.exit(0);
    }
  });

  rl.on('close', () => {
    log('stdin closed — saving state and exiting');
    saveState();
    process.exit(0);
  });

  // Periodic state flush every 5 min
  setInterval(saveState, 5 * 60 * 1000);
}

function sendRaw(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

main().catch(err => {
  process.stderr.write(`[AgentProcess] Fatal: ${err.message}\n`);
  process.exit(1);
});
