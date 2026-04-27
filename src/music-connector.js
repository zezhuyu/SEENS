/**
 * Custom music service connector manager.
 *
 * A music connector is a plugin whose manifest includes a `musicConnector` section:
 *
 *   "musicConnector": {
 *     "displayName": "My Service",  // shown in Settings UI
 *     "icon": "🎵",                 // optional emoji shown in the icon box
 *     "color": "#1db954",           // optional accent color for the icon box
 *     "authType": "oauth2",         // "oauth2" | "apikey" | "token" | "none"
 *     "endpoints": {
 *       "authStatus":  "checkAuth",   // plugin endpoint → { connected, user? }
 *       "authInit":    "startOAuth",  // plugin endpoint → { authUrl }  (oauth2 only)
 *       "authRevoke":  "logout",      // optional endpoint to disconnect
 *       "sync":        "getLibrary",  // plugin endpoint → [Track] or { tracks: [Track] }
 *       "search":      "search",      // optional; params: { q }
 *       "stream":      "getStream"    // optional; params: { id, uri? } → { streamUrl }
 *     }
 *   }
 *
 * Track shape returned by sync / search:
 *   { title, artist, id?, uri?, streamUrl?, artworkUrl? }
 *
 * Synced tracks are tagged source: "connector:<name>" and included in playlists.json.
 */

import { loadPlugins, callPlugin } from './plugin-runner.js';
import { getPref, setPref } from './state.js';

export function getMusicConnectors() {
  return loadPlugins().filter(p => p.enabled && p.musicConnector);
}

function ep(plugin, operation) {
  return plugin.musicConnector?.endpoints?.[operation] ?? null;
}

export async function getConnectorAuthStatus(plugin) {
  const authType = plugin.musicConnector?.authType ?? 'none';

  if (authType === 'none') return { connected: true };

  if (authType === 'apikey' || authType === 'token') {
    return { connected: !!getPref(`plugin.${plugin.name}.api_key`, '') };
  }

  if (authType === 'oauth2') {
    const name = ep(plugin, 'authStatus');
    if (!name) return { connected: false };
    try {
      const result = await callPlugin(plugin.name, name, {});
      return { connected: !!result?.connected, user: result?.user ?? null };
    } catch {
      return { connected: false };
    }
  }

  return { connected: false };
}

export async function initConnectorAuth(plugin) {
  const name = ep(plugin, 'authInit');
  if (!name) throw new Error(`Plugin "${plugin.name}" has no authInit endpoint configured`);
  return callPlugin(plugin.name, name, {});
}

export async function revokeConnectorAuth(plugin) {
  const authType = plugin.musicConnector?.authType ?? 'none';

  if (authType === 'apikey' || authType === 'token') {
    setPref(`plugin.${plugin.name}.api_key`, '');
    return;
  }

  const name = ep(plugin, 'authRevoke');
  if (name) {
    try { await callPlugin(plugin.name, name, {}); } catch {}
  }
}

function apiKeyParams(plugin) {
  const t = plugin.musicConnector?.authType;
  if (t === 'apikey' || t === 'token') {
    return { api_key: getPref(`plugin.${plugin.name}.api_key`, '') };
  }
  return {};
}

export async function syncConnectorTracks(plugin) {
  const name = ep(plugin, 'sync');
  if (!name) throw new Error(`Plugin "${plugin.name}" has no sync endpoint configured`);

  const result = await callPlugin(plugin.name, name, apiKeyParams(plugin));
  const raw = Array.isArray(result) ? result : result?.tracks ?? [];

  return raw.map(t => ({
    title:      t.title ?? t.name ?? '',
    artist:     t.artist ?? (Array.isArray(t.artists) ? t.artists[0] : '') ?? '',
    id:         t.id ?? '',
    uri:        t.uri ?? '',
    streamUrl:  t.streamUrl ?? t.stream_url ?? '',
    artworkUrl: t.artworkUrl ?? t.artwork_url ?? t.thumbnail ?? '',
    source:     `connector:${plugin.name}`,
  }));
}

export async function resolveConnectorStream(plugin, track) {
  const name = ep(plugin, 'stream');
  if (!name) return null;
  const result = await callPlugin(plugin.name, name, {
    id: track.id ?? '',
    uri: track.uri ?? '',
    ...apiKeyParams(plugin),
  });
  return result?.streamUrl ?? result?.stream_url ?? null;
}
