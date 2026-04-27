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

      <!-- API Keys -->
      <div class="card">
        <div class="label">API Keys</div>
        <p style="color:var(--text-dim);font-size:12px;margin-bottom:14px">
          Saved to .env and applied immediately — no restart needed. Leave a field blank to keep the existing value.
        </p>

        <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">Text-to-Speech</div>
        <select id="key-TTS_PROVIDER" style="margin-bottom:8px">
          <option value="say">macOS say (free, built-in)</option>
          <option value="elevenlabs">ElevenLabs (realistic, free tier)</option>
          <option value="openai">OpenAI TTS</option>
        </select>
        <input type="password" id="key-ELEVENLABS_API_KEY" placeholder="ElevenLabs API key" autocomplete="off" style="margin-bottom:6px;width:100%;box-sizing:border-box">
        <input type="text" id="key-ELEVENLABS_VOICE_ID" placeholder="ElevenLabs Voice ID" autocomplete="off" style="margin-bottom:8px;width:100%;box-sizing:border-box">
        <input type="password" id="key-OPENAI_API_KEY" placeholder="OpenAI API key (for TTS)" autocomplete="off" style="margin-bottom:14px;width:100%;box-sizing:border-box">

        <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px">Music Services</div>
        <input type="text" id="key-SPOTIFY_CLIENT_ID" placeholder="Spotify Client ID" autocomplete="off" style="margin-bottom:6px;width:100%;box-sizing:border-box">
        <input type="text" id="key-YOUTUBE_CLIENT_ID" placeholder="YouTube Client ID" autocomplete="off" style="margin-bottom:6px;width:100%;box-sizing:border-box">
        <input type="password" id="key-YOUTUBE_CLIENT_SECRET" placeholder="YouTube Client Secret" autocomplete="off" style="margin-bottom:12px;width:100%;box-sizing:border-box">

        <button class="primary" id="btn-save-api-keys">Save API Keys</button>
        <div id="api-keys-status" style="margin-top:8px;font-size:11px;color:var(--text-muted)"></div>
      </div>

      <!-- Plugin Manifest Upload -->
      <div class="card">
        <div class="label">Install Plugin</div>
        <p style="color:var(--text-dim);font-size:12px;margin-bottom:10px">
          Paste a plugin manifest JSON or load a manifest.json file. Supports http://, stdio://, and cli:// transports.
        </p>
        <textarea id="plugin-manifest-input" rows="6" placeholder='{"name":"my-plugin","description":"...","baseUrl":"cli:///path/to/binary","endpoints":{}}' style="width:100%;box-sizing:border-box;font-family:monospace;font-size:11px;resize:vertical;margin-bottom:8px"></textarea>
        <div style="display:flex;gap:8px;margin-bottom:8px">
          <button class="ghost" id="btn-load-manifest-file" style="flex:1">Load manifest.json</button>
          <button class="primary" id="btn-install-manifest" style="flex:1">Install Plugin</button>
        </div>
        <input type="file" id="manifest-file-input" accept=".json,application/json" style="display:none">
        <div id="plugin-install-status" style="font-size:11px;color:var(--text-muted)"></div>
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

    // API Keys — save only fields the user actually typed into
    document.getElementById('btn-save-api-keys').addEventListener('click', async () => {
      const status = document.getElementById('api-keys-status');
      const keyIds = [
        'TTS_PROVIDER', 'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID',
        'OPENAI_API_KEY', 'SPOTIFY_CLIENT_ID', 'YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET',
      ];
      const payload = {};
      // TTS_PROVIDER comes from a select, always include it
      const providerEl = document.getElementById('key-TTS_PROVIDER');
      if (providerEl) payload['TTS_PROVIDER'] = providerEl.value;
      // Text inputs: only include if user typed something (non-empty)
      for (const key of keyIds.filter(k => k !== 'TTS_PROVIDER')) {
        const el = document.getElementById(`key-${key}`);
        if (el && el.value.trim()) payload[key] = el.value.trim();
      }
      try {
        const res = await fetch('/api/settings/env-keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        status.textContent = data.updated?.length
          ? `Saved: ${data.updated.join(', ')}`
          : 'No changes (fields were empty)';
        // Clear inputs after save so placeholders reflect "set but not shown" state
        for (const key of keyIds.filter(k => k !== 'TTS_PROVIDER')) {
          const el = document.getElementById(`key-${key}`);
          if (el) el.value = '';
        }
        await this.loadApiKeyStatus();
      } catch (err) {
        status.textContent = `Error: ${err.message}`;
      }
    });

    // Plugin manifest upload
    document.getElementById('btn-load-manifest-file').addEventListener('click', () => {
      document.getElementById('manifest-file-input').click();
    });

    document.getElementById('manifest-file-input').addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        document.getElementById('plugin-manifest-input').value = ev.target.result;
      };
      reader.readAsText(file);
      e.target.value = ''; // reset so same file can be re-loaded
    });

    document.getElementById('btn-install-manifest').addEventListener('click', async () => {
      const status = document.getElementById('plugin-install-status');
      const raw = document.getElementById('plugin-manifest-input').value.trim();
      if (!raw) { status.textContent = 'Paste a manifest JSON first.'; return; }
      let manifest;
      try { manifest = JSON.parse(raw); }
      catch (e) { status.textContent = `Invalid JSON: ${e.message}`; return; }
      try {
        const res = await fetch('/api/plugins/install-from-manifest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(manifest),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        status.textContent = `✓ Plugin "${data.plugin.name}" installed.`;
        document.getElementById('plugin-manifest-input').value = '';
      } catch (err) {
        status.textContent = `Error: ${err.message}`;
      }
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
    await this.loadApiKeyStatus();
  }

  async loadApiKeyStatus() {
    try {
      const res = await fetch('/api/settings/env-keys');
      const keys = await res.json();

      // Update TTS_PROVIDER select
      const providerEl = document.getElementById('key-TTS_PROVIDER');
      if (providerEl && keys['TTS_PROVIDER']) {
        for (const opt of providerEl.options) {
          if (opt.value === keys['TTS_PROVIDER']) opt.selected = true;
        }
      }

      // Update placeholder text for secret fields to indicate set/not-set state
      const placeholders = {
        'ELEVENLABS_API_KEY':    ['ElevenLabs API key', 'ElevenLabs API key (currently set — enter new value to change)'],
        'ELEVENLABS_VOICE_ID':   ['ElevenLabs Voice ID', 'ElevenLabs Voice ID (currently set)'],
        'OPENAI_API_KEY':        ['OpenAI API key (for TTS)', 'OpenAI API key (currently set — enter new value to change)'],
        'SPOTIFY_CLIENT_ID':     ['Spotify Client ID', 'Spotify Client ID (currently set)'],
        'YOUTUBE_CLIENT_ID':     ['YouTube Client ID', 'YouTube Client ID (currently set)'],
        'YOUTUBE_CLIENT_SECRET': ['YouTube Client Secret', 'YouTube Client Secret (currently set — enter new value to change)'],
      };
      for (const [key, [empty, filled]] of Object.entries(placeholders)) {
        const el = document.getElementById(`key-${key}`);
        if (el) el.placeholder = keys[key] ? filled : empty;
      }
    } catch { /* server not ready */ }
  }
}
