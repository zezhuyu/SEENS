export class RadioSettings {
  constructor(container) {
    this.container = container;
    this.render();
    this.load();
  }

  render() {
    this.container.innerHTML = `
      <!-- AI Agent switcher -->
      <div class="card">
        <div class="label">AI Agent</div>
        <p style="color:var(--text-dim);font-size:12px;margin-bottom:12px">
          Both run as local CLI subprocesses — no API billing. Uses your Claude Code (Max/Pro) and Codex (ChatGPT Plus) subscriptions.
        </p>
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <button class="agent-btn" data-agent="claude" style="flex:1">
            <span class="badge badge-claude">Claude Code</span>
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">claude -p · Max subscription</div>
          </button>
          <button class="agent-btn" data-agent="codex" style="flex:1">
            <span class="badge badge-codex">Codex CLI</span>
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px">codex exec · ChatGPT Plus</div>
          </button>
        </div>
        <div id="agent-status" style="font-size:11px;color:var(--text-muted)">Loading...</div>
      </div>

      <!-- TTS Voice -->
      <div class="card">
        <div class="label">DJ Voice (macOS TTS)</div>
        <select id="voice-select" style="margin-bottom:8px">
          <option value="Samantha">Samantha (default)</option>
          <option value="Alex">Alex</option>
          <option value="Karen">Karen</option>
          <option value="Daniel">Daniel (UK)</option>
          <option value="Moira">Moira (Irish)</option>
          <option value="Tessa">Tessa (South African)</option>
          <option value="Rishi">Rishi (Indian)</option>
          <option value="Fiona">Fiona (Scottish)</option>
        </select>
        <button class="ghost" id="btn-test-voice">Test Voice</button>
      </div>

      <!-- Music Services -->
      <div class="card">
        <div class="label">Music Services</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <span style="font-size:13px;color:#1db954">Spotify</span>
            <button class="ghost" id="btn-spotify">Connect</button>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between">
            <span style="font-size:13px;color:#fc3c44">Apple Music</span>
            <button class="ghost" id="btn-apple">Connect</button>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between">
            <span style="font-size:13px;color:#ff0000">YouTube</span>
            <button class="ghost" id="btn-youtube">Connect</button>
          </div>
        </div>
      </div>

      <!-- Sync -->
      <div class="card">
        <div class="label">Music Sync</div>
        <p style="color:var(--text-dim);font-size:12px;margin-bottom:10px">
          Sync your playlists and listening history to update your taste profile.
        </p>
        <button class="primary" id="btn-sync">Sync Now</button>
        <div id="sync-status" style="margin-top:8px;font-size:11px;color:var(--text-muted)"></div>
      </div>

      <!-- Mood -->
      <div class="card">
        <div class="label">Energy / Mood Override</div>
        <select id="energy-select">
          <option value="auto">Auto (time-based)</option>
          <option value="high">High energy</option>
          <option value="medium">Medium</option>
          <option value="low">Chill / low</option>
          <option value="focus">Focus (instrumental)</option>
        </select>
      </div>
    `;

    this.bindEvents();
  }

  bindEvents() {
    // Agent switcher
    this.container.querySelectorAll('.agent-btn').forEach(btn => {
      btn.addEventListener('click', () => this.switchAgent(btn.dataset.agent));
    });

    // Voice
    document.getElementById('btn-test-voice').addEventListener('click', async () => {
      const voice = document.getElementById('voice-select').value;
      await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `Test voice: say "Hello, I am ${voice}, your personal radio DJ." using voice ${voice}` }),
      });
    });

    document.getElementById('voice-select').addEventListener('change', (e) => {
      fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 'tts.voice': e.target.value }),
      });
    });

    // Music service OAuth
    document.getElementById('btn-spotify').addEventListener('click', () => {
      window.open('/api/auth/spotify', 'spotify-oauth', 'width=500,height=700');
    });
    document.getElementById('btn-youtube').addEventListener('click', () => {
      window.open('/api/auth/youtube', 'youtube-oauth', 'width=500,height=700');
    });

    // Sync
    document.getElementById('btn-sync').addEventListener('click', async () => {
      const status = document.getElementById('sync-status');
      status.textContent = 'Syncing...';
      try {
        await fetch('/api/sync', { method: 'POST' });
        status.textContent = 'Sync started — check server logs for progress.';
      } catch {
        status.textContent = 'Error starting sync.';
      }
    });

    // Energy
    document.getElementById('energy-select').addEventListener('change', (e) => {
      fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 'mood.energy': e.target.value }),
      });
    });
  }

  async switchAgent(agent) {
    const status = document.getElementById('agent-status');
    status.textContent = `Switching to ${agent}...`;
    try {
      const res = await fetch('/api/settings/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      this.setActiveAgent(agent);
      status.textContent = `Active: ${agent}`;
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
    }
  }

  setActiveAgent(agent) {
    this.container.querySelectorAll('.agent-btn').forEach(btn => {
      btn.style.background = btn.dataset.agent === agent ? 'var(--surface2)' : '';
      btn.style.border = btn.dataset.agent === agent ? '1px solid var(--accent)' : '';
    });
  }

  async load() {
    try {
      const res = await fetch('/api/settings');
      const s = await res.json();
      document.getElementById('agent-status').textContent = `Active: ${s.agent}`;
      this.setActiveAgent(s.agent);
      const vs = document.getElementById('voice-select');
      if (vs) { for (const opt of vs.options) { if (opt.value === s.voice) opt.selected = true; } }
      const es = document.getElementById('energy-select');
      if (es) { for (const opt of es.options) { if (opt.value === s.energy) opt.selected = true; } }
    } catch { /* server not ready */ }
  }
}
