import { RadioPlayer } from './components/radio-player.js';
import { RadioProfile } from './components/radio-profile.js';
import { RadioSettings } from './components/radio-settings.js';

const CLIENT_ID = (() => {
  try {
    const existing = sessionStorage.getItem('seens-client-id');
    if (existing) return existing;
    const created = crypto.randomUUID();
    sessionStorage.setItem('seens-client-id', created);
    return created;
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
})();
window.__seensClientId = CLIENT_ID;
let activeRequestId = null;
window.__seensNewRequestId = function newRequestId() {
  activeRequestId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return activeRequestId;
};

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
  ws = new WebSocket(`${proto}://${location.host}/stream?clientId=${encodeURIComponent(CLIENT_ID)}`);

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
  if (msg.requestId && msg.requestId !== activeRequestId) return;
  switch (msg.type) {
    case 'dj-response':  player.onDJResponse(msg); break;
    case 'dj-tts-ready': player.onDJTTSReady(msg); break;
    case 'queue-prefilled': player.onQueuePrefilled(msg); break;
    case 'now-playing':  player.onNowPlaying(msg.track); break;
    case 'command':      player.onCommand(msg.action); break;
    case 'session-started':
      // Remote clients (the StopWatch/bridge) can start a session without
      // clicking the desktop overlay. Unlock playback and accept the next
      // streamed dj-response as an active session.
      player.started = true;
      player.waitingForInteraction = false;
      // A remote Tune In (watch/bridge) has already supplied the user
      // gesture; do not leave the desktop overlay blocking the active player.
      window._dismissOverlay?.();
      break;
    case 'session-ended':
      player.started = false;
      player.pause();
      break;
  }
}

connectWS();

// ─── Electron tray integration ─────────────────────────────────────────────────
if (window.__electron__?.isElectron) {
  window.__electron__.onTrayTogglePlay(() => player.togglePlay());
  window.__electron__.onTraySkipNext(() => player.skipNext());
}

// ─── Start overlay — tap → DJ generates session plan → speaks → music plays ──
document.getElementById('start-btn').addEventListener('click', async () => {
  const btn = document.getElementById('start-btn');
  btn.textContent = 'Tuning in...';
  btn.disabled = true;

  // Unlock browser autoplay + allow the player to respond to WS messages
  player.waitingForInteraction = false;
  player.started = true;
  const requestId = window.__seensNewRequestId();
  dbg('Tune In', `accepted clientId=${CLIENT_ID} requestId=${requestId}`);

  try {
    const sessionStartRes = await fetch('/api/settings/session/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: CLIENT_ID, requestId }),
    });
    const sessionStart = await sessionStartRes.json().catch(() => ({}));
    dbg('Tune In', `session/start alreadyActive=${!!sessionStart.alreadyActive}`);

    await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: "Start my listening session. Tell me what you have planned and introduce the first track.",
        clientId: CLIENT_ID,
        requestId,
        internal: true,
      }),
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
