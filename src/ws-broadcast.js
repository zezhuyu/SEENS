const clients = new Set();
const clientsById = new Map();
const pendingByClientId = new Map();
const PENDING_TTL_MS = 30_000;
const MAX_PENDING_PER_CLIENT = 10;

function normalizeClientId(clientId) {
  if (typeof clientId !== 'string') return null;
  const normalized = clientId.trim();
  return normalized && normalized.length <= 128 ? normalized : null;
}

export function register(ws, clientId = null) {
  const normalizedClientId = normalizeClientId(clientId);
  clients.add(ws);
  if (normalizedClientId) {
    const sockets = clientsById.get(normalizedClientId) ?? new Set();
    // A renderer reconnect can briefly overlap its previous socket. Keep one
    // delivery target per client ID; sending to every stale socket duplicates
    // DJ messages and causes the same TTS intro to be queued repeatedly.
    for (const previous of sockets) {
      if (previous === ws) continue;
      clients.delete(previous);
      previous.close?.(4001, 'superseded-by-new-connection');
    }
    sockets.clear();
    sockets.add(ws);
    clientsById.set(normalizedClientId, sockets);

    const pending = pendingByClientId.get(normalizedClientId) ?? [];
    pendingByClientId.delete(normalizedClientId);
    const now = Date.now();
    for (const message of pending) {
      if (message.expiresAt > now) send([ws], message.type, message.payload);
    }
  }

  ws.on('close', () => {
    clients.delete(ws);
    if (!normalizedClientId) return;
    const sockets = clientsById.get(normalizedClientId);
    sockets?.delete(ws);
    if (sockets?.size === 0) clientsById.delete(normalizedClientId);
  });
}

function send(sockets, type, payload) {
  const msg = JSON.stringify({ type, ...payload, ts: Date.now() });
  let sent = false;
  for (const ws of sockets) {
    if (ws.readyState !== 1) continue;
    ws.send(msg);
    sent = true;
  }
  return sent;
}

export function broadcast(type, payload) {
  return send(clients, type, payload);
}

export function deliver(type, payload, { clientId = null } = {}) {
  const normalizedClientId = normalizeClientId(clientId);
  if (!normalizedClientId) return broadcast(type, payload);
  if (send(clientsById.get(normalizedClientId) ?? [], type, payload)) return true;

  const expiresAt = Date.now() + PENDING_TTL_MS;
  const pending = pendingByClientId.get(normalizedClientId) ?? [];
  pending.push({ type, payload, expiresAt });
  pendingByClientId.set(normalizedClientId, pending.slice(-MAX_PENDING_PER_CLIENT));
  const cleanup = setTimeout(() => {
    const current = pendingByClientId.get(normalizedClientId);
    if (!current) return;
    const fresh = current.filter(message => message.expiresAt > Date.now());
    if (fresh.length) pendingByClientId.set(normalizedClientId, fresh);
    else pendingByClientId.delete(normalizedClientId);
  }, PENDING_TTL_MS);
  cleanup.unref?.();
  return false;
}

export function clientCount() {
  return clients.size;
}
