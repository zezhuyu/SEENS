import express from 'express';
import { loadPlugins, savePlugins, fetchPluginManifest } from '../src/plugin-runner.js';

const router = express.Router();

// List all plugins
router.get('/', (req, res) => {
  res.json(loadPlugins());
});

// Upsert a plugin (add or replace by name)
router.post('/', (req, res) => {
  const plugin = req.body;
  if (!plugin?.name?.trim()) return res.status(400).json({ error: 'name required' });
  const plugins = loadPlugins();
  const idx = plugins.findIndex(p => p.name === plugin.name);
  if (idx >= 0) plugins[idx] = plugin;
  else plugins.push(plugin);
  savePlugins(plugins);
  res.json({ ok: true });
});

// Accepted baseUrl schemes for plugin install:
//   http://host:port             — HTTP
//   https://host                 — HTTPS
//   unix:///path/to.sock         — Unix domain socket
//   socket:///path/to.sock
//   ipc:///path/to.sock
//   /absolute/path.sock          — bare socket path
//   stdio://node /path/plugin.js — subprocess, JSON-RPC over stdin/stdout
//   stdio:///path/to/executable
function isValidPluginUrl(url) {
  return /^https?:\/\//.test(url) ||
         /^(?:unix|socket|ipc):\/\/\//.test(url) ||
         /^\/.*\.sock(\/|$)/.test(url) ||
         /^stdio:\/\//.test(url);
}

// Install a plugin by fetching its manifest from any supported transport.
router.post('/install-from-url', async (req, res) => {
  const { url } = req.body;
  if (!url?.trim() || !isValidPluginUrl(url.trim())) {
    return res.status(400).json({
      error: 'Valid URL required: http://, https://, unix://, socket://, ipc://, /path/to.sock, or stdio://',
    });
  }

  const baseUrl = url.trim().replace(/\/$/, '');
  let manifest;
  try {
    manifest = await fetchPluginManifest(baseUrl);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  if (!manifest?.name) return res.status(400).json({ error: 'Manifest missing "name" field' });

  if (!manifest.baseUrl) manifest.baseUrl = baseUrl;
  manifest.enabled = manifest.enabled ?? true;
  manifest.endpoints = manifest.endpoints ?? {};

  const plugins = loadPlugins();
  const idx = plugins.findIndex(p => p.name === manifest.name);
  if (idx >= 0) plugins[idx] = manifest;
  else plugins.push(manifest);
  savePlugins(plugins);

  res.json({ ok: true, plugin: manifest });
});

// Write the raw plugins.json content directly.
// Validates that the body is a JSON array before saving.
// The server's fs.watch picks up the write and broadcasts plugins-changed to clients.
router.post('/raw', (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    return res.status(400).json({ error: `Invalid JSON: ${e.message}` });
  }
  if (!Array.isArray(parsed)) return res.status(400).json({ error: 'plugins.json must be a JSON array' });
  savePlugins(parsed);
  res.json({ ok: true, count: parsed.length });
});

// Toggle a plugin enabled/disabled
router.post('/:name/toggle', (req, res) => {
  const plugins = loadPlugins();
  const plugin = plugins.find(p => p.name === req.params.name);
  if (!plugin) return res.status(404).json({ error: 'plugin not found' });
  plugin.enabled = !plugin.enabled;
  savePlugins(plugins);
  res.json({ ok: true, enabled: plugin.enabled });
});

// Delete a plugin
router.delete('/:name', (req, res) => {
  const plugins = loadPlugins().filter(p => p.name !== req.params.name);
  savePlugins(plugins);
  res.json({ ok: true });
});

export default router;
