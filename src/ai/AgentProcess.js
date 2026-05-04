/**
 * SEENS AI Agent — long-running subprocess.
 *
 * Spawned ONCE by AgentClient when seens-radio starts.
 * Stays alive for the lifetime of the server.
 * All conversation memory is managed HERE — nothing in the SEENS app.
 *
 * Memory lives at: ~/.seens/agent/
 *   state.json     — session IDs, metadata
 *   claude-session — Claude Code session ID (plain text)
 *   codex-session  — Codex CLI thread ID (plain text)
 *
 * Both backends use their CLI from PATH — no direct API calls:
 *   Claude: `claude -p <msg> --resume <session_id> ...`
 *   Codex:  `codex exec <msg> --json -o <file>` /
 *           `codex exec resume <thread_id> <msg> --json -o <file>`
 *
 * Protocol: newline-delimited JSON over stdin/stdout
 *   Request:  { id, method, params }
 *   Response: { id, result }  |  { id, error }
 *
 * Methods:
 *   generate   { systemPrompt, userMessage, plugins? }
 *              → { say, play, reason, segue, sessionId? }
 *   status     {} → { backend, sessionId, uptimeMs }
 *   reset      {} → { ok } — clears this session's memory
 */

import { spawn, execSync } from 'child_process';
import fs             from 'fs';
import path           from 'path';
import os             from 'os';
import readline       from 'readline';
import { fileURLToPath } from 'url';

// ─── Agent memory directory (outside SEENS app) ──────────────────────────────

const AGENT_DIR = path.join(os.homedir(), '.seens', 'agent');
fs.mkdirSync(AGENT_DIR, { recursive: true });

const STATE_FILE   = path.join(AGENT_DIR, 'state.json');
const CLAUDE_SID   = path.join(AGENT_DIR, 'claude-session');
const CODEX_SID    = path.join(AGENT_DIR, 'codex-session');

// seens-radio project root — claude CLI auto-loads .mcp.json and
// ~/.claude/settings.json (global MCPs + skills) from here
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ─── Config ──────────────────────────────────────────────────────────────────

const BACKEND      = (process.env.AI_AGENT ?? 'claude').toLowerCase();
const CLAUDE_BIN   = process.env.CLAUDE_BIN   ?? 'claude';
const CODEX_BIN    = process.env.CODEX_BIN    ?? 'codex';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5';
// CODEX_MODEL: leave unset to use whatever model is in ~/.codex/config.toml
const CODEX_MODEL  = process.env.CODEX_MODEL  ?? null;

const START_TIME   = Date.now();

// ─── State ───────────────────────────────────────────────────────────────────

let claudeSessionId = null;    // for claude --resume
let codexSessionId  = null;    // for codex exec resume <thread_id>

function loadState() {
  try {
    claudeSessionId = fs.readFileSync(CLAUDE_SID, 'utf8').trim() || null;
    if (claudeSessionId) log(`Resuming Claude session: ${claudeSessionId}`);
  } catch { /* no prior session */ }

  try {
    codexSessionId = fs.readFileSync(CODEX_SID, 'utf8').trim() || null;
    if (codexSessionId) log(`Resuming Codex thread: ${codexSessionId}`);
  } catch { /* no prior session */ }
}

function saveState() {
  try {
    if (claudeSessionId) fs.writeFileSync(CLAUDE_SID, claudeSessionId, 'utf8');
    if (codexSessionId)  fs.writeFileSync(CODEX_SID,  codexSessionId,  'utf8');
    const meta = { backend: BACKEND, claudeSessionId, codexSessionId, savedAt: new Date().toISOString() };
    fs.writeFileSync(STATE_FILE, JSON.stringify(meta, null, 2), 'utf8');
  } catch (err) { log('saveState error: ' + err.message); }
}

// ─── DJ response schema ───────────────────────────────────────────────────────

// ─── DJ response schema ───────────────────────────────────────────────────────

// Claude CLI accepts the schema as inline JSON
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


// ─── Backend: Claude ──────────────────────────────────────────────────────────

// plugins: array of plugin descriptors from USER/plugins.json (SEENS app plugins)
// MCPs and skills are NOT passed from seens — claude CLI auto-loads them:
//   ~/.claude/settings.json → global MCPs + skills
//   PROJECT_ROOT/.mcp.json  → project MCPs (seens-notify etc.)
async function generateClaude(systemPrompt, userMessage, plugins) {
  let appendPrompt = systemPrompt;
  if (plugins?.length) {
    appendPrompt += '\n\n---\n## SEENS Plugins Available\n' +
      plugins.map(p => `- ${p.name}: ${p.description ?? ''}`).join('\n');
  }

  const args = [
    '-p', userMessage,
    '--output-format', 'json',
    '--json-schema', DJ_SCHEMA,
    '--model', CLAUDE_MODEL,
    '--append-system-prompt', appendPrompt,
  ];

  // Resume existing session — claude Code session system manages all memory
  if (claudeSessionId) {
    args.push('--resume', claudeSessionId);
    log(`Resuming session ${claudeSessionId}`);
  }

  // NOTE: --no-session-persistence intentionally absent — session is persistent
  // NOTE: --mcp-config intentionally absent — claude auto-loads from cwd + ~/.claude/
  const raw = await runCLI(CLAUDE_BIN, args, PROJECT_ROOT);
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

// ─── Backend: Codex CLI ───────────────────────────────────────────────────────
//
// Uses the local `codex` CLI from PATH — no direct API calls.
// Session persistence: codex CLI stores conversation history internally and
// exposes it via thread IDs.  We save the thread_id to ~/.seens/agent/codex-session.
//
// Codex doesn't have --append-system-prompt; we prepend the system context to
// the user message so the DJ persona and taste profile are always in scope.

const CODEX_JSON_INSTRUCTION =
  '\n\nRespond ONLY with a single JSON object (no markdown fences) matching:\n' +
  '{"say":"","play":[{"title":"","artist":"","source":"spotify|apple|youtube|any"}],"reason":"","segue":""}\n' +
  'Always populate say. pluginCall and pluginAction may be omitted.';

async function generateCodex(systemPrompt, userMessage, plugins) {
  // Build combined prompt: system context + JSON instruction + user message
  let context = systemPrompt;
  if (plugins?.length) {
    context += '\n\n---\n## SEENS Plugins Available\n' +
      plugins.map(p => `- ${p.name}: ${p.description ?? ''}`).join('\n');
  }
  context += CODEX_JSON_INSTRUCTION;
  const fullPrompt = `${context}\n\n---\n\n${userMessage}`;

  let args;
  if (codexSessionId) {
    // Resume existing thread — codex CLI manages full conversation history internally
    args = ['exec', 'resume', codexSessionId, fullPrompt];
    log(`Resuming Codex thread ${codexSessionId}`);
  } else {
    args = ['exec', fullPrompt];
  }

  args.push('--json');   // JSONL events on stdout — gives us thread_id + item.completed
  if (CODEX_MODEL) args.push('-m', CODEX_MODEL);

  // ignoreStdin prevents codex from blocking waiting for piped input
  const jsonl = await runCLI(CODEX_BIN, args, PROJECT_ROOT, { ignoreStdin: true });

  // Parse JSONL: extract thread_id and final agent message text
  let threadId = null;
  let resultText = null;
  for (const line of jsonl.split('\n')) {
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    if (evt.type === 'thread.started' && evt.thread_id) {
      threadId = evt.thread_id;
    } else if (evt.type === 'item.completed' && evt.item?.type === 'agent_message') {
      resultText = evt.item.text ?? null;
    }
  }

  if (threadId && threadId !== codexSessionId) {
    codexSessionId = threadId;
    log(`New Codex thread: ${codexSessionId}`);
    saveState();
  }

  return normalizeResult(parseJSON(resultText ?? ''), resultText ?? '');
}

// ─── Normalise ────────────────────────────────────────────────────────────────

function normalizeResult(obj, raw) {
  if (!obj) return { say: raw?.trim() ?? '', play: [], reason: '', segue: '' };
  // Some models (gpt-5.5) double-wrap: the outer say field contains the real JSON.
  // Detect this and unwrap before normalizing.
  if (typeof obj.say === 'string' && obj.say.trimStart().startsWith('{')) {
    const inner = parseJSON(obj.say);
    if (inner && typeof inner.say === 'string' && !inner.say.trimStart().startsWith('{')) {
      obj = inner;
    }
  }
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
  if (!text) return null;
  const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();

  // Fast path: well-formed JSON
  try { return JSON.parse(cleaned); } catch { /* */ }

  // Extract the outermost {...} block
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try { return JSON.parse(match[0]); } catch { /* */ }

  // Repair: LLMs sometimes embed unescaped double-quotes inside JSON strings
  // (e.g. "say":"He played "Holocene" in a cabin").  Replace `"` that appear
  // inside a string value with \" using a simple state-machine pass.
  try { return JSON.parse(repairJson(match[0])); } catch { /* */ }

  return null;
}

function repairJson(s) {
  let out = '';
  let inString = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') {
      // Keep existing escape sequence intact
      out += ch + (s[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (ch === '"') {
      if (!inString) {
        inString = true;
        out += ch;
      } else {
        // Peek ahead: is the next non-space char a JSON structural token?
        // If yes → end of string.  If no → embedded quote, escape it.
        let j = i + 1;
        while (j < s.length && s[j] === ' ') j++;
        const next = s[j];
        if (next === ':' || next === ',' || next === '}' || next === ']' || next === '"') {
          inString = false;
          out += ch;
        } else {
          out += '\\"';
        }
      }
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// ─── CLI runner ───────────────────────────────────────────────────────────────

function runCLI(bin, args, cwd = undefined, { ignoreStdin = false } = {}) {
  return new Promise((resolve, reject) => {
    const stdio = ignoreStdin ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'];
    const proc = spawn(bin, args, { env: process.env, stdio, ...(cwd ? { cwd } : {}) });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => {
      if (code !== 0) {
        // Codex CLI may exit 1 due to session-persistence bookkeeping errors
        // even when the model response was successfully written to stdout.
        // Resolve if stdout contains a completed turn; reject otherwise.
        if (stdout.includes('"turn.completed"') || stdout.includes('"item.completed"')) {
          resolve(stdout);
        } else {
          reject(new Error(`${bin} exited ${code}: ${stderr.slice(0, 300)}`));
        }
      } else {
        resolve(stdout);
      }
    });
    proc.on('error', reject);
    setTimeout(() => { proc.kill(); reject(new Error(`${bin} CLI timeout`)); }, 120_000);
  });
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

async function dispatch(method, params) {
  switch (method) {

    case 'generate': {
      const { systemPrompt, userMessage, plugins } = params;
      const sid = BACKEND === 'claude' ? claudeSessionId : codexSessionId;
      log(`generate via ${BACKEND} (sessionId=${sid ?? 'none'})`);

      if (BACKEND === 'claude') {
        return generateClaude(systemPrompt, userMessage, plugins);
      } else {
        return generateCodex(systemPrompt, userMessage, plugins);
      }
    }

    case 'status': {
      const sessionId = BACKEND === 'claude' ? claudeSessionId : codexSessionId;
      return {
        backend:   BACKEND,
        sessionId,
        uptimeMs:  Date.now() - START_TIME,
      };
    }

    case 'reset': {
      claudeSessionId = null;
      codexSessionId  = null;
      try { fs.unlinkSync(CLAUDE_SID); } catch { /* */ }
      try { fs.unlinkSync(CODEX_SID);  } catch { /* */ }
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

function resolvedBinPath(bin) {
  try { return execSync(`which ${bin}`, { encoding: 'utf8' }).trim(); }
  catch { return `${bin} (not found in PATH)`; }
}

async function main() {
  loadState();

  // Log the actual filesystem path of each CLI so it's clear no remote API is used.
  const activeBin  = BACKEND === 'claude' ? CLAUDE_BIN : CODEX_BIN;
  const resolvedPath = resolvedBinPath(activeBin);
  log(`Started. backend=${BACKEND} pid=${process.pid}`);
  log(`CLI binary: ${activeBin} → ${resolvedPath} (local process — no remote API)`);
  if (BACKEND === 'claude') {
    log(`Claude model: ${CLAUDE_MODEL}`);
  } else if (CODEX_MODEL) {
    log(`Codex model override: ${CODEX_MODEL}`);
  }

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
