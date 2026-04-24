const clients = new Set();

export function register(ws) {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
}

export function broadcast(type, payload) {
  const msg = JSON.stringify({ type, ...payload, ts: Date.now() });
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

export function clientCount() {
  return clients.size;
}
