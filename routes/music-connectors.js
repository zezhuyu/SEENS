import express from 'express';
import {
  getMusicConnectors,
  getConnectorAuthStatus,
  initConnectorAuth,
  revokeConnectorAuth,
  syncConnectorTracks,
} from '../src/music-connector.js';
import { setPref } from '../src/state.js';

const router = express.Router();

// List all enabled music connectors with live auth status
router.get('/', async (req, res) => {
  const connectors = getMusicConnectors();
  const list = await Promise.all(
    connectors.map(async (p) => {
      const status = await getConnectorAuthStatus(p).catch(() => ({ connected: false }));
      return {
        name:        p.name,
        displayName: p.musicConnector.displayName ?? p.name,
        icon:        p.musicConnector.icon ?? null,
        color:       p.musicConnector.color ?? null,
        authType:    p.musicConnector.authType ?? 'none',
        connected:   status.connected,
        user:        status.user ?? null,
      };
    })
  );
  res.json(list);
});

// Auth status for one connector
router.get('/:name/auth-status', async (req, res) => {
  const plugin = getMusicConnectors().find(p => p.name === req.params.name);
  if (!plugin) return res.status(404).json({ error: 'connector not found' });
  const status = await getConnectorAuthStatus(plugin).catch(() => ({ connected: false }));
  res.json(status);
});

// Initiate OAuth2 flow — returns { authUrl } to open in a popup
router.post('/:name/auth-init', async (req, res) => {
  const plugin = getMusicConnectors().find(p => p.name === req.params.name);
  if (!plugin) return res.status(404).json({ error: 'connector not found' });
  try {
    const result = await initConnectorAuth(plugin);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save API key / personal access token for apikey/token auth types
router.post('/:name/api-key', (req, res) => {
  const { key } = req.body;
  if (!key?.trim()) return res.status(400).json({ error: 'key required' });
  setPref(`plugin.${req.params.name}.api_key`, key.trim());
  res.json({ ok: true });
});

// Clear stored key
router.delete('/:name/api-key', (req, res) => {
  setPref(`plugin.${req.params.name}.api_key`, '');
  res.json({ ok: true });
});

// Disconnect / revoke auth
router.post('/:name/revoke', async (req, res) => {
  const plugin = getMusicConnectors().find(p => p.name === req.params.name);
  if (!plugin) return res.status(404).json({ error: 'connector not found' });
  await revokeConnectorAuth(plugin).catch(() => {});
  res.json({ ok: true });
});

// Manually trigger library sync for one connector
router.post('/:name/sync', async (req, res) => {
  const plugin = getMusicConnectors().find(p => p.name === req.params.name);
  if (!plugin) return res.status(404).json({ error: 'connector not found' });
  try {
    const tracks = await syncConnectorTracks(plugin);
    res.json({ ok: true, count: tracks.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
