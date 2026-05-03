/**
 * Codex CLI adapter — uses `codex exec` subprocess.
 * Uses your Codex CLI login (ChatGPT Plus or API key via `codex login`).
 */

import { spawn } from 'child_process';
import { readFileSync, unlinkSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';

const CODEX_BIN = process.env.CODEX_BIN ?? 'codex';

// Read model from ~/.codex/config.toml so ChatGPT-account users get their configured model.
// Override via CODEX_MODEL env var; fall back to o4-mini if config is unreadable.
function readCodexConfigModel() {
  try {
    const cfg = readFileSync(join(homedir(), '.codex', 'config.toml'), 'utf8');
    const m = cfg.match(/^\s*model\s*=\s*"([^"]+)"/m);
    return m?.[1] ?? null;
  } catch { return null; }
}
const CODEX_MODEL = process.env.CODEX_MODEL ?? readCodexConfigModel() ?? 'o4-mini';

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
  const outPath = join(tmpdir(), `seens-codex-${Date.now()}.txt`);
  const fullPrompt = `${systemPrompt}\n${JSON_INSTRUCTION}\n\n---\nUser: ${userMessage}`;

  const args = [
    'exec', fullPrompt,
    '--output-last-message', outPath,
    '--ephemeral',
    '--full-auto',
    '--skip-git-repo-check',
    '--ignore-user-config',  // skip oh-my-codex MCP servers + AGENTS.md (~50s overhead)
    '-C', '/tmp',            // use /tmp as workdir — avoids SIP-protected / in packaged app
    '-m', CODEX_MODEL,
  ];

  try {
    await runCLI(CODEX_BIN, args);
    const text = readFileSync(outPath, 'utf8').trim();
    console.log(`[Codex] model=${CODEX_MODEL ?? '(config default)'}`);
    console.log(`[Codex] raw response (first 400): ${text.slice(0, 400)}`);
    return parseOutput(text);
  } finally {
    try { unlinkSync(outPath); } catch { /* ignore */ }
  }
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
    const proc = spawn(bin, args, { env: process.env, cwd: '/tmp', stdio: ['ignore', 'pipe', 'pipe'] });
    currentProc = proc;
    let stderr = '';

    proc.stderr.on('data', d => stderr += d);
    proc.stdout.on('data', () => {});

    proc.on('close', (code, signal) => {
      if (currentProc === proc) currentProc = null;
      if (code === 0 && !signal) { resolve(); return; }
      reject(new Error(`codex exited ${signal ?? code}: ${stderr.slice(0, 300)}`));
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
