#!/usr/bin/env node
/**
 * test-reranker.js
 *
 * Tests the seens-reranker using real USER/ folder preferences.
 * Reads taste.md, routines.md, mood-rules.md to build a realistic
 * context, then calls the reranker API or subprocess with fake candidates.
 *
 * Requires the reranker server to be running:
 *   cd ../seens-reranker && python main.py
 *
 * OR tests the Python subprocess directly (no server needed):
 *   node scripts/test-reranker.js --subprocess
 *
 * Run from seens-radio root:
 *   node scripts/test-reranker.js
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_DIR  = path.join(__dirname, '../USER');
const RERANKER_URL = process.env.RERANKER_URL ?? 'http://127.0.0.1:7480';

// ─── Read user preferences ────────────────────────────────────────────────────

function readUser(file) {
  try { return fs.readFileSync(path.join(USER_DIR, file), 'utf8').trim(); }
  catch { return null; }
}

const taste     = readUser('taste.md');
const routines  = readUser('routines.md');
const moodRules = readUser('mood-rules.md');

console.log('\n=== SEENS Reranker Test ===');
console.log(`USER/ directory: ${USER_DIR}`);
console.log(`taste.md:      ${taste     ? `${taste.length} chars` : 'missing'}`);
console.log(`routines.md:   ${routines  ? `${routines.length} chars` : 'missing'}`);
console.log(`mood-rules.md: ${moodRules ? `${moodRules.length} chars` : 'missing'}`);

// ─── Candidate songs (realistic mix matching the taste profile) ───────────────

const CANDIDATES = [
  { id: 'track_1', title: 'Holocene',           artist: 'Bon Iver',          source: 'spotify' },
  { id: 'track_2', title: 'Motion Picture Soundtrack', artist: 'Radiohead',  source: 'spotify' },
  { id: 'track_3', title: 'Night Owl',           artist: 'Galimatias',        source: 'spotify' },
  { id: 'track_4', title: 'Intro',               artist: 'The xx',            source: 'spotify' },
  { id: 'track_5', title: 'Skinny Love',         artist: 'Bon Iver',          source: 'spotify' },
  { id: 'track_6', title: 'Atlas Hands',         artist: 'Benjamin Francis Leftwich', source: 'spotify' },
  { id: 'track_7', title: 'Pursuit of Happiness','artist':'Steve Aoki',       source: 'spotify' },
  { id: 'track_8', title: 'Levels',              artist: 'Avicii',            source: 'spotify' },
  { id: 'track_9', title: 'Breathe (2AM)',       artist: 'Anna Nalick',       source: 'spotify' },
  { id: 'track_10','title': 'Heartbeats',        artist: 'José González',     source: 'spotify' },
];

// ─── Context from USER/ prefs + wall clock ────────────────────────────────────

function buildContext() {
  const now = new Date();
  const hour = now.getHours();
  // Map hour to mood 0-1: late night=low, morning=moderate, afternoon=higher
  const mood = hour >= 22 || hour < 6 ? 0.25 : hour < 10 ? 0.50 : hour < 18 ? 0.65 : 0.45;
  return {
    weather_code: null,   // unknown — reranker defaults gracefully
    mood,
    energy: mood,
    has_event: false,
  };
}

// ─── HTTP test (reranker server) ──────────────────────────────────────────────

async function testViaHTTP() {
  console.log(`\n[HTTP] Connecting to ${RERANKER_URL}/api/health …`);

  let health;
  try {
    const res = await fetch(`${RERANKER_URL}/api/health`);
    health = await res.json();
  } catch (err) {
    console.error(`[HTTP] Cannot reach reranker: ${err.message}`);
    console.error(`       Start it with: cd ../seens-reranker && python main.py`);
    return false;
  }

  console.log('[HTTP] Health:', JSON.stringify(health));

  // Passive rerank
  console.log('\n[HTTP] Passive rerank — context-driven…');
  const ctx = buildContext();
  console.log(`       mood=${ctx.mood.toFixed(2)}  energy=${ctx.energy.toFixed(2)}  time=${new Date().toLocaleTimeString()}`);
  console.log(`       Using taste.md: ${taste ? 'yes' : 'no (no taste profile)'}`);

  const rerankRes = await fetch(`${RERANKER_URL}/api/rerank`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      candidates: CANDIDATES,
      context: ctx,
      top_k: 5,
    }),
  });

  if (!rerankRes.ok) {
    console.error('[HTTP] Rerank failed:', await rerankRes.text());
    return false;
  }

  const { songs, context_used } = await rerankRes.json();
  console.log('\n[HTTP] Context used by reranker:');
  for (const [k, v] of Object.entries(context_used)) {
    console.log(`       ${k}: ${typeof v === 'number' ? v.toFixed(3) : v}`);
  }

  console.log('\n[HTTP] Top-5 ranked songs:');
  songs.forEach((s, i) => {
    const attn = s.attention_weights
      ? Object.entries(s.attention_weights).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' ')
      : 'no embeddings yet';
    console.log(`  ${i + 1}. "${s.title}" – ${s.artist}  score=${s.reranker_score.toFixed(4)}  [${attn}]`);
  });

  // Search mode
  const searchQuery = taste?.includes('piano') ? 'soft piano music' : 'songs with melancholy mood';
  console.log(`\n[HTTP] Search rerank — query: "${searchQuery}"`);

  const searchRes = await fetch(`${RERANKER_URL}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      candidates: CANDIDATES,
      query: searchQuery,
      context: ctx,
      top_k: 5,
    }),
  });

  if (searchRes.ok) {
    const { songs: sSongs, intent } = await searchRes.json();
    console.log(`[HTTP] Intent routing: ${JSON.stringify(intent)}`);
    console.log('[HTTP] Search results:');
    sSongs.forEach((s, i) => console.log(`  ${i + 1}. "${s.title}" – ${s.artist}  score=${s.reranker_score.toFixed(4)}`));
  }

  return true;
}

// ─── Sync test — push the USER/ taste profile to the reranker ─────────────────

async function testSync() {
  // Build simple song list from playlists.json if available
  let playlists = [];
  try {
    playlists = JSON.parse(fs.readFileSync(path.join(USER_DIR, '../data/playlists.json') , 'utf8'));
  } catch {
    try {
      playlists = JSON.parse(fs.readFileSync(path.join(__dirname, '../USER/playlists.json'), 'utf8'));
    } catch { /* no playlist data */ }
  }

  if (!playlists.length) {
    console.log('\n[Sync] No playlists.json found — skipping sync test');
    return;
  }

  const songs = playlists.slice(0, 10).map(t => ({
    id:     t.uri ?? t.id ?? `${t.title}_${t.artist}`,
    title:  t.title,
    artist: t.artist ?? '',
    source: t.source ?? 'spotify',
    lyrics: `${t.title} ${t.artist}`,   // BGE fallback when no audio
  }));

  console.log(`\n[Sync] Syncing ${songs.length} songs from playlist…`);
  const res = await fetch(`${RERANKER_URL}/api/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ songs }),
  });
  if (res.ok) {
    const r = await res.json();
    console.log(`[Sync] Result: ok=${r.ok} fail=${r.fail} total=${r.total}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const reachable = await testViaHTTP();
  if (reachable) await testSync();

  console.log('\n=== Test complete ===\n');
  console.log('NOTE: Attention weights show "0.000" for songs without audio embeddings.');
  console.log('      Run a playlist sync first to populate the vector store.');
  if (taste) {
    console.log('\nYour taste.md summary:');
    console.log(taste.split('\n').slice(0, 6).map(l => '  ' + l).join('\n'));
  }
}

main().catch(err => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
