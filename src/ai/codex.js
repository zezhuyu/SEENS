/**
 * Codex CLI adapter — uses `codex exec` subprocess.
 * Uses your Codex CLI login (ChatGPT Plus or API key via `codex login`).
 */

import { spawn, execSync } from 'child_process';
import { homedir }         from 'os';
import { mkdirSync, existsSync } from 'fs';
import { join }            from 'path';

// Codex requires cwd to be a git repo for workspace-write sandbox.
// In read-only sandbox it reads stdin before responding (blocking).
const CODEX_WORKSPACE = join(homedir(), '.seens', 'codex-workspace');
mkdirSync(CODEX_WORKSPACE, { recursive: true });
if (!existsSync(join(CODEX_WORKSPACE, '.git'))) {
  try {
    execSync('git init', { cwd: CODEX_WORKSPACE, stdio: 'ignore' });
    execSync('git config user.email "seens@local"', { cwd: CODEX_WORKSPACE, stdio: 'ignore' });
    execSync('git config user.name "SEENS"', { cwd: CODEX_WORKSPACE, stdio: 'ignore' });
  } catch { /* git unavailable */ }
}

const CODEX_BIN   = process.env.CODEX_BIN   ?? 'codex';
// Default to a cheaper local Codex CLI model for this app.
// Override via CODEX_MODEL env var if you need a different Codex-capable model.
const CODEX_MODEL = process.env.CODEX_MODEL ?? 'gpt-5.4-mini';

let currentProc = null;

export function cancelCurrentCall() {
  if (currentProc) {
    try { currentProc.kill('SIGTERM'); } catch {}
    currentProc = null;
  }
}

const JSON_INSTRUCTION = `
Respond ONLY with a single JSON object (no markdown, no extra text) with these fields:
{
  "say": "<string — what you say aloud, never empty>",
  "play": [{"title":"<string>","artist":"<string>","source":"<spotify|apple|youtube|any>"}],
  "reason": "<string>",
  "segue": "<string>",
  "pluginCall": {"plugin":"<name>","endpoint":"<name>","params":{}} | null,
  "pluginAction": {
    "type": "play | rest-piece | info",
    "title": "<string>",
    "audioUrl": "<copy exactly from plugin result — for type=play>",
    "imageUrl": "<copy exactly from plugin result>",
    "text": "<description or summary — for type=rest-piece>",
    "sourceUrl": "<original URL — optional>"
  } | null
}`;

export async function generate(systemPrompt, userMessage) {
  const fullPrompt = `${systemPrompt}\n${JSON_INSTRUCTION}\n\n---\nUser: ${userMessage}`;

  // --json: JSONL output mode — single-shot, non-conversational (no stdin reads).
  // --full-auto: sets approval=never — without it codex reads stdin to ask for approval.
  // --skip-git-repo-check: CODEX_WORKSPACE is a fresh git repo, may not be in trust list.
  const args = ['exec', fullPrompt, '--json', '--full-auto', '--skip-git-repo-check',
                '--ignore-user-config'];  // skip ~/.codex/config.toml MCP servers (approval prompts)
  if (CODEX_MODEL) args.push('-m', CODEX_MODEL);

  const jsonl = await runCLI(CODEX_BIN, args);

  // Extract agent message from item.completed JSONL event
  let resultText = null;
  for (const line of jsonl.split('\n')) {
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    if (evt.type === 'item.completed' && evt.item?.type === 'agent_message') {
      resultText = evt.item.text ?? null;
    }
  }

  console.log(`[Codex] model=${CODEX_MODEL} result (first 400): ${(resultText ?? '').slice(0, 400)}`);
  return parseOutput(resultText ?? '');
}

function parseOutput(text) {
  const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  try {
    return normalize(JSON.parse(cleaned));
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return normalize(JSON.parse(match[0])); } catch { /* fall through */ }
    }
    return { say: cleaned, play: [], reason: '', segue: '' };
  }
}

function normalize(obj) {
  return {
    say:          String(obj.say ?? ''),
    play:         Array.isArray(obj.play) ? obj.play.map(normalizeTrack) : [],
    reason:       String(obj.reason ?? ''),
    segue:        String(obj.segue ?? ''),
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

function runCLI(bin, args) {
  return new Promise((resolve, reject) => {
    // CODEX_WORKSPACE: a git repo so codex gets workspace-write sandbox.
    // Non-git dirs → read-only sandbox → codex reads stdin before responding.
    const proc = spawn(bin, args, { env: process.env, cwd: CODEX_WORKSPACE, stdio: ['ignore', 'pipe', 'pipe'] });
    currentProc = proc;
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);

    proc.on('close', (code, signal) => {
      if (currentProc === proc) currentProc = null;
      // Resolve if we got a valid response even on non-zero exit (session bookkeeping errors)
      if (code === 0 || stdout.includes('"item.completed"')) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`codex exited ${signal ?? code}: ${stderr.slice(0, 300)}`));
      }
    });
    proc.on('error', err => {
      if (currentProc === proc) currentProc = null;
      reject(err);
    });

    setTimeout(() => {
      if (currentProc === proc) currentProc = null;
      proc.kill();
      reject(new Error('codex CLI timeout'));
    }, 120_000);
  });
}
