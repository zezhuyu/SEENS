import { RadioPlayer } from './components/radio-player.js';
import { RadioProfile } from './components/radio-profile.js';
import { RadioSettings } from './components/radio-settings.js';

// ─── Debug logger (press D to toggle panel) ───────────────────────────────────
const debugPanel = document.getElementById('debug-panel');
window.dbg = function dbg(label, data) {
  const val = data === undefined ? '' : (typeof data === 'object' ? JSON.stringify(data) : data);
  const line = `[${new Date().toLocaleTimeString()}] ${label} ${val}`;
  console.log(line);
  const el = document.createElement('div');
  el.textContent = line;
  debugPanel.appendChild(el);
  debugPanel.scrollTop = debugPanel.scrollHeight;
};
export const dbg = window.dbg;
document.addEventListener('keydown', e => {
  if ((e.key === 'd' || e.key === 'D') && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'INPUT') {
    debugPanel.style.display = debugPanel.style.display === 'none' ? 'block' : 'none';
  }
});

// ─── View routing ──────────────────────────────────────────────────────────────
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`view-${name}`).classList.add('active');
  document.querySelector(`[data-view="${name}"]`).classList.add('active');
}
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

// ─── Mount components ──────────────────────────────────────────────────────────
const player   = new RadioPlayer(document.getElementById('view-player'));
const profile  = new RadioProfile(document.getElementById('view-profile'));
const settings = new RadioSettings(document.getElementById('view-settings'));

// ─── WebSocket ─────────────────────────────────────────────────────────────────
let ws, reconnectDelay = 1000;

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/stream`);

  ws.addEventListener('open', () => {
    reconnectDelay = 1000;
    player.setConnected(true);
    dbg('WS', 'connected');
  });

  ws.addEventListener('message', e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    dbg('WS ←', `type=${msg.type}` + (msg.firstTrack ? ` videoId=${msg.firstTrack.videoId ?? 'NULL'} previewUrl=${msg.firstTrack.previewUrl ?? 'NULL'}` : ''));
    handleWS(msg);
  });

  ws.addEventListener('close', () => {
    player.setConnected(false);
    dbg('WS', 'disconnected — reconnecting');
    setTimeout(connectWS, reconnectDelay = Math.min(reconnectDelay * 1.5, 30_000));
  });

  ws.addEventListener('error', e => dbg('WS ERROR', e.message));
}

function handleWS(msg) {
  switch (msg.type) {
    case 'dj-response':  player.onDJResponse(msg); break;
    case 'now-playing':  player.onNowPlaying(msg.track); break;
    case 'command':      player.onCommand(msg.action); break;
  }
}

connectWS();

// ─── Start overlay — tap → DJ generates session plan → speaks → music plays ──
document.getElementById('start-btn').addEventListener('click', async () => {
  const btn = document.getElementById('start-btn');
  btn.textContent = 'Tuning in...';
  btn.disabled = true;

  // Unlock browser autoplay + allow the player to respond to WS messages
  player.waitingForInteraction = false;
  player.started = true;

  try {
    // Clear stale queue so we always get a fresh plan, not leftovers from last session
    await fetch('/api/settings/queue/clear', { method: 'POST' });

    await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: "Start my listening session. Tell me what you have planned and introduce the first track." }),
    });
    // dj-response arrives via WS → overlay dismissed → DJ speaks → music plays
  } catch {
    document.getElementById('start-overlay').classList.add('hidden');
    player.skipNext();
  }
});

// Hide overlay as soon as the DJ starts speaking or music loads
function dismissOverlay() {
  document.getElementById('start-overlay').classList.add('hidden');
}
window._dismissOverlay = dismissOverlay;

// ─── Service Worker ────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(console.warn);
}
