/**
 * SEENS AI Agent Client.
 *
 * Manages the long-running AgentProcess subprocess.
 * Spawned ONCE at server start — stays alive for the server's lifetime.
 * All generate() calls go to the SAME persistent agent process.
 *
 * Usage:
 *   import { agent } from './AgentClient.js'
 *   await agent.start()                    // called once at boot
 *   const result = await agent.generate(systemPrompt, userMessage)
 */

import { spawn }    from 'child_process';
import path         from 'path';
import readline     from 'readline';
import { fileURLToPath } from 'url';
import fs           from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_SCRIPT = path.join(__dirname, 'AgentProcess.js');
const MCP_CONFIG   = path.join(__dirname, '../../.mcp.json');
const SKILLS_DIR   = path.join(__dirname, '../../skills');

// Load skill files once — they don't change at runtime
function loadSkills() {
  try {
    return fs.readdirSync(SKILLS_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => fs.readFileSync(path.join(SKILLS_DIR, f), 'utf8'));
  } catch { return []; }
}

const SKILLS = loadSkills();

class AgentClient {
  constructor() {
    this._proc     = null;
    this._rl       = null;
    this._pending  = new Map();   // id → { resolve, reject }
    this._idCounter = 0;
    this._ready    = false;
    this._restarting = false;
    this._requestBuffer = [];     // requests queued during restart
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async start() {
    if (this._proc) return;
    this._spawn();
    // Wait for first status ping to confirm alive
    await this._waitReady();
  }

  _spawn() {
    console.log('[AgentClient] Spawning AI agent subprocess…');
    this._proc = spawn(process.execPath, [AGENT_SCRIPT], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env },
    });

    this._proc.on('error', err => {
      console.error('[AgentClient] Spawn error:', err.message);
    });

    this._proc.on('exit', (code, signal) => {
      console.warn(`[AgentClient] Agent exited (code=${code} signal=${signal}) — restarting in 2s`);
      this._ready = false;
      this._proc = null;
      this._rl = null;
      // Reject in-flight requests
      for (const [, { reject }] of this._pending) {
        reject(new Error('Agent restarting'));
      }
      this._pending.clear();
      // Auto-restart
      setTimeout(() => {
        if (!this._proc) this._respawn();
      }, 2000);
    });

    this._rl = readline.createInterface({ input: this._proc.stdout, terminal: false });
    this._rl.on('line', line => this._onLine(line));
  }

  async _respawn() {
    if (this._restarting) return;
    this._restarting = true;
    this._spawn();
    try { await this._waitReady(); } catch { /* will retry on next request */ }
    this._restarting = false;

    // Drain buffered requests
    const buf = this._requestBuffer.splice(0);
    for (const { method, params, resolve, reject } of buf) {
      this._callDirect(method, params).then(resolve).catch(reject);
    }
  }

  async stop() {
    if (!this._proc) return;
    try { await this._callDirect('shutdown', {}); } catch { /* ignore */ }
    this._proc.stdin.end();
    this._proc = null;
    this._ready = false;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Primary entry point — same interface as the old stateless generate().
   * Routes to the persistent agent process.
   */
  async generate(systemPrompt, userMessage) {
    return this._call('generate', {
      systemPrompt,
      userMessage,
      mcpConfigPath: MCP_CONFIG,
      skills: SKILLS,
    });
  }

  async status() {
    return this._call('status', {});
  }

  async reset() {
    return this._call('reset', {});
  }

  // ── internals ───────────────────────────────────────────────────────────────

  async _call(method, params) {
    if (!this._ready) {
      // Buffer if restarting, otherwise fail fast
      if (this._restarting || this._proc) {
        return new Promise((resolve, reject) => {
          this._requestBuffer.push({ method, params, resolve, reject });
        });
      }
      throw new Error('AgentClient not started — call agent.start() first');
    }
    return this._callDirect(method, params);
  }

  _callDirect(method, params) {
    return new Promise((resolve, reject) => {
      if (!this._proc) return reject(new Error('No agent process'));
      const id = String(++this._idCounter);
      this._pending.set(id, { resolve, reject });
      const line = JSON.stringify({ id, method, params }) + '\n';
      this._proc.stdin.write(line);
    });
  }

  _onLine(line) {
    let msg;
    try { msg = JSON.parse(line); }
    catch { return; }

    const id = String(msg.id);
    const pending = this._pending.get(id);
    if (!pending) return;
    this._pending.delete(id);

    if (msg.error) pending.reject(new Error(msg.error));
    else pending.resolve(msg.result);
  }

  async _waitReady(timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await this._callDirect('status', {});
        this._ready = true;
        console.log('[AgentClient] Agent ready ✓');
        return;
      } catch {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    throw new Error('AgentClient: agent failed to start within timeout');
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const agent = new AgentClient();
