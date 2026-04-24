/**
 * Claude Code CLI adapter — uses `claude -p` subprocess.
 * Uses your Claude Code subscription (Max/Pro), no API key needed.
 *
 * Docs: claude --help | grep -A2 "\-p"
 *   claude -p "prompt" --output-format json --json-schema '{...}' --append-system-prompt "..."
 */

import { spawn } from 'child_process';

const CLAUDE_BIN   = process.env.CLAUDE_BIN   ?? 'claude';
// Use a fast model for DJ responses — haiku is ~5x faster than sonnet
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? 'claude-haiku-4-5';

const DJ_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    say:    { type: 'string' },
    play:   { type: 'array', items: { type: 'object' } },
    reason: { type: 'string' },
    segue:  { type: 'string' },
  },
  required: ['say', 'play', 'reason', 'segue'],
});

// Returns: { say, play: [{title, artist, source}], reason, segue }
export async function generate(systemPrompt, userMessage) {
  const args = [
    '-p', userMessage,
    '--output-format', 'json',
    '--json-schema', DJ_SCHEMA,
    '--append-system-prompt', systemPrompt,
    '--no-session-persistence',
    '--model', CLAUDE_MODEL,
  ];

  const raw = await runCLI(CLAUDE_BIN, args, null);
  return parseClaudeOutput(raw);
}

function parseClaudeOutput(raw) {
  // claude --output-format json emits a single JSON object with structured_output field
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed.structured_output) return normalize(parsed.structured_output);
    // Fallback: try parsing result field as JSON
    if (parsed.result) {
      try { return normalize(JSON.parse(parsed.result)); } catch { /* fall through */ }
    }
    return normalize(parsed);
  } catch {
    // Try to extract any JSON object from the raw output
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try { return normalize(JSON.parse(match[0])); } catch { /* fall through */ }
    }
    return { say: raw.trim(), play: [], reason: '', segue: '' };
  }
}

function normalize(obj) {
  return {
    say:    String(obj.say ?? ''),
    play:   Array.isArray(obj.play) ? obj.play.map(normalizeTrack) : [],
    reason: String(obj.reason ?? ''),
    segue:  String(obj.segue ?? ''),
  };
}

// Claude sometimes uses "track" or "name" instead of "title" — normalize all variants
function normalizeTrack(t) {
  return {
    title:  String(t.title ?? t.track ?? t.name ?? t.song ?? ''),
    artist: String(t.artist ?? t.by ?? ''),
    source: String(t.source ?? 'any'),
    uri:    t.uri ?? null,
  };
}

function runCLI(bin, args, stdin) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { env: process.env });
    let stdout = '', stderr = '';

    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);

    if (stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 300)}`));
      } else {
        resolve(stdout);
      }
    });
    proc.on('error', reject);

    // 60s timeout for AI response
    setTimeout(() => { proc.kill(); reject(new Error('claude CLI timeout')); }, 60_000);
  });
}
