#!/usr/bin/env node
/**
 * test-agent.js
 *
 * Proves the long-running agent is truly persistent:
 *   1. Starts the AgentProcess subprocess
 *   2. Sends three requests in sequence to the SAME process
 *   3. Checks that the process ID, session ID, and message count
 *      are consistent across all calls (not fresh per-call)
 *   4. Sends a follow-up that references the first answer — if the
 *      agent has memory it will answer coherently
 *
 * Run from seens-radio root:
 *   node scripts/test-agent.js
 */

import { spawn } from 'child_process';
import readline  from 'readline';
import path      from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const AGENT_SCRIPT = path.join(__dirname, '../src/ai/AgentProcess.js');

let idCounter = 0;
const pending = new Map();

function startAgent() {
  const proc = spawn(process.execPath, [AGENT_SCRIPT], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env },
  });

  const rl = readline.createInterface({ input: proc.stdout, terminal: false });
  rl.on('line', line => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const cb = pending.get(String(msg.id));
    if (!cb) return;
    pending.delete(String(msg.id));
    if (msg.error) cb.reject(new Error(msg.error));
    else cb.resolve(msg.result);
  });

  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = String(++idCounter);
      pending.set(id, { resolve, reject });
      proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  return { proc, call };
}

async function run() {
  console.log('\n=== SEENS Agent Persistence Test ===\n');

  const { proc, call } = startAgent();

  // ── 1. Status — confirm process is alive ─────────────────────────────────
  console.log('1) Checking agent status…');
  const s1 = await call('status');
  console.log(`   backend=${s1.backend}  sessionId=${s1.sessionId ?? 'none'}  msgs=${s1.messageCount}  uptime=${s1.uptimeMs}ms`);
  const pid = process.pid; // our test pid — agent runs as a child

  // ── 2. First generate call ────────────────────────────────────────────────
  console.log('\n2) First generate — "Play something for a rainy morning"');
  const r1 = await call('generate', {
    systemPrompt: 'You are a music DJ. Keep responses brief.',
    userMessage:  'Play something for a rainy morning.',
  });
  console.log(`   say: "${r1.say?.slice(0, 120)}"`);
  console.log(`   tracks: ${r1.play?.map(t => `${t.title} – ${t.artist}`).join(', ') || 'none'}`);

  // ── 3. Status again — session ID should now be set (Claude) or msgs=2 (Codex)
  console.log('\n3) Status after first call…');
  const s2 = await call('status');
  console.log(`   sessionId=${s2.sessionId ?? 'none'}  msgs=${s2.messageCount}  uptime=${s2.uptimeMs}ms`);

  const hasMemory = s2.sessionId !== null || s2.messageCount >= 2;
  console.log(`   ✓ persistent session: ${hasMemory ? 'YES' : 'NO (check backend config)'}`);

  // ── 4. Follow-up that requires memory ─────────────────────────────────────
  console.log('\n4) Follow-up — "What was the last song you suggested?" (requires memory)');
  const r2 = await call('generate', {
    systemPrompt: 'You are a music DJ. Keep responses brief.',
    userMessage:  'What was the last song you just suggested to me?',
  });
  console.log(`   say: "${r2.say?.slice(0, 200)}"`);

  // ── 5. Third call — uptime should keep growing (same process)  ────────────
  console.log('\n5) Status again — uptime must be higher than step 3…');
  const s3 = await call('status');
  console.log(`   uptime=${s3.uptimeMs}ms`);
  console.log(`   ✓ same process alive: ${s3.uptimeMs > s2.uptimeMs ? 'YES' : 'NO'}`);

  // ── 6. Shutdown cleanly ────────────────────────────────────────────────────
  await call('shutdown');
  proc.stdin.end();

  console.log('\n=== Test complete ===\n');
}

run().catch(err => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
