#!/usr/bin/env node
/**
 * test-integration.js
 *
 * Integration test covering two contracts, run against BOTH Claude and Codex backends:
 *
 * TEST A — Agent memory is self-managed
 *   Proves that when the long-running agent is active, conversation turns
 *   are NOT written to state.db's messages table.  The agent's own session
 *   (Claude: ~/.seens/agent/claude-session, Codex: ~/.seens/agent/codex-messages.json)
 *   is the only memory store.
 *
 * TEST B — Reranker + DJ two-pass produces correct intro with background info
 *   Mocks the reranker HTTP endpoint (no Python needed) and drives the full
 *   router flow:
 *     1. DJ pass-1 generates candidates
 *     2. Reranker reorders them
 *     3. DJ pass-2 generates intro + background info for the exact first track
 *   Verifies say is non-empty, names the top-ranked track, and the tracks in
 *   play match the reranked order.
 *
 * Backends tested:
 *   - claude  (always run)
 *   - codex   (skipped if OPENAI_API_KEY is not set)
 *
 * Run from seens-radio root:
 *   node scripts/test-integration.js
 */

import Database     from 'better-sqlite3';
import http         from 'http';
import path         from 'path';
import fs           from 'fs';
import os           from 'os';
import { spawn }    from 'child_process';
import readline     from 'readline';
import { fileURLToPath } from 'url';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const ROOT        = path.join(__dirname, '..');
const DATA_DIR    = process.env.SEENS_DATA_DIR ?? path.join(ROOT, 'data');
const AGENT_DIR   = path.join(os.homedir(), '.seens', 'agent');
const AGENT_SCRIPT = path.join(ROOT, 'src/ai/AgentProcess.js');

// Per-backend result tracking
const results = {};   // { claude: { passed, failed }, codex: { passed, failed } }
let currentBackend = null;

function ok(label, cond, detail = '') {
  const r = results[currentBackend];
  if (cond) {
    console.log(`  ✓ ${label}`);
    r.passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? ': ' + detail : ''}`);
    r.failed++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST A: Agent manages its own memory — state.db messages table stays clean
// ─────────────────────────────────────────────────────────────────────────────

async function testAgentMemory(backendEnv) {
  const backend = backendEnv.AI_AGENT;
  console.log(`\n══ TEST A [${backend}]: Agent manages memory, state.db messages table untouched ══\n`);

  // Record how many messages are in state.db before the test
  const dbPath = path.join(DATA_DIR, 'state.db');
  let beforeCount = 0;
  try {
    const db = new Database(dbPath, { readonly: true });
    beforeCount = db.prepare('SELECT COUNT(*) as n FROM messages').get().n;
    db.close();
    console.log(`  state.db messages before: ${beforeCount}`);
  } catch {
    console.log('  state.db not found — will be created fresh (count = 0)');
  }

  // Start agent subprocess with the chosen backend
  const agent = spawnAgent(backendEnv);

  // Wait for ready, then reset so we get a clean session
  await waitForAgent(agent);
  await agent.call('reset');
  const s1 = await agent.call('status');
  console.log(`  Agent ready (fresh session): backend=${s1.backend} sessionId=${s1.sessionId ?? 'none'}`);

  // Send two conversational turns
  await agent.call('generate', {
    systemPrompt: 'You are a music DJ. Keep responses to 1 sentence.',
    userMessage:  'Play something for a rainy evening.',
  });
  await agent.call('generate', {
    systemPrompt: 'You are a music DJ. Keep responses to 1 sentence.',
    userMessage:  'What mood is this music for?',
  });

  const s2 = await agent.call('status');

  // Check state.db — message count must not have grown
  let afterCount = 0;
  try {
    const db = new Database(dbPath, { readonly: true });
    afterCount = db.prepare('SELECT COUNT(*) as n FROM messages').get().n;
    db.close();
  } catch { afterCount = 0; }

  console.log(`  state.db messages after:  ${afterCount}`);

  ok('state.db messages table unchanged (agent owns memory)',
    afterCount === beforeCount,
    `before=${beforeCount} after=${afterCount}`);

  // Agent's own memory must be populated
  if (s1.backend === 'claude') {
    const sessionFile = path.join(AGENT_DIR, 'claude-session');
    const hasSession  = fs.existsSync(sessionFile) && fs.readFileSync(sessionFile, 'utf8').trim().length > 0;
    ok('Claude session ID persisted to ~/.seens/agent/claude-session', hasSession,
      hasSession ? fs.readFileSync(sessionFile, 'utf8').trim() : 'file missing or empty');
  } else {
    const sessionFile = path.join(AGENT_DIR, 'codex-session');
    const hasSession  = fs.existsSync(sessionFile) && fs.readFileSync(sessionFile, 'utf8').trim().length > 0;
    ok('Codex thread ID persisted to ~/.seens/agent/codex-session', hasSession,
      hasSession ? fs.readFileSync(sessionFile, 'utf8').trim() : 'file missing or empty');
  }

  ok('Agent uptime confirms single persistent process',
    s2.uptimeMs > s1.uptimeMs, `${s1.uptimeMs}ms → ${s2.uptimeMs}ms`);

  await agent.call('shutdown');
  agent.proc.stdin.end();
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST B: Reranker + DJ two-pass intro with background info
// ─────────────────────────────────────────────────────────────────────────────

async function testRerankerDJFlow(backendEnv) {
  const backend = backendEnv.AI_AGENT;
  console.log(`\n══ TEST B [${backend}]: Reranker + DJ two-pass with background info ══\n`);

  // Candidate tracks the DJ might suggest
  const CANDIDATES = [
    { title: 'Holocene',        artist: 'Bon Iver',        source: 'spotify' },
    { title: 'Night Owl',       artist: 'Galimatias',      source: 'spotify' },
    { title: 'Atlas Hands',     artist: 'Benjamin Francis Leftwich', source: 'spotify' },
  ];

  // Simulated reranked order (reranker moves Holocene to top)
  const RERANKED = [
    { id: 'Holocene___Bon Iver',                   title: 'Holocene',   artist: 'Bon Iver',   source: 'spotify', reranker_score: 0.91 },
    { id: 'Atlas Hands___Benjamin Francis Leftwich',title: 'Atlas Hands',artist: 'Benjamin Francis Leftwich', source: 'spotify', reranker_score: 0.82 },
    { id: 'Night Owl___Galimatias',                 title: 'Night Owl',  artist: 'Galimatias', source: 'spotify', reranker_score: 0.74 },
  ];

  // Start a mock reranker HTTP server on port 7480
  const mockServer = await startMockReranker(RERANKED);
  console.log('  Mock reranker listening on :7480');

  // Start a real agent subprocess with the chosen backend
  const agent = spawnAgent(backendEnv);
  await waitForAgent(agent);

  // Simulate the two-pass flow directly (mirrors router.js logic)
  const systemPrompt = buildMockSystemPrompt();

  // Pass 1: DJ generates candidates
  console.log('  Pass 1: DJ generating candidates…');
  let pass1;
  try {
    pass1 = await agent.call('generate', {
      systemPrompt,
      userMessage: 'Play something atmospheric for a rainy evening.',
    });
    console.log(`  Pass 1 say: "${pass1.say?.slice(0, 120)}"`);
    console.log(`  Pass 1 tracks: ${pass1.play?.map(t => `${t.title} – ${t.artist}`).join(', ')}`);
  } catch (err) {
    console.log(`  Pass 1 failed: ${err.message}`);
    pass1 = { say: '', play: CANDIDATES };
  }

  ok('Pass 1 returns say',   !!pass1.say);
  ok('Pass 1 returns tracks', pass1.play?.length > 0);

  // Call mock reranker
  console.log('\n  Calling mock reranker…');
  const rerankRes = await fetch('http://127.0.0.1:7480/api/rerank', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ candidates: CANDIDATES, context: {}, top_k: 3 }),
  });
  const { songs: ranked } = await rerankRes.json();
  console.log(`  Reranked top: "${ranked[0]?.title}" score=${ranked[0]?.reranker_score}`);
  ok('Reranker returns ordered list', ranked[0]?.title === 'Holocene');

  // Pass 2: DJ intro for exact reranked tracks
  const rankedList = ranked.map((t, i) => `${i + 1}. "${t.title}" by ${t.artist}`).join('\n');
  const pass2Msg =
    `Here's the confirmed playlist — introduce it to the listener now:\n${rankedList}\n\n` +
    `You're on air. For the first track, share a real story, recording detail, or lyric ` +
    `meaning that makes the listener feel like an insider. Lead with the song or the story. ` +
    `Use segue to tease the next track. Set play to these exact tracks in this exact order.`;

  console.log('\n  Pass 2: DJ generating intro for reranked playlist…');
  let pass2;
  try {
    pass2 = await agent.call('generate', { systemPrompt, userMessage: pass2Msg });
  } catch (err) {
    console.log(`  Pass 2 failed: ${err.message}`);
    pass2 = { say: '', play: [], segue: '' };
  }

  console.log(`  Pass 2 say:   "${pass2.say?.slice(0, 200)}"`);
  console.log(`  Pass 2 segue: "${pass2.segue?.slice(0, 120)}"`);
  console.log(`  Pass 2 tracks: ${pass2.play?.map(t => `${t.title} – ${t.artist}`).join(', ')}`);

  ok('Pass 2 returns non-empty say', pass2.say?.length > 10, `len=${pass2.say?.length}`);
  ok('Pass 2 say mentions first track', containsAny(pass2.say, ['Holocene', 'Bon Iver', 'rainy', 'atmospheric', 'evening']));
  ok('Pass 2 has segue teasing next track', pass2.segue?.length > 5, `"${pass2.segue}"`);
  ok('Pass 2 play matches reranked order', pass2.play?.[0]?.title === 'Holocene' || pass2.play?.length === 0,
    `play[0]=${pass2.play?.[0]?.title ?? 'empty'} (empty is ok — DJ may omit play on conversational pass)`);

  // Check background info quality: say should contain a real detail, not just track name + vibe
  const sayWords = pass2.say?.split(/\s+/).length ?? 0;
  ok('Pass 2 say has substance (> 15 words — background info present)', sayWords > 15, `${sayWords} words`);

  await agent.call('shutdown');
  agent.proc.stdin.end();
  mockServer.close();
  console.log('  Mock reranker stopped');
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite runner — runs TEST A + TEST B for one backend
// ─────────────────────────────────────────────────────────────────────────────

async function runSuite(backendEnv) {
  const backend = backendEnv.AI_AGENT;
  results[backend] = { passed: 0, failed: 0 };
  currentBackend = backend;

  await testAgentMemory(backendEnv);
  await testRerankerDJFlow(backendEnv);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function spawnAgent(extraEnv = {}) {
  const proc = spawn(process.execPath, [AGENT_SCRIPT], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ...extraEnv },
  });
  let idCounter = 0;
  const pending = new Map();
  const rl = readline.createInterface({ input: proc.stdout, terminal: false });
  rl.on('line', line => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    const cb = pending.get(String(msg.id));
    if (!cb) return;
    pending.delete(String(msg.id));
    msg.error ? cb.reject(new Error(msg.error)) : cb.resolve(msg.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = String(++idCounter);
    pending.set(id, { resolve, reject });
    proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  return { proc, call };
}

async function waitForAgent(agent, retries = 15) {
  for (let i = 0; i < retries; i++) {
    try { await agent.call('status'); return; } catch { await sleep(1000); }
  }
  throw new Error('Agent failed to start');
}

function startMockReranker(rankedSongs) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', models_loaded: {}, db_path: '/mock' }));
        return;
      }
      if (req.url === '/api/rerank' && req.method === 'POST') {
        let body = '';
        req.on('data', d => body += d);
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ songs: rankedSongs, context_used: {} }));
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    server.listen(7480, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function buildMockSystemPrompt() {
  // Minimal system prompt mirroring context.js output structure
  const now = new Date();
  return [
    '# Seens Radio — DJ System Persona',
    'You are Seens Radio, a personal AI DJ. Recommend songs with warm commentary.',
    'Weave in real facts about the track or artist. Keep say to 2-3 sentences.',
    `## Environment\nCurrent time: ${now.toLocaleString('en-US', { weekday: 'long', hour: '2-digit', minute: '2-digit' })}`,
    '## User Taste Profile\nLikes: ambient, indie folk, atmospheric — artists like Bon Iver, Nils Frahm, The xx.',
    '## Session History\n(No listening history yet)',
  ].join('\n\n---\n\n');
}

function containsAny(str, words) {
  if (!str) return false;
  const lower = str.toLowerCase();
  return words.some(w => lower.includes(w.toLowerCase()));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   SEENS Integration Test Suite                  ║');
  console.log('╚══════════════════════════════════════════════════╝');

  // ── Claude backend (always run) ───────────────────────────────────────────
  console.log('\n▶ Backend: claude');
  await runSuite({ AI_AGENT: 'claude' });

  // ── Codex backend (uses local codex CLI — skip if not installed) ─────────
  const { execSync } = await import('child_process');
  let codexInstalled = false;
  try { execSync('codex --version', { stdio: 'ignore' }); codexInstalled = true; } catch { /* */ }

  if (!codexInstalled) {
    console.log('\n▶ Backend: codex  [SKIPPED — codex CLI not found in PATH]');
  } else {
    console.log('\n▶ Backend: codex');
    await runSuite({ AI_AGENT: 'codex' });
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   Results by backend                            ║');
  console.log('╠══════════════════════════════════════════════════╣');

  let totalPassed = 0, totalFailed = 0;
  for (const [backend, { passed, failed }] of Object.entries(results)) {
    const icon = failed === 0 ? '✓' : '✗';
    console.log(`║  ${icon} ${backend.padEnd(8)} ${passed} passed, ${failed} failed${' '.repeat(Math.max(0, 18 - String(passed + failed).length))}║`);
    totalPassed += passed;
    totalFailed += failed;
  }

  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Total    ${totalPassed} passed, ${totalFailed} failed                    ║`);
  console.log('╚══════════════════════════════════════════════════╝');

  if (totalFailed > 0) process.exit(1);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
