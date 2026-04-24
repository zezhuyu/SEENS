export class RadioProfile {
  constructor(container) {
    this.container = container;
    this.render();
    this.load();
  }

  render() {
    this.container.innerHTML = `
      <div class="label">Your Taste Profile</div>

      <div class="card" id="taste-sources">
        <div class="label">Connected Services</div>
        <div id="sources-list" style="display:flex;gap:8px;flex-wrap:wrap">
          <span style="color:var(--text-muted);font-size:12px">Loading...</span>
        </div>
      </div>

      <div class="card" id="taste-stats">
        <div class="label">Library Stats</div>
        <div id="stats-content" style="color:var(--text-muted);font-size:12px">—</div>
      </div>

      <div class="card">
        <div class="label">Taste Profile (raw — editable)</div>
        <pre id="taste-raw" style="font-size:11px;font-family:var(--mono);color:var(--text-dim);white-space:pre-wrap;max-height:300px;overflow-y:auto">Loading...</pre>
      </div>

      <div class="card">
        <div class="label">Recent History</div>
        <div id="history-list"></div>
      </div>
    `;
  }

  async load() {
    try {
      const res = await fetch('/api/taste');
      const { taste, playlists } = await res.json();

      document.getElementById('taste-raw').textContent = taste ?? '(No taste profile yet — run npm run sync)';

      // Stats from playlists
      if (playlists?.length) {
        const bySource = playlists.reduce((acc, t) => {
          acc[t.source] = (acc[t.source] ?? 0) + 1;
          return acc;
        }, {});
        const sources = ['spotify', 'apple', 'youtube'];
        document.getElementById('sources-list').innerHTML = sources.map(s => {
          const count = bySource[s] ?? 0;
          const color = s === 'spotify' ? '#1db954' : s === 'apple' ? '#fc3c44' : '#ff0000';
          return `<span class="badge" style="color:${color};border-color:${color}44">${s} ${count ? `(${count})` : '—'}</span>`;
        }).join('');

        document.getElementById('stats-content').innerHTML = `
          ${playlists.length} unique tracks across ${Object.keys(bySource).length} service(s)
        `;
      }
    } catch (err) {
      document.getElementById('taste-raw').textContent = 'Server not running or no data yet.';
    }
  }
}
